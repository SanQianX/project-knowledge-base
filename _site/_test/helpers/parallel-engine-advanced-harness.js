'use strict';

// P-ENG-ADVANCED lane-exclusive harness (parallel-20261023 batch).
//
// Drives the VENDORED knowledge-engine (_modules/knowledge-engine, byte-identical
// to source e5573bb at batch time) inside real child processes with full
// isolation: ephemeral loopback ports, lane-owned data dirs under
// PK_TEST_TEMP_ROOT (or the OS temp dir), isolated HOME/TEMP, and a
// scrubbed child environment (no KB_*/KNOWLEDGE_*/ANTHROPIC_*/CLAUDE* leakage,
// no env -u dependency). The analyzer is a DECLARATIVE STAND-IN: it writes real
// staged Markdown + manifest bytes through the engine's real promotion path but
// does NOT cover real model output. The vector endpoint is a loopback HTTP
// double: engine-side index behavior is real, vector-hub itself is not covered.

const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const VENDORED_ENGINE_SERVER = path.join(REPO_ROOT, '_modules', 'knowledge-engine', 'src', 'server.js');
const ENGINE_CHILD = path.join(__dirname, 'parallel-engine-advanced-engine-child.js');

// Temp root: PK_TEST_TEMP_ROOT or the OS temp dir; never inside the repository.
const TEMP_ROOT = (() => {
  const base = path.resolve(process.env.PK_TEST_TEMP_ROOT || path.join(os.tmpdir(), 'project-knowledge-engine-test', 'parallel-engine-advanced'));
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
  const dir = fs.mkdtempSync(path.join(TEMP_ROOT, `${label}-`));
  return dir;
}

function isolatedEnv(extra = {}) {
  const home = extra.ISOLATED_HOME || path.join(ensureTempRoot(), 'isolated-home');
  fs.mkdirSync(home, { recursive: true });
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (/^(KB_|KNOWLEDGE_|ANTHROPIC_|CLAUDE|OPENAI_|CODEX|MINIMAX|GLM|PK_TEST_)/i.test(name)) delete env[name];
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
  return { ...env, ...Object.fromEntries(Object.entries(extra).filter(([k]) => k !== 'ISOLATED_HOME')) };
}

function git(repoPath, args, env) {
  return execFileSync('git', args, { cwd: repoPath, windowsHide: true, encoding: 'utf8', env }).trim();
}

// Real fixture git repository with a baseline plus one labeled commit per entry.
// Mirrors the canonical fixture shape from the engine suite (test/engine.test.js
// project()) so scanner.collectEvidence sees the same repo shape it supports.
function buildFixtureRepo(root, name, commits) {
  const env = isolatedEnv();
  const repoPath = path.join(root, `repo-${name}`);
  fs.mkdirSync(repoPath, { recursive: true });
  git(repoPath, ['init', '-q'], env);
  git(repoPath, ['config', 'user.email', 'eng-advanced@test.invalid'], env);
  git(repoPath, ['config', 'user.name', 'P-ENG-ADVANCED'], env);
  fs.writeFileSync(path.join(repoPath, 'README.md'), `# ${name}\n\nInitial fixture repository.\n`);
  git(repoPath, ['add', '.'], env);
  git(repoPath, ['commit', '-qm', 'baseline'], env);
  const baseline = git(repoPath, ['rev-parse', 'HEAD'], env);
  const shas = {};
  for (const label of commits) {
    fs.writeFileSync(path.join(repoPath, `${label}.txt`), `change ${name} ${label}\n` + 'x'.repeat(64) + '\n');
    git(repoPath, ['add', '.'], env);
    git(repoPath, ['commit', '-qm', `feature ${label}`], env);
    shas[label] = git(repoPath, ['rev-parse', 'HEAD'], env);
  }
  return { repoPath, baseline, shas };
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

// Loopback vector-service double. Engine-side requestIndex behavior is fully
// real; this double only stands in for vector-hub's HTTP contract.
async function startVectorDouble() {
  const requests = [];
  let mode = { kind: 'ok' };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; } catch { body = null; }
      requests.push({ at: new Date().toISOString(), url: req.url, body });
      if (mode.kind === 'ok') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } else {
        res.writeHead(mode.httpStatus || 503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: { code: mode.code || 'EMBEDDING_UNAVAILABLE', message: mode.message || 'vector double scripted failure' } }));
      }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    setMode(next) { mode = next; },
    async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); },
  };
}

// Real engine child process running the vendored server module with the
// declarative stand-in analyzer. Returns { base, proc, dataDir, killHard, stop }.
async function startEngineChild({ label, dataDir, vectorUrl, planFile, eventsFile, concurrency }) {
  fs.mkdirSync(dataDir, { recursive: true });
  const proc = spawn(process.execPath, [ENGINE_CHILD], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: isolatedEnv({
      ENGADV_DATA_DIR: dataDir,
      ENGADV_VECTOR_URL: vectorUrl,
      ENGADV_PLAN_FILE: planFile,
      ENGADV_EVENTS_FILE: eventsFile,
      ...(concurrency !== undefined ? { ENGADV_CONCURRENCY: String(concurrency) } : {}),
    }),
  });
  let stderr = '';
  proc.stderr.on('data', chunk => { stderr += chunk; });
  const base = await new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error(`engine child not ready; stderr: ${stderr}`)), 30000);
    proc.stdout.on('data', chunk => {
      out += chunk;
      const match = out.match(/^ENGADV-READY (\{.*\})\n/m);
      if (match) {
        clearTimeout(timer);
        resolve(JSON.parse(match[1]).base);
      }
    });
    proc.on('exit', code => { clearTimeout(timer); reject(new Error(`engine child exited early (${code}); stderr: ${stderr}`)); });
  });
  async function killHard() {
    if (proc.exitCode !== null || proc.signalCode !== null) return proc.exitCode;
    // A HARD crash must not run the engine's graceful shutdown. On POSIX the
    // default signal of kill() is SIGTERM, and the engine child traps SIGTERM
    // to close the server gracefully - which releases the single-writer lock
    // file, so the residual-lock state under test would never exist (root CI
    // 39927630516 failed on Linux with ENOENT on engine-runtime.lock). SIGKILL
    // cannot be trapped, so the process dies with the lock still on disk; on
    // Windows Node maps SIGKILL to TerminateProcess, which is what kill()
    // already did there.
    proc.kill('SIGKILL');
    return await new Promise(resolve => {
      if (proc.exitCode !== null || proc.signalCode !== null) return resolve(proc.exitCode);
      proc.on('exit', code => resolve(code));
    });
  }
  async function stop() {
    if (proc.exitCode !== null) return;
    proc.send({ type: 'kb:shutdown' });
    await new Promise(resolve => {
      const timer = setTimeout(() => { try { proc.kill(); } catch {} resolve(); }, 15000);
      proc.on('exit', () => { clearTimeout(timer); resolve(); });
    });
  }
  return { base, proc, dataDir, killHard, stop, stderr: () => stderr };
}

function readEventsFile(eventsFile) {
  if (!fs.existsSync(eventsFile)) return [];
  return fs.readFileSync(eventsFile, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
}

function writePlan(planFile, plan) {
  fs.mkdirSync(path.dirname(planFile), { recursive: true });
  fs.writeFileSync(planFile, JSON.stringify(plan, null, 1));
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

function saveEvidence(laneDir, name, value) {
  fs.mkdirSync(laneDir, { recursive: true });
  fs.writeFileSync(path.join(laneDir, name), JSON.stringify(value, null, 2));
}

module.exports = {
  REPO_ROOT,
  VENDORED_ENGINE_SERVER,
  TEMP_ROOT,
  makeLaneDir,
  isolatedEnv,
  git,
  buildFixtureRepo,
  waitUntil,
  callJson,
  startVectorDouble,
  startEngineChild,
  readEventsFile,
  writePlan,
  listFilesRecursive,
  saveEvidence,
};
