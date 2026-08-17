const fs = require('fs');
const path = require('path');
const AtomicFile = require('./atomic-file');
const { DomainError, createId, validateProjectId } = require('./contracts');
const { StorageLayout } = require('./storage-layout');
const { ProjectRegistryStore } = require('./project-registry-store');
const { ProjectStore } = require('./project-store');

let globalWriterTail = Promise.resolve();

function enqueueGlobal(task) {
  const run = globalWriterTail.catch(() => {}).then(task);
  globalWriterTail = run.catch(() => {});
  return run;
}

class IndexService {
  constructor(options = {}) {
    this.layout = options.layout || new StorageLayout(options);
    this.registryStore = options.registryStore || new ProjectRegistryStore({ layout: this.layout });
    this.projectStore = options.projectStore || new ProjectStore({ layout: this.layout });
    this.adapter = options.adapter || null;
    this.logger = options.logger || null;
    this.pending = new Map();
  }

  async log(level, event, message, context) {
    if (this.logger && typeof this.logger[level] === 'function') await this.logger[level](event, message, context);
  }

  enqueue(projectId) {
    validateProjectId(projectId);
    const existing = this.pending.get(projectId);
    if (existing) {
      existing.rerun = true;
      return existing.promise;
    }
    const entry = { rerun: false, promise: null };
    entry.promise = enqueueGlobal(() => this.processEntry(projectId, entry));
    this.pending.set(projectId, entry);
    entry.promise.finally(() => {
      if (this.pending.get(projectId) === entry) this.pending.delete(projectId);
    });
    return entry.promise;
  }

  async processEntry(projectId, entry) {
    let lastResult = { ok: true, skipped: true };
    do {
      entry.rerun = false;
      lastResult = await this.processProject(projectId);
      if (!lastResult.ok) return lastResult;
      const state = this.projectStore.readState(projectId);
      if (state.index.dirty) entry.rerun = true;
    } while (entry.rerun);
    return lastResult;
  }

  async processProject(projectId) {
    const config = this.projectStore.readConfig(projectId);
    const before = this.projectStore.readState(projectId);
    if (!before.index.dirty) return { ok: true, skipped: true, projectId };
    const generation = before.index.generation;
    const operationId = createId('op');
    try {
      if (!this.adapter || typeof this.adapter.indexProject !== 'function') throw new DomainError('INVALID_ARGUMENT', 'Index adapter is unavailable.', { status: 503, retryable: true });
      const result = await this.adapter.indexProject({
        projectId,
        config,
        knowledgePath: config.knowledgePath,
        indexPath: this.layout.getIndexPath(),
        generation,
        sinceCommit: before.index.sinceCommit,
      });
      await this.projectStore.updateState(projectId, state => {
        if (state.index.generation === generation) {
          state.index.dirty = false;
          state.index.sinceCommit = null;
          state.index.lastError = null;
          state.index.lastIndexedAt = new Date().toISOString();
        }
      });
      await this.log('info', 'index.project_applied', 'Derived knowledge index updated.', { projectId, operationId, generation, phase: 'index.applied' });
      return { ok: true, projectId, generation, result: result || null };
    } catch (error) {
      await this.projectStore.updateState(projectId, state => {
        state.index.dirty = true;
        state.index.lastError = {
          code: error.code || 'INVALID_ARGUMENT',
          message: String(error.message || 'Index update failed.'),
          generation,
          ts: new Date().toISOString(),
        };
      });
      await this.log('error', 'index.project_failed', 'Derived index update failed; Markdown remains authoritative.', { projectId, operationId, generation, phase: 'index.queued', error });
      return { ok: false, projectId, generation, error: { code: error.code || 'INVALID_ARGUMENT', message: error.message } };
    }
  }

  retryDirtyProjects() {
    return Promise.all(this.registryStore.listIds()
      .filter(projectId => this.projectStore.readState(projectId).index.dirty)
      .map(projectId => this.enqueue(projectId)));
  }

  async fullRebuild(options = {}) {
    if (!this.adapter || typeof this.adapter.buildFull !== 'function' || typeof this.adapter.validateIndex !== 'function') {
      throw new DomainError('INVALID_ARGUMENT', 'Index adapter does not support atomic full rebuild.', { status: 503 });
    }
    return enqueueGlobal(async () => {
      const operationId = options.operationId || createId('op');
      const target = this.layout.getIndexPath();
      const parent = path.dirname(target);
      const temp = path.join(parent, `.knowledge.rebuild.${operationId}`);
      const backup = this.layout.getRecoveryPath('index', `${operationId}.previous`);
      if (fs.existsSync(temp)) throw new DomainError('MIGRATION_TARGET_CONFLICT', 'Index rebuild staging already exists.', { status: 409 });
      const projects = this.registryStore.listIds().map(projectId => ({ projectId, config: this.projectStore.readConfig(projectId) }));
      try {
        await this.adapter.buildFull({ targetPath: temp, projects });
        const validation = await this.adapter.validateIndex(temp);
        if (!validation || validation.ok !== true) throw new DomainError('DATA_CORRUPT', 'Rebuilt index validation failed.', { status: 500 });
        fs.mkdirSync(path.dirname(backup), { recursive: true });
        if (fs.existsSync(target)) fs.renameSync(target, backup);
        try { fs.renameSync(temp, target); }
        catch (error) {
          if (fs.existsSync(backup) && !fs.existsSync(target)) fs.renameSync(backup, target);
          throw error;
        }
        return { ok: true, operationId, target, backup: fs.existsSync(backup) ? backup : null, validation };
      } catch (error) {
        if (fs.existsSync(temp)) fs.rmSync(temp, { recursive: true, force: true });
        throw error;
      }
    });
  }

  static async flush() { await globalWriterTail.catch(() => {}); }
}

module.exports = { IndexService, enqueueGlobal };
