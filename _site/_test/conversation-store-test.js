const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SCHEMAS } = require('../lib/contracts');
const { StorageLayout } = require('../lib/storage-layout');
const { ConversationStore, sha256 } = require('../lib/conversation-store');

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-conversation-store-'));
  const dataDir = path.join(root, 'data');
  const knowledgeRoot = path.join(root, 'knowledge');
  fs.mkdirSync(knowledgeRoot, { recursive: true });
  const layout = new StorageLayout({ dataDir });
  const logRecords = [];
  const store = new ConversationStore({
    layout,
    logger: { async info(event, message, input) { logRecords.push({ event, message, input }); } },
  });
  const projectId = 'project-conversation';
  const eventsPath = layout.getProjectConversationEventsPath(projectId);
  assert.strictEqual(fs.existsSync(eventsPath), false, 'conversation business data must be lazy-created');

  const privatePrompt = 'Implement secret conversation behavior without logging this body.';
  const user = {
    eventId: 'event-user-1',
    sequence: 10,
    source: 'codex',
    eventType: 'user_prompt',
    role: 'user',
    content: privatePrompt,
    sessionId: 'session-1',
    turnId: 'turn-1',
    projectPath: path.join(root, 'repo'),
    repoIdentity: { commonDir: path.join(root, 'repo', '.git') },
    branch: 'main',
    headAtCapture: 'a'.repeat(40),
    capturedAt: '2026-08-18T01:00:00.000Z',
    rawEventType: 'user-prompt-submit',
    identityConfidence: 'high',
    captureStatus: 'captured',
  };
  const concurrent = await Promise.all(Array.from({ length: 8 }, () => store.appendEvent(projectId, user)));
  assert.strictEqual(concurrent.filter(result => result.appended).length, 1, 'eventId dedupe must be atomic under overlap');
  assert.strictEqual(store.readEvents(projectId).length, 1);
  assert.strictEqual(store.readEvents(projectId)[0].content, privatePrompt, 'full prompt belongs in the private business store');
  assert.strictEqual(store.readEvents(projectId)[0].contentHash, sha256(privatePrompt));
  assert(!JSON.stringify(logRecords).includes(privatePrompt), 'conversation body must never enter structured logs');
  assert(JSON.stringify(logRecords).includes(sha256(privatePrompt)), 'logs may retain body hash for correlation');

  await assert.rejects(
    () => store.appendEvent(projectId, { ...user, content: 'different body' }),
    error => error.code === 'DATA_CORRUPT',
    'same eventId with different content must never be silently deduplicated',
  );
  await store.appendEvent(projectId, {
    ...user,
    eventId: 'event-assistant-1',
    sequence: 11,
    eventType: 'assistant_response',
    role: 'assistant',
    content: 'Implemented and verified.',
    capturedAt: '2026-08-18T01:01:00.000Z',
  });

  const legacy = {
    schema: SCHEMAS.requirement,
    id: 'req-legacy-1',
    projectId,
    ts: '2026-08-18T00:30:00.000Z',
    client: 'claude',
    sessionId: 'legacy-session',
    branch: 'main',
    headAtRecord: 'b'.repeat(40),
    requirement: 'Legacy explicit requirement.',
    requirementHash: sha256('Legacy explicit requirement.'),
    commitSha: 'c'.repeat(40),
  };
  const imported = await store.importLegacyRequirements(projectId, [legacy, legacy]);
  assert.strictEqual(imported.filter(result => result.appended).length, 1, 'legacy adapter must share eventId dedupe with Bridge events');
  const legacyEvent = store.readEvents(projectId).find(event => event.legacyRequirementId === legacy.id);
  assert.strictEqual(legacyEvent.source, 'claude-code');
  assert.strictEqual(legacyEvent.captureStatus, 'legacy-explicit-adapter');
  assert.strictEqual(legacyEvent.sequence, null, 'legacy evidence must not invent a Bridge cursor');

  const commitSha = 'd'.repeat(40);
  const boundary = store.writeBoundary(projectId, {
    commitSha,
    repoIdentity: user.repoIdentity,
    parentShas: ['c'.repeat(40)],
    branch: 'main',
    committedAt: '2026-08-18T01:00:30.000Z',
    bridgeCursorAtCommit: 10,
    openTurnIdsAtCommit: ['turn-1'],
    operationId: 'op-boundary-1',
  });
  assert.strictEqual(boundary.schema, SCHEMAS.gitCommitBoundary);
  assert(fs.existsSync(layout.getProjectCommitBoundaryPath(projectId, commitSha)));

  const snapshot = store.writeSnapshot(projectId, {
    commitSha,
    repoIdentity: user.repoIdentity,
    parentSha: 'c'.repeat(40),
    boundaryStartCursor: 0,
    boundaryEndCursor: 10,
    status: 'available',
    turns: [{
      turnId: 'turn-1',
      source: 'codex',
      sessionId: 'session-1',
      bindingKind: 'direct',
      userEvents: [{ eventId: 'event-user-1', sequence: 10, content: privatePrompt, contentHash: sha256(privatePrompt), capturedAt: user.capturedAt }],
      assistantEvents: [],
    }],
    excludedFuturePromptCount: 0,
    finalizedAt: '2026-08-18T01:02:00.000Z',
  });
  assert(snapshot.snapshotHash.startsWith('sha256:'));
  assert.strictEqual(store.readSnapshot(projectId, commitSha).turns[0].userEvents[0].content, privatePrompt);
  await assert.rejects(
    async () => store.writeSnapshot(projectId, { ...snapshot, status: 'ambiguous', finalizedAt: snapshot.finalizedAt }),
    error => error.code === 'IMMUTABLE_FIELD',
  );
  assert(!layout.getProjectCommitConversationPath(projectId, commitSha).startsWith(knowledgeRoot), 'conversation evidence must remain outside the user Markdown root');

  const failingProject = 'project-append-failure';
  const blocker = layout.getProjectConversationEventsPath(failingProject);
  fs.mkdirSync(blocker, { recursive: true });
  await assert.rejects(() => store.appendEvent(failingProject, { ...user, eventId: 'event-fail-1' }));
  assert.deepStrictEqual(fs.readdirSync(blocker), [], 'failed append must not create partial event data');

  console.log('conversation-store-test PASS');
})().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
