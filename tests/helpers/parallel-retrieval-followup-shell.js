'use strict';
// Lane-owned helpers for the P-RETRIEVAL-FOLLOWUP-01 batch (RET-007/RET-008).
//
// Portability contract: no developer path is hard-coded. The operator's
// Workbench profile store defaults to the real user home captured BEFORE
// fixture.isolateProcess() replaces HOME/USERPROFILE, and can be overridden
// with PK_RETRIEVAL_WORKBENCH_HOME. Secrets (the glm subscription key) are
// read in memory only: they are never printed, logged or persisted, and no
// quota/usage endpoint is ever contacted by anything in this lane.
//
// Isolation contract: same as the sibling parallel-knowledge-fixture helper —
// ambient module URLs cleared, live 5757/5790/8787/8790 endpoints refused,
// every artefact under the external temp root. The shared fixture helper is
// required read-only; this file only adds lane-specific composition.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn, execFileSync } = require('node:child_process');

const fixture = require('./parallel-knowledge-fixture');

// Captured before isolateProcess() rewrites the environment.
const REAL_HOME = process.env.PK_RETRIEVAL_WORKBENCH_HOME
  || process.env.USERPROFILE
  || process.env.HOME
  || os.homedir();

const REPO_ROOT = fixture.REPO_ROOT;
const LANE_DIR = path.join(REPO_ROOT, 'qa-autopilot', 'artifacts', 'parallel-20261023', 'retrieval-followup');
const BRIDGE_BIN = path.join(REPO_ROOT, 'node_modules', '@sanqianx', 'ai-coding-event-bridge-console', 'src', 'bin.js');
const HUB_DIST = path.join(REPO_ROOT, 'node_modules', '@sanqianx', 'vector-hub', 'dist', 'cjs');
const MODEL_RELATIVE = path.join('Xenova', 'bge-small-zh-v1.5');

function workbenchProfileHome() { return path.join(REAL_HOME, '.agent-terminal'); }

// Resolve one of the operator's real subscription profiles, in memory only.
// Shape mirrors the Workbench ProfileStore runtime projection actually used
// for engine runtime-config: { apiKey, baseUrl, mainModel }.
//
// The model list is the operator's instruction order, not a filter: the
// provider is the authority on which id it accepts, so a model that the local
// catalog does not list is still attempted and the answer is recorded.
function loadRuntimeProfile(options = {}) {
  const profileId = options.profileId || 'minimax';
  const models = (options.models && options.models.length ? options.models : [options.model].filter(Boolean));
  const home = workbenchProfileHome();
  const profileFile = path.join(home, 'profiles.v2.json');
  const credentialFile = path.join(home, 'credentials.v1.json');
  const detail = { home, profileFile, credentialFile, profileId, models };
  if (!models.length) return { ok: false, reason: 'no model requested', ...detail };
  try {
    const store = JSON.parse(fs.readFileSync(profileFile, 'utf8'));
    const profiles = Array.isArray(store.profiles) ? store.profiles : [];
    const profile = profiles.find(item => item.id === profileId);
    if (!profile) return { ok: false, reason: `${profileId} profile not found`, ...detail };
    if (profile.enabled === false) return { ok: false, reason: `${profileId} profile is disabled`, ...detail };
    const credentials = JSON.parse(fs.readFileSync(credentialFile, 'utf8'));
    const secret = credentials.credentials && credentials.credentials[profile.credentialRef];
    if (typeof secret !== 'string' || !secret) return { ok: false, reason: `${profileId} credential is not configured`, ...detail };
    if (!profile.baseUrl) return { ok: false, reason: `${profileId} profile has no baseUrl`, ...detail };
    const listedModels = (profile.models && profile.models.list || []).map(entry => entry.id);
    const mainModel = models[0];
    // The secret never leaves memory; callers must not serialise this object.
    return {
      ok: true,
      ...detail,
      listedModels,
      profile: { apiKey: secret, baseUrl: profile.baseUrl, mainModel },
      identity: {
        profileId: profile.id,
        baseUrl: profile.baseUrl,
        protocol: profile.protocol || null,
        mainModel,
        modelListedInProfile: listedModels.includes(mainModel),
        credentialConfigured: true,
      },
    };
  } catch (error) {
    return { ok: false, reason: `workbench profile store unreadable: ${error.message}`, ...detail };
  }
}

// The lane's offline model cache. A missing cache is a real BLOCKED, never a
// download and never the shipped mock provider.
function verifyModelCache(cacheDir) {
  const modelDir = path.join(cacheDir, MODEL_RELATIVE);
  const required = ['onnx' + path.sep + 'model.onnx', 'tokenizer.json'];
  const missing = required.filter(relative => !fs.existsSync(path.join(modelDir, ...relative.split(/[\\/]/))));
  return { cacheDir, modelDir, ok: missing.length === 0, missing };
}

// The product's own embedding service wrapped in the interface the real
// vector hub expects (same contract as the accepted parallel-knowledge-vector
// probe: batch = passage, single string = query).
function createProductEmbedder(service) {
  const state = { calls: 0, dimensions: [], nonZeroVectors: 0 };
  return {
    kind: 'product-local-embedding-service',
    model: service.modelId,
    modelId: service.modelId,
    maxTokens: 500,
    state,
    async createEmbeddings(inputs) {
      const isBatch = Array.isArray(inputs);
      const texts = isBatch ? inputs : [inputs];
      const output = [];
      for (const text of texts) {
        const vector = isBatch ? await service.embedPassage(text) : await service.embedQuery(text);
        state.calls += 1;
        state.dimensions.push(vector.length);
        if (vector.some(value => value !== 0)) state.nonZeroVectors += 1;
        output.push(vector);
      }
      return { status: 'success', output };
    },
  };
}

// A real vectra index on disk: the stored vectors must be real, of the
// expected dimension and not all zero.
function inspectStoredVectors(projectDir, expectedDimensions) {
  const indexFile = path.join(projectDir, 'index.json');
  if (!fs.existsSync(indexFile)) {
    return { inspected: false, reason: 'no index.json in the project folder', files: fs.existsSync(projectDir) ? fs.readdirSync(projectDir) : [] };
  }
  const raw = fs.readFileSync(indexFile, 'utf8');
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch { parsed = null; }
  if (!parsed || !Array.isArray(parsed.items)) return { inspected: false, reason: 'index.json is not a readable JSON index', bytes: raw.length };
  const vectors = parsed.items.map(item => item && item.vector).filter(Array.isArray);
  const dimensions = [...new Set(vectors.map(vector => vector.length))];
  return {
    inspected: true,
    bytes: raw.length,
    itemCount: parsed.items.length,
    vectorCount: vectors.length,
    dimensions,
    expectedDimensions,
    dimensionsMatch: dimensions.length === 1 && dimensions[0] === expectedDimensions,
    allVectorsNonZero: vectors.length > 0 && vectors.every(vector => vector.some(value => value !== 0)),
  };
}

async function httpJson(url, options = {}) {
  const response = await fetch(url, { signal: AbortSignal.timeout(options.timeoutMs || 8000), ...options });
  const body = await response.json().catch(() => null);
  return { status: response.status, ok: response.ok, body };
}

// The real event-bridge console as its own child process on an isolated port
// and home — the production topology (hooks, console service and consumers
// are separate processes over HTTP).
async function spawnBridgeConsole({ home, port }) {
  fs.mkdirSync(home, { recursive: true });
  const child = spawn(process.execPath, [BRIDGE_BIN, 'serve', '--port', String(port), '--host', '127.0.0.1', '--home', home], {
    env: fixture.sanitizedEnv({ BRIDGE_CONSOLE_PICK_FOLDER: '0', AI_CODING_EVENT_BRIDGE_HOME: home }),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = { stdout: '', stderr: '' };
  child.stdout.on('data', chunk => { output.stdout += chunk; });
  child.stderr.on('data', chunk => { output.stderr += chunk; });
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20000;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const health = await httpJson(`${url}/api/health`, { timeoutMs: 2000 });
      if (health.ok) return { child, url, home, output, stop: kill(child) };
      lastError = new Error(`health HTTP ${health.status}`);
    } catch (error) { lastError = error; }
    if (child.exitCode !== null) throw new Error(`bridge console exited early (${child.exitCode}): ${output.stderr.slice(0, 400)}`);
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  kill(child)();
  throw new Error(`bridge console did not become healthy: ${lastError && lastError.message}`);
}

function kill(child) {
  return () => new Promise(resolve => {
    if (child.exitCode !== null) return resolve();
    child.once('close', () => resolve());
    child.kill();
    setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); resolve(); }, 3000).unref();
  });
}

// The real pinned vector-hub package served over its real HTTP layer. The
// product's LocalEmbeddingService is attached through the package's supported
// hub.setEmbeddings API (the accepted probe pattern); the shell-managed
// runtime-config credential path is not applicable to the offline local model
// and is documented as the lane's injection boundary.
async function startVectorHttpServer({ root, port, embedder, hubDist = HUB_DIST }) {
  const { HubManager } = require(path.join(hubDist, 'server', 'manager.js'));
  const { createServer } = require(path.join(hubDist, 'server', 'server.js'));
  fs.mkdirSync(root, { recursive: true });
  process.env.VECTOR_HUB_DISABLE_PICKER = '1';
  const manager = await HubManager.load({ rootPath: root, configPath: path.join(root, 'vector-config.json'), managed: true });
  manager.hub.setEmbeddings(embedder);
  const server = http.createServer(createServer(manager));
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  return {
    manager,
    server,
    url: `http://127.0.0.1:${server.address().port}`,
    root,
    async stop() {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      await manager.dispose?.();
    },
  };
}

// An isolated sink for the hook trigger's best-effort site notification. The
// trigger falls back to KB_SITE_PORT (default 5757 — the developer's LIVE
// site) when no runtime endpoint file exists, so every Git child in this lane
// gets KB_SITE_PORT pointed here. Nothing may ever reach the real 5757.
async function startNotificationSink() {
  const hits = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      let parsed = null;
      try { parsed = JSON.parse(body); } catch { parsed = null; }
      hits.push({ method: req.method, url: req.url, body: parsed });
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'notification sink' }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, hits, port: server.address().port, stop: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }) };
}

// Git with an explicit environment (the hook inherits it: KB_SITE_PORT sinks
// the notification, isolated vars keep the trigger away from live surfaces).
function gitIn(repoPath, args, env = {}) {
  return execFileSync('git', args, { cwd: repoPath, windowsHide: true, encoding: 'utf8', env: fixture.sanitizedEnv(env) }).trim();
}

async function waitFor(predicate, timeoutMs, label, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await predicate();
    if (last) return last;
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${label}`);
}

function writeEvidence(name, value) {
  const file = path.join(LANE_DIR, 'evidence', name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
  return { file, sha256: fixture.sha256File(file) };
}

module.exports = {
  REAL_HOME,
  REPO_ROOT,
  LANE_DIR,
  HUB_DIST,
  workbenchProfileHome,
  loadRuntimeProfile,
  verifyModelCache,
  createProductEmbedder,
  inspectStoredVectors,
  httpJson,
  spawnBridgeConsole,
  startVectorHttpServer,
  startNotificationSink,
  gitIn,
  waitFor,
  writeEvidence,
  ...fixture,
};
