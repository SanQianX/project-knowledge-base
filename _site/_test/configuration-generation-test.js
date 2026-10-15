'use strict';
const assert = require('node:assert/strict');
const { ModuleBridge } = require('../lib/module-bridge');
(async () => {
  const bridge = new ModuleBridge({ dataDir: process.cwd() });
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const hold = new Promise(resolve => { release = resolve; });
  let writes = 0;
  bridge._fetch = async (url, init) => {
    if (url.endsWith('/api/runtime-config')) {
      if (++writes === 1) { entered(); await hold; }
      return { ok: true, json: async () => ({ ok: true }) };
    }
    return { ok: true, json: async () => ({ rootPath: 'not-a-real-storage-path' }) };
  };
  const first = bridge.syncEngineConfiguration(); await started;
  bridge.resetRuntimeConfiguration(); release(); await first;
  assert.equal(writes, 2, 'a module restart while configuration is in flight triggers one merged replay');
  await bridge.syncEngineConfiguration(); assert.equal(writes, 2, 'unchanged configuration is cached only in the new generation');
  console.log('configuration-generation-test PASS (late pre-restart acknowledgements cannot suppress new configuration)');
})().catch(error => { console.error(error); process.exitCode = 1; });
