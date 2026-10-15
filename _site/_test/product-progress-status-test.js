'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawnServer } = require('./helpers/spawn-server');
const { findChrome } = require('./helpers/find-chrome');
const { launchCdpBrowser, waitFor } = require('./helpers/cdp-browser');

const ROOT = path.resolve(__dirname, '../..');
async function main() {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-product-progress-'));
  const snapshot = { projects: [], runs: [], events: [], memories: [], sharedScopes: [] };
  let connections = 0, snapshots = 0, healthRequests = 0;
  const streams = new Set();
  const upstream = http.createServer((req, res) => {
    // The product sends the progress/snapshot reads with query parameters
    // (e.g. /api/progress?summary=1), so route on the pathname only.
    const cleanPath = req.url.split('?')[0];
    if (cleanPath === '/api/progress') {
      connections++; streams.add(res); res.on('close', () => streams.delete(res));
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);
      return;
    }
    req.resume();
    if (cleanPath === '/api/snapshot') snapshots++;
    if (cleanPath.includes('/health')) healthRequests++;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(cleanPath === '/api/snapshot' ? snapshot : cleanPath === '/api/projects' ? { projects: [] } : { ok: true, name: 'knowledge-engine', dataSchemaVersion: 3 }));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const moduleUrl = `http://127.0.0.1:${upstream.address().port}`;
  const port = 8400 + process.pid % 200;
  const base = `http://127.0.0.1:${port}`;
  const server = spawnServer({ root: ROOT, port, dataDir: path.join(fixture, 'data'), analysisOwner: 'engine', tag: 'product-progress', extraEnv: {
    KB_TERMINAL_URL: moduleUrl, KB_VECTORHUB_URL: moduleUrl,
    KB_EVENTBRIDGE_URL: moduleUrl, KB_KNOWLEDGE_ENGINE_URL: moduleUrl,
  } });
  let browser;
  try {
    await waitFor(async () => { try { return (await fetch(base + '/api/health')).ok; } catch { return false; } }, 'isolated product', 20000);
    browser = await launchCdpBrowser({ chrome: findChrome(), profileDir: path.join(fixture, 'browser'), url: base, width: 1920, height: 1080 });
    await browser.setViewport(1920, 1080);
    const run = expression => browser.evaluate(expression);
    const status = () => run("document.getElementById('activityConnection').textContent");
    await waitFor(async () => await status() === '已连接实时更新', 'initial SSE snapshot');
    assert.equal(connections, 1);
    for (let attempt = 0; attempt < 2; attempt++) {
      const beforeHealth = healthRequests, beforeSnapshot = snapshots;
      await run("window.dispatchEvent(new Event('online'))");
      await waitFor(() => healthRequests > beforeHealth && snapshots > beforeSnapshot, 'online registry and snapshot refresh');
      assert.equal(await status(), '已连接实时更新', 'a duplicate online event must not leave a healthy stream labelled as recovering');
      assert.equal(connections, 1, 'a redundant online receipt cannot create another progress subscription');
    }
    await browser.send('Network.enable');
    await browser.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await waitFor(async () => (await status()).includes('连接中断'), 'genuine offline feedback');
    await waitFor(() => streams.size === 0, 'offline closes the upstream stream');
    await browser.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await waitFor(async () => await status() === '已连接实时更新' && connections === 2, 'new snapshot and stream after real reconnection');
    assert.equal(streams.size, 1);
    assert.equal(browser.exceptions.length, 0);
    console.log('product-progress-status-test PASS (real product/browser/proxy/SSE; duplicate online stays connected; real offline reconnects once)');
  } finally {
    await browser?.close(); await server.cleanup();
    upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
    assert.equal(path.dirname(fixture), path.resolve(os.tmpdir())); assert.ok(path.basename(fixture).startsWith('pk-product-progress-'));
    fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}
main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
