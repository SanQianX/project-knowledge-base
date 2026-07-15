const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const lancedb = require('@lancedb/lancedb');
const { KnowledgeDatabase } = require('../lib/knowledge-db');
const { KnowledgeMaintenanceManager } = require('../lib/knowledge-maintenance');
const { EMBEDDING_DIMENSIONS } = require('../lib/knowledge-schema');

function vectorAt(index) {
  const vector = new Array(EMBEDDING_DIMENSIONS).fill(0);
  vector[index] = 1;
  return vector;
}

(async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-maintenance-test-'));
  const dbPath = path.join(temp, 'knowledge.lancedb');
  const db = new KnowledgeDatabase({ dbPath });
  const manager = new KnowledgeMaintenanceManager({ dataDir: temp, dbPath, database: db });
  try {
    await db.replaceEntry('project:api', 'modules/auth.md', [{
      chunkOrder: 0,
      title: 'Authentication',
      headingPath: ['Token lifecycle'],
      chunkText: 'Refresh tokens rotate after every successful authentication.',
      searchText: 'Authentication\nToken lifecycle\nRefresh tokens rotate after every successful authentication.',
      vector: vectorAt(2),
      sourceCommit: 'abc123',
    }]);
    await db.replaceEntry('project:api', 'modules/00-index.md', [{
      chunkOrder: 0,
      title: 'Generated index',
      chunkText: 'Tags: auth, api, generated, duplicated',
      vector: vectorAt(3),
    }]);

    // Reproduce the v4.0.0 full-text layout. The manager must never rebuild
    // this index in place because Lance versions can retain both generations.
    await db.open();
    await db.table.createIndex('search_text', {
      name: 'search_text_idx',
      config: lancedb.Index.fts({
        baseTokenizer: 'ngram',
        ngramMinLength: 2,
        ngramMaxLength: 4,
        withPosition: false,
        stem: false,
        removeStopWords: false,
      }),
      waitTimeoutSeconds: 60,
    });
    const legacy = await db.ensureSearchIndexes();
    assert.equal(legacy.ftsSchemaVersion, 1);
    assert.equal(legacy.ftsUpgradeRequired, true);
    assert.equal((await db.maybeOptimize({ force: true })).blockedBy, 'fts-upgrade-required');

    const before = await manager.inspect();
    assert.equal(before.rows, 2);
    assert.equal(before.ftsUpgradeRequired, true);
    assert.ok(before.indices.some(index => index.name === 'search_text_idx'));

    const rebuilt = await manager.rebuild({ keepBackup: true });
    assert.equal(rebuilt.status, 'completed');
    assert.equal(rebuilt.rows, 1);
    assert.equal(rebuilt.removedDerivedRows, 1);
    assert.equal(rebuilt.ftsSchemaVersion, 2);
    assert.equal(rebuilt.backupRetained, true);
    assert.ok(fs.existsSync(rebuilt.lastBackupPath));
    assert.equal(await db.count(), 1);
    assert.deepEqual(await db.entryIds('project:api'), ['modules/auth.md']);

    const compactRows = await db.allRows();
    assert.equal(compactRows[0].search_text, 'Authentication\nToken lifecycle');
    const compactIndices = await db.indexDetails();
    assert.ok(compactIndices.some(index => index.name === 'chunk_text_idx'));
    assert.ok(!compactIndices.some(index => index.name === 'search_text_idx'));
    assert.equal((await db.vectorSearch(vectorAt(2), { spaceIds: ['project:api'], limit: 1 })).length, 1);
    assert.equal((await db.fullTextSearch('authentication', { spaceIds: ['project:api'], limit: 5 })).length, 1);

    const rolledBack = await manager.rollbackBackup();
    assert.equal(rolledBack.status, 'rolled-back');
    assert.equal(await db.count(), 2);
    assert.ok((await db.entryIds('project:api')).includes('modules/00-index.md'));

    const rebuiltWithoutBackup = await manager.rebuild({ keepBackup: false });
    assert.equal(rebuiltWithoutBackup.status, 'completed');
    assert.equal(rebuiltWithoutBackup.backupRetained, false);
    assert.equal(rebuiltWithoutBackup.lastBackupPath, null);
    assert.equal(await db.count(), 1);
    assert.equal(db.maintenanceState().ftsSchemaVersion, 2);

    console.log('knowledge-maintenance-test: PASS');
  } finally {
    await db.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error);
  process.exit(1);
});
