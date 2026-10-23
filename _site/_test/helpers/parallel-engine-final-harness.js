'use strict';

// P-ENG-FINAL lane-exclusive harness (parallel-20261023 batch, engine-final).
//
// Self-contained: this lane does NOT require the P-ENG-ADVANCED helpers (those
// are frozen read-only for the Leader). Everything the drivers need is real:
//
//   * real fixture Git repositories (isolated git config, repo-local only)
//   * a REAL post-commit hook (separate OS process running the real
//     ai-coding-event-bridge commit-boundary CLI from the pinned package)
//   * the real ai-coding-event-bridge console server (in-process, isolated
//     --home journal; pinned @sanqianx package by default, source checkout
//     only via PK_TEST_BRIDGE_ROOT)
//   * the real vector-hub server (in-process, isolated root + deterministic
//     test embeddings: the paid embedding API is NOT exercised; pinned
//     @sanqianx/vector-hub package by default, source checkout only via
//     PK_TEST_VECTOR_ROOT)
//   * the real VENDORED knowledge-engine (in-process, isolated data dir)
//
// Isolation: lane temp root at PK_TEST_TEMP_ROOT or os.tmpdir() (never inside
// the repo), ephemeral 127.0.0.1 ports,
// scrubbed child env (no KB_*/KNOWLEDGE_*/ANTHROPIC_*/CLAUDE*/GLM/MINIMAX
// leakage), isolated HOME/USERPROFILE/APPDATA/TEMP, GIT_CONFIG_NOSYSTEM=1 and
// GIT_CONFIG_GLOBAL pointed at a non-existent file (the user's global git
// config and hooks are never read or written).

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const VENDORED_ENGINE_SERVER = path.join(REPO_ROOT, '_modules', 'knowledge-engine', 'src', 'server.js');
const VENDORED_ATOMIC_FILE = path.join(REPO_ROOT, '_modules', 'knowledge-engine', 'src', 'runtime', 'atomic-file.js');

// Pinned runtime by default: the root repo's installed
// @sanqianx/ai-coding-event-bridge-console@0.7.2 and @sanqianx/vector-hub@1.0.8-rc.8
// (identity-checked below), so the drivers are portable to any checkout of this
// repo. A sibling SOURCE checkout may be substituted only through the explicit
// env overrides PK_TEST_BRIDGE_ROOT / PK_TEST_VECTOR_ROOT.
function resolveRuntimeRoot(envVar, pinnedDir, pinnedVersion) {
  const fromEnv = process.env[envVar];
  const root = path.resolve(fromEnv || pinnedDir);
  if (!fs.existsSync(root)) throw new Error(`runtime root ${root} does not exist (${fromEnv ? `${envVar} override` : `pinned ${pinnedVersion} install`} is missing)`);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  if (!fromEnv && manifest.version !== pinnedVersion) {
    throw new Error(`pinned runtime at ${root} is ${manifest.version}, expected ${pinnedVersion}`);
  }
  return { root, version: manifest.version, origin: fromEnv ? `env ${envVar}` : 'pinned package' };
}

const BRIDGE = resolveRuntimeRoot('PK_TEST_BRIDGE_ROOT', path.join(REPO_ROOT, 'node_modules', '@sanqianx', 'ai-coding-event-bridge-console'), '0.7.2');
const VECTOR = resolveRuntimeRoot('PK_TEST_VECTOR_ROOT', path.join(REPO_ROOT, 'node_modules', '@sanqianx', 'vector-hub'), '1.0.8-rc.8');
const BRIDGE_ROOT = BRIDGE.root;
const BRIDGE_CLI = path.join(BRIDGE_ROOT, 'src', 'bridge', 'bin', 'commit-boundary.js');
const VECTOR_ROOT = VECTOR.root;

// Temp root: PK_TEST_TEMP_ROOT or the OS temp dir; never inside the repository.
const TEMP_ROOT = (() => {
  const base = path.resolve(process.env.PK_TEST_TEMP_ROOT || path.join(os.tmpdir(), 'project-knowledge-engine-test'));
  if (base === REPO_ROOT || base.startsWith(REPO_ROOT + path.sep)) {
    throw new Error(`temp root must live outside the repository (got ${base})`);
  }
  return base;
})();

function ensureTempRoot() {
  fs.mkdirSync(TEMP_ROOT, { recursive: true });
  return TEMP_ROOT;
}

function makeLaneDir(label) {
  ensureTempRoot();
  return fs.mkdtempSync(path.join(TEMP_ROOT, `${label}-`));
}

// Scrubbed environment: no profile/quota/credential leakage, isolated HOME and
// TEMP, isolated git config. Nothing here relies on the caller unsetting vars.
function isolatedEnv(extra = {}) {
  const home = extra.ISOLATED_HOME || path.join(ensureTempRoot(), 'isolated-home');
  fs.mkdirSync(home, { recursive: true });
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (/^(KB_|KNOWLEDGE_|ANTHROPIC_|CLAUDE|OPENAI_|CODEX|MINIMAX|GLM|AI_CODING_EVENT_BRIDGE|PK_TEST_)/i.test(name)) delete env[name];
  }
  const tmp = path.join(ensureTempRoot(), 'tmp');
  fs.mkdirSync(tmp, { recursive: true });
  env.HOME = home;
  env.USERPROFILE = home;
  env.APPDATA = path.join(home, 'AppData', 'Roaming');
  env.LOCALAPPDATA = path.join(home, 'AppData', 'Local');
  env.TEMP = tmp;
  env.TMP = tmp;
  env.TMPDIR = tmp;
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_GLOBAL = path.join(home, 'does-not-exist.gitconfig');
  env.AI_CODING_EVENT_BRIDGE_HOME = path.join(home, 'bridge-home');
  env.BRIDGE_CONSOLE_PICK_FOLDER = '0';
  return { ...env, ...extra };
}

// git with the isolated config; returns {code, stdout, stderr} so a driver can
// assert the real exit code of a commit whose hook failed.
function gitRun(repoPath, args) {
  const result = spawnSync('git', args, { cwd: repoPath, windowsHide: true, encoding: 'utf8', env: isolatedEnv() });
  return { code: result.status, stdout: (result.stdout || '').trim(), stderr: (result.stderr || '').trim() };
}

function git(repoPath, args) {
  const result = gitRun(repoPath, args);
  if (result.code !== 0) throw new Error(`git ${args.join(' ')} failed (${result.code}): ${result.stderr}`);
  return result.stdout;
}

// Real fixture repository: init + baseline + one labeled commit per entry.
function buildFixtureRepo(root, name, commits = []) {
  const repoPath = path.join(root, `repo-${name}`);
  fs.mkdirSync(repoPath, { recursive: true });
  git(repoPath, ['init', '-q']);
  git(repoPath, ['config', 'user.email', 'engine-final@test.invalid']);
  git(repoPath, ['config', 'user.name', 'P-ENG-FINAL']);
  fs.writeFileSync(path.join(repoPath, 'README.md'), `# ${name}\n\nFixture repository.\n`);
  git(repoPath, ['add', '.']);
  git(repoPath, ['commit', '-qm', 'baseline']);
  const baseline = git(repoPath, ['rev-parse', 'HEAD']);
  const shas = {};
  for (const label of commits) {
    fs.writeFileSync(path.join(repoPath, `${label}.txt`), `change ${name} ${label}\n` + 'x'.repeat(64) + '\n');
    git(repoPath, ['add', '.']);
    git(repoPath, ['commit', '-qm', `feature ${label}`]);
    shas[label] = git(repoPath, ['rev-parse', 'HEAD']);
  }
  return { repoPath, baseline, shas };
}

// Real git hook inside the FIXTURE repository only (.git/hooks/post-commit).
// The user's global git config and global hooks are never touched.
function installPostCommitHook(repoPath, { home, mode = 'ok' }) {
  const hookPath = path.join(repoPath, '.git', 'hooks', 'post-commit');
  const slash = value => value.replace(/\\/g, '/');
  const cli = mode === 'ok' ? slash(BRIDGE_CLI) : slash(path.join(BRIDGE_ROOT, 'src', 'bridge', 'bin', 'commit-boundary.missing.js'));
  const script = [
    '#!/bin/sh',
    mode === 'ok' ? `"${slash(process.execPath)}" "${cli}" --home "${slash(home)}" --cwd "${slash(repoPath)}" >/dev/null 2>&1` : `"${slash(process.execPath)}" "${cli}" --home "${slash(home)}" --cwd "${slash(repoPath)}"`,
    'exit 1',
    '',
  ].join('\n');
  fs.mkdirSync(path.dirname(hookPath), { recursive: true });
  fs.writeFileSync(hookPath, script, { mode: 0o755 });
  return { hookPath, mode, content: script };
}

// Real bridge console + journal, isolated home, ephemeral loopback port.
function startBridge(home) {
  fs.mkdirSync(home, { recursive: true });
  const { createBridge, projectRegistry, resolveRepoContext } = require(path.join(BRIDGE_ROOT, 'src', 'bridge'));
  const { createConsoleServer } = require(path.join(BRIDGE_ROOT, 'src', 'server'));
  const bridge = createBridge({ homeDir: home });
  const server = http.createServer(createConsoleServer({ home }));
  return {
    home, bridge, projectRegistry, resolveRepoContext, server,
    async listen() {
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      return `http://127.0.0.1:${server.address().port}`;
    },
    async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); },
  };
}

// Real vector-hub server on an isolated root. Embeddings are deterministic test
// vectors (the paid embedding API is NOT exercised - stated as a boundary).
function startVector(root) {
  fs.mkdirSync(root, { recursive: true });
  const { HubManager } = require(path.join(VECTOR_ROOT, 'dist', 'cjs', 'server', 'manager'));
  const { createServer } = require(path.join(VECTOR_ROOT, 'dist', 'cjs', 'server', 'server'));
  const embeddingsFactory = () => ({
    maxTokens: 500,
    async createEmbeddings(inputs) {
      const texts = Array.isArray(inputs) ? inputs : [inputs];
      return { status: 'success', output: texts.map((text, index) => [1, 0, index / 1000]) };
    },
  });
  return HubManager.load({
    rootPath: path.join(root, 'indexes'),
    configPath: path.join(root, 'vector-config.json'),
    embeddingsFactory,
  }).then(async manager => {
    await manager.saveSettings({ provider: 'minimax', apiKey: 'embedding-test-marker' });
    const server = http.createServer(createServer(manager));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return {
      manager, server,
      url: `http://127.0.0.1:${server.address().port}`,
      async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); manager.close?.(); },
    };
  });
}

// Real vendored knowledge-engine, in-process, isolated data dir.
function startEngine({ dataDir, bridgeUrl, vectorUrl, analyzer, debug = true, consume = true, runtimeToken = null }) {
  fs.mkdirSync(dataDir, { recursive: true });
  const { createEngineServer } = require(VENDORED_ENGINE_SERVER);
  const runtime = createEngineServer({ dataDir, consume, debug, analyzer, bridgeUrl, vectorUrl, runtimeToken });
  return {
    runtime,
    async listen() {
      await runtime.ready;
      await new Promise(resolve => runtime.server.listen(0, '127.0.0.1', resolve));
      return `http://127.0.0.1:${runtime.server.address().port}`;
    },
    async close() { await runtime.close(); },
  };
}

async function waitUntil(fn, timeoutMs, describe) {
  const started = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error(`waitUntil timed out after ${timeoutMs}ms: ${describe}`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

async function callJson(base, route, body, init = {}) {
  const response = await fetch(`${base}${route}`, {
    ...init,
    method: body === undefined && !init.method ? 'GET' : init.method || 'POST',
    headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
    body: body === undefined && (!init.method || init.method === 'GET') ? undefined : JSON.stringify(body),
  });
  let payload = null;
  try { payload = await response.json(); } catch { payload = null; }
  return { status: response.status, body: payload };
}

// Fire a request and drop the response (simulates a lost network answer).
function callJsonAndLoseResponse(base, route, body) {
  return new Promise(resolve => {
    const url = new URL(route, base);
    const payload = JSON.stringify(body || {});
    const request = http.request({
      hostname: url.hostname, port: url.port, path: url.pathname + url.search, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    });
    request.on('error', () => resolve({ lost: true, error: 'socket-error' }));
    request.end(payload);
    setTimeout(() => { request.destroy(); resolve({ lost: true, error: 'response-dropped' }); }, 120);
  });
}

function listFilesRecursive(root) {
  const out = [];
  if (!fs.existsSync(root)) return out;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...listFilesRecursive(absolute).map(sub => `${entry.name}/${sub}`));
    else out.push(entry.name);
  }
  return out.sort();
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
}

function saveEvidence(laneDir, name, value) {
  fs.mkdirSync(laneDir, { recursive: true });
  fs.writeFileSync(path.join(laneDir, name), JSON.stringify(value, null, 2));
}

function hashText(value) {
  return require('node:crypto').createHash('sha256').update(value).digest('hex');
}

module.exports = {
  REPO_ROOT,
  VENDORED_ENGINE_SERVER,
  VENDORED_ATOMIC_FILE,
  RUNTIME_IDENTITY: { bridge: BRIDGE, vector: VECTOR },
  BRIDGE_ROOT,
  BRIDGE_CLI,
  VECTOR_ROOT,
  TEMP_ROOT,
  ensureTempRoot,
  makeLaneDir,
  isolatedEnv,
  git,
  gitRun,
  buildFixtureRepo,
  installPostCommitHook,
  startBridge,
  startVector,
  startEngine,
  waitUntil,
  callJson,
  callJsonAndLoseResponse,
  listFilesRecursive,
  readJsonl,
  saveEvidence,
  hashText,
};
