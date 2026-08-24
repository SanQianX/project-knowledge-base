const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { StorageLayout } = require('../lib/storage-layout');
const { ProjectStore } = require('../lib/project-store');
const { ConversationStore } = require('../lib/conversation-store');
const { CommitConversationBinder } = require('../lib/commit-conversation-binder');

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-conversation-binding-'));
  const layout = new StorageLayout({ dataDir: path.join(root, 'data') });
  const projectStore = new ProjectStore({ layout });
  const projectId = 'project-binding';
  const repoIdentity = { commonDir: path.join(root, 'repo', '.git') };
  await projectStore.create(projectId, {
    displayName: 'Binding',
    storageName: 'binding',
    repoPath: path.join(root, 'repo'),
    knowledgePath: path.join(root, 'knowledge'),
    repoIdentity,
  }, { conversationBaselineCursor: 0, conversation: { lastConsumedCursor: 0, captureStatus: 'captured' } });
  const store = new ConversationStore({ layout, projectStore });
  const binder = new CommitConversationBinder({ layout, projectStore, conversationStore: store });
  const c1 = '1'.repeat(40);
  const c2 = '2'.repeat(40);
  const c3 = '3'.repeat(40);
  const cMerge = '4'.repeat(40);
  const cAmbiguous = '5'.repeat(40);

  const append = input => store.appendEvent(projectId, {
    source: 'codex',
    sessionId: 'session-1',
    projectPath: path.join(root, 'repo'),
    repoIdentity,
    branch: 'main',
    headAtCapture: '0'.repeat(40),
    capturedAt: `2026-08-18T02:${String(input.sequence || 0).padStart(2, '0')}:00.000Z`,
    rawEventType: input.eventType,
    identityConfidence: 'high',
    captureStatus: 'captured',
    ...input,
  });
  await append({ eventId: 'r1', sequence: 1, eventType: 'user_prompt', role: 'user', content: 'Requirement before C1.', turnId: 'turn-1' });
  const boundaryC1 = { commitSha: c1, repoIdentity, parentShas: [], branch: 'main', committedAt: '2026-08-18T02:02:00.000Z', bridgeCursorAtCommit: 2, journalSequence: 2, openTurnIdsAtCommit: ['turn-1'], operationId: 'op-c1' };
  store.writeBoundary(projectId, boundaryC1);
  assert.strictEqual(store.writeBoundary(projectId, boundaryC1).commitSha, c1, 'identical bridge/hook boundary is idempotent');
  assert.throws(() => store.writeBoundary(projectId, { ...boundaryC1, branch: 'other' }), error => error.code === 'DATA_CORRUPT');
  await append({ eventId: 'a1', sequence: 3, eventType: 'assistant_response', role: 'assistant', content: 'Late assistant before claim.', turnId: 'turn-1' });
  await append({ eventId: 'r2', sequence: 4, eventType: 'user_prompt', role: 'user', content: 'Requirement after C1.', turnId: 'turn-2', headAtCapture: c1 });

  const frozenC1 = await binder.bind({ projectId, commitSha: c1 });
  assert.strictEqual(frozenC1.status, 'available');
  assert.deepStrictEqual(frozenC1.turns.map(turn => turn.turnId), ['turn-1'], 'future R2 must never bind back to C1');
  assert.deepStrictEqual(frozenC1.turns[0].assistantEvents.map(event => event.eventId), [], 'assistant beyond boundaryEndCursor must never enter the frozen snapshot (I-13)');
  assert.strictEqual(frozenC1.excludedFuturePromptCount, 1);
  const frozenHash = frozenC1.snapshotHash;
  await append({ eventId: 'a1-after-claim', sequence: 6, eventType: 'assistant_response', role: 'assistant', content: 'Assistant arrived after Claim.', turnId: 'turn-1' });
  const retriedC1 = await binder.bind({ projectId, commitSha: c1 });
  assert.strictEqual(retriedC1.snapshotHash, frozenHash, 'retry must reuse the exact Claim-time conversation freeze');
  assert.deepStrictEqual(retriedC1.turns[0].assistantEvents.map(event => event.eventId), [], 'delayed binder execution must not pull post-commit replies into the old snapshot');

  store.writeBoundary(projectId, { commitSha: c2, repoIdentity, parentShas: [c1], branch: 'main', committedAt: '2026-08-18T02:05:00.000Z', bridgeCursorAtCommit: 5, journalSequence: 5, openTurnIdsAtCommit: ['turn-1'], operationId: 'op-c2' });
  const frozenC2 = await binder.bind({ projectId, commitSha: c2 });
  assert.deepStrictEqual(frozenC2.turns.map(turn => [turn.turnId, turn.bindingKind]), [['turn-1', 'shared-spanning'], ['turn-2', 'direct']]);
  assert.deepStrictEqual(frozenC2.turns[0].assistantEvents.map(event => event.eventId), ['a1'], 'the assistant reply inside the C2 window belongs to the spanning turn');
  assert.strictEqual(frozenC2.turns[0].turnId, frozenC1.turns[0].turnId, 'spanning turns must retain one stable identity across commits');

  store.writeBoundary(projectId, { commitSha: c3, repoIdentity, parentShas: [c2], branch: 'main', committedAt: '2026-08-18T02:07:00.000Z', bridgeCursorAtCommit: 7, journalSequence: 7, openTurnIdsAtCommit: [], operationId: 'op-c3' });
  const frozenC3 = await binder.bind({ projectId, commitSha: c3 });
  assert.strictEqual(frozenC3.status, 'no-new-user-prompt');
  assert.deepStrictEqual(frozenC3.turns, [], 'a previous requirement must not be copied into a commit with no new user prompt');

  await append({ eventId: 'r-merge', sequence: 8, eventType: 'user_prompt', role: 'user', content: 'Merge-window requirement.', turnId: 'turn-merge' });
  store.writeBoundary(projectId, { commitSha: cMerge, repoIdentity, parentShas: [c1, c2], branch: 'main', committedAt: '2026-08-18T02:10:00.000Z', bridgeCursorAtCommit: 10, journalSequence: 10, openTurnIdsAtCommit: [], operationId: 'op-merge' });
  const mergeSnapshot = await binder.bind({ projectId, commitSha: cMerge });
  assert.strictEqual(mergeSnapshot.boundaryStartCursor, 7, 'merge window must use previous durable repo boundary, not an arbitrary Git parent');
  assert.deepStrictEqual(mergeSnapshot.turns.map(turn => turn.turnId), ['turn-merge']);

  await append({ eventId: 'r-ambiguous', sequence: 11, eventType: 'user_prompt', role: 'user', content: 'Identity unavailable.', turnId: null, repoIdentity: null, identityConfidence: 'unknown' });
  store.writeBoundary(projectId, { commitSha: cAmbiguous, repoIdentity, parentShas: [cMerge], branch: 'main', committedAt: '2026-08-18T02:12:00.000Z', bridgeCursorAtCommit: 12, journalSequence: 12, openTurnIdsAtCommit: [], operationId: 'op-ambiguous' });
  const ambiguous = await binder.bind({ projectId, commitSha: cAmbiguous });
  assert.strictEqual(ambiguous.status, 'ambiguous');
  assert.deepStrictEqual(ambiguous.turns, []);

  const missingBoundary = await binder.bind({ projectId, commitSha: '6'.repeat(40) });
  assert.strictEqual(missingBoundary.status, 'unavailable', 'missing boundary/capture gap must never fall back to timestamp or ancestry guessing');

  const explicitSha = '7'.repeat(40);
  await append({ eventId: 'explicit-r', sequence: null, eventType: 'user_prompt', role: 'user', content: 'Explicit requirement.', turnId: 'turn-explicit', explicitCommitSha: explicitSha, identityConfidence: 'explicit' });
  const explicit = await binder.bind({ projectId, commitSha: explicitSha });
  assert.strictEqual(explicit.status, 'available');
  assert.strictEqual(explicit.turns[0].bindingKind, 'explicit');

  console.log('commit-conversation-binding-test PASS');
})().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
