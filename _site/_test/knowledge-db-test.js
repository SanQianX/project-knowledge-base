const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { KnowledgeDatabase, sqlString, inPredicate } = require('../lib/knowledge-db');
const { LocalEmbeddingService, QUERY_PREFIX } = require('../lib/embedding-service');
const { EMBEDDING_DIMENSIONS, sha256 } = require('../lib/knowledge-schema');

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

    assert.equal((await db.deleteEntry('personal:alpha', 'modules/auth.md')).deleted, 1);
    assert.equal((await db.deleteSpace('personal:beta')).deleted, 1);
    assert.equal(await db.count(), 0);

    let seenInput = null;
    let seenOptions = null;
    const embeddings = new LocalEmbeddingService({
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

    console.log('knowledge-db-test: PASS');
  } finally {
    await db.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error);
  process.exit(1);
});
