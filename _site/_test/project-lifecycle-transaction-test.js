const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { StorageLayout } = require('../lib/storage-layout');
const { SettingsStore } = require('../lib/settings-store');
const { ProjectRegistryStore } = require('../lib/project-registry-store');
const { ProjectStore } = require('../lib/project-store');
const { ProjectLifecycleService } = require('../lib/project-lifecycle-service');
const realHookManager = require('../lib/hook-manager');

const ROOT = path.resolve(__dirname, '..', '..');
const TRIGGER = path.join(ROOT, '_site', 'scripts', 'hook-trigger.js');

function git(repo, args) {
  const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed`);
  return String(result.stdout || '').trim();
}

function createRepo(root, name, withCommit = true) {
  const repo = path.join(root, name);
  fs.mkdirSync(repo, { recursive: true });
  git(repo, ['init', '--initial-branch=main']);
  git(repo, ['config', 'user.email', 'life@example.invalid']);
  git(repo, ['config', 'user.name', 'Lifecycle Test']);
  if (withCommit) {
    fs.writeFileSync(path.join(repo, 'README.md'), `# ${name}\n`);
    git(repo, ['add', 'README.md']);
    git(repo, ['commit', '-m', 'initial']);
  }
  return repo;
}

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-lifecycle-'));
  const dataDir = path.join(root, 'data');
  const knowledgeRoot = path.join(root, 'knowledge');
  const layout = new StorageLayout({ dataDir });
  const settings = new SettingsStore({ layout });
  const registry = new ProjectRegistryStore({ layout });
  const projects = new ProjectStore({ layout });
  await settings.initialize({ knowledge: { rootPath: knowledgeRoot } });
  await registry.initialize();
  const lifecycle = new ProjectLifecycleService({
    layout,
    settingsStore: settings,
    registryStore: registry,
    projectStore: projects,
    triggerScriptPath: TRIGGER,
    bridgeAdapter: { async getHighWatermark() { return { status: 'captured', cursor: 73 }; } },
  });

  const repo = createRepo(root, 'repo-a');
  const claude = path.join(repo, 'CLAUDE.md');
  fs.writeFileSync(claude, '# user only\n');
  const imported = await lifecycle.importProject({ localPath: repo, projectId: 'project-life-a', storageName: 'repo-a-stable' });
  assert.strictEqual(imported.ok, true);
  assert.strictEqual(imported.config.aiProfileId, null, 'import must not require an AI profile');
  assert.strictEqual(imported.state.trackingStartCommit, git(repo, ['rev-parse', 'HEAD']));
  assert.strictEqual(imported.state.conversationBaselineCursor, 73, 'import must freeze the current Bridge cursor as its conversation baseline');
  assert.deepStrictEqual(fs.readdirSync(imported.config.knowledgePath), [], 'import must not create TODO knowledge files');
  assert.strictEqual(fs.readFileSync(claude, 'utf8'), '# user only\n');
  assert.strictEqual(realHookManager.readHookStatus({ repoPath: repo, projectId: imported.projectId }).installed, true);
  await assert.rejects(lifecycle.importProject({ localPath: repo }), /already imported/);

  const conflictRepo = createRepo(root, 'repo-conflict');
  const conflictPath = path.join(knowledgeRoot, 'conflict-stable');
  fs.mkdirSync(conflictPath, { recursive: true });
  fs.writeFileSync(path.join(conflictPath, 'user.md'), 'do not overwrite');
  await assert.rejects(lifecycle.importProject({ localPath: conflictRepo, projectId: 'project-conflict', storageName: 'conflict-stable' }), error => error.code === 'MIGRATION_TARGET_CONFLICT');
  assert(!registry.listIds().includes('project-conflict'));
  assert.strictEqual(fs.readFileSync(path.join(conflictPath, 'user.md'), 'utf8'), 'do not overwrite');

  const failingRepo = createRepo(root, 'repo-failing');
  const failingHooks = { ...realHookManager, installHook() { throw new Error('injected Hook failure'); } };
  const failingLifecycle = new ProjectLifecycleService({ layout, settingsStore: settings, registryStore: registry, projectStore: projects, triggerScriptPath: TRIGGER, hookManager: failingHooks });
  await assert.rejects(failingLifecycle.importProject({ localPath: failingRepo, projectId: 'project-failing', storageName: 'failing-stable' }));
  assert(!registry.listIds().includes('project-failing'));
  assert(!fs.existsSync(layout.getProjectMetadataDir('project-failing')));
  assert(!fs.existsSync(path.join(knowledgeRoot, 'failing-stable')));

  const emptyRepo = createRepo(root, 'repo-empty', false);
  const empty = await lifecycle.importProject({ localPath: emptyRepo, projectId: 'project-empty', storageName: 'empty-stable' });
  assert.strictEqual(empty.state.trackingMode, 'empty-repo');
  assert.strictEqual(empty.state.trackingStartCommit, null);

  const failingDelete = new ProjectLifecycleService({
    layout, settingsStore: settings, registryStore: registry, projectStore: projects, triggerScriptPath: TRIGGER,
    hookManager: { ...realHookManager, uninstallHook() { throw new Error('injected uninstall failure'); } },
  });
  await assert.rejects(failingDelete.deleteProject(imported.projectId));
  assert(registry.listIds().includes(imported.projectId), 'Hook uninstall failure must preserve registration');

  const knowledgePath = imported.config.knowledgePath;
  const deleted = await lifecycle.deleteProject(imported.projectId);
  assert.strictEqual(deleted.removedKnowledge, false);
  assert(fs.existsSync(knowledgePath), 'default delete must preserve external knowledge directory');
  assert(!registry.listIds().includes(imported.projectId));

  console.log('project-lifecycle-transaction-test PASS');
})().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
