'use strict';
// Publish candidates only; stable approval is external. / 只处理候选，正式发布由外部批准。
const fs = require('node:fs');
const path = require('node:path');
const { must, hash, atomicJSON, readJSON, ownedRun, isolatedEnv, runLogged, commandSync } = require('./safety.cjs');
const { git, head, assertRepo, remoteHead, snapshot } = require('./git.cjs');
const PACKAGE = '@sanqianx/project-knowledge';
function isRC(v) { return typeof v === 'string' && /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)-rc\.(?:0|[1-9]\d*)$/.test(v); }
async function registryJSON(suffix) {
    const response = await fetch('https://registry.npmjs.org/' + encodeURIComponent(PACKAGE) + suffix, { redirect: 'error', signal: AbortSignal.timeout(20000) });
    must(response.ok, 'REGISTRY_UNAVAILABLE', 'Registry response: ' + response.status, 20);
    return response.json();
}
async function registryInfo(version = 'next') {
    must(version === 'next' || version === 'latest' || isRC(version), 'VERSION', 'Invalid registry version.');
    const meta = await registryJSON('/' + encodeURIComponent(version));
    must(meta.name === PACKAGE && meta.dist?.integrity && meta.dist?.tarball, 'REGISTRY_METADATA', 'Incomplete package metadata.');
    return { name: meta.name, version: meta.version, integrity: meta.dist.integrity, tarball: meta.dist.tarball, gitHead: meta.gitHead || null, dependencies: meta.dependencies || {}, at: new Date().toISOString() };
}
function validatePack(files) {
    must(Array.isArray(files) && files.length > 0, 'EMPTY_PACKAGE', 'No packaged files.');
    const paths = files.map(f => typeof f === 'string' ? f : f.path);
    for (const p of paths)
        must(!/^(qa-autopilot|\.runtime|state|artifacts)(\/|$)|(^|\/)\.git(\/|$)|(^|\/)(\.env(?:\..*)?|ai-profiles\.json|credentials\.json)$/.test(p), 'PACKAGE_LEAK', 'Forbidden package file: ' + p);
    for (const required of ['package.json', '_site/server.js', 'ui/index.html', 'ui/product.js', 'ui/live-client.js', 'module-runtime-manifest.json', 'vendor-manifest.json'])
        must(paths.includes(required), 'PACKAGE_MISSING', 'Required runtime missing: ' + required);
    must(paths.some(p => p.startsWith('_modules/knowledge-engine/')), 'ENGINE_MISSING', 'Vendored engine missing.');
    return true;
}
function packAudit(cfg) {
    const before = snapshot(cfg);
    must(fs.existsSync(cfg.tools.npmCli || ''), 'NPM_ENTRY', 'Configure an absolute npm-cli.js path.', 20);
    const dir = ownedRun(cfg.qaRoot, 'pack-' + Date.now());
    const env = isolatedEnv(dir);
    const text = commandSync(cfg.tools.node, [cfg.tools.npmCli, 'pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: cfg.repoRoot, env, timeout: 60000 });
    const p = JSON.parse(text);
    must(p.length === 1, 'PACK_RESULT', 'Expected one package.');
    validatePack(p[0].files);
    must(snapshot(cfg).fingerprint === before.fingerprint, 'PACK_SOURCE_CHANGED', 'Pack audit altered source.');
    return { schema: 1, kind: 'pack-list-audit', status: 'PASS', head: before.head, fingerprint: before.fingerprint, paths: p[0].files.map(f => f.path), note: 'Pack-list only; does not replace release:verify or a lifecycle-enabled runtime installation.' };
}
async function ciStatus(cfg, sha = head(cfg)) {
    must(/^[a-f0-9]{40}$/.test(sha), 'SHA', 'Invalid SHA.');
    const headers = { Accept: 'application/vnd.github+json' };
    if (process.env.GH_TOKEN)
        headers.Authorization = 'Bearer ' + process.env.GH_TOKEN;
    const base = 'https://api.github.com/repos/' + cfg.githubRepo;
    const r = await fetch(base + '/actions/runs?head_sha=' + sha + '&per_page=100', { headers, signal: AbortSignal.timeout(20000) });
    must(r.ok, 'CI_UNAVAILABLE', 'CI lookup failed.', 20);
    const data = await r.json();
    const runs = (data.workflow_runs || []).filter(x => x.head_sha === sha && x.path === '.github/workflows/ci.yml' && x.event === 'push' && x.head_branch === cfg.qaBranch).sort((a, b) => b.id - a.id);
    if (!runs.length)
        return { status: 'PENDING', sha, reason: 'No matching QA push validation workflow.' };
    const run = runs[0];
    if (run.status !== 'completed' || run.conclusion !== 'success')
        return { status: run.status === 'completed' ? 'FAIL' : 'PENDING', sha, runId: run.id, conclusion: run.conclusion };
    const j = await fetch(base + '/actions/runs/' + run.id + '/jobs?per_page=100', { headers, signal: AbortSignal.timeout(20000) });
    must(j.ok, 'CI_JOBS', 'CI job lookup failed.', 20);
    const jobs = (await j.json()).jobs || [];
    const required = cfg.ciRequiredJobs || [];
    must(required.length >= 3, 'CI_REQUIREMENTS', 'Review and pin Linux Node22/24 and Windows CI job names.');
    const ok = required.every(name => jobs.some(job => job.name === name && job.conclusion === 'success'));
    return { status: ok ? 'PASS' : 'FAIL', sha, runId: run.id, jobs: jobs.map(j => ({ name: j.name, conclusion: j.conclusion })), url: run.html_url };
}
function validateReleaseAcceptance(cfg, acceptance, current) {
    must(acceptance?.schema === 1 && acceptance.status === 'PASS' && acceptance.head === current.head && acceptance.sourceFingerprint === current.fingerprint && acceptance.reviewedBy, 'RC_ACCEPTANCE', 'Reviewed candidate gates for this exact source are required.', 20);
    const required = ['unitIntegration', 'realE2E', 'visual', 'performance', 'faultRecovery', 'pack'];
    for (const name of required) {
        const gate = acceptance.gates?.[name];
        must(gate?.status === 'PASS' && gate.evidenceFile && gate.sha256, 'RC_GATE', 'Missing release gate: ' + name, 20);
        const f = require('./safety.cjs').noLinks(cfg.qaRoot, path.resolve(cfg.qaRoot, gate.evidenceFile));
        must(hash(fs.readFileSync(f)) === gate.sha256, 'RC_EVIDENCE_CHANGED', 'Evidence hash mismatch: ' + name, 20);
        const receipt = readJSON(f);
        must(receipt.status === 'PASS' && receipt.head === current.head && receipt.fingerprint === current.fingerprint, 'RC_EVIDENCE_SCOPE', 'Evidence belongs to another source or is not passed: ' + name, 20);
        if (name === 'realE2E')
            must(receipt.mode === 'REAL_PRODUCT' && receipt.realModel === true, 'MOCK_NOT_REAL', 'Shell/mock tests do not satisfy real product E2E.', 20);
    }
    return true;
}
async function candidatePlan(cfg) {
    assertRepo(cfg);
    const version = readJSON(path.join(cfg.repoRoot, 'package.json')).version;
    must(isRC(version), 'RC_ONLY', 'Only x.y.z-rc.n versions are accepted.');
    const sha = head(cfg);
    must(remoteHead(cfg, 'refs/heads/' + cfg.qaBranch) === sha, 'REMOTE_SHA', 'Candidate commit not on remote QA head.');
    must(!git(cfg, ['status', '--porcelain']), 'DIRTY_RC', 'Release source must be clean.');
    const ci = await ciStatus(cfg, sha);
    must(ci.status === 'PASS', 'CI_PENDING', 'CI gate not satisfied.', 20);
    validateReleaseAcceptance(cfg, readJSON(path.resolve(cfg.qaRoot, cfg.rcAcceptanceFile || 'state/rc-acceptance.json')), snapshot(cfg));
    const latest = await registryInfo('latest');
    return { schema: 1, status: 'PLAN_ONLY', name: PACKAGE, version, sha, tag: 'qa-rc/' + version, distTag: 'next', latestBefore: latest.version, ci };
}
async function tagCandidate(cfg, plan, apply, store) {
    const current = await candidatePlan(cfg);
    must(plan.sha === current.sha && plan.version === current.version && plan.latestBefore === current.latestBefore, 'RC_PLAN_STALE', 'Candidate plan changed.');
    if (!apply)
        return current;
    assertRepo(cfg, true);
    must(cfg.authorization?.candidatePublishEnabled === true && cfg.authorization?.publisherGateVerified === true, 'RC_NOT_AUTHORIZED', 'RC publisher gate has not been approved.', 20);
    const workflow = fs.readFileSync(path.join(cfg.repoRoot, '.github/workflows/publish.yml'), 'utf8');
    must(workflow.includes('qa-rc/*') && workflow.includes('--tag next') && workflow.includes('RC_ONLY_DURING_QA') && !workflow.includes("- 'v*'"), 'WORKFLOW_UNSAFE', 'Candidate workflow has not been installed/reviewed.');
    const opId = 'publish-' + current.version;
    const begin = store.beginOperation(opId, current);
    must(!begin.existing, 'RECONCILE_REQUIRED', 'A release intent exists; inspect remote tag and registry before retrying.', 20);
    must(!remoteHead(cfg, 'refs/tags/' + current.tag), 'TAG_EXISTS', 'RC tag exists; never move it.');
    git(cfg, ['tag', '-a', current.tag, current.sha, '-m', 'QA candidate ' + current.version]);
    git(cfg, ['push', 'origin', `refs/tags/${current.tag}:refs/tags/${current.tag}`]);
    must(remoteHead(cfg, `refs/tags/${current.tag}^{}`) === current.sha, 'TAG_UNCONFIRMED', 'RC tag verification failed.', 20);
    store.completeOperation(opId, { status: 'TAG_PUSHED_PUBLISH_PENDING', tag: current.tag, sha: current.sha });
    return { status: 'TAG_PUSHED_PUBLISH_PENDING', tag: current.tag, sha: current.sha };
}
async function installRC(cfg, version, apply = false) {
    must(isRC(version), 'RC_ONLY', 'Install a fixed RC version, never a moving next tag.');
    const meta = await registryInfo(version);
    must(meta.version === version, 'VERSION_MISMATCH', 'Registry returned another version.');
    const u = new URL(meta.tarball);
    must(u.protocol === 'https:' && u.hostname === 'registry.npmjs.org', 'TARBALL_HOST', 'Unexpected tarball host.');
    if (!apply)
        return { dryRun: true, ...meta };
    must(cfg.authorization?.installRcEnabled === true, 'INSTALL_NOT_APPROVED', 'Review isolated npm lifecycle execution before installation.', 20);
    const run = ownedRun(cfg.qaRoot, 'install-' + version + '-' + Date.now());
    const prefix = path.join(run, 'prefix');
    fs.mkdirSync(prefix);
    fs.writeFileSync(path.join(prefix, 'package.json'), JSON.stringify({ name: 'isolated-rc-acceptance', private: true, version: '0.0.0' }));
    const r = await runLogged(cfg.tools.node, [cfg.tools.npmCli, 'install', '--prefix', prefix, '--registry=https://registry.npmjs.org', '--save-exact', PACKAGE + '@' + version, '--no-audit', '--no-fund'], { cwd: prefix, env: isolatedEnv(run), logDir: path.join(cfg.qaRoot, 'artifacts', path.basename(run)), timeoutMs: 600000 });
    must(r.code === 0 && !r.timedOut, 'INSTALL_FAILED', 'Isolated RC installation failed.', 10);
    const lock = readJSON(path.join(prefix, 'package-lock.json')), entry = lock.packages['node_modules/' + PACKAGE];
    must(entry?.version === version && entry.integrity === meta.integrity && entry.resolved === meta.tarball, 'INSTALL_RECEIPT', 'Installed package receipt mismatch.');
    const installedRoot = path.join(prefix, 'node_modules', PACKAGE);
    must(readJSON(path.join(installedRoot, 'package.json')).version === version, 'INSTALLED_VERSION', 'Runtime package version mismatch.');
    const receipt = { schema: 1, kind: 'rc-install', status: 'INSTALLED_NOT_RUNTIME_VALIDATED', ...meta, installedRoot, prefix, node: process.version, run };
    atomicJSON(path.join(cfg.qaRoot, 'artifacts', path.basename(run), 'installation.json'), receipt);
    return receipt;
}
module.exports = { validateReleaseAcceptance, isRC, registryInfo, validatePack, packAudit, ciStatus, candidatePlan, tagCandidate, installRC };
