const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { StorageLayout } = require('../lib/storage-layout');
const { SettingsStore } = require('../lib/settings-store');
const { KnowledgeDatabase } = require('../lib/knowledge-db');
const { EMBEDDING_DIMENSIONS } = require('../lib/knowledge-schema');
const { spawnServer } = require('./helpers/spawn-server');

const ROOT = path.resolve(__dirname, '..', '..');
const PORT = 7931;
const BASE_URL = `http://127.0.0.1:${PORT}`;

async function get(route) {
  const response = await fetch(`${BASE_URL}${route}`);
  return { response, body: await response.json() };
}

(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-storage-startup-v2-'));
  const layout = new StorageLayout({ dataDir });
  const configuredRoot = path.join(dataDir, 'selected-knowledge-root');
  const settings = new SettingsStore({ layout });
  await settings.initialize({ knowledge: { rootPath: configuredRoot } });
  const internalIndex = layout.getIndexPath();
  const database = new KnowledgeDatabase({ dbPath: internalIndex });
  const vector = new Array(EMBEDDING_DIMENSIONS).fill(0);
  vector[4] = 1;
  await database.replaceEntry('project:legacy', 'GOAL.md', [{ chunkOrder: 0, title: 'Legacy', chunkText: 'Fixed internal derived row.', vector }]);
  await database.close();
  const spawned = spawnServer({ root: ROOT, port: PORT, dataDir, tag: 'knowledge-storage-startup', extraEnv: { KB_EMBEDDING_FAKE: '1' } });
  try {
    let health;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try { health = await get('/api/health'); if (health.response.ok) break; } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert(health && health.response.ok, 'server did not start');
    const publicSettings = await get('/api/settings');
    assert.strictEqual(publicSettings.body.settings.knowledge.rootPath, path.resolve(configuredRoot));
    const maintenance = await get('/api/knowledge/maintenance');
    assert.strictEqual(maintenance.body.indexPath, internalIndex);
    assert(fs.existsSync(internalIndex), 'the derived index must remain under the internal data directory');
    assert(!fs.existsSync(path.join(configuredRoot, '.project-knowledge')), 'the user knowledge root must not receive internal runtime data');
    console.log('knowledge-storage-startup-test: PASS');
  } finally {
    spawned.child.kill();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
