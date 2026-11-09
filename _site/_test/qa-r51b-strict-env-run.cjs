'use strict';
// P-LIFECYCLE-STRICT-ENV-R51B canonical wrapper. The ONLY sanctioned entry for
// the strict-env supplement: it installs the audited full-allowlist isolation
// (desktop/test/slow-startup-env.cjs createHarness -> release-preflight-5025
// -env.cjs) in the PARENT process FIRST, then spawns the UNMODIFIED original
// R51 probes (qa-r51-sys001-negative-ui.cjs / qa-r51-sys005-port-conflict.cjs)
// so every env value the probes and ALL their descendants see — HOME,
// USERPROFILE, APPDATA, LOCALAPPDATA, TEMP/TMP, CODEX_HOME, CLAUDE_CONFIG_DIR,
// CLAUDE_AI_WORKBENCH_DATA_DIR, AI_CODING_EVENT_BRIDGE_HOME, KB_DATA_DIR,
// KB_KNOWLEDGE_DATA_DIR — is an explicit owned root under one harness runRoot
// (HOMEDRIVE/HOMEPATH deleted, every ambient provider/secret/module var
// dropped by the allow-list). NO real profile var is restored anywhere: the
// browser is resolved INSIDE the isolated environment (find-chrome under the
// hardened env — the exact R49 launch shape that succeeded on this machine:
// the LOCALAPPDATA chrome build is invisible, the PROGRAMFILES(X86) Edge is
// the locatable tool), so the only real-world path in play is that absolute
// browser executable location.
//
// The original SYS001 driver's own browserEnvException captures the four
// profile vars from ITS environment — under this wrapper those are already the
// harness-isolated values, so the audited concern (GUI child restoring the
// REAL HOME/USERPROFILE/APPDATA/LOCALAPPDATA) cannot occur without editing a
// single original byte.
//
//   * Default --check: zero services, zero browsers, zero models — static
//     verification only (file/syntax/identity/product-surface/chrome).
//   * --run --case bootstrap: ONE independent browser launch under the full
//     harness env (launchCdpBrowser inheriting the hardened process env, own
//     profile dir, about:blank, screenshot, close). No product, no model.
//   * --run --case sys001|sys005: spawn the unmodified original probe with
//     --run; evidence lands under a UNIQUE per-run dir (R51_EVIDENCE_ROOT), so
//     no earlier run or the frozen R51 lane is ever overwritten.
//   * NO process-table scans, NO broad kills: only the exact child PID this
//     wrapper spawned is eligible for child.kill() after its bound, with
//     in-process ownership evidence (pid/argv/spawn time/runRoot/ppid).
//     Cleanup and the product verdict are SEPARATE gates; failure evidence is
//     never force-deleted.
//
// Usage:
//   node _site/_test/qa-r51b-strict-env-run.cjs --check
//   node _site/_test/qa-r51b-strict-env-run.cjs --run --case bootstrap
//   node _site/_test/qa-r51b-strict-env-run.cjs --run --case sys001
//   node _site/_test/qa-r51b-strict-env-run.cjs --run --case sys005

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const HARNESS = path.join(ROOT, 'desktop', 'test', 'slow-startup-env.cjs');
const LANE = path.join(ROOT, 'qa-autopilot', 'artifacts', 'parallel-20261023', 'lifecycle-strict-env-r51b');
const RUNS_ROOT = path.join(LANE, 'runs');
const DRIVERS = {
  sys001: path.join(ROOT, '_site', '_test', 'qa-r51-sys001-negative-ui.cjs'),
  sys005: path.join(ROOT, '_site', '_test', 'qa-r51-sys005-port-conflict.cjs'),
};
const HELPER = path.join(ROOT, '_site', '_test', 'helpers', 'qa-r51-env.cjs');
const OFFICIAL26 = '77daaa7c386c565c32b1476ecaec4cb991b62394';
const PRODUCT_SURFACES = ['bin/project-knowledge.js', '_site/lib', '_site/scripts', 'ui/product.js'];
const CHILD_TIMEOUT_MS = { bootstrap: 120000, sys001: 300000, sys005: 300000 };
// Metadata-only env proof set (names/presence/resolved paths, never values).
const PROOF_VARS = [
  'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP',
  'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'CLAUDE_AI_WORKBENCH_DATA_DIR',
  'AI_CODING_EVENT_BRIDGE_HOME', 'KB_DATA_DIR', 'KB_KNOWLEDGE_DATA_DIR',
];

// Assembled by concatenation so this source file does not contain the literals
// it bans (same pattern as the R49B canonical wrapper).
const FORBIDDEN_TOKENS = [
  'Get-' + 'CimInstance', 'Win32_' + 'Process', 'Stop-' + 'Process',
  'task' + 'kill', 'task' + 'list', 'power' + 'shell',
];

const sha256 = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const sleep = ms => new Promise(r => setTimeout(r, ms));

function parseArgs(argv) {
  const mode = argv.includes('--run') ? 'run' : 'check';
  let kase = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--check' || a === '--run') continue;
    if (a === '--case') { kase = String(argv[++i]); continue; }
    throw new Error(`unknown argument: ${a}`);
  }
  if (mode === 'check' && kase) throw new Error('--case is only valid with --run');
  if (mode === 'run') {
    if (!['bootstrap', 'sys001', 'sys005'].includes(kase)) throw new Error('--case must be bootstrap|sys001|sys005');
  }
  return { mode, kase };
}

// Names-only metadata for an env object: presence + resolved target + whether
// it sits inside the harness runRoot. Never records variable VALUES.
function envMetadata(env, runRoot) {
  const vars = {};
  for (const name of PROOF_VARS) {
    const value = env[name];
    if (value === undefined) { vars[name] = { set: false }; continue; }
    const resolved = path.resolve(String(value));
    const rel = path.relative(path.resolve(runRoot), resolved);
    vars[name] = { set: true, resolved, insideRunRoot: !(rel.startsWith('..') || path.isAbsolute(rel)) };
  }
  return vars;
}

function providerShapedNames(env) {
  // Mirrors release-preflight-5025-env.cjs PROVIDER_KEY (name match only).
  const { PROVIDER_KEY } = require(path.join(ROOT, 'desktop', 'test', 'release-preflight-5025-env.cjs'));
  return Object.keys(env).filter(k => PROVIDER_KEY.test(k) && k !== 'PSModuleAnalysisCachePath');
}

// ---------------------------------------------------------------- --check --

function runCheck() {
  const results = [];
  const check = (name, ok, detail) => { results.push({ name, ok, detail }); console.log(`[r51b-check] ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`); };

  const files = { harness: HARNESS, wrapper: __filename, envHelper: HELPER, driverSys001: DRIVERS.sys001, driverSys005: DRIVERS.sys005 };
  for (const [label, file] of Object.entries(files)) check(`path-exists:${label}`, fs.existsSync(file), file);
  if (results.some(r => !r.ok)) return 1;

  for (const [label, file] of Object.entries(files)) {
    const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8', windowsHide: true });
    check(`syntax:${label}`, r.status === 0, r.status === 0 ? '' : String(r.stderr || '').trim().split('\n')[0]);
  }
  const hits = FORBIDDEN_TOKENS.filter(t => fs.readFileSync(__filename, 'utf8').includes(t));
  check('safety-scan:wrapper', hits.length === 0, hits.length ? 'forbidden token(s) present' : 'no process-scan/kill entries');

  // Identity: live original bytes == this lane's snapshots == R51 report table.
  const snap = JSON.parse(fs.readFileSync(path.join(LANE, 'snapshots', 'snapshot-manifest.json'), 'utf8'));
  const live = {
    'qa-r51-sys001-negative-ui.cjs': DRIVERS.sys001,
    'qa-r51-sys005-port-conflict.cjs': DRIVERS.sys005,
    'qa-r51-env.cjs': HELPER,
  };
  for (const [name, file] of Object.entries(live)) {
    const ok = sha256(file) === snap.files[name].sha256 && snap.matchesR51Report[name] === true;
    check(`identity:${name}`, ok, ok ? sha256(file).slice(0, 16) + '… (== snapshot == R51 report)' : 'drift vs snapshot/R51 report');
  }

  // Product surfaces byte-identical to the official 26 source commit.
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8', windowsHide: true });
  const diff = spawnSync('git', ['diff', '--name-only', OFFICIAL26, head.stdout.trim(), '--', ...PRODUCT_SURFACES], { cwd: ROOT, encoding: 'utf8', windowsHide: true });
  const dirty = spawnSync('git', ['status', '--porcelain', '--', ...PRODUCT_SURFACES], { cwd: ROOT, encoding: 'utf8', windowsHide: true });
  const productClean = diff.status === 0 && dirty.status === 0 && diff.stdout.trim() === '' && dirty.stdout.trim() === '';
  check('product-surface==77daaa7', productClean, productClean ? `HEAD ${head.stdout.trim().slice(0, 12)} identical on ${PRODUCT_SURFACES.join(', ')}` : 'product bytes drifted vs official 77daaa7');

  // Chrome tool location resolvable BEFORE any isolation (pure path probing),
  // plus the browser that stays visible INSIDE the hardened env (R49 shape).
  const { findChrome } = require(path.join(ROOT, '_site', '_test', 'helpers', 'find-chrome.js'));
  const chrome = findChrome();
  check('chrome-tool-locatable', Boolean(chrome && fs.existsSync(chrome)), chrome || 'not found');
  const hardenedVisible = ['edge-programfiles', 'edge-programfiles-x86']
    .flatMap(src => {
      const root = src.endsWith('-x86') ? process.env['PROGRAMFILES(X86)'] : process.env.PROGRAMFILES;
      return root ? [path.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe')] : [];
    })
    .find(p => fs.existsSync(p));
  check('browser-visible-inside-isolation', Boolean(hardenedVisible), hardenedVisible || 'no PROGRAMFILES Edge found (post-isolation find-chrome would fail)');

  const failed = results.filter(r => !r.ok);
  console.log(`[r51b-check] ${results.length - failed.length}/${results.length} checks passed`);
  return failed.length ? 1 : 0;
}

// ------------------------------------------------------------------ --run --

async function runCase(kase) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomBytes(3).toString('hex');
  const runDir = path.join(RUNS_ROOT, `run-${stamp}-${kase}`);
  fs.mkdirSync(runDir, { recursive: true });

  const ambientNames = Object.keys(process.env);
  const ambientProviderShaped = providerShapedNames(process.env);
  const harness = createHarnessSafe();
  const runRoot = harness.runRoot;

  // Browser tool resolved INSIDE the isolated env (post-hardening), the R49
  // launch shape. The first bootstrap attempt resolved chrome.exe BEFORE
  // hardening and FAILED under isolation (real first failure, run dir kept):
  // the LOCALAPPDATA chrome build logs "Can't retrieve app data directory"
  // and refuses remote debugging. Under the hardened env find-chrome sees only
  // the PROGRAMFILES(X86) Edge, which launches green in the audited R49 run.
  const { findChromeDetailed } = require(path.join(ROOT, '_site', '_test', 'helpers', 'find-chrome.js'));
  const browserFound = findChromeDetailed();
  const browserExe = browserFound.path;

  const childEnvBase = {
    R51_TEMP_ROOT: path.join(runRoot, 'r51-temp'),
  };
  const envProof = {
    ambient: { varCount: ambientNames.length, providerShapedNames: ambientProviderShaped },
    hardenedWrapperEnv: { varCount: Object.keys(process.env).length, providerShapedNames: providerShapedNames(process.env), vars: envMetadata(process.env, runRoot) },
    homedriveHompeathDeleted: process.env.HOMEDRIVE === undefined && process.env.HOMEPATH === undefined,
    browserResolvedInsideIsolation: { executable: browserExe, findChromeSource: browserFound.source, note: 'no real profile var restored; absolute executable path is the only real-world tool location' },
  };

  const startedAt = new Date().toISOString();
  let product = null;
  let spawnEvidence = null;

  if (kase === 'bootstrap') {
    // ONE independent browser launch under the FULL harness env. The browser
    // child INHERITS this process's hardened environment (no env option), the
    // exact shape R49 proved on this machine; own profile dir under runRoot.
    const { launchCdpBrowser } = require(path.join(ROOT, '_site', '_test', 'helpers', 'cdp-browser.js'));
    let browser = null;
    try {
      browser = await launchCdpBrowser({ chrome: browserExe, profileDir: path.join(runRoot, 'browser-profile'), url: 'about:blank', width: 1280, height: 800 });
      const state = await browser.evaluate('document.readyState');
      await browser.screenshot(path.join(runDir, 'bootstrap-about-blank.png'));
      product = { driverExitZero: true, readyState: state, exceptions: browser.exceptions.length };
    } catch (error) {
      product = { driverExitZero: false, firstFailure: String((error && error.stack) || error) };
    } finally {
      try { await browser?.close(); } catch {}
    }
    spawnEvidence = { mode: 'in-process browser launch (inherits hardened wrapper env)', browserExe, profileDir: path.join(runRoot, 'browser-profile') };
  } else {
    const driver = DRIVERS[kase];
    const evidenceRoot = path.join(runDir, 'driver-evidence');
    fs.mkdirSync(evidenceRoot, { recursive: true });
    const childEnv = harness.nodeEnv({ ...childEnvBase, R51_EVIDENCE_ROOT: evidenceRoot });
    envProof.childEnv = { varCount: Object.keys(childEnv).length, providerShapedNames: providerShapedNames(childEnv), vars: envMetadata(childEnv, runRoot), extras: Object.keys(childEnvBase).concat(['R51_EVIDENCE_ROOT']), note: 'the SYS001 child resolves its own browser inside this env (find-chrome -> Edge); KB_CHROME_PATH deliberately NOT set so no real LOCALAPPDATA path crosses the boundary' };

    const child = spawn(process.execPath, [driver, '--run'], { cwd: ROOT, env: childEnv, windowsHide: true });
    spawnEvidence = { pid: child.pid, parentPid: process.pid, relationship: 'direct spawn child of this wrapper', argv: [process.execPath, driver, '--run'], spawnAt: startedAt, runRoot, runDir };
    let stdout = ''; let stderr = '';
    child.stdout.on('data', c => { stdout += String(c); });
    child.stderr.on('data', c => { stderr += String(c); });
    let closedResolve;
    const closedPromise = new Promise(resolve => { closedResolve = resolve; });
    child.on('error', error => closedResolve({ code: null, signal: null, spawnError: String(error && error.message || error) }));
    child.on('close', (code, signal) => closedResolve({ code, signal }));
    const waitClose = async ms => {
      const timer = new Promise(resolve => setTimeout(() => resolve('TIMEOUT'), ms));
      const value = await Promise.race([closedPromise, timer]);
      return value === 'TIMEOUT' ? null : value;
    };
    let result = await waitClose(CHILD_TIMEOUT_MS[kase]);
    let escalation = null;
    if (!result) {
      escalation = { ...spawnEvidence, action: 'SIGTERM', reason: `child did not exit within ${CHILD_TIMEOUT_MS[kase]}ms` };
      child.kill();
      result = await waitClose(20000) || { code: null, signal: null, forcedKillDidNotClose: true };
    }
    product = { driverExitZero: result.code === 0, result, escalation };
    fs.writeFileSync(path.join(runDir, 'driver-stdout.txt'), stdout);
    fs.writeFileSync(path.join(runDir, 'driver-stderr.txt'), stderr);
  }

  const finishedAt = new Date().toISOString();
  // Cleanup is a SEPARATE gate: failure evidence (runRoot) is retained.
  let cleanupStatus = 'not-attempted';
  let runRootRemoved = false;
  if (product.driverExitZero) {
    for (let attempt = 1; attempt <= 5; attempt++) {
      harness.cleanup();
      if (!fs.existsSync(runRoot)) break;
      await sleep(300);
    }
    runRootRemoved = !fs.existsSync(runRoot);
    cleanupStatus = runRootRemoved ? 'removed' : 'blocked-residue-reported';
  } else {
    cleanupStatus = 'retained-failure-evidence';
  }

  const runLog = {
    schema: 'qa-autopilot/lifecycle-strict-env-r51b/run/v1',
    mode: 'run', kase, startedAt, finishedAt,
    harness: 'desktop/test/slow-startup-env.cjs createHarness (full SYSTEM_ALLOW allowlist; HOMEDRIVE/HOMEPATH deleted; every writable root under one runRoot)',
    spawn: spawnEvidence,
    envProof,
    product, cleanup: { status: cleanupStatus, runRootRemoved, runRoot },
    runDir,
  };
  fs.writeFileSync(path.join(runDir, 'run-log.json'), JSON.stringify(runLog, null, 2) + '\n');
  console.log(`[r51b-run] runDir: ${runDir}`);
  console.log(`[r51b-run] product:${JSON.stringify(product)} cleanup:${JSON.stringify({ status: cleanupStatus, runRootRemoved })}`);
  return product.driverExitZero ? 0 : 1;
}

function createHarnessSafe() {
  const { createHarness } = require(HARNESS);
  return createHarness('lifecycle-strict-env-r51b');
}

const args = parseArgs(process.argv.slice(2));
if (args.mode === 'check') process.exit(runCheck());
runCase(args.kase).then(code => process.exit(code)).catch(error => {
  console.error('R51B WRAPPER FAILED:', (error && error.stack) || error);
  process.exit(2);
});
