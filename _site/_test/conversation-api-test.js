const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnServer } = require('./helpers/spawn-server');
const { StorageLayout } = require('../lib/storage-layout');
const { SettingsStore } = require('../lib/settings-store');
const { ProjectRegistryStore } = require('../lib/project-registry-store');
const { ProjectStore } = require('../lib/project-store');
const { ConversationStore } = require('../lib/conversation-store');
const { localDate } = require('../lib/conversation-query-service');

const ROOT = path.resolve(__dirname, '..', '..');
const PORT = 8250 + (process.pid % 300);
const BASE = `http://127.0.0.1:${PORT}`;

async function waitForServer() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('server did not start');
}

(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-conversation-api-'));
  const layout = new StorageLayout({ dataDir });
  const settings = new SettingsStore({ layout });
  const registry = new ProjectRegistryStore({ layout });
  const projects = new ProjectStore({ layout });
  await settings.initialize({ knowledge: { rootPath: path.join(dataDir, 'knowledge') } });
  await registry.initialize();
  const projectId = 'project-conversation-api';
  const repoPath = path.join(dataDir, 'repo');
  const knowledgePath = path.join(dataDir, 'knowledge', projectId);
  fs.mkdirSync(repoPath, { recursive: true });
  fs.mkdirSync(knowledgePath, { recursive: true });
  await projects.create(projectId, {
    displayName: 'Conversation API', storageName: 'conversation-api', repoPath, knowledgePath,
  }, { conversationBaselineCursor: 0, conversation: { lastConsumedCursor: 0, captureStatus: 'captured' } });
  await registry.add(projectId, { displayNameSnapshot: 'Conversation API' });
  const store = new ConversationStore({ layout, projectStore: projects });
  const repoIdentity = { repoId: 'conversation-api-repo' };
  const unsafePrompt = '<script>alert("conversation-body")</script> Keep this as plain text.';
  async function append(eventId, sequence, turnId, role, content, capturedAt) {
    return (await store.appendEvent(projectId, {
      eventId, sequence, source: 'codex', eventType: role === 'user' ? 'user_prompt' : 'assistant_response', role, content,
      sessionId: 'session-api', turnId, repoIdentity, projectPath: repoPath, branch: 'main', headAtCapture: '0'.repeat(40),
      capturedAt, identityConfidence: 'high', captureStatus: 'captured',
    })).event;
  }
  const r1 = await append('r1', 1, 'turn-1', 'user', unsafePrompt, '2026-08-18T01:00:00.000Z');
  const a1 = await append('a1', 2, 'turn-1', 'assistant', 'Rendered only as plain assistant text.', '2026-08-18T01:01:00.000Z');
  const r2 = await append('r2', 3, 'turn-2', 'user', 'Second prompt.', '2026-08-18T02:00:00.000Z');
  const a2 = await append('a2', 4, 'turn-2', 'assistant', 'Second reply.', '2026-08-18T02:01:00.000Z');
  await append('r3', 5, 'turn-3', 'user', 'Third prompt.', '2026-08-18T03:00:00.000Z');
  await append('r4', 6, 'turn-other-date', 'user', 'Other date prompt.', '2026-08-19T03:00:00.000Z');
  const projectEvent = event => ({ eventId: event.eventId, sequence: event.sequence, content: event.content, contentHash: event.contentHash, capturedAt: event.capturedAt });
  store.writeSnapshot(projectId, {
    commitSha: '1'.repeat(40), repoIdentity, parentSha: null, boundaryStartCursor: 0, boundaryEndCursor: 2, status: 'available',
    turns: [{ turnId: 'turn-1', source: 'codex', sessionId: 'session-api', bindingKind: 'direct', userEvents: [projectEvent(r1)], assistantEvents: [projectEvent(a1)] }],
  });
  store.writeSnapshot(projectId, {
    commitSha: '2'.repeat(40), repoIdentity, parentSha: '1'.repeat(40), boundaryStartCursor: 2, boundaryEndCursor: 4, status: 'available',
    turns: [{ turnId: 'turn-2', source: 'codex', sessionId: 'session-api', bindingKind: 'shared-spanning', userEvents: [projectEvent(r2)], assistantEvents: [projectEvent(a2)] }],
  });

  const spawned = spawnServer({ root: ROOT, port: PORT, dataDir, tag: 'conversation-api', extraEnv: { KB_SKIP_MIGRATION: '1' } });
  try {
    await waitForServer();
    let response = await fetch(`${BASE}/api/conversations/projects`);
    let body = await response.json();
    assert.strictEqual(response.status, 200);
    assert.deepStrictEqual(body.projects.map(project => project.projectId), [projectId]);
    assert.strictEqual(Object.hasOwn(body.projects[0], 'repoPath'), false, 'project picker payload must not expose raw repository paths');

    const date = localDate(r1.capturedAt);
    response = await fetch(`${BASE}/api/conversations/turns?projectId=${projectId}&date=${date}&limit=2`);
    body = await response.json();
    assert.strictEqual(response.status, 200, JSON.stringify(body));
    assert.strictEqual(body.turns.length, 2);
    assert(body.nextCursor && body.hasMore);
    const firstPage = body.turns;
    response = await fetch(`${BASE}/api/conversations/turns?projectId=${projectId}&date=${date}&limit=2&cursor=${encodeURIComponent(body.nextCursor)}`);
    const secondPage = await response.json();
    assert.strictEqual(secondPage.turns.length, 1);
    const allTurns = [...firstPage, ...secondPage.turns];
    const turn1 = allTurns.find(turn => turn.turnId === 'turn-1');
    const turn2 = allTurns.find(turn => turn.turnId === 'turn-2');
    const turn3 = allTurns.find(turn => turn.turnId === 'turn-3');
    assert.strictEqual(turn1.userPrompt, unsafePrompt, 'conversation body should remain exact business data');
    assert.strictEqual(turn1.renderAs, 'plain-text', 'payload must instruct hosts to avoid HTML interpretation');
    assert.strictEqual(turn1.annotation.status, 'committed');
    assert.strictEqual(turn1.annotation.commits[0].shortSha, '1111111');
    assert.strictEqual(turn2.annotation.status, 'associated');
    assert.strictEqual(turn3.annotation.status, 'uncommitted');
    assert(allTurns.every(turn => turn.date === date));

    response = await fetch(`${BASE}/api/conversations/turns?projectId=${projectId}&date=2026-08-19&cursor=${encodeURIComponent(body.nextCursor)}`);
    assert.strictEqual(response.status, 409, 'cursor must be bound to one project/date query');
    response = await fetch(`${BASE}/api/conversations/sessions?projectId=${projectId}`);
    assert.strictEqual(response.status, 404, 'default product API must not expose source/session diagnostic routes');

    response = await fetch(`${BASE}/api/logs/export`);
    const exportedLogs = await response.text();
    assert(!exportedLogs.includes('conversation-body'), 'conversation content must never leak into structured logs or export');
    console.log('conversation-api-test PASS');
  } finally {
    spawned.cleanup();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
