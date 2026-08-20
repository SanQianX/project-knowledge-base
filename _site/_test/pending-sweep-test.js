// Run: node _site/_test/pending-sweep-test.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { SCHEMAS } = require('../lib/contracts');
const { StorageLayout } = require('../lib/storage-layout');
const { ProjectRegistryStore } = require('../lib/project-registry-store');
const { ProjectStore } = require('../lib/project-store');
const { CommitReconciler } = require('../lib/commit-reconciler');
const { dispatchPendingAutomations, handlePostCommitEvent } = require('../lib/post-commit-automation');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), `kb-pending-sweep-${process.pid}-`));
const layout = new StorageLayout({ dataDir: path.join(temp, 'data') });
const registry = new ProjectRegistryStore({ layout });
const projects = new ProjectStore({ layout });

function git(repo, args) {
  const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed`);
  return String(result.stdout || '').trim();
}

function createRepo(name) {
  const repo = path.join(temp, name);
  fs.mkdirSync(repo, { recursive: true });
  git(repo, ['init', '--initial-branch=main']);
  git(repo, ['config', 'user.email', 'sweep@example.test']);
  git(repo, ['config', 'user.name', 'Sweep Test']);
  const baseline = commit(repo, 'baseline');
  const pending = commit(repo, 'pending');
  return { repo, baseline, pending, commonDir: path.resolve(git(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir'])) };
}

function commit(repo, label) {
  fs.writeFileSync(path.join(repo, `${label}-${Date.now()}-${Math.random()}.txt`), `${label}\n`, 'utf8');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-m', label]);
  return git(repo, ['rev-parse', 'HEAD']);
}

(async () => {
  await registry.initialize();
  const fixtures = [];
  for (let index = 0; index < 4; index += 1) {
    const projectId = `project-${index}`;
    const fixture = createRepo(projectId);
    fixtures.push({ projectId, ...fixture });
    await projects.create(projectId, {
      displayName: projectId,
      storageName: projectId,
      repoPath: fixture.repo,
      knowledgePath: path.join(temp, 'knowledge', projectId),
      aiProfileId: 'test-profile',
      repoIdentity: { commonDir: fixture.commonDir },
      enabled: index !== 3,
    }, { trackingStartCommit: fixture.baseline, trackingMode: 'normal' });
    await registry.add(projectId, { displayName: projectId });
  }

  let active = 0;
  let maxActive = 0;
  let releaseFirstPair;
  const firstPairReady = new Promise(resolve => { releaseFirstPair = resolve; });
  const processor = {
    processClaim: async input => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (active === 2) releaseFirstPair();
      if (active === 1) {
        // Hold the first project until a second worker reaches the processor.
        // The timeout turns an actual serialization regression into a bounded
        // assertion failure instead of a hanging test.
        await Promise.race([
          firstPairReady,
          new Promise(resolve => setTimeout(resolve, 3000)),
        ]);
      }
      await projects.updateState(input.projectId, state => {
        state.lastAnalyzedCommit = input.claim.commitSha;
        state.analysis.activeClaim = null;
        state.analysis.status = 'state.advanced';
        state.index.dirty = true;
        state.index.generation += 1;
      });
      active -= 1;
      return { stateAdvanced: true };
    },
  };
  const reconciler = new CommitReconciler({
    layout,
    registryStore: registry,
    projectStore: projects,
    settingsStore: { read: () => ({ knowledge: { rootPath: '' }, ai: { schema: 'ai-profiles/v1', profiles: [{ id: 'test-profile', enabled: true, vendor: 'anthropic', model: 'm' }], defaultProfileId: null } }) },
    claimProcessor: processor,
  });
  const swept = await dispatchPendingAutomations({ concurrency: 2 }, {
    layout, registryStore: registry, projectStore: projects, reconciler,
  });
  assert.strictEqual(swept.ok, true);
  assert.strictEqual(swept.results.length, 3, 'startup sweep should include enabled projects only');
  assert.strictEqual(swept.dispatched, 3);
  assert(maxActive > 1 && maxActive <= 2, `startup concurrency should be bounded at two, observed ${maxActive}`);
  for (const fixture of fixtures.slice(0, 3)) {
    assert.strictEqual(projects.readState(fixture.projectId).lastAnalyzedCommit, fixture.pending);
  }
  assert.strictEqual(projects.readState('project-3').lastAnalyzedCommit, null, 'disabled project must not reconcile');

  const moved = fixtures[0];
  const movedPath = path.join(temp, 'moved-project-0');
  fs.renameSync(moved.repo, movedPath);
  const afterMove = commit(movedPath, 'after-move');
  const hookResult = await handlePostCommitEvent({
    schema: SCHEMAS.hookEvent,
    projectId: moved.projectId,
    repoRoot: movedPath,
    head: afterMove,
    branch: 'main',
  }, { layout, registryStore: registry, projectStore: projects, reconciler });
  assert.strictEqual(hookResult.ok, true);
  assert.strictEqual(path.resolve(projects.readConfig(moved.projectId).repoPath), path.resolve(movedPath), 'stable projectId Hook should update a verified moved repo path');
  assert.strictEqual(projects.readState(moved.projectId).lastAnalyzedCommit, afterMove);

  await assert.rejects(
    handlePostCommitEvent({ schema: 'hook-event/v1', projectId: moved.projectId, repoRoot: movedPath }, { layout, registryStore: registry, projectStore: projects, reconciler }),
    error => error.code === 'SCHEMA_UNSUPPORTED',
  );
  console.log('pending-sweep-test PASS');
})().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}).finally(() => {
  fs.rmSync(temp, { recursive: true, force: true });
});
