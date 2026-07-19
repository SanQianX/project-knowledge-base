// Regression test for global pending automation sweep.
//
// A commit in one project should also dispatch automation for other projects
// with pending commits. If the triggering project already had known pending
// commits, that stale batch runs first and the current commit queues behind it.

const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP_DATA = path.join(os.tmpdir(), `kb-pending-sweep-${process.pid}-${Date.now()}`);
fs.rmSync(TMP_DATA, { recursive: true, force: true });
fs.mkdirSync(TMP_DATA, { recursive: true });
process.env.KB_DATA_DIR = TMP_DATA;
process.env.KB_SKIP_MIGRATION = '1';
const dataDir = require('../lib/data-dir');
dataDir._resetCache();

const automation = require('../lib/post-commit-automation');
const { makeRepo, git } = require('./fixtures/make-git-repos');

function assert(cond, msg) {
  if (!cond) throw new Error('ASSERT: ' + msg);
}

function write(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');
}

function addCommit(repoPath, relPath, content, message) {
  write(path.join(repoPath, relPath), content);
  git(repoPath, ['add', '.']);
  git(repoPath, ['commit', '-q', '-m', message]);
  return git(repoPath, ['rev-parse', 'HEAD']);
}

function makeProject(slug, repo, overrides = {}) {
  return {
    displayName: slug,
    localPath: repo.path,
    gitPath: repo.path,
    kbPath: path.join(TMP_DATA, 'projects', slug),
    aiProfileId: 'fake-profile',
    enabled: true,
    automation: {
      enabled: true,
      postCommitEnabled: true,
      knowledgeMode: 'autoApply',
      allowReadOnlyBash: true,
      hookPromptTemplate: '{{projectSlug}}\n{{commitRange}}\n{{pendingCommits}}',
    },
    claudeWorkbench: { permissionMode: 'default' },
    ...overrides,
  };
}

function makeDeps(projects) {
  let sessionCounter = 0;
  const started = [];
  let endCb = null;
  return {
    projects,
    defaultProjectKbPath: slug => path.join(TMP_DATA, 'projects', slug),
    validateUsableAiProfile: () => ({
      ok: true,
      profile: { id: 'fake-profile', implementation: 'claude-code-agent' },
    }),
    startAutomationSession: opts => {
      const sessionId = `sess-${++sessionCounter}`;
      const hash = opts.metadata && opts.metadata.commitHash || '';
      if (opts.kbPath && hash) {
        write(path.join(opts.kbPath, 'changes', `test-${hash.slice(0, 7)}.md`), `---\ncommit: ${hash}\n---\n\n# ${hash.slice(0, 7)}\n`);
      }
      started.push({ sessionId, opts });
      return { sessionId };
    },
    onSessionEnded: cb => {
      endCb = cb;
      return () => { endCb = null; };
    },
    readProjects: () => projects,
    writeProjects: next => {
      if (next && next !== projects) {
        for (const key of Object.keys(projects)) delete projects[key];
        Object.assign(projects, next);
      }
    },
    triggerEnd: (sessionId, state = 'idle') => {
      const startedSession = started.find(item => item.sessionId === sessionId);
      if (!startedSession) throw new Error(`unknown session: ${sessionId}`);
      if (!endCb) throw new Error('missing onSessionEnded callback');
      endCb({
        sessionId,
        projectSlug: startedSession.opts.slug,
        metadata: startedSession.opts.metadata,
        state,
        exitCode: 0,
        endedAt: new Date().toISOString(),
      });
    },
    started,
  };
}

async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return null;
}

(async () => {
  const repoA = makeRepo({ kind: 'one-commit' });
  const repoB = makeRepo({ kind: 'one-commit' });
  try {
    const a0 = repoA.headCommit;
    const a1 = addCommit(repoA.path, 'old-pending.txt', 'old\n', 'feat: old pending');
    const a2 = addCommit(repoA.path, 'current.txt', 'current\n', 'feat: current trigger');
    const b0 = repoB.headCommit;
    const b1 = addCommit(repoB.path, 'other-pending.txt', 'other\n', 'feat: other pending');

    const projects = {
      trigger: makeProject('trigger', repoA, {
        lastAnalyzedCommit: a0,
        trackingStartCommit: a0,
        headCommit: a1,
        lastSeenCommit: a1,
        lastScanPendingCount: 1,
      }),
      other: makeProject('other', repoB, {
        lastAnalyzedCommit: b0,
        trackingStartCommit: b0,
        headCommit: b0,
        lastSeenCommit: b0,
        lastScanPendingCount: 0,
      }),
    };
    const deps = makeDeps(projects);

    const result = await automation.handlePostCommitEvent({
      repoPath: repoA.path,
      commitHash: a2,
      branch: 'main',
      source: 'git-hook',
    }, deps);

    assert(result.ok, 'hook dispatch should succeed: ' + JSON.stringify(result));
    assert(result.status === 'dispatched', 'oldest trigger commit should dispatch immediately');
    assert(result.pendingSweep && result.pendingSweep.dispatched === 2,
      'pending sweep should dispatch trigger stale batch and other project');

    assert(deps.started.length === 2, `expected two immediate sessions, got ${deps.started.length}`);
    const triggerStarted = deps.started.find(s => s.opts.slug === 'trigger');
    const otherStarted = deps.started.find(s => s.opts.slug === 'other');
    assert(triggerStarted, 'trigger stale pending run should start first');
    assert(otherStarted, 'other project pending run should start in parallel');
    assert(triggerStarted.opts.userPrompt.includes('feat: old pending'),
      'trigger stale prompt should include old pending commit');
    assert(!triggerStarted.opts.userPrompt.includes('feat: current trigger'),
      'trigger stale prompt must not include current trigger commit');
    assert(otherStarted.opts.userPrompt.includes('feat: other pending'),
      'other project prompt should include its pending commit');

    const triggerRuns = automation.listAutomationRuns('trigger', 10);
    const staleRun = triggerRuns.find(r => r.source === 'git-hook');
    assert(staleRun && staleRun.status === 'dispatched',
      'oldest pending trigger run should be dispatched');
    assert(triggerRuns.length === 1, 'a hook should not create an overlapping current-head run');

    assert(projects.other.lastScanPendingCount === 1,
      'sweep should refresh non-trigger project pending count');
    assert(projects.trigger.lastSeenCommit === a2,
      'current trigger scan should keep the visible project head on the current commit');
    deps.triggerEnd(triggerStarted.sessionId, 'idle');
    const resumedCurrent = await waitFor(
      () => deps.started.find(s => s.opts.slug === 'trigger' && s.sessionId !== triggerStarted.sessionId),
      5000
    );
    assert(projects.trigger.lastAnalyzedCommit === a1,
      'stale pending success should advance lastAnalyzedCommit to the stale head');
    assert(projects.trigger.lastSeenCommit === a2 && projects.trigger.headCommit === a2,
      'stale pending success must not roll visible head back from the current commit');

    assert(resumedCurrent, `the Git-backed worker should discover the next commit after the first completes; started=`
      + JSON.stringify(deps.started.map(s => ({
        slug: s.opts.slug,
        runId: s.opts.metadata && s.opts.metadata.automationRunId,
        prompt: s.opts.userPrompt,
      })))
      + ' runs=' + JSON.stringify(automation.listAutomationRuns('trigger', 10)));
    assert(resumedCurrent.opts.userPrompt.includes('feat: current trigger'),
      'resumed current run should include the current trigger commit');
    assert(!resumedCurrent.opts.userPrompt.includes('feat: old pending'),
      'resumed current run should not re-analyze the stale pending commit');

    deps.triggerEnd(resumedCurrent.sessionId, 'idle');
    deps.triggerEnd(otherStarted.sessionId, 'idle');
    await waitFor(() => projects.trigger.lastAnalyzedCommit === a2 && projects.other.lastAnalyzedCommit === b1, 5000);
    assert(projects.trigger.lastAnalyzedCommit === a2, 'trigger worker should finish the current commit');
    assert(projects.other.lastAnalyzedCommit === b1, 'global sweep worker should finish the other project commit');

    console.log('pending-sweep-test PASS');
  } finally {
    try { repoA.cleanup(); } catch {}
    try { repoB.cleanup(); } catch {}
    try { fs.rmSync(TMP_DATA, { recursive: true, force: true }); } catch {}
  }
})().catch(err => {
  console.error(err);
  process.exit(1);
});
