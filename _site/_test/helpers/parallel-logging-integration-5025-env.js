'use strict';
// _site/_test/helpers/parallel-logging-integration-5025-env.js
//
// Canonical, tracked isolation environment for the logging acceptance and
// logging-safety regression entries (lane P-QA-LOG-INTEGRATION-5025, extended
// by lane P-LOGGING-ISOLATION-R2).
//
// Why this helper exists
// ----------------------
// The logging entries used to hardcode one developer's temp root
// ('D:/SanQian.Xu/.project-knowledge-test-temp'). That path cannot be entered
// into a cross-platform canonical `npm test`, and it also left the entries
// running with the developer's real HOME/APPDATA/LOCALAPPDATA, so a child
// process could still reach real user configuration.
//
// P-LOGGING-ISOLATION-R2 closed the remaining gap: redirecting a few
// directories is not isolation. The ambient environment still reached the
// driver itself and, through it, every child process - provider keys and
// tokens, credential-bearing proxies, NODE_OPTIONS, module URLs/ports and
// other CLI-injected configuration were inherited verbatim. The helper now
// sanitizes the driver's own environment BEFORE any product module loads.
//
// Contract implemented here
// -------------------------
//   * browser capture first: the real Chrome executable is resolved BEFORE
//     HOME/LOCALAPPDATA move. A per-user Chrome lives under LOCALAPPDATA, so
//     redirecting it first would make findChrome() fall back to the
//     developer's real browser profile. The captured path is re-exported as
//     KB_CHROME_PATH, which find-chrome consults first.
//   * environment whitelist: only the system baseline and this tool's own
//     knobs survive. Everything else - provider keys/tokens, proxies,
//     NODE_OPTIONS, module URLs/ports, CLI-injected configuration - is
//     removed from the driver, so every child inherits the clean base.
//   * temp root: PK_TEST_TEMP_ROOT when set (must be absolute), otherwise
//     os.tmpdir(). The resolved root must live OUTSIDE the source repository
//     - a temp root inside the checkout would put test data into the tree
//     that CI packs and publishes. Violations throw; they never degrade into
//     a "test passed" state.
//   * every entry installs, BEFORE any other module is loaded, its own
//     HOME / USERPROFILE / CODEX_HOME / CLAUDE_CONFIG_DIR / APPDATA /
//     LOCALAPPDATA / TEMP / TMP / TMPDIR, its own dual product data root
//     (KB_DATA_DIR + KB_KNOWLEDGE_DATA_DIR), its own Bridge journal home and
//     its own Workbench / agent-terminal data root. The developer's real
//     configuration is never read or overwritten by a test.
//   * PSModuleAnalysisCachePath points at a FILE inside the lane tree whose
//     parent directory exists, so PowerShell (used by the browser cleanup
//     helper) cannot write its module analysis cache into the developer's
//     real profile.
//   * module endpoints are explicit and dead: the module URL keys point at
//     the loopback dead address, the module flags are '0' (the product tests
//     `=== '0'`) and the module command keys are empty strings (the product
//     tests truthiness, so '0' would be read as a configured command).
//     KB_MODULES_AUTOSTART=0 / KB_MODULES_REGISTER=0 keep the product from
//     registering or starting real modules.
//   * Chrome >= 136 refuses --remote-debugging-port unless the default user
//     data directory resolves. With HOME/APPDATA/LOCALAPPDATA redirected, the
//     platform default directory is scaffolded empty so the real browser
//     still launches. The browser itself stays real: no stub, no fake PASS.
//   * evidence: PK_TEST_EVIDENCE_ROOT overrides the per-case evidence
//     directory (the default stays in the repository's gitignored
//     qa-autopilot/artifacts tree).
//   * explicit lane endpoints / stand-ins (extraEnv) are applied AFTER the
//     sanitization and are never removed afterwards.
//
// The helper is dependency-free on purpose: it must be requirable before the
// product modules so the environment is already isolated when they load.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

// The system variables a test process may inherit. Everything that is not
// listed here is ambient state and is removed before the product loads.
const SYSTEM_ENV_ALLOWLIST = [
  'PATH',
  'PATHEXT',
  'SystemRoot',
  'WINDIR',
  'ComSpec',
  'SystemDrive',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
  'PROCESSOR_ARCHITEW6432',
  'PROCESSOR_IDENTIFIER',
  'PROCESSOR_LEVEL',
  'PROCESSOR_REVISION',
  'OS',
  'ProgramData',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'CommonProgramFiles',
  'CommonProgramFiles(x86)',
  'CommonProgramW6432',
  'ALLUSERSPROFILE',
  'PUBLIC',
  'USERNAME',
  'USERDOMAIN',
  'COMPUTERNAME',
  'LOGONSERVER',
  'SESSIONNAME',
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'TERM',
  'SHELL',
  'DISPLAY',
  'WAYLAND_DISPLAY',
  'XAUTHORITY',
  'CI',
];

// The knobs this tool (and its runner) controls. They are kept across the
// sanitization so the caller can still select the temp root, the evidence
// root and the gate mode.
const TOOL_ENV_KEYS = [
  'PK_TEST_TEMP_ROOT',
  'PK_TEST_EVIDENCE_ROOT',
  'PK_LOGGING_GATE_STRICT_TRACKED',
  'PK_TEST_TIMEOUT_MS',
];

// The module endpoints / switches the product understands. Reset semantics
// follow qa-autopilot/lib/isolation.cjs: URLs need a legal port (1..65535,
// the product rejects port 0 as INVALID_MODULE_URL), flags are '0' and
// commands are empty strings.
const MODULE_URL_KEYS = [
  'KB_KNOWLEDGE_ENGINE_URL',
  'KB_EVENTBRIDGE_URL',
  'KB_EVENT_BRIDGE_URL',
  'KB_TERMINAL_URL',
  'KB_VECTORHUB_URL',
];
const MODULE_FLAG_KEYS = ['KB_MODULES_REGISTER', 'KB_MODULES_AUTOSTART'];
const MODULE_COMMAND_KEYS = [
  'KB_KNOWLEDGE_ENGINE_COMMAND',
  'KB_EVENTBRIDGE_COMMAND',
  'KB_TERMINAL_COMMAND',
  'KB_VECTORHUB_COMMAND',
  'AI_CODING_EVENT_BRIDGE_MODULE',
  'KB_WORKBENCH_RUNTIME_TOKEN',
];
const DEAD_MODULE_URL = 'http://127.0.0.1:1';

// Hard deny: even if a future allowlist entry would keep a key, nothing
// credential-, proxy-, token- or injection-shaped may survive. The lane
// variables are assigned after this check, so they are never affected.
const DENY_KEY_PATTERNS = [
  /(^|_)(API_?KEY|KEYS|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?)$/i,
  /^AWS_/i,
  /^AZURE_/i,
  /^GOOGLE_API/i,
  /^GOOGLE_APPLICATION_CREDENTIALS$/i,
  /^(HTTP|HTTPS|ALL|NO)_PROXY$/i,
  /^PROXY$/i,
  /^NODE_OPTIONS$/i,
  /^NODE_EXTRA_CA_CERTS$/i,
  /^NODE_PATH$/i,
  /^ANTHROPIC_/i,
  /^CLAUDE_/i,
  /^CODEX_/i,
  /^MINIMAX_/i,
  /^OPENAI_/i,
  /^GEMINI_/i,
  /^GIT_/i,
  /^NPM_/i,
  /^SSH_AUTH_SOCK$/i,
  /^DOCKER_CONFIG$/i,
  /^KUBECONFIG$/i,
  /^AI_CODING_EVENT_BRIDGE_/i,
  /^KB_(KNOWLEDGE_ENGINE|EVENTBRIDGE|EVENT_BRIDGE|TERMINAL|VECTORHUB)_/i,
];

// The environment keys this helper owns. Every one of them is redirected to
// a directory owned by the current run.
const ISOLATED_ENV_KEYS = [
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'TEMP',
  'TMP',
  'TMPDIR',
  'PSModuleAnalysisCachePath',
  'CODEX_HOME',
  'CLAUDE_CONFIG_DIR',
  'KB_DATA_DIR',
  'KB_KNOWLEDGE_DATA_DIR',
  'AI_CODING_EVENT_BRIDGE_HOME',
  'AGENT_TERMINAL_DATA_DIR',
  'CLAUDE_AI_WORKBENCH_DATA_DIR',
];

// Windows environment variables are case-insensitive; POSIX ones are not.
const normalizeKey = key => (process.platform === 'win32' ? String(key).toUpperCase() : String(key));

function isInsideRepo(candidate, repoRoot = REPO_ROOT) {
  const relative = path.relative(repoRoot, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

// Resolves the absolute temp root for a test run. PK_TEST_TEMP_ROOT wins when
// it is set; CI points it at the runner temp, which lives outside the
// checkout. os.tmpdir() is the portable fallback.
function resolveTempRoot(env = process.env) {
  const configured = env.PK_TEST_TEMP_ROOT;
  if (configured && !path.isAbsolute(configured)) {
    throw new Error(`PK_TEST_TEMP_ROOT must be an absolute path (got: ${configured})`);
  }
  // os.tmpdir() is used verbatim (no realpath): on Windows the runner temp
  // can be an 8.3 short path, and expanding it would change the path the
  // caller configured.
  const root = configured ? path.resolve(configured) : path.resolve(os.tmpdir());
  if (!path.isAbsolute(root)) throw new Error(`test temp root must be absolute (got: ${root})`);
  if (isInsideRepo(root)) {
    throw new Error(`test temp root must live outside the source repository (got: ${root}; repo: ${REPO_ROOT})`);
  }
  fs.mkdirSync(root, { recursive: true });
  return root;
}

// The evidence directory for one case. PK_TEST_EVIDENCE_ROOT overrides the
// root and keeps the per-case subdirectory name of the default location.
function resolveEvidenceDir(defaultDir, env = process.env) {
  const configured = env.PK_TEST_EVIDENCE_ROOT;
  if (!configured) return defaultDir;
  if (!path.isAbsolute(configured)) {
    throw new Error(`PK_TEST_EVIDENCE_ROOT must be an absolute path (got: ${configured})`);
  }
  fs.mkdirSync(configured, { recursive: true });
  return path.join(configured, path.basename(defaultDir));
}

// The real browser executable, captured BEFORE any path moves. A per-user
// Chrome lives under LOCALAPPDATA; once LOCALAPPDATA points into the lane
// tree the developer's install is no longer discoverable, so the path has to
// be captured first and re-exported as KB_CHROME_PATH (find-chrome consults
// that key first).
function captureChrome() {
  try {
    // Required lazily: the helper must stay loadable before the product.
    const { findChromeDetailed } = require('./find-chrome');
    const found = findChromeDetailed();
    return { path: found.path, source: found.source };
  } catch {
    return null;
  }
}

// Removes the ambient environment from the driver itself, so every child
// process inherits the same clean base. Returns what was removed, for the
// gate's evidence.
function sanitizeEnv(env = process.env, options = {}) {
  const allowed = new Set(
    (options.allowedKeys || [...SYSTEM_ENV_ALLOWLIST, ...TOOL_ENV_KEYS]).map(normalizeKey),
  );
  const removed = [];
  for (const key of Object.keys(env)) {
    if (!allowed.has(normalizeKey(key))) removed.push(key);
  }
  for (const key of removed) delete env[key];

  const denied = [];
  for (const key of Object.keys(env)) {
    if (DENY_KEY_PATTERNS.some(pattern => pattern.test(key))) denied.push(key);
  }
  for (const key of denied) delete env[key];

  return { removed, denied };
}

// Empty default user-data directories for the platform's Chrome profile
// location. Chrome >= 136 checks the default directory even when
// --user-data-dir points elsewhere; with HOME/APPDATA/LOCALAPPDATA redirected
// that directory must exist inside the isolated tree.
//
// On Windows the probe does not only follow LOCALAPPDATA: Chrome also derives
// <USERPROFILE>\AppData\Local\Google\Chrome\User Data on its own. USERPROFILE
// points at the lane home here, so that derived location is scaffolded empty
// under the owned home as well - never the developer's real default profile.
function chromeDefaultProfileDirs(dirs) {
  const created = [];
  const add = dir => {
    fs.mkdirSync(dir, { recursive: true });
    created.push(dir);
  };
  if (process.platform === 'win32') {
    add(path.join(dirs.localAppData, 'Google', 'Chrome', 'User Data'));
    add(path.join(dirs.appData, 'Google', 'Chrome', 'User Data'));
    add(path.join(dirs.home, 'AppData', 'Local', 'Google', 'Chrome', 'User Data'));
  } else if (process.platform === 'darwin') {
    add(path.join(dirs.home, 'Library', 'Application Support', 'Google', 'Chrome'));
  } else {
    add(path.join(dirs.home, '.config', 'google-chrome'));
    add(path.join(dirs.home, '.config', 'chromium'));
  }
  return created;
}

// Installs the isolated environment for one entry and returns the handles the
// entry needs. Call this before requiring any product or helper module.
//
// Phase order matters:
//   1. capture the real browser executable (before LOCALAPPDATA moves)
//   2. resolve the temp root (os.tmpdir() reads TEMP/TMP)
//   3. sanitize the ambient environment (driver level)
//   4. create the lane tree
//   5. assign the lane variables (never removed afterwards)
//   6. apply the entry's explicit lane endpoints / stand-ins
function installLoggingTestEnv({ caseId, prefix, env = process.env, extraEnv = {} } = {}) {
  const label = prefix || caseId || 'logging';

  // Phase 1: the browser executable is captured from the untouched
  // environment. Losing it would make findChrome() fall back to the
  // developer's real browser profile once LOCALAPPDATA is redirected.
  const chrome = captureChrome();

  // Phase 2: the temp root is resolved before the cleanup, because
  // os.tmpdir() reads TEMP/TMP and those are part of what gets cleaned.
  const tempRoot = resolveTempRoot(env);

  // Phase 3: the ambient environment is removed from the driver itself.
  const sanitized = sanitizeEnv(env);

  // Phase 4: the lane tree.
  const laneTmp = fs.mkdtempSync(path.join(tempRoot, `${label}-`));
  const dirs = {
    home: path.join(laneTmp, 'home'),
    appData: path.join(laneTmp, 'appdata-roaming'),
    localAppData: path.join(laneTmp, 'appdata-local'),
    temp: path.join(laneTmp, 'temp'),
    claudeConfig: path.join(laneTmp, 'claude-config'),
    codexHome: path.join(laneTmp, 'codex-home'),
    bridgeHome: path.join(laneTmp, 'bridge-home'),
    dataHome: path.join(laneTmp, 'kb-data'),
    knowledgeHome: path.join(laneTmp, 'kb-knowledge-data'),
    agentTerminalData: path.join(laneTmp, 'agent-terminal-data'),
    workbenchData: path.join(laneTmp, 'workbench-data'),
    // The PARENT directory of the PowerShell module analysis cache. The
    // environment variable must carry a FILE path whose parent exists, so
    // only the parent is created here (PowerShell writes the cache file).
    psModuleCache: path.join(laneTmp, 'ps-module-cache'),
  };
  for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true });

  // Phase 5: the lane variables. They are assigned after the sanitization, so
  // nothing here can be removed by the ambient cleanup.
  if (chrome) env.KB_CHROME_PATH = chrome.path;
  env.HOME = dirs.home;
  env.USERPROFILE = dirs.home;
  const homeRoot = path.parse(dirs.home).root;
  env.HOMEDRIVE = homeRoot;
  env.HOMEPATH = path.relative(homeRoot, dirs.home) || '\\';
  env.APPDATA = dirs.appData;
  env.LOCALAPPDATA = dirs.localAppData;
  env.TEMP = dirs.temp;
  env.TMP = dirs.temp;
  env.TMPDIR = dirs.temp;
  // PowerShell reads PSModuleAnalysisCachePath as the FILE that holds the
  // module analysis cache; pointing it at a directory is wrong. The parent
  // directory exists (created above), the cache file is PowerShell's to write.
  env.PSModuleAnalysisCachePath = path.join(dirs.psModuleCache, 'ModuleAnalysisCache');
  env.CODEX_HOME = dirs.codexHome;
  env.CLAUDE_CONFIG_DIR = dirs.claudeConfig;
  env.KB_DATA_DIR = dirs.dataHome;
  env.KB_KNOWLEDGE_DATA_DIR = dirs.knowledgeHome;
  env.AI_CODING_EVENT_BRIDGE_HOME = dirs.bridgeHome;
  env.AGENT_TERMINAL_DATA_DIR = dirs.agentTerminalData;
  env.CLAUDE_AI_WORKBENCH_DATA_DIR = dirs.workbenchData;
  // Explicit, dead module endpoints: the product must never be able to reach
  // a developer's live module through an inherited URL.
  for (const key of MODULE_URL_KEYS) env[key] = DEAD_MODULE_URL;
  for (const key of MODULE_FLAG_KEYS) env[key] = '0';
  for (const key of MODULE_COMMAND_KEYS) env[key] = '';
  if (process.platform !== 'win32') {
    // Keep Chrome's XDG lookups inside the isolated home as well.
    env.XDG_CONFIG_HOME = path.join(dirs.home, '.config');
    env.XDG_CACHE_HOME = path.join(dirs.home, '.cache');
    fs.mkdirSync(env.XDG_CONFIG_HOME, { recursive: true });
    fs.mkdirSync(env.XDG_CACHE_HOME, { recursive: true });
  }

  const chromeProfileDirs = chromeDefaultProfileDirs(dirs);

  // Phase 6: the entry's explicit lane endpoints / stand-ins. They are
  // applied last and are never sanitized away.
  const appliedOverrides = [];
  for (const [key, value] of Object.entries(extraEnv || {})) {
    env[key] = String(value);
    appliedOverrides.push(key);
  }

  return {
    caseId: caseId || label,
    prefix: label,
    tempRoot,
    laneTmp,
    dirs,
    chrome,
    chromePath: chrome ? chrome.path : null,
    chromeProfileDirs,
    isolatedEnvKeys: ISOLATED_ENV_KEYS.slice(),
    sanitized,
    appliedOverrides,
    cleanup() {
      try { fs.rmSync(laneTmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {}
    },
  };
}

module.exports = {
  REPO_ROOT,
  ISOLATED_ENV_KEYS,
  SYSTEM_ENV_ALLOWLIST,
  TOOL_ENV_KEYS,
  DENY_KEY_PATTERNS,
  MODULE_URL_KEYS,
  MODULE_FLAG_KEYS,
  MODULE_COMMAND_KEYS,
  DEAD_MODULE_URL,
  isInsideRepo,
  resolveTempRoot,
  resolveEvidenceDir,
  captureChrome,
  sanitizeEnv,
  installLoggingTestEnv,
};
