const fs = require('fs');
const path = require('path');

const SCHEMA = 'project-knowledge/embedding-config/v1';
const DEFAULT_REMOTE_HOST = 'https://huggingface.co/';

function normalizeConfig(input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const remoteHost = String(source.remoteHost || DEFAULT_REMOTE_HOST).trim();
  return {
    schema: SCHEMA,
    remoteHost: `${remoteHost.replace(/\/+$/, '')}/`,
    localModelPath: String(source.localModelPath || '').trim(),
    localFilesOnly: source.localFilesOnly === true,
  };
}

function readConfig(filePath) {
  try { return normalizeConfig(JSON.parse(fs.readFileSync(filePath, 'utf8'))); }
  catch { return normalizeConfig(); }
}

function writeConfig(filePath, input) {
  const config = normalizeConfig(input);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  fs.renameSync(temp, filePath);
  return config;
}

function readState(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch { return { status: 'idle', error: null, startedAt: null, endedAt: null }; }
}

function writeState(filePath, patch = {}) {
  const state = { ...readState(filePath), ...patch };
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  fs.renameSync(temp, filePath);
  return state;
}

module.exports = {
  SCHEMA,
  DEFAULT_REMOTE_HOST,
  normalizeConfig,
  readConfig,
  writeConfig,
  readState,
  writeState,
};
