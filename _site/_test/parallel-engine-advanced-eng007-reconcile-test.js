'use strict';

// P-ENGINE-REVIEW-R2 ENG-007 boundary re-check: what exactly does 启动对账 cover?
//
// Contract verified against the current docs and the real implementation
// BEFORE this driver was written:
//   * README.md (触发面): "消费 event-bridge journal 的 commit boundary 与关联
//     会话事件 -> CommitReconciler 对账/认领" - the reconciliation source is the
//     JOURNAL, not Git history.
//   * README.md:119: "未启动服务时，Hook 已捕获的事件保留于 journal，服务消费后
//     才生成分析任务" - retention/compensation scope is events the hook captured.
//   * src/coordinator.js consumeJournal(): the only compensation path reads
//     journal events from cursor+1; there is no git-log scan anywhere.
//   * src/runtime/commit-reconciler.js:173: "failed SHA is never retried,
//     scanned, or inferred from history."
// => The startup reconciliation contract is JOURNAL RECOVERY. A commit whose
//    hook never wrote a boundary event is outside that contract (uncovered
//    boundary, honestly stated - not papered over as "compensated").
//
// This driver pins BOTH SHAs of the offline window and answers the Leader's
// question directly:
//   commit A - broken hook (no boundary event)  -> NOT found back by any Git
//             reconcile (no such mechanism exists).
//   commit B - working hook (boundary event)    -> compensated by the startup
//             journal drain (the ONLY recovery path).
//   Then, decisively: a REAL boundary event for A is delivered after the fact
//   with the real bridge CLI. The event is consumed, but B's success moved
//   lastAnalyzedCommit to shaB, so the already-analysed-ancestor guard skips A
//   (A is B's parent in real Git history): A is skipped over by B even when
//   its evidence is handed to the engine explicitly. A is not analysed, no run
//   is created - the guarantee "已完成SHA不重跑" extends to ancestors of the
//   analysed head.
//
// Not repeated here (already green in engine-final/eng007, untouched): the
// duplicate-B replay and the restart-no-rerun saga.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  makeLaneDir, buildFixtureRepo, installPostCommitHook, startBridge, startVector,
  startEngine, waitUntil, git, gitRun, readJsonl, saveEvidence, isolatedEnv, BRIDGE_CLI,
} = require('./helpers/parallel-engine-final-harness.js');
const { createStandinAnalyzer } = require('./helpers/parallel-engine-final-standin-analyzer.js');

const ARTIFACTS = process.env.PK_TEST_EVIDENCE_ROOT
  ? path.join(process.env.PK_TEST_EVIDENCE_ROOT, 'eng007reconcile')
  : path.resolve(__dirname, '../../qa-autopilot/artifacts/parallel-20261023/engine-review-r3/reruns/eng007reconcile');
const PROJECT_ID = 'project-eng007r2';

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
  for (const file of roots.flatMap(root => findJournalFiles(root))) {
    for (const line of fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
      const event = JSON.parse(line);
      if (event.schema === 'git-commit-boundary/v1') events.push(event);
    }
  }
  return events;
}

async function main() {
  const lane = makeLaneDir('eng007r2');
  const commands = [];
  const evidence = {
    caseId: 'ENG-007 (R2 boundary re-check: startup reconciliation contract scope, both SHAs)',
    laneDir: lane,
    contract: {
      source: 'README.md 触发面 + README.md:119 + src/coordinator.js consumeJournal (journal events are the only compensation source; no git-log scan) + src/runtime/commit-reconciler.js:173 (failed SHA never retried/scanned/inferred from history)',
      scope: 'startup reconciliation = JOURNAL RECOVERY only; commits whose hook never wrote a boundary event are NOT covered (uncovered boundary, by design and by docs)',
    },
    phases: {},
    commands,
  };

  const fixture = buildFixtureRepo(lane, 'eng007r2', []);
  const knowledgePath = path.join(lane, 'knowledge-eng007r2');
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

    // Register the project (consumer off), then stop the engine - the offline window begins.
    engine = await startEngine({ dataDir, bridgeUrl, vectorUrl: vector.url, analyzer, consume: false });
    await engine.listen();
    engine.runtime.store.addProject({
      projectId: PROJECT_ID, repoPath: fixture.repoPath, knowledgePath,
      trackingStartCommit: fixture.baseline, repoIdentity, journalId: registered.id, conversationBaselineCursor: 0,
    });
    await engine.close();
    engine = null;
    commands.push('engine lifecycle 0: project registered (consumer off), engine stopped - offline window begins');

    // ----- commit A: BROKEN hook (engine down, no boundary event) -----
    installPostCommitHook(fixture.repoPath, { home, mode: 'broken' });
    fs.writeFileSync(path.join(fixture.repoPath, 'offline-a.txt'), `offline feature A\n${'a'.repeat(64)}\n`);
    git(fixture.repoPath, ['add', '.']);
    const commitA = gitRun(fixture.repoPath, ['commit', '-qm', 'offline feature A']);
    assert.equal(commitA.code, 0, `Git must not be blocked by the failing hook (exit ${commitA.code})`);
    const shaA = git(fixture.repoPath, ['rev-parse', 'HEAD']);
    assert.match(commitA.stderr, /commit-boundary\.missing\.js/, 'the hook really failed');

    // ----- commit B: WORKING hook (engine down, boundary event on disk) -----
    installPostCommitHook(fixture.repoPath, { home, mode: 'ok' });
    fs.writeFileSync(path.join(fixture.repoPath, 'offline-b.txt'), `offline feature B\n${'b'.repeat(64)}\n`);
    git(fixture.repoPath, ['add', '.']);
    const commitB = gitRun(fixture.repoPath, ['commit', '-qm', 'offline feature B']);
    assert.equal(commitB.code, 0);
    const shaB = git(fixture.repoPath, ['rev-parse', 'HEAD']);
    const boundariesOffline = boundaryEvents(home, storePath);
    assert.equal(boundariesOffline.filter(e => e.commitSha === shaB).length, 1, 'B wrote exactly one boundary event while the engine was down');
    assert.equal(boundariesOffline.filter(e => e.commitSha === shaA).length, 0, 'A wrote no boundary event');

    // A really is B's parent in real Git history (the "skipped over by B" precondition).
    const aIsAncestorOfB = gitRun(fixture.repoPath, ['merge-base', '--is-ancestor', shaA, shaB]);
    assert.equal(aIsAncestorOfB.code, 0, 'A must be an ancestor of B in the fixture history');

    // ----- restart: startup drain compensates B only -----
    engine = await startEngine({ dataDir, bridgeUrl, vectorUrl: vector.url, analyzer, consume: true });
    await engine.listen();
    const runB = await waitUntil(async () => {
      const run = engine.runtime.store.listRuns(PROJECT_ID).find(r => r.commitSha === shaB);
      return run && run.state === 'succeeded' ? run : null;
    }, 60000, 'startup drain compensates B');
    await new Promise(resolve => setTimeout(resolve, 2000)); // let the drain settle fully before judging A
    const runsAfterStart = engine.runtime.store.listRuns(PROJECT_ID);
    const ledgerA = path.join(dataDir, 'runtime', 'processed-commits', PROJECT_ID, `${shaA}.json`);
    const ledgerB = path.join(dataDir, 'runtime', 'processed-commits', PROJECT_ID, `${shaB}.json`);
    const lastAnalyzed = engine.runtime.store.getProject(PROJECT_ID)?.runtime?.lastAnalyzedCommit || null;
    evidence.phases.offlineWindow = {
      commitA: { sha: shaA, subject: 'offline feature A', hook: 'broken (missing CLI)', gitExit: commitA.code, boundaryEvents: 0 },
      commitB: { sha: shaB, subject: 'offline feature B', hook: 'working (real bridge CLI)', gitExit: commitB.code, boundaryEvents: 1 },
      aIsAncestorOfB: aIsAncestorOfB.code === 0,
      startupCompensation: {
        runForB: { runId: runB.runId, trigger: runB.trigger, state: runB.state, indexState: runB.indexState },
        runsForA: runsAfterStart.filter(r => r.commitSha === shaA).length,
        totalRuns: runsAfterStart.length,
        analyzerInvocations: { forA: invocationsFor(shaA), forB: invocationsFor(shaB) },
        ledgerAExists: fs.existsSync(ledgerA),
        ledgerBStatus: fs.existsSync(ledgerB) ? JSON.parse(fs.readFileSync(ledgerB, 'utf8')).status : null,
        lastAnalyzedCommit: lastAnalyzed,
      },
    };
    assert.equal(runB.trigger, 'git-hook');
    assert.equal(invocationsFor(shaB), 1, 'B compensated exactly once');
    assert.equal(runsAfterStart.filter(r => r.commitSha === shaA).length, 0, 'A has no run: the startup drain found nothing for A (no boundary event, no Git-history scan)');
    assert.equal(invocationsFor(shaA), 0, 'A was never analysed');
    assert.equal(fs.existsSync(ledgerA), false, 'A is not in the processing ledger');
    assert.equal(lastAnalyzed, shaB, 'B\'s success moved lastAnalyzedCommit to shaB');
    commands.push(`restart -> drain compensated B (${shaB.slice(0, 8)}) only; A (${shaA.slice(0, 8)}) has no run/ledger/analysis`);

    // ----- decisive check: hand A's boundary event to the engine AFTER the fact -----
    const cursorBefore = engine.runtime.store.state.journalCursors[registered.id] || 0;
    const replayA = spawnSync(process.execPath, [BRIDGE_CLI, '--home', home, '--cwd', fixture.repoPath, '--sha', shaA], {
      cwd: fixture.repoPath, windowsHide: true, encoding: 'utf8', env: isolatedEnv(),
    });
    assert.equal(replayA.status, 0, `replaying A's boundary event failed: ${replayA.stderr}`);
    await waitUntil(async () => (engine.runtime.store.state.journalCursors[registered.id] || 0) > cursorBefore, 20000, 'A\'s after-the-fact boundary event is consumed');
    await new Promise(resolve => setTimeout(resolve, 2000));
    const runsAfterReplayA = engine.runtime.store.listRuns(PROJECT_ID);
    evidence.phases.afterTheFactBoundaryForA = {
      replay: { ok: JSON.parse(replayA.stdout).ok, commitSha: shaA },
      journalCursorBefore: cursorBefore,
      journalCursorAfter: engine.runtime.store.state.journalCursors[registered.id] || 0,
      runsForA: runsAfterReplayA.filter(r => r.commitSha === shaA).length,
      totalRuns: runsAfterReplayA.length,
      analyzerInvocationsForA: invocationsFor(shaA),
      ledgerAExists: fs.existsSync(ledgerA),
      verdict: 'A\'s evidence IS consumed (cursor advanced, boundary projection written) but the already-analysed-ancestor guard (baseline=lastAnalyzedCommit=shaB) skips A: no run, no analysis. A is skipped over by B; it is not "found back" by any Git reconcile - and none exists in the engine.',
    };
    assert.equal(runsAfterReplayA.filter(r => r.commitSha === shaA).length, 0, 'even with its boundary event delivered after the fact, A must not be re-analysed (ancestor guard)');
    assert.equal(invocationsFor(shaA), 0, 'the analyzer was never invoked for A');
    assert.equal(runsAfterReplayA.length, 1, 'the run set stays at exactly B\'s run');
    commands.push(`A's boundary event delivered after the fact -> consumed (cursor ${cursorBefore}->${evidence.phases.afterTheFactBoundaryForA.journalCursorAfter}), ancestor guard skipped A (no run, no analysis)`);

    evidence.verdict = {
      'question A是否被Git reconcile找回': 'NO - the engine has no Git-history reconciliation at all; the only compensation source is the bridge journal (README 触发面 + README:119, src/coordinator.js consumeJournal, src/runtime/commit-reconciler.js:173)',
      'question A是否被B越过': 'YES - B\'s promotion moved lastAnalyzedCommit to shaB; even when A\'s boundary event was delivered after the fact with the real CLI, the already-analysed-ancestor guard skipped A (consumed, projected, never enqueued)',
      'contract scope (honest)': '启动对账 = journal 恢复：只有成功写入 boundary 事件的提交会被补回。无 boundary 事件的提交（hook 故障）不在契约内，本 driver 将其作为未覆盖边界显式记录，不计入"已补偿"',
      'expected1 Git不被Hook故障阻塞': 'PASS (commit A exit 0 with a failing hook; commit exists)',
      'expected2 启动对账补漏': 'PASS within the journal-recovery contract (B compensated via startup drain; A uncovered by design - stated, not claimed)',
      'expected3 已完成SHA不重跑': 'PASS (B analysed once; ledger + ancestor guards held; A skipped as analysed-ancestor)',
      boundary: 'unchanged paths (duplicate-B replay, restart-no-rerun) stay covered by engine-final/eng007 first-round evidence; they were not re-run here',
      analyzerStandin: 'deterministic stand-in - NO real model output covered; vector-hub real with deterministic test embeddings - paid embedding API NOT covered',
    };
    await engine.close();
    await vector.close();
    await bridge.close();
    saveEvidence(ARTIFACTS, 'eng007-reconcile-evidence.json', evidence);
    console.log('ENG-007 R2 reconcile re-check PASS');
    process.exit(0);
  } catch (error) {
    evidence.verdict = { failed: String((error && error.stack) || error) };
    try { await engine?.close(); } catch {}
    try { await vector?.close(); } catch {}
    try { await bridge.close(); } catch {}
    saveEvidence(ARTIFACTS, 'eng007-reconcile-evidence.json', evidence);
    console.error(`ENG-007 R2 reconcile re-check FAIL: ${error.message}`);
    process.exit(1);
  }
}

main();
