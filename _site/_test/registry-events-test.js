'use strict';
const assert = require('node:assert/strict');
const http = require('node:http');
const { RegistryEvents } = require('../lib/registry-events');
const { createRequestHandler } = require('../lib/server-app');

(async () => {
  const events = new RegistryEvents(), received = [];
  const off = events.subscribe(event => received.push(event));
  assert.equal(received[0].type, 'registry-snapshot');
  const runtime = { registryEvents: events, logger: { debug: async () => {}, info: async () => {} },
    moduleBridge: { syncEngineConfiguration: async () => ({}) },
    settingsStore: { read: () => ({ brain: { id: 'brain-default', name: 'before' }, knowledge: { rootPath: '' } }), updatePatch: async patch => ({ brain: patch.brain }) } };
  // Exercise the real HTTP completion hook independently of business stores.
  const handler = createRequestHandler(runtime, { host: '127.0.0.1', port: 0 });
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const reader = await fetch(`${base}/api/registry/events`);
    const stream = reader.body.getReader();
    const first = new TextDecoder().decode((await stream.read()).value);
    assert.match(first, /registry-snapshot/);
    const mutation = await fetch(`${base}/api/brain`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'after' }) });
    assert.equal(mutation.status, 200);
    const change = new TextDecoder().decode((await stream.read()).value);
    assert.match(change, /registry-changed/);
    assert.equal(received[1].revision, 1);
    const reconnect = []; events.subscribe(event => reconnect.push(event))();
    assert.equal(reconnect[0].revision, 1);
    assert.equal(reconnect[0].instanceId, received[0].instanceId);
    await stream.cancel();
    off(); events.publish(['brain']);
    assert.equal(received.length, 2, 'unsubscribed observers receive no more updates');
    assert.notEqual(new RegistryEvents().instanceId, events.instanceId, 'restart makes old revisions distinguishable');
    console.log('registry-events-test PASS (real SSE, reconnect identity and unsubscribe)');
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
