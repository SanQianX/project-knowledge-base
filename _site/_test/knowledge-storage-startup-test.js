const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { KnowledgeDatabase } = require('../lib/knowledge-db');
const { EMBEDDING_DIMENSIONS } = require('../lib/knowledge-schema');
const { spawnServer } = require('./helpers/spawn-server');

const ROOT = path.resolve(__dirname, '..', '..');
const PORT = 7931;

function vectorAt(index) {
  const vector = new Array(EMBEDDING_DIMENSIONS).fill(0);
  vector[index] = 1;
  return vector;
}

async function request(route) {
  const response = await fetch(`http://127.0.0.1:${PORT}${route}`);
  const body = await response.json();
  if (!response.ok) throw new Error(`${response.status}: ${JSON.stringify(body)}`);
  return body;
}

async function waitForServer() {
  for (let i = 0; i < 80; i++) {
    try { return await request('/api/knowledge-store/config'); } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('server did not start');
}

(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-storage-startup-test-'));
  const configuredRoot = path.join(dataDir, 'selected-knowledge-root');
  const legacyDbPath = path.join(dataDir, 'knowledge.lancedb');
  const desiredDbPath = path.join(configuredRoot, '.project-knowledge', 'knowledge.lancedb');
  const legacy = new KnowledgeDatabase({ dbPath: legacyDbPath });
  let runtime = null;
  try {
    fs.writeFileSync(path.join(dataDir, 'projects.json'), '{}\n', 'utf8');
    fs.writeFileSync(path.join(dataDir, 'knowledge-store.json'), JSON.stringify({
      schema: 'knowledge-store/v1',
      rootPath: configuredRoot,
      configured: true,
      git: { enabled: false, remoteUrl: '', branch: 'main', autoCommit: false, autoPush: false },
    }, null, 2), 'utf8');
    await legacy.replaceEntry('project:legacy', 'GOAL.md', [{
      chunkOrder: 0,
      title: 'Legacy knowledge',
      chunkText: 'This row must survive automatic storage relocation.',
      vector: vectorAt(4),
    }]);
    await legacy.ensureSearchIndexes();
    await legacy.close();

    runtime = spawnServer({ root: ROOT, port: PORT, dataDir, tag: 'knowledge-storage-startup', extraEnv: { KB_EMBEDDING_FAKE: '1' } });
    const config = await waitForServer();
    assert.equal(config.storage.databasePath, desiredDbPath);
    assert.equal(config.storage.followsConfiguredRoot, true);
    assert.ok(fs.existsSync(desiredDbPath));
    assert.ok(!fs.existsSync(legacyDbPath));
    const maintenance = await request('/api/knowledge/maintenance');
    assert.equal(maintenance.dbPath, desiredDbPath);
    assert.equal(maintenance.rows, 1);

    console.log('knowledge-storage-startup-test: PASS');
  } finally {
    await legacy.close().catch(() => {});
    if (runtime?.child && runtime.child.exitCode === null) {
      const exited = new Promise(resolve => runtime.child.once('exit', resolve));
      runtime.child.kill();
      await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 3000))]);
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error);
  process.exit(1);
});
