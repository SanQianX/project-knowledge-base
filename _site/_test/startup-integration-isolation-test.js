'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const control = require('../lib/runtime-control');
const { markIntent } = require('../lib/integration-intent');
const root = process.env.KB_LAUNCHER_TEST_PACKAGE || path.resolve(__dirname, '../..');
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-startup-integration-'));
const marker = path.join(data, 'slow-native-check.pid');
const preload = path.join(__dirname, 'fixtures/slow-startup-integration.cjs').replace(/\\/g, '/');
let instance;
async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve)); return port;
}
async function main() {
  markIntent(data, 'codex', 'connected');
  const port = await freePort();
  const started = Date.now();
  const launched = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, 'bin/project-knowledge.js'), '--no-open', '--port', String(port)], {
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, KB_DATA_DIR: data, KB_MODULES_AUTOSTART: '0',
        KB_LAUNCHER_TEST_PACKAGE: root, KB_STARTUP_INTEGRATION_MARKER: marker,
        AI_CODING_EVENT_BRIDGE_HOME: path.join(data, 'events'), NODE_OPTIONS: `--require="${preload}"` },
    });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('Background launch timed out')); }, 20000);
    child.stdout.on('data', value => { stdout += value; }); child.stderr.on('data', value => { stderr += value; });
    child.once('error', reject); child.once('exit', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
  assert.equal(launched.code, 0, launched.stderr);
  instance = (await control.request(data, { action: 'status' }, 1000)).instance;
  assert(Date.now() - started < 5000, 'native integration checks must not delay the launcher ready acknowledgement');
  for (let i = 0; i < 60 && !fs.existsSync(marker); i++) await new Promise(resolve => setTimeout(resolve, 50));
  assert(fs.existsSync(marker), 'startup auto repair must still run');
  assert.notEqual(Number(fs.readFileSync(marker, 'utf8')), instance.pid, 'native checks must run outside the HTTP process');
  for (let i = 0; i < 3; i++) {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1000) });
    assert.equal(response.status, 200, 'HTTP must remain usable while a native check is blocked');
    assert.equal((await control.request(data, { action: 'status' }, 1000)).instance.pid, instance.pid);
  }
  const stopAt = Date.now();
  await control.request(data, { action: 'stop', pid: instance.pid, port, startedAt: instance.startedAt }, 4000);
  assert(Date.now() - stopAt < 4000, 'shutdown must cancel the blocked repair worker');
  instance = null;
  console.log('Startup integration isolation PASS: background ready, HTTP/control usable during a blocked native probe, owned worker stopped');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  try {
    const info = instance || (await control.request(data, { action: 'status' }, 1000)).instance;
    await control.request(data, { action: 'stop', pid: info.pid, port: info.port, startedAt: info.startedAt });
  } catch {}
});
