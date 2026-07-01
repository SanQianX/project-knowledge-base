// Final KB draft apply test.
// Run: node _site/_test/draft-apply-test.js
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const SERVER = path.join(ROOT, '_site', 'server.js');
const PORT = process.env.KB_APPLY_TEST_PORT || '7799';
const BASE_URL = `http://127.0.0.1:${PORT}`;
const TEMP_SLUG = 'task-009-temp';

// Pre-create a temp data dir and seed it BEFORE requiring any lib modules
// that capture getDataDir() at module load. Both the test process and the
// spawned server will use this dir.
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), `kb-data-draft-apply-${process.pid}-`));
process.env.KB_DATA_DIR = DATA_DIR;
require('../lib/data-dir')._resetCache();
fs.writeFileSync(path.join(DATA_DIR, 'projects.json'), '{}\n', 'utf-8');
fs.copyFileSync(path.join(ROOT, 'claude-prompts.json'), path.join(DATA_DIR, 'claude-prompts.json'));

const { spawnServer } = require('./helpers/spawn-server');
const {
  applyDrafts,
  rejectDrafts,
  validateDraftSchema,
  listDraftFiles,
  readDraftContent,
  isSafeApplyPath,
  TRUSTED_GOAL_REL,
} = require('../lib/draft-apply');
const { initProjectDirs } = require('../lib/kb-framework');
const aiWorkspace = require('../lib/ai-workspace');

let PROJECTS_JSON = path.join(DATA_DIR, 'projects.json');

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

function writeRun(slug, runId, extra = {}) {
  const aiRoot = aiWorkspace.ensureProjectAIPath(slug);
  const runPath = path.join(aiRoot, 'runs', `${runId}.json`);
  fs.writeFileSync(runPath, JSON.stringify({ runId, schema: 'ai-run/v1', status: 'succeeded', ...extra }, null, 2), 'utf-8');
  return aiRoot;
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
  assert(TRUSTED_GOAL_REL === 'GOAL.md', 'trusted goal constant should be GOAL.md');
  assert(validateDraftSchema({ path: 'changes/x.md', content: 'hi' }).valid, 'change draft should be valid');
  assert(validateDraftSchema({ path: 'modules/x.md', content: 'hi' }).valid, 'module draft should be valid');
  assert(!validateDraftSchema({ path: 'x.exe', content: 'hi' }).valid, 'unknown extension should be invalid');

  const slug = `kb-apply-${process.pid}`;
  const kbRoot = path.join(os.tmpdir(), slug);
  fs.rmSync(kbRoot, { recursive: true, force: true });
  initProjectDirs(slug, kbRoot);
  assert(isSafeApplyPath(kbRoot, 'changes/x.md'), 'plain relative path is safe');
  assert(!isSafeApplyPath(kbRoot, '_ai/drafts/x.md'), 'KB-local AI path is unsafe');
  assert(!isSafeApplyPath(kbRoot, 'changes/../../outside.md'), 'traversal is unsafe');

  const runId = 'run-apply-1';
  const aiRoot = writeRun(slug, runId, { headCommitAtRun: 'abc123' });
  const draftsDir = path.join(aiRoot, 'drafts', runId);
  fs.mkdirSync(path.join(draftsDir, 'changes'), { recursive: true });
  fs.writeFileSync(path.join(draftsDir, 'changes', 'intent.md'), '# Intent\n\n## Development Intent\nBuild useful memory.\n');

  let drafts = listDraftFiles(kbRoot, runId);
  assert(drafts.some(d => d.path === 'changes/intent.md'), 'listDraftFiles should read from _site/_ai');
  assert(readDraftContent(kbRoot, runId, 'changes/intent.md').includes('Development Intent'), 'readDraftContent should read the draft');

  let result = applyDrafts({
    kbPath: kbRoot,
    slug,
    runId,
    drafts: [{ path: 'changes/intent.md', content: '# Intent\n\n## Development Intent\nBuild useful memory.\n' }],
    allowGoalEdit: false,
    headCommitAtRun: 'abc123',
  });
  assert(result.ok, `change draft should apply: ${JSON.stringify(result)}`);
  assert(fs.existsSync(path.join(kbRoot, 'changes', 'intent.md')), 'change file should be written');
  assert(fs.readFileSync(path.join(kbRoot, 'changes', '00-index.md'), 'utf-8').includes('Intent'), 'changes index should be regenerated');

  result = applyDrafts({
    kbPath: kbRoot,
    slug,
    runId: 'run-refuse-goal',
    drafts: [{ path: 'GOAL.md', content: '# Goal draft\n' }],
    allowGoalEdit: false,
  });
  assert(!result.ok && result.status === 409, 'GOAL.md should require review');

  result = applyDrafts({
    kbPath: kbRoot,
    slug,
    runId: 'run-allow-goal',
    drafts: [{ path: 'GOAL.md', content: '# Goal accepted\n' }],
    allowGoalEdit: true,
  });
  assert(result.ok, 'GOAL.md should apply when explicitly allowed');
  assert(fs.readFileSync(path.join(kbRoot, 'GOAL.md'), 'utf-8').includes('Goal accepted'), 'GOAL.md should be overwritten when allowed');

  result = applyDrafts({
    kbPath: kbRoot,
    slug,
    runId: 'run-old-path',
    drafts: [{ path: 'features/x.md', content: '# X\n' }],
    allowGoalEdit: true,
  });
  assert(!result.ok, 'old feature directory should be rejected');

  const rejectRun = 'run-reject-1';
  writeRun(slug, rejectRun);
  result = rejectDrafts({ kbPath: kbRoot, runId: rejectRun, reason: 'not useful' });
  assert(result.ok && result.run.applyStatus === 'rejected', 'reject should mark run rejected');

  fs.rmSync(kbRoot, { recursive: true, force: true });

  const _spawned = spawnServer({ root: ROOT, port: Number(PORT), dataDir: DATA_DIR, tag: 'draft-apply' });
  // Defer the AI workspace cleanup until DATA_DIR is set.
  fs.rmSync(path.join(DATA_DIR, '_ai', slug), { recursive: true, force: true });
  const child = _spawned.child;
  let serverOutput = '';
  child.stdout.on('data', d => { serverOutput += d.toString(); });
  child.stderr.on('data', d => { serverOutput += d.toString(); });

  try {
    cleanupProject(TEMP_SLUG);
    await waitForServer();

    const kbPath = path.join(DATA_DIR, 'projects', TEMP_SLUG);
    initProjectDirs(TEMP_SLUG, kbPath);
    let r = await json('PUT', '/api/projects', {
      slug: TEMP_SLUG,
      config: { displayName: 'TASK-009', localPath: ROOT, gitPath: ROOT, kbPath, kbSchemaVersion: 'minimal' },
    });
    assert(r.res.ok, 'upsert should succeed');

    const srvRunId = 'server-apply-1';
    writeRun(TEMP_SLUG, srvRunId, { headCommitAtRun: 'server-head' });
    r = await json('POST', `/api/projects/${TEMP_SLUG}/drafts/${srvRunId}/apply`, {
      drafts: [{ path: 'changes/server.md', content: '# Server\n\n## Development Intent\nServer apply.\n' }],
    });
    assert(r.res.ok && r.data.ok, `server apply should succeed: ${JSON.stringify(r.data)}`);
    assert(fs.existsSync(path.join(kbPath, 'changes', 'server.md')), 'server change should be written');

    r = await json('POST', `/api/projects/${TEMP_SLUG}/drafts/${srvRunId}/apply`, {
      drafts: [{ path: 'GOAL.md', content: '# Bad\n' }],
    });
    assert(!r.res.ok && r.res.status === 409, 'server should require goal review');

    r = await json('POST', `/api/projects/${TEMP_SLUG}/drafts/${srvRunId}/reject`, { reason: 'done' });
    assert(r.res.ok && r.data.ok, 'server reject should succeed');

    console.log('Final KB draft apply test passed');
  } catch (e) {
    console.error('Final KB draft apply test failed:', e.message);
    if (serverOutput) console.error(serverOutput);
    process.exitCode = 1;
  } finally {
    cleanupProject(TEMP_SLUG);
    child.kill();
  }
})();
