'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { StorageLayout } = require('../lib/storage-layout');
const { ModuleBridge } = require('../lib/module-bridge');
const { KnowledgeToolRuntime } = require('../lib/knowledge-tool-runtime');
const root = path.resolve('D:/knowledge storage 中文');
const layout = new StorageLayout({ dataDir: path.resolve('D:/metadata') });
assert.equal(layout.getVectorRootPath({ knowledge: { rootPath: root } }), path.join(root, '.indexes'));
assert.equal(layout.getVectorRootPath({ knowledge: { rootPath: '' } }), path.join(layout.getDataDir(), 'vectorhub'));
const settingsStore = { read: () => ({ knowledge: { rootPath: root }, brain: { id: 'brain-default', domains: [] } }) };
let knowledgeRoot = root;
const tools = new KnowledgeToolRuntime({
  layout,
  settingsStore: { read: () => ({ knowledge: { rootPath: knowledgeRoot } }) },
  registryStore: { listIds: () => ['project-storage'] },
  projectStore: {
    readConfig: () => ({ displayName: 'Storage', repoPath: path.join(root, 'repo'), knowledgePath: path.join(root, 'project') }),
    readState: () => ({ index: { generation: 3 } }),
  },
});
assert.equal(tools.resolveProject({ projectId: 'project-storage' }).indexPath, path.join(root, '.indexes'), 'MCP/CLI resolution must report the vector-hub location, not the retired shell database');
knowledgeRoot = path.join(root, 'changed root');
assert.equal(tools.resolveProject({ projectId: 'project-storage' }).indexPath, path.join(knowledgeRoot, '.indexes'), 'a running MCP process must reread the selected knowledge root');
knowledgeRoot = '';
assert.equal(tools.resolveProject({ projectId: 'project-storage' }).indexPath, path.join(layout.getDataDir(), 'vectorhub'));
const bridge = new ModuleBridge({ settingsStore, dataDir: layout.getDataDir() });
// The supervisor refuses to spawn the vendored vector-hub on Node < 22
// (module-bridge: "vector-hub declares engines >= 22"), so its supervised
// spec — and these env assertions — only exist on qualifying runtimes.
const vectorHubSpec = bridge._supervisedSpecs().find(spec => spec.name === 'vector-hub');
if (parseInt(process.versions.node, 10) >= 22) {
  assert.equal(vectorHubSpec.env.VECTOR_HUB_ROOT, path.join(root, '.indexes'));
  assert.equal(vectorHubSpec.env.VECTOR_HUB_CONFIG, path.join(layout.getDataDir(), 'vectorhub', 'config.json'));
} else {
  assert.equal(vectorHubSpec, undefined, 'vector-hub must not be supervised on Node < 22');
}
const calls = [];
bridge._fetch = async (url, init) => { const body = JSON.parse(init.body); calls.push({ url, body }); return { ok: true, json: async () => url.includes('/api/internal/runtime-config') ? { ok: true, rootPath: path.join(root, '.indexes') } : {} }; };
bridge.syncEngineConfiguration().then(async status => {
  assert.equal(calls.find(call => call.url.includes('/api/internal/runtime-config')).body.storageRoot, path.join(root, '.indexes'));
  assert.equal(status.indexStorage.status, 'ready');
  let currentRoot = root, release, started;
  const entered = new Promise(resolve => { started = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  const queued = new ModuleBridge({ dataDir: layout.getDataDir(), settingsStore: { read: () => ({ knowledge: { rootPath: currentRoot }, brain: { id: 'brain-default', domains: [] } }) } });
  const applied = [];
  queued._fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    if (url.endsWith('/api/internal/runtime-config')) {
      applied.push(body.storageRoot);
      if (applied.length === 1) { started(); await held; }
      return { ok: true, json: async () => ({ rootPath: body.storageRoot }) };
    }
    return { ok: true, json: async () => null };
  };
  const first = queued.syncEngineConfiguration(); await entered;
  currentRoot = path.join(root, 'new root');
  const second = queued.syncEngineConfiguration(); release();
  await first;
  const latest = await second;
  assert.deepEqual(applied, [path.join(root, '.indexes'), path.join(currentRoot, '.indexes')]);
  assert.equal(latest.indexStorage.actualPath, path.join(currentRoot, '.indexes'));
  assert.equal(latest.indexStorage.status, 'ready');
  const broken = new ModuleBridge({ dataDir: layout.getDataDir(), settingsStore: { read: () => { throw new Error('corrupt settings'); } } });
  let revoked;
  broken._fetch = async (url, init) => {
    if (url.endsWith('/api/internal/runtime-config')) revoked = JSON.parse(init.body);
    return { ok: false };
  };
  const unavailable = await broken.syncEngineConfiguration();
  assert.deepEqual(revoked, { settings: null });
  assert.equal(unavailable.indexStorage.status, 'pending');
  console.log('vector-storage-root-test PASS');
}).catch(error => { console.error(error); process.exitCode = 1; });
