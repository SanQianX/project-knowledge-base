'use strict';
// Lane-owned fixture helpers for the Workbench provenance batch.
//
// Isolation contract (the batch is allowed to touch nothing of the real
// product):
//   * every directory is created below the shared temp root, never inside
//     the repository;
//   * the Workbench data directory, the Bridge home, the knowledge data
//     directory and HOME/USERPROFILE/CLAUDE_CONFIG_DIR are all isolated, so
//     the spawned Claude Code CLI cannot read or write the developer's
//     ~/.claude, its credentials, its memory or its trust store;
//   * the live product ports are refused;
//   * the ambient module addresses and every ambient Anthropic credential
//     variable are dropped, so a call can only reach the profile the test
//     injects.
//
// Credential contract: the original subscription credential is read from its
// real location READ-ONLY and stays in memory. It is never written to a
// file, a log, a report or a clone, and the profile store handed to the host
// refuses every write method.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

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

function isInside(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function resolveTempRoot() {
  // The batch contract pins a shared temp root next to the repositories;
  // it is honoured when it exists, and everything else falls through so the
  // helper stays portable.
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

// --- the isolation directories of one host -------------------------------
function createIsolationLayout(prefix = 'parallel-workbench') {
  const root = makeTempDir(prefix);
  const layout = {
    root,
    dataDir: path.join(root, 'workbench-data'),
    knowledgeDataDir: path.join(root, 'knowledge-data'),
    bridgeHome: path.join(root, 'bridge-home'),
    home: path.join(root, 'home'),
    claudeConfigDir: path.join(root, 'claude-config'),
    workspace: path.join(root, 'workspace'),
    temp: path.join(root, 'temp'),
  };
  for (const dir of Object.values(layout)) {
    if (typeof dir === 'string') fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(path.join(layout.workspace, 'README.md'), '# Workbench fixture workspace\n', 'utf8');
  return layout;
}

// The environment a host child may inherit.
function hostEnv(layout, extra = {}) {
  const parsed = path.parse(layout.home);
  return sanitizedEnv({
    // The real profile directory is passed explicitly: the child's isolated
    // HOME would otherwise hide it, and the read-only profile facade needs
    // the original location.
    PK_WB_REAL_PROFILE_DIR: realWorkbenchProfileDir(),
    HOME: layout.home,
    USERPROFILE: layout.home,
    HOMEDRIVE: parsed.root,
    HOMEPATH: parsed.root === path.sep ? layout.home.slice(1) : layout.home.slice(parsed.root.length),
    CLAUDE_CONFIG_DIR: layout.claudeConfigDir,
    TEMP: layout.temp,
    TMP: layout.temp,
    TMPDIR: layout.temp,
    KB_DATA_DIR: layout.knowledgeDataDir,
    KB_KNOWLEDGE_DATA_DIR: layout.knowledgeDataDir,
    AI_CODING_EVENT_BRIDGE_HOME: layout.bridgeHome,
    AGENT_TERMINAL_DATA_DIR: layout.dataDir,
    CLAUDE_AI_WORKBENCH_DATA_DIR: layout.dataDir,
    KB_MODULES_AUTOSTART: '0',
    ...extra,
  });
}

// --- the real (read-only) profile source ---------------------------------
// Where the product keeps its profiles. Resolved from the real home, never
// from an isolated one.
function realWorkbenchProfileDir() {
  const override = String(process.env.PK_WB_REAL_PROFILE_DIR || '').trim();
  if (override) return path.resolve(override);
  return path.join(REAL_HOME, '.project-knowledge-v5', 'workbench');
}

// Byte-level snapshot of a flat directory. The SHA256 digests stay in the
// process memory: only counts and file NAMES ever leave compareDigests, so a
// digest of a credential file is never printed, logged or persisted.
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

// A profile store that reads the original profiles and credentials but
// refuses every write. The credential stays in memory: it is never written
// anywhere by this lane.
function createReadOnlyProfileStore(moduleRoot, layout, options = {}) {
  const profileDir = options.profileDir || realWorkbenchProfileDir();
  const profileFile = path.join(profileDir, 'profiles.v2.json');
  const credentialFile = path.join(profileDir, 'credentials.v1.json');
  if (!fs.existsSync(profileFile)) throw new Error(`the original profile file is missing: ${profileFile}`);
  const { ProfileStore } = require(path.join(moduleRoot, 'packages', 'server', 'lib', 'profile-store.js'));
  const store = new ProfileStore({ dataDir: layout.dataDir, profileFile, credentialFile });
  const WRITE_METHODS = new Set(['save', 'delete', 'setCredential', 'setEmbeddingConfig', 'setMaintenanceDefault', 'importLegacy', 'importEmbedding']);
  return new Proxy(store, {
    get(target, property) {
      if (WRITE_METHODS.has(property)) {
        return () => { throw Object.assign(new Error('the profile store of this fixture is read-only'), { status: 409 }); };
      }
      const value = target[property];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

// --- the controlled integration fixture ----------------------------------
// A local knowledge-engine stand-in. It is a FIXTURE: it proves that the
// module consumes an integration context over its documented contract, and
// it is never counted as real knowledge, real retrieval or a real model.
function startIntegrationFixture(options = {}) {
  const requests = [];
  const marker = options.marker || 'WB-INTEGRATION-FIXTURE';
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      let parsed = null;
      try { parsed = body ? JSON.parse(body) : null; } catch { parsed = null; }
      requests.push({ method: req.method, url: req.url, body: parsed });
      if (req.method === 'POST' && req.url === '/api/context') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
          ok: true,
          status: 'ready',
          projectId: 'fixture-project',
          scope: 'fixture',
          references: [{ uri: 'fixture/doc.md', title: 'Fixture reference', score: 0.5 }],
          memories: [{ id: 'fixture-memory', text: `${marker} memory` }],
          memoryCount: 1,
          memoryStatus: 'ready',
          truncated: false,
          requestId: `fixture-request-${requests.length}`,
          prompt: `\n\n${marker}: controlled integration context`,
        }));
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: 'not found' }));
    });
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', async () => {
      const { port } = server.address();
      if (FORBIDDEN_PORTS.has(Number(port))) { server.close(); throw new Error(`refusing to use the live port ${port}`); }
      resolve({
        port,
        url: `http://127.0.0.1:${port}`,
        marker,
        requests,
        close: () => new Promise(done => server.close(() => done())),
      });
    });
  });
}

// The module that is hosted: the copy the installed product ships, unless
// the caller pins another one explicitly.
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
  hostEnv,
  realWorkbenchProfileDir,
  digestDirectory,
  compareDigests,
  createReadOnlyProfileStore,
  startIntegrationFixture,
  resolveHostModuleRoot,
};
