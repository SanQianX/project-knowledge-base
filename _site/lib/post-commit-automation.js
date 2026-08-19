const fs = require('fs');
const path = require('path');
const { SCHEMAS, DomainError, validateProjectId } = require('./contracts');
const { StorageLayout } = require('./storage-layout');
const { ProjectRegistryStore } = require('./project-registry-store');
const { ProjectStore } = require('./project-store');
const { runGit } = require('./project-lifecycle-service');
const { CommitReconciler, reconcileProjectCommits } = require('./commit-reconciler');
const { renderCommitPrompt } = require('./commit-prompt');

function stores(deps = {}) {
  const layout = deps.layout || new StorageLayout(deps);
  return {
    layout,
    registryStore: deps.registryStore || new ProjectRegistryStore({ layout }),
    projectStore: deps.projectStore || new ProjectStore({ layout }),
  };
}

async function handlePostCommitEvent(event = {}, deps = {}) {
  if (event.schema !== SCHEMAS.hookEvent) throw new DomainError('SCHEMA_UNSUPPORTED', 'Hook event must use hook-event/v2.', { status: 409 });
  const projectId = validateProjectId(event.projectId);
  if (!event.repoRoot) throw new DomainError('INVALID_ARGUMENT', 'Hook event repoRoot is required.');
  const resolved = stores(deps);
  if (!resolved.registryStore.readDisplaySnapshot(projectId)) throw new DomainError('PROJECT_NOT_FOUND', 'Hook projectId is not registered.', { status: 404 });
  const config = resolved.projectStore.readConfig(projectId);
  const runtimeRoot = path.resolve(runGit(path.resolve(event.repoRoot), ['rev-parse', '--show-toplevel']).stdout);
  const commonDir = path.resolve(runGit(runtimeRoot, ['rev-parse', '--path-format=absolute', '--git-common-dir']).stdout);
  if (config.repoIdentity && config.repoIdentity.commonDir
    && !resolved.layout.pathsEqual(config.repoIdentity.commonDir, commonDir)) {
    if (fs.existsSync(config.repoPath)) {
      throw new DomainError('PROJECT_NOT_FOUND', 'Hook Git identity does not match projectId.', { status: 404 });
    }
    const state = resolved.projectStore.readState(projectId);
    const baseline = state.lastAnalyzedCommit || state.trackingStartCommit;
    if (baseline) {
      const reachable = runGit(runtimeRoot, ['merge-base', '--is-ancestor', baseline, 'HEAD'], { allowFailure: true });
      if (!reachable.ok) throw new DomainError('PROJECT_NOT_FOUND', 'Moved Hook repository does not contain the project baseline.', { status: 404 });
    }
  }
  if (!resolved.layout.pathsEqual(config.repoPath, runtimeRoot)) {
    // Only the versioned Hook path reaches this update, after projectId and Git identity checks above.
    await resolved.projectStore.updateConfig(projectId, { repoPath: runtimeRoot }, { allowRepoPath: true });
  }
  if (event.boundary && event.boundary.status === 'captured' && event.boundary.boundary) {
    const boundary = event.boundary.boundary;
    if (boundary.projectId !== projectId || boundary.commitSha !== event.head) {
      throw new DomainError('INVALID_ARGUMENT', 'Hook boundary identity does not match the Hook event.');
    }
    const commitExists = runGit(runtimeRoot, ['cat-file', '-e', `${boundary.commitSha}^{commit}`], { allowFailure: true });
    if (!commitExists.ok) throw new DomainError('INVALID_ARGUMENT', 'Hook boundary commit does not exist in the repository.');
    // Ordering (T13): the boundary was appended before the Hook notified us;
    // drain the journal THROUGH the boundary sequence before any snapshot is
    // bound, so every same-workspace event <= boundaryEndCursor is already in
    // the ConversationStore (or deterministically handled) at freeze time.
    if (deps.bridgeConsumerService && typeof deps.bridgeConsumerService.drainThrough === 'function') {
      await deps.bridgeConsumerService.drainThrough(Number(boundary.journalSequence), 'commit-boundary');
    }
    if (deps.conversationStore && typeof deps.conversationStore.writeBoundary === 'function') {
      deps.conversationStore.writeBoundary(projectId, boundary);
    }
  } else if (event.boundary && event.boundary.status === 'unavailable' && deps.logger && typeof deps.logger.warn === 'function') {
    await deps.logger.warn('conversation.boundary_gap', 'Conversation boundary capture gap was reported by the Git Hook.', {
      projectId,
      operationId: deps.operationId || event.operationId || '',
      commitSha: event.head || '',
      phase: 'boundary',
      context: {
        gapId: event.boundary.gap && event.boundary.gap.gapId || '',
        reason: event.boundary.gap && event.boundary.gap.reason || 'unavailable',
      },
    });
  }
  return reconcileProjectCommits(projectId, 'git-hook', {
    ...deps,
    ...resolved,
  });
}

async function dispatchPendingAutomations(options = {}, deps = {}) {
  if (typeof deps.readProjects === 'function' && !deps.projectStore && !deps.registryStore) {
    return { ok: true, dispatched: 0, results: [], legacyStoreSkipped: true };
  }
  const resolved = stores(deps);
  const projectIds = resolved.registryStore.listIds().filter(projectId => resolved.projectStore.readConfig(projectId).enabled !== false);
  const concurrency = Math.max(1, Math.min(Number(options.concurrency || deps.startupConcurrency || 3), 8));
  const results = new Array(projectIds.length);
  let cursor = 0;
  async function worker() {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= projectIds.length) return;
      const projectId = projectIds[index];
      try {
        results[index] = await reconcileProjectCommits(projectId, 'startup', { ...deps, ...resolved });
      } catch (error) {
        results[index] = { ok: false, projectId, error: { code: error.code || 'INVALID_ARGUMENT', message: error.message } };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, projectIds.length) }, () => worker()));
  return {
    ok: results.every(result => result && result.ok),
    dispatched: results.reduce((total, result) => total + Number(result && result.processed && result.processed.length || 0), 0),
    results,
  };
}

function cleanupOrphanedRuns(_projects, deps = {}) {
  if (!deps.projectStore && !deps.registryStore && !deps.layout) {
    return { activeClaims: 0, recoveredFromFrozenClaims: 0, legacyStoreSkipped: true };
  }
  const resolved = stores(deps);
  let activeClaims = 0;
  for (const projectId of resolved.registryStore.listIds()) {
    if (resolved.projectStore.readState(projectId).analysis.activeClaim) activeClaims += 1;
  }
  return { activeClaims, recoveredFromFrozenClaims: activeClaims };
}

// Transitional read-only shims keep the pre-T10 server observable while the
// legacy queue/routes are being removed. They never enqueue or discover work.
function getQueueSize() { return 0; }
function drainQueue() { return []; }
function listAutomationRuns() { return []; }

module.exports = {
  CommitReconciler,
  cleanupOrphanedRuns,
  drainQueue,
  dispatchPendingAutomations,
  handlePostCommitEvent,
  getQueueSize,
  listAutomationRuns,
  reconcileProjectCommits,
  renderCommitPrompt,
};
