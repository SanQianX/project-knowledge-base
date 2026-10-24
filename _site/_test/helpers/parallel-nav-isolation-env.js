// _site/_test/helpers/parallel-nav-isolation-env.js
//
// P-NAV-VECTOR-ISOLATION-R7: the driver-level environment whitelist for the
// NAV lane harness. The incident this exists for: parallel-nav-shell.js used
// to create the real engine WITHOUT an explicit vectorUrl, so the engine kept
// its constructor default (http://127.0.0.1:8787 = the developer's LIVE
// desktop vector-hub) and NAV-007's core-source-regression run wrote a real
// collection there (2026-10-23T18:00:54Z; recovered by
// P-VECTOR-INCIDENT-RECOVERY-R6). Driving full-env directory variables from a
// test is NOT enough to override constructor defaults, so the harness now
// (a) passes an explicit vectorUrl (see parallel-nav-shell.js) and (b) puts
// the whole driver — and every child that inherits process.env — under the
// explicit whitelist below.
//
// Contract (call order matters, enforced by the harness):
//   1. the harness resolves Chrome under the REAL environment first
//      (read-only discovery);
//   2. enterNavIsolation() builds the whitelist environment and mutates
//      process.env — BEFORE any engine/product module is loaded or any child
//      is spawned;
//   3. restore() puts the original values back after cleanup, and the stable
//      parent temp root SURVIVES serial harness runs in one process (only the
//      process-exit hook removes it), so a later os.tmpdir() never points at
//      a deleted directory.
//
// The whitelist keeps only OS-critical variables; every directory the product
// family consults (HOME/USERPROFILE/HOMEDRIVE+HOMEPATH/CODEX_HOME/
// CLAUDE_CONFIG_DIR/APPDATA/LOCALAPPDATA/TEMP/TMP/TMPDIR/KB_DATA_DIR/
// KB_KNOWLEDGE_DATA_DIR/AI_CODING_EVENT_BRIDGE_HOME/AGENT_TERMINAL_DATA_DIR/
// CLAUDE_AI_WORKBENCH_DATA_DIR/PSModuleAnalysisCachePath) points into one
// short repo-external fixture root, and the Chrome default-profile shape
// (<isolated USERPROFILE>/AppData/Local/Google/Chrome/User Data) is created
// so Chrome's own default paths resolve inside isolation. Ambient module
// URLs, model-provider credentials, proxy variables and CLI-injection
// variables are deleted; the harness adds its explicit lane endpoints only
// AFTER the whitelist is in place.
//
// P-NAV-POSIX-CI-R9: on POSIX the fixture path length is a hard correctness
// constraint, not cosmetics. Chrome places its SingletonSocket under TMPDIR
// (<root>/com.google.Chrome.<rand>/SingletonSocket) and the product's
// runtime-control channel lives at <dataDir>/runtime-control.sock
// (_site/lib/runtime-control.js) — both are UNIX domain sockets bound by the
// 108-byte sun_path limit. The descriptive R7 component names
// (pk-nav-r7-<pid>-<rand>/<full-tag>-<rand>) blew that budget on GH runners
// (CI 40011886791: a 120-char SingletonSocket aborted Chrome with SIGABRT
// and starved product bootstrap). POSIX now uses short components (pkn…/n…/t
// layout), keeps the full tag in an on-disk owner.json, prefers the external
// configured temp root when one is available, and fails fast when the
// worst-case socket path would exceed the budget. The real-home leak scan is
// also placement-aware: on hosted runners the owned temp root legitimately
// lives UNDER the real home (/home/runner/work/_temp), so a value is a leak
// only when it is outside the owned root while still referencing the real
// home (canonical containment), never merely because of a shared prefix.

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Captured at module load, before any isolation changes the environment.
const REAL_HOME = os.homedir();
const REAL_USERPROFILE = process.env.USERPROFILE || REAL_HOME;
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

/** OS-critical variables a Windows child may keep. Nothing else survives. */
const OS_WHITELIST = [
  'SystemRoot', 'SystemDrive', 'windir', 'ComSpec', 'PATHEXT', 'PATH',
  'OS', 'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER', 'PROCESSOR_LEVEL', 'PROCESSOR_REVISION',
  'COMPUTERNAME', 'USERNAME', 'USERDOMAIN',
  'PROGRAMDATA', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432',
  'CommonProgramFiles', 'CommonProgramFiles(x86)', 'CommonProgramW6432',
  'DriverData',
];

/** Directory variables the isolation overrides; every one lands inside the fixture root. */
const ISOLATION_KEYS = [
  'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
  'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'APPDATA', 'LOCALAPPDATA',
  'TEMP', 'TMP', 'TMPDIR',
  'KB_DATA_DIR', 'KB_KNOWLEDGE_DATA_DIR',
  'AI_CODING_EVENT_BRIDGE_HOME', 'AGENT_TERMINAL_DATA_DIR', 'CLAUDE_AI_WORKBENCH_DATA_DIR',
  'PSModuleAnalysisCachePath',
];

/** Deleted outright: ambient module URLs (incl. the engine's own env var), model-provider credentials, proxies, CLI injection. */
const AMBIENT_DELETES = [
  'KB_KNOWLEDGE_ENGINE_URL', 'KB_VECTORHUB_URL', 'KB_TERMINAL_URL', 'KB_EVENTBRIDGE_URL',
  'KB_EVENT_BRIDGE_URL', 'KB_VECTOR_HUB_URL', 'KB_WORKBENCH_RUNTIME_TOKEN', 'KB_MODULES_REGISTER',
  'KB_CHROME_PATH',
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_THINKING_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'API_TIMEOUT_MS',
  'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT', 'CLAUDECODE',
  'MINIMAX_API_KEY', 'MINIMAX_BASE_URL', 'MINIMAX_MODEL',
  'OPENAI_API_KEY', 'OPENAI_BASE_URL',
  'NODE_OPTIONS', 'NODE_PATH', 'NODE_PRELOAD',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
  'PSModulePath',
];

function isInside(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

// Windows environment names arrive case-preserved (git-bash exports
// SYSTEMROOT while cmd exports SystemRoot); membership must not depend on
// the caller's casing.
const upper = value => String(value).toUpperCase();
const OS_WHITELIST_UPPER = () => new Set(OS_WHITELIST.map(upper));
const isOsWhitelisted = key => OS_WHITELIST_UPPER().has(upper(key));

/**
 * A short repo-external temp root (same convention as the R5 lane). The
 * fallback chain is resolved from values captured at MODULE LOAD — a poisoned
 * or later-mutated process.env.TEMP must not steer the run root into the real
 * home (the negative case proves exactly this).
 */
const LOADED_TEMP_ROOT = (process.env.PK_TEST_TEMP_ROOT || process.env.TEMP || process.env.TMP || os.tmpdir());

// R9 POSIX socket budget: sun_path is 108 bytes including the NUL terminator,
// so 107 characters is the hard ceiling. The worst-case consumer is Chrome's
// SingletonSocket under the isolated TMPDIR; the suffix rand is observed at
// ~6 chars but budgeted at 12, and the budget counts UTF-8 BYTES, not chars.
const POSIX_SOCKET_CHAR_LIMIT = 107;
const CHROME_RAND_MAX_CHARS = 12;

/** Worst-case POSIX socket paths the fixture root must be able to host. */
function worstCasePosixSocketPaths(root) {
  const base = String(root).replaceAll('\\', '/').replace(/\/+$/, '');
  return {
    chromeSingletonSocket: `${base}/t/com.google.Chrome.${'x'.repeat(CHROME_RAND_MAX_CHARS)}/SingletonSocket`,
    productRuntimeControlSock: `${base}/data/runtime-control.sock`,
  };
}

function posixSocketBudgetVerdict(root, limit = POSIX_SOCKET_CHAR_LIMIT) {
  const paths = worstCasePosixSocketPaths(root);
  const chromeSocketBytes = Buffer.byteLength(paths.chromeSingletonSocket, 'utf8');
  const controlSocketBytes = Buffer.byteLength(paths.productRuntimeControlSock, 'utf8');
  return {
    ok: chromeSocketBytes <= limit && controlSocketBytes <= limit,
    limit, chromeSocketBytes, controlSocketBytes, paths,
  };
}

/** Fail fast — with the computed path in the message — when the budget cannot hold. */
function assertPosixSocketBudget(root, what) {
  const verdict = posixSocketBudgetVerdict(root);
  if (!verdict.ok) {
    throw new Error(
      `POSIX socket path budget exceeded for ${what}: worst-case Chrome SingletonSocket is ${verdict.chromeSocketBytes} UTF-8 bytes, limit is ${verdict.limit} — ${verdict.paths.chromeSingletonSocket}`,
    );
  }
  return verdict;
}

const IS_POSIX = process.platform !== 'win32';

function resolveNavTempRoot() {
  const sharedRoot = path.join(path.dirname(REPO_ROOT), '.project-knowledge-test-temp');
  // Windows keeps the R7 order (shared sibling root first). POSIX prefers the
  // external configured temp (PK_TEST_TEMP_ROOT, then the OS temp captured at
  // module load) over the long sibling shared root: every byte of the root is
  // spent by every socket beneath it (R9).
  const candidates = IS_POSIX
    ? [
      LOADED_TEMP_ROOT === process.env.PK_TEST_TEMP_ROOT ? LOADED_TEMP_ROOT : null,
      LOADED_TEMP_ROOT,
      fs.existsSync(sharedRoot) ? sharedRoot : null,
    ]
    : [
      LOADED_TEMP_ROOT === process.env.PK_TEST_TEMP_ROOT ? LOADED_TEMP_ROOT : null,
      fs.existsSync(sharedRoot) ? sharedRoot : null,
      LOADED_TEMP_ROOT,
    ];
  const chosen = candidates.find(value => value && String(value).trim());
  const root = path.resolve(String(chosen).trim());
  if (isInside(root, REPO_ROOT)) throw new Error(`refusing to use a temp root inside the repository: ${root}`);
  return root;
}

let stableRoot = null;
let exitHookArmed = false;
/** Per-process parent temp: stable across serial harness runs, removed at process exit. */
function stableTempRoot() {
  if (!stableRoot) {
    const prefix = IS_POSIX ? `pkn${process.pid.toString(36)}` : `pk-nav-r7-${process.pid}-`;
    stableRoot = fs.mkdtempSync(path.join(resolveNavTempRoot(), prefix));
    if (!exitHookArmed) {
      exitHookArmed = true;
      process.on('exit', () => { try { fs.rmSync(stableRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* best effort */ } });
    }
  }
  return stableRoot;
}

function buildLayout(root) {
  const layout = {
    home: path.join(root, 'home'),
    codexHome: path.join(root, 'codex-home'),
    claudeConfigDir: path.join(root, 'claude-config'),
    appData: path.join(root, 'appdata'),
    localAppData: path.join(root, 'localappdata'),
    // 't' on POSIX: three fewer bytes on every Chrome socket path (R9).
    temp: path.join(root, IS_POSIX ? 't' : 'temp'),
    dataDir: path.join(root, 'kb-data'),
    knowledgeDataDir: path.join(root, 'kb-knowledge-data'),
    bridgeHome: path.join(root, 'bridge-home'),
    agentTerminalDataDir: path.join(root, 'agent-terminal'),
    workbenchDataDir: path.join(root, 'workbench-data'),
  };
  for (const dir of Object.values(layout)) fs.mkdirSync(dir, { recursive: true });
  // Chrome's default-profile shape under the isolated USERPROFILE: Chrome
  // resolves it even when launched with an explicit --user-data-dir, and no
  // Node/GUI child keeps the real USERPROFILE.
  layout.chromeDefaultProfileDir = path.join(layout.home, 'AppData', 'Local', 'Google', 'Chrome', 'User Data');
  fs.mkdirSync(layout.chromeDefaultProfileDir, { recursive: true });
  layout.psCachePath = path.join(root, 'ps-module-analysis-cache.bin');
  return layout;
}

function isolationEnvMap(layout) {
  const parsed = path.parse(layout.home);
  return {
    HOME: layout.home,
    USERPROFILE: layout.home,
    HOMEDRIVE: parsed.root,
    HOMEPATH: layout.home.slice(parsed.root.length),
    CODEX_HOME: layout.codexHome,
    CLAUDE_CONFIG_DIR: layout.claudeConfigDir,
    APPDATA: layout.appData,
    LOCALAPPDATA: layout.localAppData,
    TEMP: layout.temp,
    TMP: layout.temp,
    TMPDIR: layout.temp,
    KB_DATA_DIR: layout.dataDir,
    KB_KNOWLEDGE_DATA_DIR: layout.knowledgeDataDir,
    AI_CODING_EVENT_BRIDGE_HOME: layout.bridgeHome,
    AGENT_TERMINAL_DATA_DIR: layout.agentTerminalDataDir,
    CLAUDE_AI_WORKBENCH_DATA_DIR: layout.workbenchDataDir,
    KB_MODULES_AUTOSTART: '0',
    PSModuleAnalysisCachePath: layout.psCachePath,
  };
}

/**
 * Whitelist the driver environment in place. Returns the per-run isolation
 * context; the caller MUST call restore() after cleanup (serial runs reuse
 * the stable parent temp, which is only removed at process exit).
 */
function enterNavIsolation({ tag = 'run' } = {}) {
  // POSIX shortens the case component to 'n<rand6>' (R9 socket budget);
  // Windows keeps the descriptive '<tag>-<rand6>' names.
  const casePrefix = IS_POSIX ? 'n' : `${tag}-`;
  const root = fs.mkdtempSync(path.join(stableTempRoot(), casePrefix));
  if (IS_POSIX) {
    try {
      assertPosixSocketBudget(root, `isolation root for tag ${tag}`);
    } catch (error) {
      try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
      throw error;
    }
  }
  const layout = buildLayout(root);

  // The shortened POSIX component names must not cost post-mortem ownership
  // binding anything: the full tag, pid and creation time stay on disk.
  fs.writeFileSync(path.join(root, 'owner.json'), JSON.stringify({
    schema: 'qa-autopilot/nav-isolation-owner/v1',
    tag,
    platform: process.platform,
    pid: process.pid,
    createdAt: new Date().toISOString(),
  }, null, 2) + '\n', 'utf8');

  const previous = {};
  for (const key of Object.keys(process.env)) previous[key] = process.env[key];

  // R9 redirection evidence (booleans only — original values may carry real
  // secrets): which isolation keys pointed at the real home BEFORE the
  // whitelist, so the report can prove every one was redirected into the
  // owned root rather than merely overwritten with another leak.
  const originalInsideRealHome = {};
  for (const key of ISOLATION_KEYS) {
    const original = previous[key];
    originalInsideRealHome[key] = original !== undefined
      && (isInside(path.resolve(String(original)), REAL_HOME) || isInside(path.resolve(String(original)), REAL_USERPROFILE));
  }

  for (const key of Object.keys(process.env)) {
    if (!isOsWhitelisted(key)) delete process.env[key];
  }
  Object.assign(process.env, isolationEnvMap(layout));

  return {
    tag, root, layout,
    posixShortRoot: IS_POSIX,
    originalInsideRealHome,
    envMap: isolationEnvMap(layout),
    realHome: REAL_HOME,
    realUserProfile: REAL_USERPROFILE,
    /** Put the original environment back; keeps the stable parent temp alive. */
    restore() {
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, previous);
    },
  };
}

/**
 * Placement-aware real-home scan (R9). A non-OS-whitelisted env value is a
 * leak ONLY when it references the real home while NOT being canonically
 * inside the owned isolation root: on hosted runners the owned temp root
 * legitimately lives UNDER the real home (/home/runner/work/_temp), and that
 * placement must not fail the scan. Canonical containment decides; a raw
 * substring match outside the owned root still flags (values that merely
 * mention the real home are suspect even when not resolvable paths).
 */
function realHomeReferenceKeys(env, { root = null, realHome = REAL_HOME, realUserProfile = REAL_USERPROFILE } = {}) {
  return Object.entries(env)
    .filter(([key]) => !isOsWhitelisted(key))
    .filter(([, value]) => {
      const text = String(value);
      if (root && isInside(path.resolve(text), root)) return false;
      return text.includes(realHome) || text.includes(realUserProfile)
        || isInside(path.resolve(text), realHome) || isInside(path.resolve(text), realUserProfile);
    })
    .map(([key]) => key);
}

/**
 * The isolation invariants, as one assertable record. `env` defaults to the
 * live process environment, so a harness or a negative case can prove the
 * whitelist property at any moment.
 */
function navIsolationReport(env = process.env, isolation = null) {
  const layout = isolation ? isolation.layout : null;
  const root = isolation ? isolation.root : null;
  const findings = {
    isolationKeys: Object.fromEntries(ISOLATION_KEYS.map(key => [key, env[key] ?? null])),
    allIsolationKeysInsideRoot: layout
      ? ISOLATION_KEYS.filter(key => key !== 'HOMEDRIVE' && key !== 'HOMEPATH').every(key => env[key] && isInside(path.resolve(env[key]), root))
      : null,
    ambientDeleted: Object.fromEntries([...AMBIENT_DELETES, 'KB_MODULES_AUTOSTART'].map(key => [key, Object.keys(env).some(name => upper(name) === upper(key))])),
    noAmbientSurvives: [...AMBIENT_DELETES].every(key => !Object.keys(env).some(name => upper(name) === upper(key))),
    osWhitelistHeld: Object.keys(env).filter(key => !isOsWhitelisted(key) && !ISOLATION_KEYS.includes(key) && key !== 'KB_MODULES_AUTOSTART'),
    // Real-home references are tolerated ONLY inside the OS allowlist (the
    // real PATH names real tool locations) or, since R9, inside the owned
    // isolation root itself (hosted runners place RUNNER_TEMP under the real
    // home — placement, not identity); every other variable must be free of
    // them. See realHomeReferenceKeys for the canonical rule.
    referencesRealHome: realHomeReferenceKeys(env, { root }),
    // Keys that pointed at the real home before the whitelist and have NOT
    // been redirected into the owned root (empty list = redirection proven).
    redirectionFailures: layout && isolation && isolation.originalInsideRealHome
      ? Object.entries(isolation.originalInsideRealHome)
        .filter(([, wasReal]) => wasReal)
        .filter(([key]) => !(env[key] && isInside(path.resolve(String(env[key])), root)))
        .map(([key]) => key)
      : null,
    posixSocketBudget: root ? posixSocketBudgetVerdict(root) : null,
    chromeDefaultProfileDirExists: layout ? fs.existsSync(layout.chromeDefaultProfileDir) : null,
    psCacheParentExists: layout ? fs.existsSync(path.dirname(layout.psCachePath)) : null,
  };
  if (root) findings.stableRootExists = fs.existsSync(path.dirname(root));
  return findings;
}

module.exports = {
  enterNavIsolation, navIsolationReport, isolationEnvMap, realHomeReferenceKeys,
  OS_WHITELIST, ISOLATION_KEYS, AMBIENT_DELETES,
  REAL_HOME, REAL_USERPROFILE, resolveNavTempRoot,
  worstCasePosixSocketPaths, posixSocketBudgetVerdict, assertPosixSocketBudget,
  POSIX_SOCKET_CHAR_LIMIT, CHROME_RAND_MAX_CHARS,
};
