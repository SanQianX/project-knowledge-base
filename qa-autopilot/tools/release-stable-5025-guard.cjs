'use strict';
// P-RELEASE-PUBLISH-5025 stable-channel publish guard.
//
// The existing qa-rc pipeline (ci-rc-guard.cjs + lib/registry.cjs) is
// candidates-only by design ("只处理候选，正式发布由外部批准"). This tool adds
// the externally-approved stable path with the same shape:
//
//   pre   — identity, exact SHA/version/tag binding, main membership, clean
//           tree, three-sync (root/desktop/pin), registry version absent
//   pack  — pack ONCE, audit the exact file list + on-disk tarball digest,
//           hand the tarball to the workflow via GITHUB_OUTPUT
//   post  — poll the registry receipt and compare name/version/integrity and
//           dist-tag outcome (latest must become this version, next untouched)
//
// Every decision is a PURE function over plain inputs (below) so the offline
// test exercises the exact production logic without network or CI; the CLI
// actions only gather inputs (git, registry fetch, files) and call them.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { must, readJSON, atomicJSON, commandSync } = require('../lib/safety.cjs');
const { validatePack } = require('../lib/registry.cjs');

const CORE_PACKAGE = '@sanqianx/project-knowledge';
const DESKTOP_PACKAGE = '@sanqianx/project-knowledge-desktop';
const SHA40 = /^[a-f0-9]{40}$/;
const REQUIRED_DESKTOP = ['package.json', 'main.cjs', 'preload.cjs', 'bin/project-knowledge-desktop.cjs', 'lib/backend-runtime.cjs', 'assets/icon.png'];
// desktop/ packs from a staged copy: the repo dir also holds out/ (multi-GB
// build output), test/, scripts/, forge config and lockfiles that must never
// enter the published thin shell (registry 5.0.18 = 13 files / 22 KB).
const FORBIDDEN_DESKTOP = [/^node_modules(\/|$)/, /^out(\/|$)/, /^test(\/|$)/, /^scripts(\/|$)/, /^forge\.config\.cjs$/, /^package-lock\.json$/, /^\.release-preflight/];
const FORBIDDEN_ANY = [/^(qa-autopilot|\.runtime|state|artifacts)(\/|$)|(^|\/)\.git(\/|$)|(^|\/)(\.env(?:\..*)?|ai-profiles\.json|credentials\.json)$/];

function isStable(version) {
  return typeof version === 'string' && /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(version);
}

function firstProblem(checks) {
  for (const { when, code, reason } of checks) {
    if (when) return { ok: false, code, reason };
  }
  return { ok: true };
}

// Pure: full stable CORE candidate validation.
function checkCoreCandidate(i) {
  return firstProblem([
    { when: i.repository !== 'SanQianX/project-knowledge-base' || !i.runTemp || i.eventName !== 'workflow_dispatch', code: 'CI_IDENTITY', reason: 'Stable publishes only run from the approved workflow_dispatch entry' },
    { when: !isStable(i.inputVersion), code: 'VERSION_SEMVER', reason: `Stable channel requires plain x.y.z, got ${i.inputVersion}` },
    { when: !SHA40.test(i.inputSha || ''), code: 'SHA_FORMAT', reason: 'Exact 40-hex commit SHA required' },
    { when: i.packageName !== CORE_PACKAGE, code: 'PACKAGE_NAME', reason: `Wrong package ${i.packageName}` },
    { when: i.packageVersion !== i.inputVersion, code: 'VERSION_INPUT', reason: `package.json ${i.packageVersion} != dispatch input ${i.inputVersion}` },
    { when: i.headSha !== i.inputSha, code: 'SHA_MATCH', reason: `checked-out HEAD ${i.headSha} != dispatch SHA ${i.inputSha}` },
    { when: i.tagSha === null || i.tagSha === undefined, code: 'TAG_MISSING', reason: `refs/tags/v${i.inputVersion} does not exist; tag it at the release SHA first (never move it afterwards)` },
    { when: i.tagSha !== i.inputSha, code: 'TAG_MOVED', reason: `refs/tags/v${i.inputVersion} resolves to ${i.tagSha}, not ${i.inputSha}` },
    { when: !i.onMain, code: 'NOT_ON_MAIN', reason: 'Release SHA is not an ancestor of origin/main' },
    { when: i.dirty, code: 'DIRTY_TREE', reason: 'Working tree is dirty; the tarball would not match the reviewed SHA' },
    { when: i.desktopVersion !== i.inputVersion || i.desktopCorePin !== i.inputVersion, code: 'THREE_SYNC', reason: `desktop ${i.desktopVersion}/pin ${i.desktopCorePin} != ${i.inputVersion}` },
    { when: i.registryVersionExists, code: 'VERSION_EXISTS', reason: `${CORE_PACKAGE}@${i.inputVersion} already exists; versions are immutable` },
  ]);
}

// Pure: stable DESKTOP candidate validation (runs after core succeeded).
function checkDesktopCandidate(i) {
  return firstProblem([
    { when: i.repository !== 'SanQianX/project-knowledge-base' || !i.runTemp || i.eventName !== 'workflow_dispatch', code: 'CI_IDENTITY', reason: 'Stable publishes only run from the approved workflow_dispatch entry' },
    { when: !isStable(i.inputVersion), code: 'VERSION_SEMVER', reason: `Stable channel requires plain x.y.z, got ${i.inputVersion}` },
    { when: i.packageName !== DESKTOP_PACKAGE, code: 'PACKAGE_NAME', reason: `Wrong package ${i.packageName}` },
    { when: i.packageVersion !== i.inputVersion, code: 'VERSION_INPUT', reason: `desktop package.json ${i.packageVersion} != dispatch input ${i.inputVersion}` },
    { when: i.desktopCorePin !== i.inputVersion, code: 'DESKTOP_PIN', reason: `desktop core pin ${i.desktopCorePin} != ${i.inputVersion}` },
    { when: !i.coreRegistryVersion || i.coreRegistryVersion !== i.inputVersion, code: 'CORE_MISSING', reason: `published core is ${i.coreRegistryVersion || 'absent'}; core@${i.inputVersion} must be live before desktop` },
    { when: i.registryVersionExists, code: 'VERSION_EXISTS', reason: `${DESKTOP_PACKAGE}@${i.inputVersion} already exists; versions are immutable` },
  ]);
}

function packPaths(list) {
  return (list[0].files || []).map((f) => (typeof f === 'string' ? f : f.path));
}

// Pure: audited-tarball check shared by core and desktop packs.
// firstProblem evaluates every `when` eagerly, so shape is settled in its own
// pass before the rest may index list[0].
function checkPack(i) {
  const list = i.list;
  const shape = firstProblem([
    { when: !Array.isArray(list) || list.length !== 1 || list[0].name !== i.packageName || list[0].version !== i.packageVersion, code: 'PACK_ID', reason: `pack produced ${Array.isArray(list) ? list.map((p) => `${p.name}@${p.version}`).join(',') : 'nothing'}` },
    { when: !Array.isArray(list) || list.length !== 1 || !/^[A-Za-z0-9._-]+\.tgz$/.test(list[0].filename || ''), code: 'TARBALL_NAME', reason: `invalid tarball filename ${Array.isArray(list) && list[0] ? list[0].filename : '(no pack)'}` },
  ]);
  if (!shape.ok) return shape;
  return firstProblem([
    { when: !i.tarballExists, code: 'TARBALL_MISSING', reason: 'tarball file not found on disk' },
    { when: !i.tarballSha512 || list[0].integrity !== 'sha512-' + i.tarballSha512, code: 'TARBALL_INTEGRITY', reason: 'on-disk tarball digest differs from the audited pack manifest' },
    { when: (i.required || []).some((p) => !packPaths(list).includes(p)), code: 'PACK_REQUIRED', reason: `required file missing (have ${packPaths(list).length} files)` },
    { when: packPaths(list).some((p) => (i.forbidden || []).concat(FORBIDDEN_ANY).some((re) => re.test(p))), code: 'PACK_FORBIDDEN', reason: 'forbidden path entered the tarball' },
  ]);
}

// Pure: registry receipt comparison after publishing. NO_RECEIPT settles first
// so later checks may dereference registryMeta.dist unguarded.
function checkReceipt(i) {
  const presence = firstProblem([
    { when: !i.registryMeta || !i.registryMeta.dist || !i.registryMeta.dist.integrity, code: 'NO_RECEIPT', reason: 'registry never published this version' },
  ]);
  if (!presence.ok) return presence;
  return firstProblem([
    { when: i.registryMeta.name !== i.packageName, code: 'RECEIPT_NAME', reason: `receipt name ${i.registryMeta.name}` },
    { when: i.registryMeta.version !== i.packageVersion, code: 'RECEIPT_VERSION', reason: `receipt version ${i.registryMeta.version}` },
    { when: i.registryMeta.dist.integrity !== i.pack.integrity, code: 'INTEGRITY', reason: 'registry artifact differs from the audited tarball; do not rerun blindly' },
    { when: i.latestAfter !== i.packageVersion, code: 'LATEST_NOT_MOVED', reason: `latest is ${i.latestAfter}, expected ${i.packageVersion}` },
    { when: i.nextAfter !== i.beforeNext, code: 'NEXT_CHANGED', reason: `next moved ${i.beforeNext} -> ${i.nextAfter} during a stable publish` },
  ]);
}

// ---- CI wrapper actions ----------------------------------------------------

async function meta(pkg, version, allowMissing = false) {
  const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(pkg)}/${encodeURIComponent(version)}`, { redirect: 'error', signal: AbortSignal.timeout(20000) });
  if (response.status === 404 && allowMissing) return null;
  must(response.ok, 'REGISTRY', `Registry lookup failed (${response.status})`);
  return response.json();
}

async function distTag(pkg, tag) {
  const doc = await meta(pkg, tag);
  return doc.version;
}

function gatherCommon(version, sha) {
  must(process.env.GITHUB_REPOSITORY && process.env.RUNNER_TEMP, 'CI_IDENTITY', 'Only the approved GitHub workflow can run this helper');
  fs.mkdirSync(path.join(process.env.RUNNER_TEMP, 'stable-5025'), { recursive: true });
  const headSha = commandSync('git', ['rev-parse', 'HEAD']).trim();
  let tagSha = null;
  try {
    tagSha = commandSync('git', ['rev-parse', `refs/tags/v${version}^{}`]).trim();
  } catch { /* rev-parse exits non-zero when the tag is absent (checked below) */ }
  let onMain = false;
  try {
    commandSync('git', ['merge-base', '--is-ancestor', sha, 'origin/main']);
    onMain = true;
  } catch { /* is-ancestor exits non-zero when not an ancestor */ }
  const dirty = commandSync('git', ['status', '--porcelain']).trim() !== '';
  return { headSha, tagSha, onMain, dirty, dir: path.join(process.env.RUNNER_TEMP, 'stable-5025') };
}

// Windows has no npm.exe; spawn the CLI JS with the running Node (registry.cjs pattern).
function npmRun(args, options) {
  const here = path.dirname(process.execPath);
  for (const cli of [path.join(here, 'node_modules', 'npm', 'bin', 'npm-cli.js'), path.join(here, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')]) {
    if (fs.existsSync(cli)) return commandSync(process.execPath, [cli, ...args], options);
  }
  return commandSync('npm', args, options);
}

async function guardCli() {
  const action = process.argv[2];
  const rootPkg = readJSON('package.json');
  const desktopPkg = readJSON('desktop/package.json');
  const eventName = process.env.GITHUB_EVENT_NAME;
  const version = process.argv[3];
  const sha = process.argv[4];
  const { headSha, tagSha, onMain, dirty, dir } = gatherCommon(version, sha);

  if (action === 'core-pre') {
    const verdict = checkCoreCandidate({
      repository: process.env.GITHUB_REPOSITORY, runTemp: process.env.RUNNER_TEMP, eventName,
      packageName: rootPkg.name, packageVersion: rootPkg.version,
      inputVersion: version, inputSha: sha, headSha, tagSha, onMain, dirty,
      desktopVersion: desktopPkg.version, desktopCorePin: desktopPkg.dependencies[CORE_PACKAGE],
      registryVersionExists: (await meta(CORE_PACKAGE, rootPkg.version, true)) !== null,
    });
    must(verdict.ok, verdict.code || 'CORE_PRE', verdict.reason || 'core pre-check failed');
    atomicJSON(path.join(dir, 'before.json'), { name: CORE_PACKAGE, version, sha: headSha, latest: await distTag(CORE_PACKAGE, 'latest'), next: await distTag(CORE_PACKAGE, 'next'), at: new Date().toISOString() });
  } else if (action === 'core-pack') {
    const list = readJSON(process.argv[3]);
    const file = path.join(dir, list[0].filename);
    const sha512 = crypto.createHash('sha512').update(fs.readFileSync(file)).digest('base64');
    const full = checkPack({ list, packageName: CORE_PACKAGE, packageVersion: rootPkg.version, required: [], forbidden: [], tarballExists: fs.existsSync(file), tarballSha512: sha512 });
    must(full.ok, full.code || 'CORE_PACK', full.reason || 'core pack check failed');
    validatePack(list[0].files); // same runtime-file contract as the RC channel
    must(process.env.GITHUB_OUTPUT, 'GITHUB_OUTPUT', 'Missing workflow output');
    fs.appendFileSync(process.env.GITHUB_OUTPUT, 'tarball=' + file + '\n');
  } else if (action === 'core-post') {
    const pack = readJSON(process.argv[3])[0];
    const before = readJSON(path.join(dir, 'before.json'));
    let found = null;
    for (let attempt = 0; attempt < 12; attempt++) {
      found = await meta(CORE_PACKAGE, pack.version, true);
      if (found && found.dist && found.dist.integrity) break;
      await new Promise((resolve) => setTimeout(resolve, 10000));
    }
    const verdict = checkReceipt({ registryMeta: found, packageName: CORE_PACKAGE, packageVersion: pack.version, pack, latestAfter: await distTag(CORE_PACKAGE, 'latest'), beforeNext: before.next, nextAfter: await distTag(CORE_PACKAGE, 'next') });
    must(verdict.ok, verdict.code || 'CORE_POST', verdict.reason || 'core receipt check failed');
    atomicJSON(path.join(dir, 'core-registry-receipt.json'), { status: 'PUBLISHED_VERIFIED', name: CORE_PACKAGE, version: pack.version, integrity: found.dist.integrity, latest: pack.version, nextUnchanged: true });
  } else if (action === 'desktop-pre') {
    const coreMeta = await meta(CORE_PACKAGE, version, true);
    const verdict = checkDesktopCandidate({
      repository: process.env.GITHUB_REPOSITORY, runTemp: process.env.RUNNER_TEMP, eventName,
      packageName: desktopPkg.name, packageVersion: desktopPkg.version,
      inputVersion: version, desktopCorePin: desktopPkg.dependencies[CORE_PACKAGE],
      coreRegistryVersion: coreMeta ? coreMeta.version : null,
      registryVersionExists: (await meta(DESKTOP_PACKAGE, desktopPkg.version, true)) !== null,
    });
    must(verdict.ok, verdict.code || 'DESKTOP_PRE', verdict.reason || 'desktop pre-check failed');
    atomicJSON(path.join(dir, 'desktop-before.json'), { name: DESKTOP_PACKAGE, version, latest: await distTag(DESKTOP_PACKAGE, 'latest'), at: new Date().toISOString() });
  } else if (action === 'desktop-pack') {
    // Stage the thin shell (desktop/ itself contains out/, test/, lockfiles
    // and would leak them — the manifest has no `files` allowlist).
    const stage = path.join(dir, 'desktop-stage');
    fs.rmSync(stage, { recursive: true, force: true });
    fs.mkdirSync(stage, { recursive: true });
    for (const entry of ['package.json', 'main.cjs', 'preload.cjs', 'bin', 'lib', 'assets']) {
      fs.cpSync(path.join('desktop', entry), path.join(stage, entry), { recursive: true });
    }
    // npm pack --json writes the manifest to stdout; persist it for desktop-post.
    const text = npmRun(['pack', '--json', '--pack-destination', dir], { cwd: stage, timeout: 120000 });
    const list = JSON.parse(text);
    atomicJSON(path.join(dir, 'desktop-pack.json'), list);
    const file = path.join(dir, list[0].filename);
    const sha512 = crypto.createHash('sha512').update(fs.readFileSync(file)).digest('base64');
    const verdict = checkPack({ list, packageName: DESKTOP_PACKAGE, packageVersion: desktopPkg.version, required: REQUIRED_DESKTOP, forbidden: FORBIDDEN_DESKTOP, tarballExists: fs.existsSync(file), tarballSha512: sha512 });
    must(verdict.ok, verdict.code || 'DESKTOP_PACK', verdict.reason || 'desktop pack check failed');
    must(process.env.GITHUB_OUTPUT, 'GITHUB_OUTPUT', 'Missing workflow output');
    fs.appendFileSync(process.env.GITHUB_OUTPUT, 'tarball=' + file + '\n');
  } else if (action === 'desktop-post') {
    const pack = readJSON(process.argv[3])[0];
    let found = null;
    for (let attempt = 0; attempt < 12; attempt++) {
      found = await meta(DESKTOP_PACKAGE, pack.version, true);
      if (found && found.dist && found.dist.integrity) break;
      await new Promise((resolve) => setTimeout(resolve, 10000));
    }
    const verdict = checkReceipt({ registryMeta: found, packageName: DESKTOP_PACKAGE, packageVersion: pack.version, pack, latestAfter: await distTag(DESKTOP_PACKAGE, 'latest'), beforeNext: null, nextAfter: null });
    must(verdict.ok, verdict.code || 'DESKTOP_POST', verdict.reason || 'desktop receipt check failed');
    atomicJSON(path.join(dir, 'desktop-registry-receipt.json'), { status: 'PUBLISHED_VERIFIED', name: DESKTOP_PACKAGE, version: pack.version, integrity: found.dist.integrity, latest: pack.version });
  } else {
    throw Error('Unknown stable guard action');
  }
}

module.exports = { isStable, checkCoreCandidate, checkDesktopCandidate, checkPack, checkReceipt, REQUIRED_DESKTOP, FORBIDDEN_DESKTOP, CORE_PACKAGE, DESKTOP_PACKAGE };

if (require.main === module) {
  (async () => guardCli())().catch((error) => { console.error((error.code ? error.code + ' ' : '') + (error.message || error)); process.exitCode = error.exitCode || 20; });
}
