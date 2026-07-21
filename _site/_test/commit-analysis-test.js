// TASK-008: Incremental commit analysis test
// Run: node _site/_test/commit-analysis-test.js
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { spawnServer } = require('./helpers/spawn-server');
const { makeRepo, git } = require('./fixtures/make-git-repos');

const ROOT = path.resolve(__dirname, '..', '..');
const SERVER = path.join(ROOT, '_site', 'server.js');
// Pre-create a temp data dir and seed it BEFORE requiring any lib modules
// that capture getDataDir() at module load. Both the test process and
// the spawned server will use this dir.
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), `kb-data-commit-analysis-${process.pid}-`));
process.env.KB_DATA_DIR = DATA_DIR;
require('../lib/data-dir')._resetCache();
fs.writeFileSync(path.join(DATA_DIR, 'projects.json'), '{}\n', 'utf-8');
try { fs.copyFileSync(path.join(ROOT, 'claude-prompts.json'), path.join(DATA_DIR, 'claude-prompts.json')); } catch {}

const { runCommitAnalysis } = require('../lib/analysis-orchestrator');
let PROJECTS_JSON = path.join(DATA_DIR, 'projects.json');
const PORT = process.env.KB_COMMIT_TEST_PORT || '7798';
const BASE_URL = `http://127.0.0.1:${PORT}`;
const TEMP_SLUG = 'task-008-temp';

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

async function cleanup() {
  const base = path.join(DATA_DIR, 'projects', TEMP_SLUG);
  fs.rmSync(base, { recursive: true, force: true });
  const cur = JSON.parse(fs.readFileSync(PROJECTS_JSON, 'utf-8'));
  if (cur[TEMP_SLUG]) {
    delete cur[TEMP_SLUG];
    fs.writeFileSync(PROJECTS_JSON, JSON.stringify(cur, null, 2) + '\n', 'utf-8');
  }
}

(async () => {
  // NOTE: The original TASK-008 unit test ran runCommitAnalysis end-to-end
  // against mock-agent. With mock-agent removed, full LLM-backed analysis
  // is no longer exercised at unit-test level. We now test the new
  // "missing profile" error path and the validation guards.
  const repo = makeRepo({ kind: 'feature-commit' });
  const kbBase = path.join(DATA_DIR, 'projects', TEMP_SLUG);
  fs.rmSync(kbBase, { recursive: true, force: true });
  fs.mkdirSync(kbBase, { recursive: true });
  fs.writeFileSync(path.join(kbBase, 'GOAL.md'), '# Goal — preserve\n');

  const project = {
    slug: TEMP_SLUG,
    kbPath: kbBase,
    gitPath: repo.path,
    localPath: repo.path,
    aiProfileId: 'claude-code-agent', // not configured in ai-profiles.json
  };

  // 1. Missing profile fails fast
  let r = await runCommitAnalysis({ projects: { [TEMP_SLUG]: project }, slug: TEMP_SLUG });
  assert(!r.ok, `commit analysis without configured profile should fail, got: ${JSON.stringify(r)}`);
  assert(/AI profile not configured/.test(r.error || ''), `expected "AI profile not configured" error, got: ${r.error}`);
  assert(r.status === 400, `expected 400, got ${r.status}`);

  // 2. Pre-existing GOAL.md is preserved
  const goalText = fs.readFileSync(path.join(kbBase, 'GOAL.md'), 'utf-8');
  assert(goalText.includes('preserve'), 'pre-existing GOAL.md must not be overwritten');

  // 3. Bad git path also fails (with a different error)
  const badProject = { ...project, gitPath: 'D:\\__no_such_repo__' };
  r = await runCommitAnalysis({ projects: { [TEMP_SLUG]: badProject }, slug: TEMP_SLUG });
  assert(!r.ok, 'bad git path should fail');

  repo.cleanup();
  fs.rmSync(kbBase, { recursive: true, force: true });

  // 7. Server tests
  const _spawned = spawnServer({ root: ROOT, port: Number(PORT), dataDir: DATA_DIR, tag: 'commit-analysis', });
  const child = _spawned.child;
  let serverOutput = '';
  child.stdout.on('data', d => { serverOutput += d.toString(); });
  child.stderr.on('data', d => { serverOutput += d.toString(); });

  try {
    await cleanup();
    await waitForServer();

    const repo4 = makeRepo({ kind: 'multi-commit' });
    const slug = TEMP_SLUG;
    const kbPath = path.join(DATA_DIR, 'projects', slug);
    fs.mkdirSync(kbPath, { recursive: true });
    fs.writeFileSync(path.join(kbPath, 'GOAL.md'), '# Goal — server\n');

    r = await json('PUT', '/api/projects', {
      slug,
      config: { displayName: 'TASK-008', localPath: repo4.path, gitPath: repo4.path, kbPath },
    });
    assert(r.res.ok, 'upsert should succeed');

    // Without a configured profile, analyze should 400 with a clear error.
    r = await json('POST', `/api/projects/${slug}/analyze/commits`, {});
    assert(!r.res.ok && r.res.status === 400, `analyze commits without profile should 400, got ${r.res.status}: ${JSON.stringify(r.data)}`);
    assert(/AI profile not (assigned|configured|disabled)/.test(r.data.error || ''), `expected profile error, got: ${r.data.error}`);

    // Bad slug
    r = await json('POST', '/api/projects/INVALID../analyze/commits', {});
    assert(!r.res.ok && r.res.status === 400, 'bad slug should 400');

    repo4.cleanup();
    console.log('TASK-008 commit analysis test passed');
  } catch (e) {
    console.error('TASK-008 commit analysis test failed:', e.message);
    if (serverOutput) console.error(serverOutput);
    process.exitCode = 1;
  } finally {
    await cleanup().catch(() => {});
    child.kill();
  }
})();
