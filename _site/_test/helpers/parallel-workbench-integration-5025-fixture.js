'use strict';
// P-WB-QA-INTEGRATION-5025 fixture — the canonical, clean-checkout isolation
// fixture for the Workbench QA suite, carried forward from the accepted R5
// isolation contract (helpers/parallel-workbench-drafts-r5-fixture.js, frozen)
// with the portability and identity-chain upgrades the integration dispatch
// requires. The frozen originals stay untouched.
//
// Canonical contract:
//   * every directory is created below PK_TEST_TEMP_ROOT when set, otherwise
//     the shared temp root next to the repository when it exists, otherwise
//     TEMP/TMP/TMPDIR, otherwise the OS temp dir — never inside the repository
//     and never a hardcoded drive or user directory;
//   * the Workbench data directory, the knowledge data directory, the Bridge
//     home, HOME/USERPROFILE, CLAUDE_CONFIG_DIR, CODEX_HOME, APPDATA,
//     LOCALAPPDATA and TEMP are ALL isolated below the per-run layout root
//     (the R4 boundary gaps stay closed); each run owns its own root;
//   * an empty default-shaped Chrome "User Data" scaffold is pre-created under
//     the isolated home so Chrome >= 136 accepts the separate, real
//     browser-profile directory as non-default (bisect-proven R5 fix);
//   * the live product ports are refused; ambient module addresses and every
//     ambient Anthropic credential variable are dropped;
//   * NO real-profile machinery: no read-only facade, no
//     PK_WB_REAL_PROFILE_DIR, no digest of real credential files. Pure-UI
//     tools (the drafts probe) must never carry a real profile source.
//     realWorkbenchProfileDir() survives only as a pure path string for guards;
//   * module identity is an INDEPENDENT chain: the expected version defaults
//     to the root package's exact dependency constraint
//     ("claude-ai-workbench": "npm:@sanqianx/claude-ai-workbench@<version>"),
//     never to the module's own self-description; a candidate release can pass
//     an explicit expectedVersion/expectedPin instead.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const sourceMap = require('./parallel-workbench-source-map');

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

// Captured at MODULE LOAD — this fixture is required by every probe BEFORE
// its launcher boot applies isolation, so the load-time environment is still
// the real one (or the safe runner's captured overrides). An AppData install
// resolved HERE keeps its identity no matter what the environment says later;
// an isolated APPDATA can no longer mislabel it as a repository pin.
const INSTALLED_PRODUCT_PACKAGE_AT_LOAD = sourceMap.resolveInstalledProductPackage();

// The installed-product package root, safe to call at ANY time: the explicit
// capture carried through by the launcher boot wins, then the load-time
// capture, and only a process that never isolated falls back to a live read.
function installedProductPackage() {
  const override = String(process.env.PK_WB_INSTALLED_PRODUCT_MODULE || '').trim();
  if (override) return fs.existsSync(override) ? override : null;
  return INSTALLED_PRODUCT_PACKAGE_AT_LOAD;
}

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
  'PSModuleAnalysisCachePath',
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

// The explicit SYSTEM whitelist: the ONLY ambient variables a process of this
// suite may inherit. Matching is case-insensitive because Windows treats
// Path/PATH and SystemRoot/SYSTEMROOT as the same variable. Everything else —
// provider credentials (OPENAI/MINIMAX/GOOGLE/AWS/ANTHROPIC…), NODE_OPTIONS,
// proxy URLs, CODEX/Claude CLI injection vars — is dropped BY CONSTRUCTION:
// the child env is rebuilt from this list, never derived by blacklisting.
const SYSTEM_ENV_WHITELIST = [
  'SystemRoot', 'SystemDrive', 'windir', 'ComSpec', 'PATHEXT',
  'PROCESSOR_ARCHITECTURE', 'PROCESSOR_ARCHITECTURE_W6432', 'PROCESSOR_IDENTIFIER',
  'PROCESSOR_LEVEL', 'PROCESSOR_REVISION', 'NUMBER_OF_PROCESSORS',
  'PATH', 'TEMP', 'TMP', 'TMPDIR',
];

function systemBaseEnv(source = process.env) {
  const allow = new Set(SYSTEM_ENV_WHITELIST.map(name => name.toLowerCase()));
  const base = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && allow.has(key.toLowerCase())) base[key] = value;
  }
  return base;
}

// Child base env: rebuild from the system whitelist, then layer the caller's
// explicit values (isolation map + lane endpoints/fake markers). Lane-specified
// keys win; ambient anything-else never enters. The old ambient delete lists
// stay exported for guard assertions only — scrubbing no longer depends on them.
function sanitizedEnv(extra = {}) {
  return { ...systemBaseEnv(), ...extra };
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

// --- the isolation directories of one run -----------------------------------
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

// The complete isolation whitelist: every value an own child (probe, host,
// browser, census powershell) may resolve through its environment points into
// this layout. Building the map MATERIALIZES the directories it names — the
// env-pointed TEMP dirs and the PSModuleAnalysisCachePath parent must actually
// exist on disk, not merely as strings (a powershell census child that resolves
// a missing cache dir would fall back to the real home).
function isolationEnvMap(layout) {
  const parsed = path.parse(layout.home);
  const psModuleCache = path.join(layout.root, 'ps-module-analysis-cache', 'AnalysisCache');
  fs.mkdirSync(layout.temp, { recursive: true });
  fs.mkdirSync(path.dirname(psModuleCache), { recursive: true });
  if (!fs.statSync(layout.temp).isDirectory()) throw new Error(`isolation TEMP does not exist on disk: ${layout.temp}`);
  if (!fs.statSync(path.dirname(psModuleCache)).isDirectory()) throw new Error(`PSModuleAnalysisCachePath parent does not exist on disk: ${psModuleCache}`);
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
    PSModuleAnalysisCachePath: psModuleCache,
    KB_DATA_DIR: layout.knowledgeDataDir,
    KB_KNOWLEDGE_DATA_DIR: layout.knowledgeDataDir,
    AI_CODING_EVENT_BRIDGE_HOME: layout.bridgeHome,
    AGENT_TERMINAL_DATA_DIR: layout.dataDir,
    CLAUDE_AI_WORKBENCH_DATA_DIR: layout.dataDir,
    KB_MODULES_AUTOSTART: '0',
  };
}

// The environment a host child may inherit. No real profile directory is
// passed: this canonical fixture has no real profile source at all.
function hostEnv(layout, extra = {}) {
  return sanitizedEnv({ ...isolationEnvMap(layout), ...extra });
}

// --- the real profile location (path string ONLY) ----------------------------
// Where the product keeps its real profiles, resolved from the real home
// captured at module load. Guards use this string exclusively to prove that
// no isolated env value points there; this helper never touches the
// filesystem.
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

// --- the independent module identity chain -----------------------------------
//
// The expected Workbench version is NOT read from the hosted module and
// compared with itself: it defaults to the root product package's exact
// dependency constraint, which is a separate, independently written pin. A
// candidate release overrides it with an explicit expectedVersion (and
// optionally an expectedPin of exact file digests).
function sha256File(file) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); } catch { return null; }
}

function rootWorkbenchDependency() {
  const rootPackage = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  const raw = String((rootPackage.dependencies || {})['claude-ai-workbench'] || '');
  const version = raw.includes('@') ? raw.slice(raw.lastIndexOf('@') + 1) : raw;
  return { raw, version };
}

function verifyModuleIdentity(options = {}) {
  const moduleRoot = options.moduleRoot;
  if (!moduleRoot) throw new Error('verifyModuleIdentity requires a moduleRoot');
  const dependency = rootWorkbenchDependency();
  const expectedVersion = options.expectedVersion || dependency.version;
  const identity = sourceMap.packageIdentity(moduleRoot) || {};
  const pin = options.expectedPin || null;
  const pinFiles = {};
  let pinOk = true;
  for (const rel of Object.keys(pin || {})) {
    const actual = sha256File(path.join(moduleRoot, rel));
    pinFiles[rel] = { expected: pin[rel], actual, match: actual === pin[rel] };
    if (actual !== pin[rel]) pinOk = false;
  }
  const versionMatches = identity.version === expectedVersion;
  return {
    moduleRoot,
    expected: {
      source: options.expectedVersion ? 'explicit (candidate release)' : 'root-package-dependency',
      dependencyRaw: dependency.raw || null,
      version: expectedVersion,
    },
    actual: { name: identity.name || null, version: identity.version || null },
    versionMatches,
    pin: pin ? { checked: Object.keys(pin), ok: pinOk, files: pinFiles } : null,
    ok: versionMatches && pinOk,
  };
}

module.exports = {
  REPO_ROOT,
  FORBIDDEN_PORTS,
  AMBIENT_MODULE_URLS,
  AMBIENT_MODEL_ENV,
  REAL_HOME,
  REAL_USERPROFILE,
  INSTALLED_PRODUCT_PACKAGE_AT_LOAD,
  installedProductPackage,
  ISOLATION_PATH_KEYS,
  SYSTEM_ENV_WHITELIST,
  systemBaseEnv,
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
  sha256File,
  rootWorkbenchDependency,
  verifyModuleIdentity,
};
