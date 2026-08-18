const assert = require('assert');
const path = require('path');
const { spawnServer } = require('./helpers/spawn-server');
const { requestJson, waitFor } = require('./helpers/cdp-browser');
const { createLoggingUiFixture } = require('./helpers/logging-ui-fixture');

const ROOT = path.resolve(__dirname, '..', '..');
const port = 8750 + (process.pid % 180);

function baseParams(fixture, pageSize) {
  const params = new URLSearchParams();
  params.set('from', '2000-01-01');
  params.set('to', '2999-12-31');
  params.set('levels', 'trace,debug,info,warn,error,fatal');
  params.set('projectId', fixture.projectId);
  params.set('pageSize', String(pageSize || 10));
  return params;
}

async function jsonResponse(url) {
  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  const body = await response.json();
  return { response, body };
}

(async () => {
  const fixture = await createLoggingUiFixture({ totalLogs: 64 });
  const server = spawnServer({ root: ROOT, port, dataDir: fixture.dataDir, tag: 'logging-ui-api', stdio: 'ignore' });
  try {
    await waitFor(() => requestJson('http://127.0.0.1:' + port + '/api/health').then(body => body.ok), 'logging API', 20000);
    const baseUrl = 'http://127.0.0.1:' + port;
    const firstParams = baseParams(fixture, 10);
    const first = await jsonResponse(baseUrl + '/api/logs?' + firstParams.toString());
    assert.strictEqual(first.response.status, 200);
    assert.strictEqual(first.body.entries.length, 10);
    assert(first.body.nextCursor, 'first page must return an opaque next cursor');
    assert.strictEqual(first.body.pageSize, 10);
    assert(first.body.health && first.body.health.status === 'ok');
    assert.deepStrictEqual(Object.keys(first.body.counts).sort(), ['debug', 'error', 'fatal', 'info', 'trace', 'warn']);

    const secondParams = baseParams(fixture, 10);
    secondParams.set('cursor', first.body.nextCursor);
    const second = await jsonResponse(baseUrl + '/api/logs?' + secondParams.toString());
    assert.strictEqual(second.response.status, 200);
    assert.strictEqual(second.body.entries.length, 10);
    assert(!second.body.entries.some(entry => first.body.entries.some(prior => prior.id === entry.id)), 'cursor pages must not overlap');

    const invalidParams = baseParams(fixture, 10);
    invalidParams.set('cursor', first.body.nextCursor);
    invalidParams.set('q', 'changed-fingerprint');
    const invalid = await jsonResponse(baseUrl + '/api/logs?' + invalidParams.toString());
    assert.strictEqual(invalid.response.status, 409);
    assert.strictEqual(invalid.body.error.code, 'LOG_CURSOR_EXPIRED');
    assert.strictEqual(invalid.body.error.retryable, true);
    assert(!('stack' in invalid.body.error), 'public cursor error must not leak a stack');

    const filters = [
      ['component', 'commit-reconciler'],
      ['event', 'fixture.phase.10'],
      ['operationId', 'op-flow-visual'],
      ['commitSha', fixture.repo.headCommit],
      ['q', '<img src=x onerror=window.__xss=1>'],
      ['levels', 'fatal'],
    ];
    for (const pair of filters) {
      const params = baseParams(fixture, 100);
      params.set(pair[0], pair[1]);
      const result = await jsonResponse(baseUrl + '/api/logs?' + params.toString());
      assert.strictEqual(result.response.status, 200, 'filter failed: ' + pair[0]);
      assert(result.body.entries.length > 0, 'filter returned no entries: ' + pair[0]);
    }

    const exportParams = baseParams(fixture, 100);
    exportParams.delete('pageSize');
    exportParams.set('operationId', 'op-flow-visual');
    exportParams.set('component', 'commit-reconciler');
    exportParams.set('event', 'fixture.phase.3');
    exportParams.set('commitSha', fixture.repo.headCommit);
    const exported = await fetch(baseUrl + '/api/logs/export?' + exportParams.toString(), { headers: { Accept: 'application/x-ndjson' } });
    assert.strictEqual(exported.status, 200);
    assert((exported.headers.get('content-type') || '').includes('application/x-ndjson'));
    assert((exported.headers.get('content-disposition') || '').includes('attachment'));
    const lines = (await exported.text()).trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
    assert.strictEqual(lines.length, 1);
    assert(lines.every(entry => entry.operationId === 'op-flow-visual' && entry.component === 'commit-reconciler' && entry.event === 'fixture.phase.3'));

    const rootMutation = await fetch(baseUrl + '/api/settings', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ logging: { rootPath: path.join(fixture.dataDir, 'elsewhere') } }),
    });
    assert.strictEqual(rootMutation.status, 409, 'logging root must not be mutable through the API');
    const persistedSettings = JSON.parse(require('fs').readFileSync(fixture.layout.getSettingsPath(), 'utf8'));
    assert(!Object.prototype.hasOwnProperty.call(persistedSettings.logging, 'rootPath'));

    console.log('logging UI test PASS');
  } finally {
    server.cleanup();
    fixture.cleanup();
  }
})().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
