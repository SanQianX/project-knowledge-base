// _site/_test/helpers/parallel-dock-acceptance-env.js
//
// Lane-exclusive helper for batch P-DOCK-ACCEPTANCE-01 (DOCK-001/002/003).
// Boots the REAL product page against REAL module processes with full
// isolation:
//   - product shell: _site/lib/server-app.js via helpers/spawn-server.js
//     (isolated KB_DATA_DIR / KB_KNOWLEDGE_DATA_DIR / bridge home)
//   - terminal module: the pinned claude-ai-workbench package from this
//     repo's node_modules, spawned here on an exclusive port with its own
//     AGENT_TERMINAL_DATA_DIR + isolated HOME. KB_TERMINAL_URL is injected
//     explicitly, so the product shell treats it as an external service and
//     NEVER spawns/reuses the live 5.x desktop modules (port 5760 etc.).
//   - fixture workspace kept a valid Git repo; the fixture project is then
//     created through the REAL onboarding API chain (settings knowledge-root
//     patch -> preflight-import -> import), which registers it with the
//     terminal module and persists state.modules wiring via module-bridge.
//
// Shared helpers (spawn-server, free-port) are referenced read-only.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const { spawnServer } = require('./spawn-server');
const freePort = require('./free-port');

const PKB_ROOT = path.resolve(__dirname, '..', '..', '..');
const TERMINAL_ENTRY = path.join(
  PKB_ROOT, 'node_modules', 'claude-ai-workbench', 'packages', 'server', 'bin', 'agent-terminal-server.js'
);

function sha256File(file) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); } catch { return null; }
}

function httpJson(url, { method = 'GET', body, timeoutMs = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const request = http.request(url, { method, headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {} }, response => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { text += chunk; });
      response.on('end', () => {
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch { data = null; }
        resolve({ status: response.statusCode, data });
      });
    });
    request.setTimeout(timeoutMs, () => { request.destroy(new Error('timeout')); });
    request.on('error', reject);
    if (payload) request.write(payload);
    request.end();
  });
}

async function waitForHttpOk(url, label, timeoutMs = 60000, accept = () => true) {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'not attempted';
  while (Date.now() < deadline) {
    try {
      const response = await httpJson(url, { timeoutMs: 3000 });
      if (response.status === 200 && accept(response.data)) return response.data;
      lastError = `status ${response.status}`;
    } catch (error) { lastError = error.message; }
    await new Promise(resolve => setTimeout(resolve, 400));
  }
  throw new Error(`Timed out waiting for ${label} (${lastError}): ${url}`);
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
}

async function createDockAcceptanceEnv({ tag = 'dock-acceptance' } = {}) {
  if (!fs.existsSync(TERMINAL_ENTRY)) {
    throw new Error(`pinned claude-ai-workbench terminal entry missing: ${TERMINAL_ENTRY}`);
  }
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), `pk-${tag}-${process.pid}-`));
  const marker = { pid: process.pid, startedAt: new Date().toISOString() };
  writeJson(path.join(fixtureRoot, 'owner-marker.json'), marker);

  const workspace = path.join(fixtureRoot, 'workspace');
  const knowledgeDir = path.join(fixtureRoot, 'knowledge');
  const homeDir = path.join(fixtureRoot, 'home');
  const workbenchDir = path.join(fixtureRoot, 'agent-terminal-data');
  const dataDir = path.join(fixtureRoot, 'kb-data');
  for (const dir of [workspace, knowledgeDir, homeDir, workbenchDir, dataDir]) fs.mkdirSync(dir, { recursive: true });

  // The workspace stays a valid rebuilt Git repo (module/project resolution
  // relies on real repository shape, a lesson carried from the retrieval lane).
  const git = (args) => spawnSync('git', ['-C', workspace, ...args], { encoding: 'utf8', windowsHide: true });
  let gitOk = git(['init', '-q']).status === 0;
  gitOk = git(['config', 'user.email', 'dock-acceptance@example.invalid']).status === 0 && gitOk;
  gitOk = git(['config', 'user.name', 'dock-acceptance']).status === 0 && gitOk;
  fs.writeFileSync(path.join(workspace, 'README.md'), '# dock acceptance fixture workspace\n', 'utf8');
  gitOk = git(['add', 'README.md']).status === 0 && gitOk;
  gitOk = git(['commit', '-q', '-m', 'fixture baseline']).status === 0 && gitOk;
  if (!gitOk) throw new Error('fixture workspace could not be initialized as a Git repository');

  // The data dir starts EMPTY: initializeProductData refuses a dir holding
  // legacy-shaped entries (projects.json / projects/) without its own
  // product-data.json marker, so the fixture project is created AFTER boot
  // through the real onboarding API chain (settings -> preflight -> import).

  const productPort = await freePort();
  const terminalPort = await freePort();
  const terminalUrl = `http://127.0.0.1:${terminalPort}`;
  const productUrl = `http://127.0.0.1:${productPort}`;

  // Product shell. KB_TERMINAL_URL is an explicit external URL: the shell
  // proxies to our isolated terminal module and never spawns or probes the
  // live desktop modules. KB_MODULES_REGISTER=1 re-enables the real
  // per-project module registration the import route performs (terminal
  // project creation + state.modules wiring) — autostart stays off.
  const product = spawnServer({
    root: PKB_ROOT, port: productPort, dataDir, tag,
    analysisOwner: 'engine',
    extraEnv: {
      KB_TERMINAL_URL: terminalUrl,
      KB_MODULES_AUTOSTART: '0',
      KB_MODULES_REGISTER: '1',
      HOME: homeDir, USERPROFILE: homeDir,
    },
  });

  const env = {
    fixtureRoot, workspace, knowledgeDir, homeDir, workbenchDir, dataDir,
    productUrl, terminalUrl, productPort, terminalPort,
    projectId: null,
    terminalProjectId: null,
    processes: { product: product.child, terminal: null },
  };

  const productLog = [];
  const productTail = (chunk) => productLog.push(String(chunk));
  product.child.stdout.on('data', productTail);
  product.child.stderr.on('data', productTail);
  const productLogText = () => productLog.join('');

  try {
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      if (product.child.exitCode !== null) {
        throw new Error(`product server exited early with code ${product.child.exitCode}; log tail: ${productLogText().slice(-4000)}`);
      }
      try {
        const response = await httpJson(`${productUrl}/api/health`, { timeoutMs: 3000 });
        if (response.status === 200 && response.data && typeof response.data === 'object') break;
        await new Promise(resolve => setTimeout(resolve, 400));
      } catch { await new Promise(resolve => setTimeout(resolve, 400)); }
    }
    const late = await httpJson(`${productUrl}/api/health`, { timeoutMs: 3000 }).catch(() => null);
    if (!late || late.status !== 200) {
      throw new Error(`product health never came up; exitCode=${product.child.exitCode}; log tail: ${productLogText().slice(-4000)}`);
    }
  } catch (error) {
    await cleanup();
    throw error;
  }

  // Terminal module on its own port with its own data dir and HOME.
  const terminalLog = [];
  const terminal = spawn(process.execPath, [TERMINAL_ENTRY], {
    cwd: PKB_ROOT,
    env: {
      ...process.env,
      AGENT_TERMINAL_PORT: String(terminalPort),
      AGENT_TERMINAL_HOST: '127.0.0.1',
      AGENT_TERMINAL_DATA_DIR: workbenchDir,
      KB_KNOWLEDGE_DATA_DIR: dataDir,
      KB_KNOWLEDGE_ENGINE_URL: 'http://127.0.0.1:0',
      KB_WORKBENCH_DISABLE_PICKER: '1',
      HOME: homeDir, USERPROFILE: homeDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  env.processes.terminal = terminal;
  const tail = (chunk) => terminalLog.push(String(chunk));
  terminal.stdout.on('data', tail);
  terminal.stderr.on('data', tail);

  try {
    await waitForHttpOk(`${terminalUrl}/api/claude-workbench/v1/health`, 'terminal module health', 60000,
      data => data && data.status === 'ok' && typeof data.apiVersion === 'string');
  } catch (error) {
    await cleanup();
    throw new Error(`${error.message}; terminal log tail: ${terminalLog.join('').slice(-2000)}`);
  }

  // Real onboarding chain, exactly what the product UI's import wizard calls:
  //   1. PATCH /api/settings            — configure the knowledge root
  //   2. POST /api/projects/preflight-import — validation-only gate
  //   3. POST /api/projects/import      — creates the project, installs the
  //      real git hook, and registers it with the terminal module through
  //      module-bridge (which also persists state.modules.terminal wiring —
  //      the mapping ui/product.js uses for kb:knowledge).
  const patched = await httpJson(`${productUrl}/api/settings`, {
    method: 'PATCH', body: { knowledge: { rootPath: knowledgeDir } },
  });
  if (patched.status !== 200 || !(patched.data && patched.data.ok)) {
    await cleanup();
    throw new Error(`settings knowledge-root patch failed: ${patched.status} ${JSON.stringify(patched.data).slice(0, 800)}`);
  }
  const preflight = await httpJson(`${productUrl}/api/projects/preflight-import`, {
    method: 'POST', body: { localPath: workspace },
  });
  if (preflight.status !== 200 || !(preflight.data && preflight.data.ok) || (Array.isArray(preflight.data.problems) && preflight.data.problems.length)) {
    await cleanup();
    throw new Error(`import preflight failed: ${preflight.status} ${JSON.stringify(preflight.data).slice(0, 800)}`);
  }
  const imported = await httpJson(`${productUrl}/api/projects/import`, {
    method: 'POST', body: { localPath: workspace, displayName: 'Dock Acceptance Fixture' },
  });
  const terminalModule = imported.data && imported.data.modules && imported.data.modules.terminal;
  if (imported.status !== 201 || !(imported.data && imported.data.projectId)
    || !(terminalModule && terminalModule.ok === true && terminalModule.status === 'registered' && terminalModule.projectId)) {
    await cleanup();
    throw new Error(`fixture project import/terminal registration failed: ${imported.status} ${JSON.stringify(imported.data).slice(0, 1200)}; product log tail: ${productLogText().slice(-1500)}`);
  }
  env.projectId = imported.data.projectId;
  env.terminalProjectId = terminalModule.projectId;

  const termApi = (pathname, init) => httpJson(`${productUrl}/api/terminal/${pathname.replace(/^\//, '')}`, init);

  // Session knowledge fixture in the module's real persisted format. The
  // module reads this file fresh on every GET /sessions/:id/knowledge, so
  // later writes are picked up live without touching the module process.
  const knowledgeFile = path.join(workbenchDir, 'knowledge-contexts.v1.json');
  const seedSessionKnowledge = (sessionId, references, status = 'ready') => {
    const current = fs.existsSync(knowledgeFile)
      ? JSON.parse(fs.readFileSync(knowledgeFile, 'utf8'))
      : { schema: 'session-knowledge-context/v1', sessions: {} };
    current.sessions[sessionId] = { status, references, retrievedAt: new Date().toISOString() };
    writeJson(knowledgeFile, current);
    return current;
  };

  async function cleanup() {
    const terminalChild = env.processes.terminal;
    if (terminalChild && terminalChild.exitCode === null && terminalChild.pid) {
      if (process.platform === 'win32') {
        try { spawnSync('taskkill', ['/PID', String(terminalChild.pid), '/T', '/F'], { stdio: 'ignore', timeout: 10000, windowsHide: true }); } catch {}
      } else {
        try { terminalChild.kill('SIGTERM'); } catch {}
        await new Promise(resolve => {
          const timer = setTimeout(resolve, 5000);
          terminalChild.once('exit', () => { clearTimeout(timer); resolve(); });
        });
      }
    }
    try { await product.cleanup(); } catch {}
    try {
      const current = JSON.parse(fs.readFileSync(path.join(fixtureRoot, 'owner-marker.json'), 'utf8'));
      if (current.pid === marker.pid) fs.rmSync(fixtureRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch { /* fixture root already gone or not owned */ }
  }

  const identity = () => ({
    pkbRoot: PKB_ROOT,
    productId: 'project-knowledge _site server (spawn-server bootstrap)',
    productPid: product.child.pid,
    productPort, terminalPort,
    terminalEntry: TERMINAL_ENTRY,
    terminalPid: terminal.pid,
    terminalPackageVersion: (() => {
      try { return require(path.join(PKB_ROOT, 'node_modules', 'claude-ai-workbench', 'package.json')).version; } catch { return null; }
    })(),
    servedFiles: {
      'agent-terminal/app.js': { path: path.join(PKB_ROOT, 'node_modules', 'claude-ai-workbench', 'apps', 'agent-terminal', 'app.js') },
      'agent-terminal/right-workspace-dock.js': { path: path.join(PKB_ROOT, 'node_modules', 'claude-ai-workbench', 'apps', 'agent-terminal', 'right-workspace-dock.js') },
      'ui/product.js': { path: path.join(PKB_ROOT, 'ui', 'product.js') },
    },
  });

  const fileHashes = () => {
    const out = {};
    const id = identity();
    for (const [name, entry] of Object.entries(id.servedFiles)) out[name] = sha256File(entry.path);
    return out;
  };

  return {
    ...env,
    termApi,
    seedSessionKnowledge,
    identity,
    fileHashes,
    cleanup,
    terminalLogText: () => terminalLog.join(''),
    productLogText,
  };
}

module.exports = { createDockAcceptanceEnv };
