const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  configuredLayout,
  legacyLayout,
  relocateLayout,
  resolveActiveLayout,
  publicStorageInfo,
  rebaseMaintenanceState,
  manifest,
} = require('../lib/knowledge-storage-location');

function write(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value, 'utf8');
}

(() => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-storage-location-test-'));
  try {
    const dataDir = path.join(temp, 'data');
    const rootA = path.join(temp, 'store-a');
    const rootB = path.join(temp, 'store-b');
    const legacy = legacyLayout(dataDir);
    const layoutA = configuredLayout(rootA);
    const layoutB = configuredLayout(rootB);

    write(path.join(legacy.dbPath, 'knowledge_chunks.lance', 'data', 'part.lance'), 'database-content');
    write(legacy.databaseMaintenancePath, '{"ftsSchemaVersion":1}\n');
    const oldBackup = path.join(legacy.backupRoot, 'old.lancedb');
    write(legacy.maintenanceStatePath, `${JSON.stringify({ status: 'completed', lastBackupPath: oldBackup })}\n`);
    write(path.join(oldBackup, 'part.lance'), 'backup-content');
    const legacyManifest = manifest(legacy.dbPath);

    assert.equal(resolveActiveLayout(rootA, dataDir).kind, 'legacy-data-dir');
    const first = relocateLayout(legacy, layoutA);
    const firstRebase = rebaseMaintenanceState(legacy, layoutA);
    assert.equal(first.moved, true);
    assert.deepEqual(manifest(layoutA.dbPath), legacyManifest);
    assert.ok(fs.existsSync(layoutA.databaseMaintenancePath));
    assert.ok(fs.existsSync(layoutA.maintenanceStatePath));
    assert.ok(fs.existsSync(path.join(layoutA.backupRoot, 'old.lancedb', 'part.lance')));
    assert.equal(firstRebase.lastBackupPath, path.join(layoutA.backupRoot, 'old.lancedb'));
    assert.equal(JSON.parse(fs.readFileSync(layoutA.maintenanceStatePath, 'utf8')).lastBackupPath, path.join(layoutA.backupRoot, 'old.lancedb'));
    assert.ok(!fs.existsSync(legacy.dbPath));
    assert.equal(resolveActiveLayout(rootA, dataDir).dbPath, layoutA.dbPath);
    assert.equal(publicStorageInfo(layoutA, rootA).followsConfiguredRoot, true);

    const second = relocateLayout(layoutA, layoutB);
    assert.equal(second.moved, true);
    assert.deepEqual(manifest(layoutB.dbPath), legacyManifest);
    assert.ok(!fs.existsSync(layoutA.dbPath));

    write(path.join(layoutA.dbPath, 'collision.lance'), 'do-not-overwrite');
    assert.throws(() => relocateLayout(layoutB, layoutA), /already contains data/);
    assert.ok(fs.existsSync(path.join(layoutB.dbPath, 'knowledge_chunks.lance', 'data', 'part.lance')));
    assert.equal(fs.readFileSync(path.join(layoutA.dbPath, 'collision.lance'), 'utf8'), 'do-not-overwrite');

    console.log('knowledge-storage-location-test: PASS');
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
})();
