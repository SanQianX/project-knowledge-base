const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { StorageLayout } = require('../lib/storage-layout');
const { SettingsStore } = require('../lib/settings-store');

(async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'embedding-config-test-'));
  const layout = new StorageLayout({ dataDir: temp });
  const store = new SettingsStore({ layout });
  try {
    const defaults = await store.initialize();
    assert.deepStrictEqual(defaults.embedding, {});
    const saved = await store.updatePatch({
      embedding: {
        modelId: 'Xenova/all-MiniLM-L6-v2',
        remoteHost: 'https://model-mirror.example/',
        localModelPath: 'D:\\models',
        localFilesOnly: true,
      },
    });
    assert.equal(saved.embedding.remoteHost, 'https://model-mirror.example/');
    assert.equal(store.read().embedding.localModelPath, 'D:\\models');
    assert.equal(store.read().embedding.localFilesOnly, true);
    assert.strictEqual(fs.existsSync(path.join(temp, 'embedding-config.json')), false, 'embedding settings must not use a second live config file');
    assert.strictEqual(fs.existsSync(layout.getSettingsPath()), true);
    console.log('embedding-config-test: PASS');
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
