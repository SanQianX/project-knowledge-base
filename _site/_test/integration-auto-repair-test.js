'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { markIntent } = require('../lib/integration-intent');
const { IntegrationAutoRepair } = require('../lib/integration-auto-repair');

const tmpDataDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kb-auto-repair-'));

const makeManager = ({ statusClients, onInstall }) => {
  const calls = { statusAll: 0, installAll: [] };
  return {
    calls,
    async statusAll() {
      calls.statusAll += 1;
      return { clients: statusClients.map(client => ({ ...client, developmentCapture: { ...client.developmentCapture } })) };
    },
    async installAll(options) {
      calls.installAll.push(options);
      return onInstall(options);
    },
  };
};

(async () => {
  // D + E: runOnce repairs exactly the connected-and-not-installed clients, once.
  {
    const dir = tmpDataDir();
    markIntent(dir, 'claude', 'connected');
    markIntent(dir, 'codex', 'disconnected');
    markIntent(dir, 'zcode', 'connected');
    const manager = makeManager({
      statusClients: [
        { client: 'claude', developmentCapture: { installed: false } },
        { client: 'codex', developmentCapture: { installed: false } },
        { client: 'zcode', developmentCapture: { installed: true } },
      ],
      onInstall: async options => ({ clients: [{ client: options.clients[0], developmentCapture: { ok: true } }] }),
    });
    const repair = new IntegrationAutoRepair({ dataDir: dir, createManager: () => manager });
    await repair.runOnce();
    assert.equal(manager.calls.installAll.length, 1, 'disconnected and already-installed clients are never repaired');
    assert.deepEqual(manager.calls.installAll[0], { clients: ['claude'] });
    const repaired = repair.status().claude;
    assert.equal(repaired.state, 'repaired');
    assert.equal(repaired.error, null);
    assert.ok(!Number.isNaN(Date.parse(repaired.at)), 'at must be an ISO timestamp');
    await repair.runOnce();
    assert.equal(manager.calls.statusAll, 2, 'second run rescans status');
    assert.equal(manager.calls.installAll.length, 1, 'a second runOnce must not repair the same client again');
  }
  // F + G: failures are recorded without interrupting others; retry repairs.
  {
    const dir = tmpDataDir();
    for (const client of ['claude', 'codex', 'zcode']) markIntent(dir, client, 'connected');
    let claudeBroken = true;
    const manager = makeManager({
      statusClients: [
        { client: 'claude', developmentCapture: { installed: false } },
        { client: 'codex', developmentCapture: { installed: false } },
        { client: 'zcode', developmentCapture: { installed: false } },
      ],
      onInstall: async options => {
        const client = options.clients[0];
        if (client === 'claude' && claudeBroken) throw new Error('boom');
        if (client === 'zcode') return { clients: [{ client, developmentCapture: { ok: false, detail: 'hook conflict' } }] };
        return { clients: [{ client, developmentCapture: { ok: true } }] };
      },
    });
    const repair = new IntegrationAutoRepair({ dataDir: dir, createManager: () => manager });
    await repair.runOnce();
    assert.equal(manager.calls.installAll.length, 3, 'every connected-and-not-installed client gets one attempt');
    const status = repair.status();
    assert.equal(status.claude.state, 'failed');
    assert.ok(status.claude.error, 'a thrown installAll records the error message');
    assert.equal(status.codex.state, 'repaired', 'a failing client does not interrupt the others');
    assert.equal(status.zcode.state, 'failed');
    assert.ok(status.zcode.error, 'ok=false records a detail as the error');
    claudeBroken = false;
    const retried = await repair.retry('claude');
    assert.equal(retried.state, 'repaired');
    assert.equal(retried.error, null);
    assert.equal(manager.calls.installAll.length, 4, 'retry ignores the attempted set');
    assert.deepEqual(manager.calls.installAll[3], { clients: ['claude'] });
    assert.equal(repair.status().claude.state, 'repaired', 'a successful retry overwrites the failure');
    const snapshot = repair.status();
    snapshot.claude = { state: 'tampered' };
    assert.equal(repair.status().claude.state, 'repaired', 'status() returns a copy');
  }
  {
    const dir = tmpDataDir();
    markIntent(dir, 'codex', 'disconnected');
    const manager = makeManager({ statusClients: [], onInstall: () => { throw new Error('must not repair'); } });
    const repair = new IntegrationAutoRepair({ dataDir: dir, createManager: () => manager });
    await repair.runOnce();
    assert.equal(manager.calls.statusAll, 0, 'disconnected clients must not run native startup probes');
    markIntent(dir, 'codex', 'connected');
    manager.statusAll = async options => {
      assert.deepEqual(options.clients, ['codex']);
      return { clients: [{ client: 'codex', developmentCapture: { state: 'check-failed' } }] };
    };
    await repair.runOnce();
    assert.equal(manager.calls.installAll.length, 0, 'an unknown status must not be treated as an absent integration');
    manager.statusAll = async () => {
      markIntent(dir, 'codex', 'disconnected');
      return { clients: [{ client: 'codex', developmentCapture: { installed: false } }] };
    };
    await repair.runOnce();
    assert.equal(manager.calls.installAll.length, 0, 'a user disconnect during status scanning must cancel the repair');
  }
  console.log('integration auto repair test PASS');
})().catch(error => { console.error(error); process.exitCode = 1; });
