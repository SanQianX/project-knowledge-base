const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnServer, defaultDataDir } = require('./helpers/spawn-server');

const ROOT = path.resolve(__dirname, '..', '..');
const PORT = 7931;

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
  for (let i = 0; i < 80; i++) {
    try { await request('GET', '/api/projects'); return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('server did not start');
}

(async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'markdown-maintenance-api-'));
  const dataDir = defaultDataDir('markdown-maintenance-api');
  const knowledgeRoot = path.join(temp, 'knowledge');
  const kbPath = path.join(knowledgeRoot, 'demo');
  fs.mkdirSync(path.join(kbPath, 'modules'), { recursive: true });
  fs.mkdirSync(path.join(kbPath, 'changes'), { recursive: true });
  fs.writeFileSync(path.join(kbPath, 'README.md'), '# Demo\n', 'utf8');
  fs.writeFileSync(path.join(kbPath, 'GOAL.md'), '# Goal\n', 'utf8');
  fs.writeFileSync(path.join(kbPath, 'ARCHITECTURE.md'), '# Architecture\n', 'utf8');
  fs.writeFileSync(path.join(kbPath, 'modules', 'core.md'), '---\ntitle: Core\n---\n# Core\n', 'utf8');
  fs.writeFileSync(path.join(kbPath, 'modules', '00-index.md'), '# Old\n\nTags: all, old, tags\n', 'utf8');
  fs.writeFileSync(path.join(kbPath, 'changes', '00-index.md'), '# Old\n', 'utf8');
  fs.writeFileSync(path.join(dataDir, 'projects.json'), JSON.stringify({
    demo: { displayName: 'Demo', kbPath, enabled: true, knowledgeBackend: 'lancedb', primarySpaceId: 'project:demo' },
  }, null, 2));
  fs.writeFileSync(path.join(dataDir, 'knowledge-store.json'), JSON.stringify({
    schema: 'knowledge-store/v1', rootPath: knowledgeRoot, configured: true, git: { enabled: false },
  }, null, 2));

  const runtime = spawnServer({ root: ROOT, port: PORT, dataDir, tag: 'markdown-maintenance-api', extraEnv: { KB_EMBEDDING_FAKE: '1' } });
  try {
    await waitForServer();
    const before = await request('GET', '/api/knowledge/markdown-maintenance');
    assert.equal(before.summary.projects, 1);
    assert(before.summary.fixable >= 2, 'API audit should expose stale indexes');
    assert.equal(before.backupRoot, path.join(knowledgeRoot, '.project-knowledge', '_backup', 'markdown-maintenance'));

    const started = await request('POST', '/api/knowledge/markdown-maintenance/optimize', {});
    assert.equal(started.started, true);
    let after;
    for (let i = 0; i < 100; i++) {
      after = await request('GET', '/api/knowledge/markdown-maintenance');
      if (!after.running) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(after.lastRun.status, 'completed');
    assert.equal(after.summary.fixable, 0);
    assert.equal(after.lastRun.projects.demo.vectorIndexes[0].status, 'succeeded', 'optimized migrated projects should refresh their vector space');
    assert(!/^Tags:/m.test(fs.readFileSync(path.join(kbPath, 'modules', '00-index.md'), 'utf8')));
    assert(fs.existsSync(after.lastRun.projects.demo.backupDir), 'backup directory should be retained under the configured knowledge root');
    const search = await request('POST', '/api/knowledge/search', { projectSlug: 'demo', query: 'Core', limit: 3 });
    assert(search.results.some(item => item.entry_id === 'modules/core.md'), 'refreshed vector database should return optimized Markdown content');
    console.log('markdown-maintenance-api-test: PASS');
  } finally {
    runtime.cleanup();
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error);
  process.exit(1);
});
