const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { StorageLayout } = require('../lib/storage-layout');
const { SettingsStore } = require('../lib/settings-store');
const { ProjectStore } = require('../lib/project-store');
const { MigrationService } = require('../lib/migration-service');
const { KnowledgeDatabase } = require('../lib/knowledge-db');
const { EMBEDDING_DIMENSIONS } = require('../lib/knowledge-schema');

(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-migration-v2-'));
  const oldKnowledgeRoot = path.join(dataDir, 'old-knowledge');
  const fixedKnowledgePath = path.join(oldKnowledgeRoot, 'api-fixed');
  const legacyIndex = path.join(dataDir, 'knowledge.lancedb');
  fs.mkdirSync(fixedKnowledgePath, { recursive: true });
  fs.writeFileSync(path.join(fixedKnowledgePath, 'GOAL.md'), '# API goal\n\nAuthoritative Markdown remains external.\n', 'utf8');
  fs.writeFileSync(path.join(dataDir, 'projects.json'), JSON.stringify({
    api: {
      displayName: 'API', localPath: dataDir, gitPath: dataDir, kbPath: fixedKnowledgePath,
      trackingStartCommit: 'track-before', lastAnalyzedCommit: 'commit-before', enabled: true,
    },
  }, null, 2));
  fs.writeFileSync(path.join(dataDir, 'knowledge-store.json'), JSON.stringify({ rootPath: oldKnowledgeRoot, configured: true }));
  fs.writeFileSync(path.join(dataDir, 'ai-profiles.json'), JSON.stringify({ schema: 'ai-profiles/v1', profiles: [{ id: 'primary', apiKey: 'migration-secret-value' }] }));
  fs.writeFileSync(path.join(dataDir, 'logging.json'), JSON.stringify({ levels: ['debug', 'info', 'error'], retentionDays: 0, maxTotalSizeMB: 128 }));
  fs.writeFileSync(path.join(dataDir, '.hook-trigger-errors.log'), '2026-01-01 legacy hook error\n', 'utf8');

  const vector = new Array(EMBEDDING_DIMENSIONS).fill(0);
  vector[9] = 1;
  const oldDatabase = new KnowledgeDatabase({ dbPath: legacyIndex });
  await oldDatabase.replaceEntry('project:api', 'GOAL.md', [{ chunkOrder: 0, title: 'Legacy index', chunkText: 'A migrated derived row.', vector }]);
  await oldDatabase.close();
  const oldIndexRows = await (async () => {
    const db = new KnowledgeDatabase({ dbPath: legacyIndex });
    try { return await db.count(); } finally { await db.close(); }
  })();

  const layout = new StorageLayout({ dataDir });
  const migration = new MigrationService({
    layout,
    legacyDataDir: dataDir,
    indexValidator: async candidate => {
      const db = new KnowledgeDatabase({ dbPath: candidate });
      try { await db.open(); return { ok: (await db.count()) === oldIndexRows }; }
      finally { await db.close(); }
    },
  });
  const result = await migration.migrateIfNeeded({ migrationRunId: 'knowledge-index-v2' });
  assert(result.ok && result.completed && result.migrated, JSON.stringify(result));
  const projectId = result.projectMap.api;
  const projectStore = new ProjectStore({ layout });
  const config = projectStore.readConfig(projectId);
  const state = projectStore.readState(projectId);
  assert.strictEqual(config.knowledgePath, fixedKnowledgePath, 'legacy kbPath must be preserved exactly');
  assert.strictEqual(state.trackingStartCommit, 'track-before');
  assert.strictEqual(state.lastAnalyzedCommit, 'commit-before');
  assert.strictEqual(new SettingsStore({ layout }).read().ai.profiles[0].apiKey, 'migration-secret-value');
  const migratedDatabase = new KnowledgeDatabase({ dbPath: layout.getIndexPath() });
  assert.strictEqual(await migratedDatabase.count(), 1, 'the validated legacy index should be copied to the one internal index path');
  await migratedDatabase.close();
  assert(fs.existsSync(legacyIndex), 'legacy index source must remain for rollback');
  assert(fs.existsSync(path.join(result.recoveryDir, 'backup', 'knowledge.lancedb')), 'recovery must retain an index backup');
  assert(fs.existsSync(path.join(dataDir, '.hook-trigger-errors.log')), 'legacy hook logs must remain at the source');
  assert(fs.existsSync(path.join(result.recoveryDir, 'backup', '.hook-trigger-errors.log')));

  const settings = new SettingsStore({ layout });
  await settings.updatePatch({ knowledge: { rootPath: path.join(dataDir, 'new-knowledge-root') } });
  assert.strictEqual(projectStore.readConfig(projectId).knowledgePath, fixedKnowledgePath, 'changing the global root must not move an imported project');
  assert.strictEqual(layout.getIndexPath(), path.join(dataDir, 'index', 'knowledge.lancedb'), 'global root changes must not move the derived index');
  const second = await migration.migrateIfNeeded();
  assert.strictEqual(second.migrated, false);
  console.log('knowledge-migration-test: PASS');
})().catch(error => { console.error(error); process.exitCode = 1; });
