'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { applyDriverIsolation } = require('./helpers/parallel-qa-engine-endpoint-isolate');
const { guardedCreateEngineServer, createEngineVectorStandin, createEngineBridgeDouble } = require('./helpers/parallel-qa-engine-endpoint-guard');

(async () => {
  const applied = applyDriverIsolation({ prefix: 'pk-qa-shared-scope' });
  // Product modules load only after the driver environment is isolated.
  const { SettingsStore } = require('../lib/settings-store');
  const { ModuleBridge } = require('../lib/module-bridge');
  const root = fs.mkdtempSync(path.join(applied.layout.temp, 'kb-shared-bindings-'));
  const oldRoot = path.join(root, '原知识根目录'), newRoot = path.join(root, '新知识根目录');
  const settings = new SettingsStore({ dataDir: path.join(root, 'shell') });
  await settings.initialize({ knowledge: { rootPath: oldRoot } });
  await settings.addDomain({ id: 'domain-tools', name: '开发工具' });
  // OWN vector stand-in and bridge double exist BEFORE any engine construction:
  // the coordinator ignores env and falls back to LIVE 8787/8790 otherwise.
  const vectorStandin = createEngineVectorStandin();
  await vectorStandin.ready;
  const bridgeDouble = createEngineBridgeDouble();
  let engine;
  async function start() {
    engine = guardedCreateEngineServer({ dataDir: path.join(root, 'engine'), consume: false, runtimeToken: 'scope-binding-test', vectorUrl: vectorStandin.url, bridge: bridgeDouble });
    await engine.ready;
    await new Promise(resolve => engine.server.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${engine.server.address().port}`;
  }
  const logs = [];
  const bridge = new ModuleBridge({ settingsStore: settings, runtimeToken: 'scope-binding-test', logger: { warn: (...args) => logs.push(args) } });
  const upstream = bridge._fetch.bind(bridge);
  bridge._fetch = (url, init) => url.startsWith(bridge.engineUrl) ? upstream(url, init) : Promise.resolve({ ok: false });
  try {
    bridge.engineUrl = await start();
    assert.equal((await bridge.syncEngineConfiguration()).scopes, true);
    const scopes = structuredClone(engine.store.state.sharedScopes);
    const brain = scopes.find(scope => scope.kind === 'brain');
    const domain = scopes.find(scope => scope.kind === 'domain');
    engine.store.addProject({ projectId: 'project-test', repoPath: path.join(root, 'code'), knowledgePath: path.join(root, 'project-knowledge'), domainId: domain.id });
    const group = await engine.coordinator.memoryGroups.create({ name: '共享目录绑定测试', brainId: brain.id });
    await engine.coordinator.memoryGroups.setProjectBindings(group.id, { addProjectIds: ['project-test'] });
    const memory = await engine.coordinator.memories.create({ text: '保持目录绑定稳定', brainId: brain.id, groupId: group.id });
    const entryId = engine.coordinator.memories.entryFor(memory, engine.store.getProject('project-test'));
    fs.writeFileSync(path.join(domain.knowledgePath, 'README.md'), '# 领域经验\n\n领域知识不能随根目录设置隐式移动。\n');
    const memoryFile = engine.coordinator.memories.file(brain, entryId);
    const before = fs.readFileSync(memoryFile);
    await settings.updatePatch({ knowledge: { rootPath: newRoot } });
    assert.equal((await bridge.syncEngineConfiguration()).scopes, true, 'changing index root must not invalidate shared memory wiring');
    assert.deepEqual(engine.store.state.sharedScopes.map(scope => scope.knowledgePath), scopes.map(scope => scope.knowledgePath));
    assert.deepEqual(fs.readFileSync(memoryFile), before);
    assert.equal(settings.read().brain.knowledgePath, brain.knowledgePath);
    assert.equal(settings.read().brain.domains[0].knowledgePath, domain.knowledgePath);
    await assert.rejects(settings.updatePatch({ brain: { knowledgePath: newRoot } }), { code: 'INVALID_ARGUMENT' });
    await assert.rejects(settings.bindSharedKnowledgePaths([{ ...brain, knowledgePath: newRoot }]), { code: 'IMMUTABLE_FIELD' });
    await settings.addDomain({ id: 'domain-new', name: '新领域' });
    assert.equal((await bridge.syncEngineConfiguration()).scopes, true);
    assert.equal(engine.store.state.sharedScopes.find(scope => scope.id === 'domain-new').knowledgePath, path.join(newRoot, '_shared', 'domain-new'));
    await engine.close();
    bridge.engineUrl = await start();
    assert.equal((await bridge.syncEngineConfiguration()).scopes, true);
    assert.deepEqual(fs.readFileSync(memoryFile), before);
    const found = await engine.coordinator.retrieval.get({ projectId: 'project-test', spaceId: 'brain:brain-default', entryId });
    assert.ok(found.chunks.some(chunk => chunk.chunk_text.includes('保持目录绑定稳定')));
    const shared = await engine.coordinator.retrieval.get({ projectId: 'project-test', spaceId: 'domain:domain-tools', entryId: 'README.md' });
    assert.ok(shared.chunks.some(chunk => chunk.chunk_text.includes('不能随根目录设置隐式移动')));
    await engine.close(); engine = null;
    const pending = await bridge.syncEngineConfiguration();
    assert.equal(pending.scopes, false);
    assert.equal(pending.scopeStatus.status, 'pending');
    assert.ok(logs.some(entry => entry[0] === 'modules.scopes.pending'));
    assert.equal(settings.read().brain.knowledgePath, brain.knowledgePath);
    console.log('shared-scope-root-binding-test PASS');
  } finally { if (engine) await engine.close(); await vectorStandin.close().catch(() => {}); }
})().catch(error => { console.error(error); process.exitCode = 1; });
