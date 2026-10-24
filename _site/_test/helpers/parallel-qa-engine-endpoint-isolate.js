'use strict';
// _site/_test/helpers/parallel-qa-engine-endpoint-isolate.js — P-QA-ENGINE-ENDPOINT-FIX-R5
//
// Driver/child environment isolation for the engine-endpoint lane. Applied as
// the FIRST action of a test's main phase, BEFORE any product module is
// required: this process's environment is wiped and rebuilt from an explicit
// case-insensitive SYSTEM whitelist (provider keys, NODE_OPTIONS, proxy URLs
// and CLI injection vars are dropped by construction), then the complete
// isolation map below points every product surface at one per-run layout:
//   HOME/USERPROFILE/HOMEDRIVE/HOMEPATH, CODEX_HOME, CLAUDE_CONFIG_DIR,
//   APPDATA, LOCALAPPDATA, TEMP/TMP/TMPDIR, PSModuleAnalysisCachePath,
//   KB_DATA_DIR, KB_KNOWLEDGE_DATA_DIR, AI_CODING_EVENT_BRIDGE_HOME,
//   AGENT_TERMINAL_DATA_DIR, CLAUDE_AI_WORKBENCH_DATA_DIR,
//   KB_MODULES_AUTOSTART='0', and dead-zero module URLs so no ambient module
//   address survives. Every env-pointed directory is MATERIALIZED and
// statSync-verified before the map is applied (not string-only checks).
//
// Chrome (when the lane needs a browser) is captured with the REAL
// environment BEFORE the wipe and carried through as KB_CHROME_PATH — the
// find-chrome helper honours it first, so post-isolation lookups cannot fall
// back to a wiped machine path. An empty default-shaped Chrome "User Data"
// scaffold is pre-created under the isolated home (Chrome >= 136 gate).
//
// Lane overrides (own fixture URLs, lane markers) are applied AFTER the
// cleanup through childEnv(extra) / the values this module returns — never
// merged before the wipe.
//
// P-QA-ENGINE-ENDPOINT-REVIEW-R6 corrections, all in one place:
//   * PSModuleAnalysisCachePath is a cache FILE PowerShell writes itself —
//     only its PARENT is materialized and the target is asserted to never be
//     a directory (R5 mkdir'd every layout value and turned it into one);
//   * the dead module URLs use port 1, not port 0: :0 is an invalid address
//     a ModulePortResolver may treat as "unset" and fall back LIVE, while :1
//     (tcpmux) is a valid, near-certainly-dead explicit port;
//   * POSIX uses short root/temp/data components and enforces a worst-case
//     socket byte budget (Chrome SingletonSocket under the isolated temp +
//     the runtime-control domain socket under the data dir; sun_path is 108
//     bytes including NUL, budgeted in UTF-8 BYTES). The budget is asserted
//     on the worst-case mkdtemp result BEFORE any filesystem write, and the
//     full lane tag lives in owner.json inside the root so short names cost
//     no post-mortem ownership. Windows keeps the descriptive R5 names.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const PROTECTED_PORTS = new Set([5757, 5760, 5789, 5790, 8787, 8790]);

// Captured at module load, before any isolation rebuilds the environment.
const LIVE_HOME = process.env.USERPROFILE || process.env.HOME || os.homedir();
const IS_POSIX = process.platform !== 'win32';

// POSIX socket budget (mirrors the R9 Nav helper constants — physical limits,
// not tunables): sun_path is 108 bytes including the NUL terminator, so 107
// chars is the hard ceiling, and Chrome's SingletonSocket suffix rand is
// observed at ~6 chars but budgeted at 12.
const POSIX_SOCKET_CHAR_LIMIT = 107;
const CHROME_RAND_MAX_CHARS = 12;
const POSIX_TEMP_NAME = 't';
const POSIX_DATA_NAME = 'data';

/** Worst-case POSIX socket paths this layout must be able to host. */
function worstCaseSocketPaths(root) {
  const base = String(root).replaceAll('\\', '/').replace(/\/+$/, '');
  return {
    chromeSingletonSocket: `${base}/${POSIX_TEMP_NAME}/com.google.Chrome.${'x'.repeat(CHROME_RAND_MAX_CHARS)}/SingletonSocket`,
    productRuntimeControlSock: `${base}/${POSIX_DATA_NAME}/runtime-control.sock`,
  };
}

function socketBudgetVerdict(root, limit = POSIX_SOCKET_CHAR_LIMIT) {
  const paths = worstCaseSocketPaths(root);
  const chromeSocketBytes = Buffer.byteLength(paths.chromeSingletonSocket, 'utf8');
  const controlSocketBytes = Buffer.byteLength(paths.productRuntimeControlSock, 'utf8');
  return { ok: chromeSocketBytes <= limit && controlSocketBytes <= limit, limit, chromeSocketBytes, controlSocketBytes, paths };
}

/** Fail fast — with the computed path in the message — when the budget cannot hold. */
function assertSocketBudget(root, what) {
  const verdict = socketBudgetVerdict(root);
  if (!verdict.ok) {
    throw new Error(
      `POSIX socket path budget exceeded for ${what}: worst-case Chrome SingletonSocket is ${verdict.chromeSocketBytes} UTF-8 bytes, limit is ${verdict.limit} — ${verdict.paths.chromeSingletonSocket}`,
    );
  }
  return verdict;
}

const SYSTEM_ENV_WHITELIST = [
  'SystemRoot', 'SystemDrive', 'windir', 'ComSpec', 'PATHEXT',
  'PROCESSOR_ARCHITECTURE', 'PROCESSOR_ARCHITECTURE_W6432', 'PROCESSOR_IDENTIFIER',
  'PROCESSOR_LEVEL', 'PROCESSOR_REVISION', 'NUMBER_OF_PROCESSORS',
  'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432',
  'PATH', 'TEMP', 'TMP', 'TMPDIR',
];

const PRESERVED_VARS = ['PK_TEST_TEMP_ROOT'];

function isInside(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function systemBaseEnv(source = process.env) {
  const allow = new Set(SYSTEM_ENV_WHITELIST.map(name => name.toLowerCase()));
  const base = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && allow.has(key.toLowerCase())) base[key] = value;
  }
  return base;
}

function resolveTempRoot() {
  const candidates = [process.env.PK_TEST_TEMP_ROOT, process.env.TEMP, process.env.TMP, process.env.TMPDIR];
  const chosen = candidates.find(value => value && String(value).trim());
  const root = path.resolve(chosen ? String(chosen).trim() : os.tmpdir());
  if (isInside(root, REPO_ROOT)) throw new Error(`refusing to use a temp root inside the repository: ${root}`);
  return root;
}

let applied = null;

function applyDriverIsolation({ prefix = 'pk-qa-engine-endpoint', captureChrome = false } = {}) {
  if (applied) throw new Error('applyDriverIsolation must run exactly once per process');
  // Discovery with the REAL environment, strictly before the wipe.
  let chrome = null;
  if (captureChrome) {
    const { findChromeDetailed } = require('./find-chrome');
    const detailed = findChromeDetailed();
    chrome = detailed && detailed.path ? detailed.path : null;
  }
  const tempRoot = resolveTempRoot();
  // POSIX shortens the mkdtemp prefix to 'pkq': every byte of the root is
  // spent by every socket beneath it. The suffix adds exactly 6 ASCII chars,
  // so the worst-case root is knowable BEFORE any filesystem write — a
  // configured temp that cannot host the budget is refused up front.
  const shortPrefix = IS_POSIX ? 'pkq' : `${prefix}-`;
  const mkdtempPrefix = path.join(tempRoot, shortPrefix);
  if (IS_POSIX) assertSocketBudget(`${mkdtempPrefix}xxxxxx`, `configured temp root ${tempRoot} + prefix ${shortPrefix} (checked before any filesystem write)`);
  const root = fs.mkdtempSync(mkdtempPrefix);
  if (isInside(root, REPO_ROOT)) throw new Error(`refusing to create an isolation layout inside the repository: ${root}`);
  if (IS_POSIX) {
    try {
      assertSocketBudget(root, 'created isolation root');
    } catch (error) {
      try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
      throw error;
    }
  }
  const layout = {
    root,
    home: path.join(root, 'home'),
    appData: path.join(root, 'appdata'),
    localAppData: path.join(root, 'localappdata'),
    // POSIX 't'/'data': three fewer bytes on every Chrome socket path and a
    // short runtime-control socket root; Windows keeps the descriptive names.
    temp: path.join(root, IS_POSIX ? POSIX_TEMP_NAME : 'temp'),
    codexHome: path.join(root, 'codex-home'),
    claudeConfigDir: path.join(root, 'claude-config'),
    bridgeHome: path.join(root, 'bridge-home'),
    dataDir: path.join(root, IS_POSIX ? POSIX_DATA_NAME : 'workbench-data'),
    knowledgeDataDir: path.join(root, IS_POSIX ? 'kb' : 'knowledge-data'),
  };
  for (const dir of Object.values(layout)) fs.mkdirSync(dir, { recursive: true });
  for (const dir of Object.values(layout)) {
    if (!fs.statSync(dir).isDirectory()) throw new Error(`isolation directory does not really exist on disk: ${dir}`);
  }
  // PSModuleAnalysisCachePath is a cache FILE PowerShell writes itself: only
  // the parent is materialized, and the target must never be a directory.
  layout.psModuleCacheParent = path.join(root, IS_POSIX ? 'pm' : 'ps-module-analysis-cache');
  layout.psModuleCache = path.join(layout.psModuleCacheParent, IS_POSIX ? 'm.bin' : 'AnalysisCache.bin');
  fs.mkdirSync(layout.psModuleCacheParent, { recursive: true });
  if (!fs.statSync(layout.psModuleCacheParent).isDirectory()) throw new Error(`PS cache parent does not really exist on disk: ${layout.psModuleCacheParent}`);
  if (fs.existsSync(layout.psModuleCache) && fs.statSync(layout.psModuleCache).isDirectory()) {
    throw new Error(`PSModuleAnalysisCachePath target must be a file path, never a directory: ${layout.psModuleCache}`);
  }
  // Short POSIX component names must cost no post-mortem ownership: the full
  // lane tag, pid and creation time stay on disk inside the root.
  const owner = {
    schema: 'qa-autopilot/engine-endpoint-isolation-owner/v1',
    tag: prefix,
    platform: process.platform,
    pid: process.pid,
    createdAt: new Date().toISOString(),
    tempRoot,
  };
  fs.writeFileSync(path.join(root, 'owner.json'), JSON.stringify(owner, null, 2) + '\n', 'utf8');
  // Chrome >= 136 refuses --remote-debugging-port unless it can resolve its
  // DEFAULT user data dir under the home it sees. Empty default-shaped
  // scaffold, entirely inside the isolated root.
  fs.mkdirSync(path.join(layout.home, 'AppData', 'Local', 'Google', 'Chrome', 'User Data'), { recursive: true });
  fs.mkdirSync(path.join(layout.home, 'AppData', 'Roaming'), { recursive: true });

  const parsed = path.parse(layout.home);
  const envMap = {
    HOME: layout.home,
    USERPROFILE: layout.home,
    HOMEDRIVE: parsed.root,
    HOMEPATH: parsed.root === path.sep ? layout.home.slice(1) : layout.home.slice(parsed.root.length),
    CODEX_HOME: layout.codexHome,
    CLAUDE_CONFIG_DIR: layout.claudeConfigDir,
    APPDATA: layout.appData,
    LOCALAPPDATA: layout.localAppData,
    TEMP: layout.temp,
    TMP: layout.temp,
    TMPDIR: layout.temp,
    PSModuleAnalysisCachePath: layout.psModuleCache,
    KB_DATA_DIR: layout.dataDir,
    KB_KNOWLEDGE_DATA_DIR: layout.knowledgeDataDir,
    AI_CODING_EVENT_BRIDGE_HOME: layout.bridgeHome,
    AGENT_TERMINAL_DATA_DIR: layout.dataDir,
    CLAUDE_AI_WORKBENCH_DATA_DIR: layout.dataDir,
    KB_MODULES_AUTOSTART: '0',
    // Valid-but-dead explicit ports (R6): :0 is an invalid address a port
    // resolver may treat as unset and fall back LIVE; :1 never runs these
    // modules and remains a well-formed URL. Caller-owned actual URLs passed
    // to childEnv() still win.
    KB_TERMINAL_URL: 'http://127.0.0.1:1',
    KB_VECTORHUB_URL: 'http://127.0.0.1:1',
    KB_EVENTBRIDGE_URL: 'http://127.0.0.1:1',
    KB_KNOWLEDGE_ENGINE_URL: 'http://127.0.0.1:1',
  };
  const preserved = systemBaseEnv(process.env);
  for (const key of PRESERVED_VARS) {
    if (process.env[key] !== undefined) preserved[key] = process.env[key];
  }
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, preserved, envMap);
  if (chrome) process.env.KB_CHROME_PATH = chrome;
  applied = { layout, envMap, chrome, tempRoot, owner };
  return applied;
}

// The environment an own child (product server, git helper) may inherit from
// an already-isolated driver: the whitelisted+isolated env plus the caller's
// EXPLICIT lane values, which win.
function childEnv(extra = {}) {
  if (!applied) throw new Error('applyDriverIsolation must run before childEnv');
  return { ...systemBaseEnv(process.env), ...applied.envMap, ...extra };
}

module.exports = {
  PROTECTED_PORTS,
  SYSTEM_ENV_WHITELIST,
  applyDriverIsolation,
  childEnv,
  systemBaseEnv,
  isInside,
  LIVE_HOME,
  IS_POSIX,
  POSIX_SOCKET_CHAR_LIMIT,
  CHROME_RAND_MAX_CHARS,
  worstCaseSocketPaths,
  socketBudgetVerdict,
  assertSocketBudget,
};
