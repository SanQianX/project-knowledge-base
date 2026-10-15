'use strict';
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { WebSocket } = require('ws');
const { attachLiveGateway } = require('../lib/live-gateway');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
  let active = 0, total = 0;
  const upstream = http.createServer((req, res) => {
    active++; total++;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('id: 17\r\nevent: snapshot\r\ndata: {"ok":true}\r');
    setTimeout(() => { if (!res.destroyed) res.write('\n\r\n'); }, 5);
    req.on('close', () => { active--; });
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${upstream.address().port}`;
  const server = http.createServer();
  const runtime = { moduleBridge: { engineUrl: origin, engineCompatible: true, _terminalApi: route => origin + route } };
  const gateway = attachLiveGateway(server, runtime);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`, clients = [];
  try {
    for (let i = 0; i < 8; i++) {
      const ws = new WebSocket(base.replace('http:', 'ws:') + '/api/live', { origin: base }); clients.push(ws);
      await once(ws, 'open');
      const messages = []; ws.on('message', b => messages.push(JSON.parse(String(b))));
      ws.send(JSON.stringify({ type: 'subscribe', id: 'engine', route: '/api/engine/progress?summary=1' }));
      for (let n = 0; n < 100 && !messages.some(m => m.type === 'event'); n++) await wait(5);
      const event = messages.find(m => m.type === 'event'); assert.equal(event.event, 'snapshot'); assert.equal(event.cursor, '17'); assert.deepEqual(JSON.parse(event.data), { ok: true });
      ws.send(JSON.stringify({ type: 'subscribe', id: 'invalid', route: 'http://attacker.invalid/private' }));
      for (let n = 0; n < 100 && !messages.some(m => m.id === 'invalid'); n++) await wait(5);
      assert.equal(messages.find(m => m.id === 'invalid').code, 'INVALID_SUBSCRIPTION');
    }
    assert.equal(active, 8); assert.equal(total, 8, 'invalid URLs never fetch an upstream');
    const last = clients.at(-1);
    last.send(JSON.stringify({ type: 'unsubscribe', id: 'engine' }));
    for (let n = 0; n < 100 && active !== 7; n++) await wait(5);
    assert.equal(active, 7, 'unsubscribing releases the upstream');
    const rejected = new WebSocket(base.replace('http:', 'ws:') + '/api/live', { origin: 'http://evil.invalid' });
    await new Promise(resolve => { rejected.on('error', resolve); rejected.on('open', () => { throw new Error('cross-origin upgrade was accepted'); }); });
    gateway.close();
    for (let n = 0; n < 100 && active; n++) await wait(5);
    assert.equal(active, 0);
    console.log('live-gateway-test PASS (8 real sockets, CRLF frames, bounded allowlist, unsubscribe and shutdown release)');
  } finally { for (const ws of clients) ws.terminate(); gateway.close(); upstream.closeAllConnections(); await Promise.all([new Promise(r => server.close(r)), new Promise(r => upstream.close(r))]); }
})().catch(error => { console.error(error); process.exitCode = 1; });
