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

class BridgeAdapter {
  constructor(options = {}) {
    this.dataDir = path.resolve(options.dataDir || process.env.KB_DATA_DIR || '.');
    this.atomic = options.atomic || AtomicFile;
    const loaded = options.bridgeModule
      ? { module: options.bridgeModule, moduleId: 'injected', error: null }
      : loadBridgeModule(options.modulePath || '');
    this.moduleId = loaded.moduleId;
    this.loadError = loaded.error;
    this.bridge = bridgeImplementation(loaded.module, { dataDir: this.dataDir });
  }

  isAvailable() {
    return Boolean(this.bridge && typeof this.bridge.appendCommitBoundary === 'function');
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
    try {
      // This single Bridge API owns cursor read, sequence allocation, append and fsync.
      const result = await this.bridge.appendCommitBoundary({
        schema: SCHEMAS.gitCommitBoundary,
        projectId: input.projectId,
        repoIdentity: input.repoIdentity || null,
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
        repoIdentity: input.repoIdentity || null,
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
