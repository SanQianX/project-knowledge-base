'use strict';
// P-PROFILE-CANONICAL-SAFETY-R49B canonical wrapper for the R49 SYS-003
// real-blank probe. This is the ONLY sanctioned entry. R49B rewrite notes:
//
//   * NO process-table scans and NO broad process kills exist anywhere in
//     this file. The R49-era sweep that matched process names/prefixes and
//     force-stopped every hit is gone. The wrapper only waits for the child
//     handle it spawned itself; if that one owned PID misses the bound it is
//     terminated via child.kill() on that exact PID, with in-process evidence
//     (pid / argv / spawn time / runRoot / parent pid) recorded in the run
//     log. Platform note (verified empirically in R49B on Windows/Node 24):
//     that single-PID call also terminates NON-DETACHED descendants of the
//     killed child via OS job-object semantics — everything affected stays
//     inside the wrapper's own spawned subtree. Detached descendants and any
//     process outside this subtree are unaffected, and residue is reported,
//     never swept.
//   * Every run writes to a UNIQUE run subdirectory; no prior run, and no
//     frozen R49/R49B history (lane-root run-log.json, evidence/) is ever
//     overwritten or deleted.
//   * Default mode is --check: zero services, zero browsers, zero models —
//     static verification only. --run is required to execute the fake-key
//     real-form test.
//   * Cleanup never force-deletes failure evidence: when the driver fails or
//     the child never closed, runRoot is retained and reported. Product
//     assertions (driverExitZero) and cleanup status (runRootRemoved) are
//     SEPARATE gates; removal is not a precondition for a product pass.
//   * All paths derive from __dirname or explicit arguments; nothing is
//     hardcoded to a machine-specific drive.
//
// Usage:
//   node qa-autopilot/tools/product-probes/qa-r49-run.cjs --check
//   node qa-autopilot/tools/product-probes/qa-r49-run.cjs --run \
//        [--driver <probe.js>] [--runs-root <dir>] [--child-timeout-ms <n>]
//
// The driver under test is fake-only by design (see
// qa-autopilot/docs/qa-r49-canonical.md): invented profiles, invented
// .invalid endpoints, never the real profiles/models/quota, never the
// protected ports 5757/5760/5790/8787/8790.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const HARNESS = path.join(ROOT, 'desktop', 'test', 'slow-startup-env.cjs');
const DEFAULT_DRIVER = path.join(ROOT, '_site', '_test', 'qa-r49-sys003-real-blank-probe.js');
const HOST = path.join(ROOT, '_site', '_test', 'helpers', 'qa-r49-wb-host.js');
const DEFAULT_RUNS_ROOT = path.join(ROOT, 'qa-autopilot', 'artifacts', 'parallel-20261023', 'profile-blank-real-r49', 'runs');

// R49 frozen execution hashes (report.json artifacts table). The probe and
// host are semantically frozen for this canonical lane; --check fails if
// either byte drifts. (The wrapper cannot embed its own hash.)
const FROZEN_HASHES = {
  [DEFAULT_DRIVER]: '2834a455a978867ec0fab69da6e087d7b2001beeaeed9670f03a2332e50845f5',
  [HOST]: '6bcb6d6353439e4838d381b33ca36d773189163b4e49a217f72cbc933006cb7d',
};

// Captured BEFORE createHarness: createHarness hardens this process's own
// environment, after which the real profile path would no longer resolve.
const REAL_USER_PROFILE = process.env.USERPROFILE || process.env.HOME || '';
const REAL_HOME_SURFACE_ROOT = path.join(REAL_USER_PROFILE, '.claude-ai-workbench');

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

// Process-safety scan tokens, assembled by concatenation so this source file
// does not contain the literals it bans.
const FORBIDDEN_TOKENS = [
  'Get-' + 'CimInstance',
  'Win32_' + 'Process',
  'Stop-' + 'Process',
  'task' + 'kill',
  'task' + 'list',
  'power' + 'shell',
];

function parseArgs(argv) {
  const mode = argv.includes('--run') ? 'run' : 'check';
  const out = { mode, driver: DEFAULT_DRIVER, runsRoot: DEFAULT_RUNS_ROOT, childTimeoutMs: 180000 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--check' || a === '--run') continue;
    if (a === '--driver') { out.driver = path.resolve(String(argv[++i])); continue; }
    if (a === '--runs-root') { out.runsRoot = path.resolve(String(argv[++i])); continue; }
    if (a === '--child-timeout-ms') { out.childTimeoutMs = Number(argv[++i]); continue; }
    throw new Error(`unknown argument: ${a}`);
  }
  if (argv.includes('--check') && argv.includes('--run')) throw new Error('--check and --run are mutually exclusive');
  if (!Number.isFinite(out.childTimeoutMs) || out.childTimeoutMs < 1000) throw new Error('--child-timeout-ms must be >= 1000');
  return out;
}

// ---------------------------------------------------------------- --check --

function staticRequires(file) {
  const src = fs.readFileSync(file, 'utf8');
  const found = [];
  const re = /require\(\s*(['"])([^'"]+)\1\s*\)/g;
  let m;
  while ((m = re.exec(src))) found.push(m[2]);
  return found;
}

// Minimal CommonJS resolution for literal specs: exact, +.js, +.cjs.
function resolveSpec(fromDir, spec) {
  const base = path.resolve(fromDir, spec);
  for (const candidate of [base, base + '.js', base + '.cjs']) {
    try { if (fs.statSync(candidate).isFile()) return candidate; } catch {}
  }
  return null;
}

const BARE_BUILTINS = new Set(['assert', 'buffer', 'child_process', 'cluster', 'console', 'constants', 'crypto', 'dgram', 'dns', 'domain', 'events', 'fs', 'http', 'http2', 'https', 'inspector', 'module', 'net', 'os', 'path', 'perf_hooks', 'process', 'punycode', 'querystring', 'readline', 'repl', 'stream', 'string_decoder', 'timers', 'tls', 'tty', 'url', 'util', 'v8', 'vm', 'worker_threads', 'zlib']);

function isTracked(file) {
  const rel = path.relative(ROOT, file).replace(/\\/g, '/');
  const r = spawnSync('git', ['ls-files', '--error-unmatch', rel], { cwd: ROOT, encoding: 'utf8', windowsHide: true });
  return r.status === 0;
}

function runCheck() {
  const results = [];
  const check = (name, ok, detail) => { results.push({ name, ok, detail }); console.log(`[r49-check] ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`); };

  const files = { driver: args.driver, host: HOST, wrapper: __filename, harness: HARNESS };
  for (const [label, file] of Object.entries(files)) {
    check(`path-exists:${label}`, fs.existsSync(file), file);
  }
  if (results.some(r => !r.ok)) return 1;

  for (const [label, file] of Object.entries(files)) {
    const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8', windowsHide: true });
    check(`syntax:${label}`, r.status === 0, r.status === 0 ? '' : String(r.stderr || '').trim().split('\n')[0]);
  }

  for (const file of [files.driver, files.host, files.wrapper]) {
    const src = fs.readFileSync(file, 'utf8');
    const hits = FORBIDDEN_TOKENS.filter(t => src.includes(t));
    check(`safety-scan:${path.basename(file)}`, hits.length === 0, hits.length ? 'forbidden process-scan/kill token(s) present' : 'no process-scan/kill entries');
  }

  for (const [file, expect] of Object.entries(FROZEN_HASHES)) {
    const actual = sha256(file);
    check(`frozen-hash:${path.basename(file)}`, actual === expect, actual === expect ? actual.slice(0, 16) + '…' : `expected ${expect.slice(0, 16)}… got ${actual.slice(0, 16)}…`);
  }

  // Dependency closure (bounded hops of literal requires): every resolved
  // file must be git-tracked, except the two lane-owned qa-r49 sources.
  // Requires built from runtime env paths (the pinned module) cannot be
  // statically resolved; the probe's identity section hash-verifies those
  // bytes at execution time.
  const owned = new Set(Object.keys(FROZEN_HASHES));
  const seen = new Set();
  let frontier = [files.driver, files.host, files.wrapper, files.harness];
  const dynamicNotes = [];
  while (frontier.length && seen.size < 64) {
    const next = [];
    for (const file of frontier) {
      if (seen.has(file)) continue;
      seen.add(file);
      for (const spec of staticRequires(file)) {
        if (spec.startsWith('node:') || BARE_BUILTINS.has(spec)) continue;
        const resolved = resolveSpec(path.dirname(file), spec);
        if (resolved) {
          const ok = owned.has(resolved) || isTracked(resolved);
          check(`closure:${path.relative(ROOT, resolved).replace(/\\/g, '/')}`, ok, ok ? (owned.has(resolved) ? 'lane-owned' : 'tracked') : 'NOT tracked and NOT lane-owned');
          next.push(resolved);
        } else {
          dynamicNotes.push(`${path.basename(file)} -> ${spec}`);
        }
      }
    }
    frontier = next;
  }
  if (dynamicNotes.length) console.log(`[r49-check] NOTE runtime-pinned requires (hash-verified by the probe identity section at execution time): ${[...new Set(dynamicNotes)].join('; ')}`);

  const failed = results.filter(r => !r.ok);
  console.log(`[r49-check] ${results.length - failed.length}/${results.length} checks passed`);
  return failed.length ? 1 : 0;
}

// ------------------------------------------------------------------ --run --

// Stat-only snapshot of the real home surface (explicit paths via the Node fs
// API; file contents are never opened).
function snapshotSurface(dir) {
  const entries = {};
  const walk = (current, prefix) => {
    let items = [];
    try { items = fs.readdirSync(current, { withFileTypes: true }); } catch { return; }
    for (const item of items) {
      const full = path.join(current, item.name);
      const rel = prefix ? `${prefix}/${item.name}` : item.name;
      try {
        if (item.isDirectory()) { entries[rel + '/'] = { dir: true }; walk(full, rel); }
        else { const st = fs.statSync(full); entries[rel] = { size: st.size, mtimeMs: st.mtimeMs }; }
      } catch { /* raced away */ }
    }
  };
  walk(dir, '');
  return entries;
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function runOnce() {
  const { createHarness } = require(HARNESS);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomBytes(3).toString('hex');
  const runDir = path.join(args.runsRoot, `run-${stamp}`);
  const evidenceDir = path.join(runDir, 'evidence');
  fs.mkdirSync(evidenceDir, { recursive: true });

  const before = snapshotSurface(REAL_HOME_SURFACE_ROOT);
  const harness = createHarness('profile-blank-real-r49');
  const runRoot = harness.runRoot;
  const dataDir = path.join(runRoot, 'wb-data');
  fs.mkdirSync(dataDir, { recursive: true });

  const startedAt = new Date().toISOString();
  const child = spawn(process.execPath, [args.driver], { cwd: ROOT, env: harness.nodeEnv({
    PK_R49_EVIDENCE: evidenceDir,
    PK_R49_DATA_DIR: dataDir,
  }), windowsHide: true });

  // In-process ownership evidence for the single escalation path below.
  const spawnEvidence = {
    pid: child.pid,
    parentPid: process.pid,
    relationship: 'direct spawn child of this wrapper',
    argv: [process.execPath, args.driver],
    spawnAt: startedAt,
    runRoot,
    runDir,
  };

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += String(chunk); });
  child.stderr.on('data', chunk => { stderr += String(chunk); });

  let closedResolve;
  const closedPromise = new Promise(resolve => { closedResolve = resolve; });
  child.on('error', error => closedResolve({ code: null, signal: null, spawnError: String(error && error.message || error) }));
  child.on('close', (code, signal) => closedResolve({ code, signal }));
  const waitClose = async (ms) => {
    const timer = new Promise(resolve => setTimeout(() => resolve('TIMEOUT'), ms));
    const value = await Promise.race([closedPromise, timer]);
    return value === 'TIMEOUT' ? null : value;
  };

  let result = await waitClose(args.childTimeoutMs);
  let escalation = null;
  if (!result) {
    // Last resort, exact single owned PID only. Grandchildren are never
    // touched; anything still alive afterwards is reported as residue.
    escalation = { ...spawnEvidence, action: 'SIGTERM', reason: `child did not exit within ${args.childTimeoutMs}ms` };
    child.kill();
    result = await waitClose(20000) || { code: null, signal: null, forcedKillDidNotClose: true };
  }
  const finishedAt = new Date().toISOString();

  // Product assertion and cleanup are reported SEPARATELY: runRoot removal is
  // never a precondition for the product verdict. Failure evidence is kept,
  // never force-deleted.
  const product = { driverExitZero: result.code === 0 };
  const after = snapshotSurface(REAL_HOME_SURFACE_ROOT);
  const envelope = { realHomeSurfaceUnchanged: JSON.stringify(before) === JSON.stringify(after) };

  let cleanupStatus = 'not-attempted';
  let runRootRemoved = false;
  if (!product.driverExitZero || result.forcedKillDidNotClose) {
    cleanupStatus = result.forcedKillDidNotClose ? 'retained-blocked-cleanup' : 'retained-failure-evidence';
  } else {
    for (let attempt = 1; attempt <= 5; attempt++) {
      harness.cleanup();
      if (!fs.existsSync(runRoot)) break;
      await sleep(300);
    }
    runRootRemoved = !fs.existsSync(runRoot);
    cleanupStatus = runRootRemoved ? 'removed' : 'blocked-residue-reported';
  }

  const runLog = {
    schema: 'qa-autopilot/profile-blank-real-r49/run/v2',
    mode: 'run',
    startedAt, finishedAt,
    driver: args.driver,
    spawn: spawnEvidence,
    result, escalation,
    product, envelope,
    cleanup: { status: cleanupStatus, runRootRemoved, runRoot },
    realHomeSurface: { root: REAL_HOME_SURFACE_ROOT, entriesBefore: Object.keys(before).length, entriesAfter: Object.keys(after).length },
    runDir, runsRoot: args.runsRoot, evidenceDir,
  };
  fs.writeFileSync(path.join(runDir, 'run-log.json'), JSON.stringify(runLog, null, 2) + '\n');
  fs.writeFileSync(path.join(runDir, 'driver-stdout.txt'), stdout);
  fs.writeFileSync(path.join(runDir, 'driver-stderr.txt'), stderr);

  console.log(`[r49-run] runDir: ${runDir}`);
  console.log(`[r49-run] product:${JSON.stringify(product)} envelope:${JSON.stringify(envelope)} cleanup:${JSON.stringify({ status: cleanupStatus, runRootRemoved })}${escalation ? ' escalation:' + JSON.stringify(escalation) : ''}`);
  return product.driverExitZero && envelope.realHomeSurfaceUnchanged ? 0 : 1;
}

// ------------------------------------------------------------------ main --

const args = parseArgs(process.argv.slice(2));
if (args.mode === 'check') {
  process.exit(runCheck());
}
runOnce().then(code => process.exit(code)).catch(error => {
  console.error('R49 WRAPPER FAILED:', error && error.stack || error);
  process.exit(2);
});
