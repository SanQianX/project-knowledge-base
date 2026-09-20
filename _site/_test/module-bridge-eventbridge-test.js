// Module bridge: ai-coding-event-bridge console leg.
//
// Exercises the third embedded module end to end against a stub console
// server (same surface as packages/console/src/server.js): proxy mapping,
// idempotent registration by Git work tree path, removal (404-tolerant),
// aggregated projection, health, and the supervised-spawn spec (vendored
// runtime, command override, bridge-home passthrough). Real module services
// are never contacted — terminal/vector-hub point at a reserved loopback
// port that refuses instantly.

const assert = require('assert');
const http = require('http');
const { PassThrough } = require('stream');
const { ModuleBridge, defaultEventBridgeUrl } = require('../lib/module-bridge');

const DEAD_URL = 'http://127.0.0.1:1'; // reserved port: connection refused, never a real service

function makeStoreStub() {
  const store = {
    state: { modules: {} },
    readConfig: () => ({ displayName: 'demo', repoPath: 'D:/work/demo', knowledgePath: 'D:/kb/demo' }),
    readState: () => store.state,
    updateState: async (_id, mutator) => { mutator(store.state); },
  };
  return store;
}

function fakeRes() {
  return {
    statusCode: 0, headers: {}, body: '',
    writeHead(code, headers) { this.statusCode = code; this.headers = headers || {}; },
    end(buf) { this.body = buf ? Buffer.from(buf).toString('utf8') : ''; },
  };
}

function fakeReq(body) {
  const req = new PassThrough();
  req.method = 'GET';
  req.headers = {};
  req.end(body || undefined);
  return req;
}

async function main() {
  assert.strictEqual(defaultEventBridgeUrl(), 'http://127.0.0.1:8790', 'loopback default URL');

  // ---- stub console server (same API surface the shell integrates against) ----
  const hits = [];
  const registered = [];
  const stub = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    hits.push(`${req.method} ${url.pathname}${url.search}`);
    if (url.pathname === '/api/echo') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ echo: `${req.method} ${url.pathname}`, query: Object.fromEntries(url.searchParams) }));
      return;
    }
    if (url.pathname === '/api/projects' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ projects: registered }));
      return;
    }
    if (url.pathname === '/api/projects' && req.method === 'POST') {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        const parsed = JSON.parse(body || '{}');
        if (registered.some(p => p.path === parsed.path)) {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { code: 'PROJECT_DUPLICATE', message: 'duplicate' } }));
          return;
        }
        const project = { id: `sha256:${registered.length + 1}`, name: 'demo', path: parsed.path, store: parsed.store || 'global', auto: false, turns: 3 };
        registered.push(project);
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ project }));
      });
      return;
    }
    if (url.pathname === '/api/projects' && req.method === 'DELETE') {
      const id = url.searchParams.get('id');
      const index = registered.findIndex(p => p.id === id);
      if (index === -1) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'PROJECT_NOT_FOUND', message: 'unknown' } }));
        return;
      }
      registered.splice(index, 1);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ removed: true }));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: req.url } }));
  });
  await new Promise(resolve => stub.listen(0, '127.0.0.1', resolve));
  const stubUrl = `http://127.0.0.1:${stub.address().port}`;

  const savedEnv = { ...process.env };
  delete process.env.KB_MODULES_REGISTER;
  delete process.env.AI_CODING_EVENT_BRIDGE_HOME;
  delete process.env.KB_EVENTBRIDGE_COMMAND;

  try {
    const bridge = new ModuleBridge({
      terminalUrl: DEAD_URL,
      vectorHubUrl: DEAD_URL,
      eventBridgeUrl: stubUrl,
      registryStore: { listIds: () => ['demo-proj'] },
      projectStore: makeStoreStub(),
    });

    // ---- proxy mapping: /api/eventbridge/<rest> -> <console>/api/<rest> ----
    assert.strictEqual(bridge._eventBridgeApi('/api/eventbridge/projects'), `${stubUrl}/api/projects`, 'api prefix mapping');
    const pres = fakeRes();
    await bridge.proxyEventBridge(fakeReq(), pres, '/api/eventbridge/echo', '?x=1');
    assert.strictEqual(pres.statusCode, 200, 'proxy reaches the console');
    assert.deepStrictEqual(JSON.parse(pres.body).query, { x: '1' }, 'proxy forwards query string');

    // ---- registration: POST { path, store: <knowledge>/dev-conversations } ----
    const wiringStore = bridge.projectStore;
    const first = await bridge.registerProjectLinks({ projectId: 'demo-proj', name: 'demo', workspacePath: 'D:/work/demo', knowledgePath: 'D:/kb/demo' });
    assert.strictEqual(first.eventBridge.ok, true, 'event-bridge leg registers');
    assert.strictEqual(first.eventBridge.status, 'registered', 'first registration is not a reuse');
    assert.ok(first.eventBridge.projectId, 'registration returns the console project id');
    const postHits = hits.filter(h => h.startsWith('POST /api/projects'));
    assert.strictEqual(postHits.length, 1, 'exactly one POST issued');
    assert.ok(wiringStore.state.modules.eventBridge, 'wiring persisted');
    assert.ok(wiringStore.state.modules.eventBridge.store.endsWith('dev-conversations'), 'store follows the recommended layout');

    // ---- idempotent registration: same path is reused, no second POST ----
    const second = await bridge.registerProjectLinks({ projectId: 'demo-proj', name: 'demo', workspacePath: 'D:/work/demo', knowledgePath: 'D:/kb/demo' });
    assert.strictEqual(second.eventBridge.ok, true, 're-registration succeeds');
    assert.strictEqual(second.eventBridge.reused, true, 're-registration reuses by path');
    assert.strictEqual(hits.filter(h => h.startsWith('POST /api/projects')).length, 1, 'no duplicate POST on re-registration');

    // ---- aggregated projection ----
    const aggregate = await bridge.aggregatedProjects();
    assert.strictEqual(aggregate.eventBridgeAvailable, true, 'event-bridge available flag');
    const projected = aggregate.projects.find(p => p.projectId === 'demo-proj');
    assert.strictEqual(projected.modules.eventBridge.registered, true, 'sidebar projection marks event-bridge registered');
    assert.strictEqual(projected.modules.eventBridge.turns, 3, 'sidebar projection carries turn count');

    // ---- health ----
    const health = await bridge.modulesHealth();
    assert.strictEqual(health.modules.eventBridge.up, true, 'health reports event-bridge up');
    assert.strictEqual(health.modules.terminal.up, false, 'health keeps terminal leg honest');

    // ---- removal: DELETE ?id=..., wiring cleared ----
    const removal = await bridge.removeProjectLinks({ projectId: 'demo-proj' });
    assert.strictEqual(removal.eventBridge.ok, true, 'removal succeeds');
    assert.ok(hits.some(h => h.startsWith(`DELETE /api/projects?id=${encodeURIComponent(first.eventBridge.projectId)}`)), 'DELETE carries the console project id');
    assert.strictEqual(wiringStore.state.modules.eventBridge.status, 'removed', 'wiring marked removed');

    // ---- removal when the console no longer knows the project: 404 tolerated ----
    const removalAgain = await bridge.removeProjectLinks({ projectId: 'demo-proj' });
    assert.strictEqual(removalAgain.eventBridge.ok, true, '404 on removal counts as removed');

    // ---- supervised spawn spec ----
    const specs = bridge._supervisedSpecs();
    const ebSpec = specs.find(s => s.name === 'event-bridge');
    assert.ok(ebSpec, 'supervisor specs include event-bridge');
    assert.ok(ebSpec.command.includes('serve'), 'spec serves the console');
    assert.ok(ebSpec.command.includes('_modules'), 'spec spawns the vendored runtime');
    assert.ok(ebSpec.url === stubUrl, 'spec binds the configured URL');

    process.env.KB_EVENTBRIDGE_COMMAND = 'node C:/explicit/console-bin.js serve --port 9001';
    const overridden = bridge._supervisedSpecs().find(s => s.name === 'event-bridge');
    assert.ok(overridden.command.includes('C:/explicit/console-bin.js'), 'KB_EVENTBRIDGE_COMMAND override wins');

    process.env.AI_CODING_EVENT_BRIDGE_HOME = 'D:/bridge-home';
    delete process.env.KB_EVENTBRIDGE_COMMAND;
    const withHome = bridge._supervisedSpecs().find(s => s.name === 'event-bridge');
    assert.ok(withHome.command.includes('--home'), 'bridge home is passed through to the console');
    assert.ok(withHome.command.includes('D:\\bridge-home') || withHome.command.includes('D:/bridge-home'), 'bridge home path is quoted into the command line');

    // ---- KB_MODULES_REGISTER=0 keeps the fan-out off ----
    process.env.KB_MODULES_REGISTER = '0';
    const disabled = await bridge.registerProjectLinks({ projectId: 'demo-proj', name: 'demo', workspacePath: 'D:/work/demo', knowledgePath: 'D:/kb/demo' });
    assert.strictEqual(disabled.eventBridge.status, 'disabled', 'registration honors KB_MODULES_REGISTER=0');
  } finally {
    process.env = savedEnv;
    stub.close();
  }

  console.log('module-bridge-eventbridge-test PASS');
}

main().catch(error => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
