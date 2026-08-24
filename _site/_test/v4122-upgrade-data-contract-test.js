const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { StorageLayout } = require('../lib/storage-layout');
const { MigrationService } = require('../lib/migration-service');
const { publicAiProfilesConfig } = require('../lib/contracts');

function fixture() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-v4122-upgrade-'));
  const knowledgeRoot = path.join(dataDir, 'knowledge-root');
  const projects = {};
  for (const slug of ['alpha', 'beta', 'gamma']) {
    const repoPath = path.join(dataDir, 'repos', slug);
    const knowledgePath = path.join(knowledgeRoot, `preserved-${slug}`);
    fs.mkdirSync(knowledgePath, { recursive: true });
    fs.writeFileSync(path.join(knowledgePath, 'README.md'), `# ${slug}\n`);
    projects[slug] = { repoPath, kbPath: knowledgePath, aiProfileId: slug === 'alpha' ? 'primary' : 'secondary' };
  }
  fs.writeFileSync(path.join(dataDir, 'projects.json'), JSON.stringify(projects));
  fs.writeFileSync(path.join(dataDir, 'knowledge-store.json'), JSON.stringify({ rootPath: knowledgeRoot }));
  fs.writeFileSync(path.join(dataDir, 'ai-profiles.json'), JSON.stringify({ profiles: [
    { id: 'primary', apiKey: 'fixture-secret-one', model: 'model-a' },
    { id: 'secondary', apiKey: 'fixture-secret-two', model: 'model-b' },
  ] }));
  fs.writeFileSync(path.join(dataDir, 'embedding-config.json'), JSON.stringify({ modelId: 'embedding-v4122', localFilesOnly: true, localModelPath: path.join(dataDir, 'models') }));
  fs.mkdirSync(path.join(dataDir, 'models', 'A', 'B'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'models', 'A', 'B', 'model.onnx'), 'exact-model-content');
  return { dataDir, knowledgeRoot, projects };
}

(async () => {
  const { dataDir, knowledgeRoot, projects } = fixture();
  try {
    const layout = new StorageLayout({ dataDir });
    const result = await new MigrationService({ layout, legacyDataDir: dataDir }).migrateIfNeeded({ migrationRunId: 'v4122-contract' });
    assert.equal(result.ok, true);
    const registry = JSON.parse(fs.readFileSync(layout.getProjectRegistryPath(), 'utf8'));
    assert.equal(registry.projectOrder.length, 3);
    const settings = JSON.parse(fs.readFileSync(layout.getSettingsPath(), 'utf8'));
    assert.equal(settings.knowledge.rootPath, knowledgeRoot);
    assert.deepEqual(settings.embedding, { modelId: 'embedding-v4122', localFilesOnly: true, localModelPath: path.join(dataDir, 'models') });
    assert.equal(settings.ai.profiles.length, 2);
    assert.equal(publicAiProfilesConfig(settings.ai).profiles.every(profile => profile.hasApiKey && !Object.hasOwn(profile, 'apiKey')), true);
    for (const projectId of registry.projectOrder) {
      const config = JSON.parse(fs.readFileSync(layout.getProjectConfigPath(projectId), 'utf8'));
      const legacy = projects[config.legacyExtensions.slug];
      assert.equal(config.repoPath, legacy.repoPath);
      assert.equal(config.knowledgePath, legacy.kbPath);
    }
    assert.equal(fs.readFileSync(path.join(dataDir, 'cache', 'models', 'A', 'B', 'model.onnx'), 'utf8'), 'exact-model-content');
    assert.equal(result.marker.projectCount, 3);
    assert.equal(result.marker.aiProfileCount, 2);
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
  console.log('v4122-upgrade-data-contract-test PASS');
})().catch(error => { console.error(error.stack || error.message); process.exit(1); });
