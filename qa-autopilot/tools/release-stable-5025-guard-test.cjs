'use strict';
// Offline positive/negative contract tests for release-stable-5025-guard.cjs.
// Pure-function fixtures only: no network, no registry, no git, no publish.
// Contract negatives required by the lane: wrong SHA / version / tag /
// channel, version already exists, wrong package, integrity mismatch — plus
// every other guard code. Run: node qa-autopilot/tools/release-stable-5025-guard-test.cjs

const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const crypto = require('node:crypto');
const g = require('./release-stable-5025-guard.cjs');

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

function coreInput(over = {}) {
  return {
    repository: 'SanQianX/project-knowledge-base', runTemp: '/runner/temp', eventName: 'workflow_dispatch',
    packageName: g.CORE_PACKAGE, packageVersion: '5.0.25',
    inputVersion: '5.0.25', inputSha: SHA_A, headSha: SHA_A, tagSha: SHA_A,
    onMain: true, dirty: false,
    desktopVersion: '5.0.25', desktopCorePin: '5.0.25',
    registryVersionExists: false,
    ...over,
  };
}

function desktopInput(over = {}) {
  return {
    repository: 'SanQianX/project-knowledge-base', runTemp: '/runner/temp', eventName: 'workflow_dispatch',
    packageName: g.DESKTOP_PACKAGE, packageVersion: '5.0.25',
    inputVersion: '5.0.25',
    desktopCorePin: '5.0.25', coreRegistryVersion: '5.0.25',
    registryVersionExists: false,
    ...over,
  };
}

function packList(files, over = {}) {
  const sha512 = over.sha512 || crypto.createHash('sha512').update('tarball-bytes').digest('base64');
  return [{
    name: over.name || g.CORE_PACKAGE,
    version: over.version || '5.0.25',
    filename: over.filename || 'pkg-5.0.25.tgz',
    integrity: over.integrity || 'sha512-' + sha512,
    files,
  }];
}

function packInput(list, over = {}) {
  return {
    list,
    packageName: over.packageName || g.CORE_PACKAGE,
    packageVersion: over.packageVersion || '5.0.25',
    required: over.required || [],
    forbidden: over.forbidden || [],
    tarballExists: over.tarballExists !== undefined ? over.tarballExists : true,
    tarballSha512: over.tarballSha512 || crypto.createHash('sha512').update('tarball-bytes').digest('base64'),
  };
}

function receiptInput(over = {}) {
  const integrity = over.integrity || 'sha512-' + crypto.createHash('sha512').update('tarball-bytes').digest('base64');
  return {
    registryMeta: over.registryMeta === undefined ? { name: over.packageName || g.CORE_PACKAGE, version: '5.0.25', dist: { integrity } } : over.registryMeta,
    packageName: over.packageName || g.CORE_PACKAGE,
    packageVersion: over.packageVersion || '5.0.25',
    pack: { integrity },
    latestAfter: over.latestAfter || '5.0.25',
    beforeNext: over.beforeNext === undefined ? '5.0.24' : over.beforeNext,
    nextAfter: over.nextAfter === undefined ? '5.0.24' : over.nextAfter,
  };
}

function expectCode(name, verdict, code) {
  assert.strictEqual(verdict.ok, false, name + ' should fail');
  assert.strictEqual(verdict.code, code, name + ' expected ' + code + ' got ' + verdict.code + ' (' + verdict.reason + ')');
}

// ---- isStable --------------------------------------------------------------

test('isStable accepts plain semver only', () => {
  for (const v of ['5.0.25', '0.0.1', '1.2.3', '10.20.30']) assert.strictEqual(g.isStable(v), true, v);
  for (const v of ['5.0.25-rc.1', '5.0.25-rc', '5.0', '5.0.25.1', '01.2.3', 'v5.0.25', '1.2.3-next.0', '1.2.3+build', '', null, 5]) {
    assert.strictEqual(g.isStable(v), false, v + ' must not be a stable version');
  }
});

// ---- checkCoreCandidate ------------------------------------------------------

test('core candidate: positive passes every gate', () => {
  assert.deepStrictEqual(g.checkCoreCandidate(coreInput()), { ok: true });
});

test('core candidate: wrong channel/repo (CI_IDENTITY)', () => {
  expectCode('push event', g.checkCoreCandidate(coreInput({ eventName: 'push' })), 'CI_IDENTITY');
  expectCode('tag push', g.checkCoreCandidate(coreInput({ eventName: 'create' })), 'CI_IDENTITY');
  expectCode('fork repo', g.checkCoreCandidate(coreInput({ repository: 'someone/fork' })), 'CI_IDENTITY');
  expectCode('no runner temp', g.checkCoreCandidate(coreInput({ runTemp: null })), 'CI_IDENTITY');
});

test('core candidate: wrong version input (VERSION_SEMVER / VERSION_INPUT)', () => {
  expectCode('rc version', g.checkCoreCandidate(coreInput({ inputVersion: '5.0.25-rc.1', packageVersion: '5.0.25-rc.1' })), 'VERSION_SEMVER');
  expectCode('package mismatch', g.checkCoreCandidate(coreInput({ packageVersion: '5.0.24' })), 'VERSION_INPUT');
});

test('core candidate: wrong SHA (SHA_FORMAT / SHA_MATCH)', () => {
  expectCode('short sha', g.checkCoreCandidate(coreInput({ inputSha: 'abc123' })), 'SHA_FORMAT');
  expectCode('head mismatch', g.checkCoreCandidate(coreInput({ headSha: SHA_B })), 'SHA_MATCH');
});

test('core candidate: wrong tag (TAG_MISSING / TAG_MOVED)', () => {
  expectCode('no tag', g.checkCoreCandidate(coreInput({ tagSha: null })), 'TAG_MISSING');
  expectCode('tag moved', g.checkCoreCandidate(coreInput({ tagSha: SHA_B })), 'TAG_MOVED');
});

test('core candidate: provenance of the SHA (NOT_ON_MAIN / DIRTY_TREE)', () => {
  expectCode('off main', g.checkCoreCandidate(coreInput({ onMain: false })), 'NOT_ON_MAIN');
  expectCode('dirty tree', g.checkCoreCandidate(coreInput({ dirty: true })), 'DIRTY_TREE');
});

test('core candidate: three-sync (THREE_SYNC)', () => {
  expectCode('desktop version off', g.checkCoreCandidate(coreInput({ desktopVersion: '5.0.24' })), 'THREE_SYNC');
  expectCode('desktop pin off', g.checkCoreCandidate(coreInput({ desktopCorePin: '5.0.24' })), 'THREE_SYNC');
});

test('core candidate: wrong package / already published (PACKAGE_NAME / VERSION_EXISTS)', () => {
  expectCode('wrong package', g.checkCoreCandidate(coreInput({ packageName: g.DESKTOP_PACKAGE })), 'PACKAGE_NAME');
  expectCode('version exists', g.checkCoreCandidate(coreInput({ registryVersionExists: true })), 'VERSION_EXISTS');
});

// ---- checkDesktopCandidate ---------------------------------------------------

test('desktop candidate: positive passes every gate', () => {
  assert.deepStrictEqual(g.checkDesktopCandidate(desktopInput()), { ok: true });
});

test('desktop candidate: channel and identity (CI_IDENTITY / VERSION_SEMVER / PACKAGE_NAME / VERSION_INPUT)', () => {
  expectCode('push event', g.checkDesktopCandidate(desktopInput({ eventName: 'push' })), 'CI_IDENTITY');
  expectCode('rc version', g.checkDesktopCandidate(desktopInput({ inputVersion: '5.0.25-rc.1', packageVersion: '5.0.25-rc.1' })), 'VERSION_SEMVER');
  expectCode('wrong package', g.checkDesktopCandidate(desktopInput({ packageName: g.CORE_PACKAGE })), 'PACKAGE_NAME');
  expectCode('version mismatch', g.checkDesktopCandidate(desktopInput({ packageVersion: '5.0.24' })), 'VERSION_INPUT');
});

test('desktop candidate: pin and core ordering (DESKTOP_PIN / CORE_MISSING)', () => {
  expectCode('pin off', g.checkDesktopCandidate(desktopInput({ desktopCorePin: '5.0.24' })), 'DESKTOP_PIN');
  expectCode('core absent', g.checkDesktopCandidate(desktopInput({ coreRegistryVersion: null })), 'CORE_MISSING');
  expectCode('core behind', g.checkDesktopCandidate(desktopInput({ coreRegistryVersion: '5.0.24' })), 'CORE_MISSING');
});

test('desktop candidate: immutability (VERSION_EXISTS)', () => {
  expectCode('already published', g.checkDesktopCandidate(desktopInput({ registryVersionExists: true })), 'VERSION_EXISTS');
});

// ---- checkPack ---------------------------------------------------------------

const CORE_FILES = ['package.json', '_site/server.js', 'ui/index.html', 'ui/product.js', 'ui/live-client.js', 'module-runtime-manifest.json'];

test('pack: core positive with required runtime files', () => {
  const verdict = g.checkPack(packInput(packList(CORE_FILES), { required: ['package.json', '_site/server.js'] }));
  assert.deepStrictEqual(verdict, { ok: true });
});

test('pack: desktop positive with thin-shell files', () => {
  const verdict = g.checkPack(packInput(packList(g.REQUIRED_DESKTOP, { name: g.DESKTOP_PACKAGE }), { packageName: g.DESKTOP_PACKAGE, required: g.REQUIRED_DESKTOP, forbidden: g.FORBIDDEN_DESKTOP }));
  assert.deepStrictEqual(verdict, { ok: true });
});

test('pack: wrong package or shape (PACK_ID / TARBALL_NAME)', () => {
  expectCode('wrong name', g.checkPack(packInput(packList(CORE_FILES, { name: 'other/pkg' }))), 'PACK_ID');
  expectCode('wrong version', g.checkPack(packInput(packList(CORE_FILES, { version: '5.0.24' }))), 'PACK_ID');
  expectCode('two packs', g.checkPack(packInput(packList(CORE_FILES).concat(packList(CORE_FILES)))), 'PACK_ID');
  expectCode('no packs', g.checkPack(packInput([])), 'PACK_ID');
  expectCode('bad filename', g.checkPack(packInput(packList(CORE_FILES, { filename: '../evil.tgz' }))), 'TARBALL_NAME');
});

test('pack: tarball on disk (TARBALL_MISSING / TARBALL_INTEGRITY)', () => {
  expectCode('missing file', g.checkPack(packInput(packList(CORE_FILES), { tarballExists: false })), 'TARBALL_MISSING');
  expectCode('digest differs', g.checkPack(packInput(packList(CORE_FILES), { tarballSha512: crypto.createHash('sha512').update('other-bytes').digest('base64') })), 'TARBALL_INTEGRITY');
});

test('pack: file floor (PACK_REQUIRED)', () => {
  expectCode('required missing', g.checkPack(packInput(packList(['package.json']), { required: g.REQUIRED_DESKTOP, forbidden: g.FORBIDDEN_DESKTOP })), 'PACK_REQUIRED');
});

test('pack: leaks and build output (PACK_FORBIDDEN)', () => {
  const leak = (file, forbidden) => g.checkPack(packInput(packList(['package.json', file]), { forbidden }));
  expectCode('build out/', leak('out/app.exe', g.FORBIDDEN_DESKTOP), 'PACK_FORBIDDEN');
  expectCode('node_modules', leak('node_modules/electron/index.js', g.FORBIDDEN_DESKTOP), 'PACK_FORBIDDEN');
  expectCode('test dir', leak('test/unit.cjs', g.FORBIDDEN_DESKTOP), 'PACK_FORBIDDEN');
  expectCode('lockfile', leak('package-lock.json', g.FORBIDDEN_DESKTOP), 'PACK_FORBIDDEN');
  expectCode('qa-autopilot (any pack)', leak('qa-autopilot/tools/x.cjs', []), 'PACK_FORBIDDEN');
  expectCode('.git (any pack)', leak('.git/config', []), 'PACK_FORBIDDEN');
  expectCode('.env (any pack)', leak('.env', []), 'PACK_FORBIDDEN');
  expectCode('ai-profiles (any pack)', leak('ai-profiles.json', []), 'PACK_FORBIDDEN');
  expectCode('credentials (any pack)', leak('sub/credentials.json', []), 'PACK_FORBIDDEN');
});

// ---- checkReceipt ------------------------------------------------------------

test('receipt: positive with dist-tag outcome', () => {
  assert.deepStrictEqual(g.checkReceipt(receiptInput()), { ok: true });
});

test('receipt: no publish happened (NO_RECEIPT)', () => {
  expectCode('absent', g.checkReceipt(receiptInput({ registryMeta: null })), 'NO_RECEIPT');
  expectCode('no integrity', g.checkReceipt(receiptInput({ registryMeta: { name: g.CORE_PACKAGE, version: '5.0.25', dist: {} } })), 'NO_RECEIPT');
});

test('receipt: wrong package or version (RECEIPT_NAME / RECEIPT_VERSION)', () => {
  expectCode('wrong name', g.checkReceipt(receiptInput({ registryMeta: { name: 'other/pkg', version: '5.0.25', dist: { integrity: receiptInput().pack.integrity } } })), 'RECEIPT_NAME');
  expectCode('wrong version', g.checkReceipt(receiptInput({ registryMeta: { name: g.CORE_PACKAGE, version: '5.0.24', dist: { integrity: receiptInput().pack.integrity } } })), 'RECEIPT_VERSION');
});

test('receipt: integrity mismatch (INTEGRITY)', () => {
  const other = 'sha512-' + crypto.createHash('sha512').update('other').digest('base64');
  expectCode('bytes differ', g.checkReceipt(receiptInput({ registryMeta: { name: g.CORE_PACKAGE, version: '5.0.25', dist: { integrity: other } } })), 'INTEGRITY');
});

test('receipt: dist-tag outcome (LATEST_NOT_MOVED / NEXT_CHANGED)', () => {
  expectCode('latest behind', g.checkReceipt(receiptInput({ latestAfter: '5.0.24' })), 'LATEST_NOT_MOVED');
  expectCode('next moved', g.checkReceipt(receiptInput({ beforeNext: '5.0.24', nextAfter: '5.0.25' })), 'NEXT_CHANGED');
});

// ---- CLI channel guard (offline, no network) ----------------------------------

test('CLI refuses to run outside the approved workflow (CI_IDENTITY)', () => {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const env = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT'])
    if (process.env[key]) env[key] = process.env[key];
  const r = spawnSync(process.execPath, [path.join(__dirname, 'release-stable-5025-guard.cjs'), 'core-pre', '5.0.25', SHA_A], { cwd: repoRoot, env, encoding: 'utf8', windowsHide: true, timeout: 30000 });
  assert.strictEqual(r.status, 2, 'expected exit 2, stderr: ' + (r.stderr || '').slice(0, 200));
  assert.match(r.stderr || '', /CI_IDENTITY/);
});
