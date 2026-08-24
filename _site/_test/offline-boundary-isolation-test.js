const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { StorageLayout } = require('../lib/storage-layout');
const { ProjectStore } = require('../lib/project-store');
const { ConversationStore } = require('../lib/conversation-store');
const { CommitConversationBinder } = require('../lib/commit-conversation-binder');

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-offline-boundaries-'));
  try {
    const layout = new StorageLayout({ dataDir: path.join(root, 'data') });
    const projects = new ProjectStore({ layout });
    const projectId = 'project-offline-boundary';
    const identity = { commonDir: path.join(root, 'repo', '.git') };
    await projects.create(projectId, { storageName: 'offline-boundary', displayName: 'Offline Boundary', repoPath: path.join(root, 'repo'), knowledgePath: path.join(root, 'knowledge'), repoIdentity: identity }, { conversationBaselineCursor: 0 });
    const store = new ConversationStore({ layout, projectStore: projects });
    const binder = new CommitConversationBinder({ layout, projectStore: projects, conversationStore: store });
    const add = (sequence, eventId, content) => store.appendEvent(projectId, { eventId, sequence, source: 'codex', eventType: 'user_prompt', role: 'user', content, turnId: eventId, repoIdentity: identity, capturedAt: '2026-08-24T00:00:00.000Z', identityConfidence: 'exact', captureStatus: 'captured' });
    const boundary = (sha, cursor) => store.writeBoundary(projectId, { commitSha: sha, repoIdentity: identity, parentShas: [], branch: 'main', committedAt: '2026-08-24T00:00:00.000Z', bridgeCursorAtCommit: cursor, journalSequence: cursor, openTurnIdsAtCommit: [], operationId: `op-${cursor}` });
    const b = 'b'.repeat(40); const c = 'c'.repeat(40); const d = 'd'.repeat(40);
    await add(1, 'prompt-b', 'offline B'); boundary(b, 2);
    await add(3, 'prompt-c', 'offline C'); boundary(c, 4);
    await add(5, 'prompt-d', 'online D'); boundary(d, 6);
    const snapshot = await binder.bind({ projectId, commitSha: d });
    assert.deepEqual(snapshot.turns.map(turn => turn.turnId), ['prompt-d']);
    assert.equal(JSON.stringify(snapshot).includes('offline B'), false);
    assert.equal(JSON.stringify(snapshot).includes('offline C'), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
  console.log('offline-boundary-isolation-test PASS');
})().catch(error => { console.error(error.stack || error.message); process.exit(1); });
