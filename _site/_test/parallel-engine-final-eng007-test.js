'use strict';

// P-ENG-FINAL ENG-007 离线提交补偿 (offline commit compensation) acceptance driver.
//
// Case (qa-autopilot/config/test-cases.json ENG-007, P1):
//   steps:    仅停测试服务，Git提交成功后再启动。
//   expected: 1) Git不被Hook故障阻塞。
//             2) 启动对账补漏。
//             3) 已完成SHA不重跑。
//
// Real behaviour under test (real Git, real bridge, real vendored engine):
//   * the real fixture repository with a REAL post-commit hook running the real
//     ai-coding-event-bridge commit-boundary CLI as a separate OS process
//   * a broken hook (missing CLI) proves Git itself is never blocked: the
//     post-commit exit status cannot fail an already-created commit
//   * the journal is durable: while the engine process is DOWN the boundary
//     event of a real commit is written to disk by the real bridge CLI
//   * the engine's startup drain (coordinator.initialize -> drain ->
//     consumeJournal) replays the journal from cursor 0, so the commit that
//     happened while the engine was down is compensated ("启动对账补漏")
//   * the engine's processing ledger
//     (runtime/processed-commits/<projectId>/<sha>.json) blocks a completed
//     SHA from being dispatched again ("已完成SHA不重跑")
//
// Isolation: real bridge console + real vector-hub + real vendored engine on
// isolated dirs, ephemeral loopback ports, scrubbed env. The broken hook is
// installed inside the FIXTURE repository only; the user's global Git config
// and global hooks are never touched. Analyzer = deterministic stand-in (NO
// real model output). No quota access, no PAYG.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  makeLaneDir, buildFixtureRepo, installPostCommitHook, startBridge, startVector,
  startEngine, waitUntil, callJson, git, gitRun, readJsonl, saveEvidence,
  isolatedEnv, BRIDGE_CLI,
} = require('./helpers/parallel-engine-final-harness.js');
const { createStandinAnalyzer } = require('./helpers/parallel-engine-final-standin-analyzer.js');

const ARTIFACTS = process.env.PK_TEST_EVIDENCE_ROOT
  ? path.join(process.env.PK_TEST_EVIDENCE_ROOT, 'eng007')
  : path.resolve(__dirname, '../../qa-autopilot/artifacts/parallel-20261023/engine-review-r3/reruns/eng007');
const PROJECT_ID = 'project-eng007';

function findJournalFiles(root) {
  const out = [];
  const walk = dir => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.name === 'events.jsonl') out.push(absolute);
    }
  };
  walk(root);
  return out;
}

function boundaryEvents(...roots) {
  const events = [];
  const files = roots.flatMap(root => findJournalFiles(root));
  for (const file of files) {
    for (const line of fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
      const event = JSON.parse(line);
      if (event.schema === 'git-commit-boundary/v1') events.push({ file: path.basename(file), event });
    }
  }
  return events;
}

async function main() {
  const lane = makeLaneDir('eng007');
  const commands = [];
  const evidence = { caseId: 'ENG-007', laneDir: lane, phases: {}, commands };

  const fixture = buildFixtureRepo(lane, 'eng007', []);
  const knowledgePath = path.join(lane, 'knowledge-eng007');
  const storePath = path.join(knowledgePath, 'dev-conversations');
  fs.mkdirSync(storePath, { recursive: true });
  const home = path.join(lane, 'bridge-home');
  const dataDir = path.join(lane, 'engine-data');
  const vectorRoot = path.join(lane, 'vector-root');
  const eventsFile = path.join(lane, 'analyzer-events.jsonl');

  const bridge = startBridge(home);
  let engine = null;
  let vector = null;
  const analyzer = createStandinAnalyzer({ eventsFile });
  const invocationsFor = sha => readJsonl(eventsFile).filter(entry => entry.kind === 'start' && entry.commitSha === sha).length;

  try {
    const bridgeUrl = await bridge.listen();
    vector = await startVector(vectorRoot);
    const registered = await bridge.projectRegistry.addProject({ home, path: fixture.repoPath, store: storePath });
    const { repoIdentity } = await bridge.resolveRepoContext(fixture.repoPath);
    commands.push(`bridge project registered id=${registered.id.slice(0, 12)}…; bridge console on ${bridgeUrl}`);

    // ---------- Lifecycle 0: the project is registered while the engine runs ----------
    // The engine is started WITHOUT the journal consumer so the registration is
    // persisted before any startup drain can happen; then the engine process is
    // stopped - this is the "仅停测试服务" state of the case.
    engine = await startEngine({ dataDir, bridgeUrl, vectorUrl: vector.url, analyzer, consume: false });
    await engine.listen();
    engine.runtime.store.addProject({
      projectId: PROJECT_ID,
      repoPath: fixture.repoPath,
      knowledgePath,
      trackingStartCommit: fixture.baseline,
      repoIdentity,
      journalId: registered.id,
      conversationBaselineCursor: 0,
    });
    await engine.close();
    engine = null;
    const persistedProject = JSON.parse(fs.readFileSync(path.join(dataDir, 'engine-state.json'), 'utf8'))
      .projects.find(p => p.projectId === PROJECT_ID);
    assert.ok(persistedProject, 'project registration is persisted before the engine is stopped');
    commands.push('engine lifecycle 0: project registered, engine stopped (journal consumer was off during registration)');

    // ---------- Expected 1: Git is never blocked by a hook fault ----------
    const brokenHook = installPostCommitHook(fixture.repoPath, { home, mode: 'broken' });
    fs.writeFileSync(path.join(fixture.repoPath, 'offline-a.txt'), `offline feature A\n${'a'.repeat(64)}\n`);
    git(fixture.repoPath, ['add', '.']);
    const commitA = gitRun(fixture.repoPath, ['commit', '-qm', 'offline feature A']);
    assert.equal(commitA.code, 0, `Git must not be blocked by a failing hook (exit ${commitA.code}): ${commitA.stderr}`);
    const shaA = git(fixture.repoPath, ['rev-parse', 'HEAD']);
    assert.match(shaA, /^[a-f0-9]{40}$/);
    assert.match(commitA.stderr, /commit-boundary\.missing\.js/, 'the hook really failed (missing CLI reported by git)');
    assert.equal(boundaryEvents(home, storePath).filter(entry => entry.event.commitSha === shaA).length, 0, 'a failed hook writes no boundary event');
    const headAfterBrokenHook = git(fixture.repoPath, ['log', '-1', '--format=%s']);
    assert.equal(headAfterBrokenHook, 'offline feature A', 'the commit itself exists despite the hook failure');
    commands.push(`real git commit with a BROKEN hook -> exit 0, HEAD=${shaA.slice(0, 8)}, hook error surfaced in stderr`);

    // ---------- Expected 2 (part 1): the real commit lands in the journal while the engine is down ----------
    const workingHook = installPostCommitHook(fixture.repoPath, { home, mode: 'ok' });
    fs.writeFileSync(path.join(fixture.repoPath, 'offline-b.txt'), `offline feature B\n${'b'.repeat(64)}\n`);
    git(fixture.repoPath, ['add', '.']);
    const commitB = gitRun(fixture.repoPath, ['commit', '-qm', 'offline feature B']);
    assert.equal(commitB.code, 0, `real commit failed: ${commitB.stderr}`);
    const shaB = git(fixture.repoPath, ['rev-parse', 'HEAD']);
    assert.match(shaB, /^[a-f0-9]{40}$/);
    const offlineBoundaries = boundaryEvents(home, storePath).filter(entry => entry.event.commitSha === shaB);
    assert.equal(offlineBoundaries.length, 1, 'the boundary event of the offline commit is on disk');
    assert.equal(fs.existsSync(path.join(dataDir, 'engine-state.json')) ? JSON.parse(fs.readFileSync(path.join(dataDir, 'engine-state.json'), 'utf8')).journalCursors[registered.id] || 0 : 0, 0, 'the stopped engine consumed nothing');
    commands.push(`real git commit while the engine was DOWN -> exit 0, HEAD=${shaB.slice(0, 8)}, boundary event written to the journal (sequence ${offlineBoundaries[0].event.sequence})`);

    // ---------- Expected 2 (part 2): startup reconciliation compensates the missed SHA ----------
    engine = await startEngine({ dataDir, bridgeUrl, vectorUrl: vector.url, analyzer, consume: true });
    const engineUrl = await engine.listen();
    const runB = await waitUntil(async () => {
      const run = engine.runtime.store.listRuns(PROJECT_ID).find(r => r.commitSha === shaB);
      return run && run.state === 'succeeded' ? run : null;
    }, 60000, 'startup drain compensates the commit made while the engine was down');
    const cursorAfterStart = engine.runtime.store.state.journalCursors[registered.id] || 0;
    const ledgerB = path.join(dataDir, 'runtime', 'processed-commits', PROJECT_ID, `${shaB}.json`);
    const promotedB = path.join(knowledgePath, 'changes', `${shaB.slice(0, 12)}.md`);
    assert.ok(fs.existsSync(ledgerB), 'the compensated commit is written to the processing ledger');
    assert.equal(JSON.parse(fs.readFileSync(ledgerB, 'utf8')).status, 'completed');
    assert.ok(fs.existsSync(promotedB), 'the compensated commit produced promoted knowledge');
    const runAExists = engine.runtime.store.listRuns(PROJECT_ID).some(r => r.commitSha === shaA);
    evidence.phases.startupCompensation = {
      offlineCommitSha: shaB,
      journalSequence: offlineBoundaries[0].event.sequence,
      engineWasDownDuringCommit: true,
      run: { runId: runB.runId, trigger: runB.trigger, state: runB.state, phase: runB.phase, commitSha: runB.commitSha, indexState: runB.indexState, promotedAt: runB.promotedAt },
      journalCursorAfterStart: cursorAfterStart,
      ledger: { path: path.relative(dataDir, ledgerB).replace(/\\/g, '/'), status: JSON.parse(fs.readFileSync(ledgerB, 'utf8')).status },
      promotedFile: path.relative(knowledgePath, promotedB).replace(/\\/g, '/'),
      analyzerInvocationsForOfflineCommit: invocationsFor(shaB),
      hookFailedCommitSha: shaA,
      hookFailedCommitAnalyzed: runAExists,
      hookFailedCommitJournalEvents: 0,
    };
    assert.equal(runB.trigger, 'git-hook', 'the compensated run came from the journal/hook path');
    assert.ok(cursorAfterStart >= offlineBoundaries[0].event.sequence, 'the startup drain advanced the journal cursor past the offline event');
    assert.equal(invocationsFor(shaB), 1, 'the missed commit was analysed exactly once');
    assert.equal(runAExists, false, 'a commit whose hook failed produced no evidence and was not analysed (documented boundary)');
    commands.push(`engine started -> startup drain compensated ${shaB.slice(0, 8)} (trigger=${runB.trigger}, cursor=${cursorAfterStart})`);

    // ---------- Expected 3: a completed SHA is not run again ----------
    // A duplicated boundary event for the already completed SHA (the same real
    // bridge CLI, pointed at the same commit) is delivered to the journal.
    const replay = spawnSync(process.execPath, [BRIDGE_CLI, '--home', home, '--cwd', fixture.repoPath, '--sha', shaB], {
      cwd: fixture.repoPath, windowsHide: true, encoding: 'utf8', env: isolatedEnv(),
    });
    assert.equal(replay.status, 0, `replaying the boundary event failed: ${replay.stderr}`);
    const replayed = JSON.parse(replay.stdout);
    assert.equal(replayed.ok, true);
    const cursorBeforeReplay = engine.runtime.store.state.journalCursors[registered.id] || 0;
    await waitUntil(async () => (engine.runtime.store.state.journalCursors[registered.id] || 0) > cursorBeforeReplay, 20000, 'the duplicated boundary event is consumed');
    const cursorAfterReplay = engine.runtime.store.state.journalCursors[registered.id] || 0;
    const runsAfterReplay = engine.runtime.store.listRuns(PROJECT_ID);
    const ledgerRecord = engine.runtime.coordinator.reconciler.processingLedger.read(PROJECT_ID, shaB);
    const lastAnalyzed = engine.runtime.store.getProject(PROJECT_ID)?.runtime?.lastAnalyzedCommit || null;
    const ancestor = gitRun(fixture.repoPath, ['merge-base', '--is-ancestor', shaB, lastAnalyzed || shaB]);
    const promotedFiles = fs.existsSync(path.join(knowledgePath, 'changes'))
      ? fs.readdirSync(path.join(knowledgePath, 'changes'))
      : [];
    evidence.phases.completedShaNotRerun = {
      replayedBoundary: { ok: replayed.ok, commitSha: replayed.commitSha, sequence: replayed.sequence },
      journalCursorBefore: cursorBeforeReplay,
      journalCursorAfter: cursorAfterReplay,
      duplicateEventConsumed: cursorAfterReplay > cursorBeforeReplay,
      runRecordCount: runsAfterReplay.length,
      runsForSha: runsAfterReplay.filter(r => r.commitSha === shaB).length,
      analyzerInvocations: invocationsFor(shaB),
      ledgerCompleted: !!ledgerRecord,
      ledgerStatus: ledgerRecord?.status || null,
      guards: { completedShaLedger: !!ledgerRecord, alreadyAnalyzedAncestor: ancestor.code === 0, lastAnalyzedCommit: lastAnalyzed },
      promotedFiles,
      healthCounts: (await callJson(engineUrl, '/api/health')).body.counts,
    };
    assert.ok(cursorAfterReplay > cursorBeforeReplay, 'the duplicated event really reached the engine');
    assert.equal(runsAfterReplay.filter(r => r.commitSha === shaB).length, 1, 'no second run for the completed SHA');
    assert.equal(invocationsFor(shaB), 1, 'the completed SHA was not analysed again');
    assert.ok(ledgerRecord, 'the completed SHA is still recorded in the processing ledger');
    assert.equal(promotedFiles.length, 1, 'no duplicate promoted knowledge');
    commands.push(`duplicated boundary event consumed (cursor ${cursorBeforeReplay}->${cursorAfterReplay}); runs=${runsAfterReplay.length}, analyzer invocations=${invocationsFor(shaB)}`);

    // ---------- Restart: the completed SHA stays completed ----------
    await engine.close();
    engine = await startEngine({ dataDir, bridgeUrl, vectorUrl: vector.url, analyzer, consume: true });
    await engine.listen();
    await new Promise(resolve => setTimeout(resolve, 3000));
    const runsAfterRestart = engine.runtime.store.listRuns(PROJECT_ID);
    evidence.phases.restartNoRerun = {
      engineRestarted: true,
      runRecordCount: runsAfterRestart.length,
      analyzerInvocations: invocationsFor(shaB),
      journalCursor: engine.runtime.store.state.journalCursors[registered.id] || 0,
      ledgerStillCompleted: fs.existsSync(ledgerB) && JSON.parse(fs.readFileSync(ledgerB, 'utf8')).status === 'completed',
      lastAnalyzedCommit: engine.runtime.store.getProject(PROJECT_ID)?.runtime?.lastAnalyzedCommit || null,
    };
    assert.equal(runsAfterRestart.length, 1, 'the restarted engine did not create a new run');
    assert.equal(invocationsFor(shaB), 1, 'the restarted engine did not analyse the completed SHA again');
    assert.equal(evidence.phases.restartNoRerun.ledgerStillCompleted, true);
    commands.push('engine restarted on the same data dir -> no new run, no second analysis of the completed SHA');

    evidence.verdict = {
      'expected1 Git不被Hook故障阻塞': 'PASS',
      'expected2 启动对账补漏': 'PASS',
      'expected3 已完成SHA不重跑': 'PASS',
      realGit: 'real fixture repository, real post-commit hook (separate OS process) running the real bridge commit-boundary CLI; a deliberately broken hook proves Git is not blocked',
      startupReconciliation: 'the durable journal is drained from cursor 0 when the engine starts, so the commit made while the engine was down is compensated through the real git-hook path',
      completedShaGuard: 'the processing ledger (runtime/processed-commits/<projectId>/<sha>.json) plus the already-analysed-ancestor check block a second dispatch of a completed SHA; observed via analyzer invocation count and run count',
      analyzerStandin: 'deterministic stand-in - NO real model output covered',
      vectorService: 'real vector-hub server, deterministic test embeddings - paid embedding API NOT covered',
      boundary: 'A commit whose hook FAILED leaves no boundary event in the journal, so there is no evidence to compensate and that commit is never analysed (recorded as hookFailedCommitAnalyzed=false). The compensation guarantee covers commits whose real hook succeeded; the engine does not scan Git history for commits without a journal event.',
    };
    await engine.close();
    await vector.close();
    await bridge.close();
    saveEvidence(ARTIFACTS, 'eng007-evidence.json', evidence);
    console.log('ENG-007 PASS');
    process.exit(0);
  } catch (error) {
    evidence.verdict = { failed: String((error && error.stack) || error) };
    try { await engine?.close(); } catch {}
    try { await vector?.close(); } catch {}
    try { await bridge.close(); } catch {}
    saveEvidence(ARTIFACTS, 'eng007-evidence.json', evidence);
    console.error(`ENG-007 FAIL: ${error.message}`);
    process.exit(1);
  }
}

main();
