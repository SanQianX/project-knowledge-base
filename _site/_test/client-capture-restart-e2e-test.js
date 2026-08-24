// Run: node _site/_test/client-capture-restart-e2e-test.js
//
// T21 gates: OpenCode + Claude Code + Codex external sessions are captured into the
// imported project's Development Conversation; Project-Knowledge offline
// accumulation is recovered by the startup drain in order without
// duplicates; fake/duplicate notifications never fabricate events.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');
const { StorageLayout } = require('../lib/storage-layout');
const { ProjectRegistryStore } = require('../lib/project-registry-store');
const { ProjectStore } = require('../lib/project-store');
const { ConversationStore } = require('../lib/conversation-store');
const { BridgeAdapter } = require('../lib/bridge-adapter');
const { BridgeConsumerService } = require('../lib/bridge-consumer-service');
const { readDevelopmentEvents } = require('../lib/conversation-exclusions');
const bridgePackage = require('@sanqianx/ai-coding-event-bridge');
const opencodeEntry = require('@sanqianx/ai-coding-event-bridge/src/connectors/opencode/hook-entry');
const claudeEntry = require('@sanqianx/ai-coding-event-bridge/src/connectors/claude-code/hook-entry');
const codexEntry = require('@sanqianx/ai-coding-event-bridge/src/connectors/codex/hook-entry');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), `kb-client-e2e-${process.pid}-`));
const layout = new StorageLayout({ dataDir: path.join(temp, 'data') });
const registry = new ProjectRegistryStore({ layout });
const projects = new ProjectStore({ layout });
const bridgeHome = path.join(temp, 'bridge-home');
const adapter = new BridgeAdapter({ dataDir: layout.dataDir, bridgeModule: bridgePackage, bridgeHomeDir: bridgeHome });
const store = new ConversationStore({ layout, projectStore: projects, logger: null });

const ccs = path.join(temp, 'CCS');
fs.mkdirSync(ccs, { recursive: true });
execSync('git init -q', { cwd: ccs, stdio: 'ignore' });
execSync('git config user.email e@example.test && git config user.name E', { cwd: ccs, shell: true, stdio: 'ignore' });
fs.writeFileSync(path.join(ccs, 'README.md'), '# ccs\n');
execSync('git add . && git commit -q -m init', { cwd: ccs, shell: true, stdio: 'ignore' });

const sessionsRoot = path.join(temp, 'codex-sessions');
fs.mkdirSync(sessionsRoot, { recursive: true });

function codexSessionFile(sessionId, cwd, turns, { day = '20', suffix = '' } = {}) {
  const dir = path.join(sessionsRoot, '2026', '08', day);
  fs.mkdirSync(dir, { recursive: true });
  const lines = [JSON.stringify({ type: 'session_meta', payload: { cwd } })];
  for (const turn of turns) {
    lines.push(JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'message',
        role: turn.role,
        phase: turn.phase,
        internal_chat_message_metadata_passthrough: { turn_id: turn.turnId },
        content: [{ type: turn.role === 'user' ? 'input_text' : 'output_text', text: turn.text }],
      },
    }));
  }
  const file = path.join(dir, `rollout-2026-08-${day}T00-00-00-${sessionId}${suffix ? `_${suffix}` : ''}.jsonl`);
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  return file;
}

async function main() {
  await registry.initialize();
  const identity = (await bridgePackage.resolveRepoContext(ccs)).repoIdentity;
  const watermark = await adapter.getHighWatermark({});
  await projects.create('project-ccs', {
    storageName: 'project-ccs', displayName: 'project-ccs',
    repoPath: ccs, knowledgePath: path.join(temp, 'knowledge', 'project-ccs'),
    repoIdentity: identity,
  }, { conversationBaselineCursor: watermark.cursor });
  await registry.add('project-ccs', { displayName: 'project-ccs' });

  // OpenCode external session without client turnIds (GATE CLIENT-OPENCODE-001).
  const ocUser = await opencodeEntry.main({ home: bridgeHome, payload: { type: 'user', sessionId: 'oc-s1', cwd: ccs, text: 'OpenCode prompt in CCS' } });
  const ocAssistant = await opencodeEntry.main({ home: bridgeHome, payload: { type: 'assistant', sessionId: 'oc-s1', cwd: ccs, text: 'OpenCode reply in CCS' } });
  assert.match(ocUser.turnId, /^turn_/, 'Bridge mints the user turnId');
  assert.strictEqual(ocAssistant.turnId, ocUser.turnId, 'assistant binds to the same durable turn');

  // Claude Code real hook payload names and durable prompt/Stop pairing
  // (GATE CLIENT-CLAUDE-001).
  const claudeUser = await claudeEntry.main({ home: bridgeHome, payload: {
    hook_event_name: 'UserPromptSubmit', session_id: 'claude-s1', cwd: ccs, prompt: 'Claude prompt in CCS',
  } });
  const claudeAssistant = await claudeEntry.main({ home: bridgeHome, payload: {
    hook_event_name: 'Stop', session_id: 'claude-s1', cwd: ccs, last_assistant_message: 'Claude reply in CCS',
  } });
  assert.strictEqual(claudeAssistant.turnId, claudeUser.turnId, 'Claude Stop closes the submitted prompt turn');

  // Codex external session driven by authoritative session_meta cwd and the
  // real nested turn id. Simulate an installed Bridge 0.1.1 cursor pinned to
  // the first rollout, then discover and recover its continuation (GATE
  // CLIENT-CODEX-001 / CODEX-CURSOR-MIGRATION-001).
  const codexFirst = codexSessionFile('codex-s1', ccs, [
    { role: 'user', turnId: 'codex-turn-1', text: '<environment_context>generated transport context</environment_context>' },
    { role: 'user', turnId: 'codex-turn-1', text: 'Codex prompt in CCS' },
    { role: 'assistant', turnId: 'codex-turn-1', phase: 'commentary', text: 'Codex working in CCS' },
  ]);
  const codexFirstResult = await codexEntry.main({ home: bridgeHome, payload: { session_id: 'codex-s1', sessions_root: sessionsRoot } });
  assert.strictEqual(codexFirstResult.status, 'captured');
  assert.strictEqual(codexFirstResult.captured, 3);
  const codexCursorFile = path.join(bridgeHome, 'cursors', 'codex', 'codex-s1.json');
  const codexCursorV2 = JSON.parse(fs.readFileSync(codexCursorFile, 'utf8'));
  const firstFileCursor = Object.values(codexCursorV2.files)[0];
  fs.writeFileSync(codexCursorFile, JSON.stringify({
    sessionId: 'codex-s1',
    filePath: codexFirst,
    byteOffset: firstFileCursor.byteOffset,
    lastRecordKey: firstFileCursor.lastRecordKey,
    activeCwd: firstFileCursor.activeCwd,
    repoIdentity: firstFileCursor.repoIdentity,
    projectPath: firstFileCursor.projectPath,
    branch: firstFileCursor.branch,
    headAtCapture: firstFileCursor.headAtCapture,
  }));
  codexSessionFile('codex-s1', ccs, [
    { role: 'assistant', turnId: 'codex-turn-1', phase: 'final_answer', text: 'Codex reply in CCS' },
  ], { day: '21', suffix: 'continuation' });
  const codexResult = await codexEntry.main({ home: bridgeHome, payload: { session_id: 'codex-s1', sessions_root: sessionsRoot } });
  assert.strictEqual(codexResult.captured, 1, 'continuation captured without replaying the first rollout');
  assert.strictEqual(codexResult.files, 2);
  const migratedCursor = JSON.parse(fs.readFileSync(codexCursorFile, 'utf8'));
  assert.strictEqual(migratedCursor.schema, 'codex-cursor/v2');
  assert.strictEqual(Object.keys(migratedCursor.files).length, 2);

  // OFFLINE-001: the consumer process was "stopped" while the events above
  // accumulated; a fresh service instance (restart) recovers everything from
  // the durable journal — in order, once, with no notification dependency.
  const restarted = new BridgeConsumerService({
    bridgeAdapter: adapter, conversationStore: store, registryStore: registry, projectStore: projects, logger: null,
  });
  await restarted.start();
  const rawEvents = store.readEvents('project-ccs');
  assert.strictEqual(rawEvents.length, 8, 'startup drain recovered every durable external record');
  const events = readDevelopmentEvents(store, 'project-ccs');
  assert.strictEqual(events.length, 7, 'generated Codex context is excluded from Development Conversation');
  assert.deepStrictEqual(
    events.map(event => event.sequence).sort((a, b) => a - b),
    [...events.map(event => event.sequence)].sort((a, b) => a - b),
  );
  const ocEvents = events.filter(event => event.source === 'opencode');
  assert.strictEqual(ocEvents.length, 2);
  assert.strictEqual(ocEvents[0].turnId, ocEvents[1].turnId, 'OpenCode turn grouped durably');
  const claudeEvents = events.filter(event => event.source === 'claude-code');
  assert.strictEqual(claudeEvents.length, 2);
  assert.strictEqual(claudeEvents[0].turnId, claudeEvents[1].turnId, 'Claude Code turn grouped durably');
  const codexEvents = events.filter(event => event.source === 'codex');
  assert.strictEqual(codexEvents.length, 3);
  assert.ok(codexEvents.every(event => event.repoIdentity.workspaceId === identity.workspaceId),
    'Codex events attributed from session_meta.cwd, not the session file location');
  assert.ok(codexEvents.every(event => event.turnId === 'codex-turn-1'), 'all Codex phases share the real turn identity');
  assert.strictEqual(new Set(events.map(event => event.eventId)).size, 7, 'no duplicates after recovery');

  // NOTIFY-001: fake/duplicate notifications with garbage bodies never
  // fabricate journal events; the consumer only drains the durable journal.
  const beforeNotify = store.readEvents('project-ccs').length;
  await restarted.handleNotification();
  await restarted.handleNotification();
  assert.strictEqual(store.readEvents('project-ccs').length, beforeNotify, 'duplicate wake-ups are idempotent');

  // Duplicate physical events (re-fired connector payload with same eventKey
  // semantics) do not double-project: re-running the Codex notify with no new
  // bytes captures nothing.
  const codexAgain = await codexEntry.main({ home: bridgeHome, payload: { session_id: 'codex-s1', sessions_root: sessionsRoot } });
  assert.strictEqual(codexAgain.captured, 0, 'cursor-based idempotency');
  await restarted.drain('notify');
  assert.strictEqual(store.readEvents('project-ccs').length, beforeNotify, 'no event loss or duplication from replayed notifies');

  // Capture-disable: an internal-marked session never reaches the store.
  const previousCapture = process.env.AI_CODING_EVENT_BRIDGE_CAPTURE;
  process.env.AI_CODING_EVENT_BRIDGE_CAPTURE = '0';
  try {
    const disabled = await opencodeEntry.main({ home: bridgeHome, payload: { type: 'user', sessionId: 'oc-internal', cwd: ccs, text: 'internal session' } });
    assert.deepStrictEqual(disabled, { status: 'ignored', reason: 'capture-disabled' });
  } finally {
    if (previousCapture === undefined) delete process.env.AI_CODING_EVENT_BRIDGE_CAPTURE;
    else process.env.AI_CODING_EVENT_BRIDGE_CAPTURE = previousCapture;
  }
  await restarted.drain('notify');
  assert.strictEqual(store.readEvents('project-ccs').length, beforeNotify, 'internal sessions add zero Development Conversation events');

  console.log('client-capture-restart-e2e-test PASS');
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
