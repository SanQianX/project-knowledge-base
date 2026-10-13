'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { writeFileAtomic } = require('./atomic-file');

const EVENTS = ['UserPromptSubmit', 'Stop'];
function normalized(file) {
  const value = path.resolve(file).replace(/\\/g, '/');
  return process.platform === 'win32' ? value.toLowerCase() : value;
}
function nodeCommand(command) { return /(?:^|[\\/])node(?:\.exe)?$/i.test(command || ''); }

// Only exact, known Bridge invocations are ours. A shell wrapper, extra
// argument or a lookalike filename never authorizes removing a user hook.
function bridgeBinding(args, options) {
  if (!Array.isArray(args) || typeof args[0] !== 'string' || !nodeCommand(args[0]) || typeof args[1] !== 'string') return '';
  if (args.length !== 2 && !(args.length === 4 && args[2] === '--source' && ['claude-code', 'claude', 'zcode', 'codex', 'opencode'].includes(args[3]))) return '';
  const actual = normalized(args[1]);
  const current = normalized(path.join(options.bridgeHomeDir, 'bin', 'bridge-hook.cjs'));
  const legacy = normalized(path.join(options.homeDir || os.homedir(), '.ai-coding-event-bridge', 'bin', 'bridge-hook.cjs'));
  return actual === current ? 'current' : actual === legacy ? 'legacy' : '';
}

function hookArgs(hook) {
  if (!hook || typeof hook !== 'object') return null;
  if (hook.type === 'process' && Array.isArray(hook.args)) return [hook.command, ...hook.args];
  if (hook.type !== 'command' || typeof hook.command !== 'string') return null;
  const match = hook.command.trim().match(/^(?:"([^"]+)"|'([^']+)'|(\S+))\s+(?:"([^"]+)"|'([^']+)'|(\S+))(?:\s+--source\s+(claude-code|claude|zcode|codex|opencode))?$/);
  return match ? [match[1] || match[2] || match[3], match[4] || match[5] || match[6], ...(match[7] ? ['--source', match[7]] : [])] : null;
}

function configuration(file) {
  const source = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  let config;
  try { config = source ? JSON.parse(source) : {}; } catch { throw new Error('Agent 配置不是有效 JSON，未修改。'); }
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Agent 配置必须是 JSON 对象，未修改。');
  return { source, config };
}

function planCaptureHooks(file, client, options, removeCurrent = false) {
  if (!['claude', 'zcode'].includes(client)) throw new Error('不支持的采集配置类型。');
  const { source, config } = configuration(file);
  const hooks = config.hooks;
  if (hooks != null && (typeof hooks !== 'object' || Array.isArray(hooks))) throw new Error('Agent hooks 配置格式异常，未修改。');
  const events = client === 'zcode' ? hooks?.events : hooks;
  if (events != null && (typeof events !== 'object' || Array.isArray(events))) throw new Error('Agent 事件配置格式异常，未修改。');
  const removed = [], counts = {};
  for (const event of EVENTS) {
    const groups = events?.[event];
    if (groups == null) { counts[event] = { current: 0, legacy: 0 }; continue; }
    if (!Array.isArray(groups)) throw new Error('Agent 事件列表格式异常，未修改。');
    const count = { current: 0, legacy: 0 };
    for (const group of groups) {
      if (group?.hooks != null && !Array.isArray(group.hooks)) throw new Error('Agent Hook 列表格式异常，未修改。');
      for (const hook of group?.hooks || []) { const binding = bridgeBinding(hookArgs(hook), options); if (binding) count[binding]++; }
    }
    counts[event] = count;
    // Materialize the replacement first; never remove the only working old
    // capture when installing the new runtime has failed.
    if (!count.current) continue;
    let keptCurrent = false;
    const removedGroup = Symbol('empty-owned-group');
    events[event] = groups.map((group, groupIndex) => {
      if (!Array.isArray(group?.hooks)) return group;
      const kept = group.hooks.filter((hook, hookIndex) => {
        const binding = bridgeBinding(hookArgs(hook), options);
        if (!binding) return true;
        if (removeCurrent && binding === 'legacy') return true;
        if (!removeCurrent && binding === 'current' && !keptCurrent) { keptCurrent = true; return true; }
        // Back up only owned invocation fields, never unrelated config/env.
        const saved = Object.fromEntries(['type', 'command', 'args', 'timeout', 'timeoutMs'].filter(key => hook[key] !== undefined).map(key => [key, hook[key]]));
        removed.push({ event, groupIndex, hookIndex, hook: saved, binding });
        return false;
      });
      return kept.length === group.hooks.length ? group : kept.length ? { ...group, hooks: kept } : removedGroup;
    }).filter(group => group !== removedGroup);
  }
  return { source, config, counts, removed, repairNeeded: Object.values(counts).some(count => count.legacy > 0 || count.current > 1) };
}

function writePlan(file, client, plan) {
  if (!plan.removed.length) return { changed: false, removedLegacy: 0, removedDuplicates: 0 };
  const assertUnchanged = () => {
    if (fs.readFileSync(file, 'utf8') !== plan.source) throw Object.assign(new Error('Agent 配置已被其他程序修改，请重试接入。'), { code: 'CONFIG_CHANGED' });
  };
  assertUnchanged();
  const backupFile = `${file}.project-knowledge-capture-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.bak`;
  writeFileAtomic(backupFile, JSON.stringify({ schema: 'project-knowledge/capture-backup/v1', client, removed: plan.removed }, null, 2) + '\n');
  const eol = plan.source.includes('\r\n') ? '\r\n' : '\n';
  writeFileAtomic(file, (JSON.stringify(plan.config, null, 2) + '\n').replace(/\n/g, eol), { beforeRename: assertUnchanged });
  return { changed: true, backupFile, removedLegacy: plan.removed.filter(row => row.binding === 'legacy').length, removedDuplicates: plan.removed.filter(row => row.binding === 'current').length };
}

function repairCaptureHooks(file, client, options) {
  const plan = planCaptureHooks(file, client, options);
  if (EVENTS.some(event => !plan.counts[event].current)) throw new Error('当前 Bridge 入口未完整建立，保留旧采集接线。');
  if (!fs.existsSync(path.join(options.bridgeHomeDir, 'bin', 'bridge-hook.cjs'))) throw new Error('当前 Bridge 运行入口缺失，保留旧采集接线。');
  return writePlan(file, client, plan);
}

function removeCaptureHooks(file, client, options) {
  return writePlan(file, client, planCaptureHooks(file, client, options, true));
}

module.exports = { bridgeBinding, planCaptureHooks, repairCaptureHooks, removeCaptureHooks };
