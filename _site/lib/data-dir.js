const fs = require('fs');
const path = require('path');
const os = require('os');

let resolved = null;
function resolveDataDirPath(options = {}) {
  const configured = options.dataDir === undefined ? process.env.KB_DATA_DIR : options.dataDir;
  return path.resolve(configured || path.join(options.homeDir || os.homedir(), '.project-knowledge-v5'));
}
function ensureDataDir(dataDir = resolveDataDirPath()) { fs.mkdirSync(dataDir, { recursive: true }); return path.resolve(dataDir); }
function getDataDir() { if (!resolved) resolved = resolveDataDirPath(); return resolved; }
function _resetCache() { resolved = null; }
module.exports = { resolveDataDirPath, ensureDataDir, getDataDir, _resetCache };
