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
 *   KB_TERMINAL_URL     default http://127.0.0.1:5760
 *   KB_VECTORHUB_URL    default http://127.0.0.1:8787
 *   KB_EVENTBRIDGE_URL  default http://127.0.0.1:8790
 *   KB_MODULES_AUTOSTART  '0' to stop spawning the vendored module services
 *                         (they start with the shell by default)
 *   KB_TERMINAL_COMMAND  explicit node command line for the terminal service
 *   KB_VECTORHUB_COMMAND explicit node command line for the vector-hub service
 *   KB_EVENTBRIDGE_COMMAND explicit node command line for the event-bridge console
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const PROXY_TIMEOUT_MS = 10000;
// Registration drives a full embedding pass in vector-hub (remote API); a
// fresh knowledge folder can easily exceed the interactive proxy budget.
const REGISTER_TIMEOUT_MS = 60000;
// Native folder dialogs wait for the user without a bound.
const PICKER_TIMEOUT_MS = 10 * 60 * 1000;

// Vendored module runtimes shipped inside the npm package. Sibling-checkout
// spawning is gone: the services are bundled, spawned from here, and resolved
// through NODE_PATH so their cross-package requires work without a workspace
// node_modules.
const MODULES_ROOT = path.resolve(__dirname, '..', '..', '_modules');

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

class ModuleBridge {
  constructor(options = {}) {
    this.logger = options.logger || { info: () => {}, warn: () => {}, error: () => {} };
    this.terminalUrl = options.terminalUrl || defaultTerminalUrl();
    this.vectorHubUrl = options.vectorHubUrl || defaultVectorHubUrl();
    this.eventBridgeUrl = options.eventBridgeUrl || defaultEventBridgeUrl();
    this.registryStore = options.registryStore || null;
    this.projectStore = options.projectStore || null;
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

  /** Same-origin reverse proxy for one browser request. Streams JSON bodies buffered. */
  async proxy(req, res, target) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    // The native folder pickers hold the request open until the user closes
    // the dialog — they need a human-scale budget, not the API budget.
    const isPicker = /\/(system\/)?pick-folder/.test(target);
    const timeoutMs = isPicker ? PICKER_TIMEOUT_MS : PROXY_TIMEOUT_MS;
    let upstream;
    try {
      upstream = await this._fetch(target, {
        method: req.method,
        timeoutMs,
        headers: body ? { 'Content-Type': req.headers['content-type'] || 'application/json' } : {},
        body: ['GET', 'HEAD'].includes(req.method) ? undefined : body,
      });
    } catch (error) {
      res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: 'MODULE_UNREACHABLE', target }));
      return;
    }
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.writeHead(upstream.status, {
      'Content-Type': upstream.headers.get('content-type') || 'application/json; charset=utf-8',
    });
    res.end(buf);
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

  async _listTerminalProjects() {
    try {
      const response = await this._fetch(`${this.terminalUrl}/api/claude-workbench/v1/projects`);
      if (!response.ok) return [];
      const payload = await response.json();
      const list = Array.isArray(payload) ? payload : payload.projects;
      return Array.isArray(list) ? list : [];
    } catch { return []; }
  }

  async _listVectorHubProjects() {
    try {
      const response = await this._fetch(`${this.vectorHubUrl}/api/projects`);
      if (!response.ok) return [];
      const payload = await response.json();
      return Array.isArray(payload.projects) ? payload.projects : [];
    } catch { return []; }
  }

  async _listEventBridgeProjects() {
    try {
      const response = await this._fetch(`${this.eventBridgeUrl}/api/projects`);
      if (!response.ok) return [];
      const payload = await response.json();
      return Array.isArray(payload.projects) ? payload.projects : [];
    } catch { return []; }
  }

  /** Aggregated projection for the shell sidebar: pkb registry is the spine. */
  async aggregatedProjects() {
    const [terminalProjects, vectorHubProjects, eventBridgeProjects] = await Promise.all([
      this._listTerminalProjects(),
      this._listVectorHubProjects(),
      this._listEventBridgeProjects(),
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
        modules: {
          terminal: terminal ? { registered: true, projectId: terminal.id, name: terminal.name } : { registered: false, status: wiring.terminal && wiring.terminal.status },
          vectorHub: vectorHub ? { registered: true, projectName: vectorHub.name, docCount: vectorHub.docCount, chunkCount: vectorHub.chunkCount, watching: !!vectorHub.watching } : { registered: false, status: wiring.vectorHub && wiring.vectorHub.status },
          eventBridge: eventBridge ? { registered: true, projectId: eventBridge.id, turns: eventBridge.turns, auto: !!eventBridge.auto } : { registered: false, status: wiring.eventBridge && wiring.eventBridge.status },
        },
      };
    });
    return {
      projects,
      terminalAvailable: terminalProjects.length > 0 || await this._probe(this.terminalUrl),
      vectorHubAvailable: vectorHubProjects.length > 0 || await this._probe(this.vectorHubUrl),
      eventBridgeAvailable: eventBridgeProjects.length > 0 || await this._probe(this.eventBridgeUrl),
    };
  }

  async _probe(base) {
    try { await this._fetch(base, { timeoutMs: 2000 }); return true; } catch { return false; }
  }

  async modulesHealth() {
    const [terminal, vectorHub, eventBridge] = await Promise.all([
      this._probe(this.terminalUrl),
      this._probe(this.vectorHubUrl),
      this._probe(this.eventBridgeUrl),
    ]);
    return { ok: true, modules: {
      terminal: { url: this.terminalUrl, up: terminal },
      vectorHub: { url: this.vectorHubUrl, up: vectorHub },
      eventBridge: { url: this.eventBridgeUrl, up: eventBridge },
    } };
  }

  /**
   * Register one pkb project into both modules and persist the wiring table.
   * Best-effort per module: a module that is down is recorded as 'pending'
   * (retry on the next register call or health-check pass), never a hard error.
   * KB_MODULES_REGISTER=0 disables fan-out entirely (test isolation).
   */
  async registerProjectLinks({ projectId, name, workspacePath, knowledgePath }) {
    const result = { terminal: { ok: false }, vectorHub: { ok: false }, eventBridge: { ok: false } };
    if (String(process.env.KB_MODULES_REGISTER || '') === '0') {
      result.terminal = { ok: false, status: 'disabled' };
      result.vectorHub = { ok: false, status: 'disabled' };
      result.eventBridge = { ok: false, status: 'disabled' };
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
    try {
      const response = await this._fetch(`${this.vectorHubUrl}/api/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        timeoutMs: REGISTER_TIMEOUT_MS,
        body: JSON.stringify({ sourceDir: knowledgePath, projectName: projectId, watch: true }),
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
    await this._writeWiring(projectId, wiring => {
      wiring.terminal = { ...wiring.terminal, ...result.terminal, name: name || projectId, rootPath: workspacePath, updatedAt: new Date().toISOString() };
      wiring.vectorHub = { ...wiring.vectorHub, ...result.vectorHub, sourceDir: knowledgePath, updatedAt: new Date().toISOString() };
      wiring.eventBridge = { ...wiring.eventBridge, ...result.eventBridge, path: workspacePath, store: knowledgePath ? path.join(knowledgePath, 'dev-conversations') : '', updatedAt: new Date().toISOString() };
    });
    this.logger.info('modules.register', 'Module registration finished.', { context: { projectId, terminal: result.terminal.status, vectorHub: result.vectorHub.status, eventBridge: result.eventBridge.status } });
    return result;
  }

  /** Remove module registrations. Local data is preserved by contract: vector-hub
   * only drops its derived index (source untouched); terminal removes the project
   * with keepSessions=1 so session records survive; the event-bridge console only
   * unregisters the project — journals and sealed commit documents stay on disk. */
  async removeProjectLinks({ projectId }) {
    const wiring = (this.projectStore ? this.projectStore.readState(projectId).modules : null) || {};
    const result = { terminal: { ok: false }, vectorHub: { ok: false }, eventBridge: { ok: false } };
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
    for (const spec of this._supervisedSpecs()) {
      if (await this._probe(spec.url)) {
        this.logger.info('modules.supervisor', 'Module service already up; not spawning.', { context: { name: spec.name, url: spec.url } });
        continue;
      }
      this._spawnSupervised(spec);
    }
  }

  _supervisedSpecs() {
    const specs = [];
    if (process.env.KB_TERMINAL_COMMAND) {
      specs.push({ name: 'terminal', command: process.env.KB_TERMINAL_COMMAND, url: this.terminalUrl, env: {} });
    } else if (fs.existsSync(path.join(MODULES_ROOT, 'claude-ai-workbench', 'packages', 'server', 'bin', 'agent-terminal-server.js'))) {
      specs.push({
        name: 'terminal',
        command: `node ${JSON.stringify(path.join(MODULES_ROOT, 'claude-ai-workbench', 'packages', 'server', 'bin', 'agent-terminal-server.js'))}`,
        url: this.terminalUrl,
        env: { AGENT_TERMINAL_PORT: urlPort(this.terminalUrl, 5760), AGENT_TERMINAL_HOST: urlHost(this.terminalUrl) },
      });
    } else {
      this.logger.warn('modules.supervisor', 'Vendored terminal runtime not present; expecting an external service.', {});
    }
    // vector-hub declares engines >= 22; spawning it on older runtimes would
    // crash-loop the supervisor for nothing.
    if (process.env.KB_VECTORHUB_COMMAND) {
      specs.push({ name: 'vector-hub', command: process.env.KB_VECTORHUB_COMMAND, url: this.vectorHubUrl, env: {} });
    } else if (parseInt(process.versions.node, 10) < 22) {
      this.logger.warn('modules.supervisor', 'vector-hub needs Node >= 22; not spawning the vendored runtime.', { context: { node: process.versions.node } });
    } else if (fs.existsSync(path.join(MODULES_ROOT, 'vectorhub', 'dist', 'cjs', 'bin.js'))) {
      const dataDir = this.dataDir || require('./data-dir').getDataDir();
      const root = path.join(dataDir, 'vectorhub');
      specs.push({
        name: 'vector-hub',
        command: `node ${JSON.stringify(path.join(MODULES_ROOT, 'vectorhub', 'dist', 'cjs', 'bin.js'))} serve --port ${urlPort(this.vectorHubUrl, 8787)} --root ${JSON.stringify(root)}`,
        url: this.vectorHubUrl,
        env: { VECTOR_HUB_ROOT: root },
      });
    } else {
      this.logger.warn('modules.supervisor', 'Vendored vector-hub runtime not present; expecting an external service.', {});
    }
    // ai-coding-event-bridge console: plain-JS CommonJS on Node >= 18 — no
    // build gate, no runtime floor beyond the shell's own. The home flag keeps
    // the console on the same bridge home the in-process BridgeAdapter uses,
    // so conversations captured by PK show up in the embedded explorer. The
    // folder-picker warm-up is an interactive-only feature the shell never
    // routes here (import uses the terminal/vector-hub pickers) — skip it.
    if (process.env.KB_EVENTBRIDGE_COMMAND) {
      specs.push({ name: 'event-bridge', command: process.env.KB_EVENTBRIDGE_COMMAND, url: this.eventBridgeUrl, env: {} });
    } else if (fs.existsSync(path.join(MODULES_ROOT, 'event-bridge', 'packages', 'console', 'src', 'bin.js'))) {
      const homeArgs = process.env.AI_CODING_EVENT_BRIDGE_HOME
        ? ` --home ${JSON.stringify(process.env.AI_CODING_EVENT_BRIDGE_HOME)}`
        : '';
      specs.push({
        name: 'event-bridge',
        command: `node ${JSON.stringify(path.join(MODULES_ROOT, 'event-bridge', 'packages', 'console', 'src', 'bin.js'))} serve --host ${urlHost(this.eventBridgeUrl)} --port ${urlPort(this.eventBridgeUrl, 8790)}${homeArgs}`,
        url: this.eventBridgeUrl,
        env: { BRIDGE_CONSOLE_PICK_FOLDER: '0' },
      });
    } else {
      this.logger.warn('modules.supervisor', 'Vendored event-bridge runtime not present; expecting an external service.', {});
    }
    return specs;
  }

  _spawnSupervised(spec) {
    // Strip the quoting: spawn takes argv, not a shell line — a literal
    // `"path"` argument makes node load a file whose name contains quotes.
    const parts = (spec.command.match(/"[^"]+"|\S+/g) || [])
      .map(part => (part.startsWith('"') && part.endsWith('"') ? part.slice(1, -1) : part));
    // NODE_PATH lets the vendored runtimes resolve each other (_modules/
    // holds claude-ai-workbench, vectorhub, vectra) while their own
    // dependencies resolve from the host package's node_modules.
    const nodePath = [MODULES_ROOT, process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
    const child = spawn(parts[0], parts.slice(1), {
      // Module banners (ports, data roots) are diagnostics — inherit stdout
      // so they land on the console in --fg mode and in launcher.log when the
      // shell itself runs detached.
      stdio: ['ignore', 'inherit', 'inherit'],
      windowsHide: true,
      env: { ...process.env, ...(spec.env || {}), NODE_PATH: nodePath },
    });
    let attempts = 0;
    child.on('exit', code => {
      attempts += 1;
      if (attempts > 5 || this.stopped) {
        this.logger.warn('modules.supervisor', 'Module service stopped.', { context: { name: spec.name, code, attempts } });
        return;
      }
      const delay = Math.min(1000 * 2 ** attempts, 15000);
      this.logger.warn('modules.supervisor', 'Module service exited; restarting.', { context: { name: spec.name, code, retryInMs: delay } });
      setTimeout(() => this._spawnSupervised({ ...spec, _attempts: attempts }), delay);
    });
    this.supervised.push(child);
    this.logger.info('modules.supervisor', 'Module service spawned.', { context: { name: spec.name, pid: child.pid } });
  }

  stopSupervised() {
    this.stopped = true;
    for (const child of this.supervised) { try { child.kill(); } catch { /* already gone */ } }
    this.supervised = [];
  }
}

module.exports = { ModuleBridge, defaultTerminalUrl, defaultVectorHubUrl, defaultEventBridgeUrl };
