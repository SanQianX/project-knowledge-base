const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  SCHEMAS,
  DomainError,
  assertMutableProjectPatch,
  validateProjectId,
} = require('./contracts');
const AtomicFile = require('./atomic-file');
const { StorageLayout } = require('./storage-layout');

const processQueues = new Map();

function defaultProjectConfig(projectId, input = {}) {
  validateProjectId(projectId);
  const createdAt = String(input.createdAt || new Date().toISOString());
  return {
    schema: SCHEMAS.projectConfig,
    schemaVersion: 2,
    projectId,
    displayName: String(input.displayName || projectId),
    storageName: String(input.storageName || projectId),
    repoPath: path.resolve(String(input.repoPath || '.')),
    knowledgePath: path.resolve(String(input.knowledgePath || '.')),
    enabled: input.enabled !== false,
    createdAt,
    teamBinding: input.teamBinding || null,
    aiProfileId: input.aiProfileId || null,
    knowledgeLanguage: input.knowledgeLanguage || 'zh-CN',
    relatedProjectIds: Array.isArray(input.relatedProjectIds) ? [...new Set(input.relatedProjectIds)] : [],
    repoIdentity: input.repoIdentity || null,
    legacyExtensions: input.legacyExtensions || {},
  };
}

function defaultProjectState(input = {}) {
  return {
    schema: SCHEMAS.projectState,
    schemaVersion: 2,
    revision: Number.isInteger(input.revision) ? input.revision : 0,
    trackingStartCommit: input.trackingStartCommit || null,
    lastAnalyzedCommit: input.lastAnalyzedCommit || null,
    trackingMode: input.trackingMode === 'empty-repo' ? 'empty-repo' : 'normal',
    analysis: {
      status: input.analysis && input.analysis.status || 'idle',
      activeClaim: input.analysis && input.analysis.activeClaim || null,
      lastError: input.analysis && input.analysis.lastError || null,
      rescanRequested: input.analysis && input.analysis.rescanRequested === true,
    },
    index: {
      dirty: input.index && input.index.dirty === true,
      generation: Number(input.index && input.index.generation || 0),
      sinceCommit: input.index && input.index.sinceCommit || null,
      lastError: input.index && input.index.lastError || null,
    },
    hook: {
      managedVersion: Number(input.hook && input.hook.managedVersion || 0),
      migrationVersion: Number(input.hook && input.hook.migrationVersion || 0),
      lastVerifiedAt: input.hook && input.hook.lastVerifiedAt || '',
    },
    updatedAt: input.updatedAt || new Date().toISOString(),
  };
}

function validateProjectConfig(config, expectedProjectId) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new DomainError('DATA_CORRUPT', 'Project config is invalid.', { status: 500 });
  if (config.schema !== SCHEMAS.projectConfig || config.schemaVersion !== 2) throw new DomainError('SCHEMA_UNSUPPORTED', 'Unsupported project config schema.', { status: 409 });
  validateProjectId(config.projectId);
  if (expectedProjectId && config.projectId !== expectedProjectId) throw new DomainError('DATA_CORRUPT', 'Project config identity mismatch.', { status: 500 });
  if (!config.storageName || !config.repoPath || !config.knowledgePath || !config.createdAt) throw new DomainError('DATA_CORRUPT', 'Project config is incomplete.', { status: 500 });
  return config;
}

function validateProjectState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw new DomainError('DATA_CORRUPT', 'Project state is invalid.', { status: 500 });
  if (state.schema !== SCHEMAS.projectState || state.schemaVersion !== 2) throw new DomainError('SCHEMA_UNSUPPORTED', 'Unsupported project state schema.', { status: 409 });
  if (!Number.isInteger(state.revision) || !state.analysis || !state.index || !state.hook) throw new DomainError('DATA_CORRUPT', 'Project state is incomplete.', { status: 500 });
  if (!['normal', 'empty-repo'].includes(state.trackingMode)) throw new DomainError('DATA_CORRUPT', 'Project tracking mode is invalid.', { status: 500 });
  return state;
}

class ProjectStore {
  constructor(options = {}) {
    this.layout = options.layout || new StorageLayout(options);
    this.atomic = options.atomic || AtomicFile;
  }

  async withProjectLock(projectId, fn, options = {}) {
    validateProjectId(projectId);
    const previous = processQueues.get(projectId) || Promise.resolve();
    let releaseQueue;
    const current = new Promise(resolve => { releaseQueue = resolve; });
    const queued = previous.then(() => current);
    processQueues.set(projectId, queued);
    await previous;
    try {
      return await this.atomic.withFileLock(this.layout.getProjectLockPath(projectId), fn, options);
    } finally {
      releaseQueue();
      if (processQueues.get(projectId) === queued) processQueues.delete(projectId);
    }
  }

  readConfig(projectId) {
    validateProjectId(projectId);
    return this.atomic.readJsonStrict(this.layout.getProjectConfigPath(projectId), {
      category: 'project-config',
      validate: config => validateProjectConfig(config, projectId),
    });
  }

  readState(projectId) {
    validateProjectId(projectId);
    return this.atomic.readJsonStrict(this.layout.getProjectStatePath(projectId), {
      category: 'project-state',
      validate: validateProjectState,
    });
  }

  async create(projectId, configInput, stateInput = {}) {
    validateProjectId(projectId);
    return this.withProjectLock(projectId, async () => {
      const dir = this.layout.getProjectMetadataDir(projectId);
      const configPath = this.layout.getProjectConfigPath(projectId);
      const statePath = this.layout.getProjectStatePath(projectId);
      if (fs.existsSync(configPath) || fs.existsSync(statePath)) throw new DomainError('INVALID_ARGUMENT', 'Project metadata already exists.', { status: 409 });
      fs.mkdirSync(dir, { recursive: true });
      const config = validateProjectConfig(defaultProjectConfig(projectId, configInput), projectId);
      const state = validateProjectState(defaultProjectState(stateInput));
      try {
        this.atomic.writeJsonAtomic(configPath, config);
        this.atomic.writeJsonAtomic(statePath, state);
      } catch (error) {
        try { if (fs.existsSync(configPath)) fs.unlinkSync(configPath); } catch {
          // Preserve the original create error; the lifecycle journal records rollback residue.
        }
        try { if (fs.existsSync(statePath)) fs.unlinkSync(statePath); } catch {
          // Preserve the original create error; the lifecycle journal records rollback residue.
        }
        throw error;
      }
      return { config, state };
    });
  }

  async updateConfig(projectId, patch, options = {}) {
    validateProjectId(projectId);
    assertMutableProjectPatch(patch, {
      allowKnowledgePath: options.allowKnowledgePath === true,
      allowRepoPath: options.allowRepoPath === true,
    });
    return this.withProjectLock(projectId, async () => {
      const current = this.readConfig(projectId);
      const next = { ...current, ...patch, projectId: current.projectId, storageName: current.storageName, createdAt: current.createdAt };
      validateProjectConfig(next, projectId);
      this.atomic.writeJsonAtomic(this.layout.getProjectConfigPath(projectId), next);
      return next;
    });
  }

  async updateState(projectId, updater, options = {}) {
    validateProjectId(projectId);
    if (typeof updater !== 'function') throw new DomainError('INVALID_ARGUMENT', 'State updater must be a function.');
    return this.withProjectLock(projectId, async () => {
      const current = this.readState(projectId);
      if (Number.isInteger(options.expectedRevision) && current.revision !== options.expectedRevision) {
        throw new DomainError('PROJECT_BUSY', 'Project state revision changed.', { status: 409, retryable: true });
      }
      const draft = JSON.parse(JSON.stringify(current));
      const updated = await updater(draft);
      const next = updated && typeof updated === 'object' ? updated : draft;
      next.schema = SCHEMAS.projectState;
      next.schemaVersion = 2;
      next.revision = current.revision + 1;
      next.updatedAt = new Date().toISOString();
      validateProjectState(next);
      this.atomic.writeJsonAtomic(this.layout.getProjectStatePath(projectId), next);
      return next;
    });
  }

  async appendRequirement(projectId, record) {
    validateProjectId(projectId);
    if (!record || typeof record !== 'object' || record.schema !== SCHEMAS.requirement || record.projectId !== projectId || !record.id) {
      throw new DomainError('INVALID_ARGUMENT', 'Requirement record is invalid.');
    }
    const filePath = this.layout.getProjectRequirementsPath(projectId);
    await this.atomic.appendJsonlLocked(filePath, record, { lockPath: `${filePath}.append.lock` });
    return record;
  }

  readRequirements(projectId) {
    validateProjectId(projectId);
    const filePath = this.layout.getProjectRequirementsPath(projectId);
    if (!fs.existsSync(filePath)) return [];
    const records = [];
    const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      if (!lines[index].trim()) continue;
      try {
        const record = JSON.parse(lines[index]);
        if (record.schema !== SCHEMAS.requirement || record.projectId !== projectId) throw new Error('schema or project mismatch');
        records.push(record);
      } catch (error) {
        throw new DomainError('DATA_CORRUPT', 'Requirements JSONL is corrupt.', { status: 500, cause: error, details: { line: index + 1 } });
      }
    }
    return records;
  }

  generateRequirementId() { return `req-${crypto.randomUUID()}`; }
}

module.exports = {
  ProjectStore,
  defaultProjectConfig,
  defaultProjectState,
  validateProjectConfig,
  validateProjectState,
};
