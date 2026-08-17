const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { StorageLayout } = require('../lib/storage-layout');
const { ProjectRegistryStore } = require('../lib/project-registry-store');
const { ProjectStore } = require('../lib/project-store');
const { IndexService } = require('../lib/index-service');

(async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-maintenance-v2-'));
  const layout = new StorageLayout({ dataDir: path.join(temp, 'data') });
  const registry = new ProjectRegistryStore({ layout });
  const projects = new ProjectStore({ layout });
  await registry.initialize();
  const target = layout.getIndexPath();
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, 'version.txt'), 'old-index', 'utf8');
  const adapter = {
    validationOk: false,
    async buildFull({ targetPath }) {
      fs.mkdirSync(targetPath, { recursive: true });
      fs.writeFileSync(path.join(targetPath, 'version.txt'), 'new-index', 'utf8');
    },
    async validateIndex(candidate) {
      return { ok: this.validationOk, marker: fs.readFileSync(path.join(candidate, 'version.txt'), 'utf8') };
    },
  };
  const service = new IndexService({ layout, registryStore: registry, projectStore: projects, adapter });
  await assert.rejects(service.fullRebuild({ operationId: 'op-validation-failure' }), error => error.code === 'DATA_CORRUPT');
  assert.strictEqual(fs.readFileSync(path.join(target, 'version.txt'), 'utf8'), 'old-index', 'failed validation must leave the live index untouched');
  assert(!fs.existsSync(path.join(path.dirname(target), '.knowledge.rebuild.op-validation-failure')));

  adapter.validationOk = true;
  const rebuilt = await service.fullRebuild({ operationId: 'op-valid-rebuild' });
  assert.strictEqual(fs.readFileSync(path.join(target, 'version.txt'), 'utf8'), 'new-index');
  assert(rebuilt.backup && fs.existsSync(rebuilt.backup));
  assert.strictEqual(fs.readFileSync(path.join(rebuilt.backup, 'version.txt'), 'utf8'), 'old-index', 'atomic swap must retain the previous live index');
  console.log('knowledge-maintenance-test: PASS');
})().catch(error => { console.error(error); process.exitCode = 1; });
