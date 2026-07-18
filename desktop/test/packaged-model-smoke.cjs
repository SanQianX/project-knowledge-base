const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const desktopRoot = path.resolve(__dirname, '..');
const bundleRoot = path.join(desktopRoot, 'out', 'Project Knowledge-win32-x64');
const executable = path.join(bundleRoot, 'Project Knowledge.exe');
const asarRoot = path.join(bundleRoot, 'resources', 'app.asar');
const localModelPath = process.env.KB_EMBEDDING_LOCAL_PATH || '';

if (!localModelPath || !fs.existsSync(localModelPath)) {
  throw new Error('KB_EMBEDDING_LOCAL_PATH must point to the local model root for the packaged model smoke test');
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-packaged-model-'));
const probe = path.join(temp, 'model-probe.cjs');
fs.writeFileSync(probe, `
  const assert = require('assert');
  const path = require('path');
  const { LocalEmbeddingService } = require(path.join(
    process.argv[2], 'node_modules', 'project-knowledge', '_site', 'lib', 'embedding-service.js'
  ));
  (async () => {
    const service = new LocalEmbeddingService({
      localModelPath: process.argv[3],
      localFilesOnly: true,
    });
    const vector = await service.embedQuery('向量知识库如何进行中文语义检索？');
    assert.equal(vector.length, 512);
    assert(vector.every(Number.isFinite));
    const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
    assert(Math.abs(norm - 1) < 0.01, 'embedding should be normalized');
    console.log('PACKAGED_MODEL_PASS');
  })().catch(error => {
    console.error(error && error.stack || error);
    process.exit(1);
  });
`);

try {
  const result = spawnSync(executable, [probe, asarRoot, path.resolve(localModelPath)], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
    timeout: 180000,
    windowsHide: true,
  });
  if (result.status !== 0 || !/PACKAGED_MODEL_PASS/.test(result.stdout)) {
    throw new Error(`packaged model smoke failed: ${result.stdout}\n${result.stderr}`);
  }
  console.log('packaged-model-smoke PASS');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
