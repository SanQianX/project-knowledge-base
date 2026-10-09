'use strict';
const assert = require('node:assert/strict');
const http = require('node:http');
const { ModuleBridge } = require('../lib/module-bridge');
(async () => {
  let profile = { apiKey: 'controlled-model-key', mainModel: 'durable-default' };
  let settings = { provider: 'openai', apiKey: 'controlled-vector-key', model: 'embedding-model' };
  let appliedModel, appliedVector; const hits = [];
  const migrationId = `embedding-${'a'.repeat(64)}`;
  let legacy = { provider: 'minimax', apiKey: 'controlled-legacy-key', model: 'embo-01' };
  const service = http.createServer((req, res) => {
    assert.equal(req.headers.authorization, 'Bearer runtime-test');
    assert.equal(req.headers.origin, undefined);
    let input = ''; req.on('data', c => { input += c; });
    req.on('end', () => {
      hits.push(req.url); const body = JSON.parse(input || '{}');
      let result = { ok: true }; let status = 200;
      if (req.url.endsWith('/internal/maintenance-config')) { result = profile; if (!profile) status = 409; }
      else if (req.url === '/api/internal/embedding-config') result = { settings: legacy, migrationId };
      else if (req.url.endsWith('/internal/import-embedding')) { assert.equal(body.settings.apiKey, 'controlled-legacy-key'); }
      else if (req.url === '/api/internal/retire-embedding') { assert.equal(body.migrationId, migrationId); legacy = null; }
      else if (req.url.endsWith('/v1/internal/embedding-config')) { result = settings; if (!settings) status = 409; }
      else if (req.url === '/api/internal/runtime-config') appliedVector = body.settings;
      else if (req.url === '/api/runtime-config') appliedModel = body.profile;
      res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(result || {}));
    });
  });
  await new Promise(resolve => service.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${service.address().port}`;
  const bridge = new ModuleBridge({ terminalUrl: url, engineUrl: url, vectorHubUrl: url, runtimeToken: 'runtime-test' });
  try {
    const status = await bridge.syncEngineConfiguration();
    assert.equal(status.model, true); assert.equal(status.embedding, true);
    assert.equal(appliedModel.mainModel, 'durable-default'); assert.equal(appliedVector.model, 'embedding-model');
    assert.ok(!JSON.stringify(status).includes('key'));
    assert.ok(hits.indexOf('/api/claude-workbench/v1/internal/import-embedding') < hits.indexOf('/api/internal/retire-embedding'));
    profile = null; settings = null;
    const revoked = await bridge.syncEngineConfiguration();
    assert.equal(revoked.model, false); assert.equal(revoked.embedding, false);
    assert.equal(appliedModel, null); assert.equal(appliedVector, null);
    console.log('module-model-configuration-test PASS');
  } finally { service.closeAllConnections(); await new Promise(resolve => service.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
