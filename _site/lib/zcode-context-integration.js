'use strict';
const fs = require('node:fs');
const path = require('node:path');
const AtomicFile = require('./atomic-file');

function configuration(file) {
  if (!fs.existsSync(file)) return {};
  let value; try { value = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new Error('ZCode 配置不是有效 JSON，未覆盖原文件。'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('ZCode 配置必须是 JSON 对象，未覆盖原文件。');
  return value;
}
const scriptFor = root => path.join(root, 'plugins/project-knowledge/scripts/context-hook.cjs');
const normalize = file => { const value = path.resolve(file).replace(/\\/g, '/'); return process.platform === 'win32' ? value.toLowerCase() : value; };
function owned(hook, root) {
  return hook?.type === 'process' && hook.command === 'node' && Array.isArray(hook.args) && hook.args.length === 3 && typeof hook.args[0] === 'string' && normalize(hook.args[0]) === normalize(scriptFor(root)) && hook.args[1] === '--client' && hook.args[2] === 'zcode';
}
function status({ configFile, rootDir }) {
  const config = configuration(configFile);
  const installed = (config.hooks?.events?.UserPromptSubmit || []).some(g => Array.isArray(g?.hooks) && g.hooks.some(h => owned(h, rootDir))) && fs.existsSync(scriptFor(rootDir));
  const disabled = config.hooks?.enabled === false;
  return { state: disabled ? 'disabled' : installed && config.hooks?.enabled === true ? 'installed' : 'not-installed', supported: true, installed: installed && !disabled && config.hooks?.enabled === true, detail: disabled ? 'ZCode 配置 Hook 已被用户禁用，未擅自启用。' : installed ? '原生 UserPromptSubmit 只读上下文入口已配置；MCP 插件状态不作已安装承诺。' : '开发前知识读取尚未接入；与会话采集独立。' };
}
function install({ configFile, rootDir, dryRun }) {
  const config = configuration(configFile);
  if (config.hooks?.enabled === false) throw new Error('ZCode Hook 已被用户禁用，请在客户端明确启用后重试；未覆盖配置。');
  if (!fs.existsSync(scriptFor(rootDir))) throw new Error('缺少已安装的知识读取脚本。');
  if (!dryRun) {
    if (config.hooks && (typeof config.hooks !== 'object' || Array.isArray(config.hooks))) throw new Error('ZCode Hook 配置格式无效，未覆盖。');
    config.hooks ||= {}; config.hooks.events ||= {};
    if (typeof config.hooks.events !== 'object' || Array.isArray(config.hooks.events)) throw new Error('ZCode Hook 事件配置格式无效，未覆盖。');
    const groups = config.hooks.events.UserPromptSubmit || [];
    if (!Array.isArray(groups)) throw new Error('ZCode UserPromptSubmit 配置格式无效，未覆盖。');
    const hook = { type: 'process', command: 'node', args: [scriptFor(rootDir), '--client', 'zcode'], timeoutMs: 12000 };
    let found = false;
    for (const group of groups) if (Array.isArray(group?.hooks)) group.hooks = group.hooks.map(h => { if (!owned(h, rootDir)) return h; found = true; return hook; });
    if (!found) groups.push({ hooks: [hook] });
    config.hooks.events.UserPromptSubmit = groups; config.hooks.enabled = true;
    AtomicFile.writeJsonAtomic(configFile, config);
  }
  return { state: dryRun ? 'planned' : 'installed', supported: true, installed: !dryRun, detail: 'ZCode 原生前置读取已配置，保留原模型、第三方 Hook 与采集入口；请重新打开会话。' };
}
function uninstall({ configFile, rootDir, dryRun }) {
  const config = configuration(configFile), groups = config.hooks?.events?.UserPromptSubmit;
  if (!dryRun && Array.isArray(groups)) {
    const kept = groups.map(group => { if (!Array.isArray(group?.hooks)) return group; const hooks = group.hooks.filter(h => !owned(h, rootDir)); return hooks.length ? { ...group, hooks } : null; }).filter(Boolean);
    if (kept.length) config.hooks.events.UserPromptSubmit = kept; else delete config.hooks.events.UserPromptSubmit;
    AtomicFile.writeJsonAtomic(configFile, config);
  }
  return { state: dryRun ? 'planned' : 'removed', supported: true, installed: false, detail: '已移除知识上下文入口，采集、模型和第三方设置保留。' };
}
module.exports = { install, status, uninstall };
