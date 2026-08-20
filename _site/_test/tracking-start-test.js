// Run: node _site/_test/tracking-start-test.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { StorageLayout } = require('../lib/storage-layout');
const { ProjectRegistryStore } = require('../lib/project-registry-store');
const { ProjectStore } = require('../lib/project-store');
const { ProjectLifecycleService } = require('../lib/project-lifecycle-service');
const { CommitReconciler } = require('../lib/commit-reconciler');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), `kb-tracking-start-${process.pid}-`));
const layout = new StorageLayout({ dataDir: path.join(temp, 'data') });
const registry = new ProjectRegistryStore({ layout });
const projects = new ProjectStore({ layout });
const knowledgeRoot = path.join(temp, 'knowledge');

function git(repo, args) {
  const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed`);
  return String(result.stdout || '').trim();
}

function repo(name, withCommit) {
  const target = path.join(temp, name);
  fs.mkdirSync(target, { recursive: true });
  git(target, ['init', '--initial-branch=main']);
  git(target, ['config', 'user.email', 'tracking@example.test']);
  git(target, ['config', 'user.name', 'Tracking Test']);
  if (withCommit) commit(target, 'imported');
  return target;
}

function commit(target, name) {
  fs.writeFileSync(path.join(target, `${name}.txt`), `${name}\n`, 'utf8');
  git(target, ['add', `${name}.txt`]);
  git(target, ['commit', '-m', name]);
  return git(target, ['rev-parse', 'HEAD']);
}

(async () => {
  fs.mkdirSync(knowledgeRoot, { recursive: true });
  await registry.initialize();
  const installed = [];
  const lifecycle = new ProjectLifecycleService({
    layout,
    registryStore: registry,
    projectStore: projects,
    settingsStore: { read: () => ({ knowledge: { rootPath: knowledgeRoot }, ai: { schema: 'ai-profiles/v1', profiles: [{ id: 'test-profile', enabled: true, vendor: 'anthropic', model: 'm' }], defaultProfileId: null } }) },
    triggerScriptPath: path.join(temp, 'hook-trigger.js'),
    hookManager: {
      installHook: options => { installed.push(options.projectId); return { ok: true, managedVersion: 2 }; },
      uninstallHook: () => ({ ok: true }),
    },
  });

  const existingRepo = repo('existing-repo', true);
  const importedHead = git(existingRepo, ['rev-parse', 'HEAD']);
  const imported = await lifecycle.importProject({ localPath: existingRepo, projectId: 'project-existing', aiProfileId: 'test-profile' });
  assert.strictEqual(imported.state.trackingStartCommit, importedHead);
  assert.strictEqual(imported.state.lastAnalyzedCommit, null);
  assert.strictEqual(imported.state.trackingMode, 'normal');
  assert.strictEqual(installed.length, 1, 'import should install Hook but not analyze');

  let processorCalls = 0;
  const processor = {
    processClaim: async input => {
      processorCalls += 1;
      await projects.updateState(input.projectId, state => {
        state.lastAnalyzedCommit = input.claim.commitSha;
        state.analysis.activeClaim = null;
        state.analysis.status = 'state.advanced';
        state.index.dirty = true;
        state.index.generation += 1;
      });
      return { stateAdvanced: true };
    },
  };
  const reconciler = new CommitReconciler({
    layout,
    registryStore: registry,
    projectStore: projects,
    settingsStore: { read: () => ({ knowledge: { rootPath: knowledgeRoot }, ai: { schema: 'ai-profiles/v1', profiles: [{ id: 'test-profile', enabled: true, vendor: 'anthropic', model: 'm' }], defaultProfileId: null } }) },
    claimProcessor: processor,
  });
  const initialSweep = await reconciler.reconcile('project-existing', 'startup');
  assert.strictEqual(initialSweep.status, 'idle');
  assert.strictEqual(processorCalls, 0, 'startup after import must not analyze pre-import history');
  const nextCommit = commit(existingRepo, 'after-import');
  await reconciler.reconcile('project-existing', 'git-hook');
  assert.strictEqual(projects.readState('project-existing').lastAnalyzedCommit, nextCommit);
  assert.strictEqual(processorCalls, 1);

  const emptyRepo = repo('empty-repo', false);
  const emptyImported = await lifecycle.importProject({ localPath: emptyRepo, projectId: 'project-empty', aiProfileId: 'test-profile' });
  assert.strictEqual(emptyImported.state.trackingMode, 'empty-repo');
  assert.strictEqual(emptyImported.state.trackingStartCommit, null);
  const firstCommit = commit(emptyRepo, 'first');
  await reconciler.reconcile('project-empty', 'git-hook');
  assert.strictEqual(projects.readState('project-empty').lastAnalyzedCommit, firstCommit, 'first commit after empty import must be analyzed');
  assert.strictEqual(processorCalls, 2);

  console.log('tracking-start-test PASS');
})().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}).finally(() => {
  fs.rmSync(temp, { recursive: true, force: true });
});
