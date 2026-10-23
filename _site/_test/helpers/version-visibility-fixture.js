'use strict';
// FEATURE-VERSIONS-01-R2 fixture — the version-visibility lane's own isolation
// contract, borrowed from the accepted drafts-r5 fixture (read-only reuse of
// its patterns; that file stays untouched):
//   * every directory lives under a repo-external temp root (PK_TEST_TEMP_ROOT
//     → repo-parent shared root when it exists → TEMP/TMP/TMPDIR → os.tmpdir),
//     never inside the repository, never on a hardcoded drive/user dir;
//   * the full env whitelist (HOME/USERPROFILE/HOMEDRIVE/HOMEPATH/CODEX_HOME/
//     CLAUDE_CONFIG_DIR/APPDATA/LOCALAPPDATA/TEMP/TMP/TMPDIR/双 KB_DATA_DIR/
//     Bridge home/Workbench data) is absolute-pathed into one per-run layout
//     root; ambient module addresses and Anthropic credentials are stripped;
//   * the live product ports 5757/5760/5789/5790/8787/8790 are refused;
//   * Chrome is resolved from the REAL machine before any isolation is applied
//     (find-chrome reads the real environment), then run with an isolated
//     --user-data-dir plus the Chrome>=136 empty-default-dir scaffold under the
//     isolated home so remote debugging is accepted.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { findChromeDetailed } = require('./find-chrome');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const FORBIDDEN_PORTS = new Set([5757, 5760, 5789, 5790, 8787, 8790]);

const AMBIENT_MODULE_URLS = [
  'KB_KNOWLEDGE_ENGINE_URL', 'KB_VECTORHUB_URL', 'KB_TERMINAL_URL', 'KB_EVENTBRIDGE_URL', 'KB_EVENT_BRIDGE_URL',
  'KB_WORKBENCH_RUNTIME_TOKEN', 'KB_MODULES_AUTOSTART',
];
const AMBIENT_MODEL_ENV = [
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_THINKING_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_OP_MODEL', 'API_TIMEOUT_MS', 'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY',
];

const ISOLATION_PATH_KEYS = [
  'HOME', 'USERPROFILE', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'APPDATA', 'LOCALAPPDATA',
  'TEMP', 'TMP', 'TMPDIR', 'KB_DATA_DIR', 'KB_KNOWLEDGE_DATA_DIR',
  'AI_CODING_EVENT_BRIDGE_HOME', 'AGENT_TERMINAL_DATA_DIR', 'CLAUDE_AI_WORKBENCH_DATA_DIR',
];

// Captured at module load, BEFORE any isolation could hide the real machine:
// the browser binary this lane's UI acceptance will drive.
const CHROME_PATH = findChromeDetailed().path;

function isInside(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function resolveTempRoot() {
  const sharedRoot = path.join(path.dirname(REPO_ROOT), '.project-knowledge-test-temp');
  const candidates = [process.env.PK_TEST_TEMP_ROOT, fs.existsSync(sharedRoot) ? sharedRoot : null, process.env.TEMP, process.env.TMP, process.env.TMPDIR];
  const chosen = candidates.find(value => value && String(value).trim());
  const root = path.resolve(chosen ? String(chosen).trim() : os.tmpdir());
  if (isInside(root, REPO_ROOT)) throw new Error(`refusing to use a temp root inside the repository: ${root}`);
  return root;
}

function makeTempDir(prefix = 'version-visibility') {
  const root = resolveTempRoot();
  fs.mkdirSync(root, { recursive: true });
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

async function waitForHttp(url, timeoutMs = 45000) {
  assertAllowedEndpoint(url, 'service');
  const until = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < until) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (response.ok) return true;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) { lastError = error; }
    await new Promise(resolve => setTimeout(resolve, 120));
  }
  throw new Error(`Timed out waiting for ${url}: ${lastError && lastError.message}`);
}

function sanitizedEnv(extra = {}, source = process.env) {
  const env = {};
  const systemKey = /^(?:PATH|PATHEXT|SYSTEMROOT|WINDIR|SYSTEMDRIVE|COMSPEC|OS|PROCESSOR_ARCHITECTURE|PROCESSOR_IDENTIFIER|PROCESSOR_LEVEL|PROCESSOR_REVISION|NUMBER_OF_PROCESSORS|PROGRAMFILES(?:\(X86\))?|PROGRAMW6432|PROGRAMDATA|LANG|LC_ALL|LC_CTYPE|TERM)$/i;
  for (const [key, value] of Object.entries(source)) {
    if (systemKey.test(key)) env[key] = value;
  }
  // Only the inherited environment is filtered. Explicit lane URLs and the
  // disabled autostart flag must survive, or the server uses live defaults.
  return { ...env, ...extra };
}

function spawnNode(args, env = {}) {
  const { spawn } = require('node:child_process');
  const child = spawn(process.execPath, args, { env: sanitizedEnv(env), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const output = { stdout: '', stderr: '' };
  child.stdout.on('data', chunk => { output.stdout += chunk; });
  child.stderr.on('data', chunk => { output.stderr += chunk; });
  const exited = new Promise(resolve => child.once('close', code => resolve({ code, ...output })));
  return { child, exited, output };
}

function createIsolationLayout(prefix = 'version-visibility') {
  const root = makeTempDir(prefix);
  const layout = {
    root,
    dataDir: path.join(root, 'kb-data'),
    knowledgeDataDir: path.join(root, 'knowledge-data'),
    bridgeHome: path.join(root, 'bridge-home'),
    workbenchDataDir: path.join(root, 'workbench-data'),
    home: path.join(root, 'home'),
    claudeConfigDir: path.join(root, 'claude-config'),
    codexHome: path.join(root, 'codex-home'),
    appData: path.join(root, 'appdata'),
    localAppData: path.join(root, 'localappdata'),
    temp: path.join(root, 'temp'),
  };
  for (const dir of Object.values(layout)) fs.mkdirSync(dir, { recursive: true });
  // Chrome >= 136 gate: an empty default-shaped "User Data" scaffold under the
  // ISOLATED home lets the default-dir resolution succeed, so the separate
  // --user-data-dir browser profile below this layout is accepted. Nothing of
  // the real machine is touched.
  fs.mkdirSync(path.join(layout.home, 'AppData', 'Local', 'Google', 'Chrome', 'User Data'), { recursive: true });
  fs.mkdirSync(path.join(layout.home, 'AppData', 'Roaming'), { recursive: true });
  return layout;
}

function isolationEnvMap(layout, extraPaths = {}) {
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
    PSModuleAnalysisCachePath: path.join(layout.temp, 'powershell-module-cache'),
    KB_DATA_DIR: layout.dataDir,
    KB_KNOWLEDGE_DATA_DIR: layout.knowledgeDataDir,
    AI_CODING_EVENT_BRIDGE_HOME: layout.bridgeHome,
    AGENT_TERMINAL_DATA_DIR: layout.workbenchDataDir,
    CLAUDE_AI_WORKBENCH_DATA_DIR: layout.workbenchDataDir,
    KB_MODULES_AUTOSTART: '0',
    ...extraPaths,
  };
}

function hostEnv(layout, extra = {}) {
  return sanitizedEnv(isolationEnvMap(layout, extra));
}

function applyIsolationEnv(layout) {
  const env = hostEnv(layout);
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, env);
}

// The product server under test: real _site/server.js, fully isolated, with
// every module address explicitly held on this run's own free ports (so the
// process can never reach for the live defaults 5760/8787/8790/5790).
async function startRootServer(layout, options = {}) {
  const port = options.port || await freePort();
  const [terminalPort, vectorHubPort, eventBridgePort, enginePort] = await Promise.all([freePort(), freePort(), freePort(), freePort()]);
  const env = hostEnv(layout, {
    KB_SITE_PORT: String(port),
    KB_SITE_HOST: '127.0.0.1',
    KB_TERMINAL_URL: `http://127.0.0.1:${terminalPort}`,
    KB_VECTORHUB_URL: `http://127.0.0.1:${vectorHubPort}`,
    KB_EVENTBRIDGE_URL: `http://127.0.0.1:${eventBridgePort}`,
    KB_KNOWLEDGE_ENGINE_URL: `http://127.0.0.1:${enginePort}`,
  });
  const runner = spawnNode([path.join(REPO_ROOT, '_site', 'server.js')], env);
  const base = `http://127.0.0.1:${port}`;
  await waitForHttp(`${base}/api/system/version`);
  return { layout, port, base, runner, modulePorts: { terminalPort, vectorHubPort, eventBridgePort, enginePort } };
}

async function stopRootServer(server) {
  if (!server || !server.runner) return;
  server.runner.child.kill();
  await server.runner.exited;
}

// The honest-unknown branch: serve the REAL ui/ assets from disk, but fail the
// version GET — the tooltip must then say 版本未知 instead of inventing one.
async function startVersionBrokenUiServer(layout, options = {}) {
  const port = options.port || await freePort();
  const uiRoot = path.join(REPO_ROOT, 'ui');
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
  const http = require('node:http');
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
    if (pathname === '/api/system/version') {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false }));
      return;
    }
    const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\//, '');
    const file = path.join(uiRoot, rel);
    if (!isInside(path.resolve(file), uiRoot) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
    res.end(fs.readFileSync(file));
  });
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  return { layout, port, base: `http://127.0.0.1:${port}`, server };
}

module.exports = {
  REPO_ROOT, FORBIDDEN_PORTS, AMBIENT_MODULE_URLS, AMBIENT_MODEL_ENV, ISOLATION_PATH_KEYS,
  CHROME_PATH, resolveTempRoot, makeTempDir, removeTree, freePort, assertAllowedEndpoint,
  waitForHttp, sanitizedEnv, spawnNode, createIsolationLayout, isolationEnvMap, hostEnv, applyIsolationEnv,
  startRootServer, stopRootServer, startVersionBrokenUiServer,
};
