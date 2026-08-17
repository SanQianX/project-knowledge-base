// Run: node _site/_test/commit-evidence-test.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { CommitScanner, TrustedGitReader, EMPTY_TREE_SHA } = require('../lib/scanner');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), `kb-commit-evidence-${process.pid}-`));
const repo = path.join(temp, 'repo');

function git(args) {
  const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed`);
  return String(result.stdout || '').trim();
}

function commitFile(name, content, message) {
  fs.mkdirSync(path.dirname(path.join(repo, name)), { recursive: true });
  fs.writeFileSync(path.join(repo, name), content);
  git(['add', name]);
  git(['commit', '-m', message]);
  return git(['rev-parse', 'HEAD']);
}

(async () => {
  fs.mkdirSync(repo, { recursive: true });
  git(['init', '--initial-branch=main']);
  git(['config', 'user.email', 'evidence@example.test']);
  git(['config', 'user.name', 'Evidence Test']);
  const rootCommit = commitFile('src/root.txt', 'root\n', 'root commit');
  const binaryCommit = commitFile('assets/sample.bin', Buffer.from([0, 1, 2, 3, 255]), 'add binary');

  git(['checkout', '-b', 'feature']);
  const featureCommit = commitFile('src/feature.txt', 'feature\n', 'feature side');
  git(['checkout', 'main']);
  const mainCommit = commitFile('src/main.txt', 'main\n', 'main side');
  git(['merge', '--no-ff', 'feature', '-m', 'merge feature']);
  const mergeCommit = git(['rev-parse', 'HEAD']);

  const scanner = new CommitScanner({ batchSize: 2 });
  const firstBatch = await scanner.scan({ repoPath: repo }, {
    trackingMode: 'normal', trackingStartCommit: rootCommit, lastAnalyzedCommit: null,
  });
  assert.strictEqual(firstBatch.status, 'ok');
  assert.strictEqual(firstBatch.commits.length, 2, 'batch limit should return a bounded first page');
  assert(firstBatch.continuation && firstBatch.continuation.remaining === 2, 'continuation must expose remaining work');
  const all = await new TrustedGitReader().listCommits(repo, rootCommit, mergeCommit);
  assert.deepStrictEqual(all, [binaryCommit, mainCommit, featureCommit, mergeCommit], 'reverse topo order must include both branch commits and the merge commit');

  const rootEvidence = await scanner.collectEvidence({ repoPath: repo }, rootCommit, { branch: 'main' });
  assert.strictEqual(rootEvidence.patchMode, 'root-empty-tree');
  assert.strictEqual(rootEvidence.patchBase, EMPTY_TREE_SHA);
  assert(rootEvidence.patch.includes('src/root.txt'), 'root evidence must contain a real empty-tree patch');

  const binaryEvidence = await scanner.collectEvidence({ repoPath: repo }, binaryCommit, { branch: 'main' });
  assert(binaryEvidence.files.some(file => file.path === 'assets/sample.bin' && file.binary), 'name-status manifest should identify binary files');
  assert(binaryEvidence.patch.includes('GIT binary patch'), 'binary patch evidence should be preserved');

  const mergeEvidence = await scanner.collectEvidence({ repoPath: repo }, mergeCommit, { branch: 'main' });
  assert.strictEqual(mergeEvidence.parents.length, 2, 'merge metadata should include every parent');
  assert.strictEqual(mergeEvidence.patchMode, 'merge-first-parent');
  assert.strictEqual(mergeEvidence.patchBase, mainCommit, 'merge patch must compare against the first parent');
  assert(mergeEvidence.patch.includes('src/feature.txt'), 'first-parent merge patch should show the introduced feature side');

  const limitedReader = new TrustedGitReader({ maxPatchBytes: 8 });
  const limited = await limitedReader.collectEvidence(repo, mergeCommit, { branch: 'main' });
  assert.strictEqual(limited.patch, null, 'oversized patch must be explicitly omitted rather than silently truncated');
  assert.strictEqual(limited.patchOmitted, true);
  assert(limited.omittedReason.includes('8-byte'));
  assert(limited.patchHash.startsWith('sha256:') && limited.evidenceHash.startsWith('sha256:'), 'full omitted evidence must retain hashes');

  console.log('commit-evidence-test PASS');
})().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}).finally(() => {
  fs.rmSync(temp, { recursive: true, force: true });
});
