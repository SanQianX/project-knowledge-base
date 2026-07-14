function excerpt(value, max = 700) {
  const text = String(value || '').trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function publicResult(row, scopeInfo = null) {
  const { vector, tags_json, source_paths_json, routes_json, symbols_json, ...rest } = row;
  return {
    ...rest,
    chunk_text: excerpt(row.chunk_text),
    scope_reason: scopeInfo?.reason || '',
    scope_project_slug: scopeInfo?.projectSlug || '',
  };
}

class KnowledgeQueryService {
  constructor(options = {}) {
    if (!options.database || !options.embedder || !options.scopeRegistry) throw new Error('database, embedder, and scopeRegistry are required');
    this.database = options.database;
    this.embedder = options.embedder;
    this.scopeRegistry = options.scopeRegistry;
    this.readProjects = options.readProjects || (() => ({}));
  }

  scope(projectSlug) {
    const projects = this.readProjects();
    if (!projects[projectSlug]) throw new Error(`project not found: ${projectSlug}`);
    return { projects, scope: this.scopeRegistry.resolveProjectScope(projects, projectSlug) };
  }

  async search(input = {}) {
    const query = String(input.query || '').trim();
    if (!query) throw new Error('query is required');
    const { projects, scope } = this.scope(input.projectSlug);
    if (projects[input.projectSlug].knowledgeBackend !== 'lancedb') {
      throw new Error(`project ${input.projectSlug} has not been migrated to LanceDB`);
    }
    const vector = await this.embedder.embedQuery(query);
    const limit = Math.max(1, Math.min(Number(input.limit || 8), 30));
    const rows = await this.database.hybridSearch({
      text: query,
      vector,
      spaceIds: scope.spaces.map(item => item.spaceId),
      limit: Math.min(limit * 4, 100),
      candidates: Math.min(limit * 8, 200),
    });
    const weights = new Map(scope.spaces.map(item => [item.spaceId, item]));
    const results = rows.map(row => {
      const info = weights.get(row.space_id);
      return { ...publicResult(row, info), relevance_score: row.relevance_score * (info?.weight || 0) };
    }).sort((a, b) => b.relevance_score - a.relevance_score).slice(0, limit);
    return { ok: true, projectSlug: input.projectSlug, query, scope, results };
  }

  async get(input = {}) {
    const entryId = String(input.entryId || '').trim();
    if (!entryId) throw new Error('entryId is required');
    const { scope } = this.scope(input.projectSlug);
    const allowed = scope.spaces.map(item => item.spaceId);
    if (input.spaceId && !allowed.includes(input.spaceId)) throw new Error('requested space is outside the project search scope');
    const rows = await this.database.getEntry(entryId, { spaceIds: allowed, spaceId: input.spaceId });
    return { ok: true, projectSlug: input.projectSlug, entryId, scope, chunks: rows.map(row => publicResult(row, scope.spaces.find(item => item.spaceId === row.space_id))) };
  }

  async ask(input = {}) {
    const searched = await this.search(input);
    if (!searched.results.length) {
      return { ...searched, answer: '知识库中没有找到足够相关的内容。', citations: [] };
    }
    const citations = searched.results.slice(0, 5).map((row, index) => ({
      index: index + 1,
      spaceId: row.space_id,
      projectSlug: row.scope_project_slug || input.projectSlug,
      entryId: row.entry_id,
      title: row.title,
      heading: row.heading_path,
      sourceCommit: row.source_commit,
      text: row.chunk_text,
    }));
    const answer = [
      `根据 ${citations.length} 条相关知识记录：`,
      ...citations.map(item => `${item.index}. ${item.title || item.entryId}${item.heading ? ` / ${item.heading}` : ''}：${excerpt(item.text, 320)}`),
      '以上内容来自已校验的知识库原文；需要形成结论时，应结合当前源码和提交状态再次核对。',
    ].join('\n');
    return { ...searched, answer, citations };
  }

  async history(input = {}) {
    const { scope } = this.scope(input.projectSlug);
    const rows = await this.database.history({ spaceIds: scope.spaces.map(item => item.spaceId), limit: input.limit });
    return { ok: true, projectSlug: input.projectSlug, scope, results: rows.map(row => publicResult(row, scope.spaces.find(item => item.spaceId === row.space_id))) };
  }
}

module.exports = { KnowledgeQueryService, publicResult };
