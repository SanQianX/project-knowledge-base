'use strict';
const assert = require('node:assert/strict');
const { ModuleBridge } = require('../lib/module-bridge');

(async () => {
  const bridge = new ModuleBridge({ engineUrl: 'http://127.0.0.1:1', settingsStore: { read: () => ({ knowledge: { rootPath: 'D:/test-knowledge' }, brain: { id: 'brain-default', name: 'test', domains: [] } }) } });
  let calls = [];
  bridge.proxy = async (_req, _res, target) => calls.push(target);
  for (const route of ['api/health', '%61pi/health', 'a/../api/runtime-config', '%2e%2e/api/control', '%252e%252e/api/control', 'x\\api/health', 'internal/maintenance-config']) {
    const res = { end() {}, statusCode: 0 };
    await bridge.proxyModuleUi({ method: 'GET' }, res, 'engine', route, '');
    assert.equal(res.statusCode, 404); assert.equal(calls.length, 0);
  }
  await bridge.proxyModuleUi({ method: 'GET' }, { end() {} }, 'terminal', 'agent-terminal/app.js', '?embed=1');
  assert.equal(calls.length, 1);
  calls = [];
  bridge._fetch = async (url, init) => {
    if (url.endsWith('/scopes')) throw new Error('scope connection failure');
    if (url.endsWith('/internal/maintenance-config') || url.endsWith('/internal/embedding-config')) throw new Error('profile source offline');
    calls.push({ url, body: JSON.parse(init.body) });
    return { ok: true };
  };
  const status = await bridge.syncEngineConfiguration();
  assert.equal(status.scopes, false); assert.equal(status.model, false);
  assert.equal(calls.length, 2);
  assert.equal(calls.find(call => call.url.endsWith('/api/runtime-config')).body.profile, null, 'scope failures must not leave a stale model credential active');
  assert.equal(calls.find(call => call.url.endsWith('/api/internal/runtime-config')).body.settings, null, 'profile source failure must clear a stale embedding credential');
  assert.equal(status.embedding, false);
  console.log('module-boundary-test PASS');
})().catch(error => { console.error(error); process.exitCode = 1; });
