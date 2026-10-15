'use strict';
// Startup-event integration repair. No timers, no polling: the same failure
// cause will not heal inside one run, so a failed repair is surfaced once and
// never retried automatically. The next backend start is a new event and gets
// one fresh attempt; the only in-run retry is the explicit user action.

const { readIntent } = require('./integration-intent');

class IntegrationAutoRepair {
  constructor({ dataDir, createManager, logger } = {}) {
    if (typeof createManager !== 'function') throw new Error('IntegrationAutoRepair requires a createManager function.');
    this.dataDir = dataDir;
    this.createManager = createManager;
    this.logger = logger || { info: () => {}, warn: () => {}, error: () => {} };
    this.attempted = new Set();
  }

  async _repairOne(client, manager) {
    const summary = await manager.installAll({ clients: [client] });
    const capture = summary?.clients?.find(entry => entry.client === client)?.developmentCapture;
    return { state: capture?.ok === true ? 'repaired' : 'failed', at: new Date().toISOString(), error: capture?.ok === true ? null : (capture?.detail || 'installAll did not report success.') };
  }

  async _attempt(client, options = {}) {
    const force = options.force === true;
    if (!force && this.attempted.has(client)) return null;
    if (!force) this.attempted.add(client);
    let result;
    try {
      result = await this._repairOne(client, this.createManager());
    } catch (error) {
      result = { state: 'failed', at: new Date().toISOString(), error: error.message };
    }
    this.results ||= {};
    this.results[client] = result;
    this.logger[result.state === 'repaired' ? 'info' : 'warn'](
      `integrations.auto_repair_${result.state === 'repaired' ? 'succeeded' : 'failed'}`,
      result.state === 'repaired' ? '启动时自动修复了 Agent 接入。' : '启动自动修复失败，已停止本周期自动重试。',
      { context: { client, error: result.error } },
    );
    return result;
  }

  async runOnce() {
    const intent = readIntent(this.dataDir);
    if (!intent) return this.status();
    const status = await this.createManager().statusAll({});
    for (const entry of status?.clients || []) {
      if (intent.clients[entry.client] !== 'connected') continue;
      if (entry.developmentCapture?.installed === true) continue;
      if (this.attempted.has(entry.client)) continue;
      await this._attempt(entry.client);
    }
    return this.status();
  }

  async retry(client) {
    return this._attempt(client, { force: true });
  }

  // A later successful manual install (switch on / retry repair) clears the
  // startup failure so the badge stops reporting a stale error.
  markSucceeded(clients) {
    this.results ||= {};
    for (const client of clients || []) {
      if (this.results[client]?.state === 'failed') this.results[client] = { state: 'repaired', at: new Date().toISOString(), error: null };
    }
  }

  status() {
    return { ...(this.results || {}) };
  }
}

module.exports = { IntegrationAutoRepair };
