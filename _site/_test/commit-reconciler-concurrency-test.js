// Run: node _site/_test/commit-reconciler-concurrency-test.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { SCHEMAS } = require('../lib/contracts');
const { StorageLayout } = require('../lib/storage-layout');
const { ProjectRegistryStore } = require('../lib/project-registry-store');
const { ProjectStore } = require('../lib/project-store');
const { ConversationStore } = require('../lib/conversation-store');
const { CommitReconciler } = require('../lib/commit-reconciler');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), `kb-reconciler-${process.pid}-`));
const layout = new StorageLayout({ dataDir: path.join(temp, 'data') });
const registry = new ProjectRegistryStore({ layout });
const projects = new ProjectStore({ layout });

function git(repo, args) {
  const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed`);
  return String(result.stdout || '').trim();
}

function initRepo(name, empty = false) {
  const repo = path.join(temp, name);
  fs.mkdirSync(repo, { recursive: true });
  git(repo, ['init', '--initial-branch=main']);
  git(repo, ['config', 'user.email', 'reconciler@example.test']);
  git(repo, ['config', 'user.name', 'Reconciler Test']);
  if (!empty) commit(repo, 'initial');
  return repo;
}

function commit(repo, label) {
  const file = path.join(repo, `${label.replace(/[^a-z0-9]/gi, '-')}.txt`);
  fs.writeFileSync(file, `${label}\n`, 'utf8');
  git(repo, ['add', path.basename(file)]);
  git(repo, ['commit', '-m', label]);
  return git(repo, ['rev-parse', 'HEAD']);
}

async function addProject(projectId, repo, state) {
  const repoIdentity = { commonDir: path.join(repo, '.git') };
  await projects.create(projectId, {
    displayName: projectId,
    storageName: projectId,
    repoPath: repo,
    knowledgePath: path.join(temp, 'knowledge', projectId),
    aiProfileId: 'test-profile',
    repoIdentity,
  }, {
    conversationBaselineCursor: 0,
    conversation: { lastConsumedCursor: 0, captureStatus: 'captured' },
    ...state,
  });
  await registry.add(projectId, { displayName: projectId });
  return repoIdentity;
}

class TestClaimProcessor {
  constructor() {
    this.calls = [];
    this.failOnceCommit = null;
    this.failed = false;
    this.gateCommit = null;
    this.gateStarted = null;
    this.releaseGate = null;
  }

  gate(commitSha) {
    this.gateCommit = commitSha;
    this.gateStarted = new Promise(resolve => { this.markGateStarted = resolve; });
    this.gateRelease = new Promise(resolve => { this.releaseGate = resolve; });
  }

  async processClaim(input) {
    this.calls.push({
      projectId: input.projectId,
      commitSha: input.claim.commitSha,
      runId: input.claim.runId,
      promptHash: input.claim.promptHash,
      retrievalManifestHash: input.claim.retrievalManifestHash,
      requirementIds: [...input.claim.requirementIds],
      attempt: input.claim.attempt,
    });
    if (input.claim.commitSha === this.gateCommit && this.markGateStarted) {
      this.markGateStarted();
      this.markGateStarted = null;
      await this.gateRelease;
    }
    if (input.claim.commitSha === this.failOnceCommit && !this.failed) {
      this.failed = true;
      throw new Error('injected analysis failure');
    }
    await projects.updateState(input.projectId, state => {
      assert.strictEqual(state.analysis.activeClaim.commitSha, input.claim.commitSha, 'processor must advance only the active claim');
      state.lastAnalyzedCommit = input.claim.commitSha;
      state.analysis.consumedRequirementIds = [...new Set([
        ...(state.analysis.consumedRequirementIds || []),
        ...input.claim.requirementIds,
      ])];
      state.analysis.activeClaim = null;
      state.analysis.status = 'state.advanced';
      state.analysis.lastError = null;
      state.index.dirty = true;
      state.index.sinceCommit = state.index.sinceCommit || input.claim.commitSha;
      state.index.generation += 1;
    });
    return { stateAdvanced: true };
  }
}

(async () => {
  await registry.initialize();
  const logs = [];
  const logger = {};
  for (const level of ['debug', 'info', 'warn', 'error']) logger[level] = async (event, message, context) => logs.push({ level, event, message, context });

  const repoA = initRepo('repo-a');
  const baselineA = git(repoA, ['rev-parse', 'HEAD']);
  const firstA = commit(repoA, 'first-a');
  const secondA = commit(repoA, 'second-a');
  const repoIdentityA = await addProject('project-a', repoA, { trackingStartCommit: baselineA, trackingMode: 'normal' });
  const conversations = new ConversationStore({ layout, projectStore: projects });
  await conversations.appendEvent('project-a', {
    eventId: 'req-project-a',
    sequence: 1,
    source: 'codex',
    eventType: 'user_prompt',
    role: 'user',
    content: 'Implement the next project A change.',
    sessionId: 'session-a',
    turnId: 'turn-project-a',
    projectPath: repoA,
    repoIdentity: repoIdentityA,
    branch: 'main',
    headAtCapture: baselineA,
    capturedAt: '2026-08-17T00:00:00.000Z',
    identityConfidence: 'high',
    captureStatus: 'captured',
  });
  conversations.writeBoundary('project-a', { commitSha: firstA, repoIdentity: repoIdentityA, parentShas: [baselineA], branch: 'main', committedAt: '2026-08-17T00:01:00.000Z', bridgeCursorAtCommit: 2, journalSequence: 2, openTurnIdsAtCommit: [], operationId: 'op-project-a-1' });
  conversations.writeBoundary('project-a', { commitSha: secondA, repoIdentity: repoIdentityA, parentShas: [firstA], branch: 'main', committedAt: '2026-08-17T00:02:00.000Z', bridgeCursorAtCommit: 3, journalSequence: 3, openTurnIdsAtCommit: [], operationId: 'op-project-a-2' });
  const processor = new TestClaimProcessor();
  processor.gate(firstA);
  const reconciler = new CommitReconciler({
    layout, registryStore: registry, projectStore: projects, conversationStore: conversations, claimProcessor: processor, logger, batchSize: 1,
  });
  const hookRun = reconciler.reconcile('project-a', 'git-hook');
  await processor.gateStarted;
  const startupRun = reconciler.reconcile('project-a', 'startup');
  processor.releaseGate();
  const [hookResult, startupResult] = await Promise.all([hookRun, startupRun]);
  assert.strictEqual(hookResult.operationId, startupResult.operationId, 'overlapping triggers should await the same in-flight sweep');
  assert.deepStrictEqual(processor.calls.filter(call => call.projectId === 'project-a').map(call => call.commitSha), [firstA, secondA], 'each commit should be processed once in order across batch continuations');
  assert.strictEqual(projects.readState('project-a').lastAnalyzedCommit, secondA);
  assert.deepStrictEqual(processor.calls[0].requirementIds, ['req-project-a'], 'the durable sequence window should bind the recorded user event');
  assert.deepStrictEqual(processor.calls[1].requirementIds, [], 'advanced requirement must not be rebound to a later commit');

  const idle = await reconciler.reconcile('project-a', 'startup');
  assert.strictEqual(idle.status, 'idle');
  assert(logs.some(log => log.level === 'debug' && log.event === 'reconcile.no_pending'), 'no pending commits should be debug, not info');

  const repoB = initRepo('repo-b');
  const baselineB = git(repoB, ['rev-parse', 'HEAD']);
  const commitsB = [commit(repoB, 'first-b'), commit(repoB, 'second-b'), commit(repoB, 'third-b')];
  const repoIdentityB = await addProject('project-b', repoB, { trackingStartCommit: baselineB, trackingMode: 'normal' });
  conversations.writeBoundary('project-b', { commitSha: commitsB[0], repoIdentity: repoIdentityB, parentShas: [baselineB], branch: 'main', committedAt: '2026-08-17T00:10:00.000Z', bridgeCursorAtCommit: 1, journalSequence: 10, openTurnIdsAtCommit: [], operationId: 'op-project-b-1' });
  conversations.writeBoundary('project-b', { commitSha: commitsB[1], repoIdentity: repoIdentityB, parentShas: [commitsB[0]], branch: 'main', committedAt: '2026-08-17T00:11:00.000Z', bridgeCursorAtCommit: 2, journalSequence: 11, openTurnIdsAtCommit: [], operationId: 'op-project-b-2' });
  conversations.writeBoundary('project-b', { commitSha: commitsB[2], repoIdentity: repoIdentityB, parentShas: [commitsB[1]], branch: 'main', committedAt: '2026-08-17T00:12:00.000Z', bridgeCursorAtCommit: 4, journalSequence: 12, openTurnIdsAtCommit: [], operationId: 'op-project-b-3' });
  processor.failOnceCommit = commitsB[1];
  const failed = await reconciler.reconcile('project-b', 'git-hook');
  assert.strictEqual(failed.ok, false);
  assert.deepStrictEqual(processor.calls.filter(call => call.projectId === 'project-b').map(call => call.commitSha), commitsB.slice(0, 2), 'failure on second commit must stop the third');
  const failedClaim = projects.readState('project-b').analysis.activeClaim;
  assert.strictEqual(failedClaim.commitSha, commitsB[1]);
  await conversations.appendEvent('project-b', {
    eventId: 'req-future',
    sequence: 3,
    source: 'codex',
    eventType: 'user_prompt',
    role: 'user',
    content: 'Recorded after the failed claim.',
    sessionId: 'future-session',
    turnId: 'future-turn',
    projectPath: repoB,
    repoIdentity: repoIdentityB,
    branch: 'main',
    headAtCapture: commitsB[1],
    capturedAt: '2026-08-17T00:11:30.000Z',
    identityConfidence: 'high',
    captureStatus: 'captured',
  });
  const frozenClaim = reconciler.claimStore.read('project-b', commitsB[1]);
  const patchManifest = JSON.parse(fs.readFileSync(frozenClaim.evidence.evidenceBundle.manifestPath, 'utf8'));
  const firstChunkPath = path.join(frozenClaim.evidence.evidenceBundle.root, ...patchManifest.chunks[0].path.split('/'));
  const originalChunk = fs.readFileSync(firstChunkPath);
  fs.appendFileSync(firstChunkPath, 'corrupt-after-claim');
  const corruptRetry = await reconciler.reconcile('project-b', 'startup');
  assert.strictEqual(corruptRetry.ok, false);
  assert.strictEqual(corruptRetry.error.code, 'EVIDENCE_INTEGRITY_FAILED', 'corrupt frozen evidence must produce a typed failure');
  assert.strictEqual(projects.readState('project-b').lastAnalyzedCommit, commitsB[0], 'corrupt evidence must not advance the commit pointer');
  assert.strictEqual(processor.calls.filter(call => call.projectId === 'project-b' && call.commitSha === commitsB[1]).length, 1, 'corrupt evidence must fail before invoking the analyzer');
  fs.writeFileSync(firstChunkPath, originalChunk);
  const retried = await reconciler.reconcile('project-b', 'startup');
  assert.strictEqual(retried.ok, true);
  const secondCommitCalls = processor.calls.filter(call => call.projectId === 'project-b' && call.commitSha === commitsB[1]);
  assert.strictEqual(secondCommitCalls.length, 2);
  assert.deepStrictEqual(secondCommitCalls[1].requirementIds, secondCommitCalls[0].requirementIds, 'retry must reuse frozen requirement IDs and ignore future records');
  assert.strictEqual(secondCommitCalls[1].retrievalManifestHash, secondCommitCalls[0].retrievalManifestHash, 'retry must reuse the frozen authoritative Markdown retrieval manifest');
  assert(secondCommitCalls[1].attempt > secondCommitCalls[0].attempt, 'retry should increment the frozen claim attempt');
  const thirdCommitCall = processor.calls.find(call => call.projectId === 'project-b' && call.commitSha === commitsB[2]);
  assert.deepStrictEqual(thirdCommitCall.requirementIds, ['req-future'], 'a post-Claim event should remain eligible for the next durable boundary window');
  assert.strictEqual(projects.readState('project-b').lastAnalyzedCommit, commitsB[2]);

  const repoTracking = initRepo('repo-tracking');
  const importHead = git(repoTracking, ['rev-parse', 'HEAD']);
  await addProject('project-tracking', repoTracking, { trackingStartCommit: null, trackingMode: 'normal' });
  const callsBeforeTracking = processor.calls.length;
  const tracking = await reconciler.reconcile('project-tracking', 'startup');
  assert.strictEqual(tracking.status, 'tracking-started');
  assert.strictEqual(projects.readState('project-tracking').trackingStartCommit, importHead);
  assert.strictEqual(processor.calls.length, callsBeforeTracking, 'missing baseline with an existing HEAD must establish tracking without analysis');

  const repoEmpty = initRepo('repo-empty', true);
  await addProject('project-empty', repoEmpty, { trackingStartCommit: null, trackingMode: 'empty-repo' });
  const firstEmpty = commit(repoEmpty, 'first-empty');
  const emptyResult = await reconciler.reconcile('project-empty', 'git-hook');
  assert.strictEqual(emptyResult.ok, true);
  assert.strictEqual(projects.readState('project-empty').lastAnalyzedCommit, firstEmpty, 'first commit in an imported empty repo must be analyzed');

  const repoDiverged = initRepo('repo-diverged');
  const baselineDiverged = git(repoDiverged, ['rev-parse', 'HEAD']);
  await addProject('project-diverged', repoDiverged, { trackingStartCommit: baselineDiverged, trackingMode: 'normal' });
  const tree = git(repoDiverged, ['write-tree']);
  const rewrittenRoot = git(repoDiverged, ['commit-tree', tree, '-m', 'rewritten root']);
  git(repoDiverged, ['update-ref', 'refs/heads/main', rewrittenRoot]);
  const diverged = await reconciler.reconcile('project-diverged', 'startup');
  assert.strictEqual(diverged.status, 'history-diverged');
  const divergedState = projects.readState('project-diverged');
  assert.strictEqual(divergedState.trackingStartCommit, baselineDiverged, 'divergence must not guess or move the baseline');
  assert.strictEqual(divergedState.lastAnalyzedCommit, null);

  await assert.rejects(reconciler.reconcile('project-a', 'manual'), error => error.code === 'INVALID_TRIGGER');
  console.log('commit-reconciler-concurrency-test PASS');
})().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}).finally(() => {
  fs.rmSync(temp, { recursive: true, force: true });
});
