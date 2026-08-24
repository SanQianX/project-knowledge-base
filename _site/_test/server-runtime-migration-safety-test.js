const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { initializeRuntime } = require('../lib/server-app');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-runtime-migration-safety-'));
let settingsInitialized = false;
let registryInitialized = false;
const runtime = {
  rootDir: path.join(root, 'missing-legacy-root'),
  dataPath: path.join(root, 'data'),
  logger: { info: async () => {} },
  migrationService: { migrateIfNeeded: async () => ({ ok: false, requiresManualRecovery: true, reason: 'fault-injected' }) },
  settingsStore: { initialize: async () => { settingsInitialized = true; } },
  registryStore: { initialize: async () => { registryInitialized = true; } },
};

initializeRuntime(runtime).then(() => {
  throw new Error('initializeRuntime must reject an unsuccessful migration');
}).catch(error => {
  assert.equal(error.code, 'MIGRATION_FAILED');
  assert.equal(settingsInitialized, false, 'settings defaults must not be initialized after migration failure');
  assert.equal(registryInitialized, false, 'empty project registry must not be initialized after migration failure');
  fs.rmSync(root, { recursive: true, force: true });
  console.log('server-runtime-migration-safety-test PASS');
});
