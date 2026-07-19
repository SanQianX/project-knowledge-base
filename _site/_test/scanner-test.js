// TASK-004: Analysis state and scanner test
// Run: node _site/_test/scanner-test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { spawnServer } = require('./helpers/spawn-server');
const { makeRepo, git } = require('./fixtures/make-git-repos');

const ROOT = path.resolve(__dirname, '..', '..');
const SERVER = path.join(ROOT, '_site', 'server.js');
let PROJECTS_JSON; // assigned inside the IIFE after spawnServer
let DATA_DIR; // assigned inside the IIFE after spawnServer
const PORT = process.env.KB_SCAN_TEST_PORT || '7794';
const BASE_URL = `http://127.0.0.1:${PORT}`;
const TEMP_SLUG = 'task-004-temp';

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

async function upsert(slug, extra = {}) {
  const r = await json('PUT', '/api/projects', {
    slug,
    config: { displayName: slug, ...extra },
  });
  assert(r.res.ok, 'upsert failed');
  return r.data;
}

async function getProject(slug) {
  const r = await json('GET', '/api/projects');
  return r.data[slug];
}

(async () => {

  const _spawned = spawnServer({ root: ROOT, port: Number(PORT), tag: 'scanner',  });
  DATA_DIR = _spawned.dataDir;
  PROJECTS_JSON = path.join(DATA_DIR, 'projects.json');
  const child = _spawned.child;
  let serverOutput = '';
  child.stdout.on('data', d => { serverOutput += d.toString(); });
  child.stderr.on('data', d => { serverOutput += d.toString(); });

  const fixtures = [];
  try {
    await cleanup();
    await waitForServer();

    // 1. Empty repo: pending=0, mode=initial
    const empty = makeRepo({ kind: 'empty' });
    fixtures.push(empty);
    await upsert(TEMP_SLUG, { localPath: empty.path, gitPath: empty.path });

    let r = await json('POST', `/api/projects/${TEMP_SLUG}/scan`);
    assert(r.res.ok, 'scan should succeed');
    assert(r.data.repoStatus === 'empty', `empty repo scan should report empty, got ${r.data.repoStatus}`);
    assert(r.data.pendingCount === 0, `empty repo should have 0 pending, got ${r.data.pendingCount}`);

    let cfg = await getProject(TEMP_SLUG);
    assert(cfg.lastSeenCommit === null || cfg.lastSeenCommit === cfg.headCommit, 'lastSeenCommit should be null/head for empty');
    assert(cfg.lastAnalyzedCommit === null, 'lastAnalyzedCommit must NOT be updated by scan');

    // 2. Multi-commit repo: first scan → initial mode, all commits
    const multi = makeRepo({ kind: 'multi-commit' });
    fixtures.push(multi);
    await upsert(TEMP_SLUG, { localPath: multi.path, gitPath: multi.path });

    r = await json('POST', `/api/projects/${TEMP_SLUG}/scan`);
    assert(r.res.ok, 'scan should succeed');
    assert(['tracking-start', 'tracked'].includes(r.data.mode), `first scan should establish tracking, got ${r.data.mode}`);
    assert(r.data.pendingCount === 0, `pre-import history should not be pending, got ${r.data.pendingCount}`);
    assert(r.data.headCommit === multi.headCommit, 'headCommit should match fixture');

    cfg = await getProject(TEMP_SLUG);
    assert(cfg.lastSeenCommit === multi.headCommit, 'lastSeenCommit should equal head');
    assert(cfg.lastAnalyzedCommit === null, 'lastAnalyzedCommit must NOT be updated by scan');
    assert(cfg.trackingStartCommit === multi.headCommit, 'trackingStartCommit should equal first imported head');

    // 3. Add new commits → second scan should detect 2 new pending
    const fs2 = require('fs');
    fs2.writeFileSync(path.join(multi.path, 'src', 'c.ts'), 'export const c = 3;\n');
    git(multi.path, 'add .');
    git(multi.path, 'commit -q -m "feat: add c module"');
    fs2.writeFileSync(path.join(multi.path, 'src', 'd.ts'), 'export const d = 4;\n');
    git(multi.path, 'add .');
    git(multi.path, 'commit -q -m "fix: add d module"');
    const newHead = git(multi.path, 'rev-parse HEAD');

    // Set lastAnalyzedCommit to the previous head (simulating a prior apply)
    // We need to write to projects.json directly so the next scan uses incremental mode.
    const cur = JSON.parse(fs.readFileSync(PROJECTS_JSON, 'utf-8'));
    cur[TEMP_SLUG].lastAnalyzedCommit = multi.headCommit;
    fs.writeFileSync(PROJECTS_JSON, JSON.stringify(cur, null, 2) + '\n', 'utf-8');

    r = await json('POST', `/api/projects/${TEMP_SLUG}/scan`);
    assert(r.res.ok, 'scan should succeed');
    assert(r.data.mode === 'incremental', `second scan with lastAnalyzedCommit should be incremental, got ${r.data.mode}`);
    assert(r.data.pendingCount === 2, `expected 2 new pending, got ${r.data.pendingCount}`);
    assert(r.data.headCommit === newHead, 'headCommit should be updated to new HEAD');
    assert(r.data.commits[0].subject.includes('feat: add c module'), 'pending commits should be ordered oldest first');

    cfg = await getProject(TEMP_SLUG);
    assert(cfg.lastSeenCommit === newHead, 'lastSeenCommit should equal new HEAD');
    assert(cfg.lastAnalyzedCommit === multi.headCommit, 'lastAnalyzedCommit must NOT be updated by scan');

    // 3b. Team KB mode should not re-analyze commits already present in shared changes/.
    const teamKbRemote = makeRepo({ kind: 'one-commit' });
    fixtures.push(teamKbRemote);
    const teamKbPath = fs.mkdtempSync(path.join(os.tmpdir(), `kb-team-scan-clone-${process.pid}-`));
    fs.rmSync(teamKbPath, { recursive: true, force: true });
    git(DATA_DIR, ['clone', teamKbRemote.path, teamKbPath]);
    fixtures.push({ cleanup: () => fs.rmSync(teamKbPath, { recursive: true, force: true }) });
    fs.mkdirSync(path.join(teamKbRemote.path, 'changes'), { recursive: true });
    fs.writeFileSync(path.join(teamKbRemote.path, 'changes', `${newHead.slice(0, 7)}.md`), `---\ncommit: ${newHead}\n---\n# already analyzed remotely\n`, 'utf-8');
    git(teamKbRemote.path, ['add', '.']);
    git(teamKbRemote.path, ['commit', '-q', '-m', 'docs: analyze teammate commit']);
    const curTeam = JSON.parse(fs.readFileSync(PROJECTS_JSON, 'utf-8'));
    curTeam[TEMP_SLUG].knowledgeMode = 'team';
    curTeam[TEMP_SLUG].kbPath = teamKbPath;
    curTeam[TEMP_SLUG].kbStorePath = teamKbPath;
    curTeam[TEMP_SLUG].kbStoreBranch = 'main';
    fs.writeFileSync(PROJECTS_JSON, JSON.stringify(curTeam, null, 2) + '\n', 'utf-8');

    r = await json('POST', `/api/projects/${TEMP_SLUG}/scan`);
    assert(r.res.ok, 'team scan should succeed');
    assert(r.data.teamKnowledgeSync && r.data.teamKnowledgeSync.ok === true && r.data.teamKnowledgeSync.skipped === false, 'team scan should pull the team KB store before filtering');
    assert(fs.existsSync(path.join(teamKbPath, 'changes', `${newHead.slice(0, 7)}.md`)), 'team scan should pull remote team KB changes');
    assert(r.data.pendingCount === 1, `team scan should skip already-analyzed KB commits, got ${r.data.pendingCount}`);
    assert(r.data.filteredTeamAnalyzedCount === 1, `team scan should report one filtered commit, got ${r.data.filteredTeamAnalyzedCount}`);
    assert(!r.data.commits.some(c => c.hash === newHead), 'team scan should omit the commit already present in shared KB');

    const curPersonal = JSON.parse(fs.readFileSync(PROJECTS_JSON, 'utf-8'));
    curPersonal[TEMP_SLUG].knowledgeMode = 'personal';
    fs.writeFileSync(PROJECTS_JSON, JSON.stringify(curPersonal, null, 2) + '\n', 'utf-8');

    // 4. No new commits since lastAnalyzedCommit → 0 pending.
    // (The scanner uses lastAnalyzedCommit as the range start, not lastSeenCommit.
    //  This is by design: "pending" means "awaiting apply", not "new since last scan".)
    r = await json('POST', `/api/projects/${TEMP_SLUG}/scan`);
    assert(r.res.ok, 'scan should succeed');
    assert(r.data.pendingCount === 2, 'pendingCount is anchored to lastAnalyzedCommit, so it stays at 2');
    assert(r.data.mode === 'incremental', 'should still be incremental mode');

    // 5. Bad slug returns 400
    r = await json('POST', '/api/projects/INVALID../scan');
    assert(!r.res.ok && r.res.status === 400, 'bad slug should 400');

    // 6. GET /scan is read-only
    r = await json('GET', `/api/projects/${TEMP_SLUG}/scan`);
    assert(r.res.ok, 'GET scan should succeed');
    assert(r.data.mode === 'incremental', 'GET scan should compute pending');

    cfg = await getProject(TEMP_SLUG);
    const beforeHead = cfg.lastSeenCommit;
    const beforeAnalyzed = cfg.lastAnalyzedCommit;
    r = await json('GET', `/api/projects/${TEMP_SLUG}/scan`);
    cfg = await getProject(TEMP_SLUG);
    assert(cfg.lastSeenCommit === beforeHead, 'GET scan must not write');
    assert(cfg.lastAnalyzedCommit === beforeAnalyzed, 'GET scan must not change lastAnalyzedCommit');

    // 7. Missing lastAnalyzedCommit uses initial mode
    const cur2 = JSON.parse(fs.readFileSync(PROJECTS_JSON, 'utf-8'));
    cur2[TEMP_SLUG].lastAnalyzedCommit = null;
    fs.writeFileSync(PROJECTS_JSON, JSON.stringify(cur2, null, 2) + '\n', 'utf-8');

    r = await json('POST', `/api/projects/${TEMP_SLUG}/scan`);
    assert(r.data.mode === 'tracked', 'cleared lastAnalyzedCommit should fall back to trackingStartCommit');
    assert(r.data.pendingCount === 2, 'tracking start should report only commits after first import');

    // 8. /api/scan-all scans every enabled project
    const enabledFixture = makeRepo({ kind: 'one-commit' });
    fixtures.push(enabledFixture);
    await json('PUT', '/api/projects', {
      slug: 'task-004-scan-all',
      config: { displayName: 'scan-all', localPath: enabledFixture.path, gitPath: enabledFixture.path },
    });
    r = await json('POST', '/api/scan-all');
    assert(r.res.ok, 'scan-all should succeed');
    const allEntry = r.data.results.find(x => x.slug === 'task-004-scan-all');
    assert(allEntry && allEntry.ok, 'scan-all should include the new project');

    // cleanup extra
    const cur3 = JSON.parse(fs.readFileSync(PROJECTS_JSON, 'utf-8'));
    delete cur3['task-004-scan-all'];
    fs.writeFileSync(PROJECTS_JSON, JSON.stringify(cur3, null, 2) + '\n', 'utf-8');
    fs.rmSync(path.join(DATA_DIR, 'projects', 'task-004-scan-all'), { recursive: true, force: true });

    console.log('TASK-004 scanner test passed');
  } catch (e) {
    console.error('TASK-004 scanner test failed:', e.message);
    if (serverOutput) console.error(serverOutput);
    process.exitCode = 1;
  } finally {
    for (const f of fixtures) {
      try { f.cleanup(); } catch {}
    }
    await cleanup().catch(() => {});
    child.kill();
  }
})();
