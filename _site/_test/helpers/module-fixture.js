// _site/_test/helpers/module-fixture.js
//
// Test-only services for the product's module boundary.
//
// Three kinds of helper live here, and each one is a real HTTP service the
// product talks to over the network:
//
//   createModuleFixture   a standalone module service (terminal / vector-hub
//                         / event-bridge) that keeps the registration state
//                         the product writes into it, can be switched offline
//                         (503) and records every request it receives.
//
//   createUpstreamProxy    a pass-through proxy in front of a real upstream
//                         (the vendored knowledge-engine module). It can hold
//                         the upstream offline with 503, and it can rewrite
//                         the runtime Authorization header so the product's
//                         own per-instance token reaches an engine that was
//                         started outside the product supervisor. Bodies and
//                         responses are forwarded verbatim.
//
//   createProductProxy     a pass-through proxy in front of the product
//                         server. It injects transport faults: a held
//                         response (late read) or a failed response.
//
// The proxies never fabricate a module answer: everything they return comes
// from the upstream service they front.

'use strict';

const http = require('node:http');

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

/**
 * A standalone module service. `kind` selects the contract subset the
 * product's module bridge uses for that module.
 */
function createModuleFixture({ kind, tag = kind }) {
  const state = { online: true, projects: [], requests: [] };
  let nextId = 1;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const raw = await readBody(req);
    let body = null;
    if (raw.length) { try { body = JSON.parse(raw.toString('utf8')); } catch { body = null; } }
    state.requests.push({ method: req.method, path: url.pathname + url.search, body, at: Date.now() });
    if (!state.online) {
      sendJson(res, 503, { ok: false, error: { code: 'MODULE_OFFLINE', message: `验收中的离线 ${kind} 模块` } });
      return;
    }
    if (kind === 'terminal') {
      if (req.method === 'GET' && url.pathname === '/api/claude-workbench/v1/projects') {
        sendJson(res, 200, { projects: state.projects });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/claude-workbench/v1/projects') {
        const id = `terminal-${nextId++}`;
        state.projects.push({ id, name: body?.name || id, rootPath: body?.rootPath || '' });
        sendJson(res, 201, { id, name: body?.name || id, rootPath: body?.rootPath || '' });
        return;
      }
      if (req.method === 'DELETE' && url.pathname.startsWith('/api/claude-workbench/v1/projects/')) {
        const id = decodeURIComponent(url.pathname.split('/').pop());
        state.projects = state.projects.filter(project => project.id !== id);
        res.writeHead(204); res.end();
        return;
      }
    }
    if (kind === 'vectorHub') {
      if (req.method === 'GET' && url.pathname === '/api/projects') { sendJson(res, 200, { projects: state.projects }); return; }
      if (req.method === 'POST' && url.pathname === '/api/import') {
        state.projects.push({ name: body?.projectName || '', sourceDir: body?.sourceDir || '', hasIndex: true });
        sendJson(res, 200, { ok: true, project: body?.projectName || '' });
        return;
      }
      if (req.method === 'DELETE' && url.pathname === '/api/project') {
        const name = url.searchParams.get('name');
        state.projects = state.projects.filter(project => project.name !== name);
        sendJson(res, 200, { ok: true });
        return;
      }
    }
    if (kind === 'eventBridge') {
      if (req.method === 'GET' && url.pathname === '/api/projects') { sendJson(res, 200, { projects: state.projects }); return; }
      if (req.method === 'POST' && url.pathname === '/api/projects') {
        const id = `bridge-${nextId++}`;
        state.projects.push({ id, path: body?.path || '', auto: false, store: body?.store || '' });
        sendJson(res, 201, { project: { id, path: body?.path || '' } });
        return;
      }
      if (req.method === 'DELETE' && url.pathname === '/api/projects') {
        const id = url.searchParams.get('id');
        state.projects = state.projects.filter(project => project.id !== id);
        sendJson(res, 200, { ok: true });
        return;
      }
    }
    sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: '未实现的模块接口' } });
  });

  return {
    kind,
    tag,
    state,
    url: null,
    requests: state.requests,
    async start() { this.url = await listen(server); return this.url; },
    setOnline(online) { state.online = online; },
    countRequests(method, pathPrefix) {
      return state.requests.filter(entry => entry.method === method && (!pathPrefix || entry.path.startsWith(pathPrefix))).length;
    },
    async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); },
  };
}

/**
 * Pass-through proxy in front of a real upstream service.
 *
 * - `offline` short-circuits every request with 503 (the upstream is never
 *   contacted), which is how the product observes an offline module.
 * - `token` rewrites the Authorization header so the product's per-instance
 *   runtime token is replaced by the token the upstream was started with.
 *
 * The proxy streams both directions, so a server-sent event stream that the
 * browser opens against the product stays a real event stream.
 */
function createUpstreamProxy({ target, token, offline = false, tag = 'upstream' }) {
  const state = { online: !offline, requests: [] };
  const upstream = new URL(target);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const raw = await readBody(req);
    let body = null;
    if (raw.length) { try { body = JSON.parse(raw.toString('utf8')); } catch { body = null; } }
    const entry = { method: req.method, path: url.pathname + url.search, body, at: Date.now(), status: null };
    state.requests.push(entry);
    if (!state.online) {
      entry.status = 503;
      sendJson(res, 503, { ok: false, error: { code: 'MODULE_OFFLINE', message: `验收中的离线 ${tag} 模块` } });
      return;
    }
    const headers = { 'Content-Type': req.headers['content-type'] || 'application/json', 'Content-Length': String(raw.length) };
    if (token) headers.Authorization = `Bearer ${token}`;
    else if (req.headers.authorization) headers.Authorization = req.headers.authorization;
    const upstreamRequest = http.request({
      hostname: upstream.hostname,
      port: upstream.port,
      path: url.pathname + url.search,
      method: req.method,
      headers,
    }, upstreamResponse => {
      entry.status = upstreamResponse.statusCode;
      res.writeHead(upstreamResponse.statusCode, upstreamResponse.headers);
      upstreamResponse.pipe(res);
    });
    upstreamRequest.on('error', error => {
      entry.status = 502;
      if (!res.headersSent) sendJson(res, 502, { ok: false, error: { code: 'UPSTREAM_UNREACHABLE', message: String(error.message || error) } });
      else res.destroy();
    });
    if (raw.length) upstreamRequest.write(raw);
    upstreamRequest.end();
  });

  return {
    tag,
    state,
    requests: state.requests,
    url: null,
    setOnline(online) { state.online = online; },
    countRequests(method, pathPrefix) {
      return state.requests.filter(entry => entry.method === method && (!pathPrefix || entry.path.startsWith(pathPrefix))).length;
    },
    async start() { this.url = await listen(server); return this.url; },
    async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); },
  };
}

/**
 * Pass-through proxy in front of the product server that injects transport
 * faults. `hold` keeps a matching response pending (a late read); `fail`
 * answers a matching request with a transport error (a failed refresh).
 */
function createProductProxy({ target, tag = 'product' }) {
  const state = { requests: [], held: [], faults: [] };
  const upstream = new URL(target);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const raw = await readBody(req);
    let body = null;
    if (raw.length) { try { body = JSON.parse(raw.toString('utf8')); } catch { body = null; } }
    const entry = { method: req.method, path: url.pathname + url.search, body, at: Date.now(), status: null };
    state.requests.push(entry);

    const fault = state.faults.find(item => !item.used && item.match(entry));
    if (fault && fault.once) fault.used = true;
    if (fault && fault.kind === 'fail') {
      entry.status = fault.status;
      sendJson(res, fault.status, { ok: false, error: { code: 'TRANSPORT_FAULT', message: fault.message || '注入的传输故障' } });
      return;
    }

    const headers = { 'Content-Type': req.headers['content-type'] || 'application/json', 'Content-Length': String(raw.length) };
    if (req.headers.authorization) headers.Authorization = req.headers.authorization;
    const upstreamRequest = http.request({
      hostname: upstream.hostname,
      port: upstream.port,
      path: url.pathname + url.search,
      method: req.method,
      headers,
    }, upstreamResponse => {
      entry.status = upstreamResponse.statusCode;
      entry.respondedAt = Date.now();
      if (fault && fault.kind === 'hold') {
        const chunks = [];
        upstreamResponse.on('data', chunk => chunks.push(chunk));
        upstreamResponse.on('end', () => {
          state.held.push({ response: res, entry, status: upstreamResponse.statusCode, headers: upstreamResponse.headers, payload: Buffer.concat(chunks) });
        });
        return;
      }
      res.writeHead(upstreamResponse.statusCode, upstreamResponse.headers);
      upstreamResponse.pipe(res);
    });
    upstreamRequest.on('error', error => {
      entry.status = 502;
      if (!res.headersSent) sendJson(res, 502, { ok: false, error: { code: 'UPSTREAM_UNREACHABLE', message: String(error.message || error) } });
      else res.destroy();
    });
    if (raw.length) upstreamRequest.write(raw);
    upstreamRequest.end();
  });

  return {
    tag,
    state,
    requests: state.requests,
    url: null,
    /** Hold the response of every request that matches the predicate. */
    hold(match, { once = false } = {}) { state.faults.push({ kind: 'hold', match, once }); },
    /** Fail every matching request at the transport level. */
    fail(match, status = 503, message = '注入的传输故障', { once = false } = {}) { state.faults.push({ kind: 'fail', match, status, message, once }); },
    clearFaults() { state.faults = []; },
    heldCount() { return state.held.length; },
    /** Deliver every held response to the browser that is still waiting. */
    releaseHeld() {
      const held = state.held.splice(0);
      for (const item of held) {
        try {
          item.response.writeHead(item.status, item.headers);
          item.response.end(item.payload);
        } catch {}
      }
      return held.length;
    },
    async start() { this.url = await listen(server); return this.url; },
    async close() { state.held.length = 0; server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); },
  };
}

module.exports = { createModuleFixture, createUpstreamProxy, createProductProxy };
