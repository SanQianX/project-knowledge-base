// Run: node _site/_test/project-control-panel-task14-test.js
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { spawnServer } = require('./helpers/spawn-server');
const { makeRepo, git } = require('./fixtures/make-git-repos');

const ROOT = path.resolve(__dirname, '..', '..');
const SERVER = path.join(ROOT, '_site', 'server.js');
let PROJECTS_JSON; // assigned inside the IIFE after spawnServer
let DATA_DIR; // assigned inside the IIFE after spawnServer
const KNOWLEDGE_STORE_JSON = path.join(ROOT, 'knowledge-store.json');
const PORT = process.env.KB_TASK14_TEST_PORT || '7815';
const BASE_URL = `http://127.0.0.1:${PORT}`;
const TEMP_SLUG = 'task-014-temp';
const TEMP_ROOT = path.join(ROOT, '.tmp-task-014');

function assert(cond, msg) { if (!cond) throw new Error(msg); }
function backup(file) { return fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : null; }
function restore(file, content) {
  if (content == null) fs.rmSync(file, { force: true });
  else fs.writeFileSync(file, content, 'utf-8');
}

async function rmWithRetry(target) {
  for (let i = 0; i < 8; i++) {
    try {
      fs.rmSync(target, { recursive: true, force: true });
      return;
    } catch (e) {
      if (i === 7) throw e;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
}

async function waitForServer() {
  const deadline = Date.now() + 15000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE_URL}/api/state`);
      if (res.ok) return;
      lastError = new Error(`HTTP ${res.status}`);
    } catch (e) { lastError = e; }
    await new Promise(resolve => setTimeout(resolve, 250));
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

(async () => {
  const projectsBackup = backup(PROJECTS_JSON);
  const storeBackup = backup(KNOWLEDGE_STORE_JSON);
  fs.rmSync(TEMP_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEMP_ROOT, { recursive: true });
  let repo = null;
  let nonGit = null;

  const _spawned = spawnServer({ root: ROOT, port: Number(PORT), tag: 'project-control-panel-task14',  });
  DATA_DIR = _spawned.dataDir;
  PROJECTS_JSON = path.join(DATA_DIR, 'projects.json');
  const child = _spawned.child;
  let serverOutput = '';
  child.stdout.on('data', d => { serverOutput += d.toString(); });
  child.stderr.on('data', d => { serverOutput += d.toString(); });

  try {
    await waitForServer();

    const storeRoot = path.join(TEMP_ROOT, 'kb-store');
    let r = await json('PUT', '/api/knowledge-store/config', { rootPath: storeRoot });
    assert(r.res.ok, 'knowledge store config should save');

    repo = makeRepo({ kind: 'multi-commit' });
    r = await json('POST', '/api/projects/import-preflight', { localPath: repo.path });
    assert(r.res.ok, 'preflight existing git should succeed');
    assert(r.data.inspection.repoStatus === 'ok', 'existing git repo should be ok');
    assert(r.data.needsGitInit === false, 'existing git should not need init');

    nonGit = makeRepo({ kind: 'not-git' });
    r = await json('POST', '/api/projects/import-preflight', { localPath: nonGit.path });
    assert(r.res.ok, 'preflight non-git should return actionable result');
    assert(r.data.needsGitInit === true, 'non-git should need git init');

    r = await json('POST', '/api/projects/import-preflight', { localPath: path.join(TEMP_ROOT, 'missing') });
    assert(!r.res.ok, 'preflight missing path should fail');

    r = await json('POST', '/api/git/init', {
      path: nonGit.path,
      createInitialCommit: true,
      remoteUrl: 'https://example.invalid/task-014.git',
    });
    assert(r.res.ok, 'git init should succeed');
    assert(r.data.initialCommit === true, 'initial commit should be created');
    assert(r.data.remoteConfigured === true, 'remote should be configured');
    assert(git(nonGit.path, 'rev-parse --is-inside-work-tree') === 'true', 'non-git dir should now be git');
    assert(git(nonGit.path, 'remote get-url origin') === 'https://example.invalid/task-014.git', 'remote origin should be set');

    const firstCommit = repo.commits[0].hash;
    r = await json('PUT', '/api/projects', {
      slug: TEMP_SLUG,
      config: {
        displayName: 'TASK 014 Temp',
        localPath: repo.path,
        gitPath: repo.path,
        enabled: true,
        aiProfileId: 'claude-code-agent',
        goalStatus: 'accepted',
        lastAnalyzedCommit: firstCommit,
      },
    });
    assert(r.res.ok, 'project import should succeed');
    r = await json('POST', `/api/projects/${TEMP_SLUG}/init`);
    assert(r.res.ok, 'KB init should succeed');

    r = await json('POST', `/api/projects/${TEMP_SLUG}/knowledge-update`, {});
    assert(r.res.status === 404, 'manual knowledge-update/auto-apply endpoint should be removed');

    r = await json('GET', `/api/projects/${TEMP_SLUG}/scan`);
    assert(r.res.ok && r.data.pendingCount >= 1, 'read-only scanner should still report pending commits');

    r = await json('GET', '/api/projects');
    assert(r.data[TEMP_SLUG].lastAnalyzedCommit === firstCommit, 'read-only scan must not advance lastAnalyzedCommit');

    console.log('TASK-014 project control panel simplification test passed');
  } catch (e) {
    console.error('TASK-014 test failed:', e.message);
    if (serverOutput) console.error(serverOutput);
    process.exitCode = 1;
  } finally {
    child.kill();
    await new Promise(r => setTimeout(r, 500));
    try { if (repo && repo.cleanup) repo.cleanup(); } catch {}
    try { if (nonGit && nonGit.cleanup) nonGit.cleanup(); } catch {}
    restore(PROJECTS_JSON, projectsBackup);
    restore(KNOWLEDGE_STORE_JSON, storeBackup);
    await rmWithRetry(TEMP_ROOT);
  }
})();
