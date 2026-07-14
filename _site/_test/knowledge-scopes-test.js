const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { KnowledgeScopeRegistry, defaultPrimarySpaceId } = require('../lib/knowledge-scope-registry');
const { spawnServer } = require('./helpers/spawn-server');

const ROOT = path.resolve(__dirname, '..', '..');
const PORT = 7926;

async function request(method, route, body) {
  const response = await fetch(`http://127.0.0.1:${PORT}${route}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`${response.status}: ${JSON.stringify(data)}`);
  return data;
}

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try { await request('GET', '/api/projects'); return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('server did not start');
}

(async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-scopes-unit-'));
  try {
    const filePath = path.join(temp, 'knowledge-scopes.json');
    const service = new KnowledgeScopeRegistry({ filePath });
    const projects = {
      api: { displayName: 'API', enabled: true },
      web: { displayName: 'Web', enabled: true },
      mobile: { displayName: 'Mobile', enabled: true },
      teamA: { displayName: 'Team A', enabled: true, knowledgeMode: 'team', kbStoreId: 'store-1', kbId: 'shared-api' },
      teamB: { displayName: 'Team B', enabled: true, knowledgeMode: 'team', kbStoreId: 'store-1', kbId: 'shared-api' },
    };
    let registry = service.synchronizeProjects(projects);
    assert.equal(registry.projectBindings.api.primarySpaceId, 'project:api');
    assert.equal(defaultPrimarySpaceId('teamA', projects.teamA), defaultPrimarySpaceId('teamB', projects.teamB));
    registry = service.setProjectRelations(projects, 'api', ['web'], { bidirectional: true });
    assert.deepEqual(registry.projectBindings.api.relatedProjectSlugs, ['web']);
    assert.deepEqual(registry.projectBindings.web.relatedProjectSlugs, ['api']);
    assert.deepEqual(registry.projectBindings.mobile.relatedProjectSlugs, []);
    const scope = service.resolveProjectScope(projects, 'api');
    assert.deepEqual(scope.spaces.map(item => item.spaceId), ['project:api', 'project:web']);
    assert.equal(scope.transitive, false);

    const runtime = spawnServer({ root: ROOT, port: PORT, tag: 'knowledge-scopes' });
    try {
      fs.writeFileSync(path.join(runtime.dataDir, 'projects.json'), JSON.stringify({
        api: { displayName: 'API', localPath: temp, gitPath: temp, enabled: true },
        web: { displayName: 'Web', localPath: temp, gitPath: temp, enabled: true },
        docs: { displayName: 'Docs', localPath: temp, gitPath: temp, enabled: true },
      }, null, 2));
      await waitForServer();
      const initial = await request('GET', '/api/knowledge/scopes');
      assert.equal(initial.resolved.api.spaces.length, 1);
      const saved = await request('PUT', '/api/projects/api/knowledge-relations', { relatedProjectSlugs: ['web'], bidirectional: true });
      assert.deepEqual(saved.binding.relatedProjectSlugs, ['web']);
      const after = await request('GET', '/api/knowledge/scopes');
      assert.deepEqual(after.projectBindings.web.relatedProjectSlugs, ['api']);
      assert.equal(after.resolved.api.spaces.length, 2);
      assert.equal(after.resolved.docs.spaces.length, 1);
    } finally {
      runtime.cleanup();
    }
    console.log('knowledge-scopes-test: PASS');
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error);
  process.exit(1);
});
