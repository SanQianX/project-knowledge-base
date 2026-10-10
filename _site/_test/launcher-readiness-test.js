'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { spawn } = require('node:child_process');
const endpoint = require('../lib/runtime-endpoint');

const packageRoot = process.env.KB_LAUNCHER_TEST_PACKAGE || path.resolve(__dirname, '../..');
const bin = path.join(packageRoot, 'bin/project-knowledge.js');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-launcher-readiness-'));
const data = path.join(root, '.project-knowledge-v5');
const record = path.join(data, 'runtime/claude-sessions/project-a/session.json');
const recordBytes = JSON.stringify({ schema: 'claude-workbench-session/v1', sessionId: 'old-test', projectSlug: 'project-a', state: 'running', metadata: { automation: true } });
fs.mkdirSync(path.dirname(record), { recursive: true });
fs.writeFileSync(record, recordBytes);
const env = { ...process.env, KB_DATA_DIR: data, KB_MODULES_AUTOSTART: '0', AI_CODING_EVENT_BRIDGE_HOME: path.join(root, 'bridge') };
let serverPid;

function run(args, overrides = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, ...args], { cwd: root, env: { ...env, ...overrides }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`CLI timed out: ${stdout} ${stderr}`)); }, 25000);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}
async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

(async () => {
  const port = await freePort();
  const launched = await run(['--no-open'], { KB_SITE_PORT: String(port) });
  serverPid = endpoint.readEndpoint(data)?.pid;
  assert.equal(launched.code, 0, launched.stderr);
  assert.match(launched.stdout, new RegExp(`is ready at http://127.0.0.1:${port}`));
  assert(serverPid && endpoint.isProcessAlive(serverPid));
  const response = await fetch(`http://127.0.0.1:${port}/api/state`);
  assert.equal(response.status, 200, 'ready must mean HTTP is usable, not only a PID exists');
  const state = await response.json();
  assert.deepEqual(state.projects, [], 'abandoned sessions must not import projects or enqueue analysis');
  assert.equal(fs.readFileSync(record, 'utf8'), recordBytes);
  const again = await run(['--no-open']);
  assert.equal(again.code, 0);
  assert.match(again.stdout, /Already running/);
  const stopped = await run(['stop']);
  assert.equal(stopped.code, 0);
  for (let attempt = 0; attempt < 50 && endpoint.isProcessAlive(serverPid); attempt++) await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(endpoint.isProcessAlive(serverPid), false);
  serverPid = null;

  const oldData = path.join(root, 'actual-old-data');
  fs.mkdirSync(oldData);
  const original = JSON.stringify({ projectOrder: ['old-project'] });
  fs.writeFileSync(path.join(oldData, 'projects.json'), original);
  const failed = await run(['--no-open', '--port', String(port)], { KB_DATA_DIR: oldData });
  assert.equal(failed.code, 1, 'background failures must return nonzero to the invoking terminal');
  assert.match(failed.stderr, /启动失败/);
  assert.match(failed.stderr, /projects\.json/);
  assert(!/is ready|Listening at/.test(failed.stdout));
  assert.equal(fs.readFileSync(path.join(oldData, 'projects.json'), 'utf8'), original);
  assert.equal(fs.existsSync(path.join(oldData, 'product-data.json')), false);
  const log = fs.readFileSync(path.join(oldData, 'launcher.log'), 'utf8');
  assert.match(log, /startup failed/);
  assert(!/Listening at/.test(log), 'never advertise a listener before initialization succeeds');
  console.log('launcher readiness PASS: unrelated cwd, abandoned records, HTTP readiness, stop, terminal failure, legacy preservation');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  if (serverPid && endpoint.readEndpoint(data)?.pid === serverPid) {
    try { process.kill(serverPid); } catch {}
  }
});
