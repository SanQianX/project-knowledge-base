'use strict';
// Manual "publish the reviewed candidate to next" route.
//
// It never prepares anything and never rebuilds anything. It consumes ONE
// artifact that a previous successful "prepare" run of THIS workflow
// produced, and it publishes exactly those bytes:
//
//   1. the prepare run is verified through the GitHub API: same repository,
//      same workflow file, manual event, completed successfully, and the same
//      reviewed source commit;
//   2. the downloaded artifact must contain exactly the receipt and one
//      tarball - no extra file, no directory, no traversal;
//   3. the receipt must bind name, version, source commit, sha256 and SRI;
//   4. the CALLER supplied review hashes (sha256 + SRI) must match the
//      actual bytes and the receipt - the tool never derives the expected
//      values from the artifact it is about to publish;
//   5. the tarball's own manifest must match the receipt file list, and its
//      package.json must carry the expected name and version;
//   6. only then is the tarball published with --tag next. "latest" is never
//      moved, no dist-tag is moved for an already published version, and no
//      registry credential, placeholder or secret is involved.
//
// Usage:
//   node qa-autopilot/tools/stable-next-publish.cjs verify-run
//   node qa-autopilot/tools/stable-next-publish.cjs publish
// Inputs (environment only): TARGET_PACKAGE, EXPECTED_VERSION,
// EXPECTED_SHA256, EXPECTED_SRI, EXPECTED_SOURCE_SHA, PREPARE_RUN_ID,
// REVIEWER, ARTIFACT_DIR, GH_TOKEN, RUNNER_TEMP.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { must, readJSON, atomicJSON, redact } = require('../lib/safety.cjs');
const C = require('./stable-next-common.cjs');

const RECEIPT_NAME = 'candidate-receipt.json';
const RECEIPT_SCHEMA = 'project-knowledge/stable-next-candidate/v1';
const PUBLISH_SCHEMA = 'project-knowledge/stable-next-publication/v1';
const PUBLISH_TAG = 'next';
const REGISTRY_POLL_ATTEMPTS = 12;
const REGISTRY_POLL_DELAY_MS = 10000;

// Pure: the manual inputs and the prepare-run binding.
function checkPublishBinding(i) {
    return C.firstProblem([
        { when: i.repository !== C.REPOSITORY, code: 'CI_IDENTITY', reason: 'Only ' + C.REPOSITORY + ' may publish a stable candidate' },
        { when: !i.workflowRef.startsWith(C.WORKFLOW_REF_PREFIX), code: 'WORKFLOW_IDENTITY', reason: 'The job must run from ' + C.WORKFLOW_PATH },
        { when: i.eventName !== 'workflow_dispatch', code: 'MANUAL_ONLY', reason: 'This route only runs on a manual dispatch' },
        { when: !C.SHA256_HEX.test(i.expectedSha256 || ''), code: 'SHA256_FORMAT', reason: 'The reviewed tarball sha256 (64 hex) is required' },
        { when: !C.SRI.test(i.expectedSRI || ''), code: 'SRI_FORMAT', reason: 'The reviewed tarball integrity (sha512-...) is required' },
        { when: !C.SHA40.test(i.expectedSourceSha || ''), code: 'SHA_FORMAT', reason: 'The reviewed source commit (40 hex) is required' },
        { when: !C.RUN_ID.test(String(i.prepareRunId || '')), code: 'RUN_ID_FORMAT', reason: 'The prepare run id is required' },
        { when: !i.reviewer || String(i.reviewer).trim().length < 2, code: 'REVIEWER_REQUIRED', reason: 'The identity of the reviewer who inspected the prepared artifact is required' },
        { when: !C.STABLE_VERSION.test(i.expectedVersion || ''), code: 'VERSION_SEMVER', reason: 'The stable channel requires a plain x.y.z version' },
        { when: !C.ALLOWED_PACKAGES.includes(i.packageName), code: 'PACKAGE_NAME', reason: 'Unknown target package' },
        { when: i.packageName === C.DESKTOP_PACKAGE, code: 'DESKTOP_IDENTITY_UNAUTHORIZED', reason: 'The desktop package has no authorized OIDC identity (measured 404) and stays optional; it must not block the core release' },
        { when: i.packageName !== C.CORE_PACKAGE, code: 'PACKAGE_NAME', reason: 'This route publishes the core package only' },
    ]);
}

// Pure: the prepare run must be this workflow, this repository, successful,
// and built from the reviewed commit.
function checkPrepareRun(i) {
    return C.firstProblem([
        { when: !i.run, code: 'RUN_MISSING', reason: 'The prepare run could not be read' },
        { when: i.run && i.run.status !== 'completed', code: 'RUN_NOT_COMPLETED', reason: 'The prepare run is ' + (i.run ? i.run.status : '?') },
        { when: i.run && i.run.conclusion !== 'success', code: 'RUN_NOT_SUCCESSFUL', reason: 'The prepare run concluded ' + (i.run ? i.run.conclusion : '?') },
        { when: i.run && i.run.event !== 'workflow_dispatch', code: 'RUN_EVENT', reason: 'The prepare run was not a manual dispatch' },
        { when: i.run && i.run.path !== C.WORKFLOW_PATH, code: 'RUN_WORKFLOW', reason: 'The prepare run belongs to ' + (i.run ? i.run.path : '?') },
        { when: i.run && i.run.head_sha !== i.expectedSourceSha, code: 'RUN_SOURCE', reason: 'The prepare run built ' + (i.run ? i.run.head_sha : '?') + ', not the reviewed ' + i.expectedSourceSha },
        { when: i.run && i.run.head_repository && i.run.head_repository.full_name !== C.REPOSITORY, code: 'RUN_REPOSITORY', reason: 'The prepare run belongs to another repository' },
        { when: String(i.prepareRunId) === String(i.currentRunId), code: 'RUN_SELF', reason: 'A run may not publish its own artifact; prepare and publish are separate runs' },
    ]);
}

// Pure: the downloaded artifact directory must hold the receipt and one
// tarball, and nothing else.
function checkArtifactDirectory(i) {
    return C.firstProblem([
        { when: !i.entries || i.entries.length !== 2, code: 'ARTIFACT_SHAPE', reason: 'The artifact must contain the receipt and exactly one tarball, found ' + (i.entries ? i.entries.length : 0) },
        { when: i.entries && i.entries.some(entry => entry.kind !== 'file'), code: 'ARTIFACT_SHAPE', reason: 'The artifact must not contain directories' },
        { when: i.entries && !i.entries.some(entry => entry.name === RECEIPT_NAME), code: 'ARTIFACT_RECEIPT', reason: 'The prepare receipt is missing' },
        { when: i.entries && i.entries.filter(entry => entry.name.endsWith('.tgz')).length !== 1, code: 'ARTIFACT_SHAPE', reason: 'The artifact must contain exactly one tarball' },
        { when: i.entries && i.entries.some(entry => entry.name.includes('/') || entry.name.includes('\\') || entry.name.startsWith('.')), code: 'ARTIFACT_PATH', reason: 'The artifact contains an unexpected entry name' },
    ]);
}

// Pure: the receipt, the caller supplied review hashes, the tarball bytes and
// the tarball's own manifest must all agree.
function checkArtifactBinding(i) {
    return C.firstProblem([
        { when: !i.receipt || i.receipt.schema !== RECEIPT_SCHEMA, code: 'RECEIPT_SCHEMA', reason: 'The prepare receipt has an unknown schema' },
        { when: i.receipt && i.receipt.status !== 'PREPARED_NOT_PUBLISHED', code: 'RECEIPT_STATUS', reason: 'The prepare receipt is in state ' + (i.receipt ? i.receipt.status : '?') },
        { when: i.receipt && i.receipt.name !== i.packageName, code: 'RECEIPT_NAME', reason: 'The receipt names ' + (i.receipt ? i.receipt.name : '?') },
        { when: i.receipt && i.receipt.version !== i.expectedVersion, code: 'RECEIPT_VERSION', reason: 'The receipt carries version ' + (i.receipt ? i.receipt.version : '?') },
        { when: i.receipt && i.receipt.sourceSha !== i.expectedSourceSha, code: 'RECEIPT_SOURCE', reason: 'The receipt was built from another commit' },
        { when: i.receipt && i.receipt.tarball && i.receipt.tarball.sha256 !== i.expectedSha256, code: 'REVIEW_SHA256', reason: 'The reviewed sha256 does not match the prepared artifact' },
        { when: i.receipt && i.receipt.tarball && i.receipt.tarball.integrity !== i.expectedSRI, code: 'REVIEW_SRI', reason: 'The reviewed integrity does not match the prepared artifact' },
        { when: i.receipt && i.receipt.tarball && i.receipt.tarball.file !== i.tarballName, code: 'RECEIPT_TARBALL', reason: 'The receipt names a different tarball' },
        { when: i.actualSha256 !== i.expectedSha256, code: 'BYTES_SHA256', reason: 'The downloaded tarball is not the reviewed tarball' },
        { when: i.actualSRI !== i.expectedSRI, code: 'BYTES_SRI', reason: 'The downloaded tarball is not the reviewed tarball' },
        { when: i.manifestFiles && i.receipt && i.receipt.files && i.manifestFiles.length !== i.receipt.files.length, code: 'MANIFEST_FILES', reason: 'The tarball holds ' + (i.manifestFiles ? i.manifestFiles.length : 0) + ' files, the receipt lists ' + (i.receipt && i.receipt.files ? i.receipt.files.length : 0) },
        { when: i.manifestFiles && i.receipt && i.receipt.files && i.manifestFiles.some(name => !i.receipt.files.includes(name)), code: 'MANIFEST_FILES', reason: 'The tarball contains a file the receipt does not list' },
        { when: i.manifestFiles && i.receipt && i.receipt.files && i.receipt.files.some(name => !i.manifestFiles.includes(name)), code: 'MANIFEST_FILES', reason: 'The receipt lists a file the tarball does not contain' },
        { when: i.unsafePaths && i.unsafePaths.length > 0, code: 'MANIFEST_UNSAFE', reason: 'The tarball contains an unsafe path' },
        { when: !i.manifest || !i.manifest.name, code: 'MANIFEST_PACKAGE', reason: 'The tarball has no package.json' },
        { when: i.manifest && i.manifest.name !== i.packageName, code: 'MANIFEST_NAME', reason: 'The tarball names ' + (i.manifest ? i.manifest.name : '?') },
        { when: i.manifest && i.manifest.version !== i.expectedVersion, code: 'MANIFEST_VERSION', reason: 'The tarball carries version ' + (i.manifest ? i.manifest.version : '?') },
    ]);
}

// Pure: the registry outcome after a publication. The dist-tag assertions
// only apply when this route published; a reconciliation never moves a tag,
// so it must not be judged by them.
function checkRegistryOutcome(i) {
    return C.firstProblem([
        { when: !i.meta || !i.meta.dist || !i.meta.dist.integrity, code: 'NO_RECEIPT', reason: 'The registry does not expose this version yet' },
        { when: i.meta && i.meta.name !== i.packageName, code: 'RECEIPT_NAME', reason: 'The registry returned ' + (i.meta ? i.meta.name : '?') },
        { when: i.meta && i.meta.version !== i.expectedVersion, code: 'RECEIPT_VERSION', reason: 'The registry returned version ' + (i.meta ? i.meta.version : '?') },
        { when: i.meta && i.meta.dist.integrity !== i.expectedSRI, code: 'INTEGRITY', reason: 'The registry artifact differs from the reviewed tarball; do not republish blindly' },
        { when: i.requireTags && i.nextAfter !== i.expectedVersion, code: 'NEXT_NOT_MOVED', reason: 'the next tag is ' + i.nextAfter + ', not the candidate' },
        { when: i.requireTags && i.latestAfter !== i.baselineLatest, code: 'LATEST_CHANGED', reason: 'latest moved from ' + i.baselineLatest + ' to ' + i.latestAfter + '; this route never moves latest' },
    ]);
}

function listDirectory(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).map(entry => ({ name: entry.name, kind: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other' }));
}

// npm publish runs with the inherited environment so the GitHub OIDC
// variables reach npm's own trusted-publishing flow. The output is captured
// and redacted before it is written next to the receipt.
function runNpm(args, options = {}) {
    const result = spawnSync('npm', args, { encoding: 'utf8', shell: false, windowsHide: true, timeout: 900000, maxBuffer: 16 * 1024 * 1024, ...options });
    return { status: result.status, stdout: String(result.stdout || ''), stderr: String(result.stderr || '') };
}

function readInputs(env) {
    return {
        repository: env.GITHUB_REPOSITORY,
        workflowRef: String(env.GITHUB_WORKFLOW_REF || ''),
        eventName: env.GITHUB_EVENT_NAME,
        packageName: String(env.TARGET_PACKAGE || '').trim(),
        expectedVersion: String(env.EXPECTED_VERSION || '').trim(),
        expectedSha256: String(env.EXPECTED_SHA256 || '').trim().toLowerCase(),
        expectedSRI: String(env.EXPECTED_SRI || '').trim(),
        expectedSourceSha: String(env.EXPECTED_SOURCE_SHA || '').trim(),
        prepareRunId: String(env.PREPARE_RUN_ID || '').trim(),
        reviewer: String(env.REVIEWER || '').trim(),
        artifactDir: String(env.ARTIFACT_DIR || '').trim(),
        currentRunId: String(env.GITHUB_RUN_ID || '').trim(),
        token: env.GH_TOKEN || env.GITHUB_TOKEN || '',
    };
}

async function fetchPrepareRun(inputs, fetchImpl) {
    const run = await C.githubJson('/repos/' + C.REPOSITORY + '/actions/runs/' + encodeURIComponent(inputs.prepareRunId), inputs.token, fetchImpl);
    return run;
}

async function verifyRun(options = {}) {
    const env = options.env || process.env;
    const fetchImpl = options.fetchImpl || globalThis.fetch;
    const inputs = readInputs(env);
    const verdict = checkPublishBinding(inputs);
    must(verdict.ok, verdict.code || 'PUBLISH_INPUT', verdict.reason || 'publish input refused');
    const run = await fetchPrepareRun(inputs, fetchImpl);
    const runVerdict = checkPrepareRun({ run, expectedSourceSha: inputs.expectedSourceSha, prepareRunId: inputs.prepareRunId, currentRunId: inputs.currentRunId });
    must(runVerdict.ok, runVerdict.code || 'PREPARE_RUN', runVerdict.reason || 'prepare run refused');
    const verified = {
        schema: 'project-knowledge/stable-next-prepare-run/v1',
        prepareRunId: inputs.prepareRunId,
        sourceSha: run.head_sha,
        workflow: run.path,
        conclusion: run.conclusion,
        verifiedAt: new Date().toISOString(),
    };
    const dir = path.join(env.RUNNER_TEMP, 'stable-next');
    fs.mkdirSync(dir, { recursive: true });
    atomicJSON(path.join(dir, 'verified-run.json'), verified);
    if (env.GITHUB_OUTPUT) {
        fs.appendFileSync(env.GITHUB_OUTPUT, 'prepare_run_id=' + inputs.prepareRunId + '\n');
        fs.appendFileSync(env.GITHUB_OUTPUT, 'source_sha=' + run.head_sha + '\n');
    }
    return verified;
}

async function publish(options = {}) {
    const env = options.env || process.env;
    const fetchImpl = options.fetchImpl || globalThis.fetch;
    const inputs = readInputs(env);
    const verdict = checkPublishBinding(inputs);
    must(verdict.ok, verdict.code || 'PUBLISH_INPUT', verdict.reason || 'publish input refused');
    must(inputs.artifactDir, 'ARTIFACT_DIR', 'The downloaded artifact directory is required');

    const run = await fetchPrepareRun(inputs, fetchImpl);
    const runVerdict = checkPrepareRun({ run, expectedSourceSha: inputs.expectedSourceSha, prepareRunId: inputs.prepareRunId, currentRunId: inputs.currentRunId });
    must(runVerdict.ok, runVerdict.code || 'PREPARE_RUN', runVerdict.reason || 'prepare run refused');

    const entries = listDirectory(inputs.artifactDir);
    const shape = checkArtifactDirectory({ entries });
    must(shape.ok, shape.code || 'ARTIFACT', shape.reason || 'artifact refused');
    const receipt = readJSON(path.join(inputs.artifactDir, RECEIPT_NAME));
    const tarballName = entries.find(entry => entry.name.endsWith('.tgz')).name;
    const bytes = fs.readFileSync(path.join(inputs.artifactDir, tarballName));
    const manifest = C.readTarball(bytes);
    const manifestFiles = C.relativePaths(manifest.files);
    const binding = checkArtifactBinding({
        receipt,
        packageName: inputs.packageName,
        expectedVersion: inputs.expectedVersion,
        expectedSourceSha: inputs.expectedSourceSha,
        expectedSha256: inputs.expectedSha256,
        expectedSRI: inputs.expectedSRI,
        tarballName,
        actualSha256: C.sha256Hex(bytes),
        actualSRI: C.sriOf(bytes),
        manifestFiles,
        manifest: manifest.packageJson,
        unsafePaths: C.unsafePaths(manifest.files),
    });
    must(binding.ok, binding.code || 'BINDING', binding.reason || 'artifact binding refused');

    const existing = await C.registryVersionMeta(inputs.packageName, inputs.expectedVersion, fetchImpl);
    const baseline = receipt.baseline || { latest: null, next: null };
    let published = false;

    if (existing !== null) {
        // Reconciliation: the exact version already exists. Never republish
        // and never move a tag; only an identical SRI is accepted.
        must(existing.dist && existing.dist.integrity === inputs.expectedSRI, 'VERSION_OCCUPIED_MISMATCH', 'The published version has a different integrity; reconcile manually');
    } else {
        const publishNpm = options.runNpm || runNpm;
        const result = publishNpm(['publish', path.join(inputs.artifactDir, tarballName), '--tag', PUBLISH_TAG, '--access', 'public', '--provenance'], { cwd: process.cwd() });
        published = true;
        const dir = path.join(env.RUNNER_TEMP, 'stable-next');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'publish.log'), redact(result.stdout + '\n' + result.stderr), { mode: 0o600 });
        must(result.status === 0, 'PUBLISH_FAILED', 'npm publish exited ' + result.status + '; see the redacted publish log', 20);
    }

    let meta = null;
    for (let attempt = 0; attempt < REGISTRY_POLL_ATTEMPTS; attempt++) {
        meta = await C.registryVersionMeta(inputs.packageName, inputs.expectedVersion, fetchImpl);
        if (meta && meta.dist && meta.dist.integrity)
            break;
        await new Promise(resolve => setTimeout(resolve, REGISTRY_POLL_DELAY_MS));
    }
    const tags = await C.registryDistTags(inputs.packageName, fetchImpl);
    const outcome = checkRegistryOutcome({
        meta,
        packageName: inputs.packageName,
        expectedVersion: inputs.expectedVersion,
        expectedSRI: inputs.expectedSRI,
        nextAfter: tags.next || null,
        latestAfter: tags.latest || null,
        baselineLatest: baseline.latest || null,
        requireTags: published,
    });
    must(outcome.ok, outcome.code || 'REGISTRY_OUTCOME', outcome.reason || 'registry outcome refused');

    const receiptOut = {
        schema: PUBLISH_SCHEMA,
        status: published ? 'PUBLISHED_NEXT' : 'ALREADY_PUBLISHED_VERIFIED',
        name: inputs.packageName,
        version: inputs.expectedVersion,
        sourceSha: inputs.expectedSourceSha,
        prepareRunId: inputs.prepareRunId,
        reviewer: inputs.reviewer,
        tarball: { file: tarballName, sha256: inputs.expectedSha256, integrity: inputs.expectedSRI, bytes: bytes.length },
        fileCount: manifestFiles.length,
        distTag: PUBLISH_TAG,
        baseline: { latest: baseline.latest || null, next: baseline.next || null },
        observed: { latest: tags.latest || null, next: tags.next || null },
        latestUnchanged: (tags.latest || null) === (baseline.latest || null),
        publishedAt: new Date().toISOString(),
    };
    const dir = path.join(env.RUNNER_TEMP, 'stable-next');
    fs.mkdirSync(dir, { recursive: true });
    atomicJSON(path.join(dir, 'publication-receipt.json'), receiptOut);
    return receiptOut;
}

async function main() {
    const action = process.argv[2];
    if (action === 'verify-run') {
        const verified = await verifyRun();
        process.stdout.write(JSON.stringify(verified) + '\n');
        return;
    }
    if (action === 'publish') {
        const receipt = await publish();
        process.stdout.write(JSON.stringify(receipt) + '\n');
        return;
    }
    throw new Error('Unknown action: use verify-run or publish');
}

module.exports = {
    checkPublishBinding, checkPrepareRun, checkArtifactDirectory, checkArtifactBinding, checkRegistryOutcome,
    verifyRun, publish, listDirectory, RECEIPT_NAME, RECEIPT_SCHEMA, PUBLISH_SCHEMA, PUBLISH_TAG,
};

if (require.main === module) {
    main().catch(error => {
        process.stderr.write((error.code ? error.code + ' ' : '') + (error.message || String(error)) + '\n');
        process.exitCode = error.exitCode || 20;
    });
}
