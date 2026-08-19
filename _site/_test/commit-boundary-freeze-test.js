// Run: node _site/_test/commit-boundary-freeze-test.js
//
// T13 gates: frozen snapshots never contain events beyond the commit
// boundary (I-13), same-workspace-only binding, legacy confidence
// translation, and idempotent freeze.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');
const { StorageLayout } = require('../lib/storage-layout');
const { ProjectRegistryStore } = require('../lib/project-registry-store');
const { ProjectStore } = require('../lib/project-store');
const { ConversationStore } = require('../lib/conversation-store');
const { CommitConversationBinder } = require('../lib/commit-conversation-binder');
const bridgeModule = require('@sanqianx/ai-coding-event-bridge');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), `kb-boundary-freeze-${process.pid}-`));
const layout = new StorageLayout({ dataDir: path.join(temp, 'data') });
const registry = new ProjectRegistryStore({ layout });
const projects = new ProjectStore({ layout });
const store = new ConversationStore({ layout, projectStore: projects, logger: null });

function gitRepo(name) {
  const dir = path.join(temp, name);
  fs.mkdirSync(dir, { recursive: true });
  execSync('git init -q', { cwd: dir, stdio: 'ignore' });
  return dir;
}

function bridgeRecord(sequence, eventType, role, content, repoIdentity, turnId, confidence) {
  return {
    schema: 'ai-coding-event/v1',
    eventId: `evt-${sequence}`,
    sequence,
    source: 'claude-code',
    eventType,
    role,
    content,
    sessionId: 's-boundary',
    turnId,
    repoIdentity,
    identityConfidence: confidence || 'exact',
    captureStatus: 'complete',
    capturedAt: new Date().toISOString(),
  };
}

(async () => {
  await registry.initialize();
  const ccsPath = gitRepo('ccs');
  const ccbPath = gitRepo('ccb');
  const ccs = (await bridgeModule.resolveRepoContext(ccsPath)).repoIdentity;
  const ccb = (await bridgeModule.resolveRepoContext(ccbPath)).repoIdentity;
  const projectId = 'project-freeze';
  await projects.create(projectId, {
    storageName: projectId,
    displayName: projectId,
    repoPath: ccsPath,
    knowledgePath: path.join(temp, 'knowledge', projectId),
    repoIdentity: ccs,
  }, { conversationBaselineCursor: 99 });
  await registry.add(projectId, { displayName: projectId });

  const binder = new CommitConversationBinder({ layout, projectStore: projects, conversationStore: store, logger: null });

  const boundary = (commitSha, cursor, openTurnIds) => store.writeBoundary(projectId, {
    repoIdentity: ccs,
    commitSha,
    parentShas: [],
    branch: 'main',
    committedAt: new Date().toISOString(),
    bridgeCursorAtCommit: cursor,
    openTurnIdsAtCommit: openTurnIds || [],
    operationId: `op-${cursor}`,
    journalSequence: cursor,
  });

  // BOUNDARY-001: user(100), boundary(101), assistant(102) created later.
  await store.appendBridgeEvent(projectId, bridgeRecord(100, 'user_prompt', 'user', 'prompt before boundary', ccs, 'turn-1'));
  await store.appendBridgeEvent(projectId, bridgeRecord(102, 'assistant_response', 'assistant', 'reply after boundary', ccs, 'turn-1'));
  boundary('a'.repeat(40), 101, []);
  const snapshotA = await binder.bind({ projectId, commitSha: 'a'.repeat(40) });
  assert.strictEqual(snapshotA.status, 'available');
  assert.strictEqual(snapshotA.turns.length, 1);
  assert.strictEqual(snapshotA.turns[0].turnId, 'turn-1');
  assert.ok(snapshotA.turns[0].userEvents.some(event => event.sequence === 100), 'user event inside window is bound');
  assert.strictEqual(snapshotA.turns[0].assistantEvents.length, 0, 'assistant beyond boundaryEndCursor must never enter the frozen snapshot');

  // BOUNDARY-002: user(200), assistant(201) before boundary(202).
  await store.appendBridgeEvent(projectId, bridgeRecord(200, 'user_prompt', 'user', 'second prompt', ccs, 'turn-2'));
  await store.appendBridgeEvent(projectId, bridgeRecord(201, 'assistant_response', 'assistant', 'reply before boundary', ccs, 'turn-2'));
  boundary('b'.repeat(40), 202, []);
  const snapshotB = await binder.bind({ projectId, commitSha: 'b'.repeat(40) });
  assert.ok(snapshotB.turns.some(turn => turn.turnId === 'turn-2'
    && turn.assistantEvents.some(event => event.sequence === 201)), 'assistant before boundary may enter');
  assert.ok(!snapshotB.turns.some(turn => turn.turnId === 'turn-1'), 'already-bound turn is not re-selected in the next window');

  // Cross-repo: CCB event right before a CCS commit is never substituted.
  // The consumer would never project a CCB event into the CCS store at all
  // (appendBridgeEvent rejects it); raw appendEvent simulates legacy stored
  // data so the binder's workspace filter is exercised directly.
  {
    const rejected = await store.appendBridgeEvent(projectId, bridgeRecord(299, 'user_prompt', 'user', 'blocked at the door', ccb, 'turn-ccb-blocked')).catch(error => error);
    assert.ok(rejected instanceof Error && rejected.code === 'DATA_CORRUPT', 'appendBridgeEvent rejects foreign-workspace events');
  }
  await store.appendEvent(projectId, {
    eventId: 'evt-300',
    sequence: 300,
    source: 'claude-code',
    eventType: 'user_prompt',
    role: 'user',
    content: 'Modify CCB parser',
    sessionId: 's-boundary',
    turnId: 'turn-ccb',
    repoIdentity: ccb,
    identityConfidence: 'exact',
    captureStatus: 'complete',
    capturedAt: new Date().toISOString(),
  });
  boundary('c'.repeat(40), 301, []);
  const snapshotC = await binder.bind({ projectId, commitSha: 'c'.repeat(40) });
  assert.strictEqual(snapshotC.status, 'no-new-user-prompt', 'no CCS conversation yields a deterministic empty status');
  assert.ok(!JSON.stringify(snapshotC).includes('Modify CCB parser'), 'CCB conversation must not leak into a CCS snapshot');

  // Legacy confidence translation: stored 'high' behaves as exact.
  await store.appendBridgeEvent(projectId, bridgeRecord(400, 'user_prompt', 'user', 'legacy confidence prompt', ccs, 'turn-3', 'high'));
  boundary('d'.repeat(40), 401, []);
  const snapshotD = await binder.bind({ projectId, commitSha: 'd'.repeat(40) });
  assert.ok(snapshotD.turns.some(turn => turn.turnId === 'turn-3'), 'legacy high/trusted translates to exact for old stored data');

  // Partial confidence never binds as direct evidence.
  await store.appendBridgeEvent(projectId, bridgeRecord(500, 'user_prompt', 'user', 'partial identity prompt', ccs, 'turn-4', 'partial'));
  boundary('e'.repeat(40), 501, []);
  const snapshotE = await binder.bind({ projectId, commitSha: 'e'.repeat(40) });
  assert.ok(!snapshotE.turns.some(turn => turn.turnId === 'turn-4'), 'partial identity is ambiguous, never direct evidence');

  // Immutable freeze: rebinding returns the identical hash.
  const rebound = await binder.bind({ projectId, commitSha: 'a'.repeat(40) });
  assert.strictEqual(rebound.snapshotHash, snapshotA.snapshotHash, 'frozen snapshots are never rewritten');

  console.log('commit-boundary-freeze-test PASS');
})().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
