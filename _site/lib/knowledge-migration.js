const fs = require('fs');
const path = require('path');
const { MarkdownKnowledgeIndexer, listMarkdownFiles } = require('./markdown-knowledge-indexer');
const { sha256 } = require('./knowledge-schema');

const MIGRATION_SCHEMA = 'project-knowledge/vector-migration/v1';

function atomicJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temp, filePath);
}

function readState(filePath) {
  try {
    const value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

function defaultState() {
  return {
    schema: MIGRATION_SCHEMA,
    status: 'idle',
    startedAt: null,
    endedAt: null,
    currentProject: null,
    total: 0,
    completed: 0,
    failed: 0,
    projects: {},
  };
}

function copyMarkdownBackup(kbPath, backupRoot, slug) {
  // Backups retain derived compatibility indexes even though they are not
  // searchable knowledge and are deliberately excluded from LanceDB.
  const files = listMarkdownFiles(kbPath, { includeDerived: true });
  const target = path.join(backupRoot, slug);
  const manifest = [];
  for (const filePath of files) {
    const rel = path.relative(kbPath, filePath);
    const dest = path.join(target, rel);
    const content = fs.readFileSync(filePath);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(filePath, dest);
    manifest.push({ path: rel.replace(/\\/g, '/'), bytes: content.length, sha256: sha256(content) });
  }
  fs.mkdirSync(target, { recursive: true });
  atomicJson(path.join(target, 'migration-manifest.json'), {
    schema: MIGRATION_SCHEMA,
    source: path.resolve(kbPath),
    backedUpAt: new Date().toISOString(),
    files: manifest,
  });
  return { path: target, files: manifest.length, manifest };
}

class KnowledgeMigrationManager {
  constructor(options = {}) {
    if (!options.database) throw new Error('database is required');
    if (!options.embedder) throw new Error('embedder is required');
    if (!options.dataDir) throw new Error('dataDir is required');
    this.database = options.database;
    this.embedder = options.embedder;
    this.dataDir = path.resolve(options.dataDir);
    this.statePath = options.statePath || path.join(this.dataDir, 'knowledge-migration.json');
    this.onProjectMigrated = options.onProjectMigrated || (async () => {});
    this.indexer = options.indexer || new MarkdownKnowledgeIndexer({ database: this.database, embedder: this.embedder });
  }

  state() {
    return readState(this.statePath) || defaultState();
  }

  saveState(state) {
    atomicJson(this.statePath, state);
    return state;
  }

  inspect(projects = {}) {
    const persisted = this.state();
    const items = Object.entries(projects).map(([slug, project]) => {
      const kbPath = path.resolve(project.kbPath || path.join(this.dataDir, 'projects', slug));
      const files = fs.existsSync(kbPath) ? listMarkdownFiles(kbPath).length : 0;
      const migrated = project.knowledgeBackend === 'lancedb';
      return {
        slug,
        displayName: project.displayName || slug,
        knowledgeMode: project.knowledgeMode || 'personal',
        primarySpaceId: project.primarySpaceId || `project:${slug}`,
        kbPath,
        files,
        eligible: !migrated && files > 0,
        migrated,
        state: persisted.projects[slug] || null,
      };
    });
    return {
      ...persisted,
      items,
      eligible: items.filter(item => item.eligible).length,
      migratedProjects: items.filter(item => item.migrated).length,
    };
  }

  async migrateProject(slug, project, batchId) {
    const kbPath = path.resolve(project.kbPath || path.join(this.dataDir, 'projects', slug));
    const spaceId = String(project.primarySpaceId || `project:${slug}`);
    if (!fs.existsSync(kbPath) || !fs.statSync(kbPath).isDirectory()) throw new Error(`knowledge path not found: ${kbPath}`);
    const files = listMarkdownFiles(kbPath);
    if (!files.length) throw new Error('no Markdown knowledge files found');

    const backupRoot = path.join(this.dataDir, '_backup', 'vector-migration', batchId);
    const backup = copyMarkdownBackup(kbPath, backupRoot, slug);
    const indexResult = await this.indexer.indexDirectory({
      kbPath,
      spaceId,
      sourceProjectId: slug,
      sourceCommit: project.headCommit || project.lastAnalyzedCommit || '',
      deferMaintenance: true,
    });

    const expected = indexResult.results.filter(item => item.chunks > 0);
    const entryIds = await this.database.entryIds(spaceId);
    const expectedIds = expected.map(item => item.entryId).sort();
    if (JSON.stringify(entryIds) !== JSON.stringify(expectedIds)) {
      throw new Error(`verification failed: expected ${expectedIds.length} entries, found ${entryIds.length}`);
    }
    let chunks = 0;
    for (const entry of expected) {
      const rows = await this.database.rowsForEntry(spaceId, entry.entryId);
      chunks += rows.length;
      if (rows.length !== entry.chunks || rows.some(row => row.document_hash !== entry.documentHash || !row.chunk_text)) {
        throw new Error(`verification failed for ${entry.entryId}`);
      }
    }
    if (!chunks) throw new Error('verification failed: no searchable chunks were created');
    const probeRows = await this.database.rowsForEntry(spaceId, expected[0].entryId);
    const probe = await this.database.vectorSearch(probeRows[0].vector, { spaceIds: [spaceId], limit: 1 });
    if (!probe.length || probe[0].space_id !== spaceId) throw new Error('verification failed: vector search probe returned no result');

    const patch = {
      knowledgeBackend: 'lancedb',
      primarySpaceId: spaceId,
      legacyKbPath: kbPath,
      vectorMigratedAt: new Date().toISOString(),
      vectorMigrationVersion: 1,
      teamSyncTransport: project.knowledgeMode === 'team' ? 'markdown-v1' : (project.teamSyncTransport || ''),
    };
    await this.onProjectMigrated(slug, patch);
    return {
      ok: true,
      slug,
      spaceId,
      files: expected.length,
      chunks,
      backupPath: backup.path,
      transport: patch.teamSyncTransport || 'local',
      verified: true,
      patch,
    };
  }

  async migrateAll(projects = {}, options = {}) {
    const requested = Array.isArray(options.slugs) && options.slugs.length ? new Set(options.slugs) : null;
    const candidates = Object.entries(projects).filter(([slug, project]) => {
      if (requested && !requested.has(slug)) return false;
      if (project.knowledgeBackend === 'lancedb' && options.force !== true) return false;
      const kbPath = project.kbPath || path.join(this.dataDir, 'projects', slug);
      return fs.existsSync(kbPath) && listMarkdownFiles(kbPath).length > 0;
    });
    if (!candidates.length) return { ...this.inspect(projects), status: 'completed', message: 'no legacy projects need migration' };
    const batchId = new Date().toISOString().replace(/[:.]/g, '-');
    const state = defaultState();
    Object.assign(state, { status: 'running', startedAt: new Date().toISOString(), total: candidates.length, batchId });
    this.saveState(state);
    if (typeof this.embedder.load === 'function') {
      state.currentProject = '__embedding_model__';
      state.model = { status: 'loading', startedAt: new Date().toISOString() };
      this.saveState(state);
      try {
        await this.embedder.load();
        state.model = { status: 'ready', endedAt: new Date().toISOString(), ...(this.embedder.status?.() || {}) };
      } catch (error) {
        state.currentProject = null;
        state.status = 'model-required';
        state.endedAt = new Date().toISOString();
        state.error = error.message;
        state.model = {
          status: 'failed',
          endedAt: state.endedAt,
          error: error.message,
          ...(this.embedder.status?.() || {}),
        };
        return this.saveState(state);
      }
      this.saveState(state);
    }
    for (const [slug, project] of candidates) {
      state.currentProject = slug;
      state.projects[slug] = { status: 'running', startedAt: new Date().toISOString() };
      this.saveState(state);
      try {
        const result = await this.migrateProject(slug, project, batchId);
        state.completed += 1;
        state.projects[slug] = { status: 'completed', endedAt: new Date().toISOString(), ...result };
      } catch (error) {
        state.failed += 1;
        state.projects[slug] = { status: 'failed', endedAt: new Date().toISOString(), error: error.message };
      }
      this.saveState(state);
    }
    state.currentProject = null;
    if (state.completed > 0) {
      await this.database.ensureSearchIndexes();
      state.maintenance = await this.database.maybeOptimize();
    }
    state.status = state.failed ? 'completed-with-errors' : 'completed';
    state.endedAt = new Date().toISOString();
    return this.saveState(state);
  }
}

module.exports = { KnowledgeMigrationManager, MIGRATION_SCHEMA, copyMarkdownBackup };
