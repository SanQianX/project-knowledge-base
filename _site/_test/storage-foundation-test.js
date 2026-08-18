const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { StorageLayout } = require('../lib/storage-layout');
const AtomicFile = require('../lib/atomic-file');
const { SettingsStore } = require('../lib/settings-store');

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-storage-foundation-'));
  const dataDir = path.join(root, 'data');
  const knowledgeRoot = path.join(root, 'knowledge');
  const layout = new StorageLayout({ dataDir, platform: 'win32' });

  assert.strictEqual(layout.pathsEqual('C:\\Work\\Repo', 'c:\\work\\repo\\'), true);
  const posixLayout = new StorageLayout({ dataDir, platform: 'linux' });
  assert.strictEqual(posixLayout.pathsEqual('/tmp/Repo', '/tmp/repo'), false);
  assert.strictEqual(layout.getIndexPath(), path.join(dataDir, 'index', 'knowledge.lancedb'));
  assert(!layout.getIndexPath().startsWith(knowledgeRoot));

  const rootResult = layout.validateKnowledgeRoot(knowledgeRoot);
  assert.strictEqual(rootResult.ok, true);
  assert.strictEqual(fs.readdirSync(knowledgeRoot).length, 0, 'write probe must not leave files');
  const projectKnowledge = layout.resolveNewProjectKnowledgePath('repo-a1b2c3', { knowledge: { rootPath: knowledgeRoot } });
  assert.strictEqual(projectKnowledge, path.join(knowledgeRoot, 'repo-a1b2c3'));
  assert.strictEqual(layout.getProjectKnowledgePath({ knowledgePath: projectKnowledge }), projectKnowledge);

  const atomicPath = path.join(dataDir, 'atomic.json');
  AtomicFile.writeJsonAtomic(atomicPath, { revision: 1 });
  assert.throws(() => AtomicFile.writeJsonAtomic(atomicPath, { revision: 2 }, {
    beforeRename() { throw new Error('injected-before-rename'); },
  }), /injected-before-rename/);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(atomicPath, 'utf8')), { revision: 1 });

  const jsonlPath = path.join(dataDir, 'append', 'requirements.jsonl');
  await Promise.all(Array.from({ length: 20 }, (_, index) => AtomicFile.appendJsonlLocked(jsonlPath, { index })));
  const lines = fs.readFileSync(jsonlPath, 'utf8').trim().split(/\r?\n/).map(JSON.parse);
  assert.strictEqual(lines.length, 20);
  assert.deepStrictEqual(lines.map(line => line.index).sort((a, b) => a - b), Array.from({ length: 20 }, (_, index) => index));

  fs.mkdirSync(dataDir, { recursive: true });
  const staleTemp = path.join(dataDir, '.atomic.json.1.1.abcdef.tmp');
  const unrelated = path.join(dataDir, 'user.tmp');
  fs.writeFileSync(staleTemp, 'stale');
  fs.writeFileSync(unrelated, 'keep');
  const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
  fs.utimesSync(staleTemp, old, old);
  const removed = AtomicFile.cleanupStaleTemps(dataDir);
  assert.deepStrictEqual(removed, [staleTemp]);
  assert(fs.existsSync(unrelated));

  const store = new SettingsStore({ layout });
  await store.initialize({
    knowledge: { rootPath: knowledgeRoot },
    ai: { schema: 'ai-profiles/v1', profiles: [{ id: 'primary', apiKey: 'secret-key-7890' }] },
  });
  const privateSettings = store.read();
  assert.strictEqual(privateSettings.ai.profiles[0].apiKey, 'secret-key-7890');
  const publicSettings = store.readPublicView();
  assert.strictEqual(publicSettings.ai.profiles[0].hasApiKey, true);
  assert.strictEqual(publicSettings.ai.profiles[0].apiKeyMasked, '****7890');
  assert.strictEqual(Object.prototype.hasOwnProperty.call(publicSettings.ai.profiles[0], 'apiKey'), false);

  await assert.rejects(
    () => store.updatePatch({ logging: { retentionDays: 0, maxTotalSizeMB: 512 } }),
    error => error.code === 'INVALID_ARGUMENT',
    'runtime retention/capacity settings must not be writable',
  );
  const updated = store.readPublicView();
  assert.deepStrictEqual(updated.logging.levels, ['trace', 'debug', 'info', 'warn', 'error', 'fatal']);
  assert.strictEqual(fs.existsSync(layout.getRecoveryPath()), false, 'optional recovery directory must stay lazy');
  assert.strictEqual(fs.existsSync(layout.getCachePath()), false, 'optional cache directory must stay lazy');

  console.log('storage-foundation-test PASS');
})().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
