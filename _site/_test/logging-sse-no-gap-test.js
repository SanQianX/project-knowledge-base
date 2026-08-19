const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnServer } = require('./helpers/spawn-server');
const { StorageLayout } = require('../lib/storage-layout');
const { LogRepository } = require('../lib/structured-logger');

const ROOT = path.resolve(__dirname, '..', '..');
const PORT = 7950 + (process.pid % 300);
const BASE = `http://127.0.0.1:${PORT}`;

async function waitForServer() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('server did not start');
}

(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-log-sse-'));
  const spawned = spawnServer({ root: ROOT, port: PORT, dataDir, tag: 'log-sse', extraEnv: { KB_SKIP_MIGRATION: '1' } });
  try {
    await waitForServer();
    let response = await fetch(`${BASE}/api/logs?q=http.request_`);
    let snapshot = await response.json();
    assert.strictEqual(snapshot.pageSize, 500, 'HTTP logs API must preserve the 500-row default');
    assert(snapshot.streamCursor);
    response = await fetch(`${BASE}/api/logs?pageSize=999999`);
    assert.strictEqual((await response.json()).pageSize, 5000, 'HTTP logs API must cap the display page at 5000');

    await fetch(`${BASE}/api/state`);
    await fetch(`${BASE}/api/projects/not-valid%2Fid`);
    await new Promise(resolve => setTimeout(resolve, 100));
    const watermark = JSON.parse(Buffer.from(snapshot.streamCursor, 'base64url').toString('utf8'));
    const repository = new LogRepository({ layout: new StorageLayout({ dataDir }) });
    const page = repository.query({ q: 'http.request_', pageSize: 5000 });
    const expectedGapIds = [];
    for (const entry of page.entries) {
      if (entry.id === watermark.afterId) break;
      expectedGapIds.push(entry.id);
    }
    assert(expectedGapIds.length >= 3, 'fixture must create completed and failed requests between GET and SSE');

    const controller = new AbortController();
    response = await fetch(`${BASE}/api/logs/stream?q=http.request_&streamCursor=${encodeURIComponent(snapshot.streamCursor)}`, { signal: controller.signal });
    assert.strictEqual(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/event-stream/);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    const streamedIds = new Set();
    let ready = false;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && (!ready || expectedGapIds.some(id => !streamedIds.has(id)))) {
      const read = await Promise.race([
        reader.read(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('SSE read timeout')), 1000)),
      ]);
      if (read.done) break;
      pending += decoder.decode(read.value, { stream: true });
      const frames = pending.split('\n\n');
      pending = frames.pop() || '';
      for (const frame of frames) {
        const dataLine = frame.split('\n').find(line => line.startsWith('data: '));
        if (!dataLine) continue;
        const event = JSON.parse(dataLine.slice(6));
        if (event.type === 'logs/ready') ready = true;
        if (event.type === 'logs/appended' && event.record) streamedIds.add(event.record.id);
      }
    }
    controller.abort();
    assert(ready, 'SSE must mark the replay/live handoff');
    assert(expectedGapIds.every(id => streamedIds.has(id)), 'GET-to-SSE handoff must replay every durable gap record exactly by id');

    const requestLogs = repository.query({ q: 'http.request_', pageSize: 5000 }).entries;
    assert(requestLogs.some(entry => entry.event === 'http.request_started'));
    assert(requestLogs.some(entry => entry.event === 'http.request_completed' && entry.durationMs >= 0));
    assert(requestLogs.some(entry => entry.event === 'http.request_failed' && entry.operationId));
    console.log('logging-sse-no-gap-test PASS');
  } finally {
    await spawned.cleanup();
  }
})().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
