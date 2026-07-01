// _site/lib/data-dir.js
//
// Resolves a stable, version-independent data directory for project-knowledge
// runtime state. Runtime data lives OUTSIDE the npm install directory so that
// `npm install -g project-knowledge` upgrades do not destroy user config
// (project registry, AI profiles with API keys, generated knowledge bases,
// logs, AI workspaces).
//
// Resolution order (highest priority first):
//   1. KB_DATA_DIR env var — used by tests and power users who want a custom
//      location. Set to "." to use the current working directory.
//   2. <os.homedir()>/.project-knowledge — the default user-specific location.
//
// On first run after upgrade from a 1.x install, the legacy runtime files
// (which lived inside the npm package directory) are silently migrated into
// the new data dir. After that, all updates keep the data dir untouched and
// data survives every future `npm install -g project-knowledge`.

const fs = require('fs');
const path = require('path');
const os = require('os');

let _resolved = null;

function getDataDir() {
  if (_resolved) return _resolved;
  const fromEnv = process.env.KB_DATA_DIR;
  const dataDir = fromEnv
    ? path.resolve(fromEnv)
    : path.join(os.homedir(), '.project-knowledge');
  try {
    fs.mkdirSync(dataDir, { recursive: true });
  } catch (err) {
    // Best-effort. Callers will surface a write error when they actually
    // try to write inside the dir; we don't want to crash here just because
    // the user's homedir is read-only or the path is bogus.
  }
  _resolved = dataDir;
  return dataDir;
}

// Reset the cached resolution. Tests use this to switch KB_DATA_DIR between
// cases without re-requiring the module.
function _resetCache() {
  _resolved = null;
}

function hasMigrated() {
  return fs.existsSync(path.join(getDataDir(), 'projects.json'));
}

// Legacy 1.x locations — these lived inside the npm package root. The
// package root for an installed package is the directory that contains
// _site/server.js, _site/lib/, package.json, etc.
const LEGACY_FILE_PATHS = [
  'projects.json',
  'ai-profiles.json',
  'knowledge-store.json',
  'logging.json',
  '.jobs-log.json',
  'claude-prompts.json',
  '.hook-trigger-errors.log',
];

const LEGACY_DIR_PATHS = [
  'projects',  // generated KB trees
  'logs',      // structured logs
];

const LEGACY_AI_DIR = path.join('_site', '_ai');  // per-project AI workspaces lived under _site/_ai/

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(from, to);
    else if (entry.isFile()) fs.copyFileSync(from, to);
  }
}

function migrateFromLegacy({ legacyRoot, logger } = {}) {
  // Test escape hatch. Set KB_SKIP_MIGRATION=1 to run against a clean data
  // dir without pulling the user's real registry in from the package root.
  if (process.env.KB_SKIP_MIGRATION === '1') {
    return { ok: true, migrated: false, reason: 'skipped via KB_SKIP_MIGRATION=1' };
  }
  if (!legacyRoot) {
    return { ok: true, migrated: false, reason: 'no legacy root provided' };
  }
  if (!fs.existsSync(legacyRoot)) {
    return { ok: true, migrated: false, reason: 'legacy root does not exist' };
  }
  const dataDir = getDataDir();
  // Safety check: if the legacy root equals the data dir, there's nothing
  // to migrate (we'd be copying onto ourselves).
  if (path.resolve(legacyRoot) === path.resolve(dataDir)) {
    return { ok: true, migrated: false, reason: 'legacy root equals data dir' };
  }
  if (hasMigrated()) {
    return { ok: true, migrated: false, reason: 'already migrated' };
  }

  const result = {
    ok: true,
    migrated: false,
    files: 0,
    dirs: 0,
    source: legacyRoot,
    target: dataDir,
  };

  for (const rel of LEGACY_FILE_PATHS) {
    const from = path.join(legacyRoot, rel);
    const to = path.join(dataDir, rel);
    if (fs.existsSync(from) && !fs.existsSync(to)) {
      try {
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.copyFileSync(from, to);
        result.files++;
      } catch (err) {
        result.ok = false;
        result.error = `failed to migrate ${rel}: ${err.message}`;
        return result;
      }
    }
  }
  for (const rel of LEGACY_DIR_PATHS) {
    const from = path.join(legacyRoot, rel);
    const to = path.join(dataDir, rel);
    if (fs.existsSync(from) && !fs.existsSync(to)) {
      try {
        copyDir(from, to);
        result.dirs++;
      } catch (err) {
        result.ok = false;
        result.error = `failed to migrate ${rel}/: ${err.message}`;
        return result;
      }
    }
  }
  const aiFrom = path.join(legacyRoot, LEGACY_AI_DIR);
  const aiTo = path.join(dataDir, '_ai');
  if (fs.existsSync(aiFrom) && !fs.existsSync(aiTo)) {
    try {
      copyDir(aiFrom, aiTo);
      result.dirs++;
    } catch (err) {
      result.ok = false;
      result.error = `failed to migrate _site/_ai/: ${err.message}`;
      return result;
    }
  }

  if (result.files > 0 || result.dirs > 0) {
    result.migrated = true;
    if (logger) {
      logger(`migrated runtime data to ${dataDir} (${result.files} files, ${result.dirs} dirs from ${legacyRoot})`);
    }
  }
  return result;
}

module.exports = {
  getDataDir,
  hasMigrated,
  migrateFromLegacy,
  LEGACY_FILE_PATHS,
  LEGACY_DIR_PATHS,
  LEGACY_AI_DIR,
  _resetCache,
};
