const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { KnowledgeDatabase } = require('../lib/knowledge-db');
const { KnowledgeMigrationManager } = require('../lib/knowledge-migration');
const { EMBEDDING_DIMENSIONS } = require('../lib/knowledge-schema');
const { spawnServer } = require('./helpers/spawn-server');

const ROOT = path.resolve(__dirname, '..', '..');
const PORT = 7927;

async function request(method, route, body) {
  const response = await fetch(`http://127.0.0.1:${PORT}${route}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`${response.status}: ${JSON.stringify(data)}`);
  return data;
}

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try { await request('GET', '/api/projects'); return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('server did not start');
}

function fakeVector(text) {
  const vector = new Array(EMBEDDING_DIMENSIONS).fill(0);
  for (let i = 0; i < String(text).length; i++) vector[String(text).charCodeAt(i) % EMBEDDING_DIMENSIONS] += 1;
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map(value => value / norm);
}

(async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-migration-test-'));
  const db = new KnowledgeDatabase({ dbPath: path.join(temp, 'knowledge.lancedb') });
  try {
    const personalKb = path.join(temp, 'projects', 'api');
    const teamKb = path.join(temp, 'team-store', 'knowledge', 'shared');
    fs.mkdirSync(path.join(personalKb, 'modules'), { recursive: true });
    fs.mkdirSync(path.join(teamKb, 'changes'), { recursive: true });
    fs.writeFileSync(path.join(personalKb, 'GOAL.md'), '# API 目标\n\n提供稳定认证接口。\n', 'utf8');
    fs.writeFileSync(path.join(personalKb, 'modules', 'auth.md'), '# 认证\n\n刷新令牌可轮换。\n', 'utf8');
    fs.writeFileSync(path.join(teamKb, 'README.md'), '# 团队知识\n\n多项目共享约定。\n', 'utf8');
    fs.writeFileSync(path.join(teamKb, 'changes', 'abc.md'), '# 变更\n\n统一请求标识。\n', 'utf8');

    const projects = {
      api: { displayName: 'API', kbPath: personalKb, primarySpaceId: 'project:api', knowledgeBackend: 'markdown', headCommit: 'abc' },
      web: { displayName: 'Web', kbPath: teamKb, primarySpaceId: 'team:store:shared', knowledgeBackend: 'markdown', knowledgeMode: 'team', kbId: 'shared' },
    };
    const patches = {};
    const manager = new KnowledgeMigrationManager({
      dataDir: temp,
      database: db,
      embedder: { embedPassage: async text => fakeVector(text) },
      onProjectMigrated: async (slug, patch) => {
        patches[slug] = patch;
        Object.assign(projects[slug], patch);
      },
    });
    assert.equal(manager.inspect(projects).eligible, 2);
    const result = await manager.migrateAll(projects);
    assert.equal(result.status, 'completed');
    assert.equal(result.completed, 2);
    assert.equal(result.failed, 0);
    assert.equal(patches.api.knowledgeBackend, 'lancedb');
    assert.equal(patches.web.teamSyncTransport, 'markdown-v1');
    assert.equal(await db.count(['project:api']), 2);
    assert.equal(await db.count(['team:store:shared']), 2);
    assert.ok(fs.existsSync(path.join(result.projects.api.backupPath, 'migration-manifest.json')));
    assert.ok(fs.existsSync(path.join(personalKb, 'GOAL.md')), 'legacy Markdown must remain untouched');
    const second = await manager.migrateAll(projects);
    assert.equal(second.message, 'no legacy projects need migration');

    const runtime = spawnServer({ root: ROOT, port: PORT, tag: 'knowledge-migration-api', extraEnv: { KB_EMBEDDING_FAKE: '1' } });
    try {
      const apiKb = path.join(runtime.dataDir, 'projects', 'api');
      fs.mkdirSync(apiKb, { recursive: true });
      fs.writeFileSync(path.join(apiKb, 'GOAL.md'), '# API\n\n迁移接口测试。\n', 'utf8');
      fs.writeFileSync(path.join(runtime.dataDir, 'projects.json'), JSON.stringify({
        api: { displayName: 'API', kbPath: apiKb, localPath: temp, gitPath: temp, enabled: true },
      }, null, 2));
      await waitForServer();
      const before = await request('GET', '/api/knowledge/migration');
      assert.equal(before.eligible, 1);
      const started = await request('POST', '/api/knowledge/migration/start', {});
      assert.equal(started.started, true);
      let status;
      for (let i = 0; i < 100; i++) {
        status = await request('GET', '/api/knowledge/migration');
        if (!status.running && status.projects.api?.status === 'completed') break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      assert.equal(status.projects.api.status, 'completed');
      const savedProjects = await request('GET', '/api/projects');
      assert.equal(savedProjects.api.knowledgeBackend, 'lancedb');
      assert.equal(savedProjects.api.legacyKbPath, apiKb);
      const rolledBack = await request('POST', '/api/projects/api/knowledge-migration/rollback', {});
      assert.equal(rolledBack.knowledgeBackend, 'markdown');
      assert.equal(rolledBack.retainedDatabase, true);
    } finally {
      runtime.cleanup();
    }
    console.log('knowledge-migration-test: PASS');
  } finally {
    await db.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error);
  process.exit(1);
});
