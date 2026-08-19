const path = require('path');
const { SCHEMAS, createId } = require('./contracts');
const AtomicFile = require('./atomic-file');

function loadBridgeModule(explicitPath = '') {
  const candidates = [explicitPath, process.env.AI_CODING_EVENT_BRIDGE_MODULE, '@sanqianx/ai-coding-event-bridge'].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const target = candidate.startsWith('.') || path.isAbsolute(candidate) ? path.resolve(candidate) : candidate;
      return { module: require(target), moduleId: candidate, error: null };
    } catch (error) {
      if (candidate !== candidates[candidates.length - 1]) continue;
      return { module: null, moduleId: candidate, error };
    }
  }
  return { module: null, moduleId: '', error: null };
}

function bridgeImplementation(loaded, options = {}) {
  if (!loaded) return null;
  if (typeof loaded.createBridge === 'function') return loaded.createBridge(options);
  if (loaded.default && typeof loaded.default.createBridge === 'function') return loaded.default.createBridge(options);
  return loaded.default || loaded;
}

// repo-identity/v1 objects are the only new automatic identity shape. Legacy
// plain strings are tolerated for stored records; the old PK-only
// { commonDir } object shape must never be sent to the Bridge again — it is
// answered with a deterministic gap instead of a guess.
function isLegacyStringIdentity(identity) {
  return typeof identity === 'string' && identity.length > 0;
}

// Local structural check: works even when the injected bridge module is a
// narrow test fixture without the full export surface.
function isV1Identity(identity) {
  return Boolean(
    identity &&
    typeof identity === 'object' &&
    identity.schema === 'repo-identity/v1' &&
    typeof identity.workspaceId === 'string' &&
    /^sha256:[0-9a-f]{64}$/.test(identity.workspaceId) &&
    typeof identity.workspaceRoot === 'string' &&
    identity.workspaceRoot.length > 0
  );
}

class BridgeAdapter {
  constructor(options = {}) {
    this.dataDir = path.resolve(options.dataDir || process.env.KB_DATA_DIR || '.');
    this.atomic = options.atomic || AtomicFile;
    const loaded = options.bridgeModule
      ? { module: options.bridgeModule, moduleId: 'injected', error: null }
      : loadBridgeModule(options.modulePath || '');
    this.moduleId = loaded.moduleId;
    this.loadError = loaded.error;
    this.module = loaded.module;
    // The Bridge journal is a global per-user spool (~/.ai-coding-event-bridge
    // by default) — never a directory inside PK's project data.
    const bridgeOptions = {};
    const homeDir = options.bridgeHomeDir || process.env.AI_CODING_EVENT_BRIDGE_HOME;
    if (homeDir) bridgeOptions.homeDir = homeDir;
    this.bridge = bridgeImplementation(loaded.module, bridgeOptions);
  }

  isAvailable() {
    return Boolean(this.bridge && typeof this.bridge.appendCommitBoundary === 'function');
  }

  // Canonical RepoIdentityV1 resolution delegated to the Bridge package so PK
  // never invents a second identity algorithm.
  async resolveRepoIdentity(cwd) {
    if (!this.module || typeof this.module.resolveRepoContext !== 'function') {
      return { status: 'unavailable', repoIdentity: null, reason: 'bridge-module-unavailable' };
    }
    try {
      const context = await this.module.resolveRepoContext(cwd);
      return { status: 'ok', repoIdentity: context.repoIdentity, projectPath: context.projectPath };
    } catch (error) {
      return { status: 'unavailable', repoIdentity: null, reason: 'repo-context-failed', errorCode: (error && error.code) || '' };
    }
  }

  async getHighWatermark(context = {}) {
    if (!this.bridge || typeof this.bridge.getHighWatermark !== 'function') {
      return { status: 'unavailable', cursor: null, reason: 'bridge-high-watermark-unavailable' };
    }
    try {
      const result = await this.bridge.getHighWatermark(context);
      const cursor = Number.isInteger(result) ? result : Number(result && (result.cursor ?? result.highWatermark));
      if (!Number.isInteger(cursor) || cursor < 0) return { status: 'unavailable', cursor: null, reason: 'bridge-high-watermark-invalid' };
      return { status: 'captured', cursor };
    } catch (error) {
      return { status: 'unavailable', cursor: null, reason: 'bridge-high-watermark-failed', errorCode: error && error.code || '' };
    }
  }

  async readEvents(options = {}) {
    if (!this.bridge || typeof this.bridge.readEvents !== 'function') {
      return { status: 'unavailable', events: null, reason: 'bridge-read-unavailable' };
    }
    try {
      const events = await this.bridge.readEvents(options);
      return { status: 'ok', events };
    } catch (error) {
      return { status: 'unavailable', events: null, reason: 'bridge-read-failed', errorCode: (error && error.code) || '' };
    }
  }

  async getHealth() {
    if (!this.bridge || typeof this.bridge.getHealth !== 'function') {
      return { status: 'unavailable', health: null, reason: 'bridge-health-unavailable' };
    }
    try {
      const health = await this.bridge.getHealth();
      return { status: 'ok', health };
    } catch (error) {
      return { status: 'unavailable', health: null, reason: 'bridge-health-failed', errorCode: (error && error.code) || '' };
    }
  }

  async registerConsumer(name, meta = {}) {
    if (!this.bridge || typeof this.bridge.registerConsumer !== 'function') {
      return { status: 'unavailable', reason: 'bridge-consumer-unavailable' };
    }
    try {
      const consumer = await this.bridge.registerConsumer(name, meta);
      return { status: 'ok', consumer };
    } catch (error) {
      return { status: 'unavailable', reason: 'bridge-consumer-failed', errorCode: (error && error.code) || '' };
    }
  }

  async getConsumer(name) {
    if (!this.bridge || typeof this.bridge.getConsumer !== 'function') {
      return { status: 'unavailable', consumer: null, reason: 'bridge-consumer-unavailable' };
    }
    try {
      const consumer = await this.bridge.getConsumer(name);
      return { status: 'ok', consumer };
    } catch (error) {
      return { status: 'unavailable', consumer: null, reason: 'bridge-consumer-failed', errorCode: (error && error.code) || '' };
    }
  }

  async listConsumers() {
    if (!this.bridge || typeof this.bridge.listConsumers !== 'function') {
      return { status: 'unavailable', consumers: null, reason: 'bridge-consumer-unavailable' };
    }
    try {
      const consumers = await this.bridge.listConsumers();
      return { status: 'ok', consumers };
    } catch (error) {
      return { status: 'unavailable', consumers: null, reason: 'bridge-consumer-failed', errorCode: (error && error.code) || '' };
    }
  }

  async ackConsumerCursor(name, sequence) {
    if (!this.bridge || typeof this.bridge.ackConsumerCursor !== 'function') {
      return { status: 'unavailable', reason: 'bridge-ack-unavailable' };
    }
    try {
      const result = await this.bridge.ackConsumerCursor(name, sequence);
      return { status: 'ok', ...result };
    } catch (error) {
      return { status: 'unavailable', reason: 'bridge-ack-failed', errorCode: (error && error.code) || '' };
    }
  }

  async compact(options = {}) {
    if (!this.bridge || typeof this.bridge.compact !== 'function') {
      return { status: 'unavailable', reason: 'bridge-compact-unavailable' };
    }
    try {
      const result = await this.bridge.compact(options);
      return { status: 'ok', ...result };
    } catch (error) {
      return { status: 'unavailable', reason: 'bridge-compact-failed', errorCode: (error && error.code) || '' };
    }
  }

  async recordGap(input, reason, error = null) {
    const gap = {
      schema: 'conversation-capture-gap/v1',
      gapId: createId('gap'),
      projectId: input.projectId,
      repoIdentity: input.repoIdentity || null,
      commitSha: input.commitSha || null,
      operationId: input.operationId || '',
      reason,
      errorCode: error && error.code || '',
      capturedAt: new Date().toISOString(),
    };
    const filePath = path.join(this.dataDir, 'runtime', 'conversation-capture-gaps.jsonl');
    try { await this.atomic.appendJsonlLocked(filePath, gap, { lockPath: `${filePath}.lock` }); }
    catch {
      // A gap that cannot be persisted remains visible through the Hook logger fallback.
    }
    return gap;
  }

  async appendCommitBoundary(input = {}) {
    if (!this.isAvailable()) {
      const gap = await this.recordGap(input, 'bridge-unavailable', this.loadError);
      return { status: 'unavailable', gap };
    }
    const identity = input.repoIdentity || null;
    if (identity === null) {
      const gap = await this.recordGap(input, 'repo-identity-missing');
      return { status: 'unavailable', gap };
    }
    const identityValid = isV1Identity(identity) || isLegacyStringIdentity(identity);
    if (!identityValid) {
      // Never send the old { commonDir } shape or malformed objects upstream;
      // record a deterministic gap instead of guessing a workspace.
      const gap = await this.recordGap(input, 'repo-identity-legacy-shape');
      return { status: 'unavailable', gap };
    }
    try {
      // This single Bridge API owns cursor read, sequence allocation, append and fsync.
      const result = await this.bridge.appendCommitBoundary({
        schema: SCHEMAS.gitCommitBoundary,
        projectId: input.projectId,
        repoIdentity: identity,
        commitSha: input.commitSha,
        parentShas: input.parentShas || [],
        branch: input.branch || null,
        committedAt: input.committedAt || new Date().toISOString(),
        operationId: input.operationId || '',
      });
      const cursor = Number(result && (result.bridgeCursorAtCommit ?? result.cursor ?? result.sequence));
      if (!Number.isInteger(cursor) || cursor < 0) throw Object.assign(new Error('Bridge returned an invalid commit boundary cursor.'), { code: 'BRIDGE_BOUNDARY_INVALID' });
      const boundary = {
        schema: SCHEMAS.gitCommitBoundary,
        projectId: input.projectId,
        repoIdentity: identity,
        commitSha: String(input.commitSha || '').toLowerCase(),
        parentShas: (input.parentShas || []).map(value => String(value).toLowerCase()),
        branch: input.branch || null,
        committedAt: result.committedAt || input.committedAt || new Date().toISOString(),
        bridgeCursorAtCommit: cursor,
        openTurnIdsAtCommit: Array.isArray(result.openTurnIdsAtCommit)
          ? result.openTurnIdsAtCommit.map(String)
          : Array.isArray(result.openTurnIds) ? result.openTurnIds.map(String) : [],
        operationId: input.operationId || '',
        journalSequence: Number.isInteger(result.sequence) ? result.sequence : cursor,
      };
      return { status: 'captured', boundary };
    } catch (error) {
      const gap = await this.recordGap(input, 'bridge-boundary-append-failed', error);
      return { status: 'unavailable', gap };
    }
  }
}

module.exports = { BridgeAdapter, loadBridgeModule };
