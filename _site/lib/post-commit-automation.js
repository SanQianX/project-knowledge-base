const fs = require('fs');
const path = require('path');
const { SCHEMAS, DomainError, validateProjectId } = require('./contracts');
const { StorageLayout } = require('./storage-layout');
const { ProjectRegistryStore } = require('./project-registry-store');
const { ProjectStore } = require('./project-store');
const { runGit } = require('./project-lifecycle-service');
const { CommitReconciler, reconcileProjectCommits } = require('./commit-reconciler');
const { validateSha } = require('./scanner');
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
  const commitSha = validateSha(event.head, 'Hook event head');
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
      const reachable = runGit(runtimeRoot, ['merge-base', '--is-ancestor', baseline, commitSha], { allowFailure: true });
      if (!reachable.ok) throw new DomainError('PROJECT_NOT_FOUND', 'Moved Hook repository does not contain the project baseline.', { status: 404 });
    }
  }
  if (!resolved.layout.pathsEqual(config.repoPath, runtimeRoot)) {
    // Only the versioned Hook path reaches this update, after projectId and Git identity checks above.
    await resolved.projectStore.updateConfig(projectId, { repoPath: runtimeRoot }, { allowRepoPath: true });
  }
  if (event.boundary && event.boundary.status === 'captured' && event.boundary.boundary) {
    const boundary = event.boundary.boundary;
    if (boundary.projectId !== projectId || boundary.commitSha !== commitSha) {
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
  const reconciler = deps.reconciler instanceof CommitReconciler ? deps.reconciler : new CommitReconciler({ ...deps, ...resolved });
  return reconciler.processCommitEvent({ projectId, commitSha, branch: event.branch || '', operationId: deps.operationId || event.operationId || '' });
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

async function recoverOrphanedClaims(deps = {}) {
  const resolved = stores(deps);
  const recovered = [];
  for (const projectId of resolved.registryStore.listIds()) {
    const state = resolved.projectStore.readState(projectId);
    const orphaned = state.analysis.activeClaim;
    if (!orphaned) continue;
    if (orphaned.phase === 'failed' && orphaned.error && orphaned.error.code === 'ORPHANED_CLAIM') continue;
    const recoveredAt = typeof deps.now === 'function' ? deps.now() : new Date().toISOString();
    const error = {
      code: 'ORPHANED_CLAIM',
      message: 'Commit analysis was interrupted by a previous process exit.',
      phase: String(orphaned.phase || state.analysis.status || 'unknown'),
      retryable: false,
      ts: recoveredAt,
    };
    await resolved.projectStore.updateState(projectId, draft => {
      if (!draft.analysis.activeClaim) return;
      draft.analysis.activeClaim.phase = 'failed';
      draft.analysis.activeClaim.error = error;
      draft.analysis.status = 'failed';
      draft.analysis.lastError = error;
    }, { expectedRevision: state.revision });
    recovered.push({
      projectId,
      commitSha: String(orphaned.commitSha || ''),
      runId: String(orphaned.runId || ''),
      previousPhase: error.phase,
    });
    if (deps.logger && typeof deps.logger.warn === 'function') {
      await deps.logger.warn('reconcile.orphaned_claim_recovered', 'An interrupted commit claim was made terminal without retrying analysis.', {
        projectId,
        commitSha: String(orphaned.commitSha || ''),
        runId: String(orphaned.runId || ''),
        phase: 'recovery',
        context: { previousPhase: error.phase },
      });
    }
  }
  return recovered;
}

module.exports = {
  CommitReconciler,
  cleanupOrphanedRuns,
  handlePostCommitEvent,
  recoverOrphanedClaims,
  reconcileProjectCommits,
  renderCommitPrompt,
};
