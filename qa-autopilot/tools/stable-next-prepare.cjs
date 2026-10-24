'use strict';
// Manual stable-candidate preparation (ASSESSMENT + ARTIFACT, no publication).
//
// This tool never publishes. It builds ONE candidate tarball from ONE
// reviewed commit and records an immutable metadata receipt next to it. The
// "publish-next" route in stable-next-publish.cjs consumes that receipt.
//
// Refusals are deliberate and fail closed:
//   wrong repository / workflow / event / ref / package / version / SHA,
//   a dirty tracked tree, a source that is not an ancestor of the dispatched
//   ref, the current CI run for that SHA not green, a stale lock file, a
//   vendored-runtime integrity drift, an occupied version, or a tarball that
//   contains bytes the reviewed commit does not track.
//
// Usage: node qa-autopilot/tools/stable-next-prepare.cjs
// Inputs (environment only, never interpolated into a shell):
//   TARGET_PACKAGE, SOURCE_SHA, EXPECTED_VERSION, GH_TOKEN, RUNNER_TEMP

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { must, readJSON, atomicJSON, commandSync } = require('../lib/safety.cjs');
const { validatePack, ciStatus } = require('../lib/registry.cjs');
const C = require('./stable-next-common.cjs');

const ARTIFACT_DIR = 'stable-next';
const RECEIPT_NAME = 'candidate-receipt.json';

// Pure: every refusal of the prepare route that can be decided from the
// local checkout, without touching the network.
function checkPrepareSource(i) {
    return C.firstProblem([
        { when: i.repository !== C.REPOSITORY, code: 'CI_IDENTITY', reason: 'Only ' + C.REPOSITORY + ' may prepare a stable candidate' },
        { when: !i.workflowRef.startsWith(C.WORKFLOW_REF_PREFIX), code: 'WORKFLOW_IDENTITY', reason: 'The job must run from ' + C.WORKFLOW_PATH },
        { when: i.eventName !== 'workflow_dispatch', reason: 'This route only runs on a manual dispatch', code: 'MANUAL_ONLY' },
        { when: !C.SHA40.test(i.sourceSha || ''), code: 'SHA_FORMAT', reason: 'Exact 40-hex commit SHA required' },
        { when: !C.STABLE_VERSION.test(i.expectedVersion || ''), code: 'VERSION_SEMVER', reason: 'The stable channel requires a plain x.y.z version' },
        { when: !C.ALLOWED_PACKAGES.includes(i.packageName), code: 'PACKAGE_NAME', reason: 'Unknown target package' },
        { when: i.packageName === C.DESKTOP_PACKAGE, code: 'DESKTOP_IDENTITY_UNAUTHORIZED', reason: 'The desktop package has no authorized OIDC identity (measured 404), so a prepared desktop artifact could never be published; the desktop channel stays optional and must not block the core release' },
        { when: i.packageName !== C.CORE_PACKAGE, code: 'PACKAGE_NAME', reason: 'This route prepares the core package only' },
        { when: i.sourceVersion !== i.expectedVersion, code: 'VERSION_INPUT', reason: 'source package.json is ' + i.sourceVersion + ', not the requested ' + i.expectedVersion + '; the route never bumps a version' },
        { when: i.lockVersion !== i.expectedVersion || i.lockRootVersion !== i.expectedVersion, code: 'LOCK_STALE', reason: 'package-lock.json is not in lockstep with ' + i.expectedVersion },
        { when: i.desktopVersion !== i.expectedVersion, code: 'THREE_SYNC', reason: 'desktop package.json is ' + i.desktopVersion + ', not ' + i.expectedVersion },
        { when: i.desktopCorePin !== i.expectedVersion, code: 'THREE_SYNC', reason: 'the desktop core pin is ' + i.desktopCorePin + ', not ' + i.expectedVersion },
        { when: i.headSha !== i.sourceSha, code: 'SHA_MATCH', reason: 'checked-out HEAD ' + i.headSha + ' is not the requested ' + i.sourceSha },
        { when: i.dirty, code: 'DIRTY_TREE', reason: 'Tracked files differ from the reviewed commit' },
        { when: !i.onDispatchRef, code: 'REF_MISMATCH', reason: 'The reviewed commit is not an ancestor of the dispatched ref' },
    ]);
}

// Pure: the two refusals that depend on the registry and on the CI run.
function checkPrepareRemote(i) {
    return C.firstProblem([
        { when: i.ciStatus !== 'PASS', code: 'CI_NOT_GREEN', reason: 'The current CI run for ' + i.sourceSha + ' is ' + i.ciStatus },
        { when: i.registryVersionExists, code: 'VERSION_OCCUPIED', reason: i.packageName + '@' + i.expectedVersion + ' already exists; versions are immutable and are never overwritten' },
    ]);
}

// Pure: every refusal of the prepare route, evaluated in one pass.
function checkPrepareCandidate(i) {
    const local = checkPrepareSource(i);
    return local.ok ? checkPrepareRemote(i) : local;
}

// Pure: the packed tarball must be exactly the reviewed package.
function checkPackedCandidate(i) {
    const list = i.list;
    const shape = C.firstProblem([
        { when: !Array.isArray(list) || list.length !== 1, code: 'PACK_RESULT', reason: 'npm pack did not produce exactly one tarball' },
    ]);
    if (!shape.ok)
        return shape;
    return C.firstProblem([
        { when: list[0].name !== i.packageName || list[0].version !== i.expectedVersion, code: 'PACK_ID', reason: 'pack produced ' + list[0].name + '@' + list[0].version },
        { when: !/^[A-Za-z0-9._-]+\.tgz$/.test(list[0].filename || ''), code: 'TARBALL_NAME', reason: 'invalid tarball filename' },
        { when: !i.tarballExists, code: 'TARBALL_MISSING', reason: 'the packed tarball is not on disk' },
        { when: i.tarballIntegrity !== list[0].integrity, code: 'TARBALL_INTEGRITY', reason: 'the on-disk tarball digest differs from the npm pack manifest' },
        { when: i.untracked.length > 0, code: 'UNTRACKED_SOURCE', reason: 'the tarball would contain ' + i.untracked.length + ' file(s) the reviewed commit does not track' },
    ]);
}

function git(args, options = {}) {
    const result = spawnSync('git', args, { encoding: 'utf8', shell: false, windowsHide: true, timeout: 60000, ...options });
    return { status: result.status, stdout: String(result.stdout || '').trim(), stderr: String(result.stderr || '') };
}

function trackedPaths() {
    const result = git(['ls-files', '-z']);
    must(result.status === 0, 'GIT', 'git ls-files failed');
    return result.stdout.split('\0').filter(Boolean);
}

function isAncestor(ancestor, descendant) {
    if (!C.SHA40.test(ancestor || '') || !C.SHA40.test(descendant || ''))
        return false;
    return git(['merge-base', '--is-ancestor', ancestor, descendant]).status === 0;
}

function npmPackOnce(destination, exec = commandSync) {
    const existing = fs.existsSync(destination) ? fs.readdirSync(destination).filter(name => name.endsWith('.tgz')) : [];
    must(existing.length === 0, 'PACK_ALREADY_PRESENT', 'A tarball already exists in the candidate directory; packing happens exactly once');
    const text = exec('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', destination], { cwd: process.cwd(), timeout: 600000 });
    return JSON.parse(text);
}

async function prepare(options = {}) {
    const env = options.env || process.env;
    const fetchImpl = options.fetchImpl || globalThis.fetch;
    const exec = options.exec || commandSync;
    const root = options.root || process.cwd();
    const runnerTemp = env.RUNNER_TEMP;
    must(runnerTemp, 'RUNNER_TEMP', 'RUNNER_TEMP is required');
    const dir = path.join(runnerTemp, ARTIFACT_DIR);
    fs.mkdirSync(dir, { recursive: true });

    const sourceSha = String(env.SOURCE_SHA || '').trim();
    const expectedVersion = String(env.EXPECTED_VERSION || '').trim();
    const targetPackage = String(env.TARGET_PACKAGE || '').trim();

    const rootPkg = readJSON(path.join(root, 'package.json'));
    const lock = readJSON(path.join(root, 'package-lock.json'));
    const desktopPkg = readJSON(path.join(root, 'desktop', 'package.json'));

    const headSha = git(['rev-parse', 'HEAD']).stdout;
    const dirty = git(['status', '--porcelain', '--untracked-files=no']).stdout !== '';
    const onDispatchRef = isAncestor(sourceSha, String(env.GITHUB_SHA || '').trim());

    const sourceFacts = {
        repository: env.GITHUB_REPOSITORY,
        workflowRef: String(env.GITHUB_WORKFLOW_REF || ''),
        eventName: env.GITHUB_EVENT_NAME,
        sourceSha,
        expectedVersion,
        packageName: targetPackage,
        sourceVersion: rootPkg.version,
        lockVersion: lock.version,
        lockRootVersion: lock.packages && lock.packages[''] ? lock.packages[''].version : null,
        desktopVersion: desktopPkg.version,
        desktopCorePin: desktopPkg.dependencies ? desktopPkg.dependencies[C.CORE_PACKAGE] : null,
        headSha,
        dirty,
        onDispatchRef,
    };
    const sourceVerdict = checkPrepareSource(sourceFacts);
    must(sourceVerdict.ok, sourceVerdict.code || 'PREPARE', sourceVerdict.reason || 'prepare refused');

    const existing = await C.registryVersionMeta(targetPackage, expectedVersion, fetchImpl);
    const tags = await C.registryDistTags(targetPackage, fetchImpl);
    const ci = await ciStatus({ githubRepo: C.REPOSITORY, mainBranch: 'main', ciRequiredJobs: [...C.REQUIRED_CI_JOBS] }, sourceSha);

    const remoteVerdict = checkPrepareRemote({
        sourceSha,
        packageName: targetPackage,
        expectedVersion,
        ciStatus: ci.status,
        registryVersionExists: existing !== null,
    });
    must(remoteVerdict.ok, remoteVerdict.code || 'PREPARE', remoteVerdict.reason || 'prepare refused');

    const list = npmPackOnce(dir, exec);
    const filename = Array.isArray(list) && list[0] ? list[0].filename : null;
    const tarballPath = filename ? path.join(dir, filename) : null;
    const bytes = tarballPath && fs.existsSync(tarballPath) ? fs.readFileSync(tarballPath) : null;
    const packedPaths = Array.isArray(list) && list[0] ? list[0].files.map(file => file.path) : [];
    const untracked = C.untrackedPaths(packedPaths, trackedPaths());
    const packVerdict = checkPackedCandidate({
        list,
        packageName: targetPackage,
        expectedVersion,
        tarballExists: bytes !== null,
        tarballIntegrity: bytes ? C.sriOf(bytes) : null,
        untracked,
    });
    must(packVerdict.ok, packVerdict.code || 'PACK', packVerdict.reason || 'pack refused');
    validatePack(list[0].files);

    const receipt = {
        schema: 'project-knowledge/stable-next-candidate/v1',
        status: 'PREPARED_NOT_PUBLISHED',
        name: targetPackage,
        version: expectedVersion,
        sourceSha,
        tarball: {
            file: filename,
            bytes: bytes.length,
            sha256: C.sha256Hex(bytes),
            integrity: C.sriOf(bytes),
        },
        fileCount: packedPaths.length,
        files: packedPaths,
        baseline: {
            latest: tags.latest || null,
            next: tags.next || null,
        },
        ci: { status: ci.status, runId: ci.runId || null, sha: ci.sha, jobs: ci.jobs || [] },
        preparedBy: {
            repository: C.REPOSITORY,
            workflow: C.WORKFLOW_PATH,
            runId: env.GITHUB_RUN_ID || null,
            attempt: env.GITHUB_RUN_ATTEMPT || null,
        },
        preparedAt: new Date().toISOString(),
    };
    atomicJSON(path.join(dir, RECEIPT_NAME), receipt);
    return { receipt, dir, tarballPath };
}

async function main() {
    const result = await prepare();
    process.stdout.write(JSON.stringify({
        status: result.receipt.status,
        name: result.receipt.name,
        version: result.receipt.version,
        sourceSha: result.receipt.sourceSha,
        sha256: result.receipt.tarball.sha256,
        integrity: result.receipt.tarball.integrity,
        fileCount: result.receipt.fileCount,
        baseline: result.receipt.baseline,
    }) + '\n');
}

module.exports = { checkPrepareSource, checkPrepareRemote, checkPrepareCandidate, checkPackedCandidate, prepare, isAncestor, ARTIFACT_DIR, RECEIPT_NAME };

if (require.main === module) {
    main().catch(error => {
        process.stderr.write((error.code ? error.code + ' ' : '') + (error.message || String(error)) + '\n');
        process.exitCode = error.exitCode || 20;
    });
}
