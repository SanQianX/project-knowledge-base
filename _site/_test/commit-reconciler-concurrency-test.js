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
  await projects.create(projectId, {
    displayName: projectId,
    storageName: projectId,
    repoPath: repo,
    knowledgePath: path.join(temp, 'knowledge', projectId),
    aiProfileId: 'test-profile',
  }, state);
  await registry.add(projectId, { displayName: projectId });
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
  await addProject('project-a', repoA, { trackingStartCommit: baselineA, trackingMode: 'normal' });
  await projects.appendRequirement('project-a', {
    schema: SCHEMAS.requirement,
    id: 'req-project-a',
    ts: '2026-08-17T00:00:00.000Z',
    projectId: 'project-a',
    client: 'codex',
    sessionId: 'session-a',
    conversationId: null,
    branch: 'main',
    headAtRecord: baselineA,
    requirement: 'Implement the next project A change.',
    requirementHash: 'sha256:req-project-a',
    explicitCommit: null,
  });
  const processor = new TestClaimProcessor();
  processor.gate(firstA);
  const reconciler = new CommitReconciler({
    layout, registryStore: registry, projectStore: projects, claimProcessor: processor, logger, batchSize: 1,
  });
  const hookRun = reconciler.reconcile('project-a', 'git-hook');
  await processor.gateStarted;
  const startupRun = reconciler.reconcile('project-a', 'startup');
  processor.releaseGate();
  const [hookResult, startupResult] = await Promise.all([hookRun, startupRun]);
  assert.strictEqual(hookResult.operationId, startupResult.operationId, 'overlapping triggers should await the same in-flight sweep');
  assert.deepStrictEqual(processor.calls.filter(call => call.projectId === 'project-a').map(call => call.commitSha), [firstA, secondA], 'each commit should be processed once in order across batch continuations');
  assert.strictEqual(projects.readState('project-a').lastAnalyzedCommit, secondA);
  assert.deepStrictEqual(processor.calls[0].requirementIds, ['req-project-a'], 'unique session ancestry should bind the recorded requirement');
  assert.deepStrictEqual(processor.calls[1].requirementIds, [], 'advanced requirement must not be rebound to a later commit');

  const idle = await reconciler.reconcile('project-a', 'startup');
  assert.strictEqual(idle.status, 'idle');
  assert(logs.some(log => log.level === 'debug' && log.event === 'reconcile.no_pending'), 'no pending commits should be debug, not info');

  const repoB = initRepo('repo-b');
  const baselineB = git(repoB, ['rev-parse', 'HEAD']);
  const commitsB = [commit(repoB, 'first-b'), commit(repoB, 'second-b'), commit(repoB, 'third-b')];
  await addProject('project-b', repoB, { trackingStartCommit: baselineB, trackingMode: 'normal' });
  processor.failOnceCommit = commitsB[1];
  const failed = await reconciler.reconcile('project-b', 'git-hook');
  assert.strictEqual(failed.ok, false);
  assert.deepStrictEqual(processor.calls.filter(call => call.projectId === 'project-b').map(call => call.commitSha), commitsB.slice(0, 2), 'failure on second commit must stop the third');
  const failedClaim = projects.readState('project-b').analysis.activeClaim;
  assert.strictEqual(failedClaim.commitSha, commitsB[1]);
  await projects.appendRequirement('project-b', {
    schema: SCHEMAS.requirement,
    id: 'req-future',
    ts: '2026-08-17T00:00:10.000Z',
    projectId: 'project-b',
    client: 'codex',
    sessionId: 'future-session',
    conversationId: null,
    branch: 'main',
    headAtRecord: commitsB[1],
    requirement: 'Recorded after the failed claim.',
    requirementHash: 'sha256:req-future',
    explicitCommit: null,
  });
  const retried = await reconciler.reconcile('project-b', 'startup');
  assert.strictEqual(retried.ok, true);
  const secondCommitCalls = processor.calls.filter(call => call.projectId === 'project-b' && call.commitSha === commitsB[1]);
  assert.strictEqual(secondCommitCalls.length, 2);
  assert.deepStrictEqual(secondCommitCalls[1].requirementIds, secondCommitCalls[0].requirementIds, 'retry must reuse frozen requirement IDs and ignore future records');
  assert(secondCommitCalls[1].attempt > secondCommitCalls[0].attempt, 'retry should increment the frozen claim attempt');
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
