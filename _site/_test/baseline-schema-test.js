// Baseline TASK-001 test: project schema normalization and API smoke checks.
// Run from repository root: node _site/_test/baseline-schema-test.js
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { spawnServer } = require('./helpers/spawn-server');

const ROOT = path.resolve(__dirname, '..', '..');
const SERVER = path.join(ROOT, '_site', 'server.js');
// Pre-create a temp data dir and seed it BEFORE requiring any lib modules
// that capture getDataDir() at module load. Both the test process and
// the spawned server will use this dir.
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), `kb-data-baseline-schema-${process.pid}-`));
process.env.KB_DATA_DIR = DATA_DIR;
require('../lib/data-dir')._resetCache();
fs.writeFileSync(path.join(DATA_DIR, 'projects.json'), '{}\n', 'utf-8');
try { fs.copyFileSync(path.join(ROOT, 'claude-prompts.json'), path.join(DATA_DIR, 'claude-prompts.json')); } catch {}

let PROJECTS_JSON = path.join(DATA_DIR, 'projects.json');
const PORT = process.env.KB_BASELINE_TEST_PORT || '7791';
const BASE_URL = `http://127.0.0.1:${PORT}`;
const TEMP_SLUG = 'task-001-temp';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitForServer() {
  const deadline = Date.now() + 15000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE_URL}/api/state`);
      if (res.ok) return;
      lastError = new Error(`HTTP ${res.status}`);
    } catch (e) {
      lastError = e;
    }
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
  if (text) {
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
  }
  return { res, data };
}

async function removeTempProject() {
  const current = JSON.parse(fs.readFileSync(PROJECTS_JSON, 'utf8'));
  if (current[TEMP_SLUG]) {
    delete current[TEMP_SLUG];
    const result = await json('PUT', '/api/projects', { projects: current });
    assert(result.res.ok, 'failed to remove temp project');
  }
}

(async () => {
  const _spawned = spawnServer({ root: ROOT, port: Number(PORT), dataDir: DATA_DIR, tag: 'baseline-schema', });
  const child = _spawned.child;

  let serverOutput = '';
  child.stdout.on('data', d => { serverOutput += d.toString(); });
  child.stderr.on('data', d => { serverOutput += d.toString(); });

  try {
    await waitForServer();

    const stateResult = await json('GET', '/api/state');
    assert(stateResult.res.ok, '/api/state should return 200');
    assert(stateResult.data.projectSchemaVersion === 'minimal', 'projectSchemaVersion should be minimal');
    // v2.0.0: kbRoot now points to the runtime data dir (was: source package).
    assert(typeof stateResult.data.kbRoot === 'string' && stateResult.data.kbRoot.length > 0,
      'kbRoot should be the runtime data dir');

    await removeTempProject();
    const upsertResult = await json('PUT', '/api/projects', {
      slug: TEMP_SLUG,
      config: {
        displayName: 'TASK-001 Temp',
        localPath: ROOT,
        gitPath: ROOT,
        kbPath: `D:\\SanQian.Xu\\kb\\projects\\${TEMP_SLUG}`,
      },
    });
    assert(upsertResult.res.ok, 'temp project upsert should succeed');

    // Schema check on the freshly upserted temp project (isolated test env).
    const stateAfter = await json('GET', '/api/state');
    assert(stateAfter.res.ok, '/api/state after upsert should return 200');
    const projects = stateAfter.data.projects;
    assert(projects && Object.keys(projects).length >= 1, 'state should include projects');
    for (const [slug, cfg] of Object.entries(projects)) {
      assert(Object.prototype.hasOwnProperty.call(cfg, 'enabled'), `${slug} missing enabled`);
      assert(Object.prototype.hasOwnProperty.call(cfg, 'repoStatus'), `${slug} missing repoStatus`);
      assert(Object.prototype.hasOwnProperty.call(cfg, 'headCommit'), `${slug} missing headCommit`);
      assert(Object.prototype.hasOwnProperty.call(cfg, 'lastSeenCommit'), `${slug} missing lastSeenCommit`);
      assert(Object.prototype.hasOwnProperty.call(cfg, 'lastAnalyzedCommit'), `${slug} missing lastAnalyzedCommit`);
      assert(Object.prototype.hasOwnProperty.call(cfg, 'trackingStartCommit'), `${slug} missing trackingStartCommit`);
      assert(Object.prototype.hasOwnProperty.call(cfg, 'trackingStartedAt'), `${slug} missing trackingStartedAt`);
      // v2.0.0: aiProfileId defaults to null (user must select one).
      assert(Object.prototype.hasOwnProperty.call(cfg, 'aiProfileId'), `${slug} missing aiProfileId property`);
      assert(cfg.kbSchemaVersion === 'minimal', `${slug} missing current kbSchemaVersion`);
      assert(cfg.goalStatus, `${slug} missing goalStatus`);
      assert(!String(cfg.kbPath || '').includes('\\SanQian.Xu\\kb\\'), `${slug} uses legacy kbPath`);
    }

    const projectsResult = await json('GET', '/api/projects');
    assert(projectsResult.res.ok, '/api/projects should return 200');
    const temp = projectsResult.data[TEMP_SLUG];
    assert(temp, 'temp project should exist');
    assert(!String(temp.kbPath || '').includes('\\SanQian.Xu\\kb\\'), 'legacy kbPath should be normalized');
    assert(path.basename(String(temp.kbPath || '')) === TEMP_SLUG, 'normalized kbPath should end with the slug');
    assert(temp.enabled === true, 'temp project should default enabled=true');
    // repoStatus is auto-validated on upsert; ROOT may or may not be a git repo.
    // Accept any of the well-defined statuses that prove normalization ran.
    assert(['ok', 'unknown', 'not-git', 'missing-path'].includes(temp.repoStatus),
      `temp project repoStatus should be a known value, got ${temp.repoStatus}`);

    const htmlResult = await fetch(`${BASE_URL}/`);
    const html = await htmlResult.text();
    assert(htmlResult.ok, 'site root should return 200');
    assert(html.includes('id="app"'), 'site HTML should include Vue app root');
    assert(html.includes('Projects'), 'site HTML should include Projects tab');

    await removeTempProject();
    console.log('TASK-001 baseline schema test passed');
  } catch (e) {
    console.error('TASK-001 baseline schema test failed:', e.message);
    if (serverOutput) console.error(serverOutput);
    process.exitCode = 1;
  } finally {
    await removeTempProject().catch(() => {});
    child.kill();
  }
})();
