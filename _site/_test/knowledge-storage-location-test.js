const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { StorageLayout } = require('../lib/storage-layout');
const { SettingsStore } = require('../lib/settings-store');

(async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-storage-location-v2-'));
  const dataDir = path.join(temp, 'data');
  const rootA = path.join(temp, 'knowledge-a');
  const rootB = path.join(temp, 'knowledge-b');
  const layout = new StorageLayout({ dataDir });
  const settings = new SettingsStore({ layout });
  await settings.initialize({ knowledge: { rootPath: rootA } });
  const indexPath = layout.getIndexPath();
  fs.mkdirSync(indexPath, { recursive: true });
  fs.writeFileSync(path.join(indexPath, 'sentinel'), 'derived-index', 'utf8');
  await settings.updatePatch({ knowledge: { rootPath: rootB } });
  assert.strictEqual(layout.getIndexPath(), indexPath, 'the internal index path must not follow the user knowledge root');
  assert.strictEqual(fs.readFileSync(path.join(indexPath, 'sentinel'), 'utf8'), 'derived-index');
  assert.strictEqual(layout.isPathInside(rootA, indexPath), false);
  assert.strictEqual(layout.isPathInside(rootB, indexPath), false);
  assert.strictEqual(layout.getKnowledgeRootPath(settings.read()), path.resolve(rootB));
  assert(!fs.existsSync(path.join(rootA, '.project-knowledge')));
  assert(!fs.existsSync(path.join(rootB, '.project-knowledge')));
  console.log('knowledge-storage-location-test: PASS');
})().catch(error => { console.error(error); process.exitCode = 1; });
