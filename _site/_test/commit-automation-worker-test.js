const fs = require('fs');
const os = require('os');
const path = require('path');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-commit-worker-'));
process.env.KB_DATA_DIR = path.join(temp, 'data');
process.env.KB_SKIP_MIGRATION = '1';
const dataDir = require('../lib/data-dir');
dataDir._resetCache();

const automation = require('../lib/post-commit-automation');
const { makeRepo, git } = require('./fixtures/make-git-repos');

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERT: ${message}`);
}

function write(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

function addCommit(repoPath, name, message) {
  write(path.join(repoPath, name), `${message}\n`);
  git(repoPath, ['add', '.']);
  git(repoPath, ['commit', '-q', '-m', message]);
  return git(repoPath, ['rev-parse', 'HEAD']);
}

async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return null;
}

(async () => {
  const repo = makeRepo({ kind: 'one-commit' });
  try {
    const baseline = repo.headCommit;
    const c1 = addCommit(repo.path, 'c1.txt', 'feat: c1');
    const c2 = addCommit(repo.path, 'c2.txt', 'fix: c2');
    const kbPath = path.join(temp, 'knowledge');
    write(path.join(kbPath, 'README.md'), '# Knowledge\n');

    const slug = 'worker';
    const projects = {
      [slug]: {
        displayName: slug,
        localPath: repo.path,
        gitPath: repo.path,
        kbPath,
        enabled: true,
        trackingStartCommit: baseline,
        lastAnalyzedCommit: baseline,
        aiProfileId: 'fake',
        automation: {
          enabled: true,
          postCommitEnabled: true,
          knowledgeMode: 'autoApply',
          allowReadOnlyBash: true,
        },
        claudeWorkbench: { permissionMode: 'default' },
      },
    };
    const started = [];
    let ended = null;
    let vectorCalls = 0;
    let failVector = false;
    const deps = {
      projects,
      defaultProjectKbPath: () => kbPath,
      validateUsableAiProfile: () => ({ ok: true, profile: { id: 'fake' } }),
      startAutomationSession: opts => {
        const sessionId = `session-${started.length + 1}`;
        const hash = opts.metadata.commitHash;
        write(path.join(opts.kbPath, 'changes', `commit-${hash.slice(0, 7)}.md`), `---\ncommit: ${hash}\n---\n\n# ${hash.slice(0, 7)}\n`);
        started.push({ sessionId, opts });
        return { sessionId };
      },
      onSessionEnded: callback => { ended = callback; return () => {}; },
      readProjects: () => projects,
      writeProjects: () => {},
      onKnowledgeUpdated: async () => {
        vectorCalls += 1;
        if (failVector) throw new Error('fake vector failure');
        return { indexed: true };
      },
    };

    const first = await automation.handlePostCommitEvent({
      repoPath: repo.path,
      commitHash: c2,
      branch: 'main',
      source: 'git-hook',
    }, deps);
    assert(first.status === 'dispatched', 'oldest pending commit should start');
    assert(started.length === 1, 'only one Claude session should start');
    assert(started[0].opts.metadata.commitHash === c1, 'C1 must run before C2');
    assert(!fs.existsSync(path.join(kbPath, 'changes')), 'Claude writes must stay in staging while analysis runs');

    const duplicate = await automation.handlePostCommitEvent({
      repoPath: repo.path,
      commitHash: c2,
      branch: 'main',
      source: 'git-hook',
    }, deps);
    assert(duplicate.busy === true, 'duplicate hooks should only wake the active project worker');
    assert(started.length === 1, 'duplicate hooks must not create overlapping runs');

    ended({
      sessionId: started[0].sessionId,
      projectSlug: slug,
      metadata: started[0].opts.metadata,
      state: 'idle',
      exitCode: 0,
      endedAt: new Date().toISOString(),
    });
    const second = await waitFor(() => started[1]);
    assert(second && second.opts.metadata.commitHash === c2, 'worker should start C2 only after C1 fully completes');
    assert(projects[slug].lastAnalyzedCommit === c1, 'C1 checkpoint should advance after Markdown and vectors succeed');
    assert(fs.existsSync(path.join(kbPath, 'changes', `commit-${c1.slice(0, 7)}.md`)), 'C1 needs its own changes record');

    failVector = true;
    ended({
      sessionId: second.sessionId,
      projectSlug: slug,
      metadata: second.opts.metadata,
      state: 'idle',
      exitCode: 0,
      endedAt: new Date().toISOString(),
    });
    const indexPending = await waitFor(() => automation.listAutomationRuns(slug, 20).find(run => run.commitHash === c2 && run.status === 'index-pending'));
    assert(indexPending, 'vector failure should persist an index-pending recovery record');
    assert(projects[slug].lastAnalyzedCommit === c1, 'vector failure must not advance the Git checkpoint');
    assert(started.length === 2, 'vector failure must not call Claude again');
    assert(fs.existsSync(path.join(kbPath, 'changes', `commit-${c2.slice(0, 7)}.md`)), 'validated C2 Markdown should remain available for index retry');

    failVector = false;
    await automation.resumePendingFinalizations(projects, deps);
    assert(projects[slug].lastAnalyzedCommit === c2, 'index recovery should finish C2 without re-analysis');
    assert(started.length === 2, 'index recovery must not create another Claude session');
    assert(vectorCalls === 3, 'C1 index, failed C2 index, and recovered C2 index should be the only vector calls');

    const c3 = addCommit(repo.path, 'c3.txt', 'docs: c3');
    const third = await automation.wakeProjectAutomation(slug, { source: 'git-hook' }, deps);
    assert(third.status === 'dispatched' && started[2].opts.metadata.commitHash === c3, 'C3 should start normally');
    ended({
      sessionId: started[2].sessionId,
      projectSlug: slug,
      metadata: started[2].opts.metadata,
      state: 'aborted',
      exitCode: null,
      endedAt: new Date().toISOString(),
    });
    await waitFor(() => automation.listAutomationRuns(slug, 20).some(run => run.commitHash === c3 && run.status === 'aborted'));
    assert(projects[slug].lastAnalyzedCommit === c2, 'aborting C3 must keep the previous checkpoint');
    assert(!fs.existsSync(path.join(kbPath, 'changes', `commit-${c3.slice(0, 7)}.md`)), 'aborted staged Markdown must not reach the live KB');

    console.log('commit-automation-worker-test PASS');
  } finally {
    try { repo.cleanup(); } catch {}
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error.stack || error);
  process.exit(1);
});
