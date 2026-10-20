'use strict';
const path = require('node:path');
const { fork, spawn } = require('node:child_process');
const { readIntent } = require('./integration-intent');

// Native client commands can block for minutes. Keep the whole startup
// status/repair operation outside the HTTP and launcher readiness process.
class StartupIntegrationRepair {
  constructor({ dataDir, managerOptions = {}, logger, workerFile, timeoutMs = 120000 } = {}) {
    this.dataDir = dataDir; this.managerOptions = managerOptions; this.logger = logger;
    this.workerFile = workerFile || path.join(__dirname, 'integration-repair-worker.js');
    this.timeoutMs = timeoutMs; this.results = {}; this.manualSuccess = new Set();
    this.closed = false; this.promise = null; this.child = null;
  }
  status() { return { ...this.results }; }
  markSucceeded(clients) {
    for (const client of clients || []) {
      this.manualSuccess.add(client);
      if (this.results[client]?.state === 'failed') this.results[client] = { state: 'repaired', at: new Date().toISOString(), error: null };
    }
  }
  runOnce() {
    if (this.promise) return this.promise;
    const clients = Object.entries(readIntent(this.dataDir)?.clients || {}).filter(([, state]) => state === 'connected').map(([client]) => client);
    if (this.closed || !clients.length) return Promise.resolve(this.status());
    this.promise = new Promise(resolve => {
      const child = fork(this.workerFile, [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true, detached: process.platform !== 'win32' });
      this.child = child;
      let settled = false;
      const finish = (results, code) => {
        if (settled) return; settled = true; clearTimeout(timer);
        if (!this.closed) {
          for (const [client, result] of Object.entries(results || {})) {
            if (clients.includes(client) && !this.manualSuccess.has(client)) this.results[client] = result;
          }
          if (code) {
            for (const client of clients) if (!this.manualSuccess.has(client)) this.results[client] = { state: 'failed', at: new Date().toISOString(), error: '启动接入检查未完成，请在 Agent 接入中重试。' };
            Promise.resolve(this.logger?.warn?.('integrations.auto_repair_skipped', '启动接入检查未完成，主界面继续可用。', { context: { code, clients } })).catch(() => {});
          }
        }
        resolve(this.status());
      };
      const timer = setTimeout(() => { void this.terminate().catch(() => {}); finish(null, 'INTEGRATION_REPAIR_TIMEOUT'); }, this.timeoutMs);
      child.on('message', message => {
        if (message?.kind === 'log') {
          if (['info', 'warn', 'error'].includes(message.level) && Array.isArray(message.args) && /^integrations?\./.test(message.args[0] || '')) {
            Promise.resolve(this.logger?.[message.level]?.(...message.args)).catch(() => {});
          }
          return;
        }
        finish(message?.results, message?.ok ? null : 'INTEGRATION_REPAIR_FAILED');
      });
      child.once('error', () => finish(null, 'INTEGRATION_REPAIR_SPAWN_FAILED'));
      child.once('exit', () => finish(null, this.closed ? null : 'INTEGRATION_REPAIR_EXITED'));
      const allowed = ['rootDir', 'homeDir', 'version', 'packageSpec', 'marketplaceSource', 'codexMarketplaceSource', 'bridgeHomeDir', 'bridgeConsumerName', 'claudeSettingsFile', 'codexConfigFile', 'zcodeConfigFile', 'openCodePluginsDir', 'env'];
      child.send({ dataDir: this.dataDir, managerOptions: Object.fromEntries(allowed.filter(key => this.managerOptions[key] !== undefined).map(key => [key, this.managerOptions[key]])) }, error => { if (error) finish(null, 'INTEGRATION_REPAIR_SEND_FAILED'); });
    });
    return this.promise;
  }
  terminate() {
    const child = this.child;
    if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('启动接入检查进程尚未停止。')), 5000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      if (process.platform === 'win32') {
        // Only this live worker and its native probe children are owned here.
        const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        killer.once('error', () => child.kill());
      } else {
        try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
      }
    });
  }
  async close() { this.closed = true; await this.terminate(); }
}
module.exports = { StartupIntegrationRepair };
