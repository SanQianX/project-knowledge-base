const { SCHEMAS, DomainError, validateProjectId } = require('./contracts');
const AtomicFile = require('./atomic-file');
const { StorageLayout } = require('./storage-layout');

function emptyRegistry() {
  return {
    schema: SCHEMAS.projectRegistry,
    schemaVersion: 2,
    projectOrder: [],
    projects: {},
    revision: 0,
    updatedAt: '',
  };
}

function validateRegistry(registry) {
  if (!registry || typeof registry !== 'object' || Array.isArray(registry)) {
    throw new DomainError('DATA_CORRUPT', 'Project registry must be an object.', { status: 500 });
  }
  if (registry.schema !== SCHEMAS.projectRegistry || registry.schemaVersion !== 2) {
    throw new DomainError('SCHEMA_UNSUPPORTED', 'Unsupported project registry schema.', { status: 409 });
  }
  if (!Array.isArray(registry.projectOrder) || !registry.projects || typeof registry.projects !== 'object') {
    throw new DomainError('DATA_CORRUPT', 'Project registry index is invalid.', { status: 500 });
  }
  const ordered = new Set();
  for (const projectId of registry.projectOrder) {
    validateProjectId(projectId);
    if (ordered.has(projectId) || !registry.projects[projectId]) {
      throw new DomainError('DATA_CORRUPT', 'Project registry order is inconsistent.', { status: 500 });
    }
    ordered.add(projectId);
  }
  for (const projectId of Object.keys(registry.projects)) {
    validateProjectId(projectId);
    if (!ordered.has(projectId)) throw new DomainError('DATA_CORRUPT', 'Project registry contains an unordered project.', { status: 500 });
  }
  return registry;
}

class ProjectRegistryStore {
  constructor(options = {}) {
    this.layout = options.layout || new StorageLayout(options);
    this.atomic = options.atomic || AtomicFile;
    this.filePath = options.filePath || this.layout.getProjectRegistryPath();
    this.lockPath = options.lockPath || this.layout.getRegistryLockPath();
  }

  read(options = {}) {
    return this.atomic.readJsonStrict(this.filePath, {
      allowMissing: options.allowMissing === true,
      defaultValue: emptyRegistry(),
      category: 'project-registry',
      validate: validateRegistry,
    });
  }

  async initialize() {
    return this.atomic.withFileLock(this.lockPath, async () => {
      let existing;
      try { existing = this.read(); } catch (error) { if (!error || error.code !== 'ENOENT') throw error; }
      if (existing) return existing;
      const registry = emptyRegistry();
      registry.updatedAt = new Date().toISOString();
      this.atomic.writeJsonAtomic(this.filePath, registry);
      return registry;
    });
  }

  listIds() { return [...this.read({ allowMissing: true }).projectOrder]; }

  readDisplaySnapshot(projectId) {
    validateProjectId(projectId);
    const registry = this.read({ allowMissing: true });
    return registry.projects[projectId] || null;
  }

  async add(projectId, snapshot = {}) {
    validateProjectId(projectId);
    return this.atomic.withFileLock(this.lockPath, async () => {
      const registry = this.read({ allowMissing: true });
      if (registry.projects[projectId]) {
        throw new DomainError('INVALID_ARGUMENT', 'Project is already registered.', { status: 409 });
      }
      registry.projects[projectId] = {
        createdAt: String(snapshot.createdAt || new Date().toISOString()),
        displayNameSnapshot: String(snapshot.displayNameSnapshot || snapshot.displayName || projectId),
      };
      registry.projectOrder.push(projectId);
      registry.revision = Number(registry.revision || 0) + 1;
      registry.updatedAt = new Date().toISOString();
      validateRegistry(registry);
      this.atomic.writeJsonAtomic(this.filePath, registry);
      return registry.projects[projectId];
    });
  }

  async remove(projectId) {
    validateProjectId(projectId);
    return this.atomic.withFileLock(this.lockPath, async () => {
      const registry = this.read({ allowMissing: true });
      if (!registry.projects[projectId]) return false;
      delete registry.projects[projectId];
      registry.projectOrder = registry.projectOrder.filter(id => id !== projectId);
      registry.revision = Number(registry.revision || 0) + 1;
      registry.updatedAt = new Date().toISOString();
      validateRegistry(registry);
      this.atomic.writeJsonAtomic(this.filePath, registry);
      return true;
    });
  }

  async reorder(projectIds) {
    return this.atomic.withFileLock(this.lockPath, async () => {
      const registry = this.read({ allowMissing: true });
      const next = Array.isArray(projectIds) ? projectIds.map(validateProjectId) : [];
      if (next.length !== registry.projectOrder.length || new Set(next).size !== next.length || next.some(id => !registry.projects[id])) {
        throw new DomainError('INVALID_ARGUMENT', 'Reorder must contain every registered project exactly once.');
      }
      registry.projectOrder = next;
      registry.revision = Number(registry.revision || 0) + 1;
      registry.updatedAt = new Date().toISOString();
      this.atomic.writeJsonAtomic(this.filePath, registry);
      return [...next];
    });
  }
}

module.exports = { ProjectRegistryStore, emptyRegistry, validateRegistry };
