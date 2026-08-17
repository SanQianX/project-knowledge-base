const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SCHEMAS } = require('../lib/contracts');
const { StorageLayout } = require('../lib/storage-layout');
const { ProjectRegistryStore } = require('../lib/project-registry-store');
const { ProjectStore } = require('../lib/project-store');

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-project-store-'));
  const layout = new StorageLayout({ dataDir: root });
  const registry = new ProjectRegistryStore({ layout });
  const projects = new ProjectStore({ layout });
  await registry.initialize();

  const create = id => projects.create(id, {
    displayName: id,
    storageName: `${id}-stable`,
    repoPath: path.join(root, 'repos', id),
    knowledgePath: path.join(root, 'knowledge', id),
  }, { trackingStartCommit: 'base' });
  await Promise.all([create('project-a'), create('project-b')]);
  await Promise.all([
    registry.add('project-a', { displayName: 'A' }),
    registry.add('project-b', { displayName: 'B' }),
  ]);
  assert.deepStrictEqual(new Set(registry.listIds()), new Set(['project-a', 'project-b']));

  await Promise.all([
    projects.updateState('project-a', state => { state.lastAnalyzedCommit = 'commit-a'; }),
    projects.updateState('project-b', state => { state.lastAnalyzedCommit = 'commit-b'; }),
  ]);
  assert.strictEqual(projects.readState('project-a').lastAnalyzedCommit, 'commit-a');
  assert.strictEqual(projects.readState('project-b').lastAnalyzedCommit, 'commit-b');

  const order = [];
  await Promise.all([
    projects.updateState('project-a', async state => {
      order.push('first-start');
      await new Promise(resolve => setTimeout(resolve, 40));
      order.push('first-end');
      state.lastAnalyzedCommit = 'commit-a-2';
    }),
    projects.updateState('project-a', state => {
      order.push('second');
      state.lastAnalyzedCommit = 'commit-a-3';
    }),
  ]);
  assert.deepStrictEqual(order, ['first-start', 'first-end', 'second']);
  assert.strictEqual(projects.readState('project-a').lastAnalyzedCommit, 'commit-a-3');
  const revision = projects.readState('project-a').revision;
  await assert.rejects(
    projects.updateState('project-a', state => state, { expectedRevision: revision - 1 }),
    error => error.code === 'PROJECT_BUSY',
  );

  const configBefore = projects.readConfig('project-a');
  const renamed = await projects.updateConfig('project-a', { displayName: 'Renamed A' });
  assert.strictEqual(renamed.projectId, configBefore.projectId);
  assert.strictEqual(renamed.storageName, configBefore.storageName);
  assert.strictEqual(renamed.knowledgePath, configBefore.knowledgePath);
  await assert.rejects(projects.updateConfig('project-a', { repoPath: path.join(root, 'unverified-move') }), error => error.code === 'INVALID_ARGUMENT');
  const moved = await projects.updateConfig('project-a', { repoPath: path.join(root, 'verified-move') }, { allowRepoPath: true });
  assert.strictEqual(moved.repoPath, path.resolve(root, 'verified-move'));
  await assert.rejects(projects.updateConfig('project-a', { knowledgePath: path.join(root, 'other') }), error => error.code === 'IMMUTABLE_FIELD');

  const requirementPath = layout.getProjectRequirementsPath('project-a');
  assert.strictEqual(fs.existsSync(requirementPath), false);
  await Promise.all(Array.from({ length: 20 }, (_, index) => projects.appendRequirement('project-a', {
    schema: SCHEMAS.requirement,
    id: `req-${index}`,
    ts: new Date().toISOString(),
    projectId: 'project-a',
    requirement: `requirement ${index}`,
  })));
  assert.strictEqual(projects.readRequirements('project-a').length, 20);
  assert.strictEqual(fs.existsSync(layout.getProjectRequirementsPath('project-b')), false);

  fs.writeFileSync(layout.getProjectStatePath('project-b'), '{broken', 'utf8');
  assert.throws(() => projects.readState('project-b'), error => error.code === 'DATA_CORRUPT');

  const registryData = registry.read();
  assert.deepStrictEqual(Object.keys(registryData.projects).sort(), ['project-a', 'project-b']);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(registryData.projects['project-a'], 'lastAnalyzedCommit'), false);
  console.log('project-store-test PASS');
})().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
