'use strict';
/**
 * Module bridge: connectivity from project-knowledge to the embedded modules
 * (claude-ai-workbench Agent Terminal, vector-hub console, ai-coding-event-bridge
 * conversation console).
 *
 * The shell owns no features — it only connects and projects. This module is
 * that connection on the server side:
 *   - reverse proxy for browser calls (keeps the UI same-origin; no CORS on modules)
 *   - registration fan-out on project import (the "wiring table" lives in project state)
 *   - aggregated project projection for the shell sidebar
 *   - module removal with keepSessions semantics
 *
 * Configuration (env, loopback defaults):
 *   KB_TERMINAL_URL     default http://127.0.0.1:5760 (managed: dynamic when busy)
 *   KB_VECTORHUB_URL    default http://127.0.0.1:8787 (managed: dynamic when busy)
 *   KB_EVENTBRIDGE_URL  default http://127.0.0.1:8790 (managed: dynamic when busy)
 *   KB_KNOWLEDGE_ENGINE_URL default http://127.0.0.1:5790 (managed: dynamic when busy)
 *   An explicitly injected URL is treated as an external service and never
 *   rewritten. Managed modules resolve a final URL before spawn: healthy
 *   identity match reuses the port, otherwise the next free port from
 *   preferred +0..+19 is taken; all busy fails loudly (NO_FREE_MODULE_PORT).
 *   KB_MODULES_AUTOSTART  '0' to stop spawning the vendored module services
 *                         (they start with the shell by default)
 *   KB_TERMINAL_COMMAND  explicit node command line for the terminal service
 *   KB_VECTORHUB_COMMAND explicit node command line for the vector-hub service
 *   KB_EVENTBRIDGE_COMMAND explicit node command line for the event-bridge console
 */

const { spawn, spawnSync } = require('child_process');
const net = require('net');
const path = require('path');
const { StorageLayout } = require('./storage-layout');
const { resolveModuleUrl } = require('./module-port-resolver');
const fs = require('fs');
const crypto = require('crypto');
const { once } = require('events');
const { DomainError } = require('./contracts');

const PROXY_TIMEOUT_MS = 10000;
// Native client startup includes knowledge retrieval and a local server/CLI
// handshake. It has a bounded setup budget, separate from ordinary reads/SSE.
const AGENT_START_TIMEOUT_MS = 90000;
// Registration drives a full embedding pass in vector-hub (remote API); a
// fresh knowledge folder can easily exceed the interactive proxy budget.
const REGISTER_TIMEOUT_MS = 60000;
// Match knowledge-engine's index request budget for synchronous embedding.
const INDEX_TIMEOUT_MS = 120000;
// Native folder dialogs wait for the user without a bound.
const PICKER_TIMEOUT_MS = 10 * 60 * 1000;

// Vendored module runtimes shipped inside the npm package. Sibling-checkout
// spawning is gone: the services are bundled, spawned from here, and resolved
// through normal node_modules resolution
// node_modules.
// Module entry scripts resolve through normal node_modules dependencies
// (claude-ai-workbench, @sanqianx/vector-hub, @sanqianx/ai-coding-event-bridge-
// console) — the npm packages are the single source of these runtimes.
const MODULE_ENTRIES = {
  terminal: 'claude-ai-workbench/packages/server/bin/agent-terminal-server.js',
  'vector-hub': '@sanqianx/vector-hub/bin.js',
  'event-bridge': '@sanqianx/ai-coding-event-bridge-console/src/bin.js',
};

function resolveModuleEntry(name) {
  if (name === 'knowledge-engine') {
    const runtime = path.resolve(__dirname, '..', '..', '_modules', 'knowledge-engine', 'src', 'bin.js');
    return fs.existsSync(runtime) ? runtime : null;
  }
  try { return require.resolve(MODULE_ENTRIES[name]); } catch { return null; }
}

function urlPort(baseUrl, fallback) {
  try { return new URL(baseUrl).port || String(fallback); } catch { return String(fallback); }
}

function urlHost(baseUrl) {
  try { return new URL(baseUrl).hostname || '127.0.0.1'; } catch { return '127.0.0.1'; }
}

function defaultTerminalUrl() {
  return String(process.env.KB_TERMINAL_URL || 'http://127.0.0.1:5760').replace(/\/+$/, '');
}

function defaultVectorHubUrl() {
  return String(process.env.KB_VECTORHUB_URL || 'http://127.0.0.1:8787').replace(/\/+$/, '');
}

function defaultEventBridgeUrl() {
  return String(process.env.KB_EVENTBRIDGE_URL || 'http://127.0.0.1:8790').replace(/\/+$/, '');
}

function defaultEngineUrl() { return String(process.env.KB_KNOWLEDGE_ENGINE_URL || 'http://127.0.0.1:5790').replace(/\/+$/, ''); }

// Health identity markers: an HTTP 200 alone can come from any foreign
// service that grabbed the port. Only a body that matches the product
// counts as "our module already running" (reuse); anything else is
// foreign and the resolver moves to another port instead of crash-looping.
const MODULE_IDENTITY = {
  terminal: body => body && typeof body === 'object' && body.status === 'ok' && typeof body.apiVersion === 'string',
  vectorHub: body => body && typeof body === 'object' && Array.isArray(body.projects),
  eventBridge: body => body && typeof body === 'object' && typeof body.registeredProjects === 'number',
  engine: body => body && typeof body === 'object' && body.name === 'knowledge-engine',
};

// kind -> bridge URL property, explicit env override, spawn spec name
const MODULE_URL_TARGETS = [
  { kind: 'terminal', prop: 'terminalUrl', env: 'KB_TERMINAL_URL', specName: 'terminal' },
  { kind: 'vectorHub', prop: 'vectorHubUrl', env: 'KB_VECTORHUB_URL', specName: 'vector-hub' },
  { kind: 'eventBridge', prop: 'eventBridgeUrl', env: 'KB_EVENTBRIDGE_URL', specName: 'event-bridge' },
  { kind: 'engine', prop: 'engineUrl', env: 'KB_KNOWLEDGE_ENGINE_URL', specName: 'knowledge-engine' },
];

function specNameToKind(specName) {
  return MODULE_URL_TARGETS.find(target => target.specName === specName)?.kind || null;
}

function tcpPortFree(host, port) {
  return new Promise(resolve => {
    const tester = net.createServer();
    let done = false;
    const finish = free => { if (done) return; done = true; tester.close(() => resolve(free)); };
    tester.once('error', () => finish(false));
    tester.once('listening', () => finish(true));
    tester.listen(port, host);
  });
}

class ModuleBridge {
  constructor(options = {}) {
    this.logger = options.logger || { info: () => {}, warn: () => {}, error: () => {} };
    this.terminalUrl = options.terminalUrl || defaultTerminalUrl();
    this.vectorHubUrl = options.vectorHubUrl || defaultVectorHubUrl();
    this.eventBridgeUrl = options.eventBridgeUrl || defaultEventBridgeUrl();
    this.engineUrl = options.engineUrl || defaultEngineUrl();
    // Explicitly injected URLs (option or env) mean an external service;
    // only managed defaults participate in dynamic port resolution.
    this.explicitModuleUrls = {
      terminal: Boolean(options.terminalUrl || process.env.KB_TERMINAL_URL),
      vectorHub: Boolean(options.vectorHubUrl || process.env.KB_VECTORHUB_URL),
      eventBridge: Boolean(options.eventBridgeUrl || process.env.KB_EVENTBRIDGE_URL),
      engine: Boolean(options.engineUrl || process.env.KB_KNOWLEDGE_ENGINE_URL),
    };
    this.moduleUrlSources = { terminal: 'pending', vectorHub: 'pending', eventBridge: 'pending', engine: 'pending' };
    this.runtimeToken = options.runtimeToken || crypto.randomBytes(32).toString('hex');
    this.registryStore = options.registryStore || null;
    this.projectStore = options.projectStore || null;
    this.projectWiringQueue = new Map();
    this.settingsStore = options.settingsStore || null;
    this.dataDir = options.dataDir || null;
    this.supervised = [];
  }

  _terminalApi(pathname) {
    // /api/terminal/<rest> -> <terminal>/api/claude-workbench/v1/<rest>
    const rest = pathname.replace(/^\/api\/terminal\/?/, '');
    return `${this.terminalUrl}/api/claude-workbench/v1/${rest}`;
  }

  _vectorHubApi(pathname) {
    // /api/vectorhub/<rest> -> <vectorhub>/api/<rest>
    const rest = pathname.replace(/^\/api\/vectorhub\/?/, '');
    return `${this.vectorHubUrl}/api/${rest}`;
  }

  _eventBridgeApi(pathname) {
    // /api/eventbridge/<rest> -> <event-bridge console>/api/<rest>
    const rest = pathname.replace(/^\/api\/eventbridge\/?/, '');
    return `${this.eventBridgeUrl}/api/${rest}`;
  }

  async _fetch(url, init = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), init.timeoutMs || PROXY_TIMEOUT_MS);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  /** Same-origin proxy. SSE has a headers deadline, never a whole-turn deadline. */
  async proxy(req, res, target) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    // The native folder pickers hold the request open until the user closes
    // the dialog — they need a human-scale budget, not the API budget.
    const isPicker = /\/(system\/)?pick-folder/.test(target);
    const targetUrl = new URL(target);
    const pathname = targetUrl.pathname;
    const isAgentStart = req.method === 'POST' && /^\/api\/claude-workbench\/v1\/sessions(?:\/[^/]+\/input)?\/?$/.test(pathname);
    const isIndex = req.method === 'POST' && pathname === '/api/sync' && targetUrl.origin === new URL(this.vectorHubUrl).origin;
    const timeoutMs = isPicker ? PICKER_TIMEOUT_MS : isAgentStart ? AGENT_START_TIMEOUT_MS : isIndex ? INDEX_TIMEOUT_MS : PROXY_TIMEOUT_MS;
    const startedAt = Date.now();
    let upstream;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const disconnected = () => { if (!res.writableEnded) controller.abort(); };
    res.once?.('close', disconnected);
    try {
      upstream = await fetch(target, {
        method: req.method,
        signal: controller.signal,
        headers: { ...(body ? { 'Content-Type': req.headers['content-type'] || 'application/json' } : {}), ...(req.headers['last-event-id'] ? { 'Last-Event-ID': req.headers['last-event-id'] } : {}) },
        body: ['GET', 'HEAD'].includes(req.method) ? undefined : body,
      });
    } catch (error) {
      clearTimeout(timer);
      res.off?.('close', disconnected);
      if (res.destroyed) return;
      const details = { failureKind: controller.signal.aborted ? 'UPSTREAM_TIMEOUT' : 'NETWORK_ERROR', timeoutMs };
      this.logger.warn('module.proxy.failed', '模块请求未完成，请检查连接或客户端启动。', {
        component: 'module-bridge', phase: 'proxy', durationMs: Date.now() - startedAt,
        context: { ...details, method: req.method, path: pathname },
      });
      res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: 'MODULE_UNREACHABLE', target: targetUrl.origin + pathname, details }));
      return;
    }
    const contentType = upstream.headers.get('content-type') || 'application/json; charset=utf-8';
    if (contentType.includes('text/event-stream')) {
      clearTimeout(timer);
      res.writeHead(upstream.status, { 'Content-Type': contentType, 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.flushHeaders?.();
      try {
        for await (const chunk of upstream.body) {
          if (res.destroyed) break;
          if (!res.write(Buffer.from(chunk))) await once(res, 'drain', { signal: controller.signal });
        }
        if (!res.destroyed) res.end();
      } catch { if (!res.destroyed) res.destroy(); }
      finally { controller.abort(); res.off?.('close', disconnected); }
    } else {
      try {
        const buf = Buffer.from(await upstream.arrayBuffer());
        res.writeHead(upstream.status, { 'Content-Type': contentType });
        res.end(buf);
      } finally { clearTimeout(timer); res.off?.('close', disconnected); }
    }
  }

  proxyTerminal(req, res, pathname, search) {
    return this.proxy(req, res, this._terminalApi(pathname) + (search || ''));
  }

  proxyVectorHub(req, res, pathname, search) {
    return this.proxy(req, res, this._vectorHubApi(pathname) + (search || ''));
  }

  proxyEventBridge(req, res, pathname, search) {
    return this.proxy(req, res, this._eventBridgeApi(pathname) + (search || ''));
  }

  proxyEngine(req, res, pathname, search) {
    if (this.engineCompatible === false) throw new DomainError('ENGINE_CONNECTION_PENDING', '知识引擎连接尚未确认，请查看系统状态；不会读取旧服务中的知识。', { status: 503 });
    return this.proxy(req, res, `${this.engineUrl}/api/${pathname.replace(/^\/api\/engine\/?/, '')}${search || ''}`);
  }

  proxyModuleUi(req, res, module, rest, search) {
    const base = { terminal: this.terminalUrl, vectorhub: this.vectorHubUrl, eventbridge: this.eventBridgeUrl, engine: this.engineUrl }[module];
    let decoded;
    try { decoded = decodeURIComponent(rest); } catch { decoded = null; }
    // Reject encoded separators/dot segments before URL normalization. Static
    // mounts must never become a second route to a module's private API.
    if (!base || req.method !== 'GET' || decoded === null || /[\\\x00-\x1f]/.test(decoded) || decoded.split('/').some(part => ['.', '..', 'api', 'internal'].includes(part.toLowerCase())) || /%[0-9a-f]{2}/i.test(decoded)) { res.statusCode = 404; res.end('Not found'); return; }
    const target = new URL(`${base}/${rest}${search || ''}`);
    if (target.origin !== new URL(base).origin) { res.statusCode = 404; res.end('Not found'); return; }
    return this.proxy(req, res, target.href);
  }

  async _listTerminalProjects() {
    try {
      const response = await this._fetch(`${this.terminalUrl}/api/claude-workbench/v1/projects`, { timeoutMs: 2500 });
      if (!response.ok) return [];
      const payload = await response.json();
      const list = Array.isArray(payload) ? payload : payload.projects;
      return Array.isArray(list) ? list : [];
    } catch { return []; }
  }

  async _listVectorHubProjects() {
    try {
      const response = await this._fetch(`${this.vectorHubUrl}/api/projects`, { timeoutMs: 2500 });
      if (!response.ok) return [];
      const payload = await response.json();
      return Array.isArray(payload.projects) ? payload.projects : [];
    } catch { return []; }
  }

  async _listEventBridgeProjects() {
    try {
      const response = await this._fetch(`${this.eventBridgeUrl}/api/projects`, { timeoutMs: 2500 });
      if (!response.ok) return [];
      const payload = await response.json();
      return Array.isArray(payload.projects) ? payload.projects : [];
    } catch { return []; }
  }

  async _listEngineProjects() {
    if (this.engineCompatible === false) return [];
    try {
      const response = await this._fetch(`${this.engineUrl}/api/projects`, { timeoutMs: 2500 });
      if (!response.ok) return [];
      const payload = await response.json();
      return Array.isArray(payload.projects) ? payload.projects : [];
    } catch { return []; }
  }

  /** Aggregated projection for the shell sidebar: pkb registry is the spine. */
  async aggregatedProjects() {
    const healthJob = this.modulesHealth();
    const [terminalProjects, vectorHubProjects, eventBridgeProjects, engineProjects] = await Promise.all([
      this._listTerminalProjects(),
      this._listVectorHubProjects(),
      this._listEventBridgeProjects(),
      this._listEngineProjects(),
    ]);
    const ids = this.registryStore ? this.registryStore.listIds() : [];
    const byWorkspace = new Map(terminalProjects.map(p => [String(p.rootPath || '').toLowerCase(), p]));
    const byName = new Map(vectorHubProjects.map(p => [String(p.name), p]));
    const ebByPath = new Map(eventBridgeProjects.filter(p => p.path).map(p => [String(p.path).toLowerCase(), p]));
    const projects = ids.map(projectId => {
      const config = this.projectStore ? (this.projectStore.readConfig(projectId) || {}) : {};
      const workspacePath = String(config.repoPath || '');
      const knowledgePath = String(config.knowledgePath || '');
      const state = this.projectStore ? this.projectStore.readState(projectId) : {};
      const wiring = state.modules || {};
      const terminal = byWorkspace.get(workspacePath.toLowerCase())
        || (wiring.terminal && wiring.terminal.projectId ? terminalProjects.find(p => p.id === wiring.terminal.projectId) : null)
        || null;
      const vectorHubName = (wiring.vectorHub && wiring.vectorHub.projectName) || projectId;
      const vectorHub = byName.get(vectorHubName) || null;
      const eventBridge = ebByPath.get(workspacePath.toLowerCase())
        || (wiring.eventBridge && wiring.eventBridge.projectId ? eventBridgeProjects.find(p => p.id === wiring.eventBridge.projectId) : null)
        || null;
      return {
        projectId,
        name: config.displayName || projectId,
        workspacePath,
        knowledgePath,
        brainId: config.brainId || 'brain-default',
        domainId: config.domainId || null,
        modules: {
          terminal: terminal ? { registered: true, projectId: terminal.id, name: terminal.name } : { registered: false, status: wiring.terminal && wiring.terminal.status },
          vectorHub: vectorHub ? { registered: true, projectName: vectorHub.name, docCount: vectorHub.docCount, chunkCount: vectorHub.chunkCount, watching: !!vectorHub.watching } : { registered: false, status: wiring.vectorHub && wiring.vectorHub.status },
          eventBridge: eventBridge ? { registered: true, projectId: eventBridge.id, turns: eventBridge.turns, auto: !!eventBridge.auto } : { registered: false, status: wiring.eventBridge && wiring.eventBridge.status },
          engine: engineProjects.some(p => p.projectId === projectId) ? { registered: true, projectId } : { registered: false, status: wiring.engine && wiring.engine.status },
        },
      };
    });
    const health = (await healthJob).modules;
    return {
      projects,
      terminalAvailable: health.terminal.up, vectorHubAvailable: health.vectorHub.up, eventBridgeAvailable: health.eventBridge.up, engineAvailable: health.engine.up,
    };
  }

  /**
   * Classify what is listening on a module URL.
   * 'module'     HTTP 2xx + product identity marker -> safe to reuse
   * 'foreign'    HTTP responded but identity mismatch -> never reuse
   * 'unreachable' no HTTP answer (free port or non-HTTP listener)
   */
  async _probeClass(base, kind) {
    const route = kind === 'terminal' ? '/api/claude-workbench/v1/health' : '/api/health';
    const marker = MODULE_IDENTITY[kind];
    if (!marker) return 'unreachable';
    try {
      const response = await this._fetch(`${base}${route}`, { timeoutMs: 2000 });
      if (!response.ok) return 'unreachable';
      let body;
      try { body = await response.json(); } catch { return 'foreign'; }
      return marker(body) ? 'module' : 'foreign';
    } catch { return 'unreachable'; }
  }

  async _probe(base, kind) {
    const resolvedKind = kind || (base === this.terminalUrl ? 'terminal' : null);
    if (!resolvedKind) return false;
    return (await this._probeClass(base, resolvedKind)) === 'module';
  }

  async modulesHealth() {
    const [terminal, vectorHub, eventBridge, engine] = await Promise.all([
      this._probe(this.terminalUrl, 'terminal'),
      this._probe(this.vectorHubUrl, 'vectorHub'),
      this._probe(this.eventBridgeUrl, 'eventBridge'),
      this._probe(this.engineUrl, 'engine'),
    ]);
    return { ok: true, modules: {
      terminal: { url: this.terminalUrl, up: terminal, source: this.moduleUrlSources.terminal },
      vectorHub: { url: this.vectorHubUrl, up: vectorHub, source: this.moduleUrlSources.vectorHub },
      eventBridge: { url: this.eventBridgeUrl, up: eventBridge, source: this.moduleUrlSources.eventBridge },
      engine: { url: this.engineUrl, up: engine, source: this.moduleUrlSources.engine },
    } };
  }

  syncEngineConfiguration({ force = false } = {}) {
    const signature = () => { try { return crypto.createHash('sha256').update(JSON.stringify(this.settingsStore?.read() || {})).digest('hex'); } catch { return ''; } };
    if (this.configSyncPromise) {
      if (force || signature() !== this.configSyncSettings) this.configSyncDirty = true;
      return this.configSyncPromise;
    }
    const pending = (async () => {
      let result;
      do { this.configSyncDirty = false; this.configSyncSettings = signature(); result = await this._syncEngineConfiguration(); } while (this.configSyncDirty && !this.stopped);
      return result;
    })().finally(() => { if (this.configSyncPromise === pending) this.configSyncPromise = null; });
    this.configSyncPromise = pending;
    return pending;
  }

  resetRuntimeConfiguration() {
    this.configFingerprints = {};
    this.configGeneration = (this.configGeneration || 0) + 1;
    if (this.configSyncPromise) this.configSyncDirty = true;
  }

  async _syncEngineConfiguration() {
    const applyConfiguration = async (key, url, body) => {
      this.configFingerprints ||= {};
      const generation = this.configGeneration;
      const fingerprint = crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
      if (this.configFingerprints[key]?.fingerprint === fingerprint) return this.configFingerprints[key].result;
      const response = await this._fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.runtimeToken}` }, body: JSON.stringify(body) });
      const result = { ok: response.ok, data: response.ok ? await response.json().catch(() => ({})) : null };
      if (result.ok && this.configGeneration === generation) this.configFingerprints[key] = { fingerprint, result };
      else delete this.configFingerprints[key];
      return result;
    };
    const dataDir = this.dataDir || require('./data-dir').getDataDir();
    let indexPath = null;
    try { indexPath = new StorageLayout({ dataDir }).getVectorRootPath(this.settingsStore?.read()); }
    catch { /* Corrupt settings must not switch storage or prevent credential revocation. */ }
    const status = { scopes: false, scopeStatus: { status: 'pending' }, model: false, embedding: false, indexStorage: { expectedPath: indexPath, actualPath: null, status: 'pending' } };
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${this.runtimeToken}` };
    try {
      if (this.settingsStore) {
        const settings = this.settingsStore.read();
        if (settings.knowledge.rootPath) {
          const brain = settings.brain;
          const root = path.join(settings.knowledge.rootPath, '_shared');
          const response = await this._fetch(`${this.engineUrl}/api/snapshot?summary=1&limit=1`);
          if (!response.ok) throw new DomainError('ENGINE_UNAVAILABLE', '共享知识接线暂时不可用。');
          const prior = (await response.json()).sharedScopes || [];
          // Root settings govern new directories and derived indexes, never move
          // existing knowledge. Retain engine-acknowledged bindings in the spine.
          const binding = (item, kind) => {
            const existing = prior.find(scope => scope.id === item.id && scope.kind === kind && scope.brainId === brain.id);
            if (existing && !path.isAbsolute(existing.knowledgePath || '')) throw new DomainError('DATA_CORRUPT', '共享目录绑定损坏。');
            return item.knowledgePath || existing?.knowledgePath || path.join(root, item.id);
          };
          const scopes = [{ id: brain.id, kind: 'brain', brainId: brain.id, name: brain.name, knowledgePath: binding(brain, 'brain') }, ...brain.domains.map(d => ({ id: d.id, kind: 'domain', brainId: brain.id, domainId: d.id, name: d.name, knowledgePath: binding(d, 'domain') }))];
          const applied = await applyConfiguration('scopes', `${this.engineUrl}/api/scopes`, { scopes });
          if (!applied.ok) throw new DomainError('SHARED_SCOPE_APPLY_FAILED', '共享目录接线未完成。');
          await this.settingsStore.bindSharedKnowledgePaths?.(scopes);
          status.scopes = true; status.scopeStatus = { status: 'ready' };
        }
      }
    } catch (error) {
      status.scopeStatus = { status: 'pending', code: ['DATA_CORRUPT', 'IMMUTABLE_FIELD', 'ENGINE_UNAVAILABLE', 'SHARED_SCOPE_APPLY_FAILED'].includes(error.code) ? error.code : 'ENGINE_UNAVAILABLE' };
      this.logger.warn('modules.scopes.pending', 'Shared knowledge wiring is pending; existing data is retained.', { context: { code: status.scopeStatus.code } });
      // A scope failure must not prevent revoking a stale model key.
    }
    try {
      let profile = null;
      try {
        const response = await this._fetch(`${this.terminalUrl}/api/claude-workbench/v1/internal/maintenance-config`, { method: 'POST', headers, body: '{}' });
        if (response.ok) profile = await response.json();
      } catch { /* Missing configuration must clear a previously resolved key. */ }
      const response = await applyConfiguration('model', `${this.engineUrl}/api/runtime-config`, { projectId: 'default', profile });
      status.model = response.ok && !!profile;
    } catch { /* Status projection only: never log resolved profiles or raw errors. */ }
    try {
      let settings = null;
      try {
        const resolved = await this._fetch(`${this.terminalUrl}/api/claude-workbench/v1/internal/embedding-config`, { method: 'POST', headers, body: '{}' });
        if (resolved.ok) settings = await resolved.json();
      } catch { /* Revocation wins over a previously cached runtime key. */ }
      const applied = await applyConfiguration('embedding', `${this.vectorHubUrl}/api/internal/runtime-config`, { settings, ...(indexPath ? { storageRoot: indexPath } : {}) });
      status.embedding = applied.ok && !!settings;
      if (applied.ok) {
        const result = applied.data;
        status.indexStorage.actualPath = result.rootPath || null;
        status.indexStorage.status = result.rootPath && path.resolve(result.rootPath) === indexPath ? 'ready' : 'pending';
      }
    } catch { /* Public status contains no resolved configuration. */ }
    this.configStatus = status;
    return status;
  }

  /**
   * Register one pkb project into both modules and persist the wiring table.
   * Best-effort per module: a module that is down is recorded as 'pending'
   * (retry on the next register call or health-check pass), never a hard error.
   * KB_MODULES_REGISTER=0 disables fan-out entirely (test isolation).
   */
  _withProjectWiring(projectId, action) {
    const prior = this.projectWiringQueue.get(projectId) || Promise.resolve();
    const operation = prior.catch(() => {}).then(action);
    const settled = operation.finally(() => { if (this.projectWiringQueue.get(projectId) === settled) this.projectWiringQueue.delete(projectId); });
    this.projectWiringQueue.set(projectId, settled);
    return settled;
  }

  registerProjectLinks(input) {
    return this._withProjectWiring(input.projectId, () => {
      // A supervisor may have captured this project before a concurrent unbind.
      // Recheck the spine after acquiring the same lease as the removal path.
      if (this.registryStore && !this.registryStore.readDisplaySnapshot(input.projectId)) return Object.fromEntries(['terminal', 'vectorHub', 'eventBridge', 'engine'].map(key => [key, { ok: true, status: 'removed', skipped: 'project-not-registered' }]));
      return this._registerProjectLinks(input);
    });
  }

  async _registerProjectLinks({ projectId, name, workspacePath, knowledgePath }) {
    const result = { terminal: { ok: false }, vectorHub: { ok: false }, eventBridge: { ok: false }, engine: { ok: false } };
    if (String(process.env.KB_MODULES_REGISTER || '') === '0') {
      result.terminal = { ok: false, status: 'disabled' };
      result.vectorHub = { ok: false, status: 'disabled' };
      result.eventBridge = { ok: false, status: 'disabled' };
      result.engine = { ok: false, status: 'disabled' };
      return result;
    }
    // 幂等登记：终端已有同 rootPath 的项目时复用，绝不重复创建
    const existingTerminal = (await this._listTerminalProjects())
      .find(p => String(p.rootPath || '').toLowerCase() === String(workspacePath || '').toLowerCase());
    if (existingTerminal) {
      result.terminal = { ok: true, projectId: existingTerminal.id, status: 'registered', reused: true };
    } else {
      try {
        const response = await this._fetch(`${this.terminalUrl}/api/claude-workbench/v1/projects`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: name || projectId, rootPath: workspacePath }),
        });
        const payload = response.status === 201 || response.ok ? await response.json().catch(() => ({})) : {};
        result.terminal = { ok: response.ok, projectId: payload.id || payload.projectId || null, status: response.ok ? 'registered' : 'error' };
      } catch {
        result.terminal = { ok: false, status: 'pending' };
      }
    }
    const existingVector = (await this._listVectorHubProjects()).find(p => p.name === projectId && String(p.sourceDir || '').toLowerCase() === String(knowledgePath || '').toLowerCase());
    if (existingVector) result.vectorHub = { ok: true, projectName: projectId, status: 'registered', reused: true };
    else try {
      const response = await this._fetch(`${this.vectorHubUrl}/api/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        timeoutMs: REGISTER_TIMEOUT_MS,
        body: JSON.stringify({ sourceDir: knowledgePath, projectName: projectId, watch: false }),
      });
      result.vectorHub = { ok: response.ok, projectName: projectId, status: response.ok ? 'registered' : 'error' };
    } catch {
      result.vectorHub = { ok: false, status: 'pending' };
    }
    // 幂等登记：会话控制台按 path（Git work tree）复用已有登记。store 遵循
    // event-bridge 的推荐布局 <知识库>/dev-conversations；无知识库地址时交给
    // 控制台的默认 store（全局 journal），登记本身不受阻。
    const existingEventBridge = (await this._listEventBridgeProjects())
      .find(p => !p.auto && String(p.path || '').toLowerCase() === String(workspacePath || '').toLowerCase());
    if (existingEventBridge) {
      result.eventBridge = { ok: true, projectId: existingEventBridge.id, status: 'registered', reused: true };
    } else {
      try {
        const body = { path: workspacePath };
        if (knowledgePath) body.store = path.join(knowledgePath, 'dev-conversations');
        const response = await this._fetch(`${this.eventBridgeUrl}/api/projects`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const payload = response.status === 201 || response.ok ? await response.json().catch(() => ({})) : {};
        const registeredProject = payload.project || {};
        result.eventBridge = { ok: response.ok, projectId: registeredProject.id || null, status: response.ok ? 'registered' : 'error', errorCode: (!response.ok && payload.error && payload.error.code) || undefined };
      } catch {
        result.eventBridge = { ok: false, status: 'pending' };
      }
    }
    const config = this.projectStore ? this.projectStore.readConfig(projectId) : {};
    const state = this.projectStore ? this.projectStore.readState(projectId) : {};
    try {
      const baselines = { ...(state.conversationBaselineCursors || {}), global: state.conversationBaselineCursor ?? 0 };
      const journalId = result.eventBridge.projectId || state.modules?.eventBridge?.projectId;
      if (journalId && baselines[journalId] === undefined) {
        const watermark = result.eventBridge.reused && await this._fetch(`${this.eventBridgeUrl}/api/journal/high-watermark?journalId=${encodeURIComponent(journalId)}`);
        const current = result.eventBridge.reused ? watermark.ok && await watermark.json() : { sequence: 0 };
        if (!current || !Number.isSafeInteger(current.sequence)) throw new Error('JOURNAL_BASELINE_UNAVAILABLE');
        baselines[journalId] = current.sequence;
        if (this.projectStore) await this.projectStore.updateState(projectId, draft => { draft.conversationBaselineCursors = baselines; });
      }
      const response = await this._fetch(`${this.engineUrl}/api/projects`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId, name: name || projectId, repoPath: workspacePath, knowledgePath, knowledgeLanguage: config.knowledgeLanguage || 'zh-CN', brainId: config.brainId || 'brain-default', domainId: config.domainId || null, repoIdentity: config.repoIdentity, journalId: journalId || null, vectorProjectId: projectId, trackingStartCommit: state.trackingStartCommit || state.lastAnalyzedCommit || null, conversationBaselineCursor: state.conversationBaselineCursor ?? 0, conversationBaselineCursors: baselines, profileId: config.aiProfileId || null }) });
      result.engine = { ok: response.ok, projectId, status: response.ok ? 'registered' : 'error' };
    } catch { result.engine = { ok: false, status: 'pending' }; }
    await this._writeWiring(projectId, wiring => {
      wiring.terminal = { ...wiring.terminal, ...result.terminal, name: name || projectId, rootPath: workspacePath, updatedAt: new Date().toISOString() };
      wiring.vectorHub = { ...wiring.vectorHub, ...result.vectorHub, sourceDir: knowledgePath, updatedAt: new Date().toISOString() };
      wiring.eventBridge = { ...wiring.eventBridge, ...result.eventBridge, path: workspacePath, store: knowledgePath ? path.join(knowledgePath, 'dev-conversations') : '', updatedAt: new Date().toISOString() };
      wiring.engine = { ...wiring.engine, ...result.engine, updatedAt: new Date().toISOString() };
    });
    this.logger.info('modules.register', 'Module registration finished.', { context: { projectId, terminal: result.terminal.status, vectorHub: result.vectorHub.status, eventBridge: result.eventBridge.status } });
    return result;
  }

  /** Remove module registrations. Local data is preserved by contract: vector-hub
   * only drops its derived index (source untouched); terminal removes the project
   * with keepSessions=1 so session records survive; the event-bridge console only
   * unregisters the project — journals and sealed commit documents stay on disk. */
  removeProjectLinks(input) {
    return this._withProjectWiring(input.projectId, async () => {
      const result = await this._removeProjectLinks(input);
      // The caller owns registry/lifecycle changes. Hold the wiring lease until
      // its transaction settles, so delayed reconfiguration cannot resurrect it.
      await input.onRemoved?.(result);
      return result;
    });
  }

  async _removeProjectLinks({ projectId, requireEngine = true }) {
    const wiring = (this.projectStore ? this.projectStore.readState(projectId).modules : null) || {};
    const result = { terminal: { ok: false }, vectorHub: { ok: false }, eventBridge: { ok: false }, engine: { ok: false } };
    // Stop the writer first, before removing hooks/index registrations.
    try {
      if (!requireEngine) result.engine = { ok: true, status: 'not-owner' };
      else {
      const response = await this._fetch(`${this.engineUrl}/api/projects/${encodeURIComponent(projectId)}`, { method: 'DELETE' });
      if (response.status === 409) throw new DomainError('PROJECT_BUSY', '此项目正在执行知识维护，请等待写入结束后再解绑。未开始的排队任务会随解绑取消。', { status: 409, retryable: true });
      result.engine = { ok: response.ok || response.status === 404, status: response.ok || response.status === 404 ? 'removed' : 'pending' };
      }
    } catch (error) { if (error.code === 'PROJECT_BUSY') throw error; result.engine = { ok: false, status: 'pending' }; }
    if (!result.engine.ok) throw new DomainError('PROJECT_BUSY', '知识引擎暂时不可用，无法安全停止写入；请恢复后再解绑。', { status: 409, retryable: true });
    let terminalId = wiring.terminal && wiring.terminal.projectId;
    if (!terminalId) {
      const workspacePath = wiring.terminal && wiring.terminal.rootPath;
      const match = (await this._listTerminalProjects())
        .find(p => (workspacePath && String(p.rootPath || '').toLowerCase() === String(workspacePath).toLowerCase()) || p.name === projectId);
      terminalId = match && match.id;
    }
    if (terminalId) {
      try {
        const response = await this._fetch(`${this.terminalUrl}/api/claude-workbench/v1/projects/${encodeURIComponent(terminalId)}?keepSessions=1`, { method: 'DELETE' });
        result.terminal = { ok: response.ok || response.status === 204 };
      } catch { result.terminal = { ok: false, status: 'pending' }; }
    } else {
      result.terminal = { ok: true, skipped: 'not-registered' };
    }
    const vectorHubName = (wiring.vectorHub && wiring.vectorHub.projectName) || projectId;
    try {
      const response = await this._fetch(`${this.vectorHubUrl}/api/project?name=${encodeURIComponent(vectorHubName)}`, { method: 'DELETE' });
      result.vectorHub = { ok: response.ok || response.status === 204 || response.status === 404 };
    } catch { result.vectorHub = { ok: false, status: 'pending' }; }
    let eventBridgeId = wiring.eventBridge && wiring.eventBridge.projectId;
    if (!eventBridgeId) {
      const workspacePath = wiring.eventBridge && wiring.eventBridge.path;
      const match = (await this._listEventBridgeProjects())
        .find(p => !p.auto && workspacePath && String(p.path || '').toLowerCase() === String(workspacePath).toLowerCase());
      eventBridgeId = match && match.id;
    }
    if (eventBridgeId) {
      try {
        const response = await this._fetch(`${this.eventBridgeUrl}/api/projects?id=${encodeURIComponent(eventBridgeId)}`, { method: 'DELETE' });
        // 404 means already unregistered (or auto entry) — removal goal reached.
        result.eventBridge = { ok: response.ok || response.status === 204 || response.status === 404 };
      } catch { result.eventBridge = { ok: false, status: 'pending' }; }
    } else {
      result.eventBridge = { ok: true, skipped: 'not-registered' };
    }
    await this._writeWiring(projectId, wiring => {
      if (result.terminal.ok) wiring.terminal = { status: 'removed', updatedAt: new Date().toISOString() };
      if (result.vectorHub.ok) wiring.vectorHub = { status: 'removed', updatedAt: new Date().toISOString() };
      if (result.eventBridge.ok) wiring.eventBridge = { status: 'removed', updatedAt: new Date().toISOString() };
      if (result.engine.ok) wiring.engine = { status: 'removed', updatedAt: new Date().toISOString() };
    });
    this.logger.info('modules.remove', 'Module de-registration finished.', { context: { projectId, terminal: result.terminal, vectorHub: result.vectorHub, eventBridge: result.eventBridge } });
    return result;
  }

  async _writeWiring(projectId, mutator) {
    if (!this.projectStore) return;
    await this.projectStore.updateState(projectId, state => {
      state.modules = state.modules || {};
      mutator(state.modules);
    });
  }

  /**
   * T3.5 process orchestration: spawn the vendored module services as
   * supervised child processes. ON by default now that the services ship in
   * the package — opt out with KB_MODULES_AUTOSTART=0. A service that is
   * already listening on its URL is never spawned twice.
   */
  async startSupervised() {
    if (String(process.env.KB_MODULES_AUTOSTART || '') === '0') return;
    await this._resolveManagedUrls();
    await Promise.all(this._supervisedSpecs().map(async spec => {
      const kind = specNameToKind(spec.name);
      if (kind && await this._probeClass(spec.url, kind) === 'module') {
        this.logger.info('modules.supervisor', 'Module service already up; not spawning.', { context: { name: spec.name, url: spec.url } });
        this.onReady?.(spec.name); return;
      }
      this._spawnSupervised(spec);
    }));
  }

  /**
   * Resolve final managed URLs BEFORE any spec is built or a process is
   * spawned, so inter-module env wiring (engine URL, bridge URL, ...) uses
   * the final dynamic ports. Sequential on purpose: parallel scans could
   * race two kinds into the same overlapping candidate range
   * (8787..8806 vs 8790..8809).
   */
  async _resolveManagedUrls() {
    for (const target of MODULE_URL_TARGETS) {
      const preferredUrl = this[target.prop];
      const resolved = await resolveModuleUrl({
        kind: target.kind,
        preferredUrl,
        explicit: this.explicitModuleUrls[target.kind],
        portFree: port => tcpPortFree(urlHost(preferredUrl), port),
        probe: url => this._probeClass(url, target.kind),
      });
      this[target.prop] = resolved.url;
      this.moduleUrlSources[target.kind] = resolved.source;
      if (resolved.source !== 'external') {
        this.logger.info('modules.port_resolution', 'Module URL resolved.', { context: { kind: target.kind, source: resolved.source, url: resolved.url, port: resolved.port, offset: resolved.offset } });
      }
    }
  }

  _supervisedSpecs() {
    const specs = [];
    // C2 minimal wiring: the terminal service receives the non-secret product
    // knowledge root via KB_KNOWLEDGE_DATA_DIR. Its own AGENT_TERMINAL_DATA_DIR
    // stays the dedicated workbench subtree and is never widened.
    const knowledgeDataDir = this.dataDir || require('./data-dir').getDataDir();
    if (process.env.KB_TERMINAL_COMMAND) {
      specs.push({ name: 'terminal', command: process.env.KB_TERMINAL_COMMAND, url: this.terminalUrl, env: { KB_KNOWLEDGE_DATA_DIR: knowledgeDataDir, KB_WORKBENCH_RUNTIME_TOKEN: this.runtimeToken, KB_KNOWLEDGE_ENGINE_URL: this.engineUrl, KB_EVENT_BRIDGE_URL: this.eventBridgeUrl } });
    } else {
      const terminalEntry = resolveModuleEntry('terminal');
      if (terminalEntry) {
        specs.push({
          name: 'terminal',
          command: `node ${JSON.stringify(terminalEntry)}`,
          url: this.terminalUrl,
          env: { AGENT_TERMINAL_DATA_DIR: path.join(knowledgeDataDir, 'workbench'), KB_KNOWLEDGE_DATA_DIR: knowledgeDataDir, AGENT_TERMINAL_PORT: urlPort(this.terminalUrl, 5760), AGENT_TERMINAL_HOST: urlHost(this.terminalUrl), KB_WORKBENCH_RUNTIME_TOKEN: this.runtimeToken, KB_KNOWLEDGE_ENGINE_URL: this.engineUrl, KB_EVENT_BRIDGE_URL: this.eventBridgeUrl },
        });
      } else {
        this.logger.warn('modules.supervisor', 'claude-ai-workbench runtime not installed; expecting an external service.', {});
      }
    }
    // vector-hub declares engines >= 22; spawning it on older runtimes would
    // crash-loop the supervisor for nothing.
    if (process.env.KB_VECTORHUB_COMMAND) {
      specs.push({ name: 'vector-hub', command: process.env.KB_VECTORHUB_COMMAND, url: this.vectorHubUrl, env: { KB_VECTOR_MANAGED: '1', KB_VECTOR_RUNTIME_TOKEN: this.runtimeToken } });
    } else if (parseInt(process.versions.node, 10) < 22) {
      this.logger.warn('modules.supervisor', 'vector-hub needs Node >= 22; not spawning the vendored runtime.', { context: { node: process.versions.node } });
    } else {
      const vectorHubEntry = resolveModuleEntry('vector-hub');
      if (!vectorHubEntry) {
        this.logger.warn('modules.supervisor', '@sanqianx/vector-hub runtime not installed; expecting an external service.', {});
      } else {
        const dataDir = this.dataDir || require('./data-dir').getDataDir();
        const configRoot = path.join(dataDir, 'vectorhub');
        const root = new StorageLayout({ dataDir }).getVectorRootPath(this.settingsStore?.read());
        specs.push({
          name: 'vector-hub',
          command: `node ${JSON.stringify(vectorHubEntry)} serve --host ${urlHost(this.vectorHubUrl)} --port ${urlPort(this.vectorHubUrl, 8787)} --root ${JSON.stringify(root)}`,
          url: this.vectorHubUrl,
          env: { VECTOR_HUB_ROOT: root, VECTOR_HUB_CONFIG: path.join(configRoot, 'config.json'), VECTOR_HUB_LEGACY_CONFIG: path.join(configRoot, 'no-legacy-config.json'), KB_VECTOR_MANAGED: '1', KB_VECTOR_RUNTIME_TOKEN: this.runtimeToken },
        });
      }
    }
    // ai-coding-event-bridge console: plain-JS CommonJS on Node >= 18 — no
    // build gate, no runtime floor beyond the shell's own. The home flag keeps
    // the console on the same bridge home the in-process BridgeAdapter uses,
    // so conversations captured by PK show up in the embedded explorer. The
    // folder-picker warm-up is an interactive-only feature the shell never
    // routes here (import uses the terminal/vector-hub pickers) — skip it.
    if (process.env.KB_EVENTBRIDGE_COMMAND) {
      specs.push({ name: 'event-bridge', command: process.env.KB_EVENTBRIDGE_COMMAND, url: this.eventBridgeUrl, env: { KB_EVENT_BRIDGE_RUNTIME_TOKEN: this.runtimeToken } });
    } else {
      const eventBridgeEntry = resolveModuleEntry('event-bridge');
      if (!eventBridgeEntry) {
        this.logger.warn('modules.supervisor', '@sanqianx/ai-coding-event-bridge-console runtime not installed; expecting an external service.', {});
      } else {
        const homeArgs = ` --home ${JSON.stringify(process.env.AI_CODING_EVENT_BRIDGE_HOME || path.join(this.dataDir || require('./data-dir').getDataDir(), 'events'))}`;
        specs.push({
          name: 'event-bridge',
          command: `node ${JSON.stringify(eventBridgeEntry)} serve --host ${urlHost(this.eventBridgeUrl)} --port ${urlPort(this.eventBridgeUrl, 8790)}${homeArgs}`,
          url: this.eventBridgeUrl,
          env: { BRIDGE_CONSOLE_PICK_FOLDER: '0', KB_EVENT_BRIDGE_RUNTIME_TOKEN: this.runtimeToken },
        });
      }
    }
    const engineEntry = resolveModuleEntry('knowledge-engine');
    if (process.env.KB_KNOWLEDGE_ENGINE_COMMAND || engineEntry) specs.push({ name: 'knowledge-engine', command: process.env.KB_KNOWLEDGE_ENGINE_COMMAND || `node ${JSON.stringify(engineEntry)} serve --port ${urlPort(this.engineUrl, 5790)} --host ${urlHost(this.engineUrl)}`, url: this.engineUrl, env: { KNOWLEDGE_ENGINE_DATA: path.join(this.dataDir || require('./data-dir').getDataDir(), 'knowledge-engine'), KB_ENGINE_MANAGED: '1', KNOWLEDGE_ENGINE_CONSUME: '0', KB_ENGINE_RUNTIME_TOKEN: this.runtimeToken, KB_EVENT_BRIDGE_URL: this.eventBridgeUrl, KB_VECTOR_HUB_URL: this.vectorHubUrl, NODE_PATH: path.resolve(__dirname, '..', '..', 'node_modules') } });
    return specs;
  }

  _spawnSupervised(spec) {
    if (this.stopped) return;
    // Strip the quoting: spawn takes argv, not a shell line — a literal
    // `"path"` argument makes node load a file whose name contains quotes.
    const parts = (spec.command.match(/"[^"]+"|\S+/g) || [])
      .map(part => { if (!part.startsWith('"') || !part.endsWith('"')) return part; try { return JSON.parse(part); } catch { return part.slice(1, -1); } });
    const nodeProcess = parts[0] === 'node' || parts[0] === process.execPath;
    const child = spawn(nodeProcess ? process.execPath : parts[0], parts.slice(1), {
      // Module banners (ports, data roots) are diagnostics — inherit stdout
      // so they land on the console in --fg mode and in launcher.log when the
      // shell itself runs detached.
      stdio: nodeProcess ? ['ignore', 'inherit', 'inherit', 'ipc'] : ['ignore', 'inherit', 'inherit'],
      windowsHide: true,
      env: { ...process.env, ...(spec.env || {}) },
    });
    child.on('message', message => {
      if (message?.type !== 'kb:diagnostic' || !message.record || !['terminal', 'knowledge-engine'].includes(spec.name)) return;
      const record = message.record;
      if (!['debug', 'info', 'warn', 'error'].includes(record.level) || typeof record.event !== 'string' || typeof record.message !== 'string') return;
      const component = spec.name === 'terminal' ? 'claude-ai-workbench' : 'knowledge-engine';
      try { Promise.resolve(this.logger[record.level]?.(record.event, record.message, { component, projectId: record.projectId, runId: record.runId, operationId: record.operationId, commitSha: record.commitSha, phase: record.phase, error: record.error, context: record.context })).catch(() => {}); } catch {}
    });
    let attempts = spec._attempts || 0;
    child.on('error', error => {
      this.supervised = this.supervised.filter(existing => existing !== child);
      this.logger.warn('modules.supervisor', 'Module process could not start.', { context: { name: spec.name, code: error.code || 'SPAWN_FAILED' } });
    });
    child.on('exit', code => {
      this.onStateChange?.(spec.name);
      this.supervised = this.supervised.filter(existing => existing !== child);
      attempts += 1;
      if (attempts > 5 || this.stopped) {
        this.logger.warn('modules.supervisor', 'Module service stopped.', { context: { name: spec.name, code, attempts } });
        return;
      }
      const delay = Math.min(1000 * 2 ** attempts, 15000);
      this.logger.warn('modules.supervisor', 'Module service exited; restarting.', { context: { name: spec.name, code, retryInMs: delay } });
      const timer = setTimeout(() => { this.restartTimers.delete(timer); this._spawnSupervised({ ...spec, _attempts: attempts }); }, delay);
      this.restartTimers = this.restartTimers || new Set(); this.restartTimers.add(timer);
    });
    this.supervised.push(child);
    this.logger.info('modules.supervisor', 'Module service spawned.', { context: { name: spec.name, pid: child.pid } });
    let attemptsReady = 0;
    const checkReady = async () => {
      if (this.stopped || child.exitCode !== null || ++attemptsReady > 20) return;
      const kind = specNameToKind(spec.name);
      if (kind && await this._probeClass(spec.url, kind) === 'module') { this.resetRuntimeConfiguration(); this.onReady?.(spec.name); return; }
      const timer = setTimeout(() => { this.restartTimers.delete(timer); checkReady(); }, 500);
      this.restartTimers ||= new Set(); this.restartTimers.add(timer);
    };
    void checkReady();
  }

  async stopSupervised() {
    this.stopped = true;
    for (const timer of this.restartTimers || []) clearTimeout(timer);
    await Promise.all(this.supervised.map(child => new Promise(resolve => {
      if (child.exitCode !== null || !child.pid) return resolve();
      const timer = setTimeout(() => {
        if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        else try { child.kill('SIGKILL'); } catch {}
        resolve();
      }, 5000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      try { if (child.connected) child.send({ type: 'kb:shutdown' }, error => { if (error) try { child.kill(); } catch {} }); else child.kill(); } catch { try { child.kill(); } catch {} }
    })));
    this.supervised = [];
  }
}

module.exports = { ModuleBridge, defaultTerminalUrl, defaultVectorHubUrl, defaultEventBridgeUrl, defaultEngineUrl };
