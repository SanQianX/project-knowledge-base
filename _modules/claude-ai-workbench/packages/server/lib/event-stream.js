'use strict';

function normalizeEvent(event, sessionId, contextId, sequence, startedAt) {
  const input = event && typeof event === 'object' ? event : { type: 'claude/error', message: String(event) };
  const baseTime = Date.parse(startedAt || '') || Date.now();
  return {
    ...input,
    type: String(input.type || 'claude/state'),
    sessionId,
    contextId,
    sequence,
    at: input.at || new Date(baseTime + sequence).toISOString(),
  };
}

function subscribeNormalized(runner, sessionId, afterSequence, onEvent) {
  const state = runner.getState(sessionId);
  if (!state) throw Object.assign(new Error('session not found'), { status: 404 });
  let sequence = 0;
  return runner.subscribe(sessionId, raw => {
    sequence += 1;
    if (sequence <= afterSequence) return;
    onEvent(normalizeEvent(raw, sessionId, state.projectSlug, sequence, state.startedAt));
  });
}

function snapshotEvents(runner, sessionId) {
  const session = runner.getSession(sessionId);
  const state = runner.getState(sessionId);
  if (!session || !state) return [];
  return (session.outputBuffer || []).map((event, index) =>
    normalizeEvent(event, sessionId, state.projectSlug, index + 1, state.startedAt));
}

module.exports = { normalizeEvent, subscribeNormalized, snapshotEvents };
