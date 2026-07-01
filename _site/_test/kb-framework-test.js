// Final minimal KB framework test.
// Run: node _site/_test/kb-framework-test.js
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { spawnServer } = require('./helpers/spawn-server');

const ROOT = path.resolve(__dirname, '..', '..');
const SERVER = path.join(ROOT, '_site', 'server.js');
let PROJECTS_JSON; // assigned inside the IIFE after spawnServer
let DATA_DIR; // assigned inside the IIFE after spawnServer
const PORT = process.env.KB_FRAMEWORK_TEST_PORT || '7793';
const BASE_URL = `http://127.0.0.1:${PORT}`;
const TEMP_SLUG = 'task-021-temp';
const LEGACY_SLUG = 'task-021-legacy';

const REQUIRED_TOP_LEVEL = ['ARCHITECTURE.md', 'GOAL.md', 'README.md', 'changes', 'modules'];
const REQUIRED_FILES = ['README.md', 'GOAL.md', 'ARCHITECTURE.md', 'modules/00-index.md', 'changes/00-index.md'];
const REMOVED_ITEMS = [
  '_ai', 'kb-manifest.json', 'project-goal.md', 'project-analysis.md', 'framework.md',
  'architecture', 'commits', 'features', 'operations', 'quality', 'requirements', 'references',
];

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

function cleanupProject(slug) {
  const cur = JSON.parse(fs.readFileSync(PROJECTS_JSON, 'utf-8'));
  const base = cur[slug] && cur[slug].kbPath || path.join(DATA_DIR, 'projects', slug);
  fs.rmSync(base, { recursive: true, force: true });
  fs.rmSync(path.join(DATA_DIR, '_ai', slug), { recursive: true, force: true });
  if (cur[slug]) {
    delete cur[slug];
    fs.writeFileSync(PROJECTS_JSON, JSON.stringify(cur, null, 2) + '\n', 'utf-8');
  }
}

(async () => {

  const _spawned = spawnServer({ root: ROOT, port: Number(PORT), tag: 'kb-framework',  });
  DATA_DIR = _spawned.dataDir;
  PROJECTS_JSON = path.join(DATA_DIR, 'projects.json');
  const child = _spawned.child;
  let serverOutput = '';
  child.stdout.on('data', d => { serverOutput += d.toString(); });
  child.stderr.on('data', d => { serverOutput += d.toString(); });

  try {
    cleanupProject(TEMP_SLUG);
    cleanupProject(LEGACY_SLUG);
    await waitForServer();

    let r = await json('PUT', '/api/projects', {
      slug: TEMP_SLUG,
      config: {
        displayName: 'TASK-021 Temp',
        localPath: ROOT,
        gitPath: ROOT,
      },
    });
    assert(r.res.ok, 'upsert should succeed');

    r = await json('POST', `/api/projects/${TEMP_SLUG}/init`);
    assert(r.res.ok, 'init should succeed');
    assert(r.data.kbSchemaVersion === 'minimal', `init should set schema minimal, got ${r.data.kbSchemaVersion}`);

    const savedProjects = JSON.parse(fs.readFileSync(PROJECTS_JSON, 'utf-8'));
    const base = savedProjects[TEMP_SLUG].kbPath;
    const topLevel = fs.readdirSync(base).filter(name => !name.startsWith('.')).sort();
    assert(JSON.stringify(topLevel) === JSON.stringify(REQUIRED_TOP_LEVEL), `top-level mismatch: ${topLevel.join(', ')}`);
    for (const rel of REQUIRED_FILES) {
      assert(fs.existsSync(path.join(base, rel)), `missing framework file: ${rel}`);
    }
    for (const rel of REMOVED_ITEMS) {
      assert(!fs.existsSync(path.join(base, rel)), `old framework item should not exist after init: ${rel}`);
    }
    assert(fs.existsSync(path.join(DATA_DIR, '_ai', TEMP_SLUG)), 'AI workspace should exist outside the KB');

    const before = fs.readFileSync(path.join(base, 'GOAL.md'), 'utf-8');
    r = await json('POST', `/api/projects/${TEMP_SLUG}/init`);
    assert(r.res.ok, 're-init should succeed');
    assert(fs.readFileSync(path.join(base, 'GOAL.md'), 'utf-8') === before, 're-init should not rewrite GOAL.md');

    const legacyBase = path.join(DATA_DIR, 'projects', LEGACY_SLUG);
    fs.mkdirSync(path.join(legacyBase, '_ai', 'runs'), { recursive: true });
    fs.mkdirSync(path.join(legacyBase, 'commits'), { recursive: true });
    fs.mkdirSync(path.join(legacyBase, 'features'), { recursive: true });
    fs.writeFileSync(path.join(legacyBase, 'README.md'), 'legacy readme\n');
    fs.writeFileSync(path.join(legacyBase, 'project-goal.md'), '# Legacy goal\n');
    fs.writeFileSync(path.join(legacyBase, 'project-analysis.md'), '# Legacy analysis\n');
    fs.writeFileSync(path.join(legacyBase, 'kb-manifest.json'), '{}\n');
    fs.writeFileSync(path.join(legacyBase, 'commits', 'old.md'), '# Old commit\n');
    fs.writeFileSync(path.join(legacyBase, '_ai', 'runs', 'old.json'), '{"runId":"old"}\n');

    r = await json('PUT', '/api/projects', {
      slug: LEGACY_SLUG,
      config: { displayName: 'legacy', localPath: ROOT, gitPath: ROOT, kbPath: legacyBase, kbSchemaVersion: 'legacy' },
    });
    assert(r.res.ok, 'legacy upsert should succeed');

    r = await json('POST', `/api/projects/${LEGACY_SLUG}/migrate-framework`);
    assert(r.res.ok, `migrate-framework should succeed: ${JSON.stringify(r.data)}`);
    assert(r.data.kbSchemaVersion === 'minimal', 'migration should report minimal schema');
    for (const rel of REMOVED_ITEMS) {
      assert(!fs.existsSync(path.join(legacyBase, rel)), `migration should remove old item: ${rel}`);
    }
    assert(fs.existsSync(path.join(legacyBase, 'GOAL.md')), 'migration should create GOAL.md');
    assert(fs.existsSync(path.join(legacyBase, 'ARCHITECTURE.md')), 'migration should create ARCHITECTURE.md');
    assert(fs.existsSync(path.join(legacyBase, 'changes', 'legacy-change-01.md')), 'migration should consolidate legacy commits');
    assert(fs.existsSync(path.join(DATA_DIR, '_ai', LEGACY_SLUG, 'runs', 'old.json')), 'migration should move AI runs outside the KB');

    r = await json('POST', '/api/projects/INVALID../migrate-framework');
    assert(!r.res.ok && r.res.status === 400, 'migrate-framework bad slug should 400');

    console.log('Final KB framework test passed');
  } catch (e) {
    console.error('Final KB framework test failed:', e.message);
    if (serverOutput) console.error(serverOutput);
    process.exitCode = 1;
  } finally {
    cleanupProject(TEMP_SLUG);
    cleanupProject(LEGACY_SLUG);
    child.kill();
  }
})();
