'use strict';
// _site/_test/parallel-ci-r9-posix-socket-budget-test.js
//
// P-CI-LAST-LINUX-R9 focused case: the POSIX control-socket path budget that
// killed normalhook on CI 40075242420 (linux24, exit 1, empty pipes).
//
// Mechanism (all source-proven, see the R9 evidence lane): the product's
// runtime-control listens on a filesystem unix socket at
// <dataDir>/runtime-control.sock on POSIX (runtime-control.js:14; Windows uses
// a hashed named pipe with no length dependence). Linux sun_path is 108 bytes
// including the NUL, so paths longer than 107 chars cannot bind. The logging
// lane stacks three name layers — laneTmp (5025-env mkdtemp `${prefix}-`),
// its `temp` dir (TEMP/TMP/TMPDIR), and the acceptance fixture's dataDir
// mkdtemp — and the OLD 'pk-logging-acc-' fixture prefix made the
// logfixr2-normal dataDir produce a 109-char socket on the CI temp root
// (/home/runner/work/_temp): unbindable, so the server exited 1 before the
// health gate and the test timed out with zero child output.
//
// This case locks the class, not the incident:
//   1. every logging-lane (prefix, caseId) pair builds a bindable socket
//      string on the documented CI Linux temp root (pure string math, runs
//      and holds on BOTH platforms);
//   2. the fixture's fail-fast guard rejects an over-budget dataDir and
//      accepts in-budget ones (on win32 it is a no-op — named pipes);
//   3. on POSIX the kernel verdict is reproduced live: the fixed normalhook
//      length binds; the 109 incident is recorded, without assuming whether
//      this Node/libuv version refuses or truncates it. 108 is also diagnostic.
//      on win32 this leg is reported platform-skipped (no sun_path there);
//   4. the product's controlPath shape per platform is asserted unchanged.
//
// No server spawn, no engine, no browser: naming + kernel contracts only.

const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const assert = require('node:assert/strict');

const { applyDriverIsolation } = require('./helpers/parallel-qa-engine-endpoint-isolate');
const isolation = applyDriverIsolation({ prefix: 'r9-socket-budget' });
const ownedRoot = fs.realpathSync(isolation.layout.root);
const { controlPath } = require('../lib/runtime-control');
const { assertPosixSocketBudget, POSIX_SOCKET_CHAR_LIMIT } = require('./helpers/parallel-logging-acceptance-fixture');

const CI_LINUX_TEMP_ROOT = '/home/runner/work/_temp'; // from the 40075242420 log (PK_TEST_TEMP_ROOT)
const MKDTEMP_RANDOM = 6; // fs.mkdtempSync appends exactly 6 random chars
const SOCK_SUFFIX = '/runtime-control.sock'; // 21 chars — runtime-control.js:14 (POSIX)

// Every spawnServer consumer of the acceptance fixture in the logging lane
// (test file → lane prefix → fixture caseId).
const LANE_CASES = [
  ['parallel-logging-acceptance-log003-test.js', 'log003', 'log003'],
  ['parallel-logging-acceptance-log004-test.js', 'log004', 'log004'],
  ['parallel-logging-acceptance-log005-test.js', 'log005', 'log005'],
  ['parallel-logging-acceptance-log006-test.js', 'log006', 'log006'],
  ['parallel-logging-acceptance-log007-test.js', 'log007', 'log007'],
  ['parallel-logging-acceptance-log008-test.js', 'log008', 'log008'],
  ['parallel-logging-fix-r2-gap-test.js', 'logfixr2-gap', 'logfixr2gap'],
  ['parallel-logging-fix-r2-normalhook-test.js', 'logfixr2-normal', 'logfixr2normal'],
];

// Replicates the three naming layers verbatim (5025-env:331,336,361-363 and
// the fixture's mkdtemp) against an arbitrary temp root.
function laneSocketPath(tempRoot, prefix, caseId, fixturePrefix) {
  const laneTmp = path.posix.join(tempRoot, `${prefix}-${'x'.repeat(MKDTEMP_RANDOM)}`);
  const tmpdir = path.posix.join(laneTmp, 'temp');
  const dataDir = path.posix.join(tmpdir, `${fixturePrefix}${caseId}-${'x'.repeat(MKDTEMP_RANDOM)}`);
  return path.posix.join(dataDir, 'runtime-control.sock');
}

function tryListen(socketPath) {
  return new Promise(resolve => {
    const server = net.createServer(() => {});
    const fail = error => resolve({ bound: false, code: error.code || null, message: String(error.message).slice(0, 160) });
    server.once('error', fail);
    server.listen(socketPath, () => server.close(() => resolve({ bound: true })));
  });
}

async function main() {
  const proof = { case: 'P-CI-LAST-LINUX-R9 posix-socket-budget', startedAt: new Date().toISOString() };

  // ---- 1. every lane case is bindable on the CI Linux temp root -----------
  const rows = LANE_CASES.map(([test, prefix, caseId]) => {
    const fixed = laneSocketPath(CI_LINUX_TEMP_ROOT, prefix, caseId, 'pk-la-').length;
    const old = laneSocketPath(CI_LINUX_TEMP_ROOT, prefix, caseId, 'pk-logging-acc-').length;
    return { test, oldLength: old, fixedLength: fixed, oldWasBindable: old <= POSIX_SOCKET_CHAR_LIMIT, fixedBindable: fixed <= POSIX_SOCKET_CHAR_LIMIT };
  });
  for (const row of rows) {
    assert.ok(row.fixedBindable, `${row.test}: fixed socket length ${row.fixedLength} exceeds the POSIX budget ${POSIX_SOCKET_CHAR_LIMIT} on the CI temp root`);
  }
  const normalhook = rows.find(r => r.test.includes('normalhook'));
  assert.ok(!normalhook.oldWasBindable && normalhook.oldLength === 109, `the CI incident stays red as history: normalhook OLD length was 109 (> ${POSIX_SOCKET_CHAR_LIMIT})`);
  proof.laneBudgets = rows;

  // ---- 2. the fixture guard fails fast on over-budget, passes in-budget ---
  const okDir = laneSocketPath(CI_LINUX_TEMP_ROOT, 'logfixr2-normal', 'logfixr2normal', 'pk-la-').slice(0, -SOCK_SUFFIX.length);
  const longDir = laneSocketPath(CI_LINUX_TEMP_ROOT, 'logfixr2-normal', 'logfixr2normal', 'pk-logging-acc-').slice(0, -SOCK_SUFFIX.length);
  if (process.platform === 'win32') {
    assert.equal(assertPosixSocketBudget(longDir), longDir, 'on win32 the control channel is a named pipe: the guard is a no-op');
    proof.fixtureGuard = { platform: 'win32', behavior: 'no-op (named pipe)' };
  } else {
    assert.equal(assertPosixSocketBudget(okDir), okDir, 'an in-budget dataDir passes the guard');
    assert.throws(() => assertPosixSocketBudget(longDir), /POSIX control socket/, 'an over-budget dataDir is rejected at fixture time, before any spawn');
    proof.fixtureGuard = { platform: process.platform, behavior: 'throws on over-budget, passes in-budget' };
  }

  // ---- 3. the kernel verdict where sun_path actually applies --------------
  if (process.platform === 'win32') {
    proof.kernelVerdict = { platform: 'win32', skipped: true, reason: 'no sun_path limit on Windows named pipes; leg 1 proves the CI-Linux string math' };
  } else {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-r9-budget-'));
    const makeAtLength = length => {
      const parent = path.join(base, 'a'.repeat(Math.max(1, length - SOCK_SUFFIX.length - base.length - 1)));
      fs.mkdirSync(parent, { recursive: true });
      const socketPath = path.join(parent, 'runtime-control.sock');
      assert.equal(socketPath.length, length);
      return socketPath;
    };
    const fixedLength = laneSocketPath(CI_LINUX_TEMP_ROOT, 'logfixr2-normal', 'logfixr2normal', 'pk-la-').length;
    const outcomes = {};
    outcomes.fixed = { length: fixedLength, ...(await tryListen(makeAtLength(fixedLength))) };
    outcomes.incident109 = { length: 109, ...(await tryListen(makeAtLength(109))) };
    // 108 is measured but NOT asserted: the exact sun_path boundary is
    // runtime-dependent (some libuv callers truncate; others reject),
    // so neither boundary observation is a cross-version product contract.
    outcomes.boundary108 = { length: 108, ...(await tryListen(makeAtLength(108))) };
    assert.ok(outcomes.fixed.bound, `the fixed normalhook socket length (${fixedLength}) binds on this POSIX kernel`);
    // Node 22 may truncate both bind and connect names; a universal refusal
    // assertion would characterize the runtime incorrectly. The fixture guard
    // above remains strict, and the fixed in-budget socket must really bind.
    proof.kernelVerdict = { platform: process.platform, outcomes };
    fs.rmSync(base, { recursive: true, force: true });
  }

  // ---- 4. the product control-path shape per platform ---------------------
  const sampleDataDir = '/tmp/pk-la-sample-abc123';
  if (process.platform === 'win32') {
    assert.match(controlPath(sampleDataDir), /^\\\\\.\\pipe\\project-knowledge-[0-9a-f]{32}$/, 'win32 control channel is the hashed named pipe (no length dependence)');
  } else {
    assert.equal(controlPath(sampleDataDir), path.join(sampleDataDir, 'runtime-control.sock'), 'POSIX control channel is the in-dir unix socket');
  }
  proof.controlPathShape = String(controlPath(sampleDataDir));

  proof.verdict = 'PASS';
  console.log(`parallel-ci-r9-posix-socket-budget-test PASS (${proof.kernelVerdict.skipped ? 'string-math + guard legs; kernel leg platform-skipped on win32' : 'string-math + guard + live kernel legs'}; normalhook fixed=${normalhook.fixedLength} ≤ ${POSIX_SOCKET_CHAR_LIMIT}, old=${normalhook.oldLength})`);
  console.log(JSON.stringify(proof, null, 2));
}

main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; }).finally(() => {
  const owner = JSON.parse(fs.readFileSync(path.join(ownedRoot, 'owner.json'), 'utf8'));
  assert.equal(fs.realpathSync(isolation.layout.root), ownedRoot, 'cleanup stays in the freshly owned isolation root');
  assert.equal(owner.pid, process.pid);
  assert.equal(owner.tag, 'r9-socket-budget');
  fs.rmSync(ownedRoot, { recursive: true, force: true });
});
