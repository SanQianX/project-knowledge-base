const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const dataDirModule = require('./data-dir');
const { DomainError, validateProjectId } = require('./contracts');

function stripTrailingSeparators(value) {
  const parsed = path.parse(value);
  let result = value;
  while (result.length > parsed.root.length && /[\\/]$/.test(result)) result = result.slice(0, -1);
  return result;
}

class StorageLayout {
  constructor(options = {}) {
    this.dataDir = path.resolve(options.dataDir || dataDirModule.getDataDir());
    this.platform = options.platform || process.platform;
  }

  getDataDir() { return this.dataDir; }
  getSettingsPath() { return path.join(this.dataDir, 'settings.json'); }
  getProjectRegistryPath() { return path.join(this.dataDir, 'projects.json'); }
  getMigrationStatePath() { return path.join(this.dataDir, 'runtime', 'migration-state.json'); }
  getMigrationCompletionPath() { return path.join(this.dataDir, 'runtime', 'layout-v2.completed.json'); }

  getProjectMetadataDir(projectId) {
    return path.join(this.dataDir, 'projects', validateProjectId(projectId));
  }

  getProjectConfigPath(projectId) { return path.join(this.getProjectMetadataDir(projectId), 'config.json'); }
  getProjectStatePath(projectId) { return path.join(this.getProjectMetadataDir(projectId), 'state.json'); }
  getProjectRequirementsPath(projectId) { return path.join(this.getProjectMetadataDir(projectId), 'requirements.jsonl'); }
  getProjectLockPath(projectId) { return path.join(this.getProjectMetadataDir(projectId), '.project.lock'); }
  getRegistryLockPath() { return path.join(this.dataDir, 'runtime', 'locks', 'projects.lock'); }

  getIndexPath() { return path.join(this.dataDir, 'index', 'knowledge.lancedb'); }
  getCachePath(...segments) { return path.join(this.dataDir, 'cache', ...segments); }
  getRuntimePath(...segments) { return path.join(this.dataDir, 'runtime', ...segments); }
  getRecoveryPath(...segments) { return path.join(this.dataDir, 'recovery', ...segments); }

  getLogPath(scope = 'app', projectId = '') {
    if (scope === 'app') return path.join(this.dataDir, 'logs', 'app');
    if (scope === 'hooks') return path.join(this.dataDir, 'logs', 'hooks');
    if (scope === 'project' || scope === 'projects') {
      return path.join(this.dataDir, 'logs', 'projects', validateProjectId(projectId));
    }
    throw new DomainError('INVALID_ARGUMENT', `Unknown log scope: ${scope}.`);
  }

  getKnowledgeRootPath(settings) {
    const root = settings && settings.knowledge && settings.knowledge.rootPath;
    if (!root || typeof root !== 'string') {
      throw new DomainError('INVALID_ARGUMENT', 'Knowledge root is not configured.', { status: 409 });
    }
    return path.resolve(root);
  }

  resolveNewProjectKnowledgePath(storageName, settings) {
    const safe = String(storageName || '').trim();
    if (!safe || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(safe)) {
      throw new DomainError('INVALID_ARGUMENT', 'Invalid storageName.');
    }
    return path.join(this.getKnowledgeRootPath(settings), safe);
  }

  getProjectKnowledgePath(config) {
    if (!config || typeof config.knowledgePath !== 'string' || !config.knowledgePath.trim()) {
      throw new DomainError('DATA_CORRUPT', 'Project knowledgePath is missing.', { status: 500 });
    }
    return path.resolve(config.knowledgePath);
  }

  normalizeForComparison(value) {
    if (!value || typeof value !== 'string') return '';
    const normalized = stripTrailingSeparators(path.resolve(value));
    return this.platform === 'win32' ? normalized.toLowerCase() : normalized;
  }

  pathsEqual(left, right) {
    const a = this.normalizeForComparison(left);
    const b = this.normalizeForComparison(right);
    return Boolean(a && b && a === b);
  }

  isPathInside(root, target, options = {}) {
    if (!root || !target) return false;
    const resolve = options.realpath === false ? path.resolve : value => this.realpathWithMissingLeaf(value);
    let rootPath;
    let targetPath;
    try {
      rootPath = resolve(root);
      targetPath = resolve(target);
    } catch {
      return false;
    }
    const rel = path.relative(rootPath, targetPath);
    if (rel === '') return options.allowRoot !== false;
    return !rel.startsWith('..') && !path.isAbsolute(rel);
  }

  realpathWithMissingLeaf(value) {
    let current = path.resolve(value);
    const suffix = [];
    while (!fs.existsSync(current)) {
      const parent = path.dirname(current);
      if (parent === current) break;
      suffix.unshift(path.basename(current));
      current = parent;
    }
    const real = fs.realpathSync.native ? fs.realpathSync.native(current) : fs.realpathSync(current);
    return path.join(real, ...suffix);
  }

  validateKnowledgeRoot(rootPath) {
    const absolute = path.resolve(String(rootPath || '').trim());
    if (!rootPath) throw new DomainError('INVALID_ARGUMENT', 'Knowledge root is required.');
    let created = false;
    if (!fs.existsSync(absolute)) {
      fs.mkdirSync(absolute, { recursive: true });
      created = true;
    }
    if (!fs.statSync(absolute).isDirectory()) {
      throw new DomainError('INVALID_ARGUMENT', 'Knowledge root must be a directory.');
    }
    const probe = path.join(absolute, `.project-knowledge-write-probe-${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
    try {
      const fd = fs.openSync(probe, 'wx', 0o600);
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fs.unlinkSync(probe);
    } catch (error) {
      try { if (fs.existsSync(probe)) fs.unlinkSync(probe); } catch {
        // Preserve the writability error; a uniquely named failed probe is never runtime data.
      }
      throw new DomainError('INVALID_ARGUMENT', 'Knowledge root is not writable.', { status: 400, cause: error });
    }
    return { ok: true, rootPath: absolute, created };
  }
}

function createStorageLayout(options) {
  return new StorageLayout(options);
}

module.exports = { StorageLayout, createStorageLayout };
