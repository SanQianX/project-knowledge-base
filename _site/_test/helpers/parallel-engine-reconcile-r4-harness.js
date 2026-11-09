'use strict';

// P-ENGINE-RECONCILE-R4 lane-exclusive harness (batch parallel-20261023).
//
// Self-contained: it does NOT require the frozen R3 helpers (those are frozen
// for the Leader to integrate). Everything the R4 probe needs is real:
//
//   * real fixture Git repositories (isolated git config, repo-local hooks only)
//   * a REAL post-commit hook (separate OS process running the real
//     ai-coding-event-bridge commit-boundary CLI from the pinned package);
//     the "broken" mode points at a non-existent CLI so the hook FAILS for
//     real and the commit never reaches the journal
//   * the real ai-coding-event-bridge console server (in-process, isolated
//     --home journal; pinned @sanqianx package by default, a source checkout
//     only through PK_TEST_BRIDGE_ROOT)
//   * the real vector-hub server (in-process, isolated root + deterministic
//     test embeddings: the paid embedding API is NOT exercised; pinned
//     @sanqianx/vector-hub by default, a source checkout only through
//     PK_TEST_VECTOR_ROOT)
//   * the knowledge-engine under test (in-process, isolated data dir): the
//     VENDORED bytes by default, a source checkout only through
//     PK_TEST_ENGINE_ROOT (the candidate host for the R4 fix)
//
// Isolation: lane temp root at PK_TEST_TEMP_ROOT or os.tmpdir() (never inside
// the repository), ephemeral 127.0.0.1 ports, scrubbed child env (no
// KB_*/KNOWLEDGE_*/ANTHROPIC_*/CLAUDE*/GLM/MINIMAX leakage), isolated
// HOME/USERPROFILE/APPDATA/TEMP, GIT_CONFIG_NOSYSTEM=1 and GIT_CONFIG_GLOBAL
// pointed at a non-existent file (the user's global git config and hooks are
// never read or written).

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const VENDORED_ENGINE_ROOT = path.join(path.dirname(require.resolve('@sanqianx/ai-coding-knowledge-engine/package.json', { paths: [path.join(REPO_ROOT)] })));
const VENDORED_ENGINE_VERSION = '0.2.7-rc.10';

function resolveRuntimeRoot(envVar, pinnedDir, pinnedVersion) {
  const fromEnv = process.env[envVar];
  const root = path.resolve(fromEnv || pinnedDir);
  if (!fs.existsSync(root)) {
    throw new Error(`runtime root ${root} does not exist (${fromEnv ? `${envVar} override` : `pinned ${pinnedVersion} install`} is missing)`);
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  if (!fromEnv && manifest.version !== pinnedVersion) {
    throw new Error(`pinned runtime at ${root} is ${manifest.version}, expected ${pinnedVersion}`);
  }
  return { root, version: manifest.version, origin: fromEnv ? `env ${envVar}` : 'pinned package' };
}

// The engine under test. Default = the vendored bytes shipped in this repo
// (the PINNED bytes). PK_TEST_ENGINE_ROOT points at a source checkout of the
// module (the CANDIDATE bytes that carry the R4 fix).
function resolveEngineRoot() {
  const fromEnv = process.env.PK_TEST_ENGINE_ROOT;
  const root = path.resolve(fromEnv || VENDORED_ENGINE_ROOT);
  if (!fs.existsSync(path.join(root, 'src', 'server.js'))) {
    throw new Error(`engine root ${root} has no src/server.js (${fromEnv ? 'PK_TEST_ENGINE_ROOT override' : 'vendored copy'} is missing)`);
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  return {
    root,
    version: manifest.version,
    origin: fromEnv ? 'env PK_TEST_ENGINE_ROOT (candidate source checkout)' : 'vendored _modules copy (pinned bytes)',
    candidate: Boolean(fromEnv),
  };
}

const BRIDGE = resolveRuntimeRoot('PK_TEST_BRIDGE_ROOT', path.join(REPO_ROOT, 'node_modules', '@sanqianx', 'ai-coding-event-bridge-console'), '0.7.2');
const VECTOR = resolveRuntimeRoot('PK_TEST_VECTOR_ROOT', path.join(REPO_ROOT, 'node_modules', '@sanqianx', 'vector-hub'), '1.0.8-rc.8');
const BRIDGE_ROOT = BRIDGE.root;
const BRIDGE_CLI = path.join(BRIDGE_ROOT, 'src', 'bridge', 'bin', 'commit-boundary.js');
const VECTOR_ROOT = VECTOR.root;

// Temp root: PK_TEST_TEMP_ROOT or the OS temp dir; never inside the repository.
const TEMP_ROOT = (() => {
  const base = path.resolve(process.env.PK_TEST_TEMP_ROOT || path.join(os.tmpdir(), 'project-knowledge-engine-r4-test'));
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
  git(repoPath, ['config', 'user.email', 'engine-reconcile-r4@test.invalid']);
  git(repoPath, ['config', 'user.name', 'P-ENGINE-RECONCILE-R4']);
  fs.writeFileSync(path.join(repoPath, 'README.md'), `# ${name}\n\nFixture repository.\n`);
  git(repoPath, ['add', '.']);
  git(repoPath, ['commit', '-qm', 'baseline']);
  const baseline = git(repoPath, ['rev-parse', 'HEAD']);
  const shas = {};
  for (const label of commits) {
    fs.writeFileSync(path.join(repoPath, `${label}.txt`), `change ${name} ${label}\n${label.repeat(64)}\n`);
    git(repoPath, ['add', '.']);
    git(repoPath, ['commit', '-qm', `feature ${label}`]);
    shas[label] = git(repoPath, ['rev-parse', 'HEAD']);
  }
  return { repoPath, baseline, shas };
}

// Real git hook inside the FIXTURE repository only (.git/hooks/post-commit).
// mode 'ok'     -> the real bridge commit-boundary CLI captures the boundary.
// mode 'broken' -> the CLI path does not exist, so the hook fails for real and
//                  the commit never reaches the journal (never captured).
// The user's global git config and global hooks are never touched.
function installPostCommitHook(repoPath, { home, mode = 'ok' }) {
  const hookPath = path.join(repoPath, '.git', 'hooks', 'post-commit');
  const slash = value => value.replace(/\\/g, '/');
  const cli = mode === 'ok' ? slash(BRIDGE_CLI) : slash(path.join(BRIDGE_ROOT, 'src', 'bridge', 'bin', 'commit-boundary.missing.js'));
  const script = [
    '#!/bin/sh',
    mode === 'ok'
      ? `"${slash(process.execPath)}" "${cli}" --home "${slash(home)}" --cwd "${slash(repoPath)}" >/dev/null 2>&1`
      : `"${slash(process.execPath)}" "${cli}" --home "${slash(home)}" --cwd "${slash(repoPath)}"`,
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

// The engine under test, in-process, isolated data dir.
function startEngine({ dataDir, bridgeUrl, vectorUrl, analyzer, debug = true, consume = true, runtimeToken = null, engineRoot = null }) {
  fs.mkdirSync(dataDir, { recursive: true });
  const root = path.resolve(engineRoot || resolveEngineRoot().root);
  const { createEngineServer } = require(path.join(root, 'src', 'server.js'));
  const runtime = createEngineServer({ dataDir, consume, debug, analyzer, bridgeUrl, vectorUrl, runtimeToken });
  return {
    runtime, engineRoot: root,
    async listen() {
      await runtime.ready;
      await new Promise(resolve => runtime.server.listen(0, '127.0.0.1', resolve));
      return `http://127.0.0.1:${runtime.server.address().port}`;
    },
    async close() { await runtime.close(); },
  };
}

// Real capture of a commit boundary through the pinned bridge CLI. This is the
// SAME code path the post-commit hook runs - no API-created task is used to
// stand in for a hook failure.
function captureBoundary({ home, repoPath, sha }) {
  const result = spawnSync(process.execPath, [BRIDGE_CLI, '--home', home, '--cwd', repoPath, '--sha', sha], {
    cwd: repoPath, windowsHide: true, encoding: 'utf8', env: isolatedEnv(),
  });
  let parsed = null;
  try { parsed = JSON.parse(result.stdout); } catch { parsed = null; }
  return { code: result.status, stdout: (result.stdout || '').trim(), stderr: (result.stderr || '').trim(), payload: parsed };
}

function findJournalFiles(root) {
  const out = [];
  const walk = dir => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.name === 'events.jsonl') out.push(absolute);
    }
  };
  walk(root);
  return out;
}

// Every git-commit-boundary event physically present in the journals on disk.
function boundaryEvents(...roots) {
  const events = [];
  for (const file of roots.flatMap(root => findJournalFiles(root))) {
    for (const line of fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
      const event = JSON.parse(line);
      if (event.schema === 'git-commit-boundary/v1') events.push(event);
    }
  }
  return events;
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

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
}

function saveEvidence(dir, name, value) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), `${JSON.stringify(value, null, 2)}\n`);
}

function hashText(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function hashFile(file) {
  if (!fs.existsSync(file)) return null;
  return hashFileSync(file);
}

function hashFileSync(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

module.exports = {
  REPO_ROOT,
  VENDORED_ENGINE_ROOT,
  VENDORED_ENGINE_VERSION,
  resolveEngineRoot,
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
  captureBoundary,
  boundaryEvents,
  waitUntil,
  readJsonl,
  saveEvidence,
  hashText,
  hashFile,
};
