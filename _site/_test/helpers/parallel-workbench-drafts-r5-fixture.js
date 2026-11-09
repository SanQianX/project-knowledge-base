'use strict';
// P-WB-DRAFTS-R5 fixture — copied from the accepted helpers/parallel-workbench-fixture.js
// (frozen for WB003/4/8) with exactly the isolation corrections the R5 dispatch
// requires; the original stays untouched.
//
// R5 isolation contract (everything this lane's own children may see):
//   * every directory is created below the shared temp root, never inside
//     the repository;
//   * the Workbench data directory, the knowledge data directory, the Bridge
//     home, HOME/USERPROFILE, CLAUDE_CONFIG_DIR, CODEX_HOME, APPDATA,
//     LOCALAPPDATA and TEMP are ALL isolated below the layout root — the
//     R4 boundary gap (APPDATA/LOCALAPPDATA/CODEX_HOME inherited from the
//     real machine) is closed;
//   * the live product ports are refused;
//   * the ambient module addresses and every ambient Anthropic credential
//     variable are dropped.
//
// Profile contract (R5): the real profile source is GONE. There is no
// read-only facade, no PK_WB_REAL_PROFILE_DIR and no digest of the real
// credential files — the host seeds a purely fictional profile with a fake
// key through the product's own ProfileStore on the isolated data dir.
// realWorkbenchProfileDir() survives only as a pure path-string helper so
// guards can prove no isolated env value points at the real location; it
// performs no filesystem access of its own.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

// The developer's live surfaces. A test may never bind or talk to them.
const FORBIDDEN_PORTS = new Set([5757, 5760, 5789, 5790, 8787, 8790]);

// Ambient module addresses that would point a test at a live instance.
const AMBIENT_MODULE_URLS = [
  'KB_KNOWLEDGE_ENGINE_URL',
  'KB_VECTORHUB_URL',
  'KB_TERMINAL_URL',
  'KB_EVENTBRIDGE_URL',
  'KB_EVENT_BRIDGE_URL',
  'KB_WORKBENCH_RUNTIME_TOKEN',
  'KB_MODULES_AUTOSTART',
];

// Ambient Anthropic credentials: a test must only ever use the credential it
// injects itself, never one that happens to sit in the shell.
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

// Captured before any isolation changes HOME.
const REAL_HOME = os.homedir();
const REAL_USERPROFILE = process.env.USERPROFILE || REAL_HOME;

// The absolute-path members of the isolation whitelist. KB_MODULES_AUTOSTART
// is a flag ('0'), HOMEDRIVE/HOMEPATH are drive-relative companions; none of
// them is a directory of its own.
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

function makeTempDir(prefix = 'parallel-workbench') {
  const root = ensureTempRoot();
  const dir = fs.mkdtempSync(path.join(root, `${prefix}-`));
  if (isInside(dir, REPO_ROOT)) throw new Error(`refusing to create a fixture inside the repository: ${dir}`);
  return dir;
}

function removeTree(dir) {
  if (!dir) return;
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
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

function assertAllowedEndpoint(url, what = 'endpoint') {
  const parsed = new URL(String(url));
  const port = parsed.port ? Number(parsed.port) : (parsed.protocol === 'https:' ? 443 : 80);
  if (FORBIDDEN_PORTS.has(port)) throw new Error(`refusing to contact the live ${what} ${url}`);
  return url;
}

async function waitForHttp(url, timeoutMs = 30000) {
  assertAllowedEndpoint(url, 'service');
  const until = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < until) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (response.ok) return true;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) { lastError = error; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${url}: ${lastError && lastError.message}`);
}

function sanitizedEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  for (const key of AMBIENT_MODULE_URLS) delete env[key];
  for (const key of AMBIENT_MODEL_ENV) delete env[key];
  return env;
}

function spawnNode(args, env = {}) {
  const { spawn } = require('node:child_process');
  const child = spawn(process.execPath, args, {
    env: sanitizedEnv(env),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = { stdout: '', stderr: '' };
  child.stdout.on('data', chunk => { output.stdout += chunk; });
  child.stderr.on('data', chunk => { output.stderr += chunk; });
  const exited = new Promise(resolve => child.once('close', code => resolve({ code, ...output })));
  return { child, exited, output };
}

// --- the isolation directories of one host ---------------------------------
function createIsolationLayout(prefix = 'parallel-workbench') {
  const root = makeTempDir(prefix);
  const layout = {
    root,
    dataDir: path.join(root, 'workbench-data'),
    knowledgeDataDir: path.join(root, 'knowledge-data'),
    bridgeHome: path.join(root, 'bridge-home'),
    home: path.join(root, 'home'),
    claudeConfigDir: path.join(root, 'claude-config'),
    codexHome: path.join(root, 'codex-home'),
    appData: path.join(root, 'appdata'),
    localAppData: path.join(root, 'localappdata'),
    workspace: path.join(root, 'workspace'),
    temp: path.join(root, 'temp'),
  };
  for (const dir of Object.values(layout)) {
    if (typeof dir === 'string') fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(path.join(layout.workspace, 'README.md'), '# Workbench fixture workspace\n', 'utf8');
  // Chrome >= 136 refuses --remote-debugging-port unless it can resolve its
  // DEFAULT user data dir and confirm the passed --user-data-dir differs.
  // The default is derived from %USERPROFILE% (bisect evidence: overriding
  // USERPROFILE alone trips the gate; APPDATA/LOCALAPPDATA/TEMP/HOME do not).
  // An empty default-shaped scaffold under the isolated home lets the
  // resolution succeed, so the real, separate browser-profile directory
  // below this layout is accepted as non-default. The scaffold stays inside
  // the isolated root — nothing of the real machine is touched.
  fs.mkdirSync(path.join(layout.home, 'AppData', 'Local', 'Google', 'Chrome', 'User Data'), { recursive: true });
  fs.mkdirSync(path.join(layout.home, 'AppData', 'Roaming'), { recursive: true });
  return layout;
}

// The complete R5 isolation whitelist: every value an own child (probe, host,
// browser) may resolve through its environment points into this layout.
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
    KB_MODULES_AUTOSTART: '0',
  };
}

// The environment a host child may inherit. Unlike the accepted fixture this
// passes NO real profile directory: there is no real profile source in R5.
function hostEnv(layout, extra = {}) {
  return sanitizedEnv({ ...isolationEnvMap(layout), ...extra });
}

// --- the real profile location (path string ONLY) --------------------------
// Where the product keeps its real profiles, resolved from the real home
// captured at module load. R5 uses this string exclusively to prove that no
// isolated env value points there; this helper never touches the filesystem.
function realWorkbenchProfileDir() {
  return path.join(REAL_HOME, '.project-knowledge-v5', 'workbench');
}

// The module that is hosted: the copy the installed product ships, unless
// the caller pins another one explicitly. Callers must resolve this BEFORE
// applying isolationEnvMap to their own process.env — the discovery reads
// the real APPDATA.
function resolveHostModuleRoot(options = {}) {
  const override = String(options.moduleRoot || process.env.PK_WB_MODULE_ROOT || '').trim();
  if (override) return path.resolve(override);
  const appData = String(process.env.APPDATA || '').trim();
  if (appData) {
    const candidate = path.join(appData, 'npm', 'node_modules', '@sanqianx', 'project-knowledge', 'node_modules', 'claude-ai-workbench');
    if (fs.existsSync(path.join(candidate, 'packages', 'server', 'package.json'))) return candidate;
  }
  const repoPin = path.join(REPO_ROOT, 'node_modules', 'claude-ai-workbench');
  if (fs.existsSync(path.join(repoPin, 'packages', 'server', 'package.json'))) return repoPin;
  return null;
}

module.exports = {
  REPO_ROOT,
  FORBIDDEN_PORTS,
  AMBIENT_MODULE_URLS,
  AMBIENT_MODEL_ENV,
  REAL_HOME,
  REAL_USERPROFILE,
  ISOLATION_PATH_KEYS,
  resolveTempRoot,
  ensureTempRoot,
  makeTempDir,
  removeTree,
  freePort,
  assertAllowedEndpoint,
  waitForHttp,
  sanitizedEnv,
  spawnNode,
  createIsolationLayout,
  isolationEnvMap,
  hostEnv,
  realWorkbenchProfileDir,
  resolveHostModuleRoot,
};
