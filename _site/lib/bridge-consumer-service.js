const CONSUMER_NAME = 'project-knowledge';
const BATCH_SIZE = 200;

/**
 * Project-Knowledge's host-level Bridge consumer.
 *
 * Owns the "project-knowledge" consumer registration and drains the global
 * Bridge journal into project-scoped ConversationStores:
 *   - exact workspaceId lookup decides the target project (never time, UI
 *     selection, recency, remote URL, or session-file location);
 *   - unimported workspaces are deterministically skipped and ACKed;
 *   - zero-match/one-match/multi-match are handled without guessing;
 *   - ACK advances only over a contiguous fully-handled prefix;
 *   - notifications are wake-ups only — the journal is the sole truth.
 */
class BridgeConsumerService {
  constructor(options = {}) {
    this.consumerName = options.consumerName || CONSUMER_NAME;
    this.bridgeAdapter = options.bridgeAdapter;
    this.conversationStore = options.conversationStore;
    this.registryStore = options.registryStore || null;
    this.projectStore = options.projectStore || null;
    this.logger = options.logger || null;
    this.batchSize = Number(options.batchSize || BATCH_SIZE);
    this.notifyUrl = options.notifyUrl || '';
    this._started = false;
    this._queue = Promise.resolve();
    this._lastDrainAt = null;
    this._lastDrainReason = null;
    this._lastDrainErrorCode = '';
    this._lastDrainStats = null;
    this._lastAck = null;
  }

  async _log(level, event, message, context) {
    try {
      if (this.logger && typeof this.logger[level] === 'function') await this.logger[level](event, message, context);
    } catch {
      // Observer failures never block the drain loop.
    }
  }

  // workspaceId -> [{ projectId, baselineCursor }] from imported configs.
  _workspaceMap() {
    const map = new Map();
    const ids = this.registryStore && typeof this.registryStore.listIds === 'function'
      ? this.registryStore.listIds()
      : [];
    for (const projectId of ids) {
      let workspaceId = null;
      let baselineCursor = null;
      try {
        const config = this.projectStore.readConfig(projectId);
        workspaceId = config && config.repoIdentity && typeof config.repoIdentity.workspaceId === 'string'
          ? config.repoIdentity.workspaceId
          : null;
        const state = this.projectStore.readState(projectId);
        baselineCursor = Number.isInteger(state.conversationBaselineCursor) ? state.conversationBaselineCursor : null;
      } catch {
        workspaceId = null;
      }
      if (!workspaceId) continue;
      if (!map.has(workspaceId)) map.set(workspaceId, []);
      map.get(workspaceId).push({ projectId, baselineCursor });
    }
    return map;
  }

  // I-14 recovery policy: a project imported while the Bridge was unavailable
  // gets its baseline established at the CURRENT high watermark on the first
  // successful attachment — pre-import global history is never backfilled.
  async _ensureBaselines(highWatermark) {
    if (!this.projectStore || typeof this.projectStore.updateState !== 'function') return;
    const ids = this.registryStore && typeof this.registryStore.listIds === 'function'
      ? this.registryStore.listIds()
      : [];
    for (const projectId of ids) {
      try {
        const state = this.projectStore.readState(projectId);
        if (Number.isInteger(state.conversationBaselineCursor)) continue;
        let workspaceId = null;
        try {
          const config = this.projectStore.readConfig(projectId);
          workspaceId = config && config.repoIdentity && typeof config.repoIdentity.workspaceId === 'string'
            ? config.repoIdentity.workspaceId
            : null;
        } catch { workspaceId = null; }
        if (!workspaceId) continue;
        await this.projectStore.updateState(projectId, draft => {
          draft.conversationBaselineCursor = highWatermark;
          draft.conversation = {
            ...(draft.conversation || {}),
            lastConsumedCursor: highWatermark,
            captureStatus: 'captured',
            lastError: null,
          };
        });
      } catch {
        // Baseline establishment is best effort per project; the drain itself
        // remains safe because a missing baseline never widens the window.
      }
    }
  }

  async _currentAck() {
    const result = await this.bridgeAdapter.getConsumer(this.consumerName);
    if (result.status !== 'ok' || !result.consumer) return 0;
    return Number.isInteger(result.consumer.ack) ? result.consumer.ack : 0;
  }

  /**
   * Handle one journal record. Returns a short outcome string; throws only
   * for conditions that must STOP the ACK (persist failure, ambiguous
   * workspace-to-project mapping).
   */
  async _processRecord(record, workspaceMap, stats) {
    if (!record || record.schema !== 'ai-coding-event/v1') {
      stats.skippedTransport += 1;
      return 'skipped-transport';
    }
    if (record.eventType !== 'user_prompt' && record.eventType !== 'assistant_response') {
      stats.skippedTransport += 1;
      return 'skipped-transport';
    }
    const identity = record.repoIdentity;
    const workspaceId = identity && typeof identity === 'object' && typeof identity.workspaceId === 'string'
      ? identity.workspaceId
      : null;
    if (!workspaceId) {
      // Unattributed evidence (e.g. codex-workspace-unresolved) is never
      // projected into any project — deterministic non-project skip.
      stats.skippedNoWorkspace += 1;
      return 'skipped-no-workspace';
    }
    const matches = workspaceMap.get(workspaceId) || [];
    if (matches.length === 0) {
      stats.skippedUnregistered += 1;
      return 'unregistered-workspace';
    }
    if (matches.length > 1) {
      // Configuration corruption: never pick one at random.
      await this.bridgeAdapter.recordGap({
        projectId: '',
        repoIdentity: identity,
        operationId: `drain-${record.sequence}`,
      }, 'workspace-project-ambiguous');
      const error = new Error(`workspaceId ${workspaceId} maps to multiple projects: ${matches.map(entry => entry.projectId).join(', ')}`);
      error.code = 'PROJECT_AMBIGUOUS';
      throw error;
    }
    const { projectId, baselineCursor } = matches[0];
    if (Number.isInteger(baselineCursor) && record.sequence <= baselineCursor) {
      // I-14: pre-baseline global history is deterministically skipped, never
      // backfilled into a newly imported project.
      stats.skippedBelowBaseline += 1;
      return 'skipped-below-baseline';
    }
    try {
      await this.conversationStore.appendBridgeEvent(projectId, record);
      stats.persisted += 1;
      return 'persisted';
    } catch (error) {
      stats.failed += 1;
      error.sequence = record.sequence;
      throw error;
    }
  }

  async _drainLoop({ through, reason }) {
    const stats = { persisted: 0, skippedTransport: 0, skippedNoWorkspace: 0, skippedUnregistered: 0, skippedBelowBaseline: 0, failed: 0 };
    let ack = await this._currentAck();
    for (;;) {
      const highResult = await this.bridgeAdapter.getHighWatermark();
      if (highResult.status !== 'captured') {
        this._lastDrainErrorCode = highResult.reason || 'bridge-unavailable';
        break;
      }
      await this._ensureBaselines(highResult.cursor);
      const target = through === undefined ? highResult.cursor : Math.min(through, highResult.cursor);
      if (ack >= target) break;
      const read = await this.bridgeAdapter.readEvents({ fromSequence: ack + 1, toSequence: target, limit: this.batchSize });
      if (read.status !== 'ok') {
        this._lastDrainErrorCode = read.reason || 'bridge-read-failed';
        break;
      }
      if (!read.events.length) break;
      const workspaceMap = this._workspaceMap();
      let lastHandled = ack;
      try {
        for (const record of read.events) {
          await this._processRecord(record, workspaceMap, stats);
          lastHandled = record.sequence;
        }
      } catch (error) {
        // ACK only the contiguous handled prefix; never cross the failed
        // sequence (I-17).
        if (lastHandled > ack) {
          await this.bridgeAdapter.ackConsumerCursor(this.consumerName, lastHandled);
          this._lastAck = lastHandled;
        }
        this._lastDrainErrorCode = (error && error.code) || 'drain-record-failed';
        await this._log('error', 'bridge_consumer.drain_failed', 'Bridge drain stopped at a failed sequence.', {
          component: 'bridge-consumer',
          consumer: this.consumerName,
          reason,
          failedSequence: error.sequence != null ? error.sequence : lastHandled + 1,
          errorCode: this._lastDrainErrorCode,
          stats,
        });
        throw error;
      }
      await this.bridgeAdapter.ackConsumerCursor(this.consumerName, target);
      ack = target;
      this._lastAck = ack;
      if (read.events.length < this.batchSize && (through === undefined || ack >= through)) break;
    }
    this._lastDrainStats = stats;
    this._lastDrainAt = new Date().toISOString();
    this._lastDrainReason = reason;
    if (this._lastDrainErrorCode !== 'drain-record-failed') this._lastDrainErrorCode = '';
    await this._log('info', 'bridge_consumer.drained', 'Bridge journal drained.', {
      component: 'bridge-consumer',
      consumer: this.consumerName,
      reason,
      ack,
      stats,
    });
    // Safe compaction is requested after every successful ACK advance; the
    // Bridge itself refuses to compact beyond the slowest consumer.
    try {
      await this.bridgeAdapter.compact({});
    } catch {
      // Compaction is best effort.
    }
    return { ack, stats };
  }

  _enqueue(operation) {
    const next = this._queue.then(operation, operation);
    this._queue = next.then(() => undefined, () => undefined);
    return next;
  }

  async start() {
    if (this._started) return { started: false };
    const meta = this.notifyUrl ? { notifyUrl: this.notifyUrl } : {};
    const registration = await this.bridgeAdapter.registerConsumer(this.consumerName, meta);
    this._started = true;
    const drain = await this.drain('startup').catch(error => ({ error }));
    return { started: true, registration, drain };
  }

  async stop() {
    this._started = false;
    await this._queue;
    return { stopped: true };
  }

  // Coalesced drain: concurrent notify/startup drains join one loop.
  drain(reason = 'notify') {
    return this._enqueue(() => this._drainLoop({ through: undefined, reason }));
  }

  // Wake-up callback body is intentionally ignored (I-16).
  handleNotification() {
    return this.drain('notify');
  }

  // Commit flow: ensure every sequence <= target is handled before returning.
  drainThrough(sequence, reason = 'commit-boundary') {
    const target = Number(sequence);
    if (!Number.isInteger(target) || target < 0) {
      return Promise.reject(new Error('drainThrough requires a non-negative integer sequence'));
    }
    return this._enqueue(() => this._drainLoop({ through: target, reason }));
  }

  async status() {
    const consumer = await this.bridgeAdapter.getConsumer(this.consumerName);
    const health = await this.bridgeAdapter.getHealth();
    const healthData = health.status === 'ok' ? health.health : null;
    // Warning-only thresholds (never destructive): oversized journal or a
    // consumer lagging behind the oldest unacked record for over 7 days.
    const warnings = [];
    if (healthData && Number.isInteger(healthData.journalSizeBytes) && healthData.journalSizeBytes >= 256 * 1024 * 1024) {
      warnings.push('journal-size');
    }
    if (healthData && healthData.oldestUnackedAt) {
      const lagMs = Date.now() - Date.parse(healthData.oldestUnackedAt);
      if (Number.isFinite(lagMs) && lagMs >= 7 * 24 * 60 * 60 * 1000) warnings.push('consumer-lag');
    }
    return {
      running: this._started,
      consumerName: this.consumerName,
      consumerRegistered: consumer.status === 'ok' && Boolean(consumer.consumer),
      ack: consumer.status === 'ok' && consumer.consumer ? consumer.consumer.ack : null,
      bridgeHealthy: health.status === 'ok',
      health: healthData,
      warnings,
      lastDrainAt: this._lastDrainAt,
      lastDrainReason: this._lastDrainReason,
      lastDrainErrorCode: this._lastDrainErrorCode,
      lastDrainStats: this._lastDrainStats,
      lastAck: this._lastAck,
    };
  }
}

module.exports = { BridgeConsumerService, CONSUMER_NAME };
