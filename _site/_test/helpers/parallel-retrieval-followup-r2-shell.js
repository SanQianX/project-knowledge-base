'use strict';
// Lane-owned helpers for the P-RETRIEVAL-FOLLOWUP-R2 round (RET-007-R2).
//
// PROVENANCE / OWNERSHIP
// ----------------------
// This file is a LANE-EXCLUSIVE SNAPSHOT of the P-MEMORY-INJECTION-02 lane's
// helper. That lane is still writing its file, so this lane COPIES the pieces
// it needs instead of importing them: the source is read-only here and is
// never edited, and the SHA-256 of the source is computed at run time so the
// copy can always be checked against its origin.
//
//   piece                                    source (read-only)                          owner
//   --------------------------------------  -----------------------------------------  --------------------------
//   isolation, read-only profile facade,     _site/_test/helpers/parallel-memory-injection-shell.js  P-MEMORY-INJECTION-02
//   recording proxy, transcript scan,
//   real Workbench turn
//   host child shape                         _site/_test/helpers/parallel-memory-injection-wb-host.js  P-MEMORY-INJECTION-02
//
// The chain helpers of THIS lane (real Git, real hook, real engine, real
// vector hub, real subscription profile) are NOT copied: they already live in
// the lane-owned _site/_test/helpers/parallel-retrieval-followup-shell.js and
// are required from there.
//
// Isolation contract (batch rules): every artefact lives under the shared
// external temp root (D:/SanQian.Xu/.project-knowledge-test-temp); the
// Workbench data dir, Bridge home, HOME/USERPROFILE and CLAUDE_CONFIG_DIR are
// isolated; the live product ports (5757/5760/5789/5790/8787/8790) are
// refused; ambient module addresses and every ambient Anthropic credential
// variable are dropped.
//
// Credential contract: the original subscription credential is read from its
// real location READ-ONLY and stays in memory. It is never written to a file,
// a log, a report or a clone, and the profile store handed to the host refuses
// every write method.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');

// The chain helpers of THIS lane (own file, not a snapshot).
const chain = require('./parallel-retrieval-followup-shell');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const ENGINE_ENTRY = path.join(REPO_ROOT, '_modules', 'knowledge-engine', 'src', 'server.js');
const BRIDGE_CONSOLE_ENTRY = path.join(REPO_ROOT, 'node_modules', '@sanqianx', 'ai-coding-event-bridge-console', 'src', 'server.js');
const BRIDGE_REPO_CONTEXT = path.join(REPO_ROOT, 'node_modules', '@sanqianx', 'ai-coding-event-bridge-console', 'src', 'bridge', 'core', 'repo-context.js');

// The developer's live surfaces. A lane test may never bind or talk to them.
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
  'KB_ENGINE_RUNTIME_TOKEN',
  'AI_CODING_EVENT_BRIDGE_HOME',
];

// Ambient Anthropic credentials: the lane may only use the credential it
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

// Captured before any isolation rewrites HOME.
const REAL_HOME = os.homedir();
const REAL_USERPROFILE = process.env.USERPROFILE || REAL_HOME;

const SNAPSHOT_SOURCES = [
  { piece: 'isolation, read-only profile facade, recording proxy, transcript scan, real Workbench turn', source: '_site/_test/helpers/parallel-memory-injection-shell.js', owner: 'P-MEMORY-INJECTION-02 lane (untracked, still being written)' },
  { piece: 'host child shape', source: '_site/_test/helpers/parallel-memory-injection-wb-host.js', owner: 'P-MEMORY-INJECTION-02 lane (untracked, still being written)' },
  { piece: 'chain helpers (real Git, real engine, real vector hub, real subscription profile)', source: '_site/_test/helpers/parallel-retrieval-followup-shell.js', owner: 'this lane (P-RETRIEVAL-FOLLOWUP)' },
];

function sha256File(file) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); } catch { return null; }
}

// The provenance of every snapshot, with the source hash computed now.
function snapshotProvenance() {
  return SNAPSHOT_SOURCES.map(entry => {
    const absolute = path.join(REPO_ROOT, ...entry.source.split('/'));
    return { ...entry, sourceSha256: sha256File(absolute), sourceExists: fs.existsSync(absolute) };
  });
}

function isInside(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

// The batch contract pins an external temp root next to the repositories.
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

function makeTempDir(prefix = 'parallel-memory-injection') {
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

// Windows keeps a directory locked for a short while after the process that
// used it exits (and the AV scanner may hold it too), so a single rmSync can
// fail with EPERM even though nothing is still running. Retry with a delay
// and report the outcome instead of throwing, so a leftover scratch folder
// never turns a green evidence run into a script error.
async function removeTreeAsync(dir, { attempts = 12, delayMs = 500 } = {}) {
  if (!dir) return { removed: true, path: dir, error: null };
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      return { removed: true, path: dir, error: null, attempts: attempt };
    } catch (error) {
      lastError = error;
      if (!fs.existsSync(dir)) return { removed: true, path: dir, error: null, attempts: attempt };
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
  return { removed: false, path: dir, attempts, error: { code: lastError.code, message: lastError.message } };
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

async function waitForHttp(url, timeoutMs = 30000) {
  const parsed = new URL(url);
  const port = parsed.port ? Number(parsed.port) : (parsed.protocol === 'https:' ? 443 : 80);
  if (FORBIDDEN_PORTS.has(port)) throw new Error(`refusing to contact the live service ${url}`);
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

function git(cwd, args) {
  const result = execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  return String(result || '').trim();
}

// A real Git repository with a real commit: the engine resolves a project by
// the Git toplevel, and the Bridge derives the repo identity from it.
function makeGitRepo(root, name) {
  const repo = path.join(root, name);
  fs.mkdirSync(repo, { recursive: true });
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.email', 'parallel-memory-injection@local.invalid']);
  git(repo, ['config', 'user.name', 'Parallel Memory Injection Lane']);
  git(repo, ['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(repo, 'README.md'), `# ${name}\n`, 'utf8');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-qm', 'baseline']);
  return { path: repo, headCommit: git(repo, ['rev-parse', 'HEAD']) };
}

function sanitizedEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  for (const key of AMBIENT_MODULE_URLS) delete env[key];
  for (const key of AMBIENT_MODEL_ENV) delete env[key];
  return env;
}

function spawnNode(args, env = {}) {
  const child = spawn(process.execPath, args, { env: sanitizedEnv(env), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const output = { stdout: '', stderr: '' };
  child.stdout.on('data', chunk => { output.stdout += chunk; });
  child.stderr.on('data', chunk => { output.stderr += chunk; });
  const exited = new Promise(resolve => child.once('close', code => resolve({ code, ...output })));
  return { child, exited, output };
}

// The isolated directories of one run.
function createIsolationLayout(prefix = 'parallel-memory-injection') {
  const root = makeTempDir(prefix);
  const layout = {
    root,
    dataDir: path.join(root, 'workbench-data'),
    knowledgeDataDir: path.join(root, 'knowledge-data'),
    bridgeHome: path.join(root, 'bridge-home'),
    engineDataDir: path.join(root, 'engine-data'),
    brainKnowledgeDir: path.join(root, 'brain-knowledge'),
    projectKnowledgeDir: path.join(root, 'project-knowledge'),
    controlKnowledgeDir: path.join(root, 'control-knowledge'),
    home: path.join(root, 'home'),
    claudeConfigDir: path.join(root, 'claude-config'),
    temp: path.join(root, 'temp'),
    repos: path.join(root, 'repos'),
  };
  for (const dir of Object.values(layout)) {
    if (typeof dir === 'string') fs.mkdirSync(dir, { recursive: true });
  }
  return layout;
}

// The environment a host child may inherit.
function hostEnv(layout, extra = {}) {
  const parsed = path.parse(layout.home);
  return sanitizedEnv({
    // The real profile directory is passed explicitly: the child's isolated
    // HOME would otherwise hide it from the read-only profile facade.
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

// Where the product keeps its profiles. Resolved from the real home, never
// from an isolated one.
function realWorkbenchProfileDir() {
  const override = String(process.env.PK_WB_REAL_PROFILE_DIR || '').trim();
  if (override) return path.resolve(override);
  return path.join(REAL_HOME, '.project-knowledge-v5', 'workbench');
}

// Byte-level snapshot of a flat directory. The SHA-256 digests stay in the
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
  const changed = [], added = [], removed = [], unreadable = [];
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

// The module that is hosted: the copy the installed product ships, unless the
// caller pins another one explicitly.
function resolveWorkbenchModuleRoot(options = {}) {
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

function packageIdentity(moduleRoot) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(moduleRoot, 'packages', 'server', 'package.json'), 'utf8'));
    return { name: manifest.name, version: manifest.version };
  } catch { return { name: null, version: null }; }
}

function safeJson(raw) {
  const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw || '');
  try { return JSON.parse(text); } catch { return text.length > 200000 ? `${text.slice(0, 200000)}…[truncated]` : text; }
}

// An observation-only transparent proxy in front of the real engine: it
// forwards every request byte-for-byte and records both directions. It never
// rewrites, filters or synthesises a response, so what the Workbench module
// received is what the engine produced.
async function startRecordingProxy({ target, label = 'engine' }) {
  const targetUrl = new URL(target);
  const records = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', async () => {
      const body = Buffer.concat(chunks);
      const entry = { label, method: req.method, url: req.url, requestBytes: body.length, requestBody: safeJson(body), at: new Date().toISOString() };
      try {
        const headers = { ...req.headers };
        delete headers.host;
        delete headers['accept-encoding'];
        const response = await fetch(new URL(req.url, targetUrl), {
          method: req.method,
          headers,
          body: body.length ? body : undefined,
          signal: AbortSignal.timeout(15000),
        });
        const text = await response.text();
        entry.responseStatus = response.status;
        entry.responseBody = safeJson(text);
        records.push(entry);
        res.writeHead(response.status, { 'Content-Type': response.headers.get('content-type') || 'application/json' });
        res.end(text);
      } catch (error) {
        entry.error = error.message;
        records.push(entry);
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'PROXY_TARGET_UNAVAILABLE' }));
      }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  if (FORBIDDEN_PORTS.has(Number(port))) throw new Error(`refusing to use the live port ${port}`);
  return {
    url: `http://127.0.0.1:${port}`,
    records,
    requests: () => records.filter(entry => entry.method === 'POST'),
    close: () => new Promise(done => server.close(() => done())),
  };
}

// An ISOLATED stand-in for the vector hub. The engine must never reach the
// live 8787 instance, and this lane makes no vector claim: the stand-in
// answers an empty result set, so retrieval stays lexical-only. Vector
// evidence is explicitly NOT produced here.
async function startVectorHubStandIn() {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ url: req.url, at: new Date().toISOString() });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, results: [], model: 'lane-stand-in-lexical-only', dimensions: 0 }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  if (FORBIDDEN_PORTS.has(Number(port))) throw new Error(`refusing to use the live port ${port}`);
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    kind: 'isolated-stand-in (empty result set, lexical-only, NOT vector evidence)',
    close: () => new Promise(done => server.close(() => done())),
  };
}

// The REAL knowledge engine, in-process, on its own isolated data dir.
async function startRealEngine({ dataDir, runtimeToken, debug = true, consume = false, bridgeUrl, vectorUrl }) {
  const { createEngineServer } = require(ENGINE_ENTRY);
  const engine = createEngineServer({
    dataDir,
    runtimeToken,
    debug: debug === true,
    consume: consume === true,
    ...(bridgeUrl ? { bridgeUrl } : {}),
    ...(vectorUrl ? { vectorUrl } : {}),
  });
  await engine.ready;
  await new Promise(resolve => engine.server.listen(0, '127.0.0.1', resolve));
  const port = engine.server.address().port;
  if (FORBIDDEN_PORTS.has(Number(port))) throw new Error(`refusing to use the live port ${port}`);
  const url = `http://127.0.0.1:${port}`;
  const api = async (method, route, body) => {
    const response = await fetch(url + route, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${runtimeToken}` },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  return {
    engine,
    url,
    token: runtimeToken,
    api,
    close: () => engine.close().catch(() => {}),
  };
}

// The REAL event-bridge console, in-process, on its own isolated home.
async function startBridgeConsole({ home, runtimeToken }) {
  const { createConsoleServer } = require(BRIDGE_CONSOLE_ENTRY);
  const handler = createConsoleServer({ home, runtimeToken });
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  if (FORBIDDEN_PORTS.has(Number(port))) throw new Error(`refusing to use the live port ${port}`);
  const url = `http://127.0.0.1:${port}`;
  const api = async (method, route, body) => {
    const response = await fetch(url + route, {
      method,
      headers: { 'Content-Type': 'application/json', ...(route.startsWith('/api/internal/') ? { Authorization: `Bearer ${runtimeToken}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  return { url, api, close: () => new Promise(done => server.close(() => done())) };
}

// The repo identity the real Bridge derives for a directory.
async function resolveRepoIdentity(dir) {
  const { resolveRepoContext } = require(BRIDGE_REPO_CONTEXT);
  return resolveRepoContext(dir);
}

function walkFiles(root, visit) {
  let names;
  try { names = fs.readdirSync(root, { withFileTypes: true }); } catch { return; }
  for (const entry of names) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) walkFiles(full, visit);
    else if (entry.isFile()) visit(full);
  }
}

// Read the CLI transcript of THIS run and report only what the evidence
// layers need: whether the request that carried the round token also carried
// the unique convention, and which model the vendor returned. The transcript
// itself is never copied anywhere.
function scanClaudeTranscript(roots, { claudeSessionId, token, marker }) {
  const files = [];
  const userMessages = [];
  const assistantModels = new Set();
  let assistantCount = 0;
  for (const root of roots) {
    walkFiles(root, file => {
      if (!file.endsWith('.jsonl')) return;
      let text;
      try { text = fs.readFileSync(file, 'utf8'); } catch { return; }
      if (claudeSessionId && !text.includes(claudeSessionId)) return;
      files.push(path.basename(file));
      for (const line of text.split(/\r?\n/)) {
        let entry;
        try { entry = JSON.parse(line); } catch { continue; }
        const sessionMatches = !claudeSessionId || entry.sessionId === claudeSessionId;
        if (entry.type === 'user' && entry.message && sessionMatches) {
          const content = Array.isArray(entry.message.content) ? entry.message.content : [];
          const text_ = content.map(block => (block && typeof block.text === 'string' ? block.text : '')).join('\n');
          if (!text_) continue;
          const markerAt = marker ? text_.indexOf(marker) : -1;
          userMessages.push({
            sessionId: entry.sessionId || null,
            hasToken: token ? text_.includes(token) : null,
            hasMarker: marker ? markerAt >= 0 : null,
            hasKnowledgeContext: text_.includes('<knowledge_context>'),
            length: text_.length,
            markerExcerpt: markerAt >= 0 ? text_.slice(Math.max(0, markerAt - 120), markerAt + 260) : null,
          });
        }
        if (entry.type === 'assistant' && entry.message && sessionMatches) {
          assistantCount += 1;
          if (typeof entry.message.model === 'string' && entry.message.model) assistantModels.add(entry.message.model);
        }
      }
    });
  }
  return {
    transcriptFiles: files,
    userMessages,
    assistantCount,
    assistantModelValues: [...assistantModels],
  };
}

async function getJson(url, options) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(30000) });
  const body = await response.json().catch(() => null);
  return { status: response.status, ok: response.ok, body };
}

// Consume the Workbench session event stream until the terminal event arrives.
async function consumeSessionEvents(url, onEvent, until, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`event stream timed out after ${timeoutMs}ms`)), timeoutMs);
  let done = null;
  const finished = new Promise(resolve => { done = resolve; });
  (async () => {
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) throw new Error(`event stream HTTP ${response.status}`);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { value, done: streamDone } = await reader.read();
        if (streamDone) break;
        buffer += decoder.decode(value, { stream: true });
        let index;
        while ((index = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, index).replace(/\r$/, '');
          buffer = buffer.slice(index + 1);
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload) continue;
          let event;
          try { event = JSON.parse(payload); } catch { continue; }
          try { onEvent(event); } catch { /* listener errors never kill the stream */ }
          if (until(event)) { controller.abort(); return; }
        }
      }
    } catch { /* aborted or ended */ }
    finally { done && done(); }
  })();
  await finished;
  clearTimeout(timer);
}

// One real turn against the hosted Workbench module.
//
// sessionInputOrigin is what the real client sends when it creates a session
// (packages/client: opts.inputOrigin || 'human'). It is OMITTED when the
// caller did not declare one, exactly like the module's own dispatcher child.
// inputOptions is the option object the input endpoint receives; the module's
// dispatcher passes { inputOrigin: 'agent-delegation', permissionMode, effort }.
async function runWorkbenchTurn({
  base, profileId, model, effort, workspaceRef, contextId, question,
  sessionInputOrigin, inputOptions, timeoutMs = 420000,
}) {
  const sessionBody = {
    context: { contextId, workspaceRef },
    aiProfileId: profileId,
    model,
    effort,
  };
  if (sessionInputOrigin !== undefined) sessionBody.inputOrigin = sessionInputOrigin;
  const session = await getJson(`${base}/api/claude-workbench/v1/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(sessionBody),
  });
  if (session.status !== 201) throw Object.assign(new Error(`the session was not created: HTTP ${session.status} ${JSON.stringify(session.body)}`), { status: session.status });
  const sessionId = session.body.session.sessionId;

  const events = [];
  // The CLI's own stderr (provider refusals, 429s, crashes) arrives as
  // claude/stderr events. They are collected separately so a failed turn can
  // report the REAL provider error instead of "isError with no diagnostics".
  const stderrEvents = [];
  const isTerminal = event => event.type === 'claude/result';
  const streamUrl = `${base}/api/claude-workbench/v1/sessions/${encodeURIComponent(sessionId)}/events`;
  const consume = consumeSessionEvents(streamUrl, event => {
    if (event.type === 'claude/stderr') { stderrEvents.push(String(event.text || event.message || '')); return; }
    if (['claude/init', 'claude/result', 'claude/error', 'claude/aborted'].includes(event.type)) events.push(event);
  }, isTerminal, timeoutMs + 60000).catch(() => {});

  const inputBody = { text: question };
  if (inputOptions !== undefined) inputBody.options = inputOptions;
  const send = await getJson(`${base}/api/claude-workbench/v1/sessions/${encodeURIComponent(sessionId)}/input`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(inputBody),
  });
  if (send.status !== 202) {
    await Promise.race([consume, new Promise(resolve => setTimeout(resolve, 2000))]);
    throw Object.assign(new Error(`the input was not accepted: HTTP ${send.status} ${JSON.stringify(send.body)}`), { status: send.status });
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !events.some(isTerminal)) {
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  await Promise.race([consume, new Promise(resolve => setTimeout(resolve, 5000))]);

  const init = events.find(event => event.type === 'claude/init') || null;
  const result = events.find(event => event.type === 'claude/result') || null;
  const error = events.find(event => event.type === 'claude/error') || null;
  return {
    sessionId,
    events,
    init,
    result,
    error,
    stderrEvents,
    claudeSessionId: init ? init.claudeSessionId : null,
    sdkReportedModel: init ? init.model : null,
    answer: result ? String(result.result || '') : '',
    isError: result ? result.isError === true : true,
    usage: result && result.usage ? { inputTokens: result.usage.input_tokens, outputTokens: result.usage.output_tokens } : null,
  };
}

async function eventually(fn, timeoutMs = 15000, intervalMs = 100) {
  const until = Date.now() + timeoutMs;
  let last;
  while (Date.now() < until) {
    try { last = await fn(); if (last) return last; } catch (error) { last = error.message; }
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  return null;
}

module.exports = {
  chain,
  REPO_ROOT,
  ENGINE_ENTRY,
  BRIDGE_CONSOLE_ENTRY,
  FORBIDDEN_PORTS,
  AMBIENT_MODULE_URLS,
  AMBIENT_MODEL_ENV,
  REAL_HOME,
  REAL_USERPROFILE,
  SNAPSHOT_SOURCES,
  snapshotProvenance,
  sha256File,
  isInside,
  resolveTempRoot,
  makeTempDir,
  removeTree,
  removeTreeAsync,
  freePort,
  waitForHttp,
  git,
  makeGitRepo,
  sanitizedEnv,
  spawnNode,
  createIsolationLayout,
  hostEnv,
  realWorkbenchProfileDir,
  digestDirectory,
  compareDigests,
  createReadOnlyProfileStore,
  resolveWorkbenchModuleRoot,
  packageIdentity,
  startRecordingProxy,
  startVectorHubStandIn,
  startRealEngine,
  startBridgeConsole,
  resolveRepoIdentity,
  scanClaudeTranscript,
  getJson,
  consumeSessionEvents,
  runWorkbenchTurn,
  eventually,
};
