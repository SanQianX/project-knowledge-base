// _site/_test/helpers/parallel-dock-isolation-r3-env.js
//
// Lane-exclusive fixture for P-DOCK-ISOLATION-R3.
//
// The terminal module is NOT started here: the launcher starts it inside the
// isolated environment and hands over its address through the handoff file.
// This helper starts the PRODUCT (the pkb server) inside the same isolated
// environment, runs the real onboarding chain and exposes the public APIs.
//
// Read-only references: parallel-dock-acceptance-r2-env.js (the accepted R2
// fixture) and parallel-dock-isolation-r3-fixture.js (this lane's isolation
// scaffolding).

'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const { spawnServer } = require('./spawn-server');
const { sha256File, writeJson, readJsonSafe } = require('./parallel-dock-isolation-r3-fixture.js');

const PKB_ROOT = path.resolve(__dirname, '..', '..', '..');
const MODULE_APP_ROOT = path.join(PKB_ROOT, 'node_modules', 'claude-ai-workbench', 'apps', 'agent-terminal');
const MODULE_API_PREFIX = '/api/claude-workbench/v1';

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

// Creates the product half of the isolated fixture. The module half is
// already running (started by the launcher with the same isolation).
async function createDockIsolationEnv({ tag = 'dock-isolation-r3', handoff } = {}) {
  if (!handoff || !handoff.layout || !handoff.moduleUrl) {
    throw new Error('createDockIsolationEnv needs the launcher handoff (layout + moduleUrl)');
  }
  const layout = handoff.layout;
  const productPort = Number(handoff.productPort);
  const productUrl = `http://127.0.0.1:${productPort}`;

  // A real Git workspace: the onboarding chain imports a real project.
  const git = (args) => spawnSync('git', ['-C', layout.workspace, ...args], { encoding: 'utf8', windowsHide: true });
  let gitOk = git(['init', '-q']).status === 0;
  gitOk = git(['config', 'user.email', 'dock-isolation-r3@example.invalid']).status === 0 && gitOk;
  gitOk = git(['config', 'user.name', 'dock-isolation-r3']).status === 0 && gitOk;
  fs.writeFileSync(path.join(layout.workspace, 'README.md'), '# dock isolation r3 fixture workspace\n', 'utf8');
  gitOk = git(['add', 'README.md']).status === 0 && gitOk;
  gitOk = git(['commit', '-q', '-m', 'fixture baseline']).status === 0 && gitOk;
  if (!gitOk) throw new Error('fixture workspace could not be initialized as a Git repository');

  // The product inherits the isolated environment of this (already isolated)
  // probe process: spawn-server spreads process.env, and every value in it
  // was allowlisted by the launcher.
  const product = spawnServer({
    root: PKB_ROOT, port: productPort, dataDir: layout.knowledgeDataDir, tag,
    analysisOwner: 'engine',
    extraEnv: {
      KB_TERMINAL_URL: handoff.moduleUrl,
      KB_MODULES_AUTOSTART: '0',
      KB_MODULES_REGISTER: '1',
    },
  });

  const env = {
    layout,
    handoff,
    workspace: layout.workspace,
    knowledgeDir: layout.knowledgeRoot,
    homeDir: layout.home,
    workbenchDir: layout.dataDir,
    dataDir: layout.knowledgeDataDir,
    productUrl,
    terminalUrl: handoff.moduleUrl,
    productPort,
    terminalPort: handoff.modulePort,
    moduleRoot: handoff.moduleRoot,
    chromePath: handoff.chromePath,
    modelProfile: handoff.profileDefinition
      ? {
        profileId: handoff.profileDefinition.id,
        name: handoff.profileDefinition.name,
        provider: handoff.profileDefinition.provider,
        baseUrl: handoff.profileDefinition.baseUrl,
        model: handoff.profileDefinition.models && handoff.profileDefinition.models.default,
        credentialRef: handoff.profileDefinition.credentialRef,
        // The credential lives in the SERVER memory only. It is never copied
        // into a credential file, a backup, a report or a URL.
        credentialConfigured: true,
        credentialLocation: 'server-memory (pipe handoff, overlay on ProfileStore read paths)',
      }
      : null,
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
    try { await product.cleanup(); } catch {}
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

  // Real onboarding chain (settings -> preflight -> import). The import route
  // registers the fixture project with the isolated terminal module.
  const patched = await httpJson(`${productUrl}/api/settings`, {
    method: 'PATCH', body: { knowledge: { rootPath: layout.knowledgeRoot } },
  });
  if (patched.status !== 200 || !(patched.data && patched.data.ok)) {
    await cleanup();
    throw new Error(`settings knowledge-root patch failed: ${patched.status} ${JSON.stringify(patched.data).slice(0, 800)}`);
  }
  const preflight = await httpJson(`${productUrl}/api/projects/preflight-import`, {
    method: 'POST', body: { localPath: layout.workspace },
  });
  if (preflight.status !== 200 || !(preflight.data && preflight.data.ok) || (Array.isArray(preflight.data.problems) && preflight.data.problems.length)) {
    await cleanup();
    throw new Error(`import preflight failed: ${preflight.status} ${JSON.stringify(preflight.data).slice(0, 800)}`);
  }
  const imported = await httpJson(`${productUrl}/api/projects/import`, {
    method: 'POST', body: { localPath: layout.workspace, displayName: 'Dock Isolation R3 Fixture' },
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
  const moduleApi = (pathname, init) => httpJson(`${handoff.moduleUrl}${MODULE_API_PREFIX}/${pathname.replace(/^\//, '')}`, init);

  const knowledgeFile = path.join(layout.dataDir, 'knowledge-contexts.v1.json');
  const seedSessionKnowledge = (sessionId, references, status = 'ready') => {
    const current = readJsonSafe(knowledgeFile) || { schema: 'session-knowledge-context/v1', sessions: {} };
    current.sessions[sessionId] = { status, references, retrievedAt: new Date().toISOString() };
    writeJson(knowledgeFile, current);
    return current;
  };

  // The isolated module's own native-task store identity.
  const storeScope = () => {
    const raw = readJsonSafe(path.join(layout.dataDir, 'store-id.v1.json'));
    if (!raw) return null;
    return raw.storeId || raw.storeScope || raw.scope || raw.id || null;
  };

  // A purely fictional profile with a fake key: it needs no provider call at
  // all, and it exercises the module's REAL ProfileStore.
  const seedFictionalProfile = async ({ id = 'r3-fictional', name = 'R3 Fictional', baseUrl = 'https://r3-fictional.invalid', model = 'r3-fictional-model' } = {}) => {
    const saved = await moduleApi('profiles', {
      method: 'POST',
      body: {
        id, name, provider: 'anthropic-compatible', protocol: 'anthropic-compatible',
        baseUrl, models: { default: model }, enabled: true, permissionMode: 'default',
      },
    });
    if (saved.status !== 201 && saved.status !== 200) {
      throw new Error(`fictional profile could not be saved: ${saved.status} ${String(saved.text).slice(0, 600)}`);
    }
    const credential = await moduleApi(`profiles/${id}/credential`, {
      method: 'PUT', body: { secret: 'sk-r3-fictional-invalid-key.invalid' },
    });
    if (credential.status !== 200 && credential.status !== 201 && credential.status !== 204) {
      throw new Error(`fictional credential could not be stored: ${credential.status} ${String(credential.text).slice(0, 600)}`);
    }
    const listed = await moduleApi('profiles');
    const rows = Array.isArray(listed.data) ? listed.data : ((listed.data && listed.data.profiles) || []);
    const found = rows.find(item => item && item.id === id) || null;
    return {
      profileId: id,
      credentialConfigured: Boolean(found && found.credentialConfigured),
      baseUrl,
      model,
      fakeKeyHost: '.invalid',
    };
  };

  // The environment the PRODUCT process actually received. spawn-server
  // spreads the (already allowlisted) probe environment and overrides the
  // knowledge/bridge locations with its own isolated directories.
  const productEnv = () => ({
    ...process.env,
    KB_SITE_PORT: String(productPort),
    KB_SITE_HOST: '127.0.0.1',
    KB_DATA_DIR: product.dataDir,
    KB_KNOWLEDGE_DATA_DIR: product.knowledgeDir,
    KB_CLAUDE_RULES_DIR: product.dataDir,
    KB_SKIP_MIGRATION: '1',
    KB_MODULES_REGISTER: '1',
    KB_MODULES_AUTOSTART: '0',
    KB_TERMINAL_URL: handoff.moduleUrl,
    KB_VECTORHUB_URL: 'http://127.0.0.1:0',
    KB_EVENTBRIDGE_URL: 'http://127.0.0.1:0',
    KB_KNOWLEDGE_ENGINE_URL: 'http://127.0.0.1:0',
    AI_CODING_EVENT_BRIDGE_HOME: product.bridgeHome,
  });

  const identity = () => ({
    pkbRoot: PKB_ROOT,
    productId: 'project-knowledge _site server (spawn-server bootstrap)',
    productPid: product.child.pid,
    productPort,
    terminalPort: handoff.modulePort,
    terminalPid: handoff.modulePid,
    terminalEntry: handoff.terminalEntry,
    terminalPackageVersion: (() => {
      try { return require(path.join(PKB_ROOT, 'node_modules', 'claude-ai-workbench', 'package.json')).version; } catch { return null; }
    })(),
    moduleRoot: handoff.moduleRoot,
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
    seedFictionalProfile,
    storeScope,
    identity,
    fileHashes,
    productEnv,
    productEnvKeys: () => Object.keys(productEnv()).sort(),
    cleanup,
    panelProofHostUrl: () => `${handoff.moduleUrl}/agent-terminal/panel-host-proof.html`,
    terminalLogText: () => (handoff.moduleLogPath ? (() => { try { return fs.readFileSync(handoff.moduleLogPath, 'utf8'); } catch { return ''; } })() : ''),
    productLogText,
  };
}

module.exports = { createDockIsolationEnv, MODULE_API_PREFIX, MODULE_APP_ROOT };
