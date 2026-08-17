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
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-scopes-v2-'));
  const layout = new StorageLayout({ dataDir: path.join(temp, 'data') });
  const settings = new SettingsStore({ layout });
  const registry = new ProjectRegistryStore({ layout });
  const projects = new ProjectStore({ layout });
  await settings.initialize({ knowledge: { rootPath: path.join(temp, 'knowledge') } });
  await registry.initialize();
  for (const projectId of ['project-api', 'project-web', 'project-transitive']) {
    const knowledgePath = path.join(temp, 'knowledge', projectId);
    fs.mkdirSync(knowledgePath, { recursive: true });
    await projects.create(projectId, {
      displayName: projectId, storageName: projectId, repoPath: path.join(temp, projectId), knowledgePath,
      relatedProjectIds: projectId === 'project-api' ? ['project-web'] : projectId === 'project-web' ? ['project-transitive'] : [],
    });
    await registry.add(projectId, { displayNameSnapshot: projectId });
  }
  const runtime = new KnowledgeToolRuntime({ layout, settingsStore: settings, registryStore: registry, projectStore: projects });
  const project = runtime.resolveProject({ projectId: 'project-api' });
  const scopes = runtime.scopes(project);
  assert.deepStrictEqual(scopes.map(scope => scope.spaceId), ['project:project-api', 'project:project-web']);
  assert(!scopes.some(scope => scope.projectId === 'project-transitive'), 'related scopes must remain non-transitive');
  assert.strictEqual(scopes[0].weight, 1);
  assert.strictEqual(scopes[1].weight, 0.88);
  assert(!fs.existsSync(path.join(layout.getDataDir(), 'knowledge-scopes.json')), 'scope resolution must derive from immutable project config without side effects');
  console.log('knowledge-scopes-test PASS');
})().catch(error => { console.error(error); process.exitCode = 1; });
