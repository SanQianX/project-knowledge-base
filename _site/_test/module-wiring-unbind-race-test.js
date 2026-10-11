'use strict';
const assert = require('node:assert/strict');
const http = require('node:http');
const { ModuleBridge } = require('../lib/module-bridge');

async function main() {
  let releaseRegister, registerStarted, registered = true;
  const started = new Promise(resolve => { registerStarted = resolve; });
  const gate = new Promise(resolve => { releaseRegister = resolve; });
  const engineProjects = new Set();
  const calls = [];
  const server = http.createServer(async (req, res) => {
    req.resume();
    if (req.method === 'POST' && req.url === '/engine/api/projects') {
      registerStarted(); await gate;
      engineProjects.add('project-race'); calls.push('register');
    }
    if (req.method === 'DELETE' && req.url === '/engine/api/projects/project-race') { engineProjects.delete('project-race'); calls.push('remove'); }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true, projects: [], id: 'terminal-race', project: { id: 'event-race' }, sequence: 0 }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const state = { modules: {} };
  const bridge = new ModuleBridge({ terminalUrl: base + '/terminal', vectorHubUrl: base + '/vector', eventBridgeUrl: base + '/event', engineUrl: base + '/engine', registryStore: { readDisplaySnapshot: () => registered ? { displayName: 'Race' } : null }, projectStore: { readState: () => state, readConfig: () => ({}), updateState: async (_id, apply) => { apply(state); } } });
  try {
    const input = { projectId: 'project-race', name: 'Race', workspacePath: process.cwd(), knowledgePath: process.cwd() };
    const wiring = bridge.registerProjectLinks(input);
    await started;
    const removing = bridge.removeProjectLinks({ projectId: 'project-race', onRemoved: async () => { registered = false; } }).then(() => { registered = false; });
    // A delayed supervisor registration must settle before removal, never after.
    await new Promise(resolve => setTimeout(resolve, 100)); releaseRegister();
    await Promise.all([wiring, removing]);
    assert.deepEqual([...engineProjects], [], 'delayed wiring must not resurrect a removed engine project');
    assert.deepEqual(calls, ['register', 'remove']);
    const before = calls.length;
    const stale = await bridge.registerProjectLinks(input);
    assert.equal(calls.length, before, 'a stale registry snapshot cannot register an absent project');
    assert.equal(stale.engine.status, 'removed');
    assert.equal(bridge.projectWiringQueue?.size || 0, 0, 'settled operations must not leak per-project queues');
    let releaseOther;
    const otherGate = new Promise(resolve => { releaseOther = resolve; });
    const order = [];
    const held = bridge._withProjectWiring('project-a', async () => { await otherGate; order.push('a'); });
    const independent = bridge._withProjectWiring('project-b', async () => { order.push('b'); });
    await independent; assert.deepEqual(order, ['b'], 'unrelated projects do not share a global wiring lock');
    releaseOther(); await held; assert.deepEqual(order, ['b', 'a']);
    // Failed deletion keeps its registry, then a retry can still repair/remove it.
    registered = true;
    await assert.rejects(bridge.removeProjectLinks({ projectId: 'project-race', onRemoved: async () => { throw new Error('controlled hook conflict'); } }), /controlled hook conflict/);
    assert.equal(registered, true);
    await bridge.registerProjectLinks(input);
    assert.ok(engineProjects.has('project-race'));
    await bridge.removeProjectLinks({ projectId: 'project-race', onRemoved: async () => { registered = false; } });
    assert.deepEqual([...engineProjects], []);
    console.log('module-wiring-unbind-race-test PASS');
  } finally { releaseRegister(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
