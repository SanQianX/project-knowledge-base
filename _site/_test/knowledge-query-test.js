const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { StorageLayout } = require('../lib/storage-layout');
const { SettingsStore } = require('../lib/settings-store');
const { ProjectRegistryStore } = require('../lib/project-registry-store');
const { ProjectStore } = require('../lib/project-store');
const { KnowledgeToolRuntime } = require('../lib/knowledge-tool-runtime');

(async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-query-v2-'));
  const layout = new StorageLayout({ dataDir: path.join(temp, 'data') });
  const settings = new SettingsStore({ layout });
  const registry = new ProjectRegistryStore({ layout });
  const projects = new ProjectStore({ layout });
  await settings.initialize({ knowledge: { rootPath: path.join(temp, 'knowledge') } });
  await registry.initialize();
  const fixtures = [
    ['project-api', 'API', 'API refresh tokens rotate after authentication.'],
    ['project-web', 'Web', 'Web login keeps a short-lived browser session.'],
    ['project-secret', 'Secret', 'This unrelated project must stay out of scope.'],
  ];
  for (const [projectId, title, content] of fixtures) {
    const knowledgePath = path.join(temp, 'knowledge', projectId);
    fs.mkdirSync(path.join(knowledgePath, 'changes'), { recursive: true });
    fs.writeFileSync(path.join(knowledgePath, 'changes', 'decision.md'), `# ${title}\n\n${content}\n`, 'utf8');
    await projects.create(projectId, {
      displayName: title, storageName: projectId, repoPath: temp, knowledgePath,
      relatedProjectIds: projectId === 'project-api' ? ['project-web'] : [],
    }, { index: { dirty: true, generation: 1 } });
    await registry.add(projectId, { displayNameSnapshot: title });
  }
  const runtime = new KnowledgeToolRuntime({ layout, settingsStore: settings, registryStore: registry, projectStore: projects });
  try {
    const search = await runtime.search({ projectId: 'project-api', query: 'login session tokens', limit: 10 });
    assert.strictEqual(search.source, 'knowledge-retrieval-service');
    assert.strictEqual(search.backend, 'markdown-hybrid-fallback');
    assert(search.results.some(row => row.scope_project_id === 'project-api'));
    assert(search.results.some(row => row.scope_project_id === 'project-web'));
    assert(search.results.every(row => row.scope_project_id !== 'project-secret'));
    const asked = await runtime.ask({ projectId: 'project-api', query: 'refresh tokens', limit: 5 });
    assert(asked.citations.length > 0 && /refresh tokens/i.test(asked.answer));
    const entry = await runtime.get({ projectId: 'project-api', entryId: 'changes/decision.md' });
    assert.match(entry.chunks[0].chunk_text, /rotate after authentication/);
    await assert.rejects(runtime.get({ projectId: 'project-api', entryId: '../project-secret/changes/decision.md' }), error => error.code === 'PATH_OUTSIDE_ROOT');
    const history = await runtime.history({ projectId: 'project-api' });
    assert.strictEqual(history.results[0].entry_id, 'changes/decision.md');
    assert.strictEqual(fs.existsSync(path.join(layout.getDataDir(), 'knowledge-scopes.json')), false, 'read queries must not create a second scope registry');
    console.log('knowledge-query-test: PASS');
  } finally {
    await runtime.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
