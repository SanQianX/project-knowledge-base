'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { StartupIntegrationRepair } = require('../lib/startup-integration-repair');
const { markIntent } = require('../lib/integration-intent');
const { isProcessAlive } = require('../lib/runtime-endpoint');
const workerFile = path.join(__dirname, 'fixtures/startup-repair-worker.cjs');
async function main() {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-startup-repair-empty-'));
  markIntent(empty, 'codex', 'disconnected');
  const idle = new StartupIntegrationRepair({ dataDir: empty, workerFile: 'does-not-exist' });
  assert.deepEqual(await idle.runOnce(), {}); assert.equal(idle.child, null); await idle.close();
  for (const mode of ['normal', 'manual', 'crash', 'hang']) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-startup-repair-'));
    markIntent(dataDir, 'claude', 'connected'); markIntent(dataDir, 'codex', 'connected');
    markIntent(dataDir, 'zcode', 'disconnected');
    const logs = [];
    const repair = new StartupIntegrationRepair({ dataDir, managerOptions: { homeDir: mode }, workerFile,
      timeoutMs: mode === 'hang' ? 150 : 3000, logger: { warn: (...args) => logs.push(args) } });
    try {
      const result = repair.runOnce();
      assert.equal(repair.runOnce(), result, 'one startup event must not spawn duplicate repair jobs');
      if (mode === 'manual') repair.markSucceeded(['claude']);
      const status = await result;
      assert.equal(status.zcode, undefined, 'disconnected clients must not acquire repair state');
      if (mode === 'normal') {
        assert.equal(status.claude.state, 'failed'); assert.equal(status.codex.state, 'repaired');
        repair.markSucceeded(['claude']); assert.equal(repair.status().claude.state, 'repaired');
      } else if (mode === 'manual') {
        assert.equal(status.claude, undefined, 'late startup failure must not overwrite a manual install');
        assert.equal(status.codex.state, 'repaired');
      } else {
        assert.equal(status.claude.state, 'failed'); assert.equal(status.codex.state, 'failed');
        assert.equal(logs.length, 1, 'worker failure must be reported without automatic retries');
      }
    } finally { await repair.close(); }
    assert.equal(isProcessAlive(repair.child.pid), false, 'owned worker must be reaped on close');
  }
  console.log('Startup repair worker PASS: intent isolation, one attempt, manual success precedence, timeout, crash and owned cleanup');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
