const fs = require('fs');
const path = require('path');

const STORAGE_DIRECTORY = '.project-knowledge';

function configuredLayout(rootPath) {
  const root = path.resolve(rootPath);
  const storageRoot = path.join(root, STORAGE_DIRECTORY);
  return {
    kind: 'configured',
    rootPath: root,
    storageRoot,
    dbPath: path.join(storageRoot, 'knowledge.lancedb'),
    databaseMaintenancePath: path.join(storageRoot, 'knowledge.lancedb.maintenance.json'),
    maintenanceStatePath: path.join(storageRoot, 'knowledge-maintenance.json'),
    backupRoot: path.join(storageRoot, '_backup', 'knowledge-db'),
  };
}

function legacyLayout(dataDir) {
  const root = path.resolve(dataDir);
  return {
    kind: 'legacy-data-dir',
    rootPath: root,
    storageRoot: root,
    dbPath: path.join(root, 'knowledge.lancedb'),
    databaseMaintenancePath: path.join(root, 'knowledge.lancedb.maintenance.json'),
    maintenanceStatePath: path.join(root, 'knowledge-maintenance.json'),
    backupRoot: path.join(root, '_backup', 'knowledge-db'),
  };
}

function samePath(left, right) {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}

function layoutItems(layout) {
  return [
    ['database', layout.dbPath, 'knowledge.lancedb'],
    ['database-maintenance', layout.databaseMaintenancePath, 'knowledge.lancedb.maintenance.json'],
    ['maintenance-state', layout.maintenanceStatePath, 'knowledge-maintenance.json'],
    ['backups', layout.backupRoot, path.join('_backup', 'knowledge-db')],
  ];
}

function manifest(target) {
  const result = { files: 0, bytes: 0 };
  if (!fs.existsSync(target)) return result;
  const walk = current => {
    const stat = fs.statSync(current);
    if (stat.isFile()) {
      result.files += 1;
      result.bytes += stat.size;
      return;
    }
    if (!stat.isDirectory()) throw new Error(`unsupported storage item: ${current}`);
    for (const entry of fs.readdirSync(current)) walk(path.join(current, entry));
  };
  walk(target);
  return result;
}

function copyItem(source, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const stat = fs.statSync(source);
  if (stat.isDirectory()) fs.cpSync(source, destination, { recursive: true, errorOnExist: true, force: false });
  else if (stat.isFile()) fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
  else throw new Error(`unsupported storage item: ${source}`);
}

function removeIfEmpty(target) {
  try {
    if (fs.existsSync(target) && fs.statSync(target).isDirectory() && fs.readdirSync(target).length === 0) fs.rmdirSync(target);
  } catch {}
}

function rebaseMaintenanceState(source, destination) {
  if (!fs.existsSync(destination.maintenanceStatePath)) return { updated: false };
  let state;
  try { state = JSON.parse(fs.readFileSync(destination.maintenanceStatePath, 'utf8')); }
  catch { return { updated: false, reason: 'maintenance state is not valid JSON' }; }
  if (!state?.lastBackupPath) return { updated: false };
  const relative = path.relative(path.resolve(source.backupRoot), path.resolve(state.lastBackupPath));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return { updated: false };
  state.lastBackupPath = path.join(destination.backupRoot, relative);
  const temp = `${destination.maintenanceStatePath}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  fs.renameSync(temp, destination.maintenanceStatePath);
  return { updated: true, lastBackupPath: state.lastBackupPath };
}

function relocateLayout(source, destination) {
  if (samePath(source.dbPath, destination.dbPath)) {
    return { ok: true, moved: false, reason: 'database path unchanged', source, destination };
  }
  const present = layoutItems(source).filter(([, sourcePath]) => fs.existsSync(sourcePath));
  if (!present.length) {
    return { ok: true, moved: false, reason: 'source storage is empty', source, destination };
  }
  const conflicts = layoutItems(destination).filter(([, targetPath]) => fs.existsSync(targetPath));
  if (conflicts.length) {
    throw new Error(`target knowledge storage already contains data: ${conflicts.map(([name]) => name).join(', ')}`);
  }

  fs.mkdirSync(destination.rootPath, { recursive: true });
  if (fs.existsSync(destination.storageRoot)) {
    if (!fs.statSync(destination.storageRoot).isDirectory() || fs.readdirSync(destination.storageRoot).length) {
      throw new Error(`target knowledge storage directory is not empty: ${destination.storageRoot}`);
    }
    fs.rmdirSync(destination.storageRoot);
  }
  const stage = `${destination.storageRoot}.relocating-${process.pid}-${Date.now()}`;
  const renamed = [];
  const copied = [];
  let finalized = false;
  try {
    for (const [name, sourcePath, relativeTarget] of present) {
      const stagedPath = path.join(stage, relativeTarget);
      fs.mkdirSync(path.dirname(stagedPath), { recursive: true });
      try {
        fs.renameSync(sourcePath, stagedPath);
        renamed.push({ name, sourcePath, stagedPath });
      } catch (error) {
        if (error.code !== 'EXDEV') throw error;
        copyItem(sourcePath, stagedPath);
        copied.push({ name, sourcePath, stagedPath });
      }
      const before = manifest(sourcePath);
      const after = manifest(stagedPath);
      // A same-volume rename removes the source. In that case the staged
      // manifest itself is the verified source manifest.
      if (renamed.some(item => item.stagedPath === stagedPath)) continue;
      if (before.files !== after.files || before.bytes !== after.bytes) {
        throw new Error(`knowledge storage copy verification failed for ${name}`);
      }
    }
    fs.renameSync(stage, destination.storageRoot);
    finalized = true;
    const cleanupErrors = [];
    for (const item of copied) {
      try { fs.rmSync(item.sourcePath, { recursive: true, force: true }); }
      catch (error) { cleanupErrors.push(`${item.name}: ${error.message}`); }
    }
    removeIfEmpty(path.dirname(source.backupRoot));
    if (source.kind !== 'legacy-data-dir') removeIfEmpty(source.storageRoot);
    return {
      ok: true,
      moved: true,
      source,
      destination,
      files: manifest(destination.storageRoot).files,
      bytes: manifest(destination.storageRoot).bytes,
      cleanupErrors,
    };
  } catch (error) {
    if (!finalized) {
      for (const item of renamed.reverse()) {
        try {
          if (fs.existsSync(item.stagedPath) && !fs.existsSync(item.sourcePath)) {
            fs.mkdirSync(path.dirname(item.sourcePath), { recursive: true });
            fs.renameSync(item.stagedPath, item.sourcePath);
          }
        } catch {}
      }
      try { fs.rmSync(stage, { recursive: true, force: true }); } catch {}
    }
    throw error;
  }
}

function resolveActiveLayout(configRoot, dataDir) {
  const desired = configuredLayout(configRoot);
  const legacy = legacyLayout(dataDir);
  if (fs.existsSync(desired.dbPath)) return desired;
  if (fs.existsSync(legacy.dbPath)) return legacy;
  return desired;
}

function publicStorageInfo(layout, configuredRoot) {
  const desired = configuredLayout(configuredRoot);
  return {
    rootPath: desired.rootPath,
    storagePath: desired.storageRoot,
    databasePath: layout.dbPath,
    followsConfiguredRoot: samePath(layout.dbPath, desired.dbPath),
    legacyLocation: layout.kind === 'legacy-data-dir',
  };
}

module.exports = {
  STORAGE_DIRECTORY,
  configuredLayout,
  legacyLayout,
  relocateLayout,
  rebaseMaintenanceState,
  resolveActiveLayout,
  publicStorageInfo,
  manifest,
  samePath,
};
