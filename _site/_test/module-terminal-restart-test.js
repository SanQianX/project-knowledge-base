'use strict';
const assert = require('node:assert/strict');
const { ModuleBridge } = require('../lib/module-bridge');

async function main() {
  const state = { modules: { terminal: { projectId: 'terminal-original' } } };
  const config = { repoPath: process.cwd(), knowledgePath: process.cwd(), displayName: 'Restart' };
  const projects = ['terminal-original', 'terminal-duplicate'].map(id => ({ id, rootPath: config.repoPath }));
  let listFailure = 'status';
  let creations = 0;
  const bridge = new ModuleBridge({
    terminalUrl: 'http://terminal.test', vectorHubUrl: 'http://vector.test',
    eventBridgeUrl: 'http://event.test', engineUrl: 'http://engine.test',
    registryStore: { listIds: () => ['project-restart'], readDisplaySnapshot: () => ({}) },
    projectStore: { readConfig: () => config, readState: () => state, updateState: async (_id, apply) => apply(state) },
  });
  bridge.modulesHealth = async () => ({ modules: Object.fromEntries(['terminal', 'vectorHub', 'eventBridge', 'engine'].map(key => [key, { up: true }])) });
  bridge._fetch = async (url, options = {}) => {
    if (url === 'http://terminal.test/api/claude-workbench/v1/projects') {
      if (options.method === 'POST') { creations += 1; return { ok: true, status: 201, json: async () => ({ id: 'unexpected-new' }) }; }
      if (listFailure === 'network') throw new Error('service starting');
      if (listFailure === 'status') return { ok: false, status: 503 };
      return { ok: true, json: async () => listFailure === 'payload' ? {} : { projects } };
    }
    return { ok: true, status: 200, json: async () => ({ projects: [], project: { id: 'journal-restart' }, sequence: 0 }) };
  };
  const input = { projectId: 'project-restart', name: config.displayName, workspacePath: config.repoPath, knowledgePath: config.knowledgePath };
  for (const failure of ['status', 'network', 'payload']) {
    listFailure = failure;
    const result = await bridge.registerProjectLinks(input);
    assert.equal(result.terminal.status, 'pending', `${failure} is not an empty registry`);
    assert.equal(creations, 0, 'a failed registry read must never create a workspace');
    assert.equal(state.modules.terminal.projectId, 'terminal-original', 'retain the last known binding');
  }
  listFailure = null;
  const recovered = await bridge.registerProjectLinks(input);
  assert.equal(recovered.terminal.projectId, 'terminal-original');
  assert.equal(recovered.terminal.reused, true);
  const projection = await bridge.aggregatedProjects();
  assert.equal(projection.projects[0].modules.terminal.projectId, 'terminal-original', 'saved binding wins over duplicate path entries');
  assert.equal(creations, 0);
  console.log('module-terminal-restart-test PASS');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
