// _site/_test/helpers/parallel-nav-proxy.js
//
// A pass-through proxy in front of the product server that injects transport
// faults (a held response = a late read, a failed response) and carries the
// product's live WebSocket channel.
//
// The shared product proxy cannot be used for these cases: the shell's live
// channel is a WebSocket upgrade (/api/live), and a plain HTTP proxy answers
// an upgrade request with 404. Without the upgrade relay the shell loses the
// live registry/progress streams, and a product that only fills its pages
// through those streams cannot be observed faithfully. This file is the lane's
// own fixture for that reason; the shared helper is left untouched.
//
// The relay forwards the upgrade request verbatim, so the product sees the
// browser's own Host and Origin headers and applies its own upgrade checks.

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

function createNavProductProxy({ target, tag = 'product' }) {
  const state = { requests: [], held: [], faults: [], upgrades: 0 };
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

  // The live channel: relay the upgrade to the product unchanged.
  server.on('upgrade', (req, socket, head) => {
    state.upgrades += 1;
    const upstreamRequest = http.request({
      hostname: upstream.hostname,
      port: upstream.port,
      path: req.url,
      method: req.method,
      headers: req.headers,
    });
    upstreamRequest.on('upgrade', (upstreamResponse, upstreamSocket, upstreamHead) => {
      const lines = Object.entries(upstreamResponse.headers)
        .map(([name, value]) => `${name}: ${Array.isArray(value) ? value.join(', ') : value}`);
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${lines.join('\r\n')}\r\n\r\n`);
      if (upstreamHead && upstreamHead.length) socket.write(upstreamHead);
      upstreamSocket.on('error', () => socket.destroy());
      socket.on('error', () => upstreamSocket.destroy());
      upstreamSocket.pipe(socket);
      socket.pipe(upstreamSocket);
    });
    upstreamRequest.on('error', () => socket.destroy());
    upstreamRequest.end(head);
  });

  return {
    tag,
    state,
    requests: state.requests,
    url: null,
    /** Hold the response of every request that matches the predicate. */
    hold(match, { once = false } = {}) { state.faults.push({ kind: 'hold', match, once }); },
    /** Fail every matching request with an HTTP status. */
    fail(match, status = 503, message = '注入的传输故障', { once = false } = {}) { state.faults.push({ kind: 'fail', match, status, message, once }); },
    clearFaults() { state.faults = []; },
    heldCount() { return state.held.length; },
    /** How many live-channel upgrades the proxy really relayed. */
    upgradeCount() { return state.upgrades; },
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
    async start() {
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      this.url = `http://127.0.0.1:${server.address().port}`;
      return this.url;
    },
    async close() {
      state.held.length = 0;
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    },
  };
}

module.exports = { createNavProductProxy };
