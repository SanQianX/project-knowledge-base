// Run: node _site/_test/index-writer-concurrency-test.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { StorageLayout } = require('../lib/storage-layout');
const { ProjectRegistryStore } = require('../lib/project-registry-store');
const { ProjectStore } = require('../lib/project-store');
const { IndexService } = require('../lib/index-service');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), `kb-index-writer-${process.pid}-`));
const layout = new StorageLayout({ dataDir: path.join(temp, 'data') });
const registry = new ProjectRegistryStore({ layout });
const projects = new ProjectStore({ layout });

async function addProject(projectId) {
  const knowledgePath = path.join(temp, 'knowledge', projectId);
  fs.mkdirSync(knowledgePath, { recursive: true });
  fs.writeFileSync(path.join(knowledgePath, 'README.md'), `# ${projectId}\n\nMarkdown remains authoritative.\n`, 'utf8');
  await projects.create(projectId, {
    displayName: projectId,
    storageName: projectId,
    repoPath: path.join(temp, 'repos', projectId),
    knowledgePath,
  });
  await registry.add(projectId, { displayName: projectId });
  await markDirty(projectId, `commit-${projectId}`);
}

async function markDirty(projectId, commitSha) {
  await projects.updateState(projectId, state => {
    state.index.dirty = true;
    state.index.sinceCommit = state.index.sinceCommit || commitSha;
    state.index.generation += 1;
  });
}

(async () => {
  await registry.initialize();
  await addProject('project-a');
  await addProject('project-b');
  let active = 0;
  let maxActive = 0;
  const calls = [];
  let releaseFirst;
  let firstStarted;
  const firstStart = new Promise(resolve => { firstStarted = resolve; });
  const firstGate = new Promise(resolve => { releaseFirst = resolve; });
  const adapter = {
    async indexProject(input) {
      active += 1;
      maxActive = Math.max(maxActive, active);
      calls.push({ projectId: input.projectId, generation: input.generation });
      if (input.projectId === 'project-a' && calls.filter(call => call.projectId === 'project-a').length === 1) {
        firstStarted();
        await firstGate;
      }
      await new Promise(resolve => setTimeout(resolve, 20));
      active -= 1;
      return { indexed: true };
    },
  };
  const service = new IndexService({ layout, registryStore: registry, projectStore: projects, adapter });
  const firstA = service.enqueue('project-a');
  await firstStart;
  await markDirty('project-a', 'commit-new-during-index');
  const coalescedA = service.enqueue('project-a');
  const firstB = service.enqueue('project-b');
  releaseFirst();
  await Promise.all([firstA, coalescedA, firstB]);
  assert.strictEqual(maxActive, 1, 'all index mutations must share one process-global writer');
  assert.strictEqual(calls.filter(call => call.projectId === 'project-a').length, 2, 'new generation during an old write must be indexed again');
  assert.strictEqual(projects.readState('project-a').index.dirty, false);
  assert.strictEqual(projects.readState('project-b').index.dirty, false);

  await markDirty('project-b', 'commit-index-failure');
  let fail = true;
  const retryService = new IndexService({
    layout,
    registryStore: registry,
    projectStore: projects,
    adapter: {
      indexProject: async () => {
        if (fail) { fail = false; throw new Error('injected index failure'); }
        return { indexed: true };
      },
    },
  });
  const failed = await retryService.enqueue('project-b');
  assert.strictEqual(failed.ok, false);
  const failedState = projects.readState('project-b');
  assert.strictEqual(failedState.index.dirty, true, 'index failure must keep dirty state');
  assert(failedState.index.lastError && failedState.index.lastError.message.includes('injected'));
  assert(fs.existsSync(path.join(projects.readConfig('project-b').knowledgePath, 'README.md')), 'index failure must not remove truthful Markdown');
  const retried = await retryService.enqueue('project-b');
  assert.strictEqual(retried.ok, true);
  assert.strictEqual(projects.readState('project-b').index.dirty, false);

  const indexPath = layout.getIndexPath();
  fs.mkdirSync(indexPath, { recursive: true });
  fs.writeFileSync(path.join(indexPath, 'marker.txt'), 'old-index', 'utf8');
  let validationOk = false;
  const rebuildService = new IndexService({
    layout,
    registryStore: registry,
    projectStore: projects,
    adapter: {
      indexProject: async () => ({}),
      buildFull: async ({ targetPath }) => {
        fs.mkdirSync(targetPath, { recursive: true });
        fs.writeFileSync(path.join(targetPath, 'marker.txt'), 'new-index', 'utf8');
      },
      validateIndex: async targetPath => ({ ok: validationOk, marker: fs.readFileSync(path.join(targetPath, 'marker.txt'), 'utf8') }),
    },
  });
  await assert.rejects(rebuildService.fullRebuild(), error => error.code === 'DATA_CORRUPT');
  assert.strictEqual(fs.readFileSync(path.join(indexPath, 'marker.txt'), 'utf8'), 'old-index', 'failed rebuild validation must retain the live DB');
  validationOk = true;
  const rebuilt = await rebuildService.fullRebuild();
  assert.strictEqual(fs.readFileSync(path.join(indexPath, 'marker.txt'), 'utf8'), 'new-index');
  assert(rebuilt.backup && fs.readFileSync(path.join(rebuilt.backup, 'marker.txt'), 'utf8') === 'old-index', 'successful swap should retain a recovery copy of the old DB');

  await IndexService.flush();
  console.log('index-writer-concurrency-test PASS');
})().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}).finally(() => {
  fs.rmSync(temp, { recursive: true, force: true });
});
