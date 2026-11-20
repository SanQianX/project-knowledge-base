'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { parse } = require('jsonc-parser');

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readObject(file) {
  let contents;
  try { contents = fs.readFileSync(file, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  const errors = [];
  const value = parse(contents.replace(/^\uFEFF/, ''), errors, { allowTrailingComma: true });
  if (errors.length || !isObject(value)) {
    throw Object.assign(new Error('Invalid Claude Code settings or plugin inventory.'), { code: 'CLAUDE_CONFIG_INVALID' });
  }
  return value;
}

function workspaceKey(directory) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) return null;
  const key = path.resolve(directory);
  return process.platform === 'win32' ? key.toLowerCase() : key;
}

function readClaudePluginStatus({ configDir, settingsFile, pluginId, cwd }) {
  const index = readObject(path.join(configDir, 'plugins', 'installed_plugins.json'));
  const records = index?.plugins?.[pluginId] ?? [];
  if ((index && (!isObject(index.plugins) || ![undefined, 1, 2].includes(index.version)))
      || !Array.isArray(records) || records.some(record => !isObject(record)
        || typeof record.version !== 'string' || !workspaceKey(record.installPath)
        || (record.scope && !['user', 'project', 'local'].includes(record.scope)))) {
    throw Object.assign(new Error('Unrecognized Claude Code plugin inventory.'), { code: 'CLAUDE_PLUGIN_INDEX_UNSUPPORTED' });
  }

  const workspace = workspaceKey(cwd);
  const applicable = records.filter(record => !record.scope || record.scope === 'user'
    || (workspace && workspace === workspaceKey(record.projectPath)));
  const record = applicable.find(row => row.scope === 'local')
    || applicable.find(row => row.scope === 'project') || applicable[0];
  const files = [settingsFile];
  if (workspace) files.push(path.join(cwd, '.claude', 'settings.json'), path.join(cwd, '.claude', 'settings.local.json'));
  let enabled = true;
  let hooksDisabled = false;
  for (const file of files) {
    const settings = readObject(file);
    const pluginEnabled = settings?.enabledPlugins?.[pluginId];
    if (typeof pluginEnabled === 'boolean') enabled = pluginEnabled;
    if (typeof settings?.disableAllHooks === 'boolean') hooksDisabled = settings.disableAllHooks;
  }
  return { plugin: record ? { ...record, enabled } : null, hooksDisabled };
}

module.exports = { readClaudePluginStatus };
