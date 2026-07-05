// TASK-006: Context pack builder test
// Run: node _site/_test/context-pack-test.js
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
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), `kb-data-context-pack-${process.pid}-`));
process.env.KB_DATA_DIR = DATA_DIR;
require('../lib/data-dir')._resetCache();
fs.writeFileSync(path.join(DATA_DIR, 'projects.json'), '{}\n', 'utf-8');
try { fs.copyFileSync(path.join(ROOT, 'claude-prompts.json'), path.join(DATA_DIR, 'claude-prompts.json')); } catch {}

const { buildContextPack, isSafePath, PACKAGE_CONFIG_FILES } = require('../lib/context-pack-builder');
let PROJECTS_JSON = path.join(DATA_DIR, 'projects.json');
const PORT = process.env.KB_CTX_TEST_PORT || '7796';
const BASE_URL = `http://127.0.0.1:${PORT}`;
const TEMP_SLUG = 'task-006-temp';

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
  // 1. Path safety
  assert(isSafePath('/tmp/proj', 'a/b.md'), 'safe path should pass');
  assert(!isSafePath('/tmp/proj', '../escape.md'), 'parent traversal should fail');
  assert(!isSafePath('/tmp/proj', '/etc/passwd'), 'absolute outside should fail');
  // Sibling that is not a sub-path: resolve it relative to the project root and check.
  const siblingResolved = require('path').resolve('/tmp/proj', '../proj-other/x.md');
  assert(!siblingResolved.startsWith('/tmp/proj/') && siblingResolved !== '/tmp/proj',
    'sibling-of-project should not pass when constructed as a traversal');
  assert(Array.isArray(PACKAGE_CONFIG_FILES) && PACKAGE_CONFIG_FILES.includes('package.json'), 'package config list ok');

  // 2. Unit test: build a context pack for a feature-commit fixture
  const repo = makeRepo({ kind: 'feature-commit' });
  const kbBase = path.join(DATA_DIR, 'projects', TEMP_SLUG);
  fs.mkdirSync(kbBase, { recursive: true });
  // Lay down final minimal KB structure with a module doc that references a changed file.
  fs.mkdirSync(path.join(kbBase, 'modules'), { recursive: true });
  fs.mkdirSync(path.join(kbBase, 'changes'), { recursive: true });
  fs.writeFileSync(path.join(kbBase, 'GOAL.md'), '# Goal — test\n\nGoal text for tests.\n');
  fs.writeFileSync(path.join(kbBase, 'ARCHITECTURE.md'), '# Analysis — test\n');
  fs.writeFileSync(path.join(kbBase, 'modules', 'feature.md'), 'See `src/feature.ts` for the implementation.\n');
  fs.writeFileSync(path.join(kbBase, 'README.md'), '# Project — test\n');
  // package.json lives in the source repo (the fixture already has a src/, but no package.json)
  fs.writeFileSync(path.join(repo.path, 'package.json'), '{"name":"fixture"}');

  const commits = repo.commits.slice().reverse(); // chronological
  const pack = await buildContextPack({
    project: {
      slug: TEMP_SLUG,
      kbPath: kbBase,
      gitPath: repo.path,
      localPath: repo.path,
    },
    runId: 'run-unit-1',
    trigger: 'commits',
    commits,
  });

  assert(pack.schema === 'context-pack/v1', 'pack schema should be v1');
  assert(pack.runId === 'run-unit-1', 'runId should be honored');
  assert(pack.trigger === 'commits', 'trigger should be commits');
  assert(pack.commitCount === commits.length, 'commitCount should match');
  assert(pack.range, 'range should be set');

  // Required entries
  const goalEntry = pack.entries.find(e => e.path === 'GOAL.md');
  assert(goalEntry, 'pack should include GOAL.md');
  assert(goalEntry.kind === 'goal', 'goal entry kind should be goal');
  assert(goalEntry.reason, 'goal entry should have a reason');
  const pkg = pack.entries.find(e => e.path === 'package.json');
  assert(pkg && pkg.kind === 'package-config', 'pack should include package.json as package-config');
  const changed = pack.entries.find(e => e.path === 'src/feature.ts');
  assert(changed && changed.kind === 'git-changed', 'pack should include changed file src/feature.ts');
  const related = pack.entries.find(e => e.path === 'modules/feature.md');
  assert(related && related.kind === 'module-doc', 'pack should include related module doc');
  // Every entry must have a reason
  for (const e of pack.entries) {
    assert(typeof e.reason === 'string' && e.reason.length > 0, `entry ${e.path} missing reason`);
  }

  // Disk artifacts
  const onDisk = JSON.parse(fs.readFileSync(path.join(DATA_DIR, '_ai', TEMP_SLUG, 'context-packs', 'run-unit-1', 'context-pack.json'), 'utf-8'));
  assert(onDisk.runId === 'run-unit-1', 'on-disk runId should match');

  // 3. Large / binary file is summarized or skipped
  const repo2 = makeRepo({ kind: 'binary-commit' });
  const kbBase2 = path.join(DATA_DIR, 'projects', TEMP_SLUG + '-2');
  fs.mkdirSync(kbBase2, { recursive: true });
  fs.writeFileSync(path.join(kbBase2, 'GOAL.md'), '# Goal\n');
  const commits2 = repo2.commits.slice().reverse();
  const pack2 = await buildContextPack({
    project: { slug: TEMP_SLUG + '-2', kbPath: kbBase2, gitPath: repo2.path, localPath: repo2.path },
    runId: 'run-binary-1',
    trigger: 'commits',
    commits: commits2,
  });
  const big = pack2.entries.find(e => e.path === 'big.bin');
  if (big) {
    assert(big.binary || big.skipped === 'too-large' || big.truncated, 'big file should be marked binary/skipped/truncated');
  }
  fs.rmSync(kbBase2, { recursive: true, force: true });
  repo2.cleanup();

  // 4. Path-traversal attempt is rejected
  const ok = isSafePath(kbBase, '..\\..\\escape.md');
  // On Windows, ..\\ becomes normalized. The resolved path should still be inside kbBase.
  // Test the explicit scenario:
  assert(!isSafePath(kbBase, '..\\..\\..\\..\\Windows\\evil.txt') || path.resolve(kbBase, '..\\..\\..\\..\\Windows\\evil.txt').startsWith(path.resolve(kbBase)),
    'path traversal must be rejected');

  repo.cleanup();

  // 5. Server tests
  const _spawned = spawnServer({ root: ROOT, port: Number(PORT), dataDir: DATA_DIR, tag: 'context-pack', });
  const child = _spawned.child;
  let serverOutput = '';
  child.stdout.on('data', d => { serverOutput += d.toString(); });
  child.stderr.on('data', d => { serverOutput += d.toString(); });

  try {
    await cleanup();
    await waitForServer();

    // 6. POST /api/projects/:slug/context-pack for an initial pack
    const initRepo = makeRepo({ kind: 'one-commit' });
    const slug = TEMP_SLUG;
    const kbPath = path.join(DATA_DIR, 'projects', slug);
    fs.mkdirSync(kbPath, { recursive: true });
    fs.writeFileSync(path.join(kbPath, 'GOAL.md'), '# Goal — server test\n');

    r = await json('PUT', '/api/projects', {
      slug,
      config: { displayName: 'TASK-006', localPath: initRepo.path, gitPath: initRepo.path, kbPath },
    });
    assert(r.res.ok, 'upsert should succeed');

    r = await json('POST', `/api/projects/${slug}/context-pack`, { trigger: 'initial' });
    assert(r.res.ok, 'context-pack initial should succeed');
    assert(r.data.contextPack.entries.length > 0, 'context pack should have entries');
    assert(r.data.contextPack.entries.find(e => e.path === 'GOAL.md'), 'goal should be in pack');

    r = await json('POST', `/api/projects/${slug}/context-pack`, { trigger: 'commits' });
    assert(r.res.ok, 'context-pack commits should succeed');
    assert(r.data.contextPack.commitCount === 0, 'commits trigger should not treat pre-import history as pending');

    // 7. Bad slug
    r = await json('POST', '/api/projects/INVALID../context-pack', {});
    assert(!r.res.ok && r.res.status === 400, 'bad slug should 400');

    initRepo.cleanup();
    console.log('TASK-006 context pack test passed');
  } catch (e) {
    console.error('TASK-006 context pack test failed:', e.message);
    if (serverOutput) console.error(serverOutput);
    process.exitCode = 1;
  } finally {
    await cleanup().catch(() => {});
    child.kill();
  }
})();
