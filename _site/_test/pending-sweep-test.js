// Regression: one Git commit must create exactly one serialized automation
// task, and repeated Hook/startup reconciliation must not dispatch it again.

const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP_DATA = path.join(os.tmpdir(), `kb-commit-reconcile-${process.pid}-${Date.now()}`);
fs.mkdirSync(TMP_DATA, { recursive: true });
process.env.KB_DATA_DIR = TMP_DATA;
process.env.KB_SKIP_MIGRATION = '1';
const dataDir = require('../lib/data-dir');
dataDir._resetCache();

const automation = require('../lib/post-commit-automation');
const commitStore = require('../lib/commit-automation-store');
const { makeRepo, git } = require('./fixtures/make-git-repos');

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERT: ${message}`);
}

function addCommit(repoPath, name, subject) {
  fs.writeFileSync(path.join(repoPath, name), `${subject}\n`, 'utf-8');
  git(repoPath, ['add', name]);
  git(repoPath, ['commit', '-q', '-m', subject]);
  return git(repoPath, ['rev-parse', 'HEAD']);
}

function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const check = () => {
      const value = predicate();
      if (value) return resolve(value);
      if (Date.now() >= deadline) return reject(new Error('timed out waiting for automation'));
      setTimeout(check, 20);
    };
    check();
  });
}

(async () => {
  const repo = makeRepo({ kind: 'one-commit' });
  try {
    const baseline = repo.headCommit;
    const commits = [
      addCommit(repo.path, 'one.txt', 'feat: commit one'),
      addCommit(repo.path, 'two.txt', 'feat: commit two'),
      addCommit(repo.path, 'three.txt', 'feat: commit three'),
    ];
    const slug = 'serial-project';
    const projects = {
      [slug]: {
        displayName: 'Serial Project',
        enabled: true,
        localPath: repo.path,
        gitPath: repo.path,
        kbPath: path.join(TMP_DATA, 'projects', slug),
        aiProfileId: 'fake-profile',
        trackingStartCommit: baseline,
        lastAnalyzedCommit: baseline,
        automation: {
          enabled: true,
          postCommitEnabled: true,
          allowReadOnlyBash: true,
          hookPromptTemplate: '{{commitHash}}\n{{commitSubject}}\n{{changedFiles}}',
        },
        claudeWorkbench: { permissionMode: 'default' },
      },
    };

    const started = [];
    let ended = null;
    let sessionCounter = 0;
    const deps = {
      projects,
      defaultProjectKbPath: projectSlug => path.join(TMP_DATA, 'projects', projectSlug),
      validateUsableAiProfile: () => ({ ok: true, profile: { id: 'fake-profile' } }),
      startAutomationSession: options => {
        const sessionId = `session-${++sessionCounter}`;
        started.push({ sessionId, options });
        return { sessionId };
      },
      onSessionEnded: callback => {
        ended = callback;
        return () => {};
      },
      readProjects: () => projects,
      writeProjects: () => {},
    };

    const first = await automation.handlePostCommitEvent({
      repoPath: repo.path,
      commitHash: commits[2],
      source: 'git-hook',
    }, deps);
    assert(first.ok && first.dispatched === 3, 'first Hook should discover three commit tasks');
    assert(started.length === 1, 'only the oldest commit should start immediately');
    assert(automation.getQueueSize(slug) === 2, 'the remaining commits should be queued');

    const repeated = await Promise.all([
      automation.handlePostCommitEvent({ repoPath: repo.path, commitHash: commits[2], source: 'git-hook' }, deps),
      automation.reconcileProject(slug, projects[slug], deps, 'startup-recovery'),
    ]);
    assert(repeated.every(result => result.dispatched === 0), 'repeated reconciliation must dispatch no duplicate');
    assert(started.length === 1 && automation.getQueueSize(slug) === 2, 'repeat must not alter active/queued task counts');

    for (let index = 0; index < commits.length; index += 1) {
      const current = await waitFor(() => started[index]);
      const prompt = current.options.userPrompt;
      assert(prompt.includes(commits[index]), `task ${index + 1} should target its exact commit`);
      for (let other = 0; other < commits.length; other += 1) {
        if (other !== index) {
          assert(!prompt.includes(commits[other]), `task ${index + 1} must not include commit ${other + 1}`);
        }
      }
      ended({
        sessionId: current.sessionId,
        projectSlug: slug,
        metadata: current.options.metadata,
        state: 'idle',
        exitCode: 0,
        endedAt: new Date().toISOString(),
      });
    }

    await waitFor(() => commitStore.summary(slug).completed === 3);
    assert(commitStore.summary(slug).pending === 0, 'all completed commits should leave zero pending');
    assert(projects[slug].lastAnalyzedCommit === commits[2], 'pointer should advance to the newest completed commit');
    assert(automation.getQueueSize(slug) === 0, 'queue should drain after completion');

    const afterComplete = await automation.handlePostCommitEvent({
      repoPath: repo.path,
      commitHash: commits[2],
      source: 'git-hook',
    }, deps);
    assert(afterComplete.dispatched === 0 && started.length === 3, 'completed commits must never be re-dispatched');

    const failedCommit = addCommit(repo.path, 'four.txt', 'feat: commit four fails once');
    const blockedCommit = addCommit(repo.path, 'five.txt', 'feat: commit five waits');
    const withFailure = await automation.handlePostCommitEvent({
      repoPath: repo.path,
      commitHash: blockedCommit,
      source: 'git-hook',
    }, deps);
    assert(withFailure.dispatched === 2 && started.length === 4, 'two new commits should be active + queued');
    const failingSession = started[3];
    ended({
      sessionId: failingSession.sessionId,
      projectSlug: slug,
      metadata: failingSession.options.metadata,
      state: 'failed',
      exitCode: 1,
      error: 'transient failure',
      endedAt: new Date().toISOString(),
    });
    await waitFor(() => commitStore.summary(slug).failed === 1);
    assert(started.length === 4, 'a failed predecessor must pause later commits');
    assert(automation.getQueueSize(slug) === 0, 'paused queue should release its in-memory slot');
    assert(commitStore.pending(slug).some(item => item.hash === blockedCommit), 'later commit should return to discovered state');
    assert(projects[slug].lastAnalyzedCommit === commits[2], 'failure must not advance the contiguous pointer');

    const retry = await automation.reconcileProject(slug, projects[slug], deps, 'startup-recovery');
    assert(retry.dispatched === 2, 'recovery should retry the failed commit and its successor');
    const retriedFailure = await waitFor(() => started[4]);
    assert(retriedFailure.options.metadata.commitHash === failedCommit, 'failed commit should retry first');
    ended({
      sessionId: retriedFailure.sessionId,
      projectSlug: slug,
      metadata: retriedFailure.options.metadata,
      state: 'idle',
      exitCode: 0,
      endedAt: new Date().toISOString(),
    });
    const resumedSuccessor = await waitFor(() => started[5]);
    assert(resumedSuccessor.options.metadata.commitHash === blockedCommit, 'successor should resume only after retry succeeds');
    ended({
      sessionId: resumedSuccessor.sessionId,
      projectSlug: slug,
      metadata: resumedSuccessor.options.metadata,
      state: 'idle',
      exitCode: 0,
      endedAt: new Date().toISOString(),
    });
    await waitFor(() => commitStore.summary(slug).completed === 5);
    assert(projects[slug].lastAnalyzedCommit === blockedCommit, 'pointer should advance after the gap is closed');

    commitStore.discover(slug, [{
      hash: 'a'.repeat(40),
      short: 'aaaaaaa',
      date: '2026-01-01',
      author: 'test',
      subject: 'interrupted',
    }]);
    commitStore.claim(slug, { hash: 'a'.repeat(40) }, 'run-interrupted');
    commitStore.markRunning(slug, 'a'.repeat(40), { runId: 'run-interrupted', sessionId: 'session-interrupted' });
    assert(commitStore.recoverInterrupted(slug) === 1, 'startup should recover one interrupted task');
    assert(commitStore.pending(slug).some(item => item.hash === 'a'.repeat(40)), 'recovered task should be dispatchable again');

    console.log('pending-sweep-test PASS');
  } finally {
    try { repo.cleanup(); } catch {}
    fs.rmSync(TMP_DATA, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error);
  process.exit(1);
});
