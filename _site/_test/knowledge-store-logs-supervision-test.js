// Run: node _site/_test/knowledge-store-logs-supervision-test.js
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { spawnServer } = require('./helpers/spawn-server');
const { makeRepo } = require('./fixtures/make-git-repos');

const ROOT = path.resolve(__dirname, '..', '..');
const SERVER = path.join(ROOT, '_site', 'server.js');
let PROJECTS_JSON; // assigned inside the IIFE after spawnServer
let DATA_DIR; // assigned inside the IIFE after spawnServer
const KNOWLEDGE_STORE_JSON = path.join(ROOT, 'knowledge-store.json');
const LOGGING_JSON = path.join(ROOT, 'logging.json');
const PORT = process.env.KB_TASK_012_013_TEST_PORT || '7814';
const BASE_URL = `http://127.0.0.1:${PORT}`;
const TEMP_SLUG = 'task-012-013-temp';
const TEMP_ROOT = path.join(ROOT, '.tmp-task-012-013');

function assert(cond, msg) { if (!cond) throw new Error(msg); }

function backup(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : null;
}

function restore(file, content) {
  if (content == null) fs.rmSync(file, { force: true });
  else fs.writeFileSync(file, content, 'utf-8');
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
  const loggingBackup = backup(LOGGING_JSON);
  fs.rmSync(TEMP_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEMP_ROOT, { recursive: true });

  const _spawned = spawnServer({ root: ROOT, port: Number(PORT), tag: 'knowledge-store-logs-supervision',  });
  DATA_DIR = _spawned.dataDir;
  PROJECTS_JSON = path.join(DATA_DIR, 'projects.json');
  const child = _spawned.child;

  let serverOutput = '';
  let repo = null;
  child.stdout.on('data', d => { serverOutput += d.toString(); });
  child.stderr.on('data', d => { serverOutput += d.toString(); });

  try {
    await waitForServer();

    const storeRoot = path.join(TEMP_ROOT, 'kb-store');
    let r = await json('PUT', '/api/knowledge-store/config', {
      rootPath: storeRoot,
      git: { enabled: true, remoteUrl: 'https://example.invalid/kb.git', branch: 'main' },
    });
    assert(r.res.ok, 'knowledge store config save should succeed');
    assert(r.data.config.rootPath === path.resolve(storeRoot), 'knowledge store root should persist');

    repo = makeRepo({ kind: 'multi-commit' });
    r = await json('PUT', '/api/projects', {
      slug: TEMP_SLUG,
      config: {
        displayName: 'TASK 012 013 Temp',
        localPath: repo.path,
        gitPath: repo.path,
        enabled: true,
      },
    });
    assert(r.res.ok, 'project import should succeed');

    r = await json('GET', '/api/projects');
    assert(r.data[TEMP_SLUG].kbPath === path.join(storeRoot, TEMP_SLUG), 'new project should use configured knowledge store root');

    r = await json('POST', `/api/projects/${TEMP_SLUG}/init`);
    assert(r.res.ok, 'project init should succeed');
    assert(fs.existsSync(path.join(storeRoot, TEMP_SLUG, 'README.md')), 'KB README should be created in external store');

    const logRoot = path.join(TEMP_ROOT, 'logs');
    r = await json('PUT', '/api/logging/config', {
      rootPath: logRoot,
      retentionDays: 7,
      levels: ['info', 'warn', 'error'],
    });
    assert(r.res.ok, 'logging config save should succeed');
    assert(fs.readdirSync(logRoot).some(file => file.endsWith('.log')), 'logging config update should write a daily .log file');

    r = await json('GET', '/api/logs?level=info&q=logging_config_updated');
    assert(r.res.ok, 'log query should succeed');
    assert((r.data.logs || []).some(log => log.event === 'logging_config_updated'), 'log query should find logging_config_updated');

    r = await json('GET', '/api/supervision/pending-commits');
    assert(r.res.ok, 'pending commits endpoint should succeed');
    const pendingItem = (r.data.items || []).find(item => item.slug === TEMP_SLUG);
    assert(pendingItem, 'pending commits should include temp project');
    assert(pendingItem.pendingCount === 0, 'pre-import history should not be pending after tracking start');

    r = await json('GET', '/api/supervision/issues');
    assert(r.res.ok, 'issues endpoint should succeed');
    assert(Array.isArray(r.data.issues), 'issues should be an array');

    r = await json('POST', '/api/knowledge-store/migrate', { execute: false });
    assert(r.res.ok, 'migration preview should succeed');
    assert(Array.isArray(r.data.plan), 'migration preview should return plan');

    console.log('TASK-012/TASK-013 knowledge store, logs, supervision test passed');
  } catch (e) {
    console.error('TASK-012/TASK-013 test failed:', e.message);
    if (serverOutput) console.error(serverOutput);
    process.exitCode = 1;
  } finally {
    child.kill();
    try { if (typeof repo !== 'undefined' && repo.cleanup) repo.cleanup(); } catch {}
    restore(PROJECTS_JSON, projectsBackup);
    restore(KNOWLEDGE_STORE_JSON, storeBackup);
    restore(LOGGING_JSON, loggingBackup);
    fs.rmSync(TEMP_ROOT, { recursive: true, force: true });
  }
})();
