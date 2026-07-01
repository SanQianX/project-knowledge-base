// TASK-002: Git import validation test
// Run: node _site/_test/git-validation-test.js
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { spawnServer } = require('./helpers/spawn-server');
const { makeRepo } = require('./fixtures/make-git-repos');

const ROOT = path.resolve(__dirname, '..', '..');
const SERVER = path.join(ROOT, '_site', 'server.js');
// Pre-create a temp data dir and seed it BEFORE requiring any lib modules
// that capture getDataDir() at module load. Both the test process and
// the spawned server will use this dir.
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), `kb-data-git-validation-${process.pid}-`));
process.env.KB_DATA_DIR = DATA_DIR;
require('../lib/data-dir')._resetCache();
fs.writeFileSync(path.join(DATA_DIR, 'projects.json'), '{}\n', 'utf-8');
try { fs.copyFileSync(path.join(ROOT, 'claude-prompts.json'), path.join(DATA_DIR, 'claude-prompts.json')); } catch {}

let PROJECTS_JSON = path.join(DATA_DIR, 'projects.json');
const PORT = process.env.KB_GIT_TEST_PORT || '7792';
const BASE_URL = `http://127.0.0.1:${PORT}`;
const TEMP_SLUG = 'task-002-temp';

function assert(cond, msg) { if (!cond) throw new Error(msg); }

async function waitForServer() {
  const deadline = Date.now() + 15000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE_URL}/api/state`);
      if (res.ok) return;
      lastError = new Error(`HTTP ${res.status}`);
    } catch (e) { lastError = e; }
    await new Promise(r => setTimeout(r, 250));
  }
  throw lastError || new Error('server did not start');
}

async function json(method, url, body) {
  const res = await fetch(`${BASE_URL}${url}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = {};
  if (text) { try { data = JSON.parse(text); } catch { data = { raw: text }; } }
  return { res, data };
}

async function upsertProject(slug, config) {
  const r = await json('PUT', '/api/projects', { slug, config });
  assert(r.res.ok, `upsert failed: ${JSON.stringify(r.data)}`);
  return r.data;
}

async function removeTemp() {
  const cur = JSON.parse(fs.readFileSync(PROJECTS_JSON, 'utf-8'));
  if (cur[TEMP_SLUG]) {
    delete cur[TEMP_SLUG];
    fs.writeFileSync(PROJECTS_JSON, JSON.stringify(cur, null, 2) + '\n', 'utf-8');
  }
}

(async () => {
  // 1. Static checks

  const _spawned = spawnServer({ root: ROOT, port: Number(PORT), dataDir: DATA_DIR, tag: 'git-validation', });
  const child = _spawned.child;
  let serverOutput = '';
  child.stdout.on('data', d => { serverOutput += d.toString(); });
  child.stderr.on('data', d => { serverOutput += d.toString(); });

  const fixtures = [];
  try {
    await waitForServer();

    // 2. Bad slug returns 400
    const bad = await json('POST', '/api/projects/INVALID..SLUG!/validate-git');
    assert(!bad.res.ok, 'bad slug should not succeed');
    assert(bad.res.status === 400, `bad slug should return 400, got ${bad.res.status}`);

    // 3. One-commit repo → repoStatus=ok
    const okRepo = makeRepo({ kind: 'one-commit' });
    fixtures.push(okRepo);
    await upsertProject(TEMP_SLUG, {
      displayName: 'TASK-002 OK',
      localPath: okRepo.path,
      gitPath: okRepo.path,
    });
    let r = await json('GET', '/api/projects');
    let cfg = r.data[TEMP_SLUG];
    assert(cfg.repoStatus === 'ok', `one-commit should be ok, got ${cfg.repoStatus}`);
    assert(cfg.headCommit && cfg.headCommit.length >= 7, 'headCommit should be set');
    assert(cfg.currentBranch === 'main', `currentBranch should be main, got ${cfg.currentBranch}`);

    // validate-git endpoint
    r = await json('POST', `/api/projects/${TEMP_SLUG}/validate-git`);
    assert(r.res.ok, 'validate-git should succeed');
    assert(r.data.repoStatus === 'ok', `validate-git should report ok, got ${r.data.repoStatus}`);

    // git-status read-only endpoint
    r = await json('GET', `/api/projects/${TEMP_SLUG}/git-status`);
    assert(r.res.ok, 'git-status should return 200');
    assert(r.data.repoStatus === 'ok', 'git-status should report ok');

    // 4. Not-git folder → repoStatus=not-git
    const notGit = makeRepo({ kind: 'not-git' });
    fixtures.push(notGit);
    await upsertProject(TEMP_SLUG, {
      displayName: 'TASK-002 NotGit',
      localPath: notGit.path,
      gitPath: notGit.path,
    });
    r = await json('GET', `/api/projects/${TEMP_SLUG}/git-status`);
    assert(r.res.ok, 'git-status should return 200 for not-git');
    assert(r.data.repoStatus === 'not-git', `not-git folder should report not-git, got ${r.data.repoStatus}`);

    // 5. Missing path → repoStatus=missing-path
    const missing = 'D:\\__no_such_path__\\__no_such_repo__';
    await upsertProject(TEMP_SLUG, {
      displayName: 'TASK-002 Missing',
      localPath: missing,
      gitPath: missing,
    });
    r = await json('GET', `/api/projects/${TEMP_SLUG}/git-status`);
    assert(r.res.ok, 'git-status should return 200 for missing');
    assert(r.data.repoStatus === 'missing-path', `missing should report missing-path, got ${r.data.repoStatus}`);

    // 6. Empty Git repo → repoStatus=empty
    const empty = makeRepo({ kind: 'empty' });
    fixtures.push(empty);
    await upsertProject(TEMP_SLUG, {
      displayName: 'TASK-002 Empty',
      localPath: empty.path,
      gitPath: empty.path,
    });
    r = await json('GET', `/api/projects/${TEMP_SLUG}/git-status`);
    assert(r.res.ok, 'git-status should return 200 for empty');
    assert(r.data.repoStatus === 'empty', `empty should report empty, got ${r.data.repoStatus}`);
    assert(r.data.headCommit === null, 'empty repo should have no headCommit');

    // 7. Nonexistent slug for validate-git
    r = await json('POST', '/api/projects/nonexistent-12345/validate-git');
    assert(!r.res.ok, 'nonexistent slug should fail');
    assert(r.res.status === 404, 'nonexistent slug should return 404');

    // 8. Persisted state visible in /api/state
    await upsertProject(TEMP_SLUG, {
      displayName: 'TASK-002 OK',
      localPath: okRepo.path,
      gitPath: okRepo.path,
    });
    r = await json('POST', `/api/projects/${TEMP_SLUG}/validate-git`);
    r = await json('GET', '/api/state');
    cfg = r.data.projects[TEMP_SLUG];
    assert(cfg.repoStatus === 'ok', 'persisted repoStatus should be ok');
    assert(cfg.headCommit && cfg.headCommit.length >= 7, 'persisted headCommit should be set');
    assert(cfg.currentBranch === 'main', 'persisted currentBranch should be main');

    console.log('TASK-002 git validation test passed');
  } catch (e) {
    console.error('TASK-002 git validation test failed:', e.message);
    if (serverOutput) console.error(serverOutput);
    process.exitCode = 1;
  } finally {
    for (const f of fixtures) {
      try { f.cleanup(); } catch {}
    }
    await removeTemp().catch(() => {});
    child.kill();
  }
})();
