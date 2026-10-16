'use strict';
const assert = require('node:assert/strict');
const http = require('node:http');
const { ModuleBridge } = require('../lib/module-bridge');
(async () => {
  const upstream = http.createServer((req, res) => {
    const timer = setTimeout(() => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}'); }, 75);
    res.on('close', () => clearTimeout(timer));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const bridge = new ModuleBridge({ vectorHubUrl: `http://127.0.0.1:${upstream.address().port}` });
  const timer = global.setTimeout;
  const budgets = [];
  // Scale only the two product deadlines, preserving real HTTP cancellation.
  global.setTimeout = (fn, ms, ...args) => {
    if (ms === 10000 || ms === 120000) { budgets.push(ms); return timer(fn, ms === 10000 ? 25 : 500, ...args); }
    return timer(fn, ms, ...args);
  };
  const server = http.createServer((req, res) => bridge.proxy(req, res, `http://127.0.0.1:${upstream.address().port}${req.url}`));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const indexed = await fetch(`${base}/api/sync`, { method: 'POST', body: '{}' });
    assert.equal(indexed.status, 200, 'a real embedding pass must use the engine indexing budget rather than the interactive deadline');
    assert.equal(budgets[0], 120000);
    const health = await fetch(`${base}/api/health`);
    assert.equal(health.status, 502, 'ordinary reads keep their bounded interactive deadline');
    console.log('module-index-proxy-test PASS');
  } finally {
    global.setTimeout = timer;
    for (const s of [server, upstream]) { s.closeAllConnections(); await new Promise(resolve => s.close(resolve)); }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
