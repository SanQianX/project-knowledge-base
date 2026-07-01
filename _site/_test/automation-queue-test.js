// _site/_test/automation-queue-test.js
//
// Regression tests for per-project automation queue + restart cleanup.
//
// Covers:
//   1. Same-slug concurrent triggers → second one queues
//   2. Different slugs → both dispatch immediately (concurrent)
//   3. cleanupOrphanedRuns marks queued/dispatched/dispatching as abandoned
//   4. maxQueueSize overflow → 429 + record marked abandoned
//   5. End-of-session hook promotes next queued run
//   6. drainQueue drops only queued (not active)
//
// Uses fake deps (no real server, no real Claude SDK).

const fs = require('fs');
const path = require('path');
const os = require('os');

// ---- Isolated data dir BEFORE requiring anything that touches aiWorkspace ----
const TMP_DATA = path.join(os.tmpdir(), `kb-queue-test-${process.pid}-${Date.now()}`);
fs.rmSync(TMP_DATA, { recursive: true, force: true });
fs.mkdirSync(TMP_DATA, { recursive: true });
process.env.KB_DATA_DIR = TMP_DATA;
process.env.KB_SKIP_MIGRATION = '1';
const dataDir = require('../lib/data-dir');
dataDir._resetCache();

const { createAutomationQueue } = require('../lib/automation-queue');
const postCommitAutomation = require('../lib/post-commit-automation');

let pass = 0;
let fail = 0;
const failures = [];

function assert(cond, msg) {
  if (!cond) throw new Error('ASSERT: ' + msg);
}
function assertEqual(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`ASSERT: ${msg}\n  expected: ${e}\n  actual:   ${a}`);
}
async function test(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fail++;
    failures.push({ name, error: e.message, stack: e.stack });
    console.error(`  ✗ ${name}\n      ${e.message}`);
  }
}

function makeFakeDeps(projects) {
  let sessionCounter = 0;
  const started = [];
  let endCb = null;
  const deps = {
    projects,
    defaultProjectKbPath: (slug) => path.join(TMP_DATA, 'projects', slug),
    validateUsableAiProfile: (id) => ({
      ok: true,
      status: 200,
      profile: { id: id || 'fake', implementation: 'claude-code-agent' },
    }),
    startAutomationSession: (sessionOpts) => {
      const sessionId = 'sess-' + (++sessionCounter) + '-' + Date.now();
      started.push({ sessionId, opts: sessionOpts });
      return { sessionId, runner: 'sdk', pendingPermission: null };
    },
    onSessionEnded: (cb) => {
      endCb = cb;
      return () => { endCb = null; };
    },
    readProjects: () => deps.projects,
    triggerEnd(sessionId, state = 'idle', extras = {}) {
      const s = started.find(s => s.sessionId === sessionId);
      if (!s) throw new Error('no such started session: ' + sessionId);
      if (!endCb) throw new Error('no end-callback registered');
      endCb({
        sessionId,
        projectSlug: s.opts.slug,
        metadata: s.opts.metadata,
        state,
        exitCode: extras.exitCode != null ? extras.exitCode : 0,
        endedAt: new Date().toISOString(),
        error: extras.error || null,
      });
    },
    started,
  };
  return deps;
}

function makeProject(slug, overrides = {}) {
  return {
    displayName: slug,
    // Use a non-existent repo path so renderAutomationPrompt's git calls
    // hit the early-return in execGit (cwd-missing) and resolve instantly,
    // instead of spawning real `git` processes that take 10s of ms each.
    localPath: path.join(TMP_DATA, 'nonexistent-repo-' + slug),
    gitPath: path.join(TMP_DATA, 'nonexistent-repo-' + slug),
    aiProfileId: 'fake',
    automation: {
      enabled: true,
      postCommitEnabled: true,
      knowledgeMode: 'requestApproval',
      ...(overrides.automation || {}),
    },
    claudeWorkbench: { permissionMode: 'default' },
  };
}

function listRuns(slug) {
  return postCommitAutomation.listAutomationRuns(slug, 100);
}

(async () => {
  console.log('automation-queue-test: starting');

  // -------- pure queue unit tests --------
  await test('queue: tryAcquire is exclusive per key; different keys independent', () => {
    const q = createAutomationQueue();
    assert(q.tryAcquire('a', 'r1') === true, 'first acquire on key a should succeed');
    assert(q.tryAcquire('a', 'r2') === false, 'second acquire on key a should fail');
    assert(q.tryAcquire('b', 'r3') === true, 'acquire on different key b should succeed');
    assert(q.isActive('a') && q.isActive('b'), 'both keys should be active');
    assertEqual(q.size('a'), 0, 'queue size on key a before enqueue');
  });

  await test('queue: enqueue + releaseAndNext is FIFO', () => {
    const q = createAutomationQueue();
    q.tryAcquire('k', 'r1');
    assert(q.enqueue('k', 'r2', 10), 'enqueue r2');
    assert(q.enqueue('k', 'r3', 10), 'enqueue r3');
    assertEqual(q.size('k'), 2, 'size after two enqueues');
    assertEqual(q.releaseAndNext('k'), 'r2', 'releaseAndNext pops r2');
    assertEqual(q.releaseAndNext('k'), 'r3', 'releaseAndNext pops r3');
    assertEqual(q.releaseAndNext('k'), null, 'releaseAndNext empty');
  });

  await test('queue: enqueue respects maxSize', () => {
    const q = createAutomationQueue();
    q.tryAcquire('k', 'r1');
    assert(q.enqueue('k', 'r2', 1), 'enqueue within limit');
    assert(!q.enqueue('k', 'r3', 1), 'enqueue over limit should fail');
  });

  await test('queue: drain drops queued but keeps active', () => {
    const q = createAutomationQueue();
    q.tryAcquire('k', 'r1');
    q.enqueue('k', 'r2', 10);
    q.enqueue('k', 'r3', 10);
    const dropped = q.drain('k');
    assertEqual(dropped, ['r2', 'r3'], 'drain returns queued ids');
    assert(q.isActive('k'), 'active still held after drain');
    assertEqual(q.size('k'), 0, 'queue empty after drain');
  });

  // -------- integration: dispatch + queue + end hook --------
  // NOTE: postCommitAutomation.queue is a module singleton. Each test below
  // uses a unique slug so slots don't leak across tests.

  await test('dispatch: same-slug second trigger queues', async () => {
    const slug = 'int-queue-1';
    const projects = { [slug]: makeProject(slug) };
    const deps = makeFakeDeps(projects);
    const r1 = await postCommitAutomation.dispatchAutomation({ slug, cfg: projects[slug], event: { commitHash: 'h1' }, source: 'test' }, deps);
    assert(r1.ok && r1.status === 'dispatched', 'first dispatch should run immediately, got: ' + JSON.stringify(r1));

    const r2 = await postCommitAutomation.dispatchAutomation({ slug, cfg: projects[slug], event: { commitHash: 'h2' }, source: 'test' }, deps);
    assert(r2.ok && r2.queued === true && r2.status === 'queued', 'second dispatch should queue, got: ' + JSON.stringify(r2));
    assertEqual(r2.queuePosition, 1, 'queue position');

    const runs = listRuns(slug);
    assertEqual(runs.length, 2, 'two runs persisted');
    const dispatched = runs.find(r => r.runId === r1.runId);
    const queued = runs.find(r => r.runId === r2.runId);
    assert(dispatched && dispatched.status === 'dispatched', 'first run dispatched');
    assert(queued && queued.status === 'queued', 'second run queued');

    // Cleanup: end the active session so slot releases and queue drains for
    // subsequent tests' peace of mind (the queued run will get resumed and
    // also need to end).
    deps.triggerEnd(r1.sessionId, 'idle', { exitCode: 0 });
    // Give setImmediate in setState-equivalent path a tick to fire
    await new Promise(r => setTimeout(r, 20));
    // After end, the queued run should have been promoted. Trigger its end too.
    const runs2 = listRuns(slug);
    const resumed = runs2.find(r => r.runId === r2.runId);
    assert(resumed, 'queued run record still present after promotion');
    assert(['dispatched', 'dispatching'].includes(resumed.status), 'second run promoted to dispatched/dispatching, got: ' + resumed.status);
    // Drain remaining active for cleanliness
    const sess2 = deps.started.find(s => s.opts.metadata && s.opts.metadata.automationRunId === r2.runId);
    if (sess2) {
      deps.triggerEnd(sess2.sessionId, 'idle', { exitCode: 0 });
      await new Promise(r => setTimeout(r, 20));
    }
  });

  await test('dispatch: different slugs run concurrently', async () => {
    const slugA = 'int-conc-a';
    const slugB = 'int-conc-b';
    const projects = {
      [slugA]: makeProject(slugA),
      [slugB]: makeProject(slugB),
    };
    const deps = makeFakeDeps(projects);
    const r1 = await postCommitAutomation.dispatchAutomation({ slug: slugA, cfg: projects[slugA], event: {}, source: 'test' }, deps);
    const r2 = await postCommitAutomation.dispatchAutomation({ slug: slugB, cfg: projects[slugB], event: {}, source: 'test' }, deps);
    assert(r1.ok && r1.status === 'dispatched', 'slugA dispatches');
    assert(r2.ok && r2.status === 'dispatched', 'slugB dispatches concurrently (not queued)');
    assertEqual(deps.started.length, 2, 'two sessions started');
    // Cleanup
    deps.triggerEnd(r1.sessionId, 'idle', { exitCode: 0 });
    deps.triggerEnd(r2.sessionId, 'idle', { exitCode: 0 });
    await new Promise(r => setTimeout(r, 20));
  });

  await test('end hook: marking run succeeded + promoting queued', async () => {
    const slug = 'int-promote-1';
    const projects = { [slug]: makeProject(slug) };
    const deps = makeFakeDeps(projects);
    const r1 = await postCommitAutomation.dispatchAutomation({ slug, cfg: projects[slug], event: { commitHash: 'h1' }, source: 'test' }, deps);
    const r2 = await postCommitAutomation.dispatchAutomation({ slug, cfg: projects[slug], event: { commitHash: 'h2' }, source: 'test' }, deps);
    assert(r2.queued === true, 'precondition: r2 queued');

    // End r1 successfully
    deps.triggerEnd(r1.sessionId, 'idle', { exitCode: 0 });
    await new Promise(r => setTimeout(r, 30));

    const runs = listRuns(slug);
    const finished = runs.find(r => r.runId === r1.runId);
    assert(finished.status === 'succeeded', 'r1 should be succeeded, got: ' + finished.status);
    assert(finished.endedAt, 'r1 should have endedAt');

    const promoted = runs.find(r => r.runId === r2.runId);
    assert(['dispatching', 'dispatched'].includes(promoted.status), 'r2 should be promoted, got: ' + promoted.status);

    // Cleanup
    const sess2 = deps.started.find(s => s.opts.metadata && s.opts.metadata.automationRunId === r2.runId);
    if (sess2) {
      deps.triggerEnd(sess2.sessionId, 'failed', { exitCode: 1, error: 'boom' });
      await new Promise(r => setTimeout(r, 20));
      const runsFinal = listRuns(slug);
      const failed = runsFinal.find(r => r.runId === r2.runId);
      assert(failed.status === 'failed', 'r2 should be failed after end, got: ' + failed.status);
      assert(failed.error === 'boom' || (failed.error || '').includes('boom'), 'r2 error captured');
    }
  });

  await test('overflow: maxQueueSize exceeded → 429 + abandoned', async () => {
    const slug = 'int-overflow-1';
    const projects = { [slug]: makeProject(slug, { automation: { maxQueueSize: 1 } }) };
    const deps = makeFakeDeps(projects);
    const r1 = await postCommitAutomation.dispatchAutomation({ slug, cfg: projects[slug], event: {}, source: 'test' }, deps);
    const r2 = await postCommitAutomation.dispatchAutomation({ slug, cfg: projects[slug], event: {}, source: 'test' }, deps);
    const r3 = await postCommitAutomation.dispatchAutomation({ slug, cfg: projects[slug], event: {}, source: 'test' }, deps);

    assert(r1.status === 'dispatched', 'r1 dispatched');
    assert(r2.queued === true, 'r2 queued (within maxQueueSize=1)');
    assert(r3.ok === false && r3.status === 429, 'r3 should be rejected with 429, got: ' + JSON.stringify(r3));

    const runs = listRuns(slug);
    const abandoned = runs.find(r => r.runId === r3.runId);
    assert(abandoned && abandoned.status === 'abandoned', 'r3 record marked abandoned');

    // Cleanup
    deps.triggerEnd(r1.sessionId, 'idle', { exitCode: 0 });
    await new Promise(r => setTimeout(r, 30));
    const sess2 = deps.started.find(s => s.opts.metadata && s.opts.metadata.automationRunId === r2.runId);
    if (sess2) {
      deps.triggerEnd(sess2.sessionId, 'idle', { exitCode: 0 });
      await new Promise(r => setTimeout(r, 20));
    }
  });

  await test('cleanupOrphanedRuns: marks queued/dispatched/dispatching as abandoned', async () => {
    const slug = 'int-cleanup-1';
    const projects = { [slug]: makeProject(slug) };
    const deps = makeFakeDeps(projects);

    // Pre-populate run files in various states. writeAutomationRun is exported.
    const mkRun = (runId, status) => ({
      schema: 'kb-automation-run/v1',
      runId,
      projectSlug: slug,
      source: 'test',
      repoPath: '/tmp',
      kbPath: '/tmp',
      commitHash: 'x',
      branch: 'main',
      knowledgeMode: 'requestApproval',
      permissionMode: 'default',
      status,
      sessionId: null,
      startedAt: new Date().toISOString(),
      endedAt: null,
      error: null,
      promptPreview: '',
      allowedTools: ['Read'],
    });
    postCommitAutomation.writeAutomationRun(slug, mkRun('r-dispatched', 'dispatched'));
    postCommitAutomation.writeAutomationRun(slug, mkRun('r-queued', 'queued'));
    postCommitAutomation.writeAutomationRun(slug, mkRun('r-dispatching', 'dispatching'));
    postCommitAutomation.writeAutomationRun(slug, mkRun('r-succeeded', 'succeeded'));
    postCommitAutomation.writeAutomationRun(slug, mkRun('r-failed', 'failed'));

    const summary = postCommitAutomation.cleanupOrphanedRuns(projects);
    assertEqual(summary.dispatched, 1, 'dispatched count');
    assertEqual(summary.queued, 1, 'queued count');
    assertEqual(summary.dispatching, 1, 'dispatching count');

    const runs = listRuns(slug);
    for (const id of ['r-dispatched', 'r-queued', 'r-dispatching']) {
      const r = runs.find(x => x.runId === id);
      assert(r && r.status === 'abandoned', `${id} should be abandoned, got: ${r && r.status}`);
      assert(r.endedAt, `${id} should have endedAt`);
    }
    // succeeded/failed should be untouched
    const ok1 = runs.find(x => x.runId === 'r-succeeded');
    const ok2 = runs.find(x => x.runId === 'r-failed');
    assert(ok1.status === 'succeeded', 'succeeded should be untouched');
    assert(ok2.status === 'failed', 'failed should be untouched');
  });

  await test('drainQueue: drops only queued; active keeps running', async () => {
    const slug = 'int-drain-1';
    const projects = { [slug]: makeProject(slug) };
    const deps = makeFakeDeps(projects);
    const r1 = await postCommitAutomation.dispatchAutomation({ slug, cfg: projects[slug], event: {}, source: 'test' }, deps);
    const r2 = await postCommitAutomation.dispatchAutomation({ slug, cfg: projects[slug], event: {}, source: 'test' }, deps);
    const r3 = await postCommitAutomation.dispatchAutomation({ slug, cfg: projects[slug], event: {}, source: 'test' }, deps);
    assert(r1.status === 'dispatched' && r2.queued && r3.queued, 'precondition: 1 active + 2 queued');

    const dropped = postCommitAutomation.drainQueue(slug);
    assertEqual(dropped.length, 2, 'dropped two queued runs');

    const runs = listRuns(slug);
    const d2 = runs.find(r => r.runId === r2.runId);
    const d3 = runs.find(r => r.runId === r3.runId);
    const a1 = runs.find(r => r.runId === r1.runId);
    assert(d2.status === 'abandoned' && d3.status === 'abandoned', 'queued runs marked abandoned');
    assert(a1.status === 'dispatched', 'active run untouched by drain');

    // Cleanup
    deps.triggerEnd(r1.sessionId, 'idle', { exitCode: 0 });
    await new Promise(r => setTimeout(r, 20));
  });

  await test('getQueueSize: reflects current queue depth', async () => {
    const slug = 'int-size-1';
    const projects = { [slug]: makeProject(slug) };
    const deps = makeFakeDeps(projects);
    assertEqual(postCommitAutomation.getQueueSize(slug), 0, 'empty initially');
    const r1 = await postCommitAutomation.dispatchAutomation({ slug, cfg: projects[slug], event: {}, source: 'test' }, deps);
    assertEqual(postCommitAutomation.getQueueSize(slug), 0, '0 after first dispatch (active, not queued)');
    await postCommitAutomation.dispatchAutomation({ slug, cfg: projects[slug], event: {}, source: 'test' }, deps);
    await postCommitAutomation.dispatchAutomation({ slug, cfg: projects[slug], event: {}, source: 'test' }, deps);
    assertEqual(postCommitAutomation.getQueueSize(slug), 2, '2 after two enqueues');
    // Cleanup
    deps.triggerEnd(r1.sessionId, 'idle', { exitCode: 0 });
    await new Promise(r => setTimeout(r, 30));
    const remaining = postCommitAutomation.getQueueSize(slug);
    // After promotion, queue may have 1 left (the 3rd run is still queued)
    assert(remaining <= 1, `after first end, queue should be ≤1, got ${remaining}`);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.error('\nFailures:');
    for (const f of failures) {
      console.error(`  - ${f.name}: ${f.error}`);
      if (f.stack) console.error(f.stack.split('\n').slice(1, 4).join('\n'));
    }
    process.exit(1);
  }

  // Cleanup tmp dir
  try { fs.rmSync(TMP_DATA, { recursive: true, force: true }); } catch {}
  process.exit(0);
})();
