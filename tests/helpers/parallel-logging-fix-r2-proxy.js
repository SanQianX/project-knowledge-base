'use strict';
// P-LOG-SAFETY-R2 lane-exclusive observation proxy (prefix
// parallel-logging-fix-r2-*). Distinct from the R1 proxy (read-only reuse of
// that file is not extended): this one adds a SNAPSHOT BARRIER for the
// deterministic LOG-004 handoff proof.
//
// Forwarding rules (only real traffic is delayed/released, never rewritten):
//   - HTTP: forwarded to the isolated server with host rewritten. GET
//     /api/logs?... (the diagnostics snapshot) can be held AFTER the server
//     produced the response: the exact original bytes are released later.
//   - WebSocket /api/live: raw upgrade passthrough (host/origin rewritten to
//     the target) with text-frame TAPPING in both directions so the wire
//     timeline (subscribe frames with streamCursor, gateway event frames) is
//     auditable evidence.

const http = require('node:http');
const crypto = require('node:crypto');

function createGapProxy(options) {
  const { targetPort, port } = options;
  const targetHost = '127.0.0.1';
  const events = [];
  let seq = 0;
  const record = (kind, detail = {}) => {
    events.push({ seq: ++seq, at: new Date().toISOString(), kind, ...detail });
  };

  let barrierArmed = false;
  let barrierResolve = null;
  const barrierHeld = new Promise(resolve => { barrierResolve = resolve; });
  let barrierInfo = null;
  let releaseResolve = null;
  const released = new Promise(resolve => { releaseResolve = resolve; });

  const sockets = new Set();
  const server = http.createServer((req, res) => {
    const url = req.url || '/';
    const isSnapshot = req.method === 'GET' && url.startsWith('/api/logs?');
    const held = barrierArmed && isSnapshot;
    if (held) barrierArmed = false;
    record('request', { method: req.method, url, held });

    const upstream = http.request({
      host: targetHost,
      port: targetPort,
      method: req.method,
      path: url,
      headers: { ...req.headers, host: `${targetHost}:${targetPort}` },
      agent: false,
    }, upstreamRes => {
      const chunks = [];
      upstreamRes.on('data', chunk => chunks.push(chunk));
      upstreamRes.on('end', () => {
        const body = Buffer.concat(chunks);
        const deliver = () => {
          const headers = { ...upstreamRes.headers };
          delete headers['transfer-encoding'];
          delete headers['content-length'];
          headers['content-length'] = String(body.length);
          res.writeHead(upstreamRes.statusCode, headers);
          res.end(body);
          record('response', { method: req.method, url, status: upstreamRes.statusCode, byteLength: body.length, releasedFromBarrier: held });
        };
        if (!held) return deliver();
        barrierInfo = {
          url,
          status: upstreamRes.statusCode,
          byteLength: body.length,
          sha256: crypto.createHash('sha256').update(body).digest('hex'),
          heldAt: new Date().toISOString(),
        };
        try {
          const parsed = JSON.parse(body.toString('utf8'));
          barrierInfo.entries = (parsed.entries || []).length;
          barrierInfo.newestEntryId = (parsed.entries || [])[0]?.id || null;
          barrierInfo.streamCursor = parsed.streamCursor || '';
          barrierInfo.health = parsed.health || null;
        } catch (error) { barrierInfo.parseError = String(error.message); }
        record('barrier-held', { ...barrierInfo });
        barrierResolve(barrierInfo);
        released.then(() => {
          record('barrier-released', { url, at: new Date().toISOString() });
          deliver();
        });
      });
    });
    upstream.on('error', error => {
      record('upstream-error', { url, error: String(error.message) });
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'proxy upstream error' }));
    });
    req.pipe(upstream);
  });

  // Minimal RFC6455 text-frame tap (no negotiation of compression happens:
  // the gateway's ws server runs with default options).
  const makeFrameTap = direction => {
    let tapBuffer = Buffer.alloc(0);
    return chunk => {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    tapBuffer = Buffer.concat([tapBuffer, buf]);
    for (;;) {
      if (tapBuffer.length < 2) break;
      const second = tapBuffer[1];
      const opcode = tapBuffer[0] & 0x0f;
      const masked = (second & 0x80) !== 0;
      let len = second & 0x7f;
      let offset = 2;
      if (len === 126) { if (tapBuffer.length < offset + 2) break; len = tapBuffer.readUInt16BE(offset); offset += 2; }
      else if (len === 127) { if (tapBuffer.length < offset + 8) break; len = Number(tapBuffer.readBigUInt64BE(offset)); offset += 8; }
      let maskKey = null;
      if (masked) { if (tapBuffer.length < offset + 4) break; maskKey = tapBuffer.subarray(offset, offset + 4); offset += 4; }
      if (tapBuffer.length < offset + len) break;
      let payload = tapBuffer.subarray(offset, offset + len);
      if (masked) { const out = Buffer.alloc(len); for (let i = 0; i < len; i++) out[i] = payload[i] ^ maskKey[i % 4]; payload = out; }
      tapBuffer = tapBuffer.subarray(offset + len);
      if (opcode === 0x1) {
        const text = payload.toString('utf8');
        const detail = { direction, length: len };
        try {
          const message = JSON.parse(text);
          detail.type = message.type || null;
          if (message.type === 'subscribe' || message.type === 'unsubscribe') { detail.id = message.id; detail.route = String(message.route || '').slice(0, 400); }
          if (message.type === 'event') { detail.eventId = message.id; detail.event = message.event; detail.cursor = message.cursor || null; detail.dataSnippet = String(message.data || '').slice(0, 1200); }
          if (message.type === 'open' || message.type === 'error') detail.id = message.id;
        } catch { detail.textSnippet = text.slice(0, 200); }
        record('ws-frame', detail);
      }
    }
    };
  };

  server.on('upgrade', (req, socket, head) => {
    record('upgrade', { url: req.url || '/', origin: req.headers.origin || null });
    const upstream = http.request({
      host: targetHost,
      port: targetPort,
      method: 'GET',
      path: req.url,
      headers: {
        ...req.headers,
        host: `${targetHost}:${targetPort}`,
        origin: `http://${targetHost}:${targetPort}`,
      },
      agent: false,
    });
    upstream.on('upgrade', (upstreamRes, upstreamSocket, upstreamHead) => {
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\n` +
        `Upgrade: websocket\r\n` +
        `Connection: Upgrade\r\n` +
        `Sec-WebSocket-Accept: ${upstreamRes.headers['sec-websocket-accept']}\r\n` +
        (upstreamRes.headers['sec-websocket-protocol'] ? `Sec-WebSocket-Protocol: ${upstreamRes.headers['sec-websocket-protocol']}\r\n` : '') +
        `\r\n`
      );
      if (upstreamHead?.length) socket.write(upstreamHead);
      if (head?.length) upstreamSocket.write(head);
      const clientTap = makeFrameTap('client->server');
      const serverTap = makeFrameTap('server->client');
      socket.on('data', chunk => { clientTap(chunk); upstreamSocket.write(chunk); });
      upstreamSocket.on('data', chunk => { serverTap(chunk); socket.write(chunk); });
      const kill = () => { try { socket.destroy(); } catch {} try { upstreamSocket.destroy(); } catch {} sockets.delete(socket); sockets.delete(upstreamSocket); };
      socket.on('error', kill); upstreamSocket.on('error', kill);
      socket.on('close', kill); upstreamSocket.on('close', kill);
      sockets.add(socket); sockets.add(upstreamSocket);
    });
    upstream.on('error', error => {
      record('upgrade-error', { error: String(error.message) });
      socket.destroy();
    });
    upstream.end();
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve({
      url: `http://127.0.0.1:${server.address().port}`,
      events,
      armSnapshotBarrier() { barrierArmed = true; record('barrier-armed', {}); },
      async waitBarrier(timeoutMs = 10000) {
        const timer = new Promise((_, reject) => setTimeout(() => reject(new Error('barrier timeout')), timeoutMs));
        return Promise.race([barrierHeld, timer]);
      },
      releaseBarrier() { record('barrier-release-command', {}); releaseResolve(); },
      get barrierInfo() { return barrierInfo; },
      close() {
        return new Promise(resolve => {
          for (const socket of sockets) { try { socket.destroy(); } catch {} }
          server.close(() => resolve());
          setTimeout(resolve, 2000);
          server.closeAllConnections?.();
        });
      },
    }));
  });
}

function decodeStreamCursor(value) {
  if (!value) return null;
  try {
    return JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8'));
  } catch { return null; }
}

module.exports = { createGapProxy, decodeStreamCursor };
