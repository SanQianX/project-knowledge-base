'use strict';
// R10/R12 slow-startup CLI acceptance: a live-but-busy instance must never be
// reported as 启动失败, must never trigger a second backend spawn, definitive
// fatal errors must still surface fast, and a stale dead-PID endpoint record
// must no longer block a fresh start. Runs the REAL bin/project-knowledge.js
// against an isolated temp data directory with a fake control-plane backend.
//
// R12: the driver hardens its own env at START (audited allow-list + owned
// run root outside the repo); every child (fixture, CLI, the real backend the
// CLI spawns) runs under the fully isolated env, and the CLI chain carries a
// --require observer recording PATH-BOOLEANS-only identity proof. Backends
// boot only on explicitly owned ports; the protected-port listener set is
// snapshotted before/after and asserted unchanged.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const { createHarness } = require('./slow-startup-env.cjs');

const harness = createHarness('cli');
const runRoot = harness.runRoot;
const ROOT = path.resolve(__dirname, '..', '..');
const BIN = path.join(ROOT, 'bin', 'project-knowledge.js');
const FIXTURE = path.join(__dirname, 'slow-startup-fixture.cjs');
const OWN_ROOTS_ENV = { KB_SS_OWN_ROOTS: JSON.stringify(harness.ownRoots) };

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const waitMarker = async (p, timeoutMs = 20000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch {}
    await sleep(100);
  }
  throw new Error('marker timeout: ' + p);
};
const runCli = (args, extraEnv = {}, timeoutMs = 60000) => new Promise((resolve, reject) => {
  const started = Date.now();
  const child = harness.spawnNode(BIN, args, { extra: extraEnv, observer: true });
  let out = '', err = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { err += d; });
  const timer = setTimeout(() => { try { child.kill(); } catch {} reject(new Error('cli timeout')); }, timeoutMs);
  child.once('exit', code => { clearTimeout(timer); resolve({ code, out, err, elapsedMs: Date.now() - started }); });
});
const spawnFixture = (dataDir, marker, options) =>
  harness.spawnNode(FIXTURE, [dataDir, marker, JSON.stringify(options)], { extra: OWN_ROOTS_ENV });
const assertFixtureIsolated = (marker) => {
  const info = JSON.parse(fs.readFileSync(marker, 'utf8'));
  const proof = info.envProof || {};
  assert.equal(proof.provided, true, 'fixture must carry its env identity proof');
  for (const key of ['userProfileOwned', 'homedirOwned', 'appdataOwned', 'localappdataOwned', 'tempOwned', 'dataDirOwned', 'noCredentialKeys']) {
    assert.equal(proof[key], true, `fixture env boolean ${key} must be true (PATH booleans only, no values recorded)`);
  }
  return info;
};
const endpointPid = (dir) => {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'runtime-endpoint.json'), 'utf8')).pid; } catch { return null; }
};

(async () => {
  const results = {};
  const portsBefore = harness.protectedPortSnapshot();

  // Case A — busy instance (4s stall): honest wait then reuse, no false
  // failure, no second spawn (endpoint PID unchanged).
  {
    const dataDir = path.join(runRoot, 'a-data');
    const marker = path.join(runRoot, 'a-ready.json');
    fs.mkdirSync(dataDir, { recursive: true });
    const fixture = spawnFixture(dataDir, marker, { busyAfterMs: 600, busyMs: 4000 });
    try {
      await waitMarker(marker);
      const info = assertFixtureIsolated(marker);
      await waitMarker(marker + '.busy');
      const first = await runCli(['start', '--data', dataDir, '--no-open'], {}, 30000);
      const pidBefore = endpointPid(dataDir);
      results.caseA = {
        exit: first.code, elapsedMs: first.elapsedMs, output: (first.out + first.err).trim(),
        noFalseFailure: first.code === 0 && !/启动失败/.test(first.out + first.err),
        reused: /Already running/.test(first.out),
        noSecondSpawn: pidBefore === info.pid,
      };
      assert.equal(results.caseA.noFalseFailure, true, 'busy instance must not be reported failed: ' + results.caseA.output);
      assert.equal(results.caseA.reused, true, 'must reuse the live instance after the busy window');
      assert.equal(results.caseA.noSecondSpawn, true, 'endpoint PID must stay the fixture PID');
    } finally { fixture.kill(); await sleep(200); }
  }

  // Case B — patience exceeded while PID alive: honest busy report, exit 0,
  // still no spawn.
  {
    const dataDir = path.join(runRoot, 'b-data');
    const marker = path.join(runRoot, 'b-ready.json');
    const fixture = spawnFixture(dataDir, marker, { busyAfterMs: 0, busyMs: 60000 });
    try {
      await waitMarker(marker);
      const info = assertFixtureIsolated(marker);
      await waitMarker(marker + '.busy');
      const first = await runCli(['start', '--data', dataDir, '--no-open'], { KB_LAUNCHER_CONNECT_PATIENCE_MS: '2500' }, 30000);
      const pidBefore = endpointPid(dataDir);
      results.caseB = {
        exit: first.code, output: (first.out + first.err).trim(),
        honestBusy: first.code === 0 && /正在启动或繁忙/.test(first.out) && /未判定失败/.test(first.out),
        noSecondSpawn: pidBefore === info.pid,
      };
      assert.equal(results.caseB.honestBusy, true, 'patience-exceeded report must be honest, not a failure: ' + results.caseB.output);
      assert.equal(results.caseB.noSecondSpawn, true, 'must never spawn while the endpoint PID lives');
    } finally { fixture.kill(); await sleep(200); }
  }

  // Case C — definitive fatal error (explicit busy port): fast real failure,
  // never a timeout-style false claim.
  {
    const blocker = http.createServer((_req, res) => { res.writeHead(200); res.end('occupied'); });
    await new Promise(resolve => blocker.listen(0, '127.0.0.1', resolve));
    const { port } = blocker.address();
    const dataDir = path.join(runRoot, 'c-data');
    fs.mkdirSync(dataDir, { recursive: true });
    try {
      const fatal = await runCli(['start', '--data', dataDir, '--no-open', '--port', String(port)], { KB_MODULES_AUTOSTART: '0' }, 60000);
      results.caseC = {
        exit: fatal.code, elapsedMs: fatal.elapsedMs, output: (fatal.out + fatal.err).trim(),
        surfaced: fatal.code === 1 && /启动失败/.test(fatal.out + fatal.err),
        fast: fatal.elapsedMs < 45000,
      };
      assert.equal(results.caseC.surfaced, true, 'a definitive fatal error must surface: ' + results.caseC.output);
      assert.equal(results.caseC.fast, true, 'fatal failure must not wait the full 45s budget');
      assert.equal(fs.existsSync(path.join(dataDir, 'runtime-endpoint.json')), false, 'failed start must clear its endpoint claim');
    } finally { blocker.closeAllConnections?.(); await new Promise(resolve => blocker.close(resolve)); }
  }

  // Case D — stale dead-PID endpoint record must not block a fresh start:
  // the real backend boots, reports ready, and stops cleanly.
  {
    const dataDir = path.join(runRoot, 'd-data');
    fs.mkdirSync(dataDir, { recursive: true });
    const dead = spawn(process.execPath, ['-e', 'process.exit(0)'], { windowsHide: true, env: harness.nodeEnv({}) });
    await new Promise(resolve => dead.once('exit', resolve));
    const endpointStore = require(path.join(ROOT, '_site', 'lib', 'runtime-endpoint.js'));
    endpointStore.writeEndpoint(dataDir, { pid: dead.pid, host: '127.0.0.1', port: 59998, mode: 'cli' });
    const ownPort = await harness.freePort();
    try {
      const boot = await runCli(['start', '--data', dataDir, '--no-open'], { KB_MODULES_AUTOSTART: '0', KB_SITE_PORT: String(ownPort) }, 60000);
      const stop = await runCli(['stop', '--data', dataDir], { KB_MODULES_AUTOSTART: '0' }, 60000);
      results.caseD = {
        bootExit: boot.code, bootOutput: boot.out.trim(), ownPort,
        stopExit: stop.code,
        ready: boot.code === 0 && /is ready at/.test(boot.out),
        staleDidNotBlock: !/已有实例记录/.test(boot.out + boot.err),
      };
      assert.equal(results.caseD.ready, true, 'fresh boot must reach ready despite the stale record: ' + results.caseD.bootOutput);
      assert.equal(results.caseD.staleDidNotBlock, true, 'a dead-PID endpoint record must not block start');
      assert.equal(stop.code, 0, 'stop must succeed after boot');
    } finally {
      await runCli(['stop', '--data', dataDir], { KB_MODULES_AUTOSTART: '0' }, 30000).catch(() => {});
    }
  }

  // Case E (R12/R18) — startup patience deadline honored BELOW the 45s first
  // checkpoint. R18: the deadline now fires while the real backend is HELD
  // starting — a test-owned preload gate (runRoot/e-gate.cjs, --fg-guarded,
  // delivered via a scoped NODE_OPTIONS --require so it reaches the --fg
  // respawn, which argv cannot do: node strips exec args from process.argv)
  // blocks the backend BEFORE its core entry until this test releases it
  // AFTER the first CLI returns. Deterministic causal ordering, not the old
  // >400ms boot-time assumption (fast CI booted before the cap, Windows job
  // 120880881525). The 400ms deadline, the honest still-starting exit-0/
  // no-failure assertions, and the same-PID reuse + stop proofs are
  // unchanged; the finally ALWAYS releases the gate and stops the own tree.
  {
    const dataDir = path.join(runRoot, 'e-data');
    fs.mkdirSync(dataDir, { recursive: true });
    const ownPort = await harness.freePort();
    const gate = {
      file: path.join(runRoot, 'e-gate.cjs'),
      entered: path.join(runRoot, 'e-gate-entered.json'),
      release: path.join(runRoot, 'e-gate-release'),
      error: path.join(runRoot, 'e-gate-error.json'),
      deadlineMs: 30000,
    };
    for (const p of [gate.entered, gate.release, gate.error]) fs.rmSync(p, { force: true });
    fs.writeFileSync(gate.file, [
      "'use strict';",
      "// R18 Case E test-owned startup gate (runRoot copy, never in the repo).",
      "// Delivered via a scoped NODE_OPTIONS --require: it preloads in every",
      "// child of the gated run but activates ONLY for the real --fg backend",
      "// respawn (the parent CLI and any grandchild lack --fg and no-op).",
      "// Holds the backend BEFORE its core entry until the owning test writes",
      "// the release file; a 30s deadline fails loud if never released.",
      "if (!process.argv.includes('--fg') || process.env.KB_R18_GATE !== '1') return;",
      "const g = require('node:fs');",
      "try { g.writeFileSync(process.env.KB_R18_GATE_ENTERED, JSON.stringify({ pid: process.pid, at: new Date().toISOString() })); } catch {}",
      "const sab = new Int32Array(new SharedArrayBuffer(4));",
      "const deadlineMs = Number(process.env.KB_R18_GATE_DEADLINE_MS || 30000);",
      "const deadline = Date.now() + deadlineMs;",
      "while (!g.existsSync(process.env.KB_R18_GATE_RELEASE)) {",
      "  if (Date.now() >= deadline) {",
      "    try { g.writeFileSync(process.env.KB_R18_GATE_ERROR, JSON.stringify({ pid: process.pid, waitedMs: deadlineMs, reason: 'parent never released the startup gate' })); } catch {}",
      "    console.error('[r18-gate] startup gate deadline exceeded; parent never released');",
      "    process.exit(70);",
      "  }",
      "  Atomics.wait(sab, 0, 0, 100);",
      "}",
    ].join('\n') + '\n', 'utf8');
    // Test-only scoped spawn. argv --require cannot reach the backend: node
    // strips exec args from process.argv (verified: `node --require x -e …`
    // yields argv [node] only), and bin respawns with argv.slice(1) + '--fg'.
    // NODE_OPTIONS is therefore the only propagation channel. The frozen env
    // contract rightly forbids NODE_OPTIONS-shaped entries, so this Case-E
    // wrapper adds it AFTER the contract-checked build as the single reviewed
    // exception: it preloads only this run's own gate file, which no-ops in
    // every process whose argv lacks '--fg'. All isolation substance (KB
    // dirs, homes, TEMP, PATH floor) comes from the contract build unchanged.
    const runGatedCli = (args, extraEnv, timeoutMs = 60000) => new Promise((resolve, reject) => {
      const started = Date.now();
      const env = harness.nodeEnv({ ...extraEnv, ELECTRON_RUN_AS_NODE: '1' });
      env.NODE_OPTIONS = `--require ${JSON.stringify(gate.file)}`;
      const child = spawn(process.execPath,
        ['--require', harness.observerPath, BIN, ...args], { env, windowsHide: true });
      let out = '', err = '';
      child.stdout.on('data', d => { out += d; });
      child.stderr.on('data', d => { err += d; });
      const timer = setTimeout(() => { try { child.kill(); } catch {} reject(new Error('gated cli timeout')); }, timeoutMs);
      child.once('exit', code => { clearTimeout(timer); resolve({ code, out, err, elapsedMs: Date.now() - started }); });
    });
    const gateEnv = {
      KB_R18_GATE: '1',
      KB_R18_GATE_ENTERED: gate.entered,
      KB_R18_GATE_RELEASE: gate.release,
      KB_R18_GATE_ERROR: gate.error,
      KB_R18_GATE_DEADLINE_MS: String(gate.deadlineMs),
    };
    try {
      const first = await runGatedCli(['start', '--data', dataDir, '--no-open'],
        { KB_MODULES_AUTOSTART: '0', KB_SITE_PORT: String(ownPort), KB_LAUNCHER_STARTUP_PATIENCE_MS: '400', ...gateEnv });
      const stillStarting = first.code === 0 && /未判定失败/.test(first.out) && !/启动失败/.test(first.out + first.err);
      // Causal proof: the backend ENTERED the gate (held before core entry)
      // while the first CLI had already returned its still-starting report —
      // and only then does this test release it to boot for real.
      const gateInfo = await waitMarker(gate.entered, 10000);
      const heldWhileReported = !fs.existsSync(gate.release) && !fs.existsSync(gate.error);
      fs.writeFileSync(gate.release, String(Date.now()));
      const endpointFile = path.join(dataDir, 'runtime-endpoint.json');
      const bootedPid = await (async () => {
        const deadline = Date.now() + 30000;
        while (Date.now() < deadline) {
          const pid = endpointPid(dataDir);
          if (pid && harness.pidAlive(pid)) return pid;
          await sleep(200);
        }
        return null;
      })();
      let reuse = null;
      if (bootedPid) {
        for (let attempt = 0; attempt < 8 && !(reuse && reuse.code === 0 && /Already running/.test(reuse.out)); attempt++) {
          reuse = await runCli(['start', '--data', dataDir, '--no-open'], { KB_MODULES_AUTOSTART: '0' }, 30000);
        }
      }
      const stop = bootedPid ? await runCli(['stop', '--data', dataDir], { KB_MODULES_AUTOSTART: '0' }, 60000).catch(error => ({ code: 'err', message: error.message })) : null;
      results.caseE = {
        exit: first.code, output: (first.out + first.err).trim(),
        stillStartingHonest: stillStarting,
        deadlineFiredWhileHeld: heldWhileReported,
        gateHeldPid: gateInfo.pid, bootedPid,
        heldPidIsBootedPid: bootedPid === gateInfo.pid,
        backendActuallyBooted: bootedPid !== null,
        noFalseFailure: !/启动失败/.test(first.out + first.err),
        reuseSamePid: !!(reuse && reuse.code === 0 && /Already running \(PID (\d+)\)/.exec(reuse.out)?.[1] === String(bootedPid)),
        stopExit: stop ? stop.code : null,
        gateErrorFile: fs.existsSync(gate.error),
      };
      assert.equal(results.caseE.stillStartingHonest, true, 'patience cap below the first checkpoint must be an honest still-starting report (typed, exit 0): ' + results.caseE.output);
      assert.equal(results.caseE.deadlineFiredWhileHeld, true, 'the deadline must fire while the real backend is HELD starting (gate entered, not yet released, no gate error)');
      assert.equal(results.caseE.heldPidIsBootedPid, true, 'the backend that boots after release must be the very PID the gate held');
      assert.equal(results.caseE.backendActuallyBooted, true, 'the first backend must still finish booting after the honest report');
      assert.equal(results.caseE.reuseSamePid, true, 'a second start must reuse the SAME backend PID (never a second spawn)');
      assert.equal(results.caseE.stopExit, 0, 'stop must succeed after the honest-report boot');
      assert.equal(results.caseE.gateErrorFile, false, 'the gate must never hit its 30s deadline in the green path');
    } finally {
      // ALWAYS release a held backend, then stop — and if the own backend is
      // still alive (boot race or control stall), retry stop and finally
      // hard-kill exactly that own tree. Nothing may leak on any failure.
      try { fs.writeFileSync(gate.release, String(Date.now())); } catch {}
      const gateInfo = (() => { try { return JSON.parse(fs.readFileSync(gate.entered, 'utf8')); } catch { return null; } })();
      const backendPid = (gateInfo && gateInfo.pid) || endpointPid(dataDir);
      try { await runCli(['stop', '--data', dataDir], { KB_MODULES_AUTOSTART: '0' }, 30000); } catch {}
      if (backendPid && harness.pidAlive(backendPid)) {
        const deadline = Date.now() + 15000;
        while (Date.now() < deadline && harness.pidAlive(backendPid)) {
          await sleep(300);
          try { await runCli(['stop', '--data', dataDir], { KB_MODULES_AUTOSTART: '0' }, 30000); } catch {}
        }
        if (harness.pidAlive(backendPid)) harness.taskkillTree(backendPid);
      }
    }
  }

  // Case F (R13) — unverified legacy endpoint: alive recorded PID (this test
  // process), a foreign 404 server on the recorded port, and NO startedAt
  // stamp (the live writer always stamps it; hand-written or legacy records
  // do not) while the control channel is definitively refused. start must
  // reject FAST and nonzero — no busy-trust of an unverified PID through the
  // patience budget, no kill, no second spawn, endpoint bytes untouched, and
  // both the foreign server and the recorded PID still alive afterwards.
  {
    const foreign = http.createServer((_req, res) => { res.writeHead(404); res.end('not knowledge'); });
    await new Promise(resolve => foreign.listen(0, '127.0.0.1', resolve));
    const foreignPort = foreign.address().port;
    const dataDir = path.join(runRoot, 'f-data');
    fs.mkdirSync(dataDir, { recursive: true });
    const endpointFile = path.join(dataDir, 'runtime-endpoint.json');
    const record = { schema: 'project-knowledge/runtime-endpoint/v1', pid: process.pid, host: '127.0.0.1', port: foreignPort };
    fs.writeFileSync(endpointFile, JSON.stringify(record, null, 2) + '\n', 'utf8');
    const bytesBefore = fs.readFileSync(endpointFile);
    try {
      const refused = await runCli(['start', '--data', dataDir, '--no-open'], {}, 20000);
      const bytesAfter = fs.readFileSync(endpointFile);
      results.caseF = {
        exit: refused.code, elapsedMs: refused.elapsedMs, foreignPort,
        output: (refused.out + refused.err).trim(),
        refusedFastNonzero: refused.code === 1 && refused.elapsedMs < 10000 && /缺少 startedAt 启动标识/.test(refused.out + refused.err),
        notKilled: foreign.listening && harness.pidAlive(process.pid),
        endpointUntouched: bytesAfter.equals(bytesBefore),
        noSecondSpawn: !fs.existsSync(path.join(dataDir, 'launcher.log')),
      };
      assert.equal(results.caseF.refusedFastNonzero, true, 'an unstamped endpoint with a refused control channel must be rejected fast and nonzero: ' + results.caseF.output);
      assert.equal(results.caseF.notKilled, true, 'neither the foreign server nor the recorded PID may be signaled');
      assert.equal(results.caseF.endpointUntouched, true, 'the refusal must not rewrite or delete the endpoint record');
      assert.equal(results.caseF.noSecondSpawn, true, 'the refusal must never spawn a backend');
    } finally { foreign.closeAllConnections?.(); await new Promise(resolve => foreign.close(resolve)); }
  }

  // Isolation proofs: observer booleans for the CLI + real-backend chain, and
  // the protected-port listener set must be untouched.
  const proof = harness.observerProof();
  results.isolation = {
    observerRunAsNodeCount: proof.runAsNodeCount,
    allOwned: proof.allOwned,
    realUserProfileSeen: proof.realUserProfileSeen,
    protectedPortsUnchanged: JSON.stringify(harness.protectedPortSnapshot()) === JSON.stringify(portsBefore),
  };
  assert.equal(results.isolation.protectedPortsUnchanged, true, 'protected ports 5757/5760/8787/8790 must be untouched');
  assert.equal(results.isolation.realUserProfileSeen, false, 'no observed child may run under the real user profile');
  assert.equal(results.isolation.allOwned, true, `every RUN_AS_NODE child (CLI + real backend) must be isolated (saw ${proof.runAsNodeCount})`);

  console.log('slow-startup cli test PASS');
  for (const [name, value] of Object.entries(results)) console.log(' ', name, JSON.stringify(value).slice(0, 220));
  harness.cleanup();
})().catch(error => { console.error(error); try { harness.cleanup(); } catch {} process.exitCode = 1; });
