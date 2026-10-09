'use strict';
const assert = require('node:assert/strict');
const http = require('node:http');
const { ModuleBridge } = require('../lib/module-bridge');

(async () => {
  let disconnected = false; let cursor;
  const upstream = http.createServer((req, res) => {
    cursor = req.headers['last-event-id'];
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('id: 8\nevent: delta\ndata: {"text":"first"}\n\n');
    const timer = setInterval(() => res.write(': live\n\n'), 100);
    res.on('close', () => { clearInterval(timer); disconnected = true; });
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const bridge = new ModuleBridge();
  const shell = http.createServer((req, res) => bridge.proxy(req, res, `http://127.0.0.1:${upstream.address().port}/events`));
  await new Promise(resolve => shell.listen(0, '127.0.0.1', resolve));
  const abort = new AbortController();
  try {
    const response = await fetch(`http://127.0.0.1:${shell.address().port}/events`, { headers: { 'Last-Event-ID': '7' }, signal: abort.signal });
    const reader = response.body.getReader();
    const first = await Promise.race([reader.read(), new Promise((_, reject) => setTimeout(() => reject(new Error('SSE was buffered')), 1500))]);
    assert.match(Buffer.from(first.value).toString(), /first/);
    assert.equal(cursor, '7');
    abort.abort();
    for (let i = 0; i < 40 && !disconnected; i++) await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(disconnected, true, 'browser disconnect releases upstream');
    console.log('module-stream-proxy-test PASS');
  } finally {
    abort.abort();
    for (const server of [shell, upstream]) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
