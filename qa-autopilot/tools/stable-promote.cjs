'use strict';
// Manual promotion of an already published stable version from "next" to
// "latest" for the CORE package.
//
// This is the FINAL phase of the stable procedure:
//
//   publish to next  ->  independent OFFICIAL download/install/UI/restart
//                         acceptance by a human  ->  move "latest"
//
// The order is never reversed. "latest" is only moved for a version that is
// ALREADY published under "next" and that a human accepted from an official
// download. This route never publishes a version, never moves "next", never
// removes a dist-tag and never touches a package other than
// @sanqianx/project-knowledge.
//
// The write is the npm CLI itself:
//
//   npm dist-tag add @sanqianx/project-knowledge@<version> latest
//
// A raw HTTP PUT of a dist-tag with a publish scoped token is never used. The
// npm side "Allow npm dist-tag" grant is an independent permission that only
// a real dist-tag write exercises, so npm's own OIDC flow is the only honest
// way to ask for it. A successful publish says nothing about that grant.
//
// The acceptance attestation is a HUMAN claim, not machine proof: the exact
// phrase "official-next-install-ui-restart-passed" is the reviewer's own
// statement that the official acceptance happened. The tool checks that the
// phrase is present and records it as an attestation; it cannot verify the
// download, the install, the UI or the restart.
//
// Usage:
//   node qa-autopilot/tools/stable-promote.cjs check
//   node qa-autopilot/tools/stable-promote.cjs promote
// Inputs (environment only, never interpolated into a shell):
//   TARGET_PACKAGE, EXPECTED_VERSION, EXPECTED_SRI, EXPECTED_SOURCE_SHA,
//   EXPECTED_CURRENT_LATEST, ACCEPTANCE_ACK, REVIEWER, GH_TOKEN, RUNNER_TEMP

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { must, atomicJSON } = require('../lib/safety.cjs');
const C = require('./stable-next-common.cjs');
const { ciStatus: registryCiStatus } = require('../lib/registry.cjs');

const PROMOTION_SCHEMA = 'project-knowledge/stable-promotion/v1';
const PROMOTION_TAG = 'latest';
const ACCEPTANCE_ACK = 'official-next-install-ui-restart-passed';
const RECEIPT_DIR = 'stable-promotion';
const RECEIPT_NAME = 'promotion-receipt.json';
const REGISTRY_POLL_ATTEMPTS = 12;
const REGISTRY_POLL_DELAY_MS = 5000;

// Pure: the manual inputs of the promotion. Every refusal of the identity,
// the format and the attestation is decided here.
function checkPromotionInputs(i) {
    return C.firstProblem([
        { when: i.repository !== C.REPOSITORY, code: 'CI_IDENTITY', reason: 'Only ' + C.REPOSITORY + ' may promote a stable release' },
        { when: !i.workflowRef.startsWith(C.WORKFLOW_REF_PREFIX), code: 'WORKFLOW_IDENTITY', reason: 'The job must run from ' + C.WORKFLOW_PATH },
        { when: i.eventName !== 'workflow_dispatch', code: 'MANUAL_ONLY', reason: 'This route only runs on a manual dispatch' },
        { when: i.packageName !== C.CORE_PACKAGE, code: 'PACKAGE_NAME', reason: 'This route promotes ' + C.CORE_PACKAGE + ' only' },
        { when: !C.STABLE_VERSION.test(i.expectedVersion || ''), code: 'VERSION_SEMVER', reason: 'The stable channel requires a plain x.y.z version' },
        { when: !C.SHA40.test(i.sourceSha || ''), code: 'SHA_FORMAT', reason: 'The reviewed source commit (40 hex) is required' },
        { when: !C.SRI.test(i.expectedSRI || ''), code: 'SRI_FORMAT', reason: 'The reviewed tarball integrity (sha512-...) is required' },
        { when: !i.reviewer || String(i.reviewer).trim().length < 2, code: 'REVIEWER_REQUIRED', reason: 'The identity of the reviewer of the official acceptance is required' },
        { when: i.acceptanceAck !== ACCEPTANCE_ACK, code: 'ACCEPTANCE_ACK', reason: 'The exact acceptance attestation "' + ACCEPTANCE_ACK + '" is required; it is a human attestation, not machine proof' },
        { when: !C.STABLE_VERSION.test(i.expectedCurrentLatest || ''), code: 'LATEST_BASELINE_FORMAT', reason: 'The expected current latest (x.y.z) is required as the concurrency guard' },
        { when: C.STABLE_VERSION.test(i.expectedVersion || '') && C.STABLE_VERSION.test(i.expectedCurrentLatest || '') && compareVersions(i.expectedVersion, i.expectedCurrentLatest) < 0, code: 'DOWNGRADE_DISALLOWED', reason: 'Promotion cannot replace a newer latest version with an older release' },
    ]);
}

function compareVersions(a, b) {
    const left = a.split('.').map(BigInt), right = b.split('.').map(BigInt);
    for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1;
    return 0;
}

// Pure: every current non-release CI job of this repository must have
// succeeded on the reviewed commit.
function checkCiGate(i) {
    const required = C.REQUIRED_CI_JOBS;
    const jobs = Array.isArray(i.jobs) ? i.jobs : [];
    const missing = required.filter(name => !jobs.some(job => job && job.name === name && job.conclusion === 'success'));
    return C.firstProblem([
        { when: i.ciStatus !== 'PASS', code: 'CI_NOT_GREEN', reason: 'The current CI run for ' + (i.sourceSha || '?') + ' is ' + (i.ciStatus || 'UNKNOWN') },
        { when: missing.length > 0, code: 'CI_JOBS_INCOMPLETE', reason: 'These CI jobs did not succeed on the reviewed commit: ' + missing.join(', ') },
    ]);
}

// Pure: the published state the promotion starts from. The candidate must be
// published under "next" with the reviewed integrity, and "latest" must still
// be the version the reviewer looked at. When "latest" already IS the
// candidate, the route reconciles instead of writing.
function checkRegistryState(i) {
    const alreadyPromoted = i.latestTag === i.expectedVersion && i.versionIntegrity === i.expectedSRI;
    const verdict = C.firstProblem([
        { when: !i.versionExists, code: 'VERSION_MISSING', reason: i.packageName + '@' + i.expectedVersion + ' is not published on the registry' },
        { when: i.versionExists && i.versionIntegrity !== i.expectedSRI, code: 'INTEGRITY_MISMATCH', reason: 'The published artifact integrity differs from the reviewed integrity' },
        { when: i.nextTag !== i.expectedVersion, code: 'NEXT_MISMATCH', reason: 'the next tag is ' + (i.nextTag || 'none') + ', not the accepted candidate' },
        { when: !alreadyPromoted && i.latestTag !== i.expectedCurrentLatest, code: 'LATEST_CHANGED', reason: 'latest is ' + (i.latestTag || 'none') + ', not the reviewed baseline ' + i.expectedCurrentLatest },
    ]);
    return Object.assign({ alreadyPromoted }, verdict);
}

// npm must be able to use OIDC for a dist-tag write: 11.21.0+ or 12.2.0+.
function npmSupportsDistTagOIDC(parts) {
    const major = Number(parts[1]);
    const minor = Number(parts[2]);
    const patch = Number(parts[3]);
    if (major >= 13)
        return true;
    if (major === 12)
        return minor > 2 || (minor === 2 && patch >= 0);
    if (major === 11)
        return minor > 21 || (minor === 21 && patch >= 0);
    return false;
}

// Pure: the npm CLI floor of the dist-tag route.
function checkNpmVersion(i) {
    const version = String(i.npmVersion || '').trim();
    const match = version.match(/^(\d+)\.(\d+)\.(\d+)/);
    return C.firstProblem([
        { when: !match, code: 'NPM_VERSION_FORMAT', reason: 'The npm CLI version could not be read: ' + (version || '(none)') },
        { when: match && !npmSupportsDistTagOIDC(match), code: 'NPM_VERSION_UNSUPPORTED', reason: 'npm ' + version + ' cannot use OIDC for a dist-tag write; 11.21.0 or 12.2.0 or newer is required' },
    ]);
}

// Pure: the registry state after the write. Only "latest" may have moved.
function checkPromotionOutcome(i) {
    return C.firstProblem([
        { when: !i.meta || !i.meta.dist || !i.meta.dist.integrity, code: 'NO_RECEIPT', reason: 'The registry does not expose this version' },
        { when: i.meta && i.meta.version !== i.expectedVersion, code: 'REGISTRY_VERSION', reason: 'The registry returned version ' + (i.meta ? i.meta.version : '?') },
        { when: i.meta && i.meta.dist.integrity !== i.expectedSRI, code: 'INTEGRITY_CHANGED', reason: 'The published artifact integrity changed' },
        { when: i.latestAfter !== i.expectedVersion, code: 'LATEST_NOT_MOVED', reason: 'latest is ' + (i.latestAfter || 'none') + ', not the promoted version' },
        { when: i.nextAfter !== i.expectedVersion, code: 'NEXT_MOVED', reason: 'the next tag is ' + (i.nextAfter || 'none') + '; this route never moves next' },
    ]);
}

function readInputs(env) {
    return {
        repository: env.GITHUB_REPOSITORY,
        workflowRef: String(env.GITHUB_WORKFLOW_REF || ''),
        eventName: env.GITHUB_EVENT_NAME,
        packageName: String(env.TARGET_PACKAGE || '').trim(),
        expectedVersion: String(env.EXPECTED_VERSION || '').trim(),
        expectedSRI: String(env.EXPECTED_SRI || '').trim(),
        sourceSha: String(env.EXPECTED_SOURCE_SHA || '').trim(),
        expectedCurrentLatest: String(env.EXPECTED_CURRENT_LATEST || '').trim(),
        acceptanceAck: String(env.ACCEPTANCE_ACK || '').trim(),
        reviewer: String(env.REVIEWER || '').trim(),
    };
}

function readNpmVersion() {
    const result = spawnSync('npm', ['--version'], { encoding: 'utf8', shell: false, windowsHide: true, timeout: 60000 });
    return result.status === 0 ? String(result.stdout || '').trim() : '';
}

// The npm CLI runs with the inherited environment so the GitHub OIDC
// variables reach npm's own trusted-publishing flow.
function runNpmCli(args, options = {}) {
    const result = spawnSync('npm', args, { encoding: 'utf8', shell: false, windowsHide: true, timeout: 300000, maxBuffer: 4 * 1024 * 1024, ...options });
    return { status: result.status, stdout: String(result.stdout || ''), stderr: String(result.stderr || '') };
}

function receiptDir(env) {
    return path.join(env.RUNNER_TEMP || path.join(process.cwd(), '.tmp'), RECEIPT_DIR);
}

async function readRegistry(inputs, fetchImpl) {
    const meta = await C.registryVersionMeta(inputs.packageName, inputs.expectedVersion, fetchImpl);
    const tags = await C.registryDistTags(inputs.packageName, fetchImpl);
    return { meta, tags };
}

async function ciStatusFor(sourceSha, options = {}) {
    const impl = options.ciStatus || registryCiStatus;
    return impl({ githubRepo: C.REPOSITORY, mainBranch: 'main', ciRequiredJobs: C.REQUIRED_CI_JOBS.slice() }, sourceSha);
}

// Pure-ish: every precondition of the promotion, evaluated in one pass.
// The write never happens inside this function.
async function evaluate(inputs, options = {}) {
    const fetchImpl = options.fetchImpl || globalThis.fetch;
    const inputVerdict = checkPromotionInputs(inputs);
    must(inputVerdict.ok, inputVerdict.code || 'PROMOTE_INPUT', inputVerdict.reason || 'promotion input refused');

    const ci = await ciStatusFor(inputs.sourceSha, options);
    const ciVerdict = checkCiGate({ ciStatus: ci.status, jobs: ci.jobs, sourceSha: inputs.sourceSha });
    must(ciVerdict.ok, ciVerdict.code || 'CI_GATE', ciVerdict.reason || 'CI gate refused');

    // Read the tag baseline after the potentially slow CI lookup. This is
    // a best-effort baseline check, not an atomic registry compare-and-swap.
    const { meta, tags } = await readRegistry(inputs, fetchImpl);

    const stateVerdict = checkRegistryState({
        packageName: inputs.packageName,
        expectedVersion: inputs.expectedVersion,
        expectedSRI: inputs.expectedSRI,
        expectedCurrentLatest: inputs.expectedCurrentLatest,
        versionExists: meta !== null,
        versionIntegrity: meta && meta.dist ? meta.dist.integrity : null,
        nextTag: tags.next || null,
        latestTag: tags.latest || null,
    });
    must(stateVerdict.ok, stateVerdict.code || 'REGISTRY_STATE', stateVerdict.reason || 'registry state refused');

    const npmVersionValue = typeof options.npmVersion === 'function' ? options.npmVersion()
        : (options.npmVersion === undefined ? readNpmVersion() : options.npmVersion);
    const npmVersion = String(npmVersionValue || '').trim();
    const npmVerdict = checkNpmVersion({ npmVersion });
    must(npmVerdict.ok, npmVerdict.code || 'NPM_VERSION', npmVerdict.reason || 'npm version refused');

    return { inputs, meta, tags, ci, npmVersion, alreadyPromoted: stateVerdict.alreadyPromoted };
}

function writeReceipt(env, plan, extra) {
    const latest = extra.observed && extra.observed.tags ? extra.observed.tags.latest : plan.tags.latest;
    const next = extra.observed && extra.observed.tags ? extra.observed.tags.next : plan.tags.next;
    const receipt = {
        schema: PROMOTION_SCHEMA,
        status: extra.status,
        name: plan.inputs.packageName,
        version: plan.inputs.expectedVersion,
        sourceSha: plan.inputs.sourceSha,
        distTag: PROMOTION_TAG,
        baseline: { latest: plan.tags.latest || null, next: plan.tags.next || null },
        observed: { latest: latest || null, next: next || null },
        integrity: plan.inputs.expectedSRI,
        integrityUnchanged: true,
        written: extra.written,
        npmVersion: plan.npmVersion,
        reviewer: plan.inputs.reviewer,
        acceptance: {
            ack: plan.inputs.acceptanceAck,
            kind: 'human-attestation',
            note: 'The acceptance phrase is the reviewer\'s own statement that the OFFICIAL download, install, UI and restart acceptance passed. It is a human attestation, not machine proof: this tool cannot verify the download, the install, the UI or the restart.',
        },
        distTagGrant: extra.written ? 'EXERCISED_BY_THIS_WRITE' : 'NOT_EXERCISED_BY_THIS_RUN',
        promotedAt: new Date().toISOString(),
    };
    const dir = receiptDir(env);
    fs.mkdirSync(dir, { recursive: true });
    atomicJSON(path.join(dir, RECEIPT_NAME), receipt);
    return receipt;
}

// Assessment without any write: every precondition is checked and reported.
async function check(options = {}) {
    const env = options.env || process.env;
    const inputs = readInputs(env);
    const plan = await evaluate(inputs, options);
    return {
        status: plan.alreadyPromoted ? 'ALREADY_PROMOTED' : 'READY_TO_PROMOTE',
        name: plan.inputs.packageName,
        version: plan.inputs.expectedVersion,
        latest: plan.tags.latest || null,
        next: plan.tags.next || null,
        npmVersion: plan.npmVersion,
        ci: plan.ci.status,
        written: false,
    };
}

// The promotion itself. Every precondition is evaluated first; the npm CLI
// writes "latest" once; the registry is read back and the result is recorded
// in a metadata-only receipt that never carries a token.
async function promote(options = {}) {
    const env = options.env || process.env;
    const fetchImpl = options.fetchImpl || globalThis.fetch;
    const inputs = readInputs(env);
    const plan = await evaluate(inputs, options);

    if (plan.alreadyPromoted) {
        return writeReceipt(env, plan, { status: 'ALREADY_PROMOTED_VERIFIED', written: false });
    }

    const runNpm = options.runNpm || runNpmCli;
    const result = runNpm(['dist-tag', 'add', inputs.packageName + '@' + inputs.expectedVersion, PROMOTION_TAG], { cwd: process.cwd() });
    const dir = receiptDir(env);
    fs.mkdirSync(dir, { recursive: true });
    // Do not retain npm output: an interactive-auth failure can contain a
    // challenge URL as well as tokens. Only known error codes are useful here.
    const output = String(result.stdout || '') + '\n' + String(result.stderr || '');
    const knownCodes = ['EOTP', 'ENEEDAUTH', 'E401', 'E403', 'E404', 'EPERM', 'EOIDC', 'ETIMEDOUT', 'ECONNRESET'];
    const errorCodes = knownCodes.filter(code => new RegExp('\\b' + code + '\\b').test(output));
    atomicJSON(path.join(dir, 'promotion-command.json'), {
        package: inputs.packageName, version: inputs.expectedVersion,
        tag: PROMOTION_TAG, exitStatus: result.status, errorCodes,
    });
    must(result.status === 0, 'DIST_TAG_FAILED', 'npm dist-tag add exited ' + result.status + '; see the metadata-only command receipt', 20);

    const attempts = options.pollAttempts || REGISTRY_POLL_ATTEMPTS;
    const delayMs = options.pollDelayMs === undefined ? REGISTRY_POLL_DELAY_MS : options.pollDelayMs;
    let observed = await readRegistry(inputs, fetchImpl);
    for (let attempt = 0; attempt < attempts; attempt++) {
        if ((observed.tags.latest || null) === inputs.expectedVersion)
            break;
        await new Promise(resolve => setTimeout(resolve, delayMs));
        observed = await readRegistry(inputs, fetchImpl);
    }
    const outcome = checkPromotionOutcome({
        meta: observed.meta,
        expectedVersion: inputs.expectedVersion,
        expectedSRI: inputs.expectedSRI,
        latestAfter: observed.tags.latest || null,
        nextAfter: observed.tags.next || null,
    });
    must(outcome.ok, outcome.code || 'PROMOTION_OUTCOME', outcome.reason || 'promotion outcome refused');

    return writeReceipt(env, plan, { status: 'PROMOTED_LATEST', written: true, observed });
}

async function main() {
    const action = process.argv[2];
    if (action === 'check') {
        process.stdout.write(JSON.stringify(await check()) + '\n');
        return;
    }
    if (action === 'promote') {
        process.stdout.write(JSON.stringify(await promote()) + '\n');
        return;
    }
    throw new Error('Unknown action: use check or promote');
}

module.exports = {
    checkPromotionInputs, checkCiGate, checkRegistryState, checkNpmVersion, checkPromotionOutcome,
    npmSupportsDistTagOIDC, evaluate, check, promote, readInputs, receiptDir,
    ACCEPTANCE_ACK, PROMOTION_SCHEMA, PROMOTION_TAG, RECEIPT_NAME,
};

if (require.main === module) {
    main().catch(error => {
        process.stderr.write((error.code ? error.code + ' ' : '') + (error.message || String(error)) + '\n');
        process.exitCode = error.exitCode || 20;
    });
}
