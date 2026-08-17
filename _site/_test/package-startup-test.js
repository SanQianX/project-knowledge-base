const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const BIN = path.join(ROOT, 'bin', 'project-knowledge.js');
const PORT = 7825;
const BASE = `http://127.0.0.1:${PORT}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkb-package-v2-'));

async function waitForServer() {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('packaged CLI server did not start');
}

(async () => {
  const child = spawn(process.execPath, [BIN, '--fg', '--port', String(PORT), '--host', '127.0.0.1', '--no-open'], {
    cwd: ROOT,
    env: { ...process.env, KB_DATA_DIR: dataDir, KB_SKIP_MIGRATION: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  try {
    await waitForServer();
    const stateResponse = await fetch(`${BASE}/api/state`);
    const state = await stateResponse.json();
    assert.strictEqual(state.schema, 'server-state/v2');
    assert.deepStrictEqual(state.projects, []);

    const registry = JSON.parse(fs.readFileSync(path.join(dataDir, 'projects.json'), 'utf8'));
    assert.strictEqual(registry.schema, 'project-registry/v2');
    assert.deepStrictEqual(registry.projectOrder, []);
    const endpoint = JSON.parse(fs.readFileSync(path.join(dataDir, 'runtime-endpoint.json'), 'utf8'));
    assert.strictEqual(endpoint.schema, 'project-knowledge/runtime-endpoint/v1');
    assert.strictEqual(endpoint.port, PORT);

    const removed = await fetch(`${BASE}/api/projects/example/hook-install`, { method: 'POST' });
    assert.strictEqual(removed.status, 404);
    console.log('package-startup-test PASS');
  } catch (error) {
    console.error(output);
    throw error;
  } finally {
    child.kill('SIGTERM');
    await new Promise(resolve => child.once('exit', resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
