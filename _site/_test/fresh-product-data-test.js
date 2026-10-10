const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { initializeProductData, DATA_SCHEMA } = require('../lib/product-data');
const { resolveDataDirPath } = require('../lib/data-dir');
const { connectEngine } = require('../lib/engine-connection');

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-fresh-product-'));
  assert.equal(resolveDataDirPath({ dataDir: '', homeDir: root }), path.join(root, '.project-knowledge-v5'));
  const old = path.join(root, 'old'); fs.mkdirSync(old);
  const bytes = JSON.stringify({ projects: ['old-project'], activeClaim: 'old-claim' });
  fs.writeFileSync(path.join(old, 'projects.json'), bytes);
  assert.throws(() => initializeProductData(old), { code: 'SCHEMA_UNSUPPORTED' });
  assert.equal(fs.readFileSync(path.join(old, 'projects.json'), 'utf8'), bytes);
  const fresh = path.join(root, 'fresh'); initializeProductData(fresh); initializeProductData(fresh);
  assert.equal(JSON.parse(fs.readFileSync(path.join(fresh, 'product-data.json'))).schema, DATA_SCHEMA);
  const auxiliary = path.join(root, 'auxiliary');
  const session = path.join(auxiliary, 'runtime', 'claude-sessions', 'unregistered-test', 'session.json');
  fs.mkdirSync(path.dirname(session), { recursive: true });
  fs.writeFileSync(session, 'untouched abandoned chat');
  fs.writeFileSync(path.join(auxiliary, 'launcher.log'), 'old startup failure');
  initializeProductData(auxiliary);
  assert.equal(fs.readFileSync(session, 'utf8'), 'untouched abandoned chat');
  for (const entry of ['claims', 'runs', 'promotions', 'transactions', 'unknown-business-state']) {
    const pending = path.join(root, entry);
    fs.mkdirSync(path.join(pending, 'runtime', entry), { recursive: true });
    fs.writeFileSync(path.join(pending, 'runtime', entry, 'record.json'), '{}');
    assert.throws(() => initializeProductData(pending), error => error.code === 'SCHEMA_UNSUPPORTED' && error.message.includes(`runtime/${entry}`));
    assert.equal(fs.existsSync(path.join(pending, 'product-data.json')), false);
  }
  const paths = [];
  let activationStatus = 403;
  const logs = [];
  const runtime = {
    analysisOwner: 'engine', registryStore: { listIds: () => [] }, logger: { warn: async (...args) => logs.push(args) },
    moduleBridge: { engineUrl: 'http://engine.invalid', runtimeToken: 'private-local-token', syncEngineConfiguration: async () => {}, _fetch: async url => {
      paths.push(url);
      if (url.endsWith('/api/health')) return { ok: true, status: 200, json: async () => ({ name: 'knowledge-engine', version: '0.2.0', dataSchemaVersion: 3 }) };
      if (url.endsWith('/api/runtime-auth')) return { ok: true, status: 200 };
      return { ok: activationStatus === 200, status: activationStatus };
    } },
  };
  await connectEngine(runtime);
  assert.equal(runtime.ownership.ready, false);
  assert.equal(runtime.ownership.error.code, 'RUNTIME_AUTH_REQUIRED');
  assert.equal(runtime.ownership.error.step, 'engine-activation');
  assert.ok(!JSON.stringify(logs).includes('private-local-token'));
  assert.ok(paths.every(url => !url.includes('migrate')));
  await connectEngine(runtime);
  assert.equal(logs.length, 1, 'identical connection failures are not repeatedly logged');
  activationStatus = 200; await connectEngine(runtime);
  assert.deepEqual(runtime.ownership, { owner: 'engine', ready: true });
  console.log('PASS fresh data isolation, legacy rejection, precise connection failure, recovery without migration');
})().catch(error => { console.error(error); process.exitCode = 1; });
