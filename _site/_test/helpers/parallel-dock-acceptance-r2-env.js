// _site/_test/helpers/parallel-dock-acceptance-r2-env.js
//
// Lane-exclusive helper for batch P-DOCK-ACCEPTANCE-02 (DOCK-001/002/004).
// Derived from the R1 helper (parallel-dock-acceptance-env.js, read-only
// reference). Same isolation contract, plus two R2 additions:
//
//   - an optional read-only copy of a REAL model profile (default:
//     'minimax') into the isolated module data dir, so a real model turn can
//     run without touching the installed desktop workbench. The credential is
//     only written into the isolated temp data dir; it is never logged, never
//     put into a URL, never sent to the browser and never written to a report.
//   - direct access to the isolated module's own API (the product proxy is
//     still available through termApi) plus the module's static app root, so
//     the module's OWN shipped panel host proof page can be driven as a real
//     host for the two-simultaneous-panel case.
//
// Everything else (product shell, fixture project through the real
// onboarding API chain, isolated HOME/ports/data dirs, owner-marker cleanup)
// is unchanged from R1.

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
const MODULE_APP_ROOT = path.join(PKB_ROOT, 'node_modules', 'claude-ai-workbench', 'apps', 'agent-terminal');
const MODULE_API_PREFIX = '/api/claude-workbench/v1';

// Real, already-installed workbench stores. They are opened READ-ONLY and
// only to copy one profile definition + its credential into the isolated
// fixture data dir. The live desktop core 5.0.24 installation is never
// written to, restarted or replaced.
const REAL_PROFILE_STORES = [
  path.join(os.homedir(), '.project-knowledge-v5', 'workbench'),
  path.join(os.homedir(), '.agent-terminal'),
];

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
        resolve({ status: response.statusCode, data, text });
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

// Copy exactly one real profile (definition + credential) into the isolated
// module data dir. The secret never leaves the fixture directory: it is not
// logged, not returned to the caller and not written into any artifact.
function seedModelProfile(workbenchDir, profileId) {
  for (const store of REAL_PROFILE_STORES) {
    const profilesFile = path.join(store, 'profiles.v2.json');
    const credentialsFile = path.join(store, 'credentials.v1.json');
    if (!fs.existsSync(profilesFile) || !fs.existsSync(credentialsFile)) continue;
    let profiles;
    let credentials;
    try {
      profiles = JSON.parse(fs.readFileSync(profilesFile, 'utf8'));
      credentials = JSON.parse(fs.readFileSync(credentialsFile, 'utf8'));
    } catch { continue; }
    const profile = (profiles.profiles || []).find(item => item && item.id === profileId);
    if (!profile) continue;
    const credentialRef = profile.credentialRef || `credential:${profile.id}`;
    const secret = (credentials.credentials || {})[credentialRef];
    if (!secret) continue;
    writeJson(path.join(workbenchDir, 'profiles.v2.json'), {
      schema: 'claude-workbench-profiles/v2',
      profiles: [profile],
      maintenanceDefaultProfileId: null,
    });
    writeJson(path.join(workbenchDir, 'credentials.v1.json'), {
      schema: 'claude-workbench-credentials/v1',
      credentials: { [credentialRef]: secret },
    });
    return {
      profileId: profile.id,
      name: profile.name || null,
      provider: profile.provider || null,
      baseUrl: profile.baseUrl || null,
      model: (profile.models && profile.models.default) || null,
      credentialRef,
      credentialConfigured: true,
      sourceStore: path.basename(store),
    };
  }
  throw new Error(`real profile "${profileId}" not found in any installed workbench store`);
}

async function createDockAcceptanceEnv({ tag = 'dock-acceptance-r2', modelProfileId = null } = {}) {
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
  // Windows roaming/local app data are per-user state directories. The
  // dispatch requires them isolated per run, otherwise a spawned process could
  // read or write the developer's real per-user application state.
  const appDataDir = path.join(fixtureRoot, 'appdata-roaming');
  const localAppDataDir = path.join(fixtureRoot, 'appdata-local');
  const tempDir = path.join(fixtureRoot, 'temp');
  for (const dir of [workspace, knowledgeDir, homeDir, workbenchDir, dataDir, appDataDir, localAppDataDir, tempDir]) fs.mkdirSync(dir, { recursive: true });

  // The model profile (if any) is written BEFORE the module boots so the
  // module reads it from its own store on first use.
  let modelProfile = null;
  if (modelProfileId) modelProfile = seedModelProfile(workbenchDir, modelProfileId);

  const git = (args) => spawnSync('git', ['-C', workspace, ...args], { encoding: 'utf8', windowsHide: true });
  let gitOk = git(['init', '-q']).status === 0;
  gitOk = git(['config', 'user.email', 'dock-acceptance@example.invalid']).status === 0 && gitOk;
  gitOk = git(['config', 'user.name', 'dock-acceptance']).status === 0 && gitOk;
  fs.writeFileSync(path.join(workspace, 'README.md'), '# dock acceptance fixture workspace\n', 'utf8');
  gitOk = git(['add', 'README.md']).status === 0 && gitOk;
  gitOk = git(['commit', '-q', '-m', 'fixture baseline']).status === 0 && gitOk;
  if (!gitOk) throw new Error('fixture workspace could not be initialized as a Git repository');

  const productPort = await freePort();
  const terminalPort = await freePort();
  const terminalUrl = `http://127.0.0.1:${terminalPort}`;
  const productUrl = `http://127.0.0.1:${productPort}`;

  const product = spawnServer({
    root: PKB_ROOT, port: productPort, dataDir, tag,
    analysisOwner: 'engine',
    extraEnv: {
      KB_TERMINAL_URL: terminalUrl,
      KB_MODULES_AUTOSTART: '0',
      KB_MODULES_REGISTER: '1',
      HOME: homeDir, USERPROFILE: homeDir,
      APPDATA: appDataDir, LOCALAPPDATA: localAppDataDir, TEMP: tempDir, TMP: tempDir,
    },
  });

  const env = {
    fixtureRoot, workspace, knowledgeDir, homeDir, workbenchDir, dataDir,
    appDataDir, localAppDataDir, tempDir,
    productUrl, terminalUrl, productPort, terminalPort,
    modelProfile,
    projectId: null,
    terminalProjectId: null,
    processes: { product: product.child, terminal: null },
  };

  const productLog = [];
  const productTail = (chunk) => productLog.push(String(chunk));
  product.child.stdout.on('data', productTail);
  product.child.stderr.on('data', productTail);
  const productLogText = () => productLog.join('');

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
      APPDATA: appDataDir, LOCALAPPDATA: localAppDataDir, TEMP: tempDir, TMP: tempDir,
      // The CLI that the Agent SDK spawns must not read or write the real
      // developer's agent config directories.
      CLAUDE_CONFIG_DIR: path.join(homeDir, '.claude'),
      CODEX_HOME: path.join(homeDir, '.codex'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  env.processes.terminal = terminal;
  const tail = (chunk) => terminalLog.push(String(chunk));
  terminal.stdout.on('data', tail);
  terminal.stderr.on('data', tail);

  try {
    await waitForHttpOk(`${terminalUrl}${MODULE_API_PREFIX}/health`, 'terminal module health', 60000,
      data => data && data.status === 'ok' && typeof data.apiVersion === 'string');
  } catch (error) {
    await cleanup();
    throw new Error(`${error.message}; terminal log tail: ${terminalLog.join('').slice(-2000)}`);
  }

  // Real onboarding chain (settings -> preflight -> import). The import route
  // registers the fixture project with the terminal module and persists the
  // state.modules.terminal wiring the product UI depends on.
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

  // Through the PRODUCT proxy (the path the product UI actually uses).
  const termApi = (pathname, init) => httpJson(`${productUrl}/api/terminal/${pathname.replace(/^\//, '')}`, init);
  // Direct to the isolated module (same server, bypassing the product proxy).
  const moduleApi = (pathname, init) => httpJson(`${terminalUrl}${MODULE_API_PREFIX}/${pathname.replace(/^\//, '')}`, init);

  const knowledgeFile = path.join(workbenchDir, 'knowledge-contexts.v1.json');
  const seedSessionKnowledge = (sessionId, references, status = 'ready') => {
    const current = fs.existsSync(knowledgeFile)
      ? JSON.parse(fs.readFileSync(knowledgeFile, 'utf8'))
      : { schema: 'session-knowledge-context/v1', sessions: {} };
    current.sessions[sessionId] = { status, references, retrievedAt: new Date().toISOString() };
    writeJson(knowledgeFile, current);
    return current;
  };

  // The isolated module's own native-task store identity (used by the
  // public native-tasks read API). The module publishes it as
  // { schema: 'workbench-store/v1', storeId }.
  const storeScope = () => {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(workbenchDir, 'store-id.v1.json'), 'utf8'));
      return raw.storeId || raw.storeScope || raw.scope || raw.id || null;
    } catch { return null; }
  };

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
    modelProfile: env.modelProfile,
    servedFiles: {
      'agent-terminal/app.js': { path: path.join(MODULE_APP_ROOT, 'app.js') },
      'agent-terminal/right-workspace-dock.js': { path: path.join(MODULE_APP_ROOT, 'right-workspace-dock.js') },
      'agent-terminal/right-dock-panel-registry.js': { path: path.join(MODULE_APP_ROOT, 'right-dock-panel-registry.js') },
      'agent-terminal/panel-host-proof.html': { path: path.join(MODULE_APP_ROOT, 'panel-host-proof.html') },
      'agent-terminal/panel-proof-content.html': { path: path.join(MODULE_APP_ROOT, 'panel-proof-content.html') },
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
    moduleApi,
    seedSessionKnowledge,
    storeScope,
    identity,
    fileHashes,
    cleanup,
    // The module's own shipped panel host proof page (a real host that
    // registers a multi-instance panel provider through the public panel
    // protocol and drives it with real buttons).
    panelProofHostUrl: () => `${terminalUrl}/agent-terminal/panel-host-proof.html`,
    terminalLogText: () => terminalLog.join(''),
    productLogText,
  };
}

module.exports = { createDockAcceptanceEnv, MODULE_API_PREFIX, MODULE_APP_ROOT };
