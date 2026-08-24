// Characterizes v4.2.6 P0 migration behavior before the safety repair.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const dataDir = require('../lib/data-dir');
const { StorageLayout } = require('../lib/storage-layout');
const { MigrationService } = require('../lib/migration-service');

function temp(name) { return fs.mkdtempSync(path.join(os.tmpdir(), `pk-p0-${name}-`)); }
function cleanup(dir) { fs.rmSync(dir, { recursive: true, force: true }); }

(() => {
  const legacy = temp('legacy');
  const target = temp('target');
  const saved = process.env.KB_DATA_DIR;
  try {
    fs.writeFileSync(path.join(legacy, 'projects.json'), JSON.stringify({ legacy: { repoPath: 'C:/legacy' } }));
    fs.writeFileSync(path.join(legacy, 'ai-profiles.json'), JSON.stringify({ profiles: [{ id: 'p' }] }));
    fs.writeFileSync(path.join(target, 'projects.json'), '{}');
    process.env.KB_DATA_DIR = target;
    dataDir._resetCache();
    const result = dataDir.migrateFromLegacy({ legacyRoot: legacy });
    assert.equal(result.reason, 'already migrated', 'v4.2.6 treats any target projects.json as migrated');
    assert.equal(fs.existsSync(path.join(target, 'ai-profiles.json')), false, 'legacy AI profiles are skipped with an empty target registry');
  } finally {
    process.env.KB_DATA_DIR = saved;
    dataDir._resetCache();
    cleanup(legacy);
    cleanup(target);
  }

  const data = temp('models');
  try {
    fs.writeFileSync(path.join(data, 'projects.json'), JSON.stringify({ legacy: { repoPath: data } }));
    fs.mkdirSync(path.join(data, 'models', 'nested'), { recursive: true });
    fs.writeFileSync(path.join(data, 'models', 'nested', 'model.onnx'), 'fixture');
    const migration = new MigrationService({ layout: new StorageLayout({ dataDir: data }), legacyDataDir: data });
    const discovery = migration.discover();
    assert.equal(discovery.sources.some(entry => entry.path.endsWith(`${path.sep}models`)), false,
      'v4.2.6 migration discovery excludes the legacy models directory');
  } finally {
    cleanup(data);
  }

  const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'server-app.js'), 'utf8');
  const initialization = source.slice(source.indexOf('async function initializeRuntime'), source.indexOf('function taskForProject'));
  assert.equal(/if\s*\(\s*!migration\.ok\s*\)/.test(initialization), false,
    'v4.2.6 initializes stores without fail-closing an unsuccessful migration');
  console.log('p0-data-migration-characterization-test PASS');
})();
