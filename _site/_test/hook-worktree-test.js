const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { installHook, readHookStatus, migrateManagedHook, LEGACY_HOOK_MARKER } = require('../lib/hook-manager');

const ROOT = path.resolve(__dirname, '..', '..');
const TRIGGER = path.join(ROOT, '_site', 'scripts', 'hook-trigger.js');

function git(repo, args) {
  const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed`);
  return String(result.stdout || '').trim();
}

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-hook-worktree-'));
const main = path.join(base, 'main repo');
const linked = path.join(base, 'linked worktree');
fs.mkdirSync(main, { recursive: true });
git(main, ['init', '--initial-branch=main']);
git(main, ['config', 'user.email', 'hook@example.invalid']);
git(main, ['config', 'user.name', 'Hook Test']);
fs.writeFileSync(path.join(main, 'README.md'), '# main\n');
git(main, ['add', 'README.md']);
git(main, ['commit', '-m', 'initial']);
git(main, ['worktree', 'add', '-b', 'linked', linked]);

git(linked, ['config', 'core.hooksPath', '.custom-hooks']);
const installed = installHook({ repoPath: linked, projectId: 'project-worktree', triggerScriptPath: TRIGGER });
const authoritativeHooks = git(linked, ['rev-parse', '--path-format=absolute', '--git-path', 'hooks']);
assert.strictEqual(path.resolve(path.dirname(installed.hookPath)), path.resolve(authoritativeHooks));
assert.strictEqual(readHookStatus({ repoPath: linked, projectId: 'project-worktree' }).installed, true);

fs.writeFileSync(installed.hookPath, `#!/bin/sh\n${LEGACY_HOOK_MARKER} — old\nexit 0\n`);
const migrated = migrateManagedHook({ repoPath: linked, projectId: 'project-worktree', triggerScriptPath: TRIGGER });
assert.strictEqual(migrated.migrated, true);
const second = migrateManagedHook({ repoPath: linked, projectId: 'project-worktree', triggerScriptPath: TRIGGER });
assert.strictEqual(second.migrated, false);
assert.strictEqual(second.reason, 'current');

console.log('hook-worktree-test PASS');
