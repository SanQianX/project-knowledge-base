'use strict';
const path = require('node:path');
const { fork, spawn } = require('node:child_process');
const { IntegrationManager, SUPPORTED_CLIENTS, CLIENT_LABELS } = require('./integration-installer');

class IntegrationStatusScan {
  constructor({ workerFile, timeoutMs = 20000 } = {}) {
    this.workerFile = workerFile || path.join(__dirname, 'integration-status-worker.js');
    this.timeoutMs = timeoutMs; this.entries = new Map(); this.children = new Set(); this.generation = 0;
    this.queue = []; this.running = 0; this.closed = false;
  }
  async read(managerOptions, statusOptions = {}, { force = false, waitMs = 500 } = {}) {
    if (managerOptions.runner || managerOptions.commandResolver || managerOptions.bridgeModule || managerOptions.codexHookProbe) return new IntegrationManager(managerOptions).statusAll(statusOptions);
    const key = JSON.stringify([managerOptions.rootDir, managerOptions.homeDir, managerOptions.bridgeHomeDir, statusOptions.cwd, statusOptions.captureOnly, statusOptions.clients]);
    let entry = this.entries.get(key);
    if (!entry || !entry.promise && (force || Date.now() - entry.at > 30000)) {
      entry = { at: Date.now(), generation: ++this.generation, summary: entry?.summary || null, promise: null };
      entry.promise = this.run(managerOptions, statusOptions).then(summary => { entry.summary = summary; entry.at = Date.now(); return summary; }, error => {
        if (entry.summary) {
          entry.summary = { ...entry.summary, stale: true, error: { code: error.code || 'INTEGRATION_STATUS_FAILED' } };
          return entry.summary;
        }
        entry.summary = { bridge: { ok: false, state: 'check-failed', detail: '接入状态检查失败或超时，未将其判为未安装。' },
          clients: (statusOptions.clients || SUPPORTED_CLIENTS).map(client => ({ client, label: CLIENT_LABELS[client],
            knowledgeIntegration: { ok: false, state: 'check-failed', detail: '检查未完成，请重试。' }, automaticContext: { supported: client !== 'opencode', configured: false, state: 'check-failed', detail: '检查未完成，不代表客户端未接入。' },
            developmentCapture: { ok: false, state: 'check-failed', detail: '采集状态尚未核实。' } })), error: { code: error.code || 'INTEGRATION_STATUS_FAILED' } };
        return entry.summary;
      }).finally(() => { entry.promise = null; });
      this.entries.set(key, entry);
      if (this.entries.size > 100) for (const [oldKey, old] of this.entries) { if (!old.promise && oldKey !== key) { this.entries.delete(oldKey); break; } }
    }
    if (entry.promise && waitMs > 0) {
      let timer;
      await Promise.race([entry.promise, new Promise(resolve => { timer = setTimeout(resolve, waitMs); })]); clearTimeout(timer);
    }
    const pending = entry.promise !== null;
    if (entry.summary) return { ...entry.summary, scan: { state: pending ? 'refreshing' : 'ready', generation: entry.generation, updatedAt: entry.at } };
    return { bridge: { ok: true, state: 'checking' }, clients: (statusOptions.clients || SUPPORTED_CLIENTS).map(client => ({ client, label: CLIENT_LABELS[client],
      configFound: new IntegrationManager(managerOptions).captureConfigFound(client),
      knowledgeIntegration: { ok: true, state: 'checking', detail: '正在检查接入状态…' },
      automaticContext: { supported: client !== 'opencode', configured: false, state: 'checking', detail: '正在检查开发前知识读取…' },
      developmentCapture: { ok: true, state: 'checking', detail: '正在检查采集…' } })), scan: { state: 'checking', generation: entry.generation } };
  }
  run(managerOptions, statusOptions) {
    return new Promise((resolve, reject) => {
      if (this.closed || this.queue.length >= 64) { reject(Object.assign(new Error('状态检查暂不可用。'), { code: this.closed ? 'INTEGRATION_STATUS_CLOSED' : 'INTEGRATION_STATUS_BUSY' })); return; }
      this.queue.push({ managerOptions, statusOptions, resolve, reject }); this.drain();
    });
  }
  drain() {
    while (!this.closed && this.running < 2 && this.queue.length) {
      const next = this.queue.shift(); this.running++;
      this.probe(next.managerOptions, next.statusOptions).then(next.resolve, next.reject).finally(() => { this.running--; this.drain(); });
    }
  }
  probe(managerOptions, statusOptions) {
    return new Promise((resolve, reject) => {
      const child = fork(this.workerFile, [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true, env: { ...process.env, KB_INTEGRATION_STATUS_WORKER: '1' } });
      this.children.add(child);
      let settled = false;
      const finish = (error, summary) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(summary); };
      const timer = setTimeout(() => {
        Promise.resolve(managerOptions.logger?.warn?.('integration.status.timeout', '客户端接入状态检查超时；未将其判为未安装。', {
          operationId: managerOptions.operationId, component: 'integration', phase: 'status',
          context: { clients: statusOptions.clients || SUPPORTED_CLIENTS, timeoutMs: this.timeoutMs },
        })).catch(() => {});
        this.terminate(child); finish(Object.assign(new Error('状态检查超时。'), { code: 'INTEGRATION_STATUS_TIMEOUT' }));
      }, this.timeoutMs);
      child.on('message', message => {
        if (message?.kind === 'log') {
          if (['info', 'warn', 'error'].includes(message.level) && Array.isArray(message.args) && /^integration\./.test(message.args[0] || '')) Promise.resolve(managerOptions.logger?.[message.level]?.(...message.args)).catch(() => {});
          return;
        }
        finish(message?.ok ? null : Object.assign(new Error('状态检查失败。'), { code: message?.code }), message?.summary);
      });
      child.once('error', error => finish(error));
      child.once('exit', () => { this.children.delete(child); if (!settled) finish(Object.assign(new Error('状态检查进程提前退出。'), { code: 'INTEGRATION_STATUS_EXITED' })); });
      const allowed = ['rootDir', 'homeDir', 'version', 'packageSpec', 'operationId', 'bridgeHomeDir', 'bridgeConsumerName', 'claudeSettingsFile', 'codexConfigFile', 'zcodeConfigFile', 'openCodePluginsDir'];
      child.send({ managerOptions: Object.fromEntries(allowed.filter(k => managerOptions[k] !== undefined).map(k => [k, managerOptions[k]])), statusOptions });
    });
  }
  terminate(child) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    if (process.platform === 'win32') {
      // Only the live worker we created, including its probe children. Never
      // terminate by executable name or scan unrelated Node processes.
      const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.on('error', () => child.kill());
    } else child.kill('SIGTERM');
  }
  invalidate() { for (const entry of this.entries.values()) entry.at = 0; }
  close() {
    this.closed = true;
    for (const child of this.children) this.terminate(child);
    for (const item of this.queue) item.reject(Object.assign(new Error('扫描已关闭。'), { code: 'INTEGRATION_STATUS_CLOSED' }));
    this.queue = []; this.entries.clear();
  }
}
module.exports = { IntegrationStatusScan };
