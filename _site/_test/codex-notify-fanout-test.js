// Run: node _site/_test/codex-notify-fanout-test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), `pk-codex-fanout-${process.pid}-`));
const receiver = path.join(TEMP, 'receiver.cjs');
const nextOutput = path.join(TEMP, 'next.json');
const bridgeOutput = path.join(TEMP, 'bridge.json');

fs.writeFileSync(receiver, "let data=''; process.stdin.on('data', chunk => data += chunk); process.stdin.on('end', () => require('fs').writeFileSync(process.argv[2], data));", 'utf8');

function encoded(output) {
  return Buffer.from(JSON.stringify([process.execPath, receiver, output])).toString('base64');
}

async function waitFor(file) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (fs.existsSync(file)) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${path.basename(file)}`);
}

(async () => {
  const payload = JSON.stringify({ session_id: 'codex-session-test', type: 'turn-ended' });
  const result = spawnSync(process.execPath, [
    path.join(ROOT, '_site', 'scripts', 'codex-notify-fanout.cjs'),
    '--next-base64', encoded(nextOutput),
    '--bridge-base64', encoded(bridgeOutput),
  ], { input: payload, encoding: 'utf8', windowsHide: true });
  assert.strictEqual(result.status, 0, result.stderr || 'fan-out process should succeed');
  await Promise.all([waitFor(nextOutput), waitFor(bridgeOutput)]);
  assert.strictEqual(fs.readFileSync(nextOutput, 'utf8'), payload, 'existing notifier must receive the original Codex payload');
  assert.strictEqual(fs.readFileSync(bridgeOutput, 'utf8'), payload, 'Bridge must receive the same Codex payload');
  console.log('codex-notify-fanout-test PASS');
})().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}).finally(() => {
  fs.rmSync(TEMP, { recursive: true, force: true });
});
