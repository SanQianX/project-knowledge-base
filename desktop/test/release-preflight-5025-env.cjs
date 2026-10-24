'use strict';
// P-DESKTOP-CANDIDATE-HARDEN-R2 environment isolation helper for the
// release-preflight-5025 tools.
//
// The preflight tools used to pass `{ ...process.env }` into the candidate
// GUI/backend after deleting only KB_* keys, which forwarded this machine's
// ambient provider credentials (ANTHROPIC_AUTH_TOKEN, OPENAI_*, ... — the
// exact vars the bundled Workbench reads) into the packaged processes, and
// left TEMP/TMPDIR/PSModuleAnalysisCache/Workbench data pointing at the real
// user profile. This helper inverts the construction: NOTHING is inherited
// by default; only an explicit system-variable allow-list is copied, and
// every writable location is redirected under one run directory.
//
// Audited exception (Leader-approved, single narrow case): the REAL Electron
// GUI browser process keeps its original USERPROFILE. Electron 43.1.1
// CHECK-fails during startup whenever USERPROFILE differs from the shell's
// real profile (EXCEPTION_BREAKPOINT before any JS; see the preflight
// evidence under qa-autopilot/artifacts/parallel-20261023/
// release-preflight-5025/evidence/verify/). The exception applies ONLY to
// gui:true environments (the caller MUST pass --user-data-dir so Chromium
// userData never lands in the real profile). ELECTRON_RUN_AS_NODE children
// and every non-GUI process use the fully isolated USERPROFILE.
//
// This module never reads env values into logs and never prints env contents.

const fs = require('node:fs');
const path = require('node:path');

// Windows process floor + tool-control vars. Anything else in the ambient
// environment (provider keys, agent homes, proxies, URLs) is dropped.
const SYSTEM_ALLOW = new Set([
  'PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'windir', 'WINDIR',
  'SystemDrive', 'SYSTEMDRIVE', 'ComSpec', 'COMSPEC', 'OS',
  'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER',
  'PROCESSOR_LEVEL', 'PROCESSOR_REVISION',
  'ProgramFiles', 'ProgramFiles(x86)', 'ProgramData', 'ProgramW6432',
  'CommonProgramFiles', 'CommonProgramFiles(x86)', 'CommonProgramW6432',
  'ALLUSERSPROFILE', 'NO_PROXY', 'no_proxy', 'LANG', 'LC_ALL',
  // Tool-control inputs of the preflight tools themselves (paths the operator
  // set on purpose; never secrets).
  'KB_DESKTOP_ELECTRON_ZIP_DIR', 'KB_DESKTOP_BUNDLE', 'KB_PREFLIGHT_ISO_ROOT',
]);

// Defense-in-depth pattern (the allow-list alone already excludes these).
// Used by the sentinel self-test to prove the contract, and by
// hardenProcessEnv as an assertion that nothing matching survived the copy.
const PROVIDER_KEY = RegExp(
  '^(ANTHROPIC|OPENAI|GEMINI|GOOGLE|AZURE|AWS|BEDROCK|COHERE|GROQ|MISTRAL|'
  + 'OPENROUTER|DEEPSEEK|MOONSHOT|MINIMAX|QWEN|DASHSCOPE|TOGETHER|FIREWORKS|'
  + 'REPLICATE|HUGGING|HF|CODEX|CLAUDE|ZCODE|ZAI|SENTRY|OTEL|LANGSMITH|LANGFUSE|'
  + 'ELECTRON_GET|NODE_OPTIONS|NODE_EXTRA_CA_CERTS)[_A-Z0-9]*$'
  + '|(^|_)(API_KEY|AUTH_TOKEN|ACCESS_TOKEN|REFRESH_TOKEN|SESSION_TOKEN|OAUTH_TOKEN|SECRET|PASSWORD|CREDENTIALS?|PRIVATE_KEY)(_|$)'
  + '|(_BASE_URL|_MODULE_URL|_ENDPOINT)$'
  + '|^(HTTP|HTTPS|ALL|SOCKS)_PROXY$',
);

// Writable locations that must be redirected under the run directory.
const ISOLATED_VARS = [
  'HOME', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'TMPDIR',
  'PSModuleAnalysisCachePath', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR',
  'CLAUDE_AI_WORKBENCH_DATA_DIR', 'AI_CODING_EVENT_BRIDGE_HOME',
  'KB_DATA_DIR', 'KB_KNOWLEDGE_DATA_DIR', 'npm_config_cache', 'electron_config_cache',
];

function defaultDirs(runDir) {
  return {
    home: path.join(runDir, 'home'),
    appdata: path.join(runDir, 'appdata'),
    localappdata: path.join(runDir, 'localappdata'),
    temp: path.join(runDir, 'temp'),
    psCache: path.join(runDir, 'ps-module-cache', 'ModuleAnalysisCache'),
    codex: path.join(runDir, 'codex'),
    claude: path.join(runDir, 'claude'),
    workbench: path.join(runDir, 'workbench'),
    bridge: path.join(runDir, 'bridge'),
    data: path.join(runDir, 'data'),
    knowledge: path.join(runDir, 'knowledge'),
    npmCache: path.join(runDir, 'npm-cache'),
    electronCache: path.join(runDir, 'electron-cache'),
  };
}

// Every redirected value is a DIRECTORY to create except psCache: the
// PowerShell module-analysis cache is a FILE path, so only its parent is
// created (PowerShell itself writes the file). The old ensureDirs created
// path.dirname() of EVERY value, so the directories themselves (TEMP
// included) never existed unless some other code happened to create them.
const FILE_VALUED_DIR_KEYS = new Set(['psCache']);

function ensureDirs(dirs) {
  for (const [name, dir] of Object.entries(dirs)) {
    const target = FILE_VALUED_DIR_KEYS.has(name) ? path.dirname(dir) : dir;
    fs.mkdirSync(target, { recursive: true });
    assertExistingDirectory(target, name);
  }
}

function assertExistingDirectory(target, name) {
  let stat;
  try {
    stat = fs.statSync(target);
  } catch {
    throw new Error(`isolated env path ${name} was not created on disk: ${target}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`isolated env path ${name} exists but is not a directory: ${target}`);
  }
}

// Build a hardened child environment from `sourceEnv` (injectable so the
// offline sentinel can poison it; callers pass process.env). Copies only
// SYSTEM_ALLOW entries, asserts none of them look like credentials, then
// redirects every writable root under runDir. gui:true keeps the original
// USERPROFILE (the single audited exception); everything else isolates it.
function buildIsolatedEnv({ sourceEnv, runDir, dirs, gui = false, extra = {} }) {
  const d = dirs || defaultDirs(runDir);
  ensureDirs(d);
  const env = {};
  for (const name of Object.keys(sourceEnv || {})) {
    if (!SYSTEM_ALLOW.has(name)) continue;
    if (PROVIDER_KEY.test(name)) {
      throw new Error(`allow-list variable matches the credential pattern and was refused: ${name}`);
    }
    env[name] = sourceEnv[name];
  }
  const profile = gui ? (sourceEnv && sourceEnv.USERPROFILE) || process.env.USERPROFILE : d.home;
  Object.assign(env, {
    HOME: d.home,
    USERPROFILE: profile,
    HOMEDRIVE: undefined,
    HOMEPATH: undefined,
    APPDATA: d.appdata,
    LOCALAPPDATA: d.localappdata,
    TEMP: d.temp,
    TMP: d.temp,
    TMPDIR: d.temp,
    PSModuleAnalysisCachePath: d.psCache,
    CODEX_HOME: d.codex,
    CLAUDE_CONFIG_DIR: d.claude,
    CLAUDE_AI_WORKBENCH_DATA_DIR: d.workbench,
    AI_CODING_EVENT_BRIDGE_HOME: d.bridge,
    KB_DATA_DIR: d.data,
    KB_KNOWLEDGE_DATA_DIR: d.knowledge,
    npm_config_cache: d.npmCache,
    electron_config_cache: d.electronCache,
  });
  for (const [k, v] of Object.entries(extra)) env[k] = v === undefined ? undefined : String(v);
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  return env;
}

// Offline fail-closed sentinel. Throws (names only, never values) when:
//  - any remaining key matches the credential pattern,
//  - any isolated var is missing or points outside runDir,
//  - the system floor is absent,
//  - the USERPROFILE exception is not narrowed to gui:true.
function assertEnvContract(env, runDir, { gui, originalUserProfile } = {}) {
  // ISOLATED_VARS names may themselves look provider-shaped (CODEX_HOME,
  // CLAUDE_CONFIG_DIR, CLAUDE_AI_WORKBENCH_DATA_DIR match the pattern by
  // NAME), but buildIsolatedEnv never copies them from the ambient env —
  // they are always OUR overrides, and the loop below contract-checks their
  // values. Only ambient leftovers can be leaks.
  const leaked = Object.keys(env).filter((k) => !ISOLATED_VARS.includes(k) && PROVIDER_KEY.test(k));
  if (leaked.length) throw new Error(`env contract violation: credential-shaped keys present: ${leaked.join(', ')}`);
  const root = path.resolve(runDir);
  for (const name of ISOLATED_VARS) {
    const value = env[name];
    if (!value) throw new Error(`env contract violation: ${name} is not set`);
    // Directory-valued vars must sit inside runDir THEMSELVES (not merely
    // their parent); PSModuleAnalysisCachePath is file-valued, so its parent
    // is what must sit inside.
    const fileValued = name === 'PSModuleAnalysisCachePath';
    const target = path.resolve(fileValued ? path.dirname(value) : value);
    const rel = path.relative(root, target);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error(`env contract violation: ${name} escapes the run directory`);
    }
    // Real on-disk proof, not a string check: the directory (or, for the
    // file-valued var, its parent) must exist and be a directory.
    assertExistingDirectory(target, name);
  }
  if (!env.PATH && !env.Path) throw new Error('env contract violation: PATH missing (spawn floor)');
  if (process.platform === 'win32' && !env.SystemRoot && !env.SYSTEMROOT) {
    throw new Error('env contract violation: SystemRoot missing (Windows spawn floor)');
  }
  if (gui) {
    const original = originalUserProfile || process.env.USERPROFILE;
    if (!original || env.USERPROFILE !== original) {
      throw new Error('env contract violation: gui env must keep the original USERPROFILE (audited Electron 43 exception)');
    }
  } else if (path.resolve(env.USERPROFILE) !== path.resolve(path.join(root, 'home'))) {
    throw new Error('env contract violation: non-GUI env must isolate USERPROFILE');
  }
  return true;
}

// For tools that run their work in-process (make.cjs drives electron-forge
// via require): rewrite this process's own env with the same construction so
// every child forge/packager/npm/powershell process inherits the hardened set.
function hardenProcessEnv(runDir, { gui = false, extra = {} } = {}) {
  const snapshot = { ...process.env };
  const env = buildIsolatedEnv({ sourceEnv: snapshot, runDir, gui, extra });
  for (const name of Object.keys(process.env)) delete process.env[name];
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  assertEnvContract(env, runDir, { gui, originalUserProfile: snapshot.USERPROFILE });
  return snapshot;
}

module.exports = {
  SYSTEM_ALLOW, PROVIDER_KEY, ISOLATED_VARS, FILE_VALUED_DIR_KEYS,
  defaultDirs, ensureDirs, buildIsolatedEnv, assertEnvContract, hardenProcessEnv,
};
