// _site/_test/helpers/parallel-dock-isolation-r3-fixture.js
//
// Lane-exclusive isolation scaffolding for P-DOCK-ISOLATION-R3.
// Read-only references: _site/_test/helpers/parallel-workbench-drafts-r5-fixture.js
// (the isolation scaffolding the Leader named as verified) and
// _site/_test/helpers/parallel-dock-acceptance-r2-env.js. Neither is modified.
//
// Contract of this lane:
//   * the PROBE process itself is re-executed with the isolated environment
//     before any product / terminal / Chrome / SDK child is started, so every
//     later child inherits the isolation instead of the developer's shell;
//   * every child environment is an ALLOWLIST: no ambient provider key and no
//     ambient module URL survives;
//   * HOME / USERPROFILE / CODEX_HOME / CLAUDE_CONFIG_DIR / APPDATA /
//     LOCALAPPDATA / TEMP / TMP / TMPDIR, the dual KB data dirs, the Bridge
//     home, the Workbench data dir, the ports and the browser profile all
//     point below ONE root that lives OUTSIDE the repository and carries an
//     owner marker;
//   * Chrome's executable is resolved BEFORE the isolation is applied,
//     because that discovery reads the real %LOCALAPPDATA%.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const crypto = require('crypto');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

// The developer's live surfaces. A test may never bind or talk to them.
const FORBIDDEN_PORTS = new Set([5757, 5760, 5789, 5790, 8787, 8790]);

// Ambient module addresses: dropped from every allowlisted environment.
const AMBIENT_MODULE_URLS = [
  'KB_KNOWLEDGE_ENGINE_URL',
  'KB_VECTORHUB_URL',
  'KB_TERMINAL_URL',
  'KB_EVENTBRIDGE_URL',
  'KB_EVENT_BRIDGE_URL',
  'KB_WORKBENCH_RUNTIME_TOKEN',
  'KB_MODULES_AUTOSTART',
];

// Ambient provider credentials: a test may only use the credential it injects
// itself, never one that happens to sit in the shell.
const AMBIENT_MODEL_ENV = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_THINKING_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'API_TIMEOUT_MS',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
];

// Any other variable whose name looks like a provider credential, a Bridge
// token or a product/knowledge variable is dropped as well. The isolation map
// re-adds the ones this lane owns.
const AMBIENT_CREDENTIAL_PATTERN = /^(ANTHROPIC|OPENAI|CLAUDE|CLAUDE_CODE|GEMINI|GOOGLE|GROQ|MISTRAL|XAI|COHERE|DEEPSEEK|MINIMAX|MOONSHOT|QWEN|DASHSCOPE|KB_|AI_CODING|AI_)/;

// The variables an isolated child may inherit from the launching shell. Only
// operating-system facts survive - never user state, never credentials.
const BASE_ENV_KEYS = new Set([
  'SYSTEMROOT', 'WINDIR', 'SYSTEMDRIVE', 'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER', 'PROCESSOR_REVISION',
  'OS', 'PATHEXT', 'COMSPEC', 'PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ',
  'TERM', 'SHELL', 'TMPDIR', 'TEMP', 'TMP', 'HOME', 'USERPROFILE',
  'HOMEDRIVE', 'HOMEPATH',
]);

// The absolute-path members of the isolation whitelist.
const ISOLATION_PATH_KEYS = [
  'HOME',
  'USERPROFILE',
  'CODEX_HOME',
  'CLAUDE_CONFIG_DIR',
  'APPDATA',
  'LOCALAPPDATA',
  'TEMP',
  'TMP',
  'TMPDIR',
  'KB_DATA_DIR',
  'KB_KNOWLEDGE_DATA_DIR',
  'AI_CODING_EVENT_BRIDGE_HOME',
  'AGENT_TERMINAL_DATA_DIR',
  'CLAUDE_AI_WORKBENCH_DATA_DIR',
];

// Captured before any isolation changes HOME.
const REAL_HOME = os.homedir();
const REAL_USERPROFILE = process.env.USERPROFILE || REAL_HOME;

// Where the product keeps the REAL profiles. Read-only access, one profile at
// a time, and the secret that is read there never leaves the server process
// memory: it is handed over through a pipe, never written to a file.
const REAL_PROFILE_STORES = [
  path.join(REAL_HOME, '.project-knowledge-v5', 'workbench'),
  path.join(REAL_HOME, '.agent-terminal'),
];

function isInside(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function resolveTempRoot() {
  const sharedRoot = path.join(path.dirname(REPO_ROOT), '.project-knowledge-test-temp');
  const candidates = [
    process.env.PK_TEST_TEMP_ROOT,
    fs.existsSync(sharedRoot) ? sharedRoot : null,
    process.env.TEMP,
    process.env.TMP,
    process.env.TMPDIR,
  ];
  const chosen = candidates.find(value => value && String(value).trim());
  const root = path.resolve(chosen ? String(chosen).trim() : os.tmpdir());
  if (isInside(root, REPO_ROOT)) throw new Error(`refusing to use a temp root inside the repository: ${root}`);
  return root;
}

function ensureTempRoot() {
  const root = resolveTempRoot();
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function makeTempDir(prefix = 'dock-isolation-r3') {
  const root = ensureTempRoot();
  const dir = fs.mkdtempSync(path.join(root, `${prefix}-`));
  if (isInside(dir, REPO_ROOT)) throw new Error(`refusing to create a fixture inside the repository: ${dir}`);
  return dir;
}

function removeTree(dir) {
  if (!dir) return;
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

// One isolated layout: every directory this lane may touch.
function createIsolationLayout(prefix = 'dock-isolation-r3') {
  const root = makeTempDir(prefix);
  const layout = {
    root,
    home: path.join(root, 'home'),
    claudeConfigDir: path.join(root, 'claude-config'),
    codexHome: path.join(root, 'codex-home'),
    appData: path.join(root, 'appdata-roaming'),
    localAppData: path.join(root, 'appdata-local'),
    temp: path.join(root, 'temp'),
    workspace: path.join(root, 'workspace'),
    knowledgeRoot: path.join(root, 'knowledge-root'),
    knowledgeDataDir: path.join(root, 'knowledge-data'),
    bridgeHome: path.join(root, 'bridge-home'),
    dataDir: path.join(root, 'agent-terminal-data'),
    browserProfile: path.join(root, 'chrome-profile'),
  };
  for (const dir of Object.values(layout)) fs.mkdirSync(dir, { recursive: true });
  // Chrome >= 136 refuses --remote-debugging-port unless it can resolve its
  // DEFAULT user data dir and confirm the passed --user-data-dir differs. The
  // default is derived from the user profile / local app data, so BOTH
  // derivations get an empty scaffold inside the isolated root. Nothing of
  // the real machine is touched.
  fs.mkdirSync(path.join(layout.home, 'AppData', 'Local', 'Google', 'Chrome', 'User Data'), { recursive: true });
  fs.mkdirSync(path.join(layout.home, 'AppData', 'Roaming'), { recursive: true });
  fs.mkdirSync(path.join(layout.localAppData, 'Google', 'Chrome', 'User Data'), { recursive: true });
  fs.mkdirSync(path.join(layout.appData, 'Google', 'Chrome', 'User Data'), { recursive: true });
  return layout;
}

function writeOwnerMarker(layout, marker) {
  const file = path.join(layout.root, 'owner-marker.json');
  fs.writeFileSync(file, JSON.stringify(marker, null, 2), 'utf8');
  return file;
}

function readOwnerMarker(layout) {
  try { return JSON.parse(fs.readFileSync(path.join(layout.root, 'owner-marker.json'), 'utf8')); } catch { return null; }
}

// The isolation whitelist: every value an own child may resolve through its
// environment points into this layout.
function isolationEnvMap(layout) {
  const parsed = path.parse(layout.home);
  return {
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
    KB_DATA_DIR: layout.knowledgeDataDir,
    KB_KNOWLEDGE_DATA_DIR: layout.knowledgeDataDir,
    AI_CODING_EVENT_BRIDGE_HOME: layout.bridgeHome,
    AGENT_TERMINAL_DATA_DIR: layout.dataDir,
    CLAUDE_AI_WORKBENCH_DATA_DIR: layout.dataDir,
  };
}

// The allowlisted operating-system facts of the launching shell.
function allowlistedBaseEnv(source = process.env) {
  const out = {};
  for (const [key, value] of Object.entries(source || {})) {
    if (value === undefined || value === null) continue;
    const upper = String(key).toUpperCase();
    if (!BASE_ENV_KEYS.has(upper)) continue;
    if (upper === 'TEMP' || upper === 'TMP' || upper === 'TMPDIR'
      || upper === 'HOME' || upper === 'USERPROFILE'
      || upper === 'HOMEDRIVE' || upper === 'HOMEPATH') continue;
    out[key] = String(value);
  }
  return out;
}

// The environment of one isolated child. Nothing ambient survives unless this
// lane puts it there on purpose.
function isolatedEnv(layout, extra = {}, source = process.env) {
  const env = { ...allowlistedBaseEnv(source), ...isolationEnvMap(layout) };
  for (const key of AMBIENT_MODULE_URLS) delete env[key];
  for (const key of AMBIENT_MODEL_ENV) delete env[key];
  for (const key of Object.keys(env)) {
    if (AMBIENT_CREDENTIAL_PATTERN.test(key) && !ISOLATION_PATH_KEYS.includes(key)) delete env[key];
  }
  return { ...env, ...extra };
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => {
        if (FORBIDDEN_PORTS.has(Number(port))) { reject(new Error(`refusing to use the live port ${port}`)); return; }
        resolve(Number(port));
      });
    });
  });
}

function sha256File(file) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); } catch { return null; }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
  return file;
}

function readJsonSafe(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// Reads ONE real profile definition and its credential, read-only. The
// definition is secret-free by construction (normalizeProfile drops every
// credential field); the secret is returned to the caller only, which hands it
// to the server process through a pipe.
function readRealWorkbenchProfile(profileId) {
  for (const store of REAL_PROFILE_STORES) {
    const profilesFile = path.join(store, 'profiles.v2.json');
    const credentialsFile = path.join(store, 'credentials.v1.json');
    if (!fs.existsSync(profilesFile) || !fs.existsSync(credentialsFile)) continue;
    const profiles = readJsonSafe(profilesFile);
    const credentials = readJsonSafe(credentialsFile);
    if (!profiles || !credentials) continue;
    const profile = (profiles.profiles || []).find(item => item && item.id === profileId);
    if (!profile) continue;
    const credentialRef = profile.credentialRef || `credential:${profile.id}`;
    const secret = (credentials.credentials || {})[credentialRef];
    if (!secret) continue;
    // Only the definition leaves this function; the secret travels separately.
    const definition = {
      id: profile.id,
      name: profile.name || profile.id,
      provider: profile.provider || null,
      protocol: profile.protocol || 'anthropic-compatible',
      baseUrl: profile.baseUrl || null,
      openaiBaseUrl: profile.openaiBaseUrl || null,
      credentialRef,
      models: profile.models || null,
      contextWindow: profile.contextWindow || null,
      timeoutMs: profile.timeoutMs || null,
      permissionMode: profile.permissionMode || null,
      enabled: profile.enabled !== false,
    };
    return {
      profileId: profile.id,
      credentialRef,
      secret: String(secret),
      definition,
      sourceStore: path.basename(store),
      sourceStorePath: store,
    };
  }
  throw new Error(`real profile "${profileId}" not found in any installed workbench store`);
}

// Proves that the real credential never reached a file: every file below the
// given roots is searched for the secret literal.
function scanForSecret(roots, secret) {
  const findings = [];
  let scanned = 0;
  const needle = String(secret || '');
  if (!needle) return { scanned, findings, skipped: 'no secret given' };
  const walk = (dir) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.isFile()) continue;
      let stat = null;
      try { stat = fs.statSync(full); } catch { continue; }
      if (stat.size > 8 * 1024 * 1024) continue;
      let text = '';
      try { text = fs.readFileSync(full, 'utf8'); } catch { continue; }
      scanned += 1;
      if (text.includes(needle)) findings.push(full);
    }
  };
  for (const root of [].concat(roots || [])) walk(root);
  return { scanned, findings };
}

// The names of the environment variables a process received. Values are never
// recorded for credential-shaped names.
function envKeyNames(env) {
  return Object.keys(env || {}).sort();
}

module.exports = {
  REPO_ROOT,
  FORBIDDEN_PORTS,
  AMBIENT_MODULE_URLS,
  AMBIENT_MODEL_ENV,
  AMBIENT_CREDENTIAL_PATTERN,
  ISOLATION_PATH_KEYS,
  REAL_HOME,
  REAL_USERPROFILE,
  REAL_PROFILE_STORES,
  resolveTempRoot,
  ensureTempRoot,
  makeTempDir,
  removeTree,
  isInside,
  createIsolationLayout,
  writeOwnerMarker,
  readOwnerMarker,
  isolationEnvMap,
  allowlistedBaseEnv,
  isolatedEnv,
  freePort,
  sha256File,
  writeJson,
  readJsonSafe,
  readRealWorkbenchProfile,
  scanForSecret,
  envKeyNames,
};
