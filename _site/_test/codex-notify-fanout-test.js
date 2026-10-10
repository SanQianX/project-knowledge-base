// Run: node _site/_test/codex-notify-fanout-test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), `pk-codex-fanout-${process.pid}-`));
const fanout = path.join(ROOT, '_site', 'scripts', 'codex-notify-fanout.cjs');
const receiver = path.join(TEMP, 'receiver.cjs');

fs.writeFileSync(receiver, [
  "let data = '';",
  "process.stdin.on('data', chunk => data += chunk);",
  "process.stdin.on('end', () => require('fs').writeFileSync(process.argv[2], JSON.stringify({",
  "  stdin: data, args: process.argv.slice(3), sessionsRoot: process.env.CODEX_SESSIONS_ROOT || null,",
  '})));',
].join('\n'), 'utf8');

function encoded(command) {
  return Buffer.from(JSON.stringify(command)).toString('base64');
}

function receiverCommand(output) {
  return [process.execPath, receiver, path.join(TEMP, output)];
}

function options(next, bridge) {
  return ['--next-base64', encoded(next), '--bridge-base64', encoded(bridge)];
}

async function received(fileName) {
  const file = path.join(TEMP, fileName);
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${fileName}`);
}

function run(args, input = '') {
  const result = spawnSync(process.execPath, [fanout, ...args], {
    input,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 5000,
  });
  assert.strictEqual(result.status, 0, result.stderr || result.error?.message || 'fan-out process should succeed');
  assert.strictEqual(result.stderr, '', 'a broken notifier must not emit an unhandled child-process error');
}

function runWithOpenStdin(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fanout, ...args], {
      stdio: ['pipe', 'ignore', 'pipe'],
      windowsHide: true,
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { stderr += chunk; });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('argv notification waited for stdin to end'));
    }, 5000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', status => {
      clearTimeout(timer);
      child.stdin.destroy();
      try {
        assert.strictEqual(status, 0, stderr || 'argv notification must succeed with stdin still open');
        assert.strictEqual(stderr, '');
        resolve();
      } catch (error) {
        reject(error);
      }
    });
  });
}

(async () => {
  const legacy = JSON.stringify({ session_id: 'codex-session-test', type: 'turn-ended' });
  run(options(receiverCommand('stdin-next.json'), receiverCommand('stdin-bridge.json')), legacy);
  const [stdinNext, stdinBridge] = await Promise.all([received('stdin-next.json'), received('stdin-bridge.json')]);
  assert.strictEqual(stdinNext.stdin, legacy, 'stdin notifier keeps the original payload bytes');
  assert.deepStrictEqual(stdinNext.args, [], 'stdin notification is not unexpectedly converted into argv');
  assert.strictEqual(stdinBridge.stdin, legacy, 'existing session_id payload remains unchanged');
  assert.deepStrictEqual(stdinBridge.args, [], 'Bridge always receives stdin');

  // This is the documented Codex notify shape, not an invented session event.
  const official = '{ "type": "agent-turn-complete", "thread-id": "codex-thread-test", "turn-id": "turn-41", "last-assistant-message": "摘要不应成为伪造的会话证据" }';
  await runWithOpenStdin([
    ...options(receiverCommand('argv-next.json'), receiverCommand('argv-bridge.json')),
    official,
  ]);
  const [argvNext, argvBridge] = await Promise.all([received('argv-next.json'), received('argv-bridge.json')]);
  assert.deepStrictEqual(argvNext.args, [official], 'third-party notifier receives the original single JSON argument');
  assert.strictEqual(argvNext.stdin, '', 'argv notifier must not also receive a duplicate stdin payload');
  const normalized = JSON.parse(argvBridge.stdin);
  assert.strictEqual(normalized.session_id, 'codex-thread-test', 'official thread-id wakes the matching Bridge rollout reader');
  assert.strictEqual(normalized.turn_id, 'turn-41');
  assert.strictEqual(normalized['last-assistant-message'], JSON.parse(official)['last-assistant-message']);
  assert.deepStrictEqual(argvBridge.args, [], 'official payload is adapted into Bridge stdin only');
  assert.strictEqual(argvBridge.sessionsRoot, process.env.CODEX_SESSIONS_ROOT || path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions'));

  run(options(receiverCommand('official-stdin-next.json'), receiverCommand('official-stdin-bridge.json')), official);
  const [officialStdinNext, officialStdinBridge] = await Promise.all([
    received('official-stdin-next.json'), received('official-stdin-bridge.json'),
  ]);
  assert.strictEqual(officialStdinNext.stdin, official, 'legacy stdin transport preserves official payload bytes for third parties');
  assert.strictEqual(JSON.parse(officialStdinBridge.stdin).session_id, 'codex-thread-test');

  const alias = JSON.stringify({ sessionId: 'already-authoritative', turnId: 'already-turn', 'thread-id': 'different-thread', 'turn-id': 'different-turn' });
  run(options(null, receiverCommand('alias-bridge.json')), alias);
  assert.strictEqual((await received('alias-bridge.json')).stdin, alias, 'existing authoritative legacy aliases must not be overridden');

  const missingExecutable = [path.join(TEMP, 'missing-notifier.exe')];
  run(options(missingExecutable, receiverCommand('after-next-failure.json')), legacy);
  assert.strictEqual((await received('after-next-failure.json')).stdin, legacy, 'failed third-party spawn cannot block Bridge');
  run([...options(receiverCommand('after-bridge-failure.json'), missingExecutable), official]);
  assert.deepStrictEqual((await received('after-bridge-failure.json')).args, [official], 'failed Bridge spawn cannot block third-party notifier');
  run(['--next-base64', 'not-json', '--bridge-base64', encoded(receiverCommand('after-invalid-next.json'))], legacy);
  assert.strictEqual((await received('after-invalid-next.json')).stdin, legacy, 'invalid encoded branch cannot block the valid branch');

  // A child closing stdin early must not cause an EPIPE crash or lose the other branch.
  run(options([process.execPath, '-e', 'process.exit(0)'], receiverCommand('after-closed-stdin.json')), JSON.stringify({ session_id: 'large-payload', padding: 'x'.repeat(1024 * 1024) }));
  assert.strictEqual(JSON.parse((await received('after-closed-stdin.json')).stdin).session_id, 'large-payload');
  console.log('codex-notify-fanout-test PASS');
})().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}).finally(() => {
  fs.rmSync(TEMP, { recursive: true, force: true });
});
