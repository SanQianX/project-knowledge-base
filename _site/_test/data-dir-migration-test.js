const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const dataDir = require('../lib/data-dir');
const { LEGACY_ASSETS } = require('../lib/legacy-data-manifest');

function temp(name) { return fs.mkdtempSync(path.join(os.tmpdir(), `pk-data-dir-${name}-`)); }
function clean(dir) { fs.rmSync(dir, { recursive: true, force: true }); }
function write(file, value = '{}') { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value); }

(() => {
  // Resolution must be diagnostic-safe: resolving never creates the candidate.
  const missing = path.join(temp('resolve'), 'not-created');
  try {
    assert.equal(dataDir.resolveDataDirPath({ dataDir: missing }), path.resolve(missing));
    assert.equal(fs.existsSync(missing), false);
    dataDir.ensureDataDir(missing);
    assert.equal(fs.existsSync(missing), true);
  } finally { clean(path.dirname(missing)); }

  const legacy = temp('legacy');
  const target = temp('target');
  const saved = process.env.KB_DATA_DIR;
  try {
    write(path.join(legacy, 'projects.json'), JSON.stringify({ old: { repoPath: 'C:/legacy' } }));
    write(path.join(legacy, 'ai-profiles.json'), JSON.stringify({ profiles: [{ id: 'primary', apiKey: 'test-secret' }] }));
    write(path.join(legacy, 'knowledge-store.json'), JSON.stringify({ rootPath: 'C:/knowledge' }));
    write(path.join(legacy, 'embedding-config.json'), JSON.stringify({ modelId: 'model', localModelPath: 'C:/models', localFilesOnly: true }));
    write(path.join(legacy, 'knowledge-scopes.json'), JSON.stringify({ scopes: ['p'] }));
    write(path.join(legacy, 'models', 'nested', 'model.onnx'), 'model-bytes');
    // An empty target registry is non-authoritative and must not suppress legacy data.
    write(path.join(target, 'projects.json'), '{}');
    process.env.KB_DATA_DIR = target;
    dataDir._resetCache();
    const result = dataDir.migrateFromLegacy({ legacyRoot: legacy });
    assert.equal(result.ok, true);
    assert.equal(result.migrated, true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(target, 'projects.json'))).old.repoPath, 'C:/legacy');
    assert.equal(JSON.parse(fs.readFileSync(path.join(target, 'ai-profiles.json'))).profiles.length, 1);
    assert.equal(JSON.parse(fs.readFileSync(path.join(target, 'embedding-config.json'))).modelId, 'model');
    assert.equal(fs.readFileSync(path.join(target, 'models', 'nested', 'model.onnx'), 'utf8'), 'model-bytes');
    assert(LEGACY_ASSETS.some(asset => asset.source === 'embedding-config.json'));
    assert(LEGACY_ASSETS.some(asset => asset.source === 'models'));
  } finally { process.env.KB_DATA_DIR = saved; dataDir._resetCache(); clean(legacy); clean(target); }

  const source = temp('conflict-source');
  const destination = temp('conflict-destination');
  try {
    write(path.join(source, 'projects.json'), JSON.stringify({ old: { repoPath: 'C:/old' } }));
    write(path.join(destination, 'projects.json'), JSON.stringify({ newer: { repoPath: 'C:/new' } }));
    process.env.KB_DATA_DIR = destination;
    dataDir._resetCache();
    const result = dataDir.migrateFromLegacy({ legacyRoot: source });
    assert.equal(result.ok, false);
    assert.equal(result.requiresManualRecovery, true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(destination, 'projects.json'))).newer.repoPath, 'C:/new');
  } finally { process.env.KB_DATA_DIR = saved; dataDir._resetCache(); clean(source); clean(destination); }
  console.log('data-dir-migration-test PASS');
})();
