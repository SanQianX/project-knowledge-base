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
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), `kb-data-task15-20-integration-${process.pid}-`));
process.env.KB_DATA_DIR = DATA_DIR;
require('../lib/data-dir')._resetCache();
fs.writeFileSync(path.join(DATA_DIR, 'projects.json'), '{}\n', 'utf-8');
try { fs.copyFileSync(path.join(ROOT, 'claude-prompts.json'), path.join(DATA_DIR, 'claude-prompts.json')); } catch {}

let PROJECTS_JSON = path.join(DATA_DIR, 'projects.json');
const KNOWLEDGE_STORE_JSON = path.join(ROOT, 'knowledge-store.json');
const LOGGING_JSON = path.join(ROOT, 'logging.json');
const PORT = process.env.KB_TASK_15_20_PORT || '7820';
const BASE_URL = `http://127.0.0.1:${PORT}`;
const TEMP_ROOT = path.join(ROOT, '.tmp-task-15-20');
const SLUG = 'task-015-020-temp';
const LEGACY_SLUG = 'task-020-legacy-temp';

function assert(cond, msg) { if (!cond) throw new Error(msg); }
function backup(file) { return fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : null; }
function restore(file, content) {
  if (content == null) fs.rmSync(file, { force: true });
  else fs.writeFileSync(file, content, 'utf-8');
}
async function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
async function rmWithRetry(target) {
  for (let i = 0; i < 8; i++) {
    try { fs.rmSync(target, { recursive: true, force: true }); return; }
    catch (e) { if (i === 7) throw e; await sleep(250); }
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
    await sleep(250);
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
  const kbRoot = path.join(TEMP_ROOT, 'knowledge');
  const logsRoot = path.join(TEMP_ROOT, 'logs');
  const aiRoot = path.join(DATA_DIR, '_ai');
  fs.rmSync(path.join(aiRoot, SLUG), { recursive: true, force: true });
  fs.rmSync(path.join(aiRoot, LEGACY_SLUG), { recursive: true, force: true });

  const _spawned = spawnServer({ root: ROOT, port: Number(PORT), dataDir: DATA_DIR, tag: 'task15-20-integration', });
  const child = _spawned.child;
  let serverOutput = '';
  child.stdout.on('data', d => { serverOutput += d.toString(); });
  child.stderr.on('data', d => { serverOutput += d.toString(); });

  let repo = null;
  try {
    await waitForServer();
    let r = await json('PUT', '/api/knowledge-store/config', { rootPath: kbRoot, git: { enabled: false } });
    assert(r.res.ok, 'knowledge-store config should save');
    r = await json('PUT', '/api/logging/config', { rootPath: logsRoot, retentionDays: 14 });
    assert(r.res.ok, 'logging config should save');

    repo = makeRepo({ kind: 'feature-commit' });
    r = await json('PUT', '/api/projects', {
      slug: SLUG,
      config: {
        displayName: 'TASK 015-020 Temp',
        localPath: repo.path,
        gitPath: repo.path,
        aiProfileId: 'claude-code-agent',
        goalStatus: 'accepted',
        kbSchemaVersion: 'minimal',
      },
    });
    assert(r.res.ok, 'project import should succeed');

    r = await json('POST', `/api/projects/${SLUG}/init`);
    assert(r.res.ok && r.data.kbSchemaVersion === 'minimal', 'init should create minimal KB');
    const projects = JSON.parse(fs.readFileSync(PROJECTS_JSON, 'utf-8'));
    const kbPath = projects[SLUG].kbPath;
    const top = fs.readdirSync(kbPath).filter(name => !name.startsWith('.')).sort();
    assert(JSON.stringify(top) === JSON.stringify(['ARCHITECTURE.md', 'GOAL.md', 'README.md', 'changes', 'modules']), `unexpected minimal top-level: ${top.join(', ')}`);
    assert(!fs.existsSync(path.join(kbPath, '_ai')), 'minimal KB must not contain _ai');
    assert(!fs.existsSync(path.join(kbPath, 'kb-manifest.json')), 'minimal KB must not contain manifest');

    r = await json('POST', `/api/projects/${SLUG}/validate-kb`);
    assert(r.res.ok && r.data.ok, `minimal validate should pass: ${JSON.stringify(r.data)}`);
    r = await json('GET', `/api/projects/${SLUG}/pr-context`);
    assert(r.res.ok && r.data.pack && r.data.pack.goal.path === 'GOAL.md', 'PR context should read final GOAL');

    // analyze/commits requires a configured AI profile; without one the
    // endpoint must 400 with a clear error (regression coverage for the new
    // "no default profile" model). The drafts/apply/drafts-by-branch flow
    // is then exercised against a synthetic run on disk.
    r = await json('POST', `/api/projects/${SLUG}/analyze/commits`);
    assert(!r.res.ok && r.res.status === 400, `analyze commits without profile should 400, got ${r.res.status}: ${JSON.stringify(r.data)}`);
    assert(/AI profile not (assigned|configured|disabled)/.test(r.data.error || ''),
      `expected profile error, got: ${r.data.error}`);

    // Build a synthetic minimal-framework run + drafts on disk
    const runId = 'integration-synthetic';
    const runDraftsDir = path.join(aiRoot, SLUG, 'drafts', runId, 'changes');
    fs.mkdirSync(path.join(aiRoot, SLUG, 'drafts', runId, 'changes'), { recursive: true });
    fs.mkdirSync(path.join(aiRoot, SLUG, 'runs'), { recursive: true });
    const syntheticBranch = 'main';
    const syntheticHeadCommit = '0123456789abcdef0123456789abcdef01234567';
    fs.writeFileSync(path.join(aiRoot, SLUG, 'drafts', runId, 'changes', 'integration-change.md'),
      '---\nsourceBranch: main\nsourceHeadCommit: 0123456789abcdef0123456789abcdef01234567\n---\n# integration change\n');
    fs.writeFileSync(path.join(aiRoot, SLUG, 'runs', `${runId}.json`), JSON.stringify({
      schema: 'ai-run/v1',
      runId,
      type: 'commit',
      project: SLUG,
      status: 'succeeded',
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      headCommitAtRun: syntheticHeadCommit,
      sourceBranch: syntheticBranch,
      sourceDefaultBranch: syntheticBranch,
      sourceRemote: 'https://example.invalid/integration.git',
      drafts: [
        { path: 'changes/integration-change.md', status: 'pending' },
      ],
      outputPaths: ['changes/integration-change.md'],
    }, null, 2));

    r = await json('GET', `/api/projects/${SLUG}/drafts-by-branch?branch=${encodeURIComponent(syntheticBranch)}`);
    assert(r.res.ok && r.data.drafts.length > 0, 'drafts-by-branch should return branch drafts');
    assert(r.data.drafts.every(d => d.sourceBranch === syntheticBranch), 'drafts-by-branch should filter by branch');

    const payloads = [];
    for (const d of r.data.drafts.filter(d => d.path.startsWith('changes/'))) {
      const raw = await json('GET', `/api/projects/${SLUG}/drafts/${d.runId}/raw?path=${encodeURIComponent(d.path)}`);
      assert(raw.res.ok, `raw draft should load: ${d.path}`);
      payloads.push({ path: d.path, content: raw.data.content, sourceBranch: d.sourceBranch, sourceHeadCommit: d.sourceHeadCommit });
    }
    assert(payloads.length > 0, 'should have changes draft payloads');
    r = await json('POST', `/api/projects/${SLUG}/drafts/${runId}/apply`, { drafts: payloads, allowGoalEdit: false });
    assert(r.res.ok && r.data.applied.length === payloads.length, 'final changes drafts should auto-apply');
    const applied = fs.readFileSync(path.join(kbPath, payloads[0].path), 'utf-8');
    assert(applied.includes('sourceBranch:'), 'applied final doc should include sourceBranch');
    assert(fs.existsSync(path.join(kbPath, 'changes', '00-index.md')), 'changes index should regenerate');

    r = await json('POST', `/api/projects/${SLUG}/drafts/${runId}/apply`, {
      drafts: [{ path: 'GOAL.md', content: '# bad silent goal edit' }],
      allowGoalEdit: false,
    });
    assert(!r.res.ok && r.res.status === 409, 'GOAL.md apply should require review');

    const legacyKb = path.join(kbRoot, LEGACY_SLUG);
    fs.mkdirSync(path.join(legacyKb, '_ai', 'runs'), { recursive: true });
    fs.mkdirSync(path.join(legacyKb, 'commits'), { recursive: true });
    fs.writeFileSync(path.join(legacyKb, 'README.md'), '# legacy\n');
    fs.writeFileSync(path.join(legacyKb, 'GOAL.md'), '# legacy goal\n');
    fs.writeFileSync(path.join(legacyKb, '_ai', 'runs', 'old.json'), '{"schema":"ai-run/v1"}\n');
    for (let i = 0; i < 6; i++) fs.writeFileSync(path.join(legacyKb, 'commits', `2026-01-0${i + 1}_aaaaaa${i}_test.md`), `# commit ${i}\n`);
    r = await json('PUT', '/api/projects', { slug: LEGACY_SLUG, config: { displayName: 'legacy', localPath: repo.path, gitPath: repo.path, kbPath: legacyKb, kbSchemaVersion: 'minimal' } });
    assert(r.res.ok, 'legacy project import should succeed');
    r = await json('POST', `/api/projects/${LEGACY_SLUG}/migrate-framework`);
    assert(r.res.ok, `migrate-framework should pass: ${JSON.stringify(r.data)}`);
    assert(!fs.existsSync(path.join(legacyKb, '_ai')), 'migrate-framework should remove KB-local _ai');
    assert(!fs.existsSync(path.join(legacyKb, 'commits')), 'migrate-framework should remove legacy commits dir');
    assert(fs.existsSync(path.join(aiRoot, LEGACY_SLUG, 'legacy-commits')), 'legacy commits should be backed up to app AI workspace');
    assert(fs.readdirSync(path.join(legacyKb, 'changes')).some(name => /^legacy-change-/.test(name)), 'legacy commits should consolidate into changes');

    r = await json('GET', `/api/projects/${SLUG}/remove-preview`);
    assert(r.res.ok && r.data.preview.fileCount > 0, 'remove preview should include file count');
    r = await json('POST', `/api/projects/${SLUG}/remove`, { deleteKb: false, reason: 'integration soft remove' });
    assert(r.res.ok && r.data.removedKb === false, 'soft remove should not delete KB');
    assert(fs.existsSync(kbPath), 'soft remove should keep KB on disk');
    r = await json('PUT', '/api/projects', { slug: SLUG, config: { displayName: 'reimport', localPath: repo.path, gitPath: repo.path, kbPath, kbSchemaVersion: 'minimal' } });
    assert(r.res.ok, 'reimport after soft remove should work');
    r = await json('POST', `/api/projects/${SLUG}/remove`, { deleteKb: true, reason: 'integration hard remove' });
    assert(r.res.ok && r.data.removedKb === true, 'hard remove should delete KB');
    assert(!fs.existsSync(kbPath), 'hard remove should remove KB path');

    const logFiles = fs.readdirSync(logsRoot).filter(name => name.endsWith('.log'));
    assert(logFiles.length > 0, 'structured log should be written');
    const logText = logFiles.map(file => fs.readFileSync(path.join(logsRoot, file), 'utf-8')).join('\n');
    assert(logText.includes('project_removed'), 'project removal should be logged');

    console.log('TASK-015..020 integration test passed');
  } catch (e) {
    console.error('TASK-015..020 integration test failed:', e.message);
    if (serverOutput) console.error(serverOutput);
    process.exitCode = 1;
  } finally {
    child.kill();
    await sleep(500);
    try { if (repo && repo.cleanup) repo.cleanup(); } catch {}
    restore(PROJECTS_JSON, projectsBackup);
    restore(KNOWLEDGE_STORE_JSON, storeBackup);
    restore(LOGGING_JSON, loggingBackup);
    fs.rmSync(path.join(aiRoot, SLUG), { recursive: true, force: true });
    fs.rmSync(path.join(aiRoot, LEGACY_SLUG), { recursive: true, force: true });
    await rmWithRetry(TEMP_ROOT).catch(() => {});
  }
})();
