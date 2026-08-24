const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { StorageLayout } = require('../lib/storage-layout');
const { MigrationService } = require('../lib/migration-service');

function fixture() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-p0-migration-'));
  fs.writeFileSync(path.join(dataDir, 'projects.json'), JSON.stringify({ old: { repoPath: 'C:/legacy', kbPath: 'C:/knowledge/old' } }));
  fs.writeFileSync(path.join(dataDir, 'knowledge-store.json'), JSON.stringify({ rootPath: 'C:/knowledge' }));
  fs.writeFileSync(path.join(dataDir, 'ai-profiles.json'), JSON.stringify({ profiles: [{ id: 'p', apiKey: 'test-secret' }] }));
  fs.writeFileSync(path.join(dataDir, 'embedding-config.json'), JSON.stringify({ modelId: 'legacy-model', localModelPath: 'C:/models', localFilesOnly: true }));
  fs.mkdirSync(path.join(dataDir, 'models', 'nested'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'models', 'nested', 'model.onnx'), 'model-fixture');
  return dataDir;
}

(async () => {
  const dataDir = fixture();
  try {
    const layout = new StorageLayout({ dataDir });
    const migration = new MigrationService({ layout, legacyDataDir: dataDir });
    const result = await migration.migrateIfNeeded({ migrationRunId: 'p0-characterization' });
    assert.equal(result.ok, true);
    assert.equal(result.marker.schema, 'layout-migration-completion/v2');
    assert.equal(result.marker.projectCount, 1);
    assert.equal(result.marker.aiProfileCount, 1);
    assert.equal(result.marker.knowledgeRootConfigured, true);
    assert.equal(result.marker.embeddingConfigured, true);
    assert.equal(fs.readFileSync(path.join(dataDir, 'cache', 'models', 'nested', 'model.onnx'), 'utf8'), 'model-fixture');
    const settings = JSON.parse(fs.readFileSync(layout.getSettingsPath(), 'utf8'));
    assert.equal(settings.embedding.modelId, 'legacy-model');
    assert.equal(settings.ai.profiles.length, 1);
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
  console.log('p0-data-migration-characterization-test PASS');
})().catch(error => { console.error(error.stack || error.message); process.exit(1); });
