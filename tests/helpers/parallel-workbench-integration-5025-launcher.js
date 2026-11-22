'use strict';
// P-WB-CANONICAL-R2 launcher — the single safe entry discipline for every
// integration-5025 probe (model / ordering / abort / drafts). The accepted
// canonical suite isolated only the CHILD processes; the probe driver itself
// still ran on the developer's environment, and the model probe built its
// child env from the pre-R5 fixture whose whitelist lacked APPDATA,
// LOCALAPPDATA and CODEX_HOME. This launcher closes that:
//
//   boot(options) — called as the FIRST statement of a probe's main phase —
//     1. GATES FIRST, before any environment mutation: a paid entry refuses
//        without PK_WB_ALLOW_PAID_TURNS=1; an entry that reads the original
//        subscription profile refuses without an EXPLICIT
//        PK_WB_REAL_PROFILE_DIR. By default nothing about the real profile is
//        ever resolved, read or digested.
//     2. READ-ONLY DISCOVERY with the real environment (or the explicit
//        captures a safe runner passed in): Chrome, the module root to host,
//        the installed-product package, and — only when authorized — the real
//        profile directory. Discovery happens BEFORE any isolation rewrite.
//     3. FULL DRIVER ISOLATION BY WHITELIST REBUILD (R3): this process's env is
//        wiped and rebuilt from the fixture's explicit SYSTEM whitelist
//        (case-insensitive), the documented PK_* contract variables, and the
//        complete canonical isolation map (incl. APPDATA/LOCALAPPDATA/
//        CODEX_HOME, PSModuleAnalysisCachePath, and the Chrome>=136 default-dir
//        scaffold). Ambient provider credentials (OPENAI/MINIMAX/…),
//        NODE_OPTIONS, proxy URLs and CLI injection vars are dropped by
//        construction — never inherited by the driver or any descendant (host
//        via hostEnv, Chrome by env inheritance, CLI runtimes and census
//        helpers below the host).
//     4. CARRY-THROUGH: the pre-isolation captures are re-injected as
//        explicit absolute overrides (PK_WB_MODULE_ROOT /
//        PK_WB_INSTALLED_PRODUCT_MODULE / PK_WB_CHROME / and the authorized
//        PK_WB_REAL_PROFILE_DIR), so nothing is ever re-discovered from the
//        isolated environment. In particular the installed-product identity
//        label keeps resolving to the AppData install captured BEFORE the
//        switch — an isolated APPDATA can no longer mislabel an AppData-hosted
//        module as "repository-pin".
//
// The real-profile digest helpers (in-memory SHA256 before/after comparison,
// digests never leave the process) live HERE, in the authorized layer — the
// canonical fixture itself stays free of any real-profile machinery.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const fixture = require('./parallel-workbench-integration-5025-fixture');
const sourceMap = require('./parallel-workbench-source-map');
const { findChromeDetailed } = require('./find-chrome');

function refuse(message) {
  const error = new Error(message);
  error.code = 'PK_WB_BOOT_REFUSED';
  return error;
}

// --- pre-isolation, read-only discovery --------------------------------------
//
// Every resolver honours an explicit override first, so the SAME code path is
// safe both for a direct probe launch (real environment present) and for a
// runner that performed the discovery itself and passed only captures.
function resolveChromeOnce() {
  const captured = String(process.env.PK_WB_CHROME || '').trim();
  if (captured) return path.resolve(captured);
  const detailed = findChromeDetailed();
  return detailed && detailed.path ? detailed.path : null;
}

function discoverWithRealEnvironment(options = {}) {
  const explicitProfileDir = String(process.env.PK_WB_REAL_PROFILE_DIR || '').trim();
  return {
    chrome: options.chrome !== undefined ? options.chrome : resolveChromeOnce(),
    moduleRoot: fixture.resolveHostModuleRoot(options.moduleRoot ? { moduleRoot: options.moduleRoot } : {}),
    installedProductPackage: sourceMap.resolveInstalledProductPackage(),
    // The real profile directory is only ever resolved from an EXPLICIT
    // authorized path — never auto-discovered from the real home.
    realProfileDir: explicitProfileDir ? path.resolve(explicitProfileDir) : null,
    realHome: fixture.REAL_HOME,
    realAppData: process.env.APPDATA || null,
    discoveredAt: new Date().toISOString(),
  };
}

// --- the boot discipline ------------------------------------------------------
//
// Returns { layout, envApplied, discovery }. Throws (code PK_WB_BOOT_REFUSED)
// for any unsafe launch; a probe exits non-zero on refusal without having
// touched anything.

// The documented contract variables that survive the driver env wipe: the
// operator's own explicit settings (timeouts, model selection, evidence target,
// acknowledgements), never ambient machine state.
const BOOT_PRESERVED_VARS = [
  'PK_TEST_TEMP_ROOT',
  'PK_WB_ALLOW_PAID_TURNS',
  'PK_WB_EXPECTED_VERSION',
  'PK_WB_MODEL_PROFILE',
  'PK_WB_MODEL_ID',
  'PK_WB_TURN_TIMEOUT_MS',
  'PK_WB_INTEGRATION_5025_TIMEOUT_MS',
  'PARALLEL_WORKBENCH_RUNTIME_EVIDENCE',
  'PK_WB_SAFE_LAUNCH',
];
function boot(options = {}) {
  const paid = options.paid === true;
  const needsRealProfile = options.needsRealProfile === true;
  if (paid && String(process.env.PK_WB_ALLOW_PAID_TURNS || '') !== '1') {
    throw refuse('this entry spends real paid model turns; set PK_WB_ALLOW_PAID_TURNS=1 explicitly first (unsafe direct launch refused)');
  }
  if (needsRealProfile && !String(process.env.PK_WB_REAL_PROFILE_DIR || '').trim()) {
    throw refuse('this entry reads the original subscription profile read-only behind the in-memory facade; that requires the paid acknowledgement AND an explicit PK_WB_REAL_PROFILE_DIR path — refusing to auto-discover or read the real profile by default');
  }
  if (paid && needsRealProfile && !fs.existsSync(String(process.env.PK_WB_REAL_PROFILE_DIR || ''))) {
    throw refuse(`the authorized PK_WB_REAL_PROFILE_DIR does not exist: ${process.env.PK_WB_REAL_PROFILE_DIR}`);
  }

  const discovery = discoverWithRealEnvironment(options);
  if (!discovery.moduleRoot) {
    throw refuse('no claude-ai-workbench module copy was found to host (discovery ran before any isolation)');
  }
  if (options.requireChrome !== false && !discovery.chrome) {
    throw refuse('no real Chrome was found (discovery ran before any isolation)');
  }

  const layout = fixture.createIsolationLayout(options.prefix || 'parallel-wb-integration-5025');
  const envApplied = fixture.isolationEnvMap(layout);
  // FULL DRIVER ISOLATION BY WHITELIST REBUILD (R3), not blacklisting: this
  // process's env is wiped and rebuilt from the fixture's explicit SYSTEM
  // whitelist (case-insensitive), plus the documented PK_* contract variables
  // the operator may have set, plus the complete isolation map. Provider
  // credentials (OPENAI/MINIMAX/GOOGLE/AWS/ANTHROPIC…), NODE_OPTIONS, proxy
  // URLs and CODEX/Claude CLI injection vars are dropped by construction. The
  // credential an authorized paid entry needs is never inherited from ambient
  // — only the server-side read-only in-memory facade over the explicit
  // profile path constructs it, below the host.
  const preserved = fixture.systemBaseEnv(process.env);
  for (const key of BOOT_PRESERVED_VARS) {
    if (process.env[key] !== undefined) preserved[key] = process.env[key];
  }
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, preserved, envApplied);
  // Carry the pre-isolation captures through as explicit absolute overrides.
  process.env.PK_WB_MODULE_ROOT = discovery.moduleRoot;
  if (discovery.installedProductPackage) process.env.PK_WB_INSTALLED_PRODUCT_MODULE = discovery.installedProductPackage;
  if (discovery.chrome) process.env.PK_WB_CHROME = discovery.chrome;
  if (discovery.realProfileDir) process.env.PK_WB_REAL_PROFILE_DIR = discovery.realProfileDir;
  return { layout, envApplied, discovery };
}

// --- the authorized real-profile digest layer --------------------------------
//
// Byte-level snapshot of a flat directory. The SHA256 digests stay in process
// memory: only counts and file NAMES ever leave compareDigests, so a digest of
// a credential file is never printed, logged or persisted. No file is ever
// copied, moved or written.
function digestDirectory(dir) {
  if (!dir || !fs.existsSync(dir)) return null;
  const entries = {};
  for (const name of fs.readdirSync(dir)) {
    try {
      const file = path.join(dir, name);
      if (!fs.statSync(file).isFile()) continue;
      entries[name] = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    } catch { entries[name] = null; }
  }
  return entries;
}

function compareDigests(before, after) {
  const names = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  const changed = [];
  const added = [];
  const removed = [];
  const unreadable = [];
  for (const name of names) {
    const a = before ? before[name] : undefined;
    const b = after ? after[name] : undefined;
    if (a === undefined && b !== undefined) added.push(name);
    else if (a !== undefined && b === undefined) removed.push(name);
    else if (a === null || b === null) unreadable.push(name);
    else if (a !== b) changed.push(name);
  }
  return {
    count: names.size,
    byteIdentical: changed.length === 0 && added.length === 0 && removed.length === 0 && unreadable.length === 0,
    changedFiles: changed,
    addedFiles: added,
    removedFiles: removed,
    unreadableFiles: unreadable,
  };
}

// --- the safe runner's child environment -------------------------------------
//
// The canonical runner must NOT hand a probe the developer's shell. It
// performs the discovery itself (real environment, read-only), then builds the
// child env from this whitelist: the Windows essentials a node child and its
// census helpers need (PATH for git/powershell, SystemRoot for crypto), the
// TEMP fallbacks the portable temp-root resolution may consult before boot
// replaces them, the documented PK_* contract variables, and the captured
// discovery results as explicit absolute overrides. Nothing else survives.
const RUNNER_ENV_PASSTHROUGH = [
  'SystemRoot', 'SystemDrive', 'windir', 'ComSpec', 'PATHEXT',
  'PROCESSOR_ARCHITECTURE', 'PROCESSOR_ARCHITECTURE_W6432', 'NUMBER_OF_PROCESSORS',
  'PATH', 'TEMP', 'TMP', 'TMPDIR',
  'PK_TEST_TEMP_ROOT',
  'PK_WB_ALLOW_PAID_TURNS',
  'PK_WB_EXPECTED_VERSION',
  'PK_WB_MODEL_PROFILE',
  'PK_WB_MODEL_ID',
  'PK_WB_TURN_TIMEOUT_MS',
  'PK_WB_INTEGRATION_5025_TIMEOUT_MS',
  'PARALLEL_WORKBENCH_RUNTIME_EVIDENCE',
];

function buildRunnerChildEnv(sourceEnv, captures = {}) {
  // Case-insensitive membership (Windows: Path/PATH, SystemRoot/SYSTEMROOT are
  // the same variable; a case-variant credential or NODE_OPTIONS must NOT slip
  // through an exact-case match).
  const allow = new Set(RUNNER_ENV_PASSTHROUGH.map(name => name.toLowerCase()));
  const env = {};
  for (const [key, value] of Object.entries(sourceEnv)) {
    if (value !== undefined && allow.has(key.toLowerCase())) env[key] = value;
  }
  // The runner's own read-only discovery, captured with the real environment.
  if (captures.moduleRoot) env.PK_WB_MODULE_ROOT = captures.moduleRoot;
  if (captures.installedProductPackage) env.PK_WB_INSTALLED_PRODUCT_MODULE = captures.installedProductPackage;
  if (captures.chrome) env.PK_WB_CHROME = captures.chrome;
  // The real profile directory is forwarded ONLY when the operator authorized
  // it explicitly — the runner never invents one.
  if (captures.realProfileDir) env.PK_WB_REAL_PROFILE_DIR = captures.realProfileDir;
  env.PK_WB_SAFE_LAUNCH = '1';
  return env;
}

module.exports = {
  boot,
  discoverWithRealEnvironment,
  digestDirectory,
  compareDigests,
  buildRunnerChildEnv,
  RUNNER_ENV_PASSTHROUGH,
};
