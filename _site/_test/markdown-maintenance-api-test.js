const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { spawnServer } = require('./helpers/spawn-server');

const ROOT = path.resolve(__dirname, '..', '..');
const PORT = 7932;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'index-maintenance-api-v2-'));
const DATA_DIR = path.join(TEMP, 'data');
const REPO = path.join(TEMP, 'repo');

function git(args) { return execFileSync('git', args, { cwd: REPO, encoding: 'utf8' }).trim(); }

async function json(method, route, body) {
  const response = await fetch(`${BASE_URL}${route}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(`${response.status}: ${JSON.stringify(data)}`);
  return data;
}

(async () => {
  fs.mkdirSync(REPO, { recursive: true });
  git(['init', '--initial-branch=main']);
  git(['config', 'user.name', 'Index Test']);
  git(['config', 'user.email', 'index@example.test']);
  fs.writeFileSync(path.join(REPO, 'README.md'), '# source\n', 'utf8');
  git(['add', '.']);
  git(['commit', '-m', 'baseline']);
  const spawned = spawnServer({ root: ROOT, port: PORT, dataDir: DATA_DIR, tag: 'index-maintenance-v2', extraEnv: { KB_EMBEDDING_FAKE: '1' } });
  try {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try { await json('GET', '/api/health'); break; } catch {
        if (attempt === 99) throw new Error('server did not start');
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    await json('PATCH', '/api/settings', { knowledge: { rootPath: path.join(TEMP, 'knowledge') } });
    const imported = await json('POST', '/api/projects/import', { projectId: 'maintenance-demo', localPath: REPO, displayName: 'Maintenance demo' });
    const kbPath = imported.config.knowledgePath;
    fs.mkdirSync(path.join(kbPath, 'modules'), { recursive: true });
    fs.writeFileSync(path.join(kbPath, 'GOAL.md'), '# Goal\n\nBuild reliable derived indexes.\n', 'utf8');
    fs.writeFileSync(path.join(kbPath, 'modules', 'core.md'), '# Core\n\nSingle writer atomic rebuild content.\n', 'utf8');
    const markdownBefore = fs.readFileSync(path.join(kbPath, 'modules', 'core.md'), 'utf8');

    const before = await json('GET', '/api/knowledge/maintenance');
    assert.strictEqual(before.indexPath, path.join(DATA_DIR, 'index', 'knowledge.lancedb'));
    const rebuilt = await json('POST', '/api/knowledge/maintenance/rebuild', {});
    assert(rebuilt.ok && rebuilt.validation.ok, JSON.stringify(rebuilt));
    assert(fs.existsSync(before.indexPath));
    assert.strictEqual(fs.readFileSync(path.join(kbPath, 'modules', 'core.md'), 'utf8'), markdownBefore, 'index maintenance must not rewrite authoritative Markdown');
    let search = await json('POST', '/api/knowledge/search', { projectId: 'maintenance-demo', query: 'atomic rebuild', limit: 5 });
    assert.strictEqual(search.source, 'derived-index');
    assert(search.results.some(item => item.entry_id === 'modules/core.md'));

    fs.writeFileSync(path.join(kbPath, 'modules', 'core.md'), `${markdownBefore}\nSecond rebuild evidence.\n`, 'utf8');
    const second = await json('POST', '/api/knowledge/maintenance/rebuild', {});
    assert(second.ok && second.backup && fs.existsSync(second.backup), 'replacing a live index should retain the previous index under recovery');
    search = await json('POST', '/api/knowledge/search', { projectId: 'maintenance-demo', query: 'Second rebuild evidence', limit: 5 });
    assert(search.results.some(item => /Second rebuild evidence/.test(item.chunk_text)));
    const after = await json('GET', '/api/knowledge/maintenance');
    assert(after.projects.every(project => project.index.dirty === false));
    console.log('markdown-maintenance-api-test: PASS');
  } finally {
    spawned.child.kill();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
