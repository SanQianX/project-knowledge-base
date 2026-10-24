'use strict';
// R10/R12 slow-startup desktop acceptance: runs the REAL electron main.cjs
// and observes visible startup behavior. Scenario A: a live-but-busy existing
// instance must be reused (no second backend spawn, progress lines visible,
// the app page actually loaded). Scenario B: an owned child that dies on a
// definitive fatal error must surface 后台连接失败 fast with its log tail —
// never an endless spinner, never a false failure for a live process.
//
// R12 isolation: the GUI keeps its original USERPROFILE ONLY under the
// audited Electron-43 exception (own --user-data-dir + KB_DESKTOP_USER_DATA_DIR),
// and the REAL Node backend it spawns is isolated by the R5 test-only
// inspector spawn hook (installed before app entry): USERPROFILE/APPDATA/
// LOCALAPPDATA/TEMP rewritten to the owned roots + --require observer with
// PATH-BOOLEANS-only proof. A real screenshot of the loaded app page is
// captured only AFTER the isolation booleans are proven. If the hook cannot
// be installed the scenario is reported NOT PASS (never a silent pass).
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHarness } = require('./slow-startup-env.cjs');

const harness = createHarness('desktop');
const runRoot = harness.runRoot;
const DESKTOP = path.resolve(__dirname, '..');
const ELECTRON = path.join(DESKTOP, 'node_modules', 'electron', 'dist', 'electron.exe');
const FIXTURE = path.join(__dirname, 'slow-startup-fixture.cjs');
const EVIDENCE_DIR = path.resolve(DESKTOP, '..', 'qa-autopilot', 'artifacts', 'parallel-20261023', 'startup-isolation-r12', 'evidence');
const coreVersion = require(path.join(DESKTOP, 'node_modules', '@sanqianx', 'project-knowledge', 'package.json')).version;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const waitMarker = async (p, timeoutMs = 30000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch {}
    await sleep(100);
  }
  throw new Error('marker timeout: ' + p);
};
// Launches the REAL desktop app under the held-inspector pattern and exposes
// one-shot settling (R10 semantics): `marker`/`onOutput` settle on an observed
// condition, child exit settles with earlyExit, `done` awaits whichever
// happens first. Resolves { value, out, elapsedMs, child, rdpPort }.
const launchGui = async (dataDir, userDataDir) => {
  const gui = await harness.spawnGuiHeld(ELECTRON, DESKTOP, {
    extra: { KB_DATA_DIR_DESKTOP: dataDir },
    userDataDir,
  });
  const { child, rdpPort, hookResult } = gui;
  const started = Date.now();
  let out = '';
  let value = child.exitCode !== null ? { earlyExit: child.exitCode } : null;
  let settledAt = value !== null ? Date.now() - started : null;
  let settled = value !== null;
  const waiters = [];
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { out += d; });
  const settle = v => {
    if (settled) return;
    settled = true;
    value = v;
    settledAt = Date.now() - started;
    while (waiters.length) waiters.shift()({ value, out, elapsedMs: settledAt, child, rdpPort });
  };
  child.once('exit', code => settle({ earlyExit: code === null ? 'signal' : code }));
  return {
    child, rdpPort, hookResult,
    onOutput: predicate => {
      const timer = setInterval(() => { if (settled) { clearInterval(timer); return; } if (predicate(out)) { clearInterval(timer); settle({ matched: true }); } }, 200);
    },
    marker: (markerPath, timeoutMs) => {
      waitMarker(markerPath, timeoutMs).then(() => settle({ matched: true }), error => settle({ error }));
    },
    done: () => new Promise(resolve => {
      if (settled) resolve({ value, out, elapsedMs: settledAt, child, rdpPort });
      else waiters.push(resolve);
    }),
  };
};
const endpointPid = (dir) => {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'runtime-endpoint.json'), 'utf8')).pid; } catch { return null; }
};
const assertFixtureIsolated = (marker) => {
  const info = JSON.parse(fs.readFileSync(marker, 'utf8'));
  const proof = info.envProof || {};
  assert.equal(proof.provided, true, 'fixture must carry its env identity proof');
  for (const key of ['userProfileOwned', 'homedirOwned', 'appdataOwned', 'localappdataOwned', 'tempOwned', 'dataDirOwned', 'noCredentialKeys']) {
    assert.equal(proof[key], true, `fixture env boolean ${key} must be true`);
  }
  return info;
};

(async () => {
  assert.equal(fs.existsSync(ELECTRON), true, 'electron.exe must exist');
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  const results = {};
  const portsBefore = harness.protectedPortSnapshot();

  // Scenario A — busy existing instance (45s stall, version matching the
  // resolved core): honest progress, reuse, no second spawn, app page loaded.
  {
    const dataDir = path.join(runRoot, 'a-data');
    const marker = path.join(runRoot, 'a-ready.json');
    fs.mkdirSync(dataDir, { recursive: true });
    // The busy window must cover electron's own boot (cold start plus the
    // held-inspector attach), so the desktop's first control probe lands in
    // the stall.
    const fixture = harness.spawnNode(FIXTURE, [dataDir, marker, JSON.stringify({ busyAfterMs: 1500, busyMs: 45000, version: coreVersion })],
      { extra: { KB_SS_OWN_ROOTS: JSON.stringify(harness.ownRoots) } });
    let app = null;
    try {
      await waitMarker(marker);
      const info = assertFixtureIsolated(marker);
      // Launch the desktop only once the stall is actually active, so its
      // first control probe genuinely lands inside the busy window.
      await waitMarker(marker + '.busy');
      app = await launchGui(dataDir, path.join(runRoot, 'a-electron-userdata'));
      assert.equal(app.hookResult, 'installed', 'the main-process spawn hook must install (else backend isolation is NOT PASS)');
      app.marker(marker + '.appviewed', 85000);
      const run = await app.done();
      const log = run.out;
      if (process.env.R10_DEBUG) {
        let idleAt = null;
        try { idleAt = JSON.parse(fs.readFileSync(marker + '.idle', 'utf8')).at; } catch {}
        console.error(`--- scenario A: settle ${run.elapsedMs}ms, idle marker: ${idleAt || 'not yet'} ---\n${log}`);
      }
      const pidBefore = endpointPid(dataDir);
      results.scenarioA = {
        appViewed: run.value && run.value.matched === true,
        earlyExit: run.value && run.value.earlyExit !== undefined ? run.value.earlyExit : null,
        elapsedMs: run.elapsedMs,
        hookInstalled: app.hookResult === 'installed',
        progressSeen: /检测到现有后台/.test(log),
        reused: /reusing backend at/.test(log),
        noFalseFailure: !/后台连接失败|backend failed/.test(log),
        noSecondSpawn: pidBefore === info.pid,
        noOwnedLog: !fs.existsSync(path.join(dataDir, 'desktop-backend.log')),
        fixtureIsolated: true,
      };
      assert.equal(results.scenarioA.appViewed, true, 'desktop must load the existing instance app page after the busy window: ' + log.slice(-2000));
      assert.equal(results.scenarioA.progressSeen, true, 'busy-window progress must be visible in output');
      assert.equal(results.scenarioA.reused, true, 'desktop must log reusing backend');
      assert.equal(results.scenarioA.noFalseFailure, true, 'a live busy instance must never render 后台连接失败');
      assert.equal(results.scenarioA.noSecondSpawn, true, 'endpoint PID must stay the fixture PID (no second backend)');
      assert.equal(results.scenarioA.noOwnedLog, true, 'desktop-backend.log must not exist (no spawn happened)');
      // Visual proof only AFTER isolation booleans: real renderer screenshot.
      try {
        const shot = await harness.captureRendererScreenshot(run.rdpPort, '127.0.0.1', path.join(EVIDENCE_DIR, 'scenarioA-app-page.png'));
        results.scenarioA.screenshot = { bytes: shot.bytes, pageUrl: shot.pageUrl };
      } catch (error) {
        results.scenarioA.screenshot = { error: error.message };
      }
    } finally {
      try { harness.taskkillTree(app?.child?.pid); } catch {}
      try { app?.child?.kill(); } catch {}
      fixture.kill();
      await sleep(400);
    }
  }

  // Scenario B — definitive fatal error (old-format data dir → core exits on
  // SCHEMA_UNSUPPORTED): fast honest failure page with the log tail, and the
  // REAL spawned backend (RUN_AS_NODE child of the GUI) proven isolated via
  // the observer booleans.
  {
    const dataDir = path.join(runRoot, 'b-data');
    fs.mkdirSync(path.join(dataDir, 'projects', 'legacy-demo'), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'projects', 'legacy-demo', 'config.json'), '{}\n');
    const app = await launchGui(dataDir, path.join(runRoot, 'b-electron-userdata'));
    assert.equal(app.hookResult, 'installed', 'the main-process spawn hook must install (else backend isolation is NOT PASS)');
    app.onOutput(text => /backend failed/.test(text));
    let run;
    const guard = setTimeout(() => { try { app.child.kill(); } catch {} }, 90000);
    try {
      run = await app.done();
    } finally { clearTimeout(guard); try { harness.taskkillTree(app.child.pid); } catch {} try { app.child.kill(); } catch {} await sleep(400); }
    const log = run.out;
    if (process.env.R10_DEBUG) console.error('--- scenario B electron output ---\n' + log);
    const proof = harness.observerProof();
    results.scenarioB = {
      elapsedMs: run.elapsedMs,
      failedSurfaced: /backend failed/.test(log),
      definitiveExit: /发布端点前退出|后台进程在就绪前已退出/.test(log),
      logTailShown: /日志尾部|诊断日志/.test(log),
      fast: run.elapsedMs < 45000,
      backendObserverCount: proof.runAsNodeCount,
      backendIsolated: proof.allOwned,
    };
    assert.equal(results.scenarioB.failedSurfaced, true, 'definitive fatal must surface as backend failed: ' + log.slice(-2000));
    assert.equal(results.scenarioB.definitiveExit, true, 'failure must name the definitive exit cause');
    assert.equal(results.scenarioB.logTailShown, true, 'failure must point at the diagnostic log or tail');
    assert.equal(results.scenarioB.fast, true, 'fatal must surface fast, not at a patience deadline');
    assert.equal(results.scenarioB.backendIsolated, true,
      `the REAL backend spawned by the GUI must be isolated (observer runAsNode=${proof.runAsNodeCount}, booleans only): ` + JSON.stringify(proof.entries.slice(-3)));
  }

  results.isolation = {
    protectedPortsUnchanged: JSON.stringify(harness.protectedPortSnapshot()) === JSON.stringify(portsBefore),
  };
  assert.equal(results.isolation.protectedPortsUnchanged, true, 'protected ports 5757/5760/8787/8790 must be untouched');

  console.log('slow-startup desktop test PASS');
  for (const [name, value] of Object.entries(results)) console.log(' ', name, JSON.stringify(value).slice(0, 240));
  harness.cleanup();
})().catch(error => { console.error(error); try { harness.cleanup(); } catch {} process.exitCode = 1; });
