// Run: node _site/_test/codex-notify-capture-e2e-test.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { IntegrationManager } = require('../lib/integration-installer');
const bridge = require('@sanqianx/ai-coding-event-bridge-console/src/bridge');

const ROOT = path.resolve(__dirname, '..', '..');
const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-codex-notify-e2e-'));
const repoPath = path.join(TEMP, '中文 project');
const bridgeHomeDir = path.join(TEMP, 'bridge home');
const sessionsRoot = path.join(TEMP, 'isolated sessions');
const configFile = path.join(TEMP, 'home', '.codex', 'config.toml');
const radarFile = path.join(TEMP, 'tools', 'devtask-radar', 'connectors', 'codex', 'notify-hook.js');
const receivedFile = path.join(TEMP, 'third-party-payload.json');
const sessionId = 'local-notify-e2e-session';

async function waitFor(check, label) {
  for (let attempt = 0; attempt < 200; attempt++) {
    try { if (check()) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out: ${label}`);
}

function readEvents(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)) : [];
}

function invokeNotify(notify, payload) {
  const env = { ...process.env, CODEX_SESSIONS_ROOT: sessionsRoot };
  // A fresh client does not inherit the shell's Bridge-home override. The
  // installed shim must resolve its own target directory from its location.
  delete env.AI_CODING_EVENT_BRIDGE_HOME;
  const result = spawnSync(notify[0], [...notify.slice(1), payload], { env, cwd: repoPath, encoding: 'utf8', windowsHide: true, timeout: 5000 });
  assert.strictEqual(result.status, 0, result.stderr || result.error?.message);
}

async function main() {
  fs.mkdirSync(repoPath, { recursive: true });
  const initialized = spawnSync('git', ['init', '-q'], { cwd: repoPath, encoding: 'utf8', windowsHide: true });
  assert.strictEqual(initialized.status, 0, initialized.stderr);
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  fs.mkdirSync(path.dirname(radarFile), { recursive: true });
  fs.writeFileSync(radarFile, `require('fs').writeFileSync(${JSON.stringify(receivedFile)}, JSON.stringify(process.argv.slice(2)));`);
  fs.writeFileSync(configFile, `notify = ${JSON.stringify(['node', radarFile])}\n`);
  const manager = new IntegrationManager({ rootDir: ROOT, homeDir: path.join(TEMP, 'home'), env: {}, bridgeHomeDir, codexConfigFile: configFile });
  const result = await manager.installCaptureCodex();
  assert(result.installed && !result.conflict);
  const registered = await bridge.projectRegistry.addProject({ home: bridgeHomeDir, path: repoPath, store: path.join(TEMP, 'project event store') });
  const eventsFile = path.join(registered.store, 'journal', 'events.jsonl');
  const cursorFile = path.join(bridgeHomeDir, 'cursors', 'codex', `${sessionId}.json`);
  fs.mkdirSync(sessionsRoot, { recursive: true });
  const record = (type, payload) => JSON.stringify({ timestamp: new Date().toISOString(), type, payload });
  const messages = [
    record('session_meta', { id: sessionId, cwd: repoPath }),
    record('response_item', { type: 'message', role: 'user', internal_chat_message_metadata_passthrough: { turn_id: 'turn-local-1' }, content: [{ type: 'input_text', text: '隔离采集验证：用户原始请求' }] }),
    record('response_item', { type: 'message', role: 'assistant', phase: 'final_answer', internal_chat_message_metadata_passthrough: { turn_id: 'turn-local-1' }, content: [{ type: 'output_text', text: '隔离采集验证：rollout 原始回答' }] }),
  ];
  fs.writeFileSync(path.join(sessionsRoot, `rollout-${sessionId}.jsonl`), messages.join('\n') + '\n');
  const notify = JSON.parse(fs.readFileSync(configFile, 'utf8').split(/\r?\n/).find(line => /^notify\s*=/.test(line)).replace(/^notify\s*=\s*/, ''));
  const payload = '{ "type": "agent-turn-complete", "thread-id": "local-notify-e2e-session", "turn-id": "turn-local-1", "last-assistant-message": "NOT-EVIDENCE: do not use the notification summary" }';
  invokeNotify(notify, payload);
  await waitFor(() => fs.existsSync(cursorFile) && fs.existsSync(receivedFile) && readEvents(eventsFile).length === 2, 'official notify → real runtime → project journal');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(receivedFile, 'utf8')), [payload], 'third party receives unchanged JSON argv');
  const captured = readEvents(eventsFile);
  assert.deepStrictEqual(captured.map(event => event.content), ['隔离采集验证：用户原始请求', '隔离采集验证：rollout 原始回答']);
  assert(captured.every(event => event.source === 'codex' && event.sessionId === sessionId && event.turnId === 'turn-local-1'));
  assert(captured.every(event => event.repoIdentity.workspaceId === registered.id && path.resolve(event.projectPath).toLowerCase() === path.resolve(repoPath).toLowerCase()), 'workspace comes from rollout metadata, not the notification or server cwd');
  assert(!JSON.stringify(captured).includes('NOT-EVIDENCE'), 'notification summaries are never captured as conversation facts');

  const beforeRepeat = JSON.parse(fs.readFileSync(cursorFile, 'utf8')).updatedAt;
  await new Promise(resolve => setTimeout(resolve, 25));
  invokeNotify(notify, payload);
  // Filesystems may coalesce mtime; the durable cursor timestamp proves that
  // the reader completed another pass rather than merely touching a file.
  await waitFor(() => JSON.parse(fs.readFileSync(cursorFile, 'utf8')).updatedAt !== beforeRepeat, 'second notification reaches the real cursor reader');
  assert.strictEqual(readEvents(eventsFile).length, 2, 'duplicate notify cannot duplicate captured evidence');

  invokeNotify(notify, JSON.stringify({ type: 'agent-turn-complete', 'thread-id': 'missing-session-e2e', 'last-assistant-message': 'must not be fabricated' }));
  const gapsFile = path.join(bridgeHomeDir, 'journal', 'capture-gaps.jsonl');
  await waitFor(() => readEvents(gapsFile).some(item => item.sessionId === 'missing-session-e2e' && item.reason === 'session-file-not-found'), 'missing rollout is an explicit capture gap');
  assert.strictEqual(readEvents(eventsFile).length, 2, 'missing session cannot be guessed from the newest rollout');

  await manager.uninstallCaptureCodex();
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(configFile, 'utf8').split(/\r?\n/).find(line => /^notify\s*=/.test(line)).replace(/^notify\s*=\s*/, '')), ['node', radarFile]);
  assert.strictEqual(readEvents(eventsFile).length, 2, 'uninstall retains existing evidence');
  console.log('codex-notify-capture-e2e-test PASS (real Git, installed Bridge runtime and project journal; fixture rollout, no LLM calls)');
}

module.exports = main().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}).finally(() => {
  assert(path.resolve(TEMP).startsWith(`${path.resolve(os.tmpdir())}${path.sep}`));
  fs.rmSync(TEMP, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});
