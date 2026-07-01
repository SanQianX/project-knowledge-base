// Automation Queue — per-key FIFO serial gate.
//
// Each key (in this project, key = project slug) owns an independent slot.
// Within one key, only one run may be "active" at a time; the rest queue.
// Different keys are completely independent and impose no concurrency limit
// on each other — different projects write different KBs and may run in
// parallel.
//
// State is in-memory only. On server restart, queued items are lost (the
// caller is expected to mark their persisted records as abandoned during
// startup cleanup; see post-commit-automation.cleanupOrphanedRuns).

function createAutomationQueue() {
  // key -> { activeRunId: string|null, queuedRunIds: string[] }
  const slots = new Map();

  function slot(key) {
    if (!slots.has(key)) slots.set(key, { activeRunId: null, queuedRunIds: [] });
    return slots.get(key);
  }

  // Try to claim the active slot for `key` immediately.
  // Returns true if acquired (caller should start the run now).
  // Returns false if the slot is already held (caller should enqueue).
  function tryAcquire(key, runId) {
    const s = slot(key);
    if (s.activeRunId) return false;
    s.activeRunId = runId;
    return true;
  }

  // Enqueue a run behind the active one. Returns true if accepted, false if
  // the queue is at capacity (caller should reject the run).
  function enqueue(key, runId, maxSize) {
    const s = slot(key);
    if (typeof maxSize === 'number' && s.queuedRunIds.length >= maxSize) return false;
    s.queuedRunIds.push(runId);
    return true;
  }

  // Release the active slot and promote the next queued run to active in one
  // atomic step. Returns the next runId (now active), or null if the queue
  // is empty.
  function releaseAndNext(key) {
    const s = slots.get(key);
    if (!s) return null;
    s.activeRunId = s.queuedRunIds.shift() || null;
    if (!s.activeRunId && s.queuedRunIds.length === 0) slots.delete(key);
    return s.activeRunId;
  }

  // Drain the queue without touching the active run. Returns the dropped
  // runIds (caller marks them abandoned). Used when automation is disabled
  // mid-flight.
  function drain(key) {
    const s = slots.get(key);
    if (!s) return [];
    const dropped = s.queuedRunIds.slice();
    s.queuedRunIds = [];
    if (!s.activeRunId) slots.delete(key);
    return dropped;
  }

  function size(key) {
    const s = slots.get(key);
    return s ? s.queuedRunIds.length : 0;
  }

  function isActive(key) {
    const s = slots.get(key);
    return !!(s && s.activeRunId);
  }

  function activeRunId(key) {
    const s = slots.get(key);
    return s ? s.activeRunId : null;
  }

  return {
    tryAcquire,
    enqueue,
    releaseAndNext,
    drain,
    size,
    isActive,
    activeRunId,
  };
}

module.exports = { createAutomationQueue };
