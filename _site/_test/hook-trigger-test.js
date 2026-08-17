const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  HOOK_MARKER,
  installHook,
  uninstallHook,
  readHookStatus,
  parseManagedMarker,
} = require('../lib/hook-manager');

const ROOT = path.resolve(__dirname, '..', '..');
const TRIGGER = path.join(ROOT, '_site', 'scripts', 'hook-trigger.js');

function git(repo, args) {
  const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed`);
  return String(result.stdout || '').trim();
}

function makeRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-hook-v2-repo-'));
  git(repo, ['init', '--initial-branch=main']);
  git(repo, ['config', 'user.email', 'hook@example.invalid']);
  git(repo, ['config', 'user.name', 'Hook Test']);
  fs.writeFileSync(path.join(repo, 'README.md'), '# hook\n');
  git(repo, ['add', 'README.md']);
  git(repo, ['commit', '-m', 'initial']);
  return repo;
}

const repo = makeRepo();
const claudePath = path.join(repo, 'CLAUDE.md');
fs.writeFileSync(claudePath, '# user-owned\n');
const projectId = 'project-hook-test';

const installed = installHook({ repoPath: repo, projectId, triggerScriptPath: TRIGGER });
assert.strictEqual(installed.ok, true);
assert(fs.existsSync(installed.hookPath));
const body = fs.readFileSync(installed.hookPath, 'utf8');
assert(body.includes(HOOK_MARKER));
assert(body.includes('--project-id'));
assert(body.includes('--repo-root "$REPO_ROOT"'));
assert(body.includes('git rev-parse --show-toplevel'));
assert(!body.includes(repo.replace(/\\/g, '/')), 'managed hook must not embed the imported repo path');
assert.strictEqual(parseManagedMarker(body).projectId, projectId);
assert.strictEqual(fs.readFileSync(claudePath, 'utf8'), '# user-owned\n', 'Hook install must not modify CLAUDE.md');

const repeated = installHook({ repoPath: repo, projectId, triggerScriptPath: TRIGGER });
assert.strictEqual(repeated.updated, false);
assert.strictEqual(fs.readFileSync(installed.hookPath, 'utf8'), body);
assert.strictEqual(readHookStatus({ repoPath: repo, projectId }).installed, true);

const removed = uninstallHook({ repoPath: repo, projectId });
assert.strictEqual(removed.removed, true);
assert.strictEqual(fs.readFileSync(claudePath, 'utf8'), '# user-owned\n', 'Hook uninstall must not modify CLAUDE.md');

fs.writeFileSync(installed.hookPath, '#!/bin/sh\necho user-hook\n');
assert.throws(() => installHook({ repoPath: repo, projectId, triggerScriptPath: TRIGGER }), error => error.code === 'HOOK_CONFLICT');
assert.throws(() => uninstallHook({ repoPath: repo, projectId }), error => error.code === 'HOOK_CONFLICT');
assert(fs.readFileSync(installed.hookPath, 'utf8').includes('user-hook'));

const offlineData = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-hook-offline-'));
const offline = spawnSync(process.execPath, [TRIGGER, '--project-id', projectId, '--repo-root', repo, '--port', '65530'], {
  encoding: 'utf8',
  timeout: 10_000,
  env: { ...process.env, KB_DATA_DIR: offlineData, KB_SKIP_MIGRATION: '1' },
});
assert.strictEqual(offline.status, 0, offline.stderr);
const hooksLogDir = path.join(offlineData, 'logs', 'hooks');
assert(fs.existsSync(hooksLogDir));
const lines = fs.readdirSync(hooksLogDir).flatMap(file => fs.readFileSync(path.join(hooksLogDir, file), 'utf8').trim().split(/\r?\n/).filter(Boolean).map(JSON.parse));
assert(lines.some(line => line.schema === 'log/v2' && line.event === 'hook.notification.degraded'));

console.log('hook-trigger-test PASS');
