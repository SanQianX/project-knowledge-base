const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { KnowledgeDatabase, sqlString, inPredicate } = require('../lib/knowledge-db');
const { LocalEmbeddingService, QUERY_PREFIX } = require('../lib/embedding-service');
const { EMBEDDING_DIMENSIONS, sha256 } = require('../lib/knowledge-schema');
const { MarkdownKnowledgeIndexer, chunkMarkdown } = require('../lib/markdown-knowledge-indexer');

function vectorAt(index) {
  const vector = new Array(EMBEDDING_DIMENSIONS).fill(0);
  vector[index] = 1;
  return vector;
}

(async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-db-test-'));
  const db = new KnowledgeDatabase({ dbPath: path.join(temp, 'knowledge.lancedb') });
  try {
    assert.equal(sqlString("space'o"), "'space''o'");
    assert.equal(inPredicate('space_id', ['a', 'a', 'b']), "space_id IN ('a', 'b')");
    assert.throws(() => inPredicate('space_id', []), /must not be empty/);

    const created = await db.replaceEntry('personal:alpha', 'modules/auth.md', [
      {
        chunkOrder: 0,
        title: '登录设计',
        chunkText: '系统使用短期访问令牌和可轮换刷新令牌。',
        vector: vectorAt(0),
        tags: ['auth'],
        sourcePaths: ['src/auth.js'],
        sourceCommit: 'abc123',
      },
      {
        chunkOrder: 1,
        title: '登录设计',
        chunkText: '退出登录会撤销刷新令牌。',
        vector: vectorAt(1),
        sourceCommit: 'abc123',
      },
    ]);
    assert.equal(created.action, 'created');
    assert.equal(await db.count(), 2);

    const same = await db.replaceEntry('personal:alpha', 'modules/auth.md', [
      { chunkOrder: 0, title: '登录设计', chunkText: '系统使用短期访问令牌和可轮换刷新令牌。', vector: vectorAt(0), tags: ['auth'], sourcePaths: ['src/auth.js'], sourceCommit: 'abc123' },
      { chunkOrder: 1, title: '登录设计', chunkText: '退出登录会撤销刷新令牌。', vector: vectorAt(1), sourceCommit: 'abc123' },
    ]);
    assert.equal(same.action, 'unchanged');

    const updated = await db.replaceEntry('personal:alpha', 'modules/auth.md', [
      { chunkOrder: 0, title: '登录设计', chunkText: '系统使用短期访问令牌。', vector: vectorAt(0), sourceCommit: 'def456' },
    ]);
    assert.equal(updated.action, 'updated');
    assert.equal(updated.deleted, 1);
    assert.equal(await db.count(), 1);

    await db.replaceEntry('personal:beta', 'GOAL.md', [
      { chunkOrder: 0, title: '目标', chunkText: '支付服务负责对账。', vector: vectorAt(1), sourceCommit: '999999' },
    ]);
    assert.equal(await db.count(['personal:alpha']), 1);
    const scoped = await db.vectorSearch(vectorAt(0), { spaceIds: ['personal:alpha'], limit: 5 });
    assert.equal(scoped.length, 1);
    assert.equal(scoped[0].space_id, 'personal:alpha');
    assert.deepEqual(scoped[0].tags, []);
    assert.equal(scoped[0].content_hash, sha256('系统使用短期访问令牌。'));

    const initialIndexes = await db.ensureSearchIndexes();
    assert.equal(initialIndexes.ftsSchemaVersion, 2);
    assert.equal(initialIndexes.ftsUpgradeRequired, false);
    assert.equal(db.maintenanceState().ftsSchemaVersion, 2);
    db.saveMaintenanceState({ ftsSchemaVersion: 0, ftsUpgradeRequired: false });
    const legacyIndexes = await db.ensureSearchIndexes();
    assert.equal(legacyIndexes.ftsSchemaVersion, 1, 'an existing unversioned FTS index should be treated as v4.0.0');
    assert.equal(legacyIndexes.ftsUpgradeRequired, true, 'legacy FTS should wait for atomic rebuild instead of rebuilding in place');
    assert.equal((await db.maybeOptimize({ force: true })).blockedBy, 'fts-upgrade-required', 'legacy FTS must not be expanded by in-place optimization');
    db.saveMaintenanceState({ ftsSchemaVersion: 2, ftsUpgradeRequired: false });
    const keyword = await db.fullTextSearch('短期访问令牌', { spaceIds: ['personal:alpha'], limit: 5 });
    assert.equal(keyword.length, 1);
    const hybrid = await db.hybridSearch({ text: '短期访问令牌', vector: vectorAt(0), spaceIds: ['personal:alpha'], limit: 5 });
    assert.equal(hybrid.length, 1);
    assert.deepEqual(hybrid[0].match_channels.sort(), ['keyword', 'semantic']);

    assert.equal((await db.deleteEntry('personal:alpha', 'modules/auth.md')).deleted, 1);
    assert.equal((await db.deleteSpace('personal:beta')).deleted, 1);
    assert.equal(await db.count(), 0);

    let seenInput = null;
    let seenOptions = null;
    const embeddings = new LocalEmbeddingService({
      remoteHost: 'https://models.example.test/',
      pipelineFactory: async (task, model, options) => {
        assert.equal(task, 'feature-extraction');
        assert.equal(model, 'Xenova/bge-small-zh-v1.5');
        assert.equal(options.dtype, 'fp32');
        return async (input, embedOptions) => {
          seenInput = input;
          seenOptions = embedOptions;
          return { data: Float32Array.from(vectorAt(2)) };
        };
      },
    });
    const embedded = await embeddings.embedQuery('登录怎么做');
    assert.equal(embedded.length, EMBEDDING_DIMENSIONS);
    assert.equal(seenInput, `${QUERY_PREFIX}登录怎么做`);
    assert.deepEqual(seenOptions, { pooling: 'cls', normalize: true });
    assert.equal(embeddings.status().loaded, true);
    assert.equal(embeddings.status().remoteHost, 'https://models.example.test/');

    const sections = chunkMarkdown('# 标题\n\n第一段。\n\n## 细节\n\n第二段。', { maxChars: 20, overlapChars: 2 });
    assert.ok(sections.length >= 2);
    assert.deepEqual(sections.at(-1).headingPath, ['标题', '细节']);

    const markdownRoot = path.join(temp, 'legacy-markdown');
    fs.mkdirSync(path.join(markdownRoot, 'modules'), { recursive: true });
    fs.writeFileSync(path.join(markdownRoot, 'GOAL.md'), '# 项目目标\n\n建立可靠的支付知识库。\n', 'utf8');
    fs.writeFileSync(path.join(markdownRoot, 'modules', 'pay.md'), '# 支付模块\n\n对账任务每天运行。\n', 'utf8');
    fs.writeFileSync(path.join(markdownRoot, 'modules', '00-index.md'), '# Modules Index\n\nTags: duplicated, derived\n', 'utf8');
    const deterministicEmbedder = {
      embedPassage: async text => text.includes('对账') ? vectorAt(3) : vectorAt(4),
    };
    const indexer = new MarkdownKnowledgeIndexer({ database: db, embedder: deterministicEmbedder });
    await db.replaceEntry('personal:migrated', 'modules/00-index.md', [
      { chunkOrder: 0, title: 'Legacy index', chunkText: 'duplicated derived tags', vector: vectorAt(5) },
    ]);
    const firstIndex = await indexer.indexDirectory({ kbPath: markdownRoot, spaceId: 'personal:migrated', sourceProjectId: 'pay' });
    assert.equal(firstIndex.files, 2);
    assert.equal(firstIndex.indexed, 2);
    assert.equal(firstIndex.deletedEntries, 1, 'previously indexed derived files should be removed as stale');
    assert(!firstIndex.results.some(item => item.entryId.endsWith('00-index.md')), 'derived indexes must not be embedded');
    assert.equal(firstIndex.maintenance.optimized, false, 'small updates must not optimize on every commit');
    const secondIndex = await indexer.indexDirectory({ kbPath: markdownRoot, spaceId: 'personal:migrated', sourceProjectId: 'pay' });
    assert.equal(secondIndex.unchanged, 2);
    db.optimizeOperationsThreshold = 1;
    fs.unlinkSync(path.join(markdownRoot, 'GOAL.md'));
    const thirdIndex = await indexer.indexDirectory({ kbPath: markdownRoot, spaceId: 'personal:migrated', sourceProjectId: 'pay' });
    assert.equal(thirdIndex.deletedEntries, 1);
    assert.equal(thirdIndex.maintenance.optimized, true, 'maintenance should run after the configured mutation threshold');
    assert.equal(db.maintenanceState().pendingOperations, 0);
    assert.deepEqual(await db.entryIds('personal:migrated'), ['modules/pay.md']);

    console.log('knowledge-db-test: PASS');
  } finally {
    await db.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error);
  process.exit(1);
});
