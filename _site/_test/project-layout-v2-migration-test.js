const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { StorageLayout } = require('../lib/storage-layout');
const { MigrationService } = require('../lib/migration-service');

function fixture() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-layout-v2-migration-'));
  const oldRoot = path.join(dataDir, 'old-knowledge');
  const differentRoot = path.join(dataDir, 'different-current-root');
  fs.mkdirSync(oldRoot, { recursive: true });
  const exactKbPath = path.join(oldRoot, 'legacy-a-fixed');
  fs.mkdirSync(exactKbPath, { recursive: true });
  fs.writeFileSync(path.join(exactKbPath, 'README.md'), '# existing knowledge\n', 'utf8');
  fs.writeFileSync(path.join(dataDir, 'projects.json'), JSON.stringify({
    legacyA: {
      displayName: 'Legacy A',
      localPath: path.join(dataDir, 'repo-a'),
      gitPath: path.join(dataDir, 'repo-a'),
      kbPath: exactKbPath,
      trackingStartCommit: 'track-a',
      lastAnalyzedCommit: 'last-a',
      enabled: true,
      aiProfileId: 'primary',
    },
    legacyB: {
      displayName: 'Legacy B',
      localPath: path.join(dataDir, 'repo-b'),
      trackingStartCommit: 'track-b',
      enabled: true,
    },
  }, null, 2));
  fs.writeFileSync(path.join(dataDir, 'knowledge-store.json'), JSON.stringify({ rootPath: differentRoot, configured: true }));
  fs.writeFileSync(path.join(dataDir, 'ai-profiles.json'), JSON.stringify({ schema: 'ai-profiles/v1', profiles: [{ id: 'primary', apiKey: 'exact-secret-value' }] }));
  fs.writeFileSync(path.join(dataDir, 'embedding-config.json'), JSON.stringify({ modelId: 'model-a' }));
  fs.writeFileSync(path.join(dataDir, 'logging.json'), JSON.stringify({ levels: ['debug', 'info', 'error'], retentionDays: 0, maxTotalSizeMB: 512 }));
  fs.writeFileSync(path.join(dataDir, 'claude-prompts.json'), JSON.stringify({ hookPromptTemplate: 'legacy override' }));
  fs.writeFileSync(path.join(dataDir, '.hook-trigger-errors.log'), '2026-01-01 old hook error\n');
  return { dataDir, exactKbPath, differentRoot };
}

(async () => {
  {
    const { dataDir, exactKbPath, differentRoot } = fixture();
    const layout = new StorageLayout({ dataDir });
    const migration = new MigrationService({ layout, legacyDataDir: dataDir });
    const result = await migration.migrateIfNeeded({ migrationRunId: 'layout-v2-success' });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.completed, true);
    assert(fs.existsSync(layout.getMigrationCompletionPath()));
    const registry = JSON.parse(fs.readFileSync(layout.getProjectRegistryPath(), 'utf8'));
    assert.strictEqual(registry.schema, 'project-registry/v2');
    assert.strictEqual(registry.projectOrder.length, 2);
    const idA = result.projectMap.legacyA;
    const idB = result.projectMap.legacyB;
    const configA = JSON.parse(fs.readFileSync(layout.getProjectConfigPath(idA), 'utf8'));
    const configB = JSON.parse(fs.readFileSync(layout.getProjectConfigPath(idB), 'utf8'));
    const stateA = JSON.parse(fs.readFileSync(layout.getProjectStatePath(idA), 'utf8'));
    assert.strictEqual(configA.knowledgePath, exactKbPath, 'old kbPath must remain exact');
    assert.strictEqual(configB.knowledgePath, path.join(differentRoot, 'legacyB'));
    assert.strictEqual(stateA.trackingStartCommit, 'track-a');
    assert.strictEqual(stateA.lastAnalyzedCommit, 'last-a');
    const settings = JSON.parse(fs.readFileSync(layout.getSettingsPath(), 'utf8'));
    assert.strictEqual(settings.ai.profiles[0].apiKey, 'exact-secret-value');
    assert.strictEqual(settings.logging.retentionDays, 0);
    assert(fs.existsSync(path.join(result.recoveryDir, 'backup', 'projects.json')));
    assert(fs.existsSync(path.join(dataDir, '.hook-trigger-errors.log')), 'legacy hook log must remain');
    const second = await migration.migrateIfNeeded();
    assert.strictEqual(second.completed, true);
    assert.strictEqual(second.migrated, false);
  }

  for (const stage of ['backup', 'staging', 'validation', 'activation', 'open-verification']) {
    const { dataDir } = fixture();
    const originalProjects = fs.readFileSync(path.join(dataDir, 'projects.json'), 'utf8');
    const layout = new StorageLayout({ dataDir });
    const migration = new MigrationService({ layout, legacyDataDir: dataDir });
    const result = await migration.migrateIfNeeded({ migrationRunId: `fault-${stage}`, faultAt: stage });
    assert.strictEqual(result.ok, false, `${stage} should fail`);
    assert.strictEqual(result.useLegacy, true);
    assert.strictEqual(fs.existsSync(layout.getMigrationCompletionPath()), false, `${stage} must not write completion`);
    assert.strictEqual(fs.readFileSync(path.join(dataDir, 'projects.json'), 'utf8'), originalProjects, `${stage} must preserve/restore legacy registry`);
    const journal = JSON.parse(fs.readFileSync(path.join(result.recoveryDir, 'journal.json'), 'utf8'));
    assert.strictEqual(journal.phase, 'failed');
    assert.strictEqual(journal.rollback.ok, true, `${stage} rollback must complete`);
    assert.strictEqual(fs.existsSync(layout.getSettingsPath()), false, `${stage} must remove newly activated settings`);
    assert.strictEqual(fs.existsSync(path.join(dataDir, 'projects')), false, `${stage} must remove newly activated project metadata`);
    if (['activation', 'open-verification'].includes(stage)) {
      const retry = await migration.migrateIfNeeded({ migrationRunId: `retry-${stage}` });
      assert.strictEqual(retry.ok, true, `${stage} must be safely retryable after rollback`);
      assert.strictEqual(retry.completed, true);
    }
  }

  {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-layout-v2-fresh-'));
    const layout = new StorageLayout({ dataDir });
    const result = await new MigrationService({ layout }).migrateIfNeeded();
    assert.strictEqual(result.reason, 'fresh-install');
    assert.strictEqual(fs.existsSync(layout.getRecoveryPath()), false, 'fresh install must not create optional recovery dir');
  }

  console.log('project-layout-v2-migration-test PASS');
})().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
