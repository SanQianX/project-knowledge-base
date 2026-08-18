const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { StorageLayout } = require('./storage-layout');
const { SettingsStore } = require('./settings-store');
const { ProjectRegistryStore } = require('./project-registry-store');
const { ProjectStore } = require('./project-store');
const { RequirementRecorder } = require('./requirement-recorder');
const { KnowledgeDatabase } = require('./knowledge-db');
const { LocalEmbeddingService } = require('./embedding-service');
const { EMBEDDING_DIMENSIONS } = require('./knowledge-schema');
const { DomainError } = require('./contracts');
const { KnowledgeRetrievalService } = require('./knowledge-retrieval-service');
const { ConversationStore } = require('./conversation-store');

function gitRoot(candidate) {
  const resolved = path.resolve(candidate || process.cwd());
  const cwd = fs.existsSync(resolved) && fs.statSync(resolved).isFile() ? path.dirname(resolved) : resolved;
  const result = spawnSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], {
    encoding: 'utf8', windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  return result.status === 0 && String(result.stdout || '').trim()
    ? path.resolve(String(result.stdout).trim())
    : cwd;
}

function safeLimit(value, fallback = 8, max = 30) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(1, Math.min(Math.floor(parsed), max)) : fallback;
}

function markdownFiles(knowledgePath) {
  const roots = [
    path.join(knowledgePath, 'README.md'),
    path.join(knowledgePath, 'GOAL.md'),
    path.join(knowledgePath, 'ARCHITECTURE.md'),
    path.join(knowledgePath, 'modules'),
    path.join(knowledgePath, 'changes'),
  ];
  const files = [];
  const walk = current => {
    if (!fs.existsSync(current)) return;
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) return;
    if (stat.isFile()) {
      if (/\.md$/i.test(current) && path.basename(current).toLowerCase() !== '00-index.md') files.push(path.resolve(current));
      return;
    }
    if (!stat.isDirectory()) return;
    for (const entry of fs.readdirSync(current)) walk(path.join(current, entry));
  };
  roots.forEach(walk);
  return [...new Set(files)].sort();
}

function queryTokens(query) {
  const normalized = String(query || '').trim().toLowerCase();
  const words = normalized.match(/[\p{L}\p{N}_-]+/gu) || [];
  for (const segment of normalized.match(/[\p{Script=Han}]+/gu) || []) {
    for (let index = 0; index < segment.length - 1; index += 1) words.push(segment.slice(index, index + 2));
  }
  return [...new Set(words.filter(token => token.length > 1))];
}

function markdownTitle(text, fallback) {
  const match = /^#\s+(.+)$/m.exec(String(text || ''));
  return match ? match[1].trim() : fallback;
}

function markdownExcerpt(text, tokens, max = 900) {
  const normalized = String(text || '').replace(/\r\n/g, '\n');
  const lowered = normalized.toLowerCase();
  let first = -1;
  for (const token of tokens) {
    const hit = lowered.indexOf(token);
    if (hit >= 0 && (first < 0 || hit < first)) first = hit;
  }
  const start = Math.max(0, first < 0 ? 0 : first - 180);
  const excerpt = normalized.slice(start, start + max).trim();
  return `${start > 0 ? '…' : ''}${excerpt}${start + max < normalized.length ? '…' : ''}`;
}

function publicIndexResult(row, scope) {
  const { vector, tags_json, source_paths_json, routes_json, symbols_json, ...safe } = row;
  return {
    ...safe,
    chunk_text: markdownExcerpt(row.chunk_text, [], 900),
    scope_reason: scope.reason,
    scope_project_id: scope.projectId,
  };
}

class KnowledgeToolRuntime {
  constructor(options = {}) {
    this.layout = options.layout || new StorageLayout({ dataDir: options.dataDir });
    this.cwd = path.resolve(options.cwd || process.cwd());
    this.settingsStore = options.settingsStore || new SettingsStore({ layout: this.layout });
    this.registryStore = options.registryStore || new ProjectRegistryStore({ layout: this.layout });
    this.projectStore = options.projectStore || new ProjectStore({ layout: this.layout });
    this.database = null;
    this.embedder = null;
    this.conversationStore = options.conversationStore || new ConversationStore({
      layout: this.layout,
      projectStore: this.projectStore,
      logger: options.logger,
    });
    this.requirementRecorder = options.requirementRecorder || new RequirementRecorder({
      layout: this.layout,
      registryStore: this.registryStore,
      projectStore: this.projectStore,
      conversationStore: this.conversationStore,
      logger: options.logger,
    });
    this.retrievalService = options.retrievalService || new KnowledgeRetrievalService({
      layout: this.layout,
      registryStore: this.registryStore,
      projectStore: this.projectStore,
      databaseProvider: () => this.createDatabase(),
      embedderProvider: () => this.createEmbedder(),
      logger: options.logger,
    });
  }

  projectAlias(projectId, config) {
    return String(config.legacyExtensions && config.legacyExtensions.slug || projectId);
  }

  resolveRequestedProject(requested) {
    const ids = this.registryStore.listIds();
    if (ids.includes(requested)) return requested;
    const matches = ids.filter(projectId => this.projectAlias(projectId, this.projectStore.readConfig(projectId)) === requested);
    if (matches.length > 1) throw new DomainError('PROJECT_AMBIGUOUS', 'Multiple projects use this compatibility alias.', { status: 409 });
    if (!matches.length) throw new DomainError('PROJECT_NOT_FOUND', 'The requested project is not registered.', { status: 404 });
    return matches[0];
  }

  resolveProject(input = {}) {
    const requested = String(input.projectId || input.projectSlug || input.project || '').trim();
    let projectId;
    let resolvedRepoPath = '';
    if (requested) {
      projectId = this.resolveRequestedProject(requested);
    } else {
      resolvedRepoPath = gitRoot(input.repoPath || input.path || this.cwd);
      const matches = this.registryStore.listIds().filter(candidate => {
        const config = this.projectStore.readConfig(candidate);
        return config.enabled !== false && this.layout.pathsEqual(config.repoPath, resolvedRepoPath);
      });
      if (!matches.length) throw new DomainError('PROJECT_NOT_FOUND', 'No enabled project is registered for this Git root.', { status: 404 });
      if (matches.length > 1) throw new DomainError('PROJECT_AMBIGUOUS', 'Multiple projects are registered for this Git root.', { status: 409 });
      [projectId] = matches;
    }
    const config = this.projectStore.readConfig(projectId);
    if (config.enabled === false) throw new DomainError('PROJECT_NOT_FOUND', 'The requested project is disabled.', { status: 404 });
    const state = this.projectStore.readState(projectId);
    return {
      ok: true,
      projectId,
      projectSlug: this.projectAlias(projectId, config),
      displayName: config.displayName,
      repoPath: path.resolve(resolvedRepoPath || config.repoPath),
      knowledgePath: path.resolve(config.knowledgePath),
      kbPath: path.resolve(config.knowledgePath),
      indexPath: this.layout.getIndexPath(),
      primarySpaceId: `project:${projectId}`,
      relatedProjectIds: Array.isArray(config.relatedProjectIds) ? [...config.relatedProjectIds] : [],
      index: { ...state.index },
      readOnly: true,
    };
  }

  scopes(project) {
    const scopes = [{ projectId: project.projectId, spaceId: project.primarySpaceId, weight: 1, reason: 'primary' }];
    for (const projectId of project.relatedProjectIds) {
      if (!this.registryStore.readDisplaySnapshot(projectId)) continue;
      const config = this.projectStore.readConfig(projectId);
      if (config.enabled === false) continue;
      scopes.push({ projectId, spaceId: `project:${projectId}`, weight: 0.88, reason: 'related' });
    }
    return scopes;
  }

  indexAvailability(project) {
    if (project.index.dirty) return { usable: false, status: 'dirty', reason: 'index-dirty' };
    const indexPath = this.layout.getIndexPath();
    if (!fs.existsSync(indexPath)) return { usable: false, status: 'unavailable', reason: 'index-missing' };
    return { usable: true, status: 'ok', reason: '' };
  }

  createEmbedder() {
    if (this.embedder) return this.embedder;
    if (process.env.KB_EMBEDDING_FAKE === '1') {
      this.embedder = {
        embedQuery: async text => {
          const vector = new Array(EMBEDDING_DIMENSIONS).fill(0);
          for (let index = 0; index < String(text).length; index += 1) vector[String(text).charCodeAt(index) % vector.length] += 1;
          const norm = Math.sqrt(vector.reduce((sum, item) => sum + item * item, 0)) || 1;
          return vector.map(item => item / norm);
        },
      };
      return this.embedder;
    }
    const settings = this.settingsStore.read({ allowMissing: true });
    this.embedder = new LocalEmbeddingService({
      modelId: settings.embedding.modelId,
      cacheDir: this.layout.getCachePath('models'),
      remoteHost: settings.embedding.remoteHost,
      localModelPath: settings.embedding.localModelPath,
      localFilesOnly: settings.embedding.localFilesOnly === true,
    });
    return this.embedder;
  }

  createDatabase() {
    if (!this.database) {
      this.database = new KnowledgeDatabase({
        dbPath: this.layout.getIndexPath(),
        maintenancePath: this.layout.getRuntimePath('index-maintenance.json'),
      });
    }
    return this.database;
  }

  async searchIndex(project, input) {
    const query = String(input.query || '').trim();
    const scopes = this.scopes(project);
    const vector = await this.createEmbedder().embedQuery(query);
    const limit = safeLimit(input.limit);
    const rows = await this.createDatabase().hybridSearch({
      text: query,
      vector,
      spaceIds: scopes.map(scope => scope.spaceId),
      limit: Math.min(limit * 4, 100),
      candidates: Math.min(limit * 8, 200),
    });
    const bySpace = new Map(scopes.map(scope => [scope.spaceId, scope]));
    const results = rows.map(row => {
      const scope = bySpace.get(row.space_id) || scopes[0];
      return { ...publicIndexResult(row, scope), relevance_score: Number(row.relevance_score || 0) * scope.weight };
    }).sort((left, right) => right.relevance_score - left.relevance_score).slice(0, limit);
    return { ok: true, projectId: project.projectId, projectSlug: project.projectSlug, query, backend: 'lancedb', source: 'derived-index', health: { index: 'ok' }, results };
  }

  searchMarkdown(project, input = {}, health = { index: 'unavailable' }) {
    const query = String(input.query || '').trim();
    if (!query) throw new DomainError('INVALID_ARGUMENT', 'query is required.');
    const tokens = queryTokens(query);
    const loweredQuery = query.toLowerCase();
    const sources = this.scopes(project).map(scope => {
      const config = scope.projectId === project.projectId ? null : this.projectStore.readConfig(scope.projectId);
      return { scope, knowledgePath: config ? path.resolve(config.knowledgePath) : project.knowledgePath };
    });
    const results = sources.flatMap(source => markdownFiles(source.knowledgePath).map(file => {
      const text = fs.readFileSync(file, 'utf8');
      const lowered = text.toLowerCase();
      let score = lowered.includes(loweredQuery) ? 20 : 0;
      for (const token of tokens) {
        let offset = 0;
        let matches = 0;
        while ((offset = lowered.indexOf(token, offset)) >= 0 && matches < 20) {
          matches += 1;
          offset += token.length;
        }
        score += matches;
      }
      if (!score) return null;
      const entryId = path.relative(source.knowledgePath, file).replace(/\\/g, '/');
      return {
        entry_id: entryId,
        title: markdownTitle(text, path.basename(file, '.md')),
        chunk_text: markdownExcerpt(text, tokens),
        relevance_score: score * source.scope.weight,
        space_id: source.scope.spaceId,
        scope_project_id: source.scope.projectId,
      };
    })).filter(Boolean).sort((left, right) => right.relevance_score - left.relevance_score).slice(0, safeLimit(input.limit));
    return { ok: true, projectId: project.projectId, projectSlug: project.projectSlug, query, backend: 'markdown', source: 'markdown-fallback', health, results };
  }

  async search(input = {}) {
    const project = this.resolveProject(input);
    return this.retrievalService.search({ ...input, project });
  }

  async ask(input = {}) {
    const searched = await this.search(input);
    const citations = searched.results.slice(0, 5).map((result, index) => ({
      index: index + 1,
      projectId: result.scope_project_id || searched.projectId,
      entryId: result.entry_id,
      title: result.title,
      text: result.chunk_text,
    }));
    return {
      ...searched,
      answer: citations.length ? citations.map(item => `${item.index}. ${item.title}: ${item.text}`).join('\n') : 'No relevant knowledge was found.',
      citations,
    };
  }

  async get(input = {}) {
    const project = this.resolveProject(input);
    const entryId = String(input.entryId || input.entry || '').trim().replace(/\\/g, '/');
    if (!entryId) throw new DomainError('INVALID_ARGUMENT', 'entry is required.');
    const target = path.resolve(project.knowledgePath, ...entryId.split('/'));
    if (!/\.md$/i.test(target) || !this.layout.isPathInside(project.knowledgePath, target, { realpath: true })) {
      throw new DomainError('PATH_OUTSIDE_ROOT', 'entry is outside the project knowledge base.', { status: 403 });
    }
    if (!fs.existsSync(target) || !fs.statSync(target).isFile() || fs.lstatSync(target).isSymbolicLink()) {
      throw new DomainError('PROJECT_NOT_FOUND', 'Knowledge entry was not found.', { status: 404 });
    }
    return {
      ok: true,
      projectId: project.projectId,
      projectSlug: project.projectSlug,
      entryId: path.relative(project.knowledgePath, target).replace(/\\/g, '/'),
      source: 'markdown',
      chunks: [{ chunk_text: fs.readFileSync(target, 'utf8'), entry_id: entryId, space_id: project.primarySpaceId }],
    };
  }

  async history(input = {}) {
    const project = this.resolveProject(input);
    const changesRoot = path.join(project.knowledgePath, 'changes');
    const results = markdownFiles(project.knowledgePath).filter(file => this.layout.isPathInside(changesRoot, file, { realpath: true })).map(file => {
      const text = fs.readFileSync(file, 'utf8');
      return {
        entry_id: path.relative(project.knowledgePath, file).replace(/\\/g, '/'),
        title: markdownTitle(text, path.basename(file, '.md')),
        chunk_text: markdownExcerpt(text, [], 900),
        updated_at: fs.statSync(file).mtime.toISOString(),
      };
    }).sort((left, right) => right.updated_at.localeCompare(left.updated_at)).slice(0, safeLimit(input.limit, 20, 100));
    return { ok: true, projectId: project.projectId, projectSlug: project.projectSlug, backend: 'markdown', source: 'markdown', results };
  }

  async recordRequirement(input = {}) {
    const record = await this.requirementRecorder.recordRequirement(input);
    return {
      ok: true,
      projectId: record.projectId,
      requirementId: record.id,
      requirementHash: record.requirementHash,
      recordedAt: record.ts,
      branch: record.branch,
      headAtRecord: record.headAtRecord,
      turnId: record.turnId,
    };
  }

  async close() {
    const database = this.database;
    this.database = null;
    this.embedder = null;
    if (database) await database.close();
  }
}

module.exports = { KnowledgeToolRuntime, gitRoot, markdownFiles, queryTokens };
