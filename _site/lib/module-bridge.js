'use strict';
/**
 * Module bridge: connectivity from project-knowledge to the embedded modules
 * (claude-ai-workbench Agent Terminal, vector-hub console).
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
 *   KB_MODULES_AUTOSTART  '1' to spawn module services at server start
 *   KB_TERMINAL_COMMAND  node command line for the terminal service
 *   KB_VECTORHUB_COMMAND node command line for the vector-hub service
 */

const { spawn } = require('child_process');
const path = require('path');

const PROXY_TIMEOUT_MS = 10000;
// Registration drives a full embedding pass in vector-hub (remote API); a
// fresh knowledge folder can easily exceed the interactive proxy budget.
const REGISTER_TIMEOUT_MS = 60000;

function defaultTerminalUrl() {
  return String(process.env.KB_TERMINAL_URL || 'http://127.0.0.1:5760').replace(/\/+$/, '');
}

function defaultVectorHubUrl() {
  return String(process.env.KB_VECTORHUB_URL || 'http://127.0.0.1:8787').replace(/\/+$/, '');
}

class ModuleBridge {
  constructor(options = {}) {
    this.logger = options.logger || { info: () => {}, warn: () => {}, error: () => {} };
    this.terminalUrl = options.terminalUrl || defaultTerminalUrl();
    this.vectorHubUrl = options.vectorHubUrl || defaultVectorHubUrl();
    this.registryStore = options.registryStore || null;
    this.projectStore = options.projectStore || null;
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
    let upstream;
    try {
      upstream = await this._fetch(target, {
        method: req.method,
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

  /** Aggregated projection for the shell sidebar: pkb registry is the spine. */
  async aggregatedProjects() {
    const [terminalProjects, vectorHubProjects] = await Promise.all([
      this._listTerminalProjects(),
      this._listVectorHubProjects(),
    ]);
    const ids = this.registryStore ? this.registryStore.listIds() : [];
    const byWorkspace = new Map(terminalProjects.map(p => [String(p.rootPath || '').toLowerCase(), p]));
    const byName = new Map(vectorHubProjects.map(p => [String(p.name), p]));
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
      return {
        projectId,
        name: config.displayName || projectId,
        workspacePath,
        knowledgePath,
        modules: {
          terminal: terminal ? { registered: true, projectId: terminal.id, name: terminal.name } : { registered: false, status: wiring.terminal && wiring.terminal.status },
          vectorHub: vectorHub ? { registered: true, projectName: vectorHub.name, docCount: vectorHub.docCount, chunkCount: vectorHub.chunkCount, watching: !!vectorHub.watching } : { registered: false, status: wiring.vectorHub && wiring.vectorHub.status },
        },
      };
    });
    return { projects, terminalAvailable: terminalProjects.length > 0 || await this._probe(this.terminalUrl), vectorHubAvailable: vectorHubProjects.length > 0 || await this._probe(this.vectorHubUrl) };
  }

  async _probe(base) {
    try { await this._fetch(base, { timeoutMs: 2000 }); return true; } catch { return false; }
  }

  async modulesHealth() {
    const [terminal, vectorHub] = await Promise.all([this._probe(this.terminalUrl), this._probe(this.vectorHubUrl)]);
    return { ok: true, modules: { terminal: { url: this.terminalUrl, up: terminal }, vectorHub: { url: this.vectorHubUrl, up: vectorHub } } };
  }

  /**
   * Register one pkb project into both modules and persist the wiring table.
   * Best-effort per module: a module that is down is recorded as 'pending'
   * (retry on the next register call or health-check pass), never a hard error.
   */
  async registerProjectLinks({ projectId, name, workspacePath, knowledgePath }) {
    const result = { terminal: { ok: false }, vectorHub: { ok: false } };
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
    await this._writeWiring(projectId, wiring => {
      wiring.terminal = { ...wiring.terminal, ...result.terminal, name: name || projectId, rootPath: workspacePath, updatedAt: new Date().toISOString() };
      wiring.vectorHub = { ...wiring.vectorHub, ...result.vectorHub, sourceDir: knowledgePath, updatedAt: new Date().toISOString() };
    });
    this.logger.info('modules.register', 'Module registration finished.', { context: { projectId, terminal: result.terminal.status, vectorHub: result.vectorHub.status } });
    return result;
  }

  /** Remove module registrations. Local data is preserved by contract: vector-hub
   * only drops its derived index (source untouched); terminal removes the project
   * with keepSessions=1 so session records survive. */
  async removeProjectLinks({ projectId }) {
    const wiring = (this.projectStore ? this.projectStore.readState(projectId).modules : null) || {};
    const result = { terminal: { ok: false }, vectorHub: { ok: false } };
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
    await this._writeWiring(projectId, wiring => {
      if (result.terminal.ok) wiring.terminal = { status: 'removed', updatedAt: new Date().toISOString() };
      if (result.vectorHub.ok) wiring.vectorHub = { status: 'removed', updatedAt: new Date().toISOString() };
    });
    this.logger.info('modules.remove', 'Module de-registration finished.', { context: { projectId, terminal: result.terminal, vectorHub: result.vectorHub } });
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
   * T3.5 process orchestration: optionally spawn module services as supervised
   * child processes. Off by default; enabled with KB_MODULES_AUTOSTART=1.
   */
  startSupervised() {
    if (String(process.env.KB_MODULES_AUTOSTART || '') !== '1') return;
    const cwd = process.cwd();
    const specs = [
      {
        name: 'terminal',
        command: process.env.KB_TERMINAL_COMMAND
          || `node ${JSON.stringify(path.resolve(cwd, '..', 'claude-ai-workbench', 'packages', 'server', 'bin', 'agent-terminal-server.js'))}`,
      },
      {
        name: 'vector-hub',
        command: process.env.KB_VECTORHUB_COMMAND
          || `node ${JSON.stringify(path.resolve(cwd, '..', 'vector-hub', 'node_modules', 'tsx', 'dist', 'cli.mjs'))} ${JSON.stringify(path.resolve(cwd, '..', 'vector-hub', 'src', 'bin.ts'))} serve`,
      },
    ];
    for (const spec of specs) this._spawnSupervised(spec);
  }

  _spawnSupervised(spec) {
    const parts = spec.command.match(/"[^"]+"|\S+/g) || [];
    const child = spawn(parts[0], parts.slice(1), { stdio: ['ignore', 'ignore', 'inherit'], windowsHide: true });
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

module.exports = { ModuleBridge, defaultTerminalUrl, defaultVectorHubUrl };
