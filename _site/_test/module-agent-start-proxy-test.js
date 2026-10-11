'use strict';
const assert = require('node:assert/strict');
const http = require('node:http');
const { Readable } = require('node:stream');
const { EventEmitter } = require('node:events');
const { ModuleBridge } = require('../lib/module-bridge');

async function budget(method, pathname) {
  const timers = [], originalTimer = global.setTimeout, originalFetch = global.fetch;
  const req = Readable.from([]); req.method = method; req.headers = {};
  const res = new EventEmitter();
  res.writeHead = () => {}; res.end = () => { res.writableEnded = true; };
  try {
    global.setTimeout = (fn, ms, ...args) => { timers.push(ms); return originalTimer(fn, ms, ...args); };
    global.fetch = async () => new Response('{}', { headers: { 'Content-Type': 'application/json' } });
    await new ModuleBridge().proxy(req, res, 'http://127.0.0.1:5760' + pathname);
    return timers[0];
  } finally { global.setTimeout = originalTimer; global.fetch = originalFetch; }
}

(async () => {
  const upstream = http.createServer((req, res) => {
    const timer = setTimeout(() => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"accepted":true}'); }, 11000);
    res.on('close', () => clearTimeout(timer));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const bridge = new ModuleBridge();
  const target = `http://127.0.0.1:${upstream.address().port}/api/claude-workbench/v1/sessions/cold-client/input`;
  const shell = http.createServer((req, res) => bridge.proxy(req, res, target));
  await new Promise(resolve => shell.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${shell.address().port}/send`, { method: 'POST', body: '{}' });
    assert.equal(response.status, 200, 'cold native client startup must not be reported as unreachable after ten seconds');
    assert.equal((await response.json()).accepted, true);
  } finally {
    for (const server of [shell, upstream]) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  }
  assert.equal(await budget('POST', '/api/claude-workbench/v1/sessions'), 90000);
  assert.equal(await budget('POST', '/api/claude-workbench/v1/sessions/cold-client/input?scope=project'), 90000);
  for (const [method, route] of [
    ['GET', '/api/claude-workbench/v1/sessions'],
    ['POST', '/api/claude-workbench/v1/sessions/cold-client/abort'],
    ['POST', '/api/claude-workbench/v1/sessions/cold-client/permission'],
    ['POST', '/api/engine/runs'],
    ['POST', '/api/sessions/cold-client/input'],
  ]) assert.equal(await budget(method, route), 10000, 'unrelated APIs must keep their ordinary timeout');
  assert.equal(await budget('POST', '/api/claude-workbench/v1/system/pick-folder'), 600000);
  const originalFetch = global.fetch;
  let warning, failure;
  const request = Readable.from([]); request.method = 'GET'; request.headers = {};
  const response = new EventEmitter(); response.writeHead = () => {};
  response.end = bytes => { response.writableEnded = true; failure = JSON.parse(bytes); };
  try {
    global.fetch = async () => { throw new Error('upstream leaked credential: secret-proxy-fixture'); };
    const safeBridge = new ModuleBridge({ logger: { warn(...args) { warning = args; } } });
    await safeBridge.proxy(request, response, 'http://127.0.0.1:5760/api/health?apiKey=secret-proxy-fixture');
    assert.equal(failure.error, 'MODULE_UNREACHABLE');
    assert.equal(failure.details.failureKind, 'NETWORK_ERROR');
    assert.equal(failure.details.timeoutMs, 10000);
    assert.equal(warning[0], 'module.proxy.failed');
    assert.equal(warning[2].context.path, '/api/health');
    assert.ok(!JSON.stringify([failure, warning]).includes('secret-proxy-fixture'), 'diagnostics omit queries, raw errors and credentials');
  } finally { global.fetch = originalFetch; }
  console.log('module-agent-start-proxy-test PASS');
})().catch(error => { console.error(error); process.exitCode = 1; });
