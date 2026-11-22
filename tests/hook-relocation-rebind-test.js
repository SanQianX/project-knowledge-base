// Run: node tests/hook-relocation-rebind-test.js
// 数据目录迁移后的受管 Hook 重绑定：legacy 启动路径上，「已迁移」标记不再跳过
// 路径核对——Hook 实体必须绑定当前实例（--data-dir / --bridge-home / 触发脚本），
// 过期绑定被受控重写；已是当前的绑定不写文件；第三方或他人 Hook 报冲突并保留。

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { migrateManagedHooks } = require('../_site/lib/server-app');
const hookManager = require('../_site/lib/hook-manager');

const ROOT = require("./paths").ROOT;
const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-hook-reloc-'));
const repo = path.join(TEMP, '代码 仓库');
const TRIGGER = path.join(ROOT, '_site', 'scripts', 'hook-trigger.js');

function git(args) {
  const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed`);
  return String(result.stdout || '').trim();
}

function makeRuntime(dataDir, analysisOwner = 'legacy') {
  // Minimal runtime surface used by migrateManagedHooks.
  const projects = new Map();
  const states = new Map();
  return {
    analysisOwner,
    registryStore: { listIds: () => [...projects.keys()] },
    projectStore: {
      readConfig: id => projects.get(id),
      readState: id => states.get(id) || { hook: { migrationVersion: 0 } },
      updateState: async (id, mutate) => {
        const state = states.get(id) || { hook: { migrationVersion: 0 } };
        mutate(state);
        states.set(id, state);
      },
      register(id, config) { projects.set(id, config); },
      states,
    },
    bridgeAdapter: {
      hookBinding: () => ({ dataDir, bridgeHomeDir: path.join(dataDir, 'events'), bridgeModulePath: undefined }),
    },
    logger: { warn: async () => {}, info: async () => {} },
  };
}

function hookText() {
  const hookPath = hookManager.readHookStatus({ repoPath: repo }).hookPath;
  return fs.readFileSync(hookPath, 'utf8');
}

(async () => {
  fs.mkdirSync(repo, { recursive: true });
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'hook-reloc@example.local']);
  git(['config', 'user.name', 'Hook Reloc Test']);
  fs.writeFileSync(path.join(repo, 'README.md'), '# hook reloc\n');
  git(['add', '.']);
  git(['commit', '-q', '-m', 'initial']);
  const projectId = 'project-hook-reloc';

  // An older installation under data directory A already recorded migration v2.
  const dataA = path.join(TEMP, '数据 A');
  const dataB = path.join(TEMP, '数据 B');
  hookManager.installHook({ repoPath: repo, projectId, triggerScriptPath: TRIGGER, dataDir: dataA, bridgeHomeDir: path.join(dataA, 'events') });
  assert.ok(hookText().includes('数据 A'), 'the stale hook carries the old data directory');

  const runtimeA = makeRuntime(dataA);
  runtimeA.projectStore.register(projectId, { repoPath: repo });
  runtimeA.projectStore.states.set(projectId, { hook: { migrationVersion: 2 } });

  // Relocation: the current instance runs from directory B.
  const runtimeB = makeRuntime(dataB);
  runtimeB.projectStore.register(projectId, { repoPath: repo });
  runtimeB.projectStore.states.set(projectId, { hook: { migrationVersion: 2 } });
  const rebound = await migrateManagedHooks(runtimeB);
  assert.strictEqual(rebound[0].ok, true, JSON.stringify(rebound[0]));
  assert.strictEqual(rebound[0].reason, 'rebound-to-current-instance');
  const afterRebind = hookText();
  assert.ok(afterRebind.includes('数据 B'), 'the hook now binds the current data directory');
  assert.ok(!afterRebind.includes('数据 A'), 'the stale binding is gone');

  // A second pass with the same instance must be a no-op (no rewrite).
  const again = await migrateManagedHooks(runtimeB);
  assert.strictEqual(again[0].ok, true);
  assert.strictEqual(again[0].reason, 'already-migrated');
  assert.strictEqual(again[0].updated, false, 'an already-current binding is not rewritten');
  assert.strictEqual(hookText(), afterRebind, 'the hook file is byte-identical');

  // A third-party hook is reported as a conflict and preserved verbatim.
  const hookPath = hookManager.readHookStatus({ repoPath: repo }).hookPath;
  const thirdParty = '#!/bin/sh\necho third-party-marker\nexit 0\n';
  fs.writeFileSync(hookPath, thirdParty);
  const conflicted = await migrateManagedHooks(runtimeB);
  assert.strictEqual(conflicted[0].ok, false);
  assert.strictEqual(conflicted[0].status, 'conflict');
  assert.strictEqual(fs.readFileSync(hookPath, 'utf8'), thirdParty, 'the third-party hook is preserved');
  const conflictState = runtimeB.projectStore.states.get(projectId);
  assert.strictEqual(conflictState.hook.lastConflict.code, 'HOOK_CONFLICT');

  // A managed hook bound to ANOTHER project is likewise preserved (both the
  // marker line and the command line identify the owner).
  fs.writeFileSync(hookPath, afterRebind
    .replace(`--project-id '${projectId}'`, `--project-id 'project-other'`)
    .replace(`"projectId":"${projectId}"`, `"projectId":"project-other"`));
  const wrongProject = await migrateManagedHooks(runtimeB);
  assert.strictEqual(wrongProject[0].ok, false);
  assert.strictEqual(wrongProject[0].status, 'conflict');
  assert.ok(fs.readFileSync(hookPath, 'utf8').includes("project-other"), 'the other project\'s hook is preserved');

  console.log('hook-relocation-rebind-test PASS');
})().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}).finally(() => {
  fs.rmSync(TEMP, { recursive: true, force: true });
});
