'use strict';
// P-DESKTOP-ACTUAL-CANDIDATE-R4 offline sentinel for the make.cjs deletion/
// copy containment and free-disk guards. Proves, WITHOUT running any build:
//   1. a recursive-removal target outside the owned desktop/out tree is
//      refused (repo evidence dirs, the OS temp root, the Leader BASE tree)
//   2. a junction inside the owned tree is unlinked where it stands — the
//      removal never traverses it, so the linked victim survives
//   3. a nonexistent inside-tree target is a no-op
//   4. assertFreeDisk passes on the real volumes and refuses an impossible
//      requirement
// Run: node desktop/test/release-preflight-5025-make-guards-test.cjs

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const guards = require('./release-preflight-5025-make.cjs');

const outRoot = path.resolve(__dirname, '..', 'out');
const selftestRoot = path.join(outRoot, '.release-preflight-5025-guards-selftest');

test('recursive removal is refused for anything outside desktop/out', () => {
  const outside = [
    path.join(os.tmpdir(), 'release-preflight-5025-guards-victim'),
    path.resolve(__dirname, '..', '..', 'qa-autopilot', 'artifacts'),
    path.resolve(__dirname, '..', '..', '..', '.release-preflight-fixture', 'node_modules'),
  ];
  for (const target of outside) {
    assert.throws(() => guards.safeRmRecursive(target, 'sentinel'),
      { message: /must stay inside the owned desktop\/out tree/ },
      `must refuse ${target}`);
  }
  // the owned out root itself is not a valid removal target either
  assert.throws(() => guards.safeRmRecursive(outRoot, 'sentinel'),
    { message: /must stay inside the owned desktop\/out tree/ });
});

test('a junction is unlinked, never traversed — the victim survives', () => {
  fs.rmSync(selftestRoot, { recursive: true, force: true });
  const victimRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'release-preflight-5025-guards-victim-'));
  try {
    const victimFile = path.join(victimRoot, 'precious.txt');
    fs.writeFileSync(victimFile, 'do-not-delete');
    const owned = path.join(selftestRoot, 'owned');
    fs.mkdirSync(owned, { recursive: true });
    fs.writeFileSync(path.join(owned, 'real.txt'), 'x');
    fs.symlinkSync(victimRoot, path.join(owned, 'link-to-victim'), 'junction');
    guards.safeRmRecursive(selftestRoot, 'sentinel junction case');
    assert.ok(!fs.existsSync(selftestRoot), 'owned tree removed');
    assert.ok(fs.existsSync(victimFile), 'victim behind the junction survived');
    assert.strictEqual(fs.readFileSync(victimFile, 'utf8'), 'do-not-delete');
  } finally {
    fs.rmSync(victimRoot, { recursive: true, force: true });
  }
});

test('a nonexistent inside-tree target is a no-op', () => {
  guards.safeRmRecursive(path.join(outRoot, '.release-preflight-5025-guards-nothing-here'), 'sentinel noop');
});

test('assertFreeDisk passes real volumes and refuses impossible requirements', () => {
  const real = fs.statfsSync(outRoot);
  const free = real.bsize * real.bavail;
  guards.assertFreeDisk(outRoot, 1, 'tiny floor');
  assert.throws(() => guards.assertFreeDisk(outRoot, free + 2 ** 30, 'impossible'),
    { message: /below the impossible requirement of/ });
  assert.ok(guards.MIN_BUILD_FREE_BYTES > 0 && guards.MIN_TMP_FREE_BYTES > 0);
});
