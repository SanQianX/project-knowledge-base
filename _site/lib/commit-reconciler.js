const fs = require('fs');
const path = require('path');
const AtomicFile = require('./atomic-file');
const {
  SCHEMAS,
  DomainError,
  createId,
  validateProjectId,
  validateTrigger,
} = require('./contracts');
const { StorageLayout } = require('./storage-layout');
const { ProjectRegistryStore } = require('./project-registry-store');
const { ProjectStore } = require('./project-store');
const { CommitScanner, validateSha } = require('./scanner');
const { ConversationStore } = require('./conversation-store');
const { CommitConversationBinder, snapshotRequirementRecords } = require('./commit-conversation-binder');
const { renderCommitPrompt, sha256 } = require('./commit-prompt');
const { KnowledgeRetrievalService } = require('./knowledge-retrieval-service');
const { manifestHash: calculateRetrievalManifestHash } = require('./knowledge-retrieval-service');
const { sha256: knowledgeContentHash } = require('./knowledge-schema');
const { resolveEffectiveAiProfile } = require('./ai-profile-resolver');
const { CommitProcessingLedger } = require('./commit-processing-ledger');

const explicitQueues = new Map();

const SNAPSHOT_SCHEMA_V1 = 'commit-claim-snapshot/v1';
const SNAPSHOT_SCHEMA_V2 = 'commit-claim-snapshot/v2';
const SNAPSHOT_SCHEMAS = [SNAPSHOT_SCHEMA_V1, SNAPSHOT_SCHEMA_V2];
// Frozen inputs live under <dataDir>/runtime/runs/<projectId>/<runId>/input and
// are ALWAYS re-derived from the running layout: a renamed or relocated data
// directory keeps every claim working without rewriting historical snapshots.
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function validateRunIdSegment(runId) {
  const value = String(runId || '');
  if (!RUN_ID_PATTERN.test(value)) {
    throw new DomainError('DATA_CORRUPT', 'Claim run id is invalid for frozen evidence location.', { status: 500 });
  }
  return value;
}

function publicFailure(error, phase) {
  const failure = {
    code: error && error.code || 'INVALID_ARGUMENT',
    message: String(error && error.message || 'Commit reconciliation failed.'),
    phase,
    retryable: error && error.retryable === true,
    ts: new Date().toISOString(),
  };
  // Evidence failures must surface the concrete resource and reason so the UI
  // can point at what is missing instead of a generic retry loop.
  if (error && error.details && typeof error.details === 'object') failure.details = error.details;
  return failure;
}

function validateClaim(claim, projectId, commitSha) {
  if (!claim || typeof claim !== 'object' || claim.schema !== SCHEMAS.commitClaim) {
    throw new DomainError('DATA_CORRUPT', 'Active commit claim is corrupt.', { status: 500 });
  }
  if (claim.projectId !== projectId || claim.commitSha !== commitSha) {
    throw new DomainError('DATA_CORRUPT', 'Active commit claim identity does not match the pending commit.', { status: 500 });
  }
  if (!Array.isArray(claim.requirementIds) || !claim.patchHash || !claim.promptHash || !claim.evidenceHash
    || !claim.evidenceManifestHash || !claim.retrievalManifestHash || !claim.knowledgePath || !claim.runId) {
    throw new DomainError('DATA_CORRUPT', 'Active commit claim is incomplete.', { status: 500 });
  }
  return claim;
}

function claimFingerprint(claim) {
  return sha256(JSON.stringify({
    schema: claim.schema,
    projectId: claim.projectId,
    commitSha: claim.commitSha,
    parents: claim.parents,
    requirementIds: claim.requirementIds,
    requirementBinding: claim.requirementBinding,
    conversationSnapshotHash: claim.conversationSnapshotHash || '',
    promptTemplateVersion: claim.promptTemplateVersion,
    promptHash: claim.promptHash,
    patchHash: claim.patchHash,
    evidenceHash: claim.evidenceHash,
    evidenceManifestHash: claim.evidenceManifestHash,
    retrievalManifestHash: claim.retrievalManifestHash,
    knowledgePath: claim.knowledgePath,
  }));
}

class CommitClaimStore {
  constructor(options = {}) {
    this.layout = options.layout || new StorageLayout(options);
    this.atomic = options.atomic || AtomicFile;
  }

  filePath(projectId, commitSha) {
    return this.layout.getRuntimePath('claims', validateProjectId(projectId), `${validateSha(commitSha)}.json`);
  }

  write(projectId, commitSha, snapshot) {
    const file = this.filePath(projectId, commitSha);
    // v2 persists only locating IDs and validation metadata; every path is
    // derived at run time from the current layout, so a relocated data
    // directory needs no snapshot rewrite. Marker snapshots without evidence
    // (existence-only records) stay valid without a run id.
    const { evidence, existingKnowledge, ...rest } = snapshot;
    const payload = { schema: SNAPSHOT_SCHEMA_V2, ...rest, evidence: stripFrozenEvidencePaths(evidence), existingKnowledge: stripRetrievalPaths(existingKnowledge) };
    if (payload.evidence && !payload.runId) throw new DomainError('DATA_CORRUPT', 'Claim snapshot requires a run id.', { status: 500 });
    this.atomic.writeJsonAtomic(file, payload);
    return file;
  }

  read(projectId, commitSha) {
    return this.atomic.readJsonStrict(this.filePath(projectId, commitSha), {
      category: 'commit-claim-snapshot',
      validate: snapshot => {
        if (!snapshot || !SNAPSHOT_SCHEMAS.includes(snapshot.schema) || snapshot.projectId !== projectId || snapshot.commitSha !== commitSha) {
          throw new DomainError('DATA_CORRUPT', 'Commit claim snapshot is corrupt.', { status: 500 });
        }
        if (snapshot.schema === SNAPSHOT_SCHEMA_V2 && !snapshot.runId) {
          throw new DomainError('DATA_CORRUPT', 'Commit claim snapshot is missing its run id.', { status: 500 });
        }
        return snapshot;
      },
    });
  }

  remove(projectId, commitSha) {
    const file = this.filePath(projectId, commitSha);
    try { fs.unlinkSync(file); } catch (error) { if (!error || error.code !== 'ENOENT') throw error; }
  }
}

// Absolute evidence locations are build-time facts of the instance that wrote
// them; only hashes and IDs cross a data-directory relocation.
function stripFrozenEvidencePaths(evidence) {
  if (!evidence || typeof evidence !== 'object') return evidence;
  const bundle = evidence.evidenceBundle;
  if (!bundle || typeof bundle !== 'object') return { ...evidence };
  const { root, commitPath, manifestPath, ...bundleRest } = bundle;
  void root; void commitPath; void manifestPath;
  return { ...evidence, evidenceBundle: bundleRest };
}

function stripRetrievalPaths(existingKnowledge) {
  if (!existingKnowledge || typeof existingKnowledge !== 'object') return existingKnowledge;
  const { manifestPath, ...rest } = existingKnowledge;
  void manifestPath;
  return rest;
}

class CommitReconciler {
  constructor(options = {}) {
    this.layout = options.layout || new StorageLayout(options);
    this.registryStore = options.registryStore || new ProjectRegistryStore({ layout: this.layout });
    this.projectStore = options.projectStore || new ProjectStore({ layout: this.layout });
    this.scanner = options.scanner || new CommitScanner(options);
    this.conversationStore = options.conversationStore || new ConversationStore({
      layout: this.layout,
      projectStore: this.projectStore,
      logger: options.logger,
    });
    this.binder = options.conversationBinder || new CommitConversationBinder({
      layout: this.layout,
      projectStore: this.projectStore,
      conversationStore: this.conversationStore,
      logger: options.logger,
    });
    this.retrievalService = options.retrievalService || new KnowledgeRetrievalService({
      layout: this.layout,
      registryStore: this.registryStore,
      projectStore: this.projectStore,
      databaseProvider: options.databaseProvider,
      embedderProvider: options.embedderProvider,
      logger: options.logger,
    });
    this.claimStore = options.claimStore || new CommitClaimStore({ layout: this.layout });
    this.processingLedger = options.processingLedger || new CommitProcessingLedger({ layout: this.layout });
    this.claimProcessor = options.claimProcessor || null;
    this.logger = options.logger || null;
    this.settingsStore = options.settingsStore || null;
    this.batchSize = Math.max(1, Number(options.batchSize || 200));
    this.requireAiProfile = options.requireAiProfile !== false;
  }

  async log(level, event, message, context) {
    if (this.logger && typeof this.logger[level] === 'function') await this.logger[level](event, message, context);
  }

  // First preparation, failed retries and recovery all share one construction
  // rule: the ACTIVE claim's runId plus the RUNNING layout decide where frozen
  // evidence is read. Absolute paths inside historical snapshots are archival
  // facts and never select the read location, even if the old directory still
  // exists.
  resolveFrozenLocations(projectId, runId) {
    const safeRunId = validateRunIdSegment(runId);
    const runtimeRoot = path.join(this.layout.dataDir, 'runtime');
    const evidenceRoot = this.layout.getRuntimePath('runs', validateProjectId(projectId), safeRunId, 'input', 'evidence');
    const retrievalManifestPath = this.layout.getRuntimePath('runs', validateProjectId(projectId), safeRunId, 'input', 'retrieval', 'manifest.json');
    // The legacy layout joins paths without containment checks; enforce the
    // same real-path boundary the engine layout guarantees (symlink/junction
    // escapes on parent directories included).
    for (const candidate of [evidenceRoot, retrievalManifestPath]) {
      if (!this.layout.isPathInside(runtimeRoot, candidate, { realpath: true, allowRoot: false })) {
        throw new DomainError('PATH_OUTSIDE_ROOT', 'Frozen evidence location escapes the runtime root.', { status: 403 });
      }
    }
    return { runId: safeRunId, evidenceRoot, retrievalManifestPath };
  }

  relocateFrozenEvidence(evidence, locations) {
    return {
      ...evidence,
      evidenceBundle: {
        ...evidence.evidenceBundle,
        root: locations.evidenceRoot,
        commitPath: path.join(locations.evidenceRoot, 'commit.json'),
        manifestPath: path.join(locations.evidenceRoot, 'patch-manifest.json'),
      },
    };
  }

  async reconcile(projectId, trigger, context = {}) {
    validateProjectId(projectId);
    validateTrigger(trigger);
    if (!context.commitSha) throw new DomainError('INVALID_ARGUMENT', 'Commit reconciliation requires an explicit Hook commit SHA.');
    return this.processCommitEvent({ projectId, commitSha: context.commitSha, branch: context.branch || '', operationId: context.operationId || createId('op') });
  }

  async processCommitEvent({ projectId, commitSha, branch = '', operationId = '' } = {}) {
    validateProjectId(projectId);
    validateSha(commitSha);
    const existingQueue = explicitQueues.get(projectId) || { tail: Promise.resolve(), pending: new Map() };
    explicitQueues.set(projectId, existingQueue);
    if (existingQueue.pending.has(commitSha)) return existingQueue.pending.get(commitSha);
    const queued = existingQueue.tail.catch(() => {}).then(async () => {
      const completed = this.processingLedger.read(projectId, commitSha);
      if (completed) return { ok: true, projectId, commitSha, status: 'already-completed', processed: [], ledger: completed };
      const config = this.projectStore.readConfig(projectId);
      if (config.enabled === false) return { ok: true, projectId, commitSha, status: 'disabled', processed: [] };
      const result = await this.processCommit(projectId, 'git-hook', operationId || createId('op'), config, branch, commitSha);
      if (!result.ok) return { ok: false, projectId, commitSha, status: 'failed', processed: [result], error: result.error };
      const ledger = this.processingLedger.complete(projectId, commitSha, { runId: result.runId, claimFingerprint: result.claimFingerprint || '' });
      return { ok: true, projectId, commitSha, status: 'completed', processed: [result], ledger };
    });
    existingQueue.pending.set(commitSha, queued);
    existingQueue.tail = queued.catch(() => {});
    try { return await queued; }
    finally {
      existingQueue.pending.delete(commitSha);
      if (!existingQueue.pending.size) explicitQueues.delete(projectId);
    }
  }

  async prepareClaim(projectId, trigger, operationId, config, branch, commitSha) {
    const state = this.projectStore.readState(projectId);
    if (state.analysis.activeClaim) {
      const activeClaim = state.analysis.activeClaim;
      // A terminal failure must not turn a project into a permanent dead end.
      // We only release it while processing a *new, explicit* Hook SHA; the
      // failed SHA is never retried, scanned, or inferred from history.
      if (activeClaim.commitSha !== commitSha) {
        validateClaim(activeClaim, projectId, activeClaim.commitSha);
        const terminalFailure = activeClaim.phase === 'failed'
          && activeClaim.error
          && activeClaim.error.retryable !== true;
        if (!terminalFailure) {
          throw new DomainError('PROJECT_BUSY', 'Another unfinished commit claim already exists.', { status: 409, retryable: true });
        }
        await this.projectStore.updateState(projectId, draft => {
          const current = draft.analysis.activeClaim;
          if (!current || current.commitSha !== activeClaim.commitSha || current.fingerprint !== activeClaim.fingerprint) {
            throw new DomainError('PROJECT_BUSY', 'The active commit claim changed while preparing this Hook event.', { status: 409, retryable: true });
          }
          draft.analysis.activeClaim = null;
          draft.analysis.status = 'idle';
          draft.analysis.lastError = {
            code: 'FAILED_CLAIM_SUPERSEDED',
            message: 'A terminal failed claim was preserved for diagnostics and superseded by a newer explicit Hook commit.',
            retryable: false,
            ts: new Date().toISOString(),
          };
        });
        await this.log('warn', 'reconcile.failed_claim_superseded', 'A terminal failed claim was superseded by a newer explicit Hook commit.', {
          projectId,
          previousCommitSha: activeClaim.commitSha,
          commitSha,
          previousFailure: activeClaim.error,
        });
        return this.prepareClaim(projectId, trigger, operationId, config, branch, commitSha);
      }
      const claim = validateClaim(activeClaim, projectId, commitSha);
      const snapshot = this.claimStore.read(projectId, commitSha);
      if ((snapshot.schema === SNAPSHOT_SCHEMA_V2 && snapshot.runId !== claim.runId)
        || snapshot.claimFingerprint !== claimFingerprint(claim)
        || snapshot.evidence.patchHash !== claim.patchHash
        || snapshot.evidence.evidenceHash !== claim.evidenceHash
        || !snapshot.evidence.evidenceBundle
        || snapshot.evidence.evidenceBundle.manifestHash !== claim.evidenceManifestHash
        || !snapshot.existingKnowledge || snapshot.existingKnowledge.manifestHash !== claim.retrievalManifestHash
        || sha256(snapshot.prompt) !== claim.promptHash
        || (claim.conversationSnapshotHash && (!snapshot.conversationSnapshot || snapshot.conversationSnapshot.snapshotHash !== claim.conversationSnapshotHash))) {
        throw new DomainError('DATA_CORRUPT', 'Frozen commit claim snapshot does not match active state.', { status: 500 });
      }
      // Recompute every frozen-input location from the current data directory
      // and the active claim's run id, then verify the SAME historical evidence
      // (commit SHA, patch/manifest/chunk hashes) at those current paths.
      const locations = this.resolveFrozenLocations(projectId, claim.runId);
      const evidence = this.relocateFrozenEvidence(snapshot.evidence, locations);
      const existingKnowledge = { ...snapshot.existingKnowledge, manifestPath: locations.retrievalManifestPath };
      this.scanner.verifyEvidence(evidence, {
        expectedCommitSha: claim.commitSha,
        expectedManifestHash: claim.evidenceManifestHash,
      });
      let retrievalManifest;
      try {
        retrievalManifest = this.claimStore.atomic.readJsonStrict(existingKnowledge.manifestPath, {
          category: 'knowledge-retrieval-manifest',
          validate: value => {
            if (!value || value.schema !== 'knowledge-retrieval-manifest/v1'
              || value.manifestHash !== claim.retrievalManifestHash
              || calculateRetrievalManifestHash(value) !== value.manifestHash) {
              throw new DomainError('DATA_CORRUPT', 'Frozen knowledge retrieval manifest is corrupt.', { status: 500 });
            }
            return value;
          },
        });
      } catch (error) {
        if (error instanceof DomainError) throw error;
        if (error && error.code === 'ENOENT') {
          throw new DomainError('EVIDENCE_MISSING', 'Frozen knowledge retrieval manifest is missing at the current data directory.', {
            status: 500,
            details: { resource: 'input/retrieval/manifest.json', runId: claim.runId },
            cause: error,
          });
        }
        throw error;
      }
      const selectedById = new Map(retrievalManifest.selected.map(item => [`${item.spaceId}:${item.chunkId}`, item]));
      for (const entry of existingKnowledge.entries || []) {
        const selected = selectedById.get(`${entry.projectId === projectId ? `project:${projectId}` : `project:${entry.projectId}`}:${entry.chunkId}`);
        if (!selected || knowledgeContentHash(entry.content) !== entry.hash || selected.contentHash !== entry.hash) {
          throw new DomainError('DATA_CORRUPT', 'Frozen authoritative Markdown context does not match its retrieval manifest.', { status: 500 });
        }
      }
      claim.attempt = Number(claim.attempt || 1) + 1;
      claim.phase = 'evidence.prepared';
      await this.projectStore.updateState(projectId, draft => {
        draft.analysis.activeClaim = claim;
        draft.analysis.status = 'evidence.prepared';
        draft.analysis.lastError = null;
      });
      return {
        claim,
        evidence,
        prompt: snapshot.prompt,
        requirements: snapshot.requirements || [],
        conversationSnapshot: snapshot.conversationSnapshot || null,
        existingKnowledge,
        retry: true,
      };
    }

    const runId = createId('run');
    const evidenceRoot = this.layout.getRuntimePath('runs', projectId, runId, 'input', 'evidence');
    const evidence = await this.scanner.collectEvidence(config, commitSha, { branch, evidenceRoot });
    this.scanner.verifyEvidence(evidence);
    const conversationSnapshot = await this.binder.bind({ projectId, commitSha, branch });
    const requirements = snapshotRequirementRecords(conversationSnapshot);
    const existingKnowledge = await this.retrievalService.retrieveForCommit({
      projectId,
      conversationSnapshot,
      commitEvidence: evidence,
    });
    existingKnowledge.manifestPath = this.layout.getRuntimePath('runs', projectId, runId, 'input', 'retrieval', 'manifest.json');
    this.claimStore.atomic.writeJsonAtomic(existingKnowledge.manifestPath, existingKnowledge.manifest);
    const rendered = renderCommitPrompt({ projectId, config, evidence, requirements, conversationSnapshot, existingKnowledge });
    const claim = {
      schema: SCHEMAS.commitClaim,
      projectId,
      commitSha,
      parents: evidence.parents,
      triggerFirstSeen: trigger,
      requirementIds: requirements.map(requirement => requirement.id),
      requirementBinding: conversationSnapshot.status,
      conversationSnapshotHash: conversationSnapshot.snapshotHash,
      conversationTurnIds: conversationSnapshot.turns.map(turn => turn.turnId),
      conversationEventIds: conversationSnapshot.turns.flatMap(turn => [...turn.userEvents, ...turn.assistantEvents].map(event => event.eventId)),
      promptTemplateVersion: rendered.promptTemplateVersion,
      promptHash: rendered.promptHash,
      patchHash: evidence.patchHash,
      evidenceHash: evidence.evidenceHash,
      evidenceManifestHash: evidence.evidenceBundle.manifestHash,
      retrievalManifestHash: existingKnowledge.manifestHash,
      knowledgePath: config.knowledgePath,
      runId,
      operationId,
      phase: 'evidence.prepared',
      attempt: 1,
    };
    claim.fingerprint = claimFingerprint(claim);
    this.claimStore.write(projectId, commitSha, {
      projectId,
      commitSha,
      runId: claim.runId,
      claimFingerprint: claim.fingerprint,
      evidence,
      prompt: rendered.prompt,
      requirements,
      conversationSnapshot,
      existingKnowledge,
      createdAt: new Date().toISOString(),
    });
    try {
      await this.projectStore.updateState(projectId, draft => {
        if (draft.analysis.activeClaim) throw new DomainError('PROJECT_BUSY', 'Another active claim already exists.', { status: 409, retryable: true });
        draft.analysis.activeClaim = claim;
        draft.analysis.status = 'evidence.prepared';
        draft.analysis.lastError = null;
      });
    } catch (error) {
      this.claimStore.remove(projectId, commitSha);
      throw error;
    }
    await this.log('info', 'reconcile.claim_prepared', 'Commit evidence and claim prepared.', {
      projectId,
      operationId,
      runId: claim.runId,
      commitSha,
      phase: claim.phase,
      promptHash: claim.promptHash,
      patchHash: claim.patchHash,
      patchBytes: evidence.patchBytes,
      evidenceManifestHash: claim.evidenceManifestHash,
      evidenceChunkCount: evidence.evidenceBundle.chunkCount,
      evidenceChunkBytes: evidence.evidenceBundle.chunkBytes,
      retrievalManifestHash: claim.retrievalManifestHash,
      retrievalSelectedCount: existingKnowledge.entries.length,
      retrievalBytes: existingKnowledge.totalBytes,
      fileCount: evidence.files.length,
      requirementBinding: claim.requirementBinding,
      requirementCount: claim.requirementIds.length,
    });
    return { claim, evidence, prompt: rendered.prompt, requirements, conversationSnapshot, existingKnowledge, retry: false };
  }

  async processCommit(projectId, trigger, operationId, config, branch, commitSha) {
    let prepared;
    try {
      prepared = await this.prepareClaim(projectId, trigger, operationId, config, branch, commitSha);
      if (this.requireAiProfile) {
        // Use the shared effective-profile resolver so a project with no explicit
        // aiProfileId can still analyze via the global default or first-usable
        // profile. The resolver throws AI_PROFILE_REQUIRED if nothing usable
        // exists, which becomes a clear actionable error rather than a silent
        // null deref.
        resolveEffectiveAiProfile(this.settingsStore ? this.settingsStore.read() : null, config);
      }
      if (!this.claimProcessor || typeof this.claimProcessor.processClaim !== 'function') {
        throw new DomainError('INVALID_ARGUMENT', 'Knowledge claim processor is unavailable.', { status: 503, retryable: true });
      }
      const result = await this.claimProcessor.processClaim({
        projectId,
        config,
        claim: prepared.claim,
        evidence: prepared.evidence,
        prompt: prepared.prompt,
        requirements: prepared.requirements,
        conversationSnapshot: prepared.conversationSnapshot,
        existingKnowledge: prepared.existingKnowledge,
        operationId,
      });
      if (!result || result.stateAdvanced !== true) {
        throw new DomainError('INVALID_ARGUMENT', 'Knowledge promotion did not prove state advancement.', { status: 500, retryable: true });
      }
      const advanced = this.projectStore.readState(projectId);
      if (advanced.lastAnalyzedCommit !== commitSha || advanced.analysis.activeClaim) {
        throw new DomainError('DATA_CORRUPT', 'Claim processor reported success without atomically advancing project state.', { status: 500 });
      }
      this.claimStore.remove(projectId, commitSha);
      await this.log('info', 'reconcile.commit_completed', 'Commit knowledge was promoted and state advanced.', {
        projectId,
        operationId,
        runId: prepared.claim.runId,
        commitSha,
        phase: 'state.advanced',
      });
      return { ok: true, commitSha, runId: prepared.claim.runId, claimFingerprint: prepared.claim.fingerprint, retry: prepared.retry };
    } catch (error) {
      const failure = publicFailure(error, prepared && prepared.claim && prepared.claim.phase || 'evidence.prepared');
      let stateUpdateError = null;
      try {
        await this.projectStore.updateState(projectId, draft => {
          const active = draft.analysis.activeClaim;
          if (active && active.commitSha === commitSha) {
            active.phase = 'failed';
            active.error = failure;
          }
          draft.analysis.status = 'failed';
          draft.analysis.lastError = failure;
        });
      } catch (updateError) {
        stateUpdateError = updateError;
      }
      await this.log('error', 'reconcile.commit_failed', 'Commit reconciliation stopped at the first failed commit.', {
        projectId,
        operationId,
        runId: prepared && prepared.claim && prepared.claim.runId,
        commitSha,
        phase: failure.phase,
        error,
        context: stateUpdateError ? { failureStateWriteError: stateUpdateError } : {},
      });
      return { ok: false, commitSha, error: failure, retry: prepared && prepared.retry || false };
    }
  }

  async markDiverged(projectId, operationId, message, processed = []) {
    const error = new DomainError('HISTORY_DIVERGED', message || 'Git history diverged from the stored baseline.', { status: 409 });
    await this.projectStore.updateState(projectId, state => {
      state.analysis.status = 'history-diverged';
      state.analysis.lastError = publicFailure(error, 'history-diverged');
    });
    await this.log('error', 'reconcile.history_diverged', 'Git history diverged; reconciliation stopped without moving pointers.', { projectId, operationId, phase: 'history-diverged', error });
    return { ok: false, status: 'history-diverged', processed, error: publicFailure(error, 'history-diverged') };
  }

  async failWithoutClaim(projectId, operationId, error, phase, processed = []) {
    await this.projectStore.updateState(projectId, state => {
      state.analysis.status = 'failed';
      state.analysis.lastError = publicFailure(error, phase);
    });
    await this.log('error', 'reconcile.failed', 'Reconciliation failed before claim processing.', { projectId, operationId, phase, error });
    return { ok: false, status: 'failed', processed, error: publicFailure(error, phase) };
  }
}

async function reconcileProjectCommits(projectId, trigger, deps = {}) {
  const reconciler = deps.reconciler instanceof CommitReconciler ? deps.reconciler : new CommitReconciler(deps);
  return reconciler.reconcile(projectId, trigger, { operationId: deps.operationId || '', commitSha: deps.commitSha || '', branch: deps.branch || '' });
}

module.exports = {
  CommitClaimStore,
  CommitReconciler,
  CommitProcessingLedger,
  claimFingerprint,
  reconcileProjectCommits,
  validateClaim,
  SNAPSHOT_SCHEMA_V1,
  SNAPSHOT_SCHEMA_V2,
};
