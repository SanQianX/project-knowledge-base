// Run: node _site/_test/claude-session-lifecycle-sweep-test.js
//
// Regression test for the stale-active-session sweep in claude-cli-runner.
//
// Without the sweeper, three failure modes leave sessions stuck in
// state=running forever after the subprocess is gone:
//   1. dashboard restart kills the SDK parent query; claude.exe becomes
//      orphaned; on reload the persisted record still says "running"
//   2. SIGKILL of the dashboard before the SDK for-await loop emits its
//      terminal message
//   3. child Claude.exe dies under IPC drop; in-memory session has
//      subprocess=null while state=running
//
// Symptom in production: a project keeps showing the pulsing "running"
// badge and the embedded terminal view stays empty because no live
// subprocess streams into it. Until the sweeper ships, the only manual
// workaround is a dashboard restart that the user has to remember.

const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), `kb-sweep-test-${process.pid}-`));
process.env.KB_DATA_DIR = TMP_DATA;
process.env.KB_STALE_ACTIVE_MS = '60000';
require(path.resolve(__dirname, '..', '..', '_site', 'lib', 'data-dir'))._resetCache();

// scanPersistedRecords discovers projects by reading projects.json first,
// falling back to listing KB_ROOT/projects/. Without either, the sweeper
// will see no candidates at all. Seed a minimal registry so every test
// "project" below is visible.
const TEST_PROJECTS = {
  'demo-zombie-persisted': { kbPath: path.join(TMP_DATA, 'projects', 'demo-zombie-persisted'), enabled: true },
  'demo-zombie-memory': { kbPath: path.join(TMP_DATA, 'projects', 'demo-zombie-memory'), enabled: true },
  'demo-fresh': { kbPath: path.join(TMP_DATA, 'projects', 'demo-fresh'), enabled: true },
  'demo-broadcast': { kbPath: path.join(TMP_DATA, 'projects', 'demo-broadcast'), enabled: true },
  'demo-callback': { kbPath: path.join(TMP_DATA, 'projects', 'demo-callback'), enabled: true },
};
fs.mkdirSync(path.join(TMP_DATA, 'projects'), { recursive: true });
for (const slug of Object.keys(TEST_PROJECTS)) {
  fs.mkdirSync(path.join(TMP_DATA, 'projects', slug), { recursive: true });
  fs.mkdirSync(path.join(TMP_DATA, '_ai', slug, 'claude-workbench'), { recursive: true });
}
fs.writeFileSync(path.join(TMP_DATA, 'projects.json'), JSON.stringify(TEST_PROJECTS, null, 2) + '\n', 'utf-8');
fs.writeFileSync(path.join(TMP_DATA, 'claude-prompts.json'), '{"schema":"prompts/v1","prompts":{}}', 'utf-8');

const runner = require('../lib/claude-cli-runner');
const {
  createSession,
  demoteStaleActiveSessions,
  ACTIVE_STATES,
  TERMINAL_STATES,
  listSessions,
  subscribeList,
} = runner;

function assert(cond, msg) { if (!cond) throw new Error('ASSERT: ' + msg); }

function writePersistedRecord(projectSlug, record) {
  const aiDir = path.join(TMP_DATA, '_ai', projectSlug, 'claude-workbench');
  fs.mkdirSync(aiDir, { recursive: true });
  const target = path.join(aiDir, `${record.sessionId}.json`);
  // Default updatedAt to the same stale time used for startedAt so the
  // sweeper treats the record as orphan-aged. Callers can override either.
  const longAgo = record.startedAt || new Date(Date.now() - 10 * 60 * 1000).toISOString();
  fs.writeFileSync(target, JSON.stringify({
    schema: 'claude-workbench-session/v1',
    updatedAt: record.updatedAt || longAgo,
    ...record,
  }, null, 2) + '\n', 'utf-8');
  return target;
}

function makeStalePersistedRecord(projectSlug, sessionId, state) {
  const longAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  return writePersistedRecord(projectSlug, {
    sessionId,
    projectSlug,
    projectPath: 'D:/proj/' + projectSlug,
    kbPath: path.join(TMP_DATA, 'projects', projectSlug),
    promptKey: 'post-commit-automation',
    runner: 'sdk',
    state,
    startedAt: longAgo,
    endedAt: null,
    exitCode: null,
    turns: 1,
    error: null,
    pendingPermission: null,
    source: 'git-hook',
    automation: true,
    automationRunId: 'auto-test-1',
    metadata: { source: 'git-hook', automation: true, automationRunId: 'auto-test-1' },
    permissionMode: 'bypassPermissions',
    events: [{ type: 'claude/system-prompt', text: 'fake', promptKey: 'post-commit-automation' }],
  });
}

(() => {
  // The sweeper itself is the unit under test.
  assert(typeof demoteStaleActiveSessions === 'function',
    'demoteStaleActiveSessions must be exported');
  assert(ACTIVE_STATES.has('running'),
    'ACTIVE_STATES must include running');
  assert(TERMINAL_STATES.has('failed'),
    'TERMINAL_STATES must include failed');

  // (1) Persisted record that's been "running" for 10 minutes with no live
  // subprocess — must be demoted. The user's exact scenario: dashboard
  // restart orphaned the SDK parent query and the record on disk still
  // says running.
  {
    const sessionId = 'sess-zombie-persisted-' + Date.now();
    makeStalePersistedRecord('demo-zombie-persisted', sessionId, 'running');

    const demoted = demoteStaleActiveSessions({ thresholdMs: 60 * 1000 });
    const hit = demoted.find(d => d.sessionId === sessionId);
    assert(hit, 'sweeper should have demoted the persisted zombie');
    assert(hit.source === 'persisted', `expected source=persisted, got ${hit.source}`);

    // The rehydrated session in memory should now show failed + endedAt.
    const state = runner.getState(sessionId);
    assert(state.state === 'failed',
      `expected state=failed after sweep, got ${state.state}`);
    assert(state.endedAt, 'endedAt should be set after demotion');
    assert(state.error && /subprocess lost/i.test(state.error),
      `error message should explain the orphan, got ${state.error}`);

    // Subsequent sweeps should be idempotent — already-failed sessions are
    // not in ACTIVE_STATES so they don't get touched again.
    const secondSweep = demoteStaleActiveSessions({ thresholdMs: 60 * 1000 });
    const hitAgain = secondSweep.find(d => d.sessionId === sessionId);
    assert(!hitAgain,
      `sweeper must not re-demote already-failed session (hit again: ${JSON.stringify(secondSweep)})`);
  }

  // (2) In-memory session with state=running AND subprocess=null AND a
  // stale updatedAt — must be demoted. This is the runtime-orphan case:
  // SDK query was kicked off, but the subprocess ref was cleared without
  // a terminal setState (e.g. the dashboard process died between the
  // subprocess=null assignment and the setState(failed) on the catch path).
  {
    const projectSlug = 'demo-zombie-memory';
    const session = createSession({
      projectSlug,
      projectPath: 'D:/proj/' + projectSlug,
      kbPath: path.join(TMP_DATA, 'projects', projectSlug),
      promptKey: 'post-commit-automation',
      source: 'git-hook',
      metadata: { source: 'git-hook', automation: true, automationRunId: 'auto-mem' },
    });
    // Force it into the orphan shape: state=running, subprocess=null,
    // updatedAt way in the past.
    session.state = 'running';
    session.subprocess = null;
    session.updatedAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    session.startedAt = session.updatedAt;

    const demoted = demoteStaleActiveSessions({ thresholdMs: 60 * 1000 });
    const hit = demoted.find(d => d.sessionId === session.sessionId);
    assert(hit, 'sweeper should have demoted the in-memory zombie');
    assert(hit.source === 'memory', `expected source=memory, got ${hit.source}`);

    const state = runner.getState(session.sessionId);
    assert(state.state === 'failed',
      `expected in-memory session to be failed, got ${state.state}`);
    assert(state.error && /subprocess exited/i.test(state.error),
      `expected subprocess-null error, got ${state.error}`);
  }

  // (3) Fresh session (started 5s ago) must NOT be demoted even if
  // subprocess happens to be null. Threshold exists exactly to keep
  // legitimately-thinking sessions from being killed prematurely.
  {
    const projectSlug = 'demo-fresh';
    const session = createSession({
      projectSlug,
      projectPath: 'D:/proj/' + projectSlug,
      kbPath: path.join(TMP_DATA, 'projects', projectSlug),
      promptKey: 'post-commit-automation',
      source: 'git-hook',
      metadata: { source: 'git-hook', automation: true, automationRunId: 'auto-fresh' },
    });
    session.state = 'running';
    session.subprocess = null;
    // updatedAt defaults to createdAt via createSession, well under 60s old.

    const demoted = demoteStaleActiveSessions({ thresholdMs: 60 * 1000 });
    const hit = demoted.find(d => d.sessionId === session.sessionId);
    assert(!hit,
      `fresh session (age <60s) must NOT be demoted; demoted list = ${JSON.stringify(demoted)}`);

    // Cleanup so it doesn't leak into the next test.
    runner.deleteSession(session.sessionId);
  }

  // (4) Demotion must fire the global SSE broadcast so the UI sees the
  // running→failed transition. Without this the blue light stays on even
  // after the in-memory state is wrong.
  {
    const projectSlug = 'demo-broadcast';
    const broadcastEvents = [];
    subscribeList(ev => broadcastEvents.push(ev));

    const sessionId = 'sess-broadcast-' + Date.now();
    makeStalePersistedRecord(projectSlug, sessionId, 'running');

    demoteStaleActiveSessions({ thresholdMs: 60 * 1000 });
    const sawTransition = broadcastEvents.some(
      ev => ev.sessionId === sessionId && ev.state === 'failed' && ev.kind === 'stale-active-sweep'
    );
    assert(sawTransition,
      `expected SSE broadcast for ${sessionId} with state=failed kind=stale-active-sweep; got ${JSON.stringify(broadcastEvents)}`);
  }

  // (5) The onSessionEnded hook must fire for failed sessions, so the
  // automation queue (post-commit-automation.js) can promote the next
  // queued run. Without this, stranded sessions would also strand any
  // queued successor forever.
  {
    const projectSlug = 'demo-callback';
    const sessionId = 'sess-callback-' + Date.now();
    makeStalePersistedRecord(projectSlug, sessionId, 'running');

    let endedWithFailed = null;
    const off = runner.onSessionEnded(s => {
      if (s.sessionId === sessionId && s.state === 'failed') {
        endedWithFailed = s;
      }
    });

    demoteStaleActiveSessions({ thresholdMs: 60 * 1000 });
    // onSessionEnded fires via setImmediate, so wait one tick.
    return Promise.resolve()
      .then(() => new Promise(resolve => setImmediate(resolve)))
      .then(() => {
        off();
        assert(endedWithFailed,
          `onSessionEnded should have fired for the demoted session`);
        assert(endedWithFailed.sessionId === sessionId,
          `wrong sessionId in callback: ${endedWithFailed && endedWithFailed.sessionId}`);
      });
  }
})().then(() => {
  console.log('claude-session-lifecycle-sweep-test PASS');
}).catch(e => {
  console.error(e.stack || e.message);
  process.exit(1);
});
