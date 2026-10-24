'use strict';
// Offline positive/negative contract tests for stable-next-prepare.cjs.
// Pure-function fixtures only: no network, no registry, no git, no npm, no
// packaging. Contract negatives required by the lane: wrong repository /
// workflow / event / ref / package / version / SHA, stale lock, dirty tree,
// unreviewed CI, occupied version and untracked source bytes.
// Run: node qa-autopilot/tools/stable-next-prepare-test.cjs

const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const g = require('./stable-next-prepare.cjs');
const C = require('./stable-next-common.cjs');

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const VERSION = '5.0.25';

function input(over = {}) {
    return {
        repository: C.REPOSITORY,
        workflowRef: C.WORKFLOW_REF_PREFIX + 'main',
        eventName: 'workflow_dispatch',
        sourceSha: SHA_A,
        expectedVersion: VERSION,
        packageName: C.CORE_PACKAGE,
        sourceVersion: VERSION,
        lockVersion: VERSION,
        lockRootVersion: VERSION,
        desktopVersion: VERSION,
        desktopCorePin: VERSION,
        headSha: SHA_A,
        dirty: false,
        onDispatchRef: true,
        ciStatus: 'PASS',
        registryVersionExists: false,
        ...over,
    };
}

function expectCode(name, verdict, code) {
    assert.strictEqual(verdict.ok, false, name + ' should fail');
    assert.strictEqual(verdict.code, code, name + ' expected ' + code + ' got ' + verdict.code + ' (' + verdict.reason + ')');
}

function packList(over = {}) {
    const integrity = over.integrity || 'sha512-' + crypto.createHash('sha512').update('tarball-bytes').digest('base64');
    return [{
        name: over.name || C.CORE_PACKAGE,
        version: over.version || VERSION,
        filename: over.filename || 'sanqianx-project-knowledge-5.0.25.tgz',
        integrity,
        files: over.files || [{ path: 'package.json' }, { path: 'ui/index.html' }],
    }];
}

function packInput(list, over = {}) {
    return {
        list,
        packageName: over.packageName || C.CORE_PACKAGE,
        expectedVersion: over.expectedVersion || VERSION,
        tarballExists: over.tarballExists !== undefined ? over.tarballExists : true,
        tarballIntegrity: over.tarballIntegrity !== undefined ? over.tarballIntegrity : (list[0] ? list[0].integrity : null),
        untracked: over.untracked || [],
    };
}

test('prepare accepts a fully valid core candidate', () => {
    const verdict = g.checkPrepareCandidate(input());
    assert.strictEqual(verdict.ok, true, JSON.stringify(verdict));
});

test('prepare refuses another repository', () => {
    expectCode('wrong repository', g.checkPrepareCandidate(input({ repository: 'someone/else' })), 'CI_IDENTITY');
});

test('prepare refuses another workflow file', () => {
    expectCode('wrong workflow', g.checkPrepareCandidate(input({ workflowRef: C.REPOSITORY + '/.github/workflows/other.yml@main' })), 'WORKFLOW_IDENTITY');
});

test('prepare refuses a non manual event', () => {
    expectCode('push event', g.checkPrepareCandidate(input({ eventName: 'push' })), 'MANUAL_ONLY');
});

test('prepare refuses a malformed commit id', () => {
    expectCode('short sha', g.checkPrepareCandidate(input({ sourceSha: 'abc' })), 'SHA_FORMAT');
});

test('prepare refuses a prerelease version', () => {
    expectCode('rc version', g.checkPrepareCandidate(input({ expectedVersion: '5.0.25-rc.3' })), 'VERSION_SEMVER');
});

test('prepare refuses an unknown package', () => {
    expectCode('unknown package', g.checkPrepareCandidate(input({ packageName: '@sanqianx/something-else' })), 'PACKAGE_NAME');
});

test('prepare refuses the unauthorized desktop package without blocking core', () => {
    expectCode('desktop', g.checkPrepareCandidate(input({ packageName: C.DESKTOP_PACKAGE })), 'DESKTOP_IDENTITY_UNAUTHORIZED');
    assert.strictEqual(g.checkPrepareCandidate(input({ packageName: C.CORE_PACKAGE })).ok, true);
});

test('prepare refuses a source version that differs from the request', () => {
    expectCode('source version', g.checkPrepareCandidate(input({ sourceVersion: '5.0.24' })), 'VERSION_INPUT');
});

test('prepare refuses a stale lockfile', () => {
    expectCode('lock version', g.checkPrepareCandidate(input({ lockVersion: '5.0.24' })), 'LOCK_STALE');
    expectCode('lock root version', g.checkPrepareCandidate(input({ lockRootVersion: '5.0.24' })), 'LOCK_STALE');
});

test('prepare refuses a desktop package out of sync', () => {
    expectCode('desktop version', g.checkPrepareCandidate(input({ desktopVersion: '5.0.24' })), 'THREE_SYNC');
});

test('prepare refuses a desktop core pin out of sync', () => {
    expectCode('desktop pin', g.checkPrepareCandidate(input({ desktopCorePin: '5.0.24' })), 'THREE_SYNC');
});

test('prepare refuses a checkout that is not the reviewed commit', () => {
    expectCode('head sha', g.checkPrepareCandidate(input({ headSha: SHA_B })), 'SHA_MATCH');
});

test('prepare refuses a dirty tracked tree', () => {
    expectCode('dirty tree', g.checkPrepareCandidate(input({ dirty: true })), 'DIRTY_TREE');
});

test('prepare refuses a commit that is not on the dispatched ref', () => {
    expectCode('ref mismatch', g.checkPrepareCandidate(input({ onDispatchRef: false })), 'REF_MISMATCH');
});

test('prepare refuses a candidate whose current CI run is not green', () => {
    expectCode('ci pending', g.checkPrepareCandidate(input({ ciStatus: 'PENDING' })), 'CI_NOT_GREEN');
    expectCode('ci failed', g.checkPrepareCandidate(input({ ciStatus: 'FAIL' })), 'CI_NOT_GREEN');
});

test('prepare refuses an occupied version', () => {
    expectCode('occupied', g.checkPrepareCandidate(input({ registryVersionExists: true })), 'VERSION_OCCUPIED');
});

test('prepare accepts a packed candidate that matches the review', () => {
    const verdict = g.checkPackedCandidate(packInput(packList()));
    assert.strictEqual(verdict.ok, true, JSON.stringify(verdict));
});

test('prepare refuses a pack that produced more than one tarball', () => {
    expectCode('pack shape', g.checkPackedCandidate(packInput([])), 'PACK_RESULT');
});

test('prepare refuses a packed package of another name or version', () => {
    expectCode('pack id', g.checkPackedCandidate(packInput(packList({ name: '@sanqianx/other' }))), 'PACK_ID');
    expectCode('pack version', g.checkPackedCandidate(packInput(packList({ version: '5.0.24' }))), 'PACK_ID');
});

test('prepare refuses an invalid tarball filename', () => {
    expectCode('tarball name', g.checkPackedCandidate(packInput(packList({ filename: 'evil.sh' }))), 'TARBALL_NAME');
});

test('prepare refuses a missing tarball', () => {
    expectCode('tarball missing', g.checkPackedCandidate(packInput(packList(), { tarballExists: false })), 'TARBALL_MISSING');
});

test('prepare refuses a tarball whose digest differs from the pack manifest', () => {
    expectCode('integrity', g.checkPackedCandidate(packInput(packList(), { tarballIntegrity: 'sha512-' + 'A'.repeat(86) + '==' })), 'TARBALL_INTEGRITY');
});

test('prepare refuses bytes the reviewed commit does not track', () => {
    expectCode('untracked', g.checkPackedCandidate(packInput(packList(), { untracked: ['qa-autopilot/tools/local-helper.cjs'] })), 'UNTRACKED_SOURCE');
});

test('untrackedPaths reports only packed files outside the tracked set', () => {
    const tracked = ['package.json', 'ui/index.html'];
    assert.deepStrictEqual(C.untrackedPaths(['package.json', 'ui/index.html'], tracked), []);
    assert.deepStrictEqual(C.untrackedPaths(['package.json', 'ui/stray.html'], tracked), ['ui/stray.html']);
});

test('the required CI matrix is the reviewed Core3 plus QA3 set', () => {
    assert.strictEqual(C.REQUIRED_CI_JOBS.length, 6);
    assert.ok(C.REQUIRED_CI_JOBS.some(job => job.startsWith('Core /')));
    assert.ok(C.REQUIRED_CI_JOBS.some(job => job.startsWith('QA controller /')));
});

test('the stable channel accepts only plain x.y.z versions', () => {
    assert.ok(C.STABLE_VERSION.test('5.0.25'));
    assert.ok(!C.STABLE_VERSION.test('5.0.25-rc.1'));
    assert.ok(!C.STABLE_VERSION.test('v5.0.25'));
    assert.ok(!C.STABLE_VERSION.test('5.0'));
});

test('the desktop package stays optional and outside the publish allowlist', () => {
    assert.ok(C.ALLOWED_PACKAGES.includes(C.DESKTOP_PACKAGE));
    assert.notStrictEqual(C.CORE_PACKAGE, C.DESKTOP_PACKAGE);
});
