// Run: node _site/_test/commit-evidence-test.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { CommitScanner, TrustedGitReader, EMPTY_TREE_SHA, sha256 } = require('../lib/scanner');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), `kb-commit-evidence-${process.pid}-`));
const repo = path.join(temp, 'repo');

function git(args) {
  const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed`);
  return String(result.stdout || '').trim();
}

function gitRaw(args) {
  const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed`);
  return String(result.stdout || '');
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

  git(['mv', 'src/root.txt', 'src/renamed.txt']);
  git(['commit', '-m', 'rename root evidence']);
  const renameCommit = git(['rev-parse', 'HEAD']);
  const renameEvidence = await scanner.collectEvidence({ repoPath: repo }, renameCommit, { branch: 'main' });
  assert(renameEvidence.files.some(file => file.oldPath === 'src/root.txt' && file.path === 'src/renamed.txt'), 'rename evidence must retain old and new paths');

  const largeContent = Array.from({ length: 42000 }, (_, index) => `${String(index).padStart(6, '0')} ${'exact-evidence-'.repeat(5)}\n`).join('');
  const largeCommit = commitFile('src/large.txt', largeContent, 'large exact evidence');
  const evidenceRoot = path.join(temp, 'run', 'input', 'evidence');
  const largeReader = new TrustedGitReader({ maxPatchBytes: 2 * 1024 * 1024, maxChunkBytes: 128 * 1024 });
  const large = await largeReader.collectEvidence(repo, largeCommit, { branch: 'main', evidenceRoot });
  assert(large.patchBytes > 2 * 1024 * 1024, 'fixture must cross the production inline threshold');
  assert.strictEqual(large.patch, null, 'large patch should be referenced by exact chunks instead of prompt inline text');
  assert.strictEqual(large.patchChunked, true);
  assert.strictEqual(large.patchOmitted, false, 'exact chunk evidence must not be represented as omitted');
  assert(large.evidenceBundle.chunkCount > 1, 'large patch should be split into ordered chunks');
  const manifest = largeReader.verifyEvidence(large);
  assert.deepStrictEqual(manifest.chunks.map(chunk => chunk.sequence), manifest.chunks.map((_, index) => index + 1));
  assert(manifest.chunks.every(chunk => chunk.sha256.startsWith('sha256:') && chunk.bytes > 0 && chunk.sourcePaths.includes('src/large.txt')));
  const reconstructed = manifest.chunks.map(chunk => fs.readFileSync(path.join(evidenceRoot, ...chunk.path.split('/')))).join('');
  const exactGitPatch = gitRaw(['diff', '--no-ext-diff', '--binary', '--find-renames', '--unified=3', renameCommit, largeCommit]);
  assert.strictEqual(Buffer.byteLength(reconstructed), Buffer.byteLength(exactGitPatch));
  assert.strictEqual(sha256(reconstructed), large.patchHash, 'ordered chunks must exactly reconstruct the full Git diff hash');

  const corruptPath = path.join(evidenceRoot, ...manifest.chunks[0].path.split('/'));
  fs.appendFileSync(corruptPath, 'corrupt');
  assert.throws(() => largeReader.verifyEvidence(large), error => error.code === 'EVIDENCE_INTEGRITY_FAILED', 'corrupt chunks must fail with a typed evidence error');

  const missingRootReader = new TrustedGitReader({ maxPatchBytes: 8 });
  await assert.rejects(missingRootReader.collectEvidence(repo, mergeCommit, { branch: 'main' }), error => error.code === 'EVIDENCE_INTEGRITY_FAILED');

  console.log('commit-evidence-test PASS');
})().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}).finally(() => {
  fs.rmSync(temp, { recursive: true, force: true });
});
