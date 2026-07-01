const fs = require('fs');
const path = require('path');

const SCHEMA = 'knowledge-store/v1';

function defaultConfig(appRoot) {
  return {
    schema: SCHEMA,
    rootPath: path.join(appRoot, 'projects'),
    git: {
      enabled: false,
      remoteUrl: '',
      branch: 'main',
      autoCommit: false,
      autoPush: false,
    },
    configured: false,
  };
}

function normalizeConfig(input, appRoot) {
  const base = defaultConfig(appRoot);
  const source = input && typeof input === 'object' ? input : {};
  const git = source.git && typeof source.git === 'object' ? source.git : {};
  return {
    schema: SCHEMA,
    rootPath: path.resolve(source.rootPath || base.rootPath),
    git: {
      enabled: git.enabled === true,
      remoteUrl: typeof git.remoteUrl === 'string' ? git.remoteUrl : '',
      branch: typeof git.branch === 'string' && git.branch.trim() ? git.branch.trim() : 'main',
      autoCommit: git.autoCommit === true,
      autoPush: git.autoPush === true,
    },
    configured: source.configured === true,
  };
}

function readConfig(configPath, appRoot) {
  if (!fs.existsSync(configPath)) return defaultConfig(appRoot);
  try {
    return normalizeConfig(JSON.parse(fs.readFileSync(configPath, 'utf-8')), appRoot);
  } catch {
    return defaultConfig(appRoot);
  }
}

function writeConfig(configPath, appRoot, config) {
  const normalized = normalizeConfig({ ...config, configured: true }, appRoot);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(normalized, null, 2) + '\n', 'utf-8');
  return normalized;
}

function validateRoot(rootPath) {
  if (!rootPath || typeof rootPath !== 'string') {
    return { ok: false, error: 'rootPath is required' };
  }
  const resolved = path.resolve(rootPath);
  try {
    fs.mkdirSync(resolved, { recursive: true });
    const stat = fs.statSync(resolved);
    if (!stat.isDirectory()) return { ok: false, rootPath: resolved, error: 'rootPath is not a directory' };
    return { ok: true, rootPath: resolved };
  } catch (e) {
    return { ok: false, rootPath: resolved, error: e.message };
  }
}

function defaultProjectKbPath(slug, configPath, appRoot) {
  const cfg = readConfig(configPath, appRoot);
  return path.join(cfg.rootPath, slug);
}

function isInside(child, parent) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(from, to);
    else if (entry.isFile()) fs.copyFileSync(from, to);
  }
}

function buildMigrationPlan({ projects, appRoot, storeConfig }) {
  const legacyRoot = path.join(appRoot, 'projects');
  const items = [];
  for (const [slug, cfg] of Object.entries(projects || {})) {
    const current = path.resolve(cfg.kbPath || path.join(legacyRoot, slug));
    if (!isInside(current, legacyRoot)) continue;
    const target = path.join(storeConfig.rootPath, slug);
    if (path.resolve(current) === path.resolve(target)) continue;
    items.push({
      slug,
      from: current,
      to: target,
      exists: fs.existsSync(current),
      targetExists: fs.existsSync(target),
    });
  }
  return items;
}

function migrateProjects({ projects, appRoot, storeConfig, overwrite = false, move = false }) {
  const plan = buildMigrationPlan({ projects, appRoot, storeConfig });
  const migrated = [];
  for (const item of plan) {
    if (!item.exists) {
      projects[item.slug].kbPath = item.to;
      migrated.push({ ...item, copied: false, reason: 'source missing; path updated only' });
      continue;
    }
    if (item.targetExists && !overwrite) {
      migrated.push({ ...item, copied: false, skipped: true, reason: 'target exists' });
      continue;
    }
    if (item.targetExists && overwrite) fs.rmSync(item.to, { recursive: true, force: true });
    copyDir(item.from, item.to);
    if (move) fs.rmSync(item.from, { recursive: true, force: true });
    projects[item.slug].kbPath = item.to;
    migrated.push({ ...item, copied: true, moved: !!move });
  }
  return { plan, migrated };
}

module.exports = {
  SCHEMA,
  defaultConfig,
  readConfig,
  writeConfig,
  validateRoot,
  defaultProjectKbPath,
  buildMigrationPlan,
  migrateProjects,
  isInside,
};
