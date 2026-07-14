const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { KnowledgeDatabase } = require('../lib/knowledge-db');
const { KnowledgeScopeRegistry } = require('../lib/knowledge-scope-registry');
const { KnowledgeQueryService } = require('../lib/knowledge-query-service');
const { EMBEDDING_DIMENSIONS } = require('../lib/knowledge-schema');

function vectorAt(index) {
  const vector = new Array(EMBEDDING_DIMENSIONS).fill(0);
  vector[index] = 1;
  return vector;
}

(async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-query-test-'));
  const db = new KnowledgeDatabase({ dbPath: path.join(temp, 'knowledge.lancedb') });
  try {
    const projects = {
      api: { displayName: 'API', enabled: true, knowledgeBackend: 'lancedb', primarySpaceId: 'project:api' },
      web: { displayName: 'Web', enabled: true, knowledgeBackend: 'lancedb', primarySpaceId: 'project:web' },
      secret: { displayName: 'Secret', enabled: true, knowledgeBackend: 'lancedb', primarySpaceId: 'project:secret' },
    };
    const scopes = new KnowledgeScopeRegistry({ filePath: path.join(temp, 'knowledge-scopes.json') });
    scopes.synchronizeProjects(projects);
    scopes.setProjectRelations(projects, 'api', ['web']);
    await db.replaceEntry('project:api', 'modules/auth.md', [{ chunkOrder: 0, title: '认证', chunkText: 'API 使用轮换刷新令牌。', vector: vectorAt(0), sourceCommit: 'aaa' }]);
    await db.replaceEntry('project:web', 'changes/web.md', [{ chunkOrder: 0, entryType: 'change', title: 'Web 登录', chunkText: 'Web 登录页会保存短期会话。', vector: vectorAt(0), sourceCommit: 'bbb' }]);
    await db.replaceEntry('project:secret', 'secret.md', [{ chunkOrder: 0, title: '机密', chunkText: '绝不能泄漏的独立项目内容。', vector: vectorAt(0), sourceCommit: 'ccc' }]);
    await db.ensureSearchIndexes();
    const service = new KnowledgeQueryService({ database: db, embedder: { embedQuery: async () => vectorAt(0) }, scopeRegistry: scopes, readProjects: () => projects });
    const search = await service.search({ projectSlug: 'api', query: '登录令牌', limit: 10 });
    assert.ok(search.results.some(row => row.space_id === 'project:api'));
    assert.ok(search.results.some(row => row.space_id === 'project:web'));
    assert.ok(search.results.every(row => row.space_id !== 'project:secret'));
    assert.ok(search.results.every(row => !Object.prototype.hasOwnProperty.call(row, 'vector')));
    const asked = await service.ask({ projectSlug: 'api', query: '登录令牌', limit: 5 });
    assert.match(asked.answer, /知识记录/);
    assert.ok(asked.citations.length > 0);
    const entry = await service.get({ projectSlug: 'api', entryId: 'changes/web.md', spaceId: 'project:web' });
    assert.equal(entry.chunks.length, 1);
    await assert.rejects(service.get({ projectSlug: 'api', entryId: 'secret.md', spaceId: 'project:secret' }), /outside/);
    const history = await service.history({ projectSlug: 'api' });
    assert.equal(history.results[0].entry_id, 'changes/web.md');
    console.log('knowledge-query-test: PASS');
  } finally {
    await db.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error);
  process.exit(1);
});
