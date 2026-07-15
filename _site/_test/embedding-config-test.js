const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('../lib/embedding-config');

(() => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'embedding-config-test-'));
  const configPath = path.join(temp, 'embedding-config.json');
  const statePath = path.join(temp, 'embedding-model-state.json');
  try {
    const defaults = store.readConfig(configPath);
    assert.equal(defaults.remoteHost, 'https://huggingface.co/');
    assert.equal(defaults.localFilesOnly, false);
    const saved = store.writeConfig(configPath, {
      remoteHost: 'https://model-mirror.example///',
      localModelPath: 'D:\\models',
      localFilesOnly: true,
    });
    assert.equal(saved.remoteHost, 'https://model-mirror.example/');
    assert.equal(store.readConfig(configPath).localModelPath, 'D:\\models');
    const downloading = store.writeState(statePath, { status: 'downloading', startedAt: 'now' });
    assert.equal(downloading.status, 'downloading');
    const failed = store.writeState(statePath, { status: 'failed', error: 'network unavailable' });
    assert.equal(failed.startedAt, 'now');
    assert.equal(store.readState(statePath).error, 'network unavailable');
    console.log('embedding-config-test: PASS');
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
})();
