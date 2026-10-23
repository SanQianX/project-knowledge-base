'use strict';

// P-ENGINE-REVIEW-R2/R3 lane-exclusive candidate host for the knowledge-engine UI.
//
// Purpose: let a REAL browser load the REAL product UI bytes from a directory
// the caller chooses (the vendored copy = as shipped, or the module source
// tree = candidate fix), while /api/* is reverse-proxied to the REAL vendored
// engine - mirroring the product shell wiring where the UI is embedded
// same-origin behind the shell proxy. The engine refuses cross-origin
// requests (src/server.js FORBIDDEN_ORIGIN), so the browser origin and the
// API origin must be this one host.
//
// Harness-only fault injection (never touches the engine or the UI bytes):
//   * retryDelayMs      - hold retry POST responses so a second native click can
//                         land while the first intent is still in flight.
//   * dropRetry         - forward the retry POST upstream, let the engine really
//                         execute it, then destroy the browser socket without
//                         any response bytes (lost response -> the product
//                         client faces an UNKNOWN result).
//   * rejectRetryStatus - answer the retry POST with an explicit error status
//                         (e.g. 409) WITHOUT forwarding it (the API clearly
//                         refused the intent).
//   * holdRetryForward  - accept the retry POST but do NOT forward it yet, so
//                         the engine still reports the run as failed and every
//                         detail re-render rebuilds a retry button for the SAME
//                         in-flight intent (the re-render counter-proof).
//                         releaseHeldRetries() forwards the parked requests.

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const STATIC_FILES = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/app.css', ['app.css', 'text/css; charset=utf-8']],
]);

function fileSha(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function startUiHost({ uiDir, engineBase, retryDelayMs = 0, dropRetry = false, rejectRetryStatus = 0, holdRetryForward = false }) {
  const settings = { retryDelayMs, dropRetry, rejectRetryStatus, holdRetryForward };
  const state = {
    proxiedApiRequests: 0,
    receivedRetryPosts: 0,
    forwardedRetryPosts: 0,
    rejectedRetryResponses: 0,
    heldRetryPosts: 0,
    droppedRetryResponses: 0,
  };
  const held = [];

  const forward = ({ url, method, headers, body }, res, isRetryPost) => {
    const target = new URL(url.pathname + url.search, engineBase);
    const outHeaders = { ...headers, host: target.host };
    delete outHeaders.origin;
    delete outHeaders.connection;
    delete outHeaders['proxy-connection'];
    delete outHeaders['content-length'];
    if (body.length) outHeaders['content-length'] = String(body.length);
    if (isRetryPost) state.forwardedRetryPosts += 1;
    const upstream = http.request(target, { method, headers: outHeaders }, up => {
      const responseChunks = [];
      up.on('data', chunk => responseChunks.push(chunk));
      up.on('end', () => {
        const payload = Buffer.concat(responseChunks);
        if (isRetryPost && settings.dropRetry) {
          // The engine has fully executed the retry. Start the response (so
          // the browser cannot transparently retry the request on a fresh
          // keep-alive connection) and then destroy the socket mid-flight -
          // the product client faces a truncated answer, i.e. an UNKNOWN
          // result it must reconcile by querying, never by re-dispatching.
          state.droppedRetryResponses += 1;
          const out = { ...up.headers };
          delete out['content-length'];
          delete out['transfer-encoding'];
          delete out.connection;
          res.writeHead(up.statusCode, out);
          res.flushHeaders();
          setTimeout(() => res.destroy(), 30);
          return;
        }
        const reply = () => {
          const out = { ...up.headers };
          delete out['content-length'];
          delete out['transfer-encoding'];
          delete out.connection;
          if (payload.length) out['content-length'] = String(payload.length);
          res.writeHead(up.statusCode, out);
          res.end(payload);
        };
        if (isRetryPost && settings.retryDelayMs > 0) setTimeout(reply, settings.retryDelayMs);
        else reply();
      });
    });
    upstream.on('error', () => res.destroy());
    upstream.end(body);
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const staticEntry = req.method === 'GET' ? STATIC_FILES.get(url.pathname) : null;
    if (staticEntry) {
      res.writeHead(200, { 'Content-Type': staticEntry[1], 'Cache-Control': 'no-store' });
      res.end(fs.readFileSync(path.join(uiDir, staticEntry[0])));
      return;
    }
    if (!url.pathname.startsWith('/api/')) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }
    state.proxiedApiRequests += 1;
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const headers = { ...req.headers };
      // The shell proxy terminates the browser origin; the engine would refuse
      // any mismatched Origin header (FORBIDDEN_ORIGIN).
      delete headers.origin;
      delete headers.connection;
      delete headers['proxy-connection'];
      delete headers['content-length'];
      const isRetryPost = req.method === 'POST' && /\/api\/runs\/[^/]+\/retry$/.test(url.pathname);
      if (isRetryPost) state.receivedRetryPosts += 1;

      if (isRetryPost && settings.rejectRetryStatus) {
        state.rejectedRetryResponses += 1;
        res.writeHead(settings.rejectRetryStatus, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: 'RUN_NOT_RETRYABLE', message: `ui-host injected explicit refusal (HTTP ${settings.rejectRetryStatus})` }));
        return;
      }
      if (isRetryPost && settings.holdRetryForward) {
        state.heldRetryPosts += 1;
        held.push({ url, method: req.method, headers, body, res });
        return;
      }
      forward({ url, method: req.method, headers, body }, res, isRetryPost);
    });
  });

  return {
    state,
    uiDir,
    uiHashes: {
      'index.html': fileSha(path.join(uiDir, 'index.html')),
      'app.js': fileSha(path.join(uiDir, 'app.js')),
      'app.css': fileSha(path.join(uiDir, 'app.css')),
    },
    configure(next) { Object.assign(settings, next); },
    // Forward every parked retry POST and answer it (the held intent finally
    // reaches the engine).
    releaseHeldRetries() {
      const parked = held.splice(0, held.length);
      for (const request of parked) {
        const isRetryPost = request.method === 'POST' && /\/api\/runs\/[^/]+\/retry$/.test(request.url.pathname);
        forward(request, request.res, isRetryPost);
      }
      return parked.length;
    },
    async listen() {
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      return `http://127.0.0.1:${server.address().port}`;
    },
    async close() {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    },
  };
}

module.exports = { startUiHost };
