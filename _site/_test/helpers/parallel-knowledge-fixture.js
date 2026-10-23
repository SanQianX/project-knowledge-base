'use strict';
// Lane-owned fixture helpers for the parallel knowledge verification batch.
// Portability contract: nothing here may hard-code a developer path.
// The temp root is resolved as PK_TEST_TEMP_ROOT -> TEMP/TMP/TMPDIR ->
// os.tmpdir(), and every artefact is created with mkdtemp outside the
// repository, so the same helpers work on a developer machine and on CI.
// Isolation contract: the helpers themselves clear the ambient module URLs
// and the live data directories, so a test entry point never depends on the
// caller remembering `env -u`, and never reaches the developer's real
// 5757/5790/8787/8790 endpoints or the real HOME.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const { execFileSync, spawn } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

// The developer's live surfaces. A test may never bind or talk to them.
const FORBIDDEN_PORTS = new Set([5757, 5790, 8787, 8790]);

// Ambient module addresses that would otherwise point a test at a live
// instance. The product falls back to them when no explicit URL is given.
const AMBIENT_MODULE_URLS = [
  'KB_KNOWLEDGE_ENGINE_URL',
  'KB_VECTORHUB_URL',
  'KB_TERMINAL_URL',
  'KB_EVENTBRIDGE_URL',
  'KB_EVENT_BRIDGE_URL',
];

function isInside(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function resolveTempRoot() {
  const candidates = [process.env.PK_TEST_TEMP_ROOT, process.env.TEMP, process.env.TMP, process.env.TMPDIR];
  const chosen = candidates.find(value => value && String(value).trim());
  const root = path.resolve(chosen ? String(chosen).trim() : os.tmpdir());
  if (isInside(root, REPO_ROOT)) {
    throw new Error(`refusing to use a temp root inside the repository: ${root}`);
  }
  return root;
}

function ensureTempRoot() {
  const root = resolveTempRoot();
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function makeTempDir(prefix = 'parallel-knowledge') {
  const root = ensureTempRoot();
  const dir = fs.mkdtempSync(path.join(root, `${prefix}-`));
  if (isInside(dir, REPO_ROOT)) throw new Error(`refusing to create a fixture inside the repository: ${dir}`);
  return dir;
}

function git(cwd, args) {
  return execFileSync('git', args, { cwd, windowsHide: true, encoding: 'utf8' }).trim();
}

function sha256Buffer(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function sha256File(filePath) {
  return fs.existsSync(filePath) ? sha256Buffer(fs.readFileSync(filePath)) : null;
}

// A real Git worktree with real commits. `files` are committed in order.
function makeRepo(root, name, commits = []) {
  const repoPath = path.join(root, name);
  fs.mkdirSync(repoPath, { recursive: true });
  git(repoPath, ['init', '-q']);
  git(repoPath, ['config', 'user.email', 'parallel-knowledge@local.invalid']);
  git(repoPath, ['config', 'user.name', 'Parallel Knowledge Test']);
  git(repoPath, ['config', 'commit.gpgsign', 'false']);
  const shas = [];
  for (const commit of commits) {
    for (const [file, content] of Object.entries(commit.files || {})) {
      const target = path.join(repoPath, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content, 'utf8');
    }
    git(repoPath, ['add', '-A']);
    git(repoPath, ['commit', '-q', '-m', commit.message || 'fixture commit']);
    shas.push(git(repoPath, ['rev-parse', 'HEAD']));
  }
  return { repoPath, shas, head: shas[shas.length - 1] || null };
}

function makeKnowledgeDir(root, name) {
  const knowledgePath = path.join(root, name);
  fs.mkdirSync(knowledgePath, { recursive: true });
  return knowledgePath;
}

// Relative path -> sha256 for every file below `dir`.
function hashTree(dir) {
  const out = {};
  if (!fs.existsSync(dir)) return out;
  const walk = current => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else out[path.relative(dir, absolute).replace(/\\/g, '/')] = sha256File(absolute);
    }
  };
  walk(dir);
  return out;
}

function assertAllowedPort(port, what = 'port') {
  if (FORBIDDEN_PORTS.has(Number(port))) {
    throw new Error(`refusing to use the live ${what} ${port}`);
  }
  return Number(port);
}

function assertAllowedEndpoint(url, what = 'endpoint') {
  const parsed = new URL(String(url));
  const port = parsed.port ? Number(parsed.port) : (parsed.protocol === 'https:' ? 443 : 80);
  if (FORBIDDEN_PORTS.has(port)) throw new Error(`refusing to contact the live ${what} ${url}`);
  return url;
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => {
        try { resolve(assertAllowedPort(port)); } catch (error) { reject(error); }
      });
    });
  });
}

async function waitForHttp(url, timeoutMs = 20000) {
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

// The environment a child may inherit: no ambient module address, no live
// data directory, no real HOME.
function sanitizedEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  for (const key of AMBIENT_MODULE_URLS) delete env[key];
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

async function eventually(fn, timeoutMs = 15000, intervalMs = 25) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await fn()) return true;
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  return false;
}

function removeTree(dir) {
  if (!dir) return;
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

// Isolate the current process. This MUST run before any product module is
// required, because the product reads its data directories and module
// addresses from the environment. It returns the isolated paths so the
// caller can clean them up.
function isolateProcess() {
  if (isolateProcess.done) return isolateProcess.state;
  const root = makeTempDir('parallel-knowledge-isolate');
  const dataHome = path.join(root, 'kb-data');
  const knowledgeHome = path.join(root, 'kb-knowledge-data');
  const bridgeHome = path.join(root, 'event-bridge-home');
  const home = path.join(root, 'home');
  for (const dir of [dataHome, knowledgeHome, bridgeHome, home]) fs.mkdirSync(dir, { recursive: true });

  for (const key of AMBIENT_MODULE_URLS) delete process.env[key];
  process.env.KB_DATA_DIR = dataHome;
  process.env.KB_KNOWLEDGE_DATA_DIR = knowledgeHome;
  process.env.AI_CODING_EVENT_BRIDGE_HOME = bridgeHome;
  process.env.KB_MODULES_AUTOSTART = '0';

  // The real HOME must never be read or written by a lane test.
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  const parsed = path.parse(home);
  process.env.HOMEDRIVE = parsed.root;
  process.env.HOMEPATH = parsed.root === path.sep ? home.slice(1) : home.slice(parsed.root.length);

  isolateProcess.state = { root, dataHome, knowledgeHome, bridgeHome, home };
  isolateProcess.done = true;
  return isolateProcess.state;
}

function cleanupIsolatedProcess() {
  if (!isolateProcess.done) return;
  removeTree(isolateProcess.state.root);
  isolateProcess.done = false;
  isolateProcess.state = null;
}

module.exports = {
  REPO_ROOT,
  FORBIDDEN_PORTS,
  AMBIENT_MODULE_URLS,
  resolveTempRoot,
  ensureTempRoot,
  makeTempDir,
  makeRepo,
  makeKnowledgeDir,
  hashTree,
  sha256File,
  sha256Buffer,
  git,
  freePort,
  waitForHttp,
  spawnNode,
  sanitizedEnv,
  eventually,
  removeTree,
  assertAllowedPort,
  assertAllowedEndpoint,
  isolateProcess,
  cleanupIsolatedProcess,
};
