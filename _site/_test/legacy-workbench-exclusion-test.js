// Run: node _site/_test/legacy-workbench-exclusion-test.js
//
// T17 / GATE LEGACY-001: old embedded Workbench pairs are excluded from
// Development Conversation presentation and new commit binding; genuine
// explicit MCP requirements survive; immutable snapshots and JSONL lines are
// never rewritten.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { StorageLayout } = require('../lib/storage-layout');
const { ProjectStore } = require('../lib/project-store');
const { ConversationStore } = require('../lib/conversation-store');
const { CommitConversationBinder } = require('../lib/commit-conversation-binder');
const { computeConversationExclusions, readDevelopmentEvents } = require('../lib/conversation-exclusions');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), `kb-legacy-exclusion-${process.pid}-`));
const layout = new StorageLayout({ dataDir: path.join(temp, 'data') });
const projects = new ProjectStore({ layout });
const store = new ConversationStore({ layout, projectStore: projects, logger: null });
const projectId = 'project-legacy';

const repoIdentity = { commonDir: path.join(temp, 'repo', '.git') };

async function append(input) {
  await store.appendEvent(projectId, {
    source: 'claude-code',
    sessionId: 'legacy-session',
    projectPath: path.join(temp, 'repo'),
    repoIdentity,
    branch: 'main',
    capturedAt: '2026-08-01T00:00:00.000Z',
    ...input,
  });
}

(async () => {
  await projects.create(projectId, {
    displayName: 'Legacy', storageName: 'legacy',
    repoPath: path.join(temp, 'repo'), knowledgePath: path.join(temp, 'knowledge'),
    repoIdentity,
  }, { conversationBaselineCursor: 0 });

  // Old embedded Workbench pair (explicit-REQ1 + embedded-assistant-REQ1).
  await append({ eventId: 'explicit-REQ1', sequence: 1, eventType: 'user_prompt', role: 'user', content: 'Workbench prompt', turnId: 'turn-embed-1', identityConfidence: 'high' });
  await append({ eventId: 'embedded-assistant-REQ1', sequence: 2, eventType: 'assistant_response', role: 'assistant', content: 'Workbench reply', turnId: 'turn-embed-1', rawEventType: 'embedded-claude-result', identityConfidence: 'high' });
  // Genuine explicit MCP requirement NOT paired with an embedded assistant.
  await append({ eventId: 'explicit-REQ2', sequence: 3, eventType: 'user_prompt', role: 'user', content: 'Genuine MCP requirement', turnId: 'turn-explicit-2', identityConfidence: 'explicit', explicitCommitSha: 'f'.repeat(40) });
  // Modern bridge-projected event.
  await append({ eventId: 'evt-bridge-1', sequence: 4, eventType: 'user_prompt', role: 'user', content: 'Modern bridge event', turnId: 'turn-bridge', identityConfidence: 'exact' });

  const eventsRaw = store.readEvents(projectId);
  assert.strictEqual(eventsRaw.length, 4, 'raw JSONL lines are never deleted');

  const manifest = computeConversationExclusions(projectId, eventsRaw);
  assert.deepStrictEqual(manifest.excludedEventIds, ['embedded-assistant-REQ1', 'explicit-REQ1'], 'only the embedded pair is excluded');

  const development = readDevelopmentEvents(store, projectId);
  assert.deepStrictEqual(development.map(event => event.eventId), ['explicit-REQ2', 'evt-bridge-1'], 'genuine explicit + bridge events survive');
  assert.strictEqual(development.some(event => event.content === 'Workbench prompt'), false);
  assert.strictEqual(development.some(event => event.content === 'Workbench reply'), false);

  // Manifest persisted for audit; JSONL untouched.
  const manifestFile = path.join(layout.getProjectMetadataDir(projectId), 'conversation-exclusions.json');
  assert.ok(fs.existsSync(manifestFile), 'exclusion manifest is persisted');
  assert.strictEqual(JSON.parse(fs.readFileSync(manifestFile, 'utf8')).schema, 'conversation-exclusions/v1');
  assert.strictEqual(store.readEvents(projectId).length, 4, 'raw store still holds every historical line');

  // New commit binding excludes the legacy pair.
  const binder = new CommitConversationBinder({ layout, projectStore: projects, conversationStore: store });
  const commitSha = 'a'.repeat(40);
  store.writeBoundary(projectId, {
    repoIdentity, commitSha, parentShas: [], branch: 'main', committedAt: '2026-08-02T00:00:00.000Z',
    bridgeCursorAtCommit: 10, journalSequence: 10, openTurnIdsAtCommit: [], operationId: 'op-legacy',
  });
  const snapshot = await binder.bind({ projectId, commitSha });
  assert.ok(!JSON.stringify(snapshot).includes('Workbench prompt'), 'legacy embedded pair never binds to a new commit');
  assert.ok(!JSON.stringify(snapshot).includes('embedded-claude-result'));

  // An old frozen snapshot written before the migration stays byte-identical.
  const frozenPath = layout.getProjectCommitConversationPath(projectId, commitSha);
  const before = fs.readFileSync(frozenPath, 'utf8');
  const rebound = await binder.bind({ projectId, commitSha });
  assert.strictEqual(rebound.snapshotHash, snapshot.snapshotHash, 'immutable snapshot untouched by exclusion');
  assert.strictEqual(fs.readFileSync(frozenPath, 'utf8'), before);

  console.log('legacy-workbench-exclusion-test PASS');
})().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
