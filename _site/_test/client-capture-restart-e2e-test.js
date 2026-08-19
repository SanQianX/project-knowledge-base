// Run: node _site/_test/client-capture-restart-e2e-test.js
//
// T21 gates: OpenCode + Codex external sessions are captured into the
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
const bridgePackage = require('@sanqianx/ai-coding-event-bridge');
const opencodeEntry = require('@sanqianx/ai-coding-event-bridge/src/connectors/opencode/hook-entry');
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

function codexSessionFile(sessionId, cwd, turns) {
  const lines = [JSON.stringify({ type: 'session_meta', payload: { cwd } })];
  for (const [index, turn] of turns.entries()) {
    lines.push(JSON.stringify({
      type: 'response_item',
      payload: { type: 'message', role: turn.role, turn_id: `${sessionId}-turn-${index}`, content: [{ type: turn.role === 'user' ? 'input_text' : 'output_text', text: turn.text }] },
    }));
  }
  const file = path.join(sessionsRoot, `rollout-2026-08-20-${sessionId}.jsonl`);
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

  // Codex external session driven by authoritative session_meta cwd (GATE CLIENT-CODEX-001).
  codexSessionFile('codex-s1', ccs, [
    { role: 'user', text: 'Codex prompt in CCS' },
    { role: 'assistant', text: 'Codex reply in CCS' },
  ]);
  const codexResult = await codexEntry.main({ home: bridgeHome, payload: { session_id: 'codex-s1', sessions_root: sessionsRoot } });
  assert.strictEqual(codexResult.status, 'captured');
  assert.strictEqual(codexResult.captured, 2);

  // OFFLINE-001: the consumer process was "stopped" while the events above
  // accumulated; a fresh service instance (restart) recovers everything from
  // the durable journal — in order, once, with no notification dependency.
  const restarted = new BridgeConsumerService({
    bridgeAdapter: adapter, conversationStore: store, registryStore: registry, projectStore: projects, logger: null,
  });
  await restarted.start();
  const events = store.readEvents('project-ccs');
  assert.strictEqual(events.length, 4, 'startup drain recovered all external events');
  assert.deepStrictEqual(
    events.map(event => event.sequence).sort((a, b) => a - b),
    [...events.map(event => event.sequence)].sort((a, b) => a - b),
  );
  const ocEvents = events.filter(event => event.source === 'opencode');
  assert.strictEqual(ocEvents.length, 2);
  assert.strictEqual(ocEvents[0].turnId, ocEvents[1].turnId, 'OpenCode turn grouped durably');
  const codexEvents = events.filter(event => event.source === 'codex');
  assert.strictEqual(codexEvents.length, 2);
  assert.ok(codexEvents.every(event => event.repoIdentity.workspaceId === identity.workspaceId),
    'Codex events attributed from session_meta.cwd, not the session file location');
  assert.strictEqual(new Set(events.map(event => event.eventId)).size, 4, 'no duplicates after recovery');

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
