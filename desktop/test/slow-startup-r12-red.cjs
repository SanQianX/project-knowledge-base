'use strict';
// P-STARTUP-ISOLATION-R12 red→green E2E for the bin launcher patience cap.
// Deterministic on BOTH sides of the fix without touching product code: the
// CLI runs with a test-only --require preload (the R12 observer plus a delay
// block that stalls ONLY the spawned --fg backend by 50s, emulating a
// large-data init window). With KB_LAUNCHER_STARTUP_PATIENCE_MS=20000:
//   RED (pre-fix): the first budget checkpoint is hard-coded at 45s, so the
//     20s deadline is ignored until 45s; then the cap's plain Error reaches
//     the outer handler → "启动失败：启动仍在进行…" + exit 1 (the exact R11
//     boundary defect: an honest still-starting mislabeled as failure).
//   GREEN (post-fix): the checkpoint schedule honors the patience deadline
//     (min(45s, patience)) and the cap throws a TYPED still-starting error
//     the outer handler reports honestly: exit 0, 未判定失败, no 启动失败.
// Usage: node desktop/test/slow-startup-r12-red.cjs <output.json>
// Exit 0 = GREEN observed; exit 1 = RED observed (expected before the fix);
// exit 2 = unexpected shape (investigate).
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createHarness, observerSource } = require('./slow-startup-env.cjs');

const harness = createHarness('red');
const ROOT = path.resolve(__dirname, '..', '..');
const BIN = path.join(ROOT, 'bin', 'project-knowledge.js');
const OUT = process.argv[2] || path.join(harness.runRoot, 'r12-red.json');
const DELAY_MS = 50000;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

(async () => {
  const portsBefore = harness.protectedPortSnapshot();
  const redLog = path.join(harness.runRoot, 'red-observer.jsonl');
  const redPreload = path.join(harness.runRoot, 'red-preload.cjs');
  // The red preload IS the observer for this run (its own path is what the
  // spawn wrap injects into the delayed --fg backend), plus the delay block.
  fs.writeFileSync(redPreload, observerSource({
    ...harness.ownRoots, log: redLog, observer: redPreload,
  }) + `
try {
  if (process.env.KB_SS_RED_DELAY === '1' && process.argv.includes('--fg')) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${DELAY_MS});
  }
} catch {}
`);

  const dataDir = path.join(harness.runRoot, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const ownPort = await harness.freePort();
  const cliEnv = harness.nodeEnv({
    KB_SS_RED_DELAY: '1',
    KB_LAUNCHER_STARTUP_PATIENCE_MS: '20000',
    KB_MODULES_AUTOSTART: '0',
    KB_SITE_PORT: String(ownPort),
    ELECTRON_RUN_AS_NODE: '1',
  });
  const startedAt = Date.now();
  const run = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--require', redPreload, BIN, 'start', '--data', dataDir, '--no-open'],
      { env: cliEnv, windowsHide: true });
    let out = '', err = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    const timer = setTimeout(() => { try { child.kill(); } catch {} reject(new Error('cli timeout')); }, 90000);
    child.once('exit', code => { clearTimeout(timer); resolve({ code, out, err, elapsedMs: Date.now() - startedAt }); });
  });
  const combined = (run.out + run.err).trim();

  // Cleanup: the detached backend finishes its delay then boots; stop it via
  // the verified CLI stop protocol, tree-kill as a fallback.
  const endpointPid = () => {
    try { return JSON.parse(fs.readFileSync(path.join(dataDir, 'runtime-endpoint.json'), 'utf8')).pid; } catch { return null; }
  };
  let stopped = 'not-started';
  {
    const deadline = Date.now() + DELAY_MS + 20000;
    let pid = null;
    while (Date.now() < deadline && !(pid = endpointPid()) ) await sleep(300);
    if (pid && harness.pidAlive(pid)) {
      const stop = await new Promise((resolve) => {
        const child = harness.spawnNode(BIN, ['stop', '--data', dataDir], { extra: { KB_MODULES_AUTOSTART: '0' } });
        const timer = setTimeout(() => { try { child.kill(); } catch {} resolve('timeout'); }, 45000);
        child.once('exit', code => { clearTimeout(timer); resolve(code === 0 ? 'stopped' : `stop-exit-${code}`); });
      });
      stopped = stop;
      const after = endpointPid();
      if (after && harness.pidAlive(after)) { harness.taskkillTree(after); stopped += '+treekill'; }
    } else stopped = 'no-live-backend';
  }

  const entries = (() => {
    try {
      return fs.readFileSync(redLog, 'utf8').split('\n').filter(Boolean)
        .map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
    } catch { return []; }
  })();
  const runAsNode = entries.filter(e => e.runAsNode);
  const verdict = run.code === 0 && /未判定失败/.test(combined) && !/启动失败/.test(combined)
    ? 'GREEN'
    : run.code === 1 && /启动失败/.test(combined) && /启动仍在进行/.test(combined)
      ? 'RED'
      : 'UNEXPECTED';
  const record = {
    schema: 'qa-autopilot/parallel-20261023/startup-isolation-r12-red/v1',
    at: new Date().toISOString(),
    verdict,
    cli: { exit: run.code, elapsedMs: run.elapsedMs, output: combined },
    backendDelayMs: DELAY_MS,
    patienceMs: 20000,
    isolation: {
      observerTotal: entries.length,
      observerRunAsNode: runAsNode.length,
      allOwned: entries.length > 0 && runAsNode.length > 0 && runAsNode.every(e => e.userProfileOwned && e.homedirOwned && e.appdataOwned && e.localappdataOwned && e.tempOwned),
      realUserProfileSeen: entries.some(e => !e.userProfileOwned),
      protectedPortsUnchanged: JSON.stringify(harness.protectedPortSnapshot()) === JSON.stringify(portsBefore),
      ownPort,
    },
    cleanup: stopped,
  };
  fs.mkdirSync(path.dirname(path.resolve(OUT)), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(record, null, 2));
  console.log(JSON.stringify({ verdict, exit: run.code, elapsedMs: run.elapsedMs, output: combined.slice(0, 300), cleanup: stopped, isolation: record.isolation }, null, 2));
  harness.cleanup();
  process.exitCode = verdict === 'GREEN' ? 0 : verdict === 'RED' ? 1 : 2;
})().catch(error => { console.error(error); try { harness.cleanup(); } catch {} process.exitCode = 2; });
