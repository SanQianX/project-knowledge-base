const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { getDataDir } = require('./data-dir');
const knowledgeStore = require('./knowledge-store');
const knowledgeStorageLocation = require('./knowledge-storage-location');
const embeddingConfigStore = require('./embedding-config');
const { KnowledgeDatabase } = require('./knowledge-db');
const { LocalEmbeddingService } = require('./embedding-service');
const { KnowledgeScopeRegistry } = require('./knowledge-scope-registry');
const { KnowledgeQueryService } = require('./knowledge-query-service');
const { pathsReferToSameLocation, isInsidePath } = require('./automation-config');
const { EMBEDDING_DIMENSIONS } = require('./knowledge-schema');

function readJson(filePath, fallback = {}) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function gitRoot(candidate) {
  const resolved = path.resolve(candidate || process.cwd());
  const cwd = fs.existsSync(resolved) && fs.statSync(resolved).isFile()
    ? path.dirname(resolved)
    : resolved;
  const result = spawnSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  return result.status === 0 && String(result.stdout || '').trim()
    ? path.resolve(String(result.stdout).trim())
    : cwd;
}

function projectRepoPath(project = {}) {
  return project.gitPath || project.localPath || '';
}

function safeLimit(value, fallback = 8, max = 30) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(1, Math.min(Math.floor(parsed), max)) : fallback;
}

function markdownFiles(kbPath) {
  const roots = [
    path.join(kbPath, 'README.md'),
    path.join(kbPath, 'GOAL.md'),
    path.join(kbPath, 'ARCHITECTURE.md'),
    path.join(kbPath, 'modules'),
    path.join(kbPath, 'changes'),
  ];
  const files = [];
  const walk = current => {
    if (!fs.existsSync(current)) return;
    const stat = fs.statSync(current);
    if (stat.isFile()) {
      if (current.toLowerCase().endsWith('.md')) files.push(current);
      return;
    }
    if (!stat.isDirectory()) return;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      walk(path.join(current, entry.name));
    }
  };
  roots.forEach(walk);
  return Array.from(new Set(files.map(file => path.resolve(file))));
}

function queryTokens(query) {
  const normalized = String(query || '').trim().toLowerCase();
  const words = normalized.match(/[\p{L}\p{N}_-]+/gu) || [];
  const compactCjk = normalized.match(/[\p{Script=Han}]+/gu) || [];
  for (const segment of compactCjk) {
    if (segment.length < 2) continue;
    for (let i = 0; i < segment.length - 1; i++) words.push(segment.slice(i, i + 2));
  }
  return Array.from(new Set(words.filter(token => token.length > 1)));
}

function markdownTitle(text, fallback) {
  const match = /^#\s+(.+)$/m.exec(text);
  return match ? match[1].trim() : fallback;
}

function markdownExcerpt(text, tokens, max = 900) {
  const normalized = String(text || '').replace(/\r\n/g, '\n');
  const lowered = normalized.toLowerCase();
  let index = -1;
  for (const token of tokens) {
    const hit = lowered.indexOf(token);
    if (hit >= 0 && (index < 0 || hit < index)) index = hit;
  }
  const start = Math.max(0, index < 0 ? 0 : index - 180);
  const excerpt = normalized.slice(start, start + max).trim();
  return `${start > 0 ? '…' : ''}${excerpt}${start + max < normalized.length ? '…' : ''}`;
}

class KnowledgeToolRuntime {
  constructor(options = {}) {
    this.dataDir = path.resolve(options.dataDir || getDataDir());
    this.cwd = path.resolve(options.cwd || process.cwd());
    this.projectsPath = path.join(this.dataDir, 'projects.json');
    this.scopePath = path.join(this.dataDir, 'knowledge-scopes.json');
    this.storePath = path.join(this.dataDir, 'knowledge-store.json');
    this.embeddingConfigPath = path.join(this.dataDir, 'embedding-config.json');
    this.database = null;
    this.databasePath = '';
    this.queryService = null;
  }

  readProjects() {
    const projects = readJson(this.projectsPath, {});
    if (!projects || typeof projects !== 'object' || Array.isArray(projects)) {
      throw new Error(`project registry is invalid: ${this.projectsPath}`);
    }
    return projects;
  }

  resolveProject(input = {}) {
    const projects = this.readProjects();
    const requestedSlug = String(input.projectSlug || input.project || '').trim();
    if (requestedSlug) {
      const project = projects[requestedSlug];
      if (!project || project.enabled === false) throw new Error(`project is not registered or enabled: ${requestedSlug}`);
      return this.publicProject(requestedSlug, project, projectRepoPath(project));
    }

    const root = gitRoot(input.repoPath || input.path || this.cwd);
    const matches = Object.entries(projects).filter(([, project]) => (
      project?.enabled !== false
      && projectRepoPath(project)
      && pathsReferToSameLocation(projectRepoPath(project), root)
    ));
    if (matches.length !== 1) {
      if (!matches.length) {
        throw new Error(`no enabled project is registered for Git root: ${root}`);
      }
      throw new Error(`multiple projects are registered for Git root: ${root}`);
    }
    const [slug, project] = matches[0];
    return this.publicProject(slug, project, root);
  }

  publicProject(slug, project, resolvedRepoPath) {
    const registry = new KnowledgeScopeRegistry({ filePath: this.scopePath }).read();
    const binding = registry.projectBindings?.[slug] || {};
    return {
      ok: true,
      projectSlug: slug,
      displayName: project.displayName || slug,
      repoPath: path.resolve(resolvedRepoPath || projectRepoPath(project)),
      kbPath: path.resolve(project.kbPath || path.join(this.dataDir, 'projects', slug)),
      knowledgeBackend: project.knowledgeBackend || 'markdown',
      knowledgeMode: project.knowledgeMode || 'personal',
      primarySpaceId: project.primarySpaceId || binding.primarySpaceId || '',
      relatedProjectSlugs: Array.isArray(binding.relatedProjectSlugs) ? binding.relatedProjectSlugs : [],
      readOnly: true,
    };
  }

  async ensureQueryService() {
    const config = knowledgeStore.readConfig(this.storePath, this.dataDir);
    const layout = knowledgeStorageLocation.resolveActiveLayout(config.rootPath, this.dataDir);
    if (this.queryService && pathsReferToSameLocation(this.databasePath, layout.dbPath)) return this.queryService;
    await this.close();

    const embeddingConfig = embeddingConfigStore.readConfig(this.embeddingConfigPath);
    const database = new KnowledgeDatabase({
      dbPath: layout.dbPath,
      maintenancePath: layout.databaseMaintenancePath,
    });
    let embedder;
    if (process.env.KB_EMBEDDING_FAKE === '1') {
      embedder = {
        embedQuery: async text => {
          const vector = new Array(EMBEDDING_DIMENSIONS).fill(0);
          for (let i = 0; i < String(text).length; i++) vector[String(text).charCodeAt(i) % vector.length] += 1;
          const norm = Math.sqrt(vector.reduce((sum, item) => sum + item * item, 0)) || 1;
          return vector.map(item => item / norm);
        },
      };
    } else {
      embedder = new LocalEmbeddingService({
        cacheDir: path.join(this.dataDir, 'models'),
        remoteHost: embeddingConfig.remoteHost,
        localModelPath: embeddingConfig.localModelPath,
        localFilesOnly: embeddingConfig.localFilesOnly,
      });
    }
    const scopeRegistry = new KnowledgeScopeRegistry({ filePath: this.scopePath });
    this.database = database;
    this.databasePath = layout.dbPath;
    this.queryService = new KnowledgeQueryService({
      database,
      embedder,
      scopeRegistry,
      readProjects: () => this.readProjects(),
    });
    return this.queryService;
  }

  async search(input = {}) {
    const project = this.resolveProject(input);
    if ((project.knowledgeBackend || '').toLowerCase() !== 'lancedb') {
      return this.searchMarkdown(project, input);
    }
    const service = await this.ensureQueryService();
    return service.search({
      projectSlug: project.projectSlug,
      query: input.query,
      limit: safeLimit(input.limit),
    });
  }

  async ask(input = {}) {
    const project = this.resolveProject(input);
    if ((project.knowledgeBackend || '').toLowerCase() !== 'lancedb') {
      const searched = await this.searchMarkdown(project, input);
      const citations = searched.results.slice(0, 5).map((item, index) => ({
        index: index + 1,
        projectSlug: project.projectSlug,
        entryId: item.entry_id,
        title: item.title,
        text: item.chunk_text,
      }));
      return {
        ...searched,
        answer: citations.length
          ? citations.map(item => `${item.index}. ${item.title}: ${item.text}`).join('\n')
          : 'No relevant knowledge was found.',
        citations,
      };
    }
    const service = await this.ensureQueryService();
    return service.ask({
      projectSlug: project.projectSlug,
      query: input.query,
      limit: safeLimit(input.limit),
    });
  }

  async get(input = {}) {
    const project = this.resolveProject(input);
    const entryId = String(input.entryId || input.entry || '').trim();
    if (!entryId) throw new Error('entry is required');
    if ((project.knowledgeBackend || '').toLowerCase() !== 'lancedb') {
      const target = path.resolve(project.kbPath, entryId);
      if (!isInsidePath(project.kbPath, target) || !target.toLowerCase().endsWith('.md')) {
        throw new Error('entry is outside the project knowledge base');
      }
      if (!fs.existsSync(target) || !fs.statSync(target).isFile()) throw new Error(`knowledge entry not found: ${entryId}`);
      return {
        ok: true,
        projectSlug: project.projectSlug,
        entryId: path.relative(project.kbPath, target).replace(/\\/g, '/'),
        chunks: [{ chunk_text: fs.readFileSync(target, 'utf8'), entry_id: entryId, space_id: project.primarySpaceId }],
      };
    }
    const service = await this.ensureQueryService();
    return service.get({
      projectSlug: project.projectSlug,
      entryId,
      spaceId: input.spaceId || input.space,
    });
  }

  async history(input = {}) {
    const project = this.resolveProject(input);
    if ((project.knowledgeBackend || '').toLowerCase() !== 'lancedb') {
      const changesRoot = path.join(project.kbPath, 'changes');
      const rows = markdownFiles(project.kbPath)
        .filter(file => isInsidePath(changesRoot, file) && path.basename(file).toLowerCase() !== '00-index.md')
        .map(file => {
          const text = fs.readFileSync(file, 'utf8');
          return {
            entry_id: path.relative(project.kbPath, file).replace(/\\/g, '/'),
            title: markdownTitle(text, path.basename(file, '.md')),
            chunk_text: markdownExcerpt(text, [], 900),
            updated_at: fs.statSync(file).mtime.toISOString(),
          };
        })
        .sort((left, right) => right.updated_at.localeCompare(left.updated_at))
        .slice(0, safeLimit(input.limit, 20, 100));
      return { ok: true, projectSlug: project.projectSlug, backend: 'markdown', results: rows };
    }
    const service = await this.ensureQueryService();
    return service.history({
      projectSlug: project.projectSlug,
      limit: safeLimit(input.limit, 20, 100),
    });
  }

  searchMarkdown(project, input = {}) {
    const query = String(input.query || '').trim();
    if (!query) throw new Error('query is required');
    const tokens = queryTokens(query);
    const loweredQuery = query.toLowerCase();
    const results = markdownFiles(project.kbPath).map(file => {
      const text = fs.readFileSync(file, 'utf8');
      const lowered = text.toLowerCase();
      let score = lowered.includes(loweredQuery) ? 20 : 0;
      for (const token of tokens) {
        let index = 0;
        let count = 0;
        while ((index = lowered.indexOf(token, index)) >= 0 && count < 20) {
          count += 1;
          index += token.length;
        }
        score += count;
      }
      if (!score) return null;
      const entryId = path.relative(project.kbPath, file).replace(/\\/g, '/');
      return {
        entry_id: entryId,
        title: markdownTitle(text, path.basename(file, '.md')),
        chunk_text: markdownExcerpt(text, tokens),
        relevance_score: score,
        space_id: project.primarySpaceId,
        scope_project_slug: project.projectSlug,
      };
    }).filter(Boolean)
      .sort((left, right) => right.relevance_score - left.relevance_score)
      .slice(0, safeLimit(input.limit));
    return {
      ok: true,
      projectSlug: project.projectSlug,
      query,
      backend: 'markdown',
      searchMode: 'keyword',
      results,
    };
  }

  async close() {
    const database = this.database;
    this.database = null;
    this.databasePath = '';
    this.queryService = null;
    if (database) await database.close();
  }
}

module.exports = {
  KnowledgeToolRuntime,
  gitRoot,
  markdownFiles,
  queryTokens,
};
