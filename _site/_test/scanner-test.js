// Run: node _site/_test/scanner-test.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { CommitScanner, scanProject } = require('../lib/scanner');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), `kb-scanner-${process.pid}-`));

function git(repo, args) {
  const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed`);
  return String(result.stdout || '').trim();
}

function initRepo(name) {
  const repo = path.join(temp, name);
  fs.mkdirSync(repo, { recursive: true });
  git(repo, ['init', '--initial-branch=main']);
  git(repo, ['config', 'user.email', 'scanner@example.test']);
  git(repo, ['config', 'user.name', 'Scanner Test']);
  return repo;
}

function commit(repo, index) {
  fs.writeFileSync(path.join(repo, `${index}.txt`), `${index}\n`, 'utf8');
  git(repo, ['add', `${index}.txt`]);
  git(repo, ['commit', '-m', `commit ${index}`]);
  return git(repo, ['rev-parse', 'HEAD']);
}

(async () => {
  const scanner = new CommitScanner({ batchSize: 2 });
  const emptyRepo = initRepo('empty');
  const empty = await scanner.scan({ repoPath: emptyRepo }, { trackingMode: 'normal', trackingStartCommit: null, lastAnalyzedCommit: null });
  assert.strictEqual(empty.status, 'empty-repo');
  assert.deepStrictEqual(empty.commits, []);

  const repo = initRepo('multi');
  const importedHead = commit(repo, 1);
  const initial = await scanner.scan({ repoPath: repo }, { trackingMode: 'normal', trackingStartCommit: null, lastAnalyzedCommit: null });
  assert.strictEqual(initial.status, 'establish-tracking');
  assert.strictEqual(initial.head, importedHead);
  assert.strictEqual(initial.commits.length, 0, 'pre-import history must not be analyzed');

  const second = commit(repo, 2);
  const third = commit(repo, 3);
  const fourth = commit(repo, 4);
  const pending = await scanner.scan({ repoPath: repo }, { trackingMode: 'normal', trackingStartCommit: importedHead, lastAnalyzedCommit: null });
  assert.deepStrictEqual(pending.commits, [second, third]);
  assert.strictEqual(pending.pendingCount, 3);
  assert.deepStrictEqual(pending.continuation, { remaining: 1, after: third });

  const next = await scanner.scan({ repoPath: repo }, { trackingMode: 'normal', trackingStartCommit: importedHead, lastAnalyzedCommit: third });
  assert.deepStrictEqual(next.commits, [fourth], 'lastAnalyzedCommit must take priority over trackingStartCommit');
  assert.strictEqual(next.continuation, null);

  const firstAfterEmpty = await scanner.scan({ repoPath: repo }, { trackingMode: 'empty-repo', trackingStartCommit: null, lastAnalyzedCommit: null });
  assert.deepStrictEqual(firstAfterEmpty.commits, [importedHead, second], 'empty-repo mode should start with the root commit and expose continuation');

  const legacyView = await scanProject({ slug: 'legacy-view', gitPath: repo, trackingStartCommit: importedHead }, { batchSize: 10 });
  assert.strictEqual(legacyView.repoStatus, 'ok');
  assert.deepStrictEqual(legacyView.commits.map(item => item.hash), [second, third, fourth]);

  const tree = git(repo, ['write-tree']);
  const rewritten = git(repo, ['commit-tree', tree, '-m', 'rewritten']);
  git(repo, ['update-ref', 'refs/heads/main', rewritten]);
  const diverged = await scanner.scan({ repoPath: repo }, { trackingMode: 'normal', trackingStartCommit: importedHead, lastAnalyzedCommit: null });
  assert.strictEqual(diverged.status, 'history-diverged');
  assert.strictEqual(diverged.head, rewritten);
  assert.deepStrictEqual(diverged.commits, []);

  const missing = await scanner.scan({ repoPath: path.join(temp, 'missing') }, { trackingMode: 'normal' });
  assert.strictEqual(missing.status, 'not-git');
  console.log('scanner-test PASS');
})().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}).finally(() => {
  fs.rmSync(temp, { recursive: true, force: true });
});
