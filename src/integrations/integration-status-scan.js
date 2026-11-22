'use strict';
const path = require('node:path');
const { fork, spawn } = require('node:child_process');
const { IntegrationManager, SUPPORTED_CLIENTS, CLIENT_LABELS, normalizeClient } = require('./integration-installer');

function clientSnapshot(entry, captureOnly) {
  const { client, snapshot, promise, error, stale, checkedAt } = entry;
  const state = error ? 'check-failed' : promise ? (snapshot ? 'refreshing' : 'checking') : 'ready';
  const pending = { state: error ? 'check-failed' : 'checking', ok: !error };
  return {
    client,
    label: CLIENT_LABELS[client],
    developmentCapture: { ...pending, detail: error ? '采集状态尚未核实。' : '正在检查采集配置…' },
    ...(!captureOnly ? {
      knowledgeIntegration: { ...pending, detail: error ? '知识插件状态尚未核实。' : '正在检查知识插件…' },
      automaticContext: { supported: client !== 'opencode', configured: false, state: pending.state, detail: error ? '开发前知识读取尚未核实。' : '正在检查开发前知识读取…' },
    } : {}),
    ...snapshot,
    scan: { state, checkedAt, ...(stale ? { stale } : {}), ...(error ? { error } : {}) },
  };
}

class IntegrationStatusScan {
  constructor({ workerFile, timeoutMs = 30_000 } = {}) {
    this.workerFile = workerFile || path.join(__dirname, 'integration-status-worker.js');
    this.timeoutMs = timeoutMs; this.entries = new Map(); this.children = new Set(); this.generation = 0;
    this.queue = []; this.running = 0; this.closed = false;
  }
  async read(managerOptions, statusOptions = {}, { force = false, waitMs = 500 } = {}) {
    if (managerOptions.runner || managerOptions.commandResolver || managerOptions.bridgeModule || managerOptions.codexHookProbe) return new IntegrationManager(managerOptions).statusAll(statusOptions);
    const captureOnly = statusOptions.captureOnly === true;
    const clients = statusOptions.clients?.length ? [...new Set(statusOptions.clients.map(normalizeClient))] : SUPPORTED_CLIENTS;
    const owner = [managerOptions.rootDir, managerOptions.homeDir, managerOptions.bridgeHomeDir, captureOnly];
    const entries = clients.map(client => this.schedule(
      [...owner, client, ['claude', 'codex'].includes(client) ? statusOptions.cwd : null],
      managerOptions, { ...statusOptions, clients: [client], includeShared: false }, client, force,
    ));
    const shared = this.schedule([...owner, 'shared'], managerOptions, { captureOnly, sharedOnly: true }, null, force && !statusOptions.clients?.length);
    const jobs = [...entries, shared];
    const pending = jobs.map(entry => entry.promise).filter(Boolean);
    if (pending.length && waitMs > 0) {
      let timer;
      await Promise.race([Promise.all(pending), new Promise(resolve => { timer = setTimeout(resolve, waitMs); })]);
      clearTimeout(timer);
    }
    const error = jobs.find(entry => entry.error)?.error;
    const active = jobs.some(entry => entry.promise);
    const hasResults = entries.some(entry => entry.snapshot);
    return {
      ...shared.snapshot,
      bridge: shared.snapshot?.bridge || { ok: !shared.error, state: shared.error ? 'check-failed' : 'checking' },
      clients: entries.map(entry => clientSnapshot(entry, captureOnly)),
      ...(error ? { error } : {}),
      scan: {
        state: active ? (hasResults ? 'refreshing' : 'checking') : 'ready',
        generation: Math.max(...jobs.map(entry => entry.generation)),
        updatedAt: Math.max(...jobs.map(entry => entry.at)),
      },
    };
  }

  schedule(parts, managerOptions, statusOptions, client, force) {
    const key = JSON.stringify(parts);
    const previous = this.entries.get(key);
    if (previous && (previous.promise || !force && Date.now() - previous.at <= 30_000)) return previous;
    const entry = { client, generation: ++this.generation, at: Date.now(),
      snapshot: previous?.snapshot, checkedAt: previous?.checkedAt, stale: Boolean(previous?.snapshot) };
    const publish = snapshot => {
      entry.snapshot = snapshot;
      entry.checkedAt = new Date().toISOString();
      entry.stale = false;
    };
    entry.promise = this.run(managerOptions, statusOptions, partial => {
      if (client === partial?.client) publish(partial);
    }).then(summary => {
      const snapshot = client ? summary?.clients?.find(row => row.client === client) : summary;
      if (snapshot) publish(snapshot);
      else entry.error = { code: 'INTEGRATION_STATUS_INCOMPLETE' };
    }, error => {
      entry.error = { code: error.code || 'INTEGRATION_STATUS_FAILED' };
    }).finally(() => { entry.promise = null; entry.at = Date.now(); });
    this.entries.set(key, entry);
    if (this.entries.size > 100) for (const [oldKey, old] of this.entries) {
      if (!old.promise && oldKey !== key) { this.entries.delete(oldKey); break; }
    }
    return entry;
  }

  run(managerOptions, statusOptions, onPartial) {
    return new Promise((resolve, reject) => {
      if (this.closed || this.queue.length >= 64) { reject(Object.assign(new Error('状态检查暂不可用。'), { code: this.closed ? 'INTEGRATION_STATUS_CLOSED' : 'INTEGRATION_STATUS_BUSY' })); return; }
      this.queue.push({ managerOptions, statusOptions, onPartial, resolve, reject }); this.drain();
    });
  }
  drain() {
    while (!this.closed && this.running < SUPPORTED_CLIENTS.length && this.queue.length) {
      const next = this.queue.shift(); this.running++;
      this.probe(next.managerOptions, next.statusOptions, next.onPartial).then(next.resolve, next.reject).finally(() => { this.running--; this.drain(); });
    }
  }
  probe(managerOptions, statusOptions, onPartial) {
    return new Promise((resolve, reject) => {
      const child = fork(this.workerFile, [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true, detached: process.platform !== 'win32', env: { ...process.env, KB_INTEGRATION_STATUS_WORKER: '1' } });
      this.children.add(child);
      let settled = false;
      const finish = (error, summary) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(summary); };
      let phase = statusOptions.sharedOnly ? 'shared' : 'capture';
      const timer = setTimeout(() => {
        Promise.resolve(managerOptions.logger?.warn?.('integration.status.timeout', '客户端接入状态检查超时；未将其判为未安装。', {
          operationId: managerOptions.operationId, component: 'integration', phase: 'status',
          context: { clients: statusOptions.clients || [], step: phase, timeoutMs: this.timeoutMs },
        })).catch(() => {});
        this.terminate(child); finish(Object.assign(new Error('状态检查超时。'), { code: 'INTEGRATION_STATUS_TIMEOUT' }));
      }, this.timeoutMs);
      child.on('message', message => {
        if (message?.kind === 'log') {
          if (['info', 'warn', 'error'].includes(message.level) && Array.isArray(message.args) && /^integration\./.test(message.args[0] || '')) Promise.resolve(managerOptions.logger?.[message.level]?.(...message.args)).catch(() => {});
          return;
        }
        if (message?.kind === 'client-status') {
          if (!settled) {
            phase = message.entry?.knowledgeIntegration ? 'context-and-mcp' : 'knowledge-plugin';
            onPartial(message.entry);
          }
          return;
        }
        finish(message?.ok ? null : Object.assign(new Error('状态检查失败。'), { code: message?.code }), message?.summary);
      });
      child.once('error', error => finish(error));
      child.once('exit', () => { this.children.delete(child); if (!settled) finish(Object.assign(new Error('状态检查进程提前退出。'), { code: 'INTEGRATION_STATUS_EXITED' })); });
      const allowed = ['rootDir', 'homeDir', 'env', 'version', 'packageSpec', 'operationId', 'bridgeHomeDir', 'bridgeConsumerName', 'claudeSettingsFile', 'codexConfigFile', 'zcodeConfigFile', 'openCodePluginsDir'];
      child.send({ managerOptions: Object.fromEntries(allowed.filter(k => managerOptions[k] !== undefined).map(k => [k, managerOptions[k]])), statusOptions }, error => { if (error) finish(error); });
    });
  }
  terminate(child) {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
    if (process.platform === 'win32') {
      // Only the live worker we created, including its probe children. Never
      // terminate by executable name or scan unrelated Node processes.
      const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.on('error', () => child.kill());
    } else {
      try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
    }
  }
  invalidate(clients) {
    const selected = clients?.length ? new Set(clients.map(normalizeClient)) : null;
    for (const [key, entry] of this.entries) {
      if (!selected || !entry.client || selected.has(entry.client)) this.entries.delete(key);
    }
  }
  close() {
    this.closed = true;
    for (const child of this.children) this.terminate(child);
    for (const item of this.queue) item.reject(Object.assign(new Error('扫描已关闭。'), { code: 'INTEGRATION_STATUS_CLOSED' }));
    this.queue = []; this.entries.clear();
  }
}
module.exports = { IntegrationStatusScan };
