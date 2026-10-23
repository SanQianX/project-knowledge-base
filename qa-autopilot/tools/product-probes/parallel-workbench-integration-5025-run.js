#!/usr/bin/env node
'use strict';
// P-WB-QA-INTEGRATION-5025 / P-WB-CANONICAL-R2 — the explicit entry point for
// the canonical Workbench QA suite. These are MANUAL, heavyweight tools (real
// Chrome, real isolated hosts; three of them spend real paid model turns and
// really talk to the provider), so none of them is named *-test.js and
// run-all-tests.js never collects them. This runner is the single documented
// way to launch them.
//
// Usage (from any cwd, against a clean tracked checkout):
//   node qa-autopilot/tools/product-probes/parallel-workbench-integration-5025-run.js --list
//   node qa-autopilot/tools/product-probes/parallel-workbench-integration-5025-run.js --check
//   node qa-autopilot/tools/product-probes/parallel-workbench-integration-5025-run.js --run env
//   node qa-autopilot/tools/product-probes/parallel-workbench-integration-5025-run.js --run drafts
//   PK_WB_ALLOW_PAID_TURNS=1 node ...--run model|ordering|abort
//
// --list   describe every entry (default)
// --check  node --check every suite file, verify the whole dependency closure
//          resolves on disk AND is Git-tracked (so a clean checkout really has
//          it), confirm the collection/paid classification, and run the FREE
//          offline env self-check in a child process — no browser, no model
// --run N  run one entry in a child process and propagate its real exit code.
//          The child NEVER inherits the developer's shell: the runner performs
//          the read-only discovery itself (real environment) and hands the
//          child only the documented whitelist plus the captured absolutes;
//          the entry's launcher boot then isolates the driver itself before
//          anything else happens.
//
// The paid entries (model / ordering / abort) additionally require BOTH the
// explicit PK_WB_ALLOW_PAID_TURNS=1 acknowledgement AND an explicit
// PK_WB_REAL_PROFILE_DIR (the runner never invents one), so a paid turn can
// never be triggered by accident, by a default CI loop, or by silently
// auto-discovering the real subscription profile.
//
// Environment contract (forwarded to the entries):
//   PK_TEST_TEMP_ROOT         optional temp-root override for the isolation
//                             fixture (defaults: shared root next to the repo,
//                             then TEMP/TMP/TMPDIR, then the OS temp dir)
//   PK_WB_MODULE_ROOT         explicit module root (candidate releases)
//   PK_WB_EXPECTED_VERSION    explicit expected version; by default the
//                             identity chain reads the root package's exact
//                             dependency constraint independently
//   PK_WB_REAL_PROFILE_DIR    real profile dir for the read-only in-memory
//                             facade (paid entries only; must be explicit)
//   PARALLEL_WORKBENCH_RUNTIME_EVIDENCE  evidence target for the paid entries
//                             (defaulted under the integration-5025 artifacts)
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const EVIDENCE_DIR = path.join(REPO_ROOT, 'qa-autopilot', 'artifacts', 'parallel-20261023', 'workbench-integration-5025', 'evidence');
const LAUNCHER = path.join(REPO_ROOT, '_site', '_test', 'helpers', 'parallel-workbench-integration-5025-launcher.js');

const HELPERS = [
  '_site/_test/helpers/parallel-workbench-integration-5025-fixture.js',
  '_site/_test/helpers/parallel-workbench-integration-5025-launcher.js',
  '_site/_test/helpers/parallel-workbench-integration-5025-host.js',
  '_site/_test/helpers/parallel-workbench-integration-5025-harness.js',
  '_site/_test/helpers/parallel-workbench-integration-5025-runtime-harness.js',
];

const ENTRIES = [
  {
    name: 'env',
    file: '_site/_test/parallel-workbench-integration-5025-env-check.js',
    caseId: 'I5025-ENV',
    paid: false,
    description: 'FREE offline env self-check — launcher gates, full driver isolation in a real child, identity carry-through, runner whitelist, pure-fragment + 50-anchor validation (no browser, no model, no network)',
  },
  {
    name: 'drafts',
    file: '_site/_test/parallel-workbench-integration-5025-drafts-probe.js',
    caseId: 'WB-005',
    paid: false,
    description: 'draft & attachment isolation — real browser, real UI, fictional profile, ZERO model requests (the canonical retest of the accepted R5 probe)',
  },
  {
    name: 'model',
    file: '_site/_test/parallel-workbench-integration-5025-model-probe.js',
    caseId: 'WB-003',
    paid: true,
    description: 'real MiniMax positive acceptance — API-driven, exactly ONE paid turn, real network to the provider, real profile behind the read-only in-memory facade (needs PK_WB_ALLOW_PAID_TURNS=1 + explicit PK_WB_REAL_PROFILE_DIR)',
  },
  {
    name: 'ordering',
    file: '_site/_test/parallel-workbench-integration-5025-ordering-probe.js',
    caseId: 'WB-004',
    paid: true,
    description: 'consecutive-answer ordering with stale-frame replay — real browser, TWO paid turns, real network to the provider, real profile (same authorization)',
  },
  {
    name: 'abort',
    file: '_site/_test/parallel-workbench-integration-5025-abort-probe.js',
    caseId: 'WB-008',
    paid: true,
    description: 'abort isolation of two concurrent real sessions — real browser, TWO paid turns, real network to the provider, real profile (same authorization)',
  },
];

function fail(message) {
  console.error(`parallel-workbench-integration-5025-run: ${message}`);
  process.exit(2);
}

function listEntries() {
  console.log('canonical workbench QA entries (manual, heavyweight — never collected by run-all-tests.js):');
  for (const entry of ENTRIES) {
    console.log(`  ${entry.name.padEnd(9)} ${entry.caseId}  ${entry.paid ? '[PAID: needs PK_WB_ALLOW_PAID_TURNS=1 + explicit PK_WB_REAL_PROFILE_DIR; real network]' : '[free]'}`);
    console.log(`            ${entry.description}`);
    console.log(`            ${entry.file}`);
  }
  console.log('\nno entry is a default CI test; run one explicitly with --run <name>');
  return 0;
}

function gitTracked(relative, env) {
  try {
    execFileSync('git', ['ls-files', '--error-unmatch', relative], { cwd: REPO_ROOT, windowsHide: true, stdio: 'ignore', env });
    return true;
  } catch { return false; }
}

// node --check every suite file, resolve every relative require on disk, and
// confirm Git tracks the whole closure — the cheap validation that works from
// a clean checkout without launching a browser, plus the free offline env
// self-check that proves the R2/R3 wiring itself.
function checkSuite() {
  let failures = 0;
  // --check spawns its OWN children too, so they get the SAME whitelist env as
  // --run children: runnerDiscovery runs with the real environment (read-only),
  // then every spawned child (syntax checks, git, the env self-check) runs on
  // buildRunnerChildEnv with the captures forwarded — the runner never hands
  // its own developer shell to anything it spawns.
  const captures = runnerDiscovery();
  const { buildRunnerChildEnv } = require(LAUNCHER);
  const checkEnv = buildRunnerChildEnv(process.env, captures);
  const files = ['qa-autopilot/tools/product-probes/parallel-workbench-integration-5025-run.js', ...HELPERS, ...ENTRIES.map(entry => entry.file)];
  for (const rel of files) {
    const abs = path.join(REPO_ROOT, rel);
    const syntax = spawnSync(process.execPath, ['--check', abs], { encoding: 'utf8', windowsHide: true, env: checkEnv });
    if (syntax.status !== 0) {
      failures += 1;
      console.log(`SYNTAX FAIL ${rel}\n${syntax.stderr}`);
      continue;
    }
    const text = fs.readFileSync(abs, 'utf8');
    const missing = [];
    const untrackedDeps = [];
    const seen = new Set();
    for (const match of text.matchAll(/require\((['"])(\.[^'"]+)\1\)/g)) {
      const spec = match[2];
      if (seen.has(spec)) continue;
      seen.add(spec);
      const target = path.resolve(path.dirname(abs), spec);
      const candidate = fs.existsSync(target) ? target : `${target}.js`;
      if (!fs.existsSync(target) && !fs.existsSync(`${target}.js`)) {
        missing.push(spec);
        continue;
      }
      const depRel = path.relative(REPO_ROOT, candidate).split(path.sep).join('/');
      if (!gitTracked(depRel, checkEnv)) untrackedDeps.push(`${spec} → ${depRel}`);
    }
    if (missing.length) {
      failures += 1;
      console.log(`CLOSURE FAIL ${rel}: missing require target(s) ${missing.join(', ')}`);
      continue;
    }
    if (untrackedDeps.length) {
      failures += 1;
      console.log(`CLOSURE FAIL ${rel}: untracked dependency — a clean checkout would not resolve: ${untrackedDeps.join(', ')}`);
      continue;
    }
    if (!gitTracked(rel, checkEnv)) {
      failures += 1;
      console.log(`TRACKED FAIL ${rel}: not Git-tracked — a clean checkout would not have it`);
      continue;
    }
    console.log(`OK ${rel} (syntax + closure + tracked)`);
  }
  // Every heavyweight entry stays out of the default collection, and every
  // paid entry is marked paid — the classification a clean checkout ships.
  const collected = ENTRIES.filter(entry => /-test\.js$/.test(entry.file) || entry.file.endsWith('test.js'));
  if (collected.length) {
    failures += 1;
    console.log(`CLASSIFY FAIL: run-all would collect ${collected.map(entry => entry.name).join(', ')}`);
  } else {
    console.log('OK classification (no entry matches *-test.js; run-all-tests.js never collects them)');
  }
  const paid = ENTRIES.filter(entry => entry.paid).map(entry => entry.name);
  console.log(`OK paid marking (${paid.join(', ')} require PK_WB_ALLOW_PAID_TURNS=1; the runner never triggers them implicitly)`);

  const envCheck = spawnSync(process.execPath, [path.join(REPO_ROOT, '_site', '_test', 'parallel-workbench-integration-5025-env-check.js')], {
    cwd: REPO_ROOT, stdio: 'inherit', windowsHide: true, timeout: 180000, env: checkEnv,
  });
  if (envCheck.status !== 0) failures += 1;

  console.log(failures ? `\n${failures} check(s) failed` : '\nall suite files pass syntax + dependency closure + tracked, and the offline env self-check passes');
  return failures ? 1 : 0;
}

// The read-only discovery THIS runner performs with the real environment,
// before building the child's whitelist env. Mirrors the launcher's own
// discovery so a direct probe launch and a runner launch behave identically.
function runnerDiscovery() {
  const captured = {};
  const chrome = spawnSync(process.execPath, ['-e', `console.log(require(${JSON.stringify(path.join(REPO_ROOT, '_site', '_test', 'helpers', 'find-chrome'))}).findChromeDetailed().path || '')`], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
  if (chrome.status === 0) {
    const found = String(chrome.stdout || '').trim();
    if (found) captured.chrome = found;
  }
  const probe = spawnSync(process.execPath, ['-e', `
    const fixture = require(${JSON.stringify(path.join(REPO_ROOT, '_site', '_test', 'helpers', 'parallel-workbench-integration-5025-fixture.js'))});
    const sourceMap = require(${JSON.stringify(path.join(REPO_ROOT, '_site', '_test', 'helpers', 'parallel-workbench-source-map.js'))});
    console.log(JSON.stringify({ moduleRoot: fixture.resolveHostModuleRoot(), installedProductPackage: sourceMap.resolveInstalledProductPackage() }));
  `], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
  if (probe.status === 0) {
    try {
      const found = JSON.parse(String(probe.stdout || '').trim().split(/\r?\n/).pop());
      if (found.moduleRoot) captured.moduleRoot = found.moduleRoot;
      if (found.installedProductPackage) captured.installedProductPackage = found.installedProductPackage;
    } catch { /* a missing discovery surfaces as the probe's own refusal */ }
  }
  // The real profile directory is forwarded ONLY when the operator set it.
  const explicitProfile = String(process.env.PK_WB_REAL_PROFILE_DIR || '').trim();
  if (explicitProfile) captured.realProfileDir = path.resolve(explicitProfile);
  return captured;
}

function runEntry(name) {
  const entry = ENTRIES.find(candidate => candidate.name === name);
  if (!entry) fail(`unknown entry "${name}" — use --list`);
  if (entry.paid && String(process.env.PK_WB_ALLOW_PAID_TURNS || '') !== '1') {
    fail(`the "${name}" entry spends real paid model turns; set PK_WB_ALLOW_PAID_TURNS=1 explicitly first`);
  }
  if (entry.paid && !String(process.env.PK_WB_REAL_PROFILE_DIR || '').trim()) {
    fail(`the "${name}" entry reads the original subscription profile read-only; pass an explicit PK_WB_REAL_PROFILE_DIR (the runner never auto-discovers it)`);
  }
  const captures = runnerDiscovery();
  const { buildRunnerChildEnv } = require(LAUNCHER);
  const env = buildRunnerChildEnv(process.env, captures);
  if (entry.paid && !String(env.PARALLEL_WORKBENCH_RUNTIME_EVIDENCE || '').trim()) {
    fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
    env.PARALLEL_WORKBENCH_RUNTIME_EVIDENCE = path.join(EVIDENCE_DIR, `${entry.name}-probe.json`);
  }
  console.log(`running ${entry.name} (${entry.caseId}, ${entry.paid ? 'PAID (real network to the provider)' : 'free'}) → ${entry.file}`);
  console.log(`runner env: whitelist passthrough + captures (chrome=${captures.chrome ? 'resolved' : 'n/a'}, moduleRoot=${captures.moduleRoot ? 'resolved' : 'MISSING'}, installed=${captures.installedProductPackage ? 'resolved' : 'n/a'}, realProfile=${captures.realProfileDir ? 'authorized explicit' : 'none'})`);
  const child = spawnSync(process.execPath, [path.join(REPO_ROOT, entry.file)], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    env,
    timeout: Number(process.env.PK_WB_RUNNER_TIMEOUT_MS || 0) || undefined,
  });
  const code = child.status === null ? (child.signal ? 4 : 1) : child.status;
  console.log(`entry ${entry.name} exited with code ${code}`);
  return code;
}

const args = process.argv.slice(2);
if (args[0] === '--check') process.exit(checkSuite());
if (args[0] === '--run') process.exit(runEntry(args[1]));
process.exit(listEntries());
