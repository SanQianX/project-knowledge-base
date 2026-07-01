// TASK-010: Job orchestrator test
// Run: node _site/_test/job-orchestrator-test.js
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { spawnServer } = require('./helpers/spawn-server');
const { makeRepo } = require('./fixtures/make-git-repos');
const {
  runJob, makeJob, readJobLog, appendJobLog, KNOWN_MODES,
} = require('../lib/job-orchestrator');
const { runCommitAnalysis, readRun, listDrafts } = require('../lib/analysis-orchestrator');

const ROOT = path.resolve(__dirname, '..', '..');
const SERVER = path.join(ROOT, '_site', 'server.js');
// Pre-create a temp data dir and seed it BEFORE requiring any lib modules
// that capture getDataDir() at module load. Both the test process and
// the spawned server will use this dir.
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), `kb-data-job-orchestrator-${process.pid}-`));
process.env.KB_DATA_DIR = DATA_DIR;
require('../lib/data-dir')._resetCache();
fs.writeFileSync(path.join(DATA_DIR, 'projects.json'), '{}\n', 'utf-8');
try { fs.copyFileSync(path.join(ROOT, 'claude-prompts.json'), path.join(DATA_DIR, 'claude-prompts.json')); } catch {}

let PROJECTS_JSON = path.join(DATA_DIR, 'projects.json');
const PORT = process.env.KB_JOB_TEST_PORT || '7800';
const BASE_URL = `http://127.0.0.1:${PORT}`;
const TEMP_SLUG = 'task-010-temp';

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
  const log = path.join(ROOT, '.jobs-log.json');
  if (fs.existsSync(log)) fs.unlinkSync(log);
}

function makeProjectsDir(slug) {
  const base = path.join(DATA_DIR, 'projects', slug);
  fs.rmSync(base, { recursive: true, force: true });
  fs.mkdirSync(base, { recursive: true });
  fs.writeFileSync(path.join(base, 'GOAL.md'), '# Goal\n');
  fs.mkdirSync(path.join(base, 'modules'), { recursive: true });
  fs.mkdirSync(path.join(base, 'changes'), { recursive: true });
  return base;
}

(async () => {
  assert(fs.existsSync(SERVER), 'server.js missing');

  // 1. KNOWN_MODES lists the expected set
  for (const m of ['scan', 'analyze-initial', 'analyze-commits', 'safe']) {
    assert(KNOWN_MODES.has(m), `KNOWN_MODES should include ${m}`);
  }

  // 2. makeJob returns a job with the expected shape
  const j = makeJob({ mode: 'scan', slug: 'ALL' });
  assert(j.jobId && j.jobId.startsWith('job-'), 'jobId should start with job-');
  assert(j.mode === 'scan' && j.slug === 'ALL', 'mode and slug set');
  assert(j.status === 'running', 'initial status is running');
  assert(typeof j.startTime === 'string', 'startTime is an ISO string');

  // 3. appendJobLog / readJobLog round-trip
  const log = path.join(ROOT, '.jobs-log-test.json');
  if (fs.existsSync(log)) fs.unlinkSync(log);
  appendJobLog(log, { jobId: 'job-a', status: 'success' });
  appendJobLog(log, { jobId: 'job-b', status: 'failed' });
  const readBack = readJobLog(log);
  assert(readBack.length === 2, `expected 2 entries, got ${readBack.length}`);
  assert(readBack[0].jobId === 'job-a' && readBack[1].jobId === 'job-b', 'entries in order');
  fs.unlinkSync(log);

  // 4. runJob with unknown mode returns failure but still records
  const badJob = makeJob({ mode: 'no-such-mode', slug: 'ALL' });
  const badResult = await runJob({
    job: badJob,
    projects: {},
    projectsPath: PROJECTS_JSON,
    jobsLogPath: log,
  });
  assert(!badResult.summary || badResult.summary.error, 'unknown mode should set summary.error');
  assert(badResult.status === 'failed', 'unknown mode should fail');
  fs.unlinkSync(log);

  // ----- Integration: scan mode -----
  const repo = makeRepo({ kind: 'multi-commit' });
  const kbBase = makeProjectsDir(TEMP_SLUG);
  const project = {
    slug: TEMP_SLUG,
    kbPath: kbBase,
    gitPath: repo.path,
    localPath: repo.path,
    aiProfileId: 'claude-code-agent',
    enabled: true,
    headCommit: null,
    lastSeenCommit: null,
    lastAnalyzedCommit: null,
  };
  const projectsMap = { [TEMP_SLUG]: project };

  const scanJob = makeJob({ mode: 'scan', slug: TEMP_SLUG });
  const scanResult = await runJob({
    job: scanJob,
    projects: projectsMap,
    projectsPath: PROJECTS_JSON,
    jobsLogPath: log,
  });
  assert(scanResult.status === 'success', `scan should succeed, got ${scanResult.status}`);
  assert(scanResult.summary && scanResult.summary.scanned === 1, `expected 1 scanned, got ${JSON.stringify(scanResult.summary)}`);
  assert(projectsMap[TEMP_SLUG].headCommit, 'scan should populate headCommit');
  assert(projectsMap[TEMP_SLUG].lastSeenCommit, 'scan should populate lastSeenCommit');
  assert(projectsMap[TEMP_SLUG].lastScanPendingCount === 3, `expected 3 pending, got ${projectsMap[TEMP_SLUG].lastScanPendingCount}`);

  // 5. safe mode runs scan + analyze-commits. Without a configured profile,
  // analyze-commits will fail; we expect safe mode to surface that as a failed
  // commits run, with 0 applied drafts and the formal KB untouched.
  projectsMap[TEMP_SLUG].lastAnalyzedCommit = null;
  const safeJob = makeJob({ mode: 'safe', slug: TEMP_SLUG });
  const safeResult = await runJob({
    job: safeJob,
    projects: projectsMap,
    projectsPath: PROJECTS_JSON,
    jobsLogPath: log,
  });
  // safe should be a partial (scan succeeds, analyze-commits fails for missing profile).
  assert(safeResult.summary && safeResult.summary.scan, 'safe should include scan summary');
  assert(safeResult.summary && safeResult.summary.commits, 'safe should include commits summary');
  assert(safeResult.summary.applied === 0, `safe must apply 0 drafts, got ${safeResult.summary.applied}`);
  assert(safeResult.summary.commits.failed === 1, `analyze-commits must fail (no profile); got failed=${safeResult.summary.commits.failed}`);
  // The formal KB must NOT have any modules/<slug>.md or changes/<short>.md
  const modulesDir = path.join(kbBase, 'modules');
  const changesDir = path.join(kbBase, 'changes');
  const realModuleFiles = fs.existsSync(modulesDir)
    ? fs.readdirSync(modulesDir).filter(f => f !== '00-index.md')
    : [];
  const realChangeFiles = fs.existsSync(changesDir)
    ? fs.readdirSync(changesDir).filter(f => f !== '00-index.md')
    : [];
  assert(realModuleFiles.length === 0, `safe mode must not write module files; found: ${realModuleFiles.join(',')}`);
  assert(realChangeFiles.length === 0, `safe mode must not write changes files; found: ${realChangeFiles.join(',')}`);

  // 6. analyze-commits mode without a configured profile must fail (no profile → 1 failed).
  projectsMap[TEMP_SLUG].lastAnalyzedCommit = null;
  const acJob = makeJob({ mode: 'analyze-commits', slug: TEMP_SLUG });
  const acResult = await runJob({
    job: acJob,
    projects: projectsMap,
    projectsPath: PROJECTS_JSON,
    jobsLogPath: log,
  });
  assert(acResult.summary && acResult.summary.failed === 1,
    `analyze-commits without profile should fail; got ${JSON.stringify(acResult.summary)}`);

  // 7. analyze-initial mode skips a project that already has a goal (this path
  //    doesn't touch the LLM and must still work).
  const aiJob = makeJob({ mode: 'analyze-initial', slug: TEMP_SLUG });
  const aiResult = await runJob({
    job: aiJob,
    projects: projectsMap,
    projectsPath: PROJECTS_JSON,
    jobsLogPath: log,
  });
  assert(aiResult.summary && aiResult.summary.skipped === 1, `analyze-initial should skip project with existing goal; got ${JSON.stringify(aiResult.summary)}`);

  // 8. analyze-initial on a project with no goal: initial analysis was removed,
  //    so this mode is a no-op skip (never calls the LLM, never creates GOAL.md).
  const noGoalSlug = TEMP_SLUG + '-no-goal';
  const noGoalBase = makeProjectsDir(noGoalSlug);
  fs.unlinkSync(path.join(noGoalBase, 'GOAL.md'));
  const noGoalRepo = makeRepo({ kind: 'one-commit' });
  projectsMap[noGoalSlug] = {
    slug: noGoalSlug,
    kbPath: noGoalBase,
    gitPath: noGoalRepo.path,
    localPath: noGoalRepo.path,
    aiProfileId: 'claude-code-agent',
    enabled: true,
  };
  const aiJob2 = makeJob({ mode: 'analyze-initial', slug: noGoalSlug });
  const aiResult2 = await runJob({
    job: aiJob2,
    projects: projectsMap,
    projectsPath: PROJECTS_JSON,
    jobsLogPath: log,
  });
  assert(aiResult2.summary && aiResult2.summary.skipped === 1 && aiResult2.summary.failed === 0,
    `analyze-initial should be a no-op skip; got ${JSON.stringify(aiResult2.summary)}`);
  assert(!fs.existsSync(path.join(noGoalBase, 'GOAL.md')), 'analyze-initial must NOT create GOAL.md directly');

  // 9. scan with slug=ALL iterates enabled projects
  projectsMap[TEMP_SLUG].headCommit = null;
  projectsMap[TEMP_SLUG].lastSeenCommit = null;
  const scanAllJob = makeJob({ mode: 'scan', slug: 'ALL' });
  const scanAllResult = await runJob({
    job: scanAllJob,
    projects: projectsMap,
    projectsPath: PROJECTS_JSON,
    jobsLogPath: log,
  });
  assert(scanAllResult.summary.scanned >= 1, 'scan ALL should hit at least the test project');

  // 10. unknown slug returns a clear error
  const badSlugJob = makeJob({ mode: 'scan', slug: 'no-such-slug' });
  const badSlugResult = await runJob({
    job: badSlugJob,
    projects: projectsMap,
    projectsPath: PROJECTS_JSON,
    jobsLogPath: log,
  });
  assert(badSlugResult.status === 'failed', 'scan on unknown slug should fail');

  // 11. Job log persisted
  const persistedLog = readJobLog(log);
  assert(persistedLog.length >= 5, `expected ≥5 persisted jobs, got ${persistedLog.length}`);

  repo.cleanup();
  noGoalRepo.cleanup();
  fs.rmSync(kbBase, { recursive: true, force: true });
  fs.rmSync(noGoalBase, { recursive: true, force: true });
  fs.unlinkSync(log);

  // ----- Server tests -----
  const _spawned = spawnServer({ root: ROOT, port: Number(PORT), dataDir: DATA_DIR, tag: 'job-orchestrator', });
  const child = _spawned.child;
  let serverOutput = '';
  child.stdout.on('data', d => { serverOutput += d.toString(); });
  child.stderr.on('data', d => { serverOutput += d.toString(); });

  try {
    await cleanup();
    await waitForServer();

    // 12. /api/jobs/run dispatches a job and returns jobId
    r = await json('POST', '/api/jobs/run', { mode: 'scan', slug: 'ALL' });
    assert(r.res.ok, `jobs/run should succeed: ${JSON.stringify(r.data)}`);
    assert(r.data.jobId && r.data.jobId.startsWith('job-'), 'should return jobId');
    assert(r.data.mode === 'scan' && r.data.slug === 'ALL', 'should echo mode and slug');
    const dispatchedJobId = r.data.jobId;

    // 13. /api/jobs returns history
    r = await json('GET', '/api/jobs');
    assert(r.res.ok, 'GET /api/jobs should succeed');
    assert(Array.isArray(r.data.history), 'history should be an array');
    assert(Array.isArray(r.data.knownModes), 'knownModes should be an array');
    assert(r.data.knownModes.includes('safe'), 'knownModes should include safe');

    // 14. /api/jobs/:jobId returns the job (live or persisted)
    r = await json('GET', `/api/jobs/${dispatchedJobId}`);
    assert(r.res.ok, `GET job should succeed: ${JSON.stringify(r.data)}`);
    assert(r.data.job.jobId === dispatchedJobId, 'should return the right job');

    // 15. unknown mode returns 400
    r = await json('POST', '/api/jobs/run', { mode: 'no-such-mode' });
    assert(!r.res.ok && r.res.status === 400, 'unknown mode should 400');

    // 16. unknown jobId returns 404
    r = await json('GET', '/api/jobs/job-999999-9999');
    assert(!r.res.ok && r.res.status === 404, 'unknown job should 404');

    console.log('TASK-010 job orchestrator test passed');
  } catch (e) {
    console.error('TASK-010 job orchestrator test failed:', e.message);
    if (serverOutput) console.error(serverOutput);
    process.exitCode = 1;
  } finally {
    await cleanup().catch(() => {});
    child.kill();
  }
})();
