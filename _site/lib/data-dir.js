const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { LEGACY_ASSETS, assetPath } = require('./legacy-data-manifest');
const { isEmptyJson } = require('./data-state-classifier');

let _resolved = null;

function resolveDataDirPath(options = {}) {
  const fromEnv = options.dataDir === undefined ? process.env.KB_DATA_DIR : options.dataDir;
  const homeDir = options.homeDir || os.homedir();
  return path.resolve(fromEnv || path.join(homeDir, '.project-knowledge'));
}
function ensureDataDir(dataDir = resolveDataDirPath()) { fs.mkdirSync(dataDir, { recursive: true }); return path.resolve(dataDir); }
function getDataDir() { if (!_resolved) _resolved = resolveDataDirPath(); return _resolved; }
function _resetCache() { _resolved = null; }
function fileDigest(filePath) { return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex'); }
function directoryDigest(root) {
  const hash = crypto.createHash('sha256');
  const walk = current => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const filePath = path.join(current, entry.name);
      const relative = path.relative(root, filePath).replace(/\\/g, '/');
      hash.update(`${entry.isDirectory() ? 'd' : 'f'}:${relative}\0`);
      if (entry.isDirectory()) walk(filePath); else if (entry.isFile()) hash.update(fs.readFileSync(filePath));
    }
  };
  walk(root); return hash.digest('hex');
}
function isEmptyAsset(filePath, asset) {
  if (!fs.existsSync(filePath)) return true;
  if (asset.kind === 'dir') return fs.readdirSync(filePath).length === 0;
  if (fs.statSync(filePath).size === 0) return true;
  if (!filePath.endsWith('.json')) return false;
  try { const raw = fs.readFileSync(filePath, 'utf8'); return isEmptyJson(JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw)); } catch { return false; }
}
function assetsEqual(source, target, asset) { return asset.kind === 'dir' ? directoryDigest(source) === directoryDigest(target) : fileDigest(source) === fileDigest(target); }
function copyDir(source, target) {
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name); const to = path.join(target, entry.name);
    if (entry.isDirectory()) copyDir(from, to); else if (entry.isFile()) fs.copyFileSync(from, to);
  }
}

function migrateFromLegacy({ legacyRoot, logger } = {}) {
  if (process.env.KB_SKIP_MIGRATION === '1') return { ok: true, migrated: false, reason: 'skipped via KB_SKIP_MIGRATION=1' };
  if (!legacyRoot || !fs.existsSync(legacyRoot)) return { ok: true, migrated: false, reason: legacyRoot ? 'legacy root does not exist' : 'no legacy root provided' };
  const dataDir = getDataDir();
  if (path.resolve(legacyRoot) === dataDir) return { ok: true, migrated: false, reason: 'legacy root equals data dir' };
  // Packaged application roots may include empty scaffolding such as
  // `projects/`. It is not user data and must never conflict with populated
  // runtime data during startup relocation.
  const sources = LEGACY_ASSETS.filter(asset => {
    const source = assetPath(legacyRoot, asset);
    return fs.existsSync(source) && !isEmptyAsset(source, asset);
  });
  if (!sources.length) return { ok: true, migrated: false, reason: 'no legacy assets found' };
  const conflicts = [];
  for (const asset of sources) {
    const source = assetPath(legacyRoot, asset); const target = assetPath(dataDir, asset, 'target');
    if (fs.existsSync(target) && !isEmptyAsset(target, asset) && !assetsEqual(source, target, asset)) conflicts.push(asset.target);
  }
  if (conflicts.length) return { ok: false, migrated: false, requiresManualRecovery: true, reason: 'legacy-data-conflict', conflicts, source: legacyRoot, target: dataDir };
  ensureDataDir(dataDir);
  const result = { ok: true, migrated: false, files: 0, dirs: 0, source: legacyRoot, target: dataDir };
  try {
    for (const asset of sources) {
      const source = assetPath(legacyRoot, asset); const target = assetPath(dataDir, asset, 'target');
      if (fs.existsSync(target) && assetsEqual(source, target, asset)) continue;
      if (asset.kind === 'dir') { if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true }); copyDir(source, target); result.dirs++; }
      else { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(source, target); result.files++; }
    }
    result.migrated = result.files > 0 || result.dirs > 0;
    if (result.migrated && logger) logger(`migrated runtime data to ${dataDir} (${result.files} files, ${result.dirs} dirs from ${legacyRoot})`);
    return result;
  } catch (error) { return { ...result, ok: false, error: `failed to relocate legacy runtime data: ${error.message}` }; }
}

module.exports = { resolveDataDirPath, ensureDataDir, getDataDir, migrateFromLegacy, LEGACY_ASSETS, _resetCache };
