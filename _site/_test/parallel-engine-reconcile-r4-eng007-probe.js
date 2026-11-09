'use strict';

// P-ENGINE-RECONCILE-R4 - ENG-007 gap probe (the open item R3 left behind).
//
// R3 proved honestly that the startup reconciliation contract is JOURNAL
// RECOVERY: a commit whose hook failed and therefore never reached the
// journal is not "found back" by the engine, because the engine has no
// Git-history traversal at all (CommitScanner.scan/scanProject/applyScanResult
// are exported but never called from src/).
//
// R3 also proved the OTHER case: a commit whose boundary event WAS captured
// but was delivered after the analysed head had already moved past it was
// silently DISCARDED - the event was consumed (cursor advanced), the boundary
// was projected, and no run, no ledger entry and no analysis were created.
// Durable evidence disappeared with no diagnostic and no way to recover it.
// That is the case this probe drives to a decision.
//
// Everything here is real:
//   * a REAL fixture git repository with REAL commits
//   * a REAL post-commit hook that runs the REAL pinned
//     ai-coding-event-bridge commit-boundary CLI as a separate OS process
//   * the "broken hook" mode points the hook at a non-existent CLI, so the
//     hook FAILS for real and the commit never reaches the journal - no
//     API-created task is used to stand in for a hook failure
//   * the REAL bridge console (isolated --home journal), the REAL vector-hub
//     (deterministic test embeddings - the paid embedding API is NOT
//     exercised), the REAL knowledge-engine under test
//
// The analysed analyzer is a deterministic stand-in: it writes real staged
// Markdown bytes and a real staging manifest through the engine's real
// promotion path. NO real model output is exercised.
//
// TARGET IDENTITY
//   default run : the VENDORED bytes (_modules/knowledge-engine) - the pinned
//                 bytes in which the late-delivery drop is live -> RED
//   candidate   : PK_TEST_ENGINE_ROOT=<module source checkout> -> GREEN
//
// This file is deliberately NOT named *-test.js: the canonical runner collects
// only *-test.js, and the fix lives in the module SOURCE repo (not vendored),
// so a default-red canonical entry would misrepresent the pinned package. The
// same file runs RED against the pinned bytes and GREEN against the candidate
// bytes.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  makeLaneDir, buildFixtureRepo, installPostCommitHook, startBridge, startVector,
  startEngine, captureBoundary, boundaryEvents, waitUntil, git, gitRun, readJsonl,
  saveEvidence, hashFile, resolveEngineRoot, RUNTIME_IDENTITY, REPO_ROOT,
  VENDORED_ENGINE_ROOT, VENDORED_ENGINE_VERSION,
} = require('./helpers/parallel-engine-reconcile-r4-harness.js');
const { createStandinAnalyzer } = require('./helpers/parallel-engine-reconcile-r4-standin-analyzer.js');

const ARTIFACTS = process.env.PK_TEST_EVIDENCE_ROOT
  ? path.join(process.env.PK_TEST_EVIDENCE_ROOT, 'eng007r4')
  : path.resolve(__dirname, '../../qa-autopilot/artifacts/parallel-20261023/engine-reconcile-r4/reruns/eng007r4');
const PROJECT_ID = 'project-eng007r4';

function targetLabel(engineIdentity) {
  return engineIdentity.candidate ? 'candidate' : 'pinned';
}

function readDiagnostics(dataDir) {
  const records = [];
  const root = path.join(dataDir, 'logs');
  const walk = dir => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.name.endsWith('.jsonl')) records.push(...readJsonl(absolute));
    }
  };
  walk(root);
  return records;
}

async function main() {
  const engineIdentity = resolveEngineRoot();
  const lane = makeLaneDir('eng007r4');
  const commands = [];
  const evidence = {
    caseId: 'ENG-007 (R4): a captured commit boundary delivered after the analysed head moved past it',
    laneDir: lane,
    target: {
      engineRoot: engineIdentity.root,
      engineVersion: engineIdentity.version,
      engineOrigin: engineIdentity.origin,
      candidateBytes: engineIdentity.candidate,
      vendoredEngineRoot: VENDORED_ENGINE_ROOT,
      vendoredEngineVersion: VENDORED_ENGINE_VERSION,
      bridge: RUNTIME_IDENTITY.bridge,
      vector: RUNTIME_IDENTITY.vector,
      coordinatorSha256: {
        underTest: hashFile(path.join(engineIdentity.root, 'src', 'coordinator.js')),
        vendored: hashFile(path.join(VENDORED_ENGINE_ROOT, 'src', 'coordinator.js')),
      },
    },
    contract: {
      source: 'README.md 触发面 (the journal is the reconciliation source) + README.md:119 (hook-captured events are retained in the journal and only become tasks after the service consumes them) + src/coordinator.js consumeJournal + src/runtime/commit-reconciler.js:173 (a failed SHA is never retried, scanned or inferred from history)',
      scope: 'startup reconciliation = JOURNAL RECOVERY. A commit that never reached the journal is OUTSIDE the contract (uncovered boundary, stated - not papered over). A commit whose event WAS captured but was delivered after the analysed head moved past it is INSIDE the contract and must not be dropped.',
    },
    phases: {},
    commands,
  };

  const fixture = buildFixtureRepo(lane, 'eng007r4', []);
  const knowledgePath = path.join(lane, 'knowledge-eng007r4');
  const storePath = path.join(knowledgePath, 'dev-conversations');
  fs.mkdirSync(storePath, { recursive: true });
  const home = path.join(lane, 'bridge-home');
  const dataDir = path.join(lane, 'engine-data');
  const vectorRoot = path.join(lane, 'vector-root');
  const eventsFile = path.join(lane, 'analyzer-events.jsonl');

  const bridge = startBridge(home);
  let engine = null;
  let vector = null;
  const analyzer = createStandinAnalyzer({ eventsFile, engineRoot: engineIdentity.root });
  const invocationsFor = sha => readJsonl(eventsFile).filter(entry => entry.kind === 'start' && entry.commitSha === sha).length;

  try {
    const bridgeUrl = await bridge.listen();
    vector = await startVector(vectorRoot);
    const registered = await bridge.projectRegistry.addProject({ home, path: fixture.repoPath, store: storePath });
    const { repoIdentity } = await bridge.resolveRepoContext(fixture.repoPath);

    // Register the project (consumer off), then stop the engine: the offline
    // window begins. Nothing can consume a journal event while the engine is
    // down.
    engine = await startEngine({ dataDir, bridgeUrl, vectorUrl: vector.url, analyzer, consume: false, engineRoot: engineIdentity.root });
    await engine.listen();
    engine.runtime.store.addProject({
      projectId: PROJECT_ID, repoPath: fixture.repoPath, knowledgePath,
      trackingStartCommit: fixture.baseline, repoIdentity, journalId: registered.id, conversationBaselineCursor: 0,
    });
    await engine.close();
    engine = null;
    commands.push('engine lifecycle 0: project registered (consumer off), engine stopped - offline window begins');

    // ----- commit A: BROKEN hook (the real hook failure) -----
    installPostCommitHook(fixture.repoPath, { home, mode: 'broken' });
    fs.writeFileSync(path.join(fixture.repoPath, 'offline-a.txt'), `offline feature A\n${'a'.repeat(64)}\n`);
    git(fixture.repoPath, ['add', '.']);
    const commitA = gitRun(fixture.repoPath, ['commit', '-qm', 'offline feature A']);
    assert.equal(commitA.code, 0, `Git must not be blocked by the failing hook (exit ${commitA.code})`);
    const shaA = git(fixture.repoPath, ['rev-parse', 'HEAD']);
    assert.match(commitA.stderr, /commit-boundary\.missing\.js/, 'the hook really failed');

    // ----- commit C: BROKEN hook too, and it is NEVER captured later -----
    installPostCommitHook(fixture.repoPath, { home, mode: 'broken' });
    fs.writeFileSync(path.join(fixture.repoPath, 'offline-c.txt'), `offline feature C\n${'c'.repeat(64)}\n`);
    git(fixture.repoPath, ['add', '.']);
    const commitC = gitRun(fixture.repoPath, ['commit', '-qm', 'offline feature C']);
    assert.equal(commitC.code, 0);
    const shaC = git(fixture.repoPath, ['rev-parse', 'HEAD']);

    // ----- commit B: WORKING hook (the real capture path) -----
    installPostCommitHook(fixture.repoPath, { home, mode: 'ok' });
    fs.writeFileSync(path.join(fixture.repoPath, 'offline-b.txt'), `offline feature B\n${'b'.repeat(64)}\n`);
    git(fixture.repoPath, ['add', '.']);
    const commitB = gitRun(fixture.repoPath, ['commit', '-qm', 'offline feature B']);
    assert.equal(commitB.code, 0);
    const shaB = git(fixture.repoPath, ['rev-parse', 'HEAD']);

    const boundariesOffline = boundaryEvents(home, storePath);
    assert.equal(boundariesOffline.filter(e => e.commitSha === shaB).length, 1, 'B wrote exactly one boundary event while the engine was down');
    assert.equal(boundariesOffline.filter(e => e.commitSha === shaA).length, 0, 'A wrote no boundary event (hook failure)');
    assert.equal(boundariesOffline.filter(e => e.commitSha === shaC).length, 0, 'C wrote no boundary event (hook failure)');

    // A and C really are ancestors of B in the real Git history (the
    // "the analysed head moved past them" precondition).
    const aIsAncestorOfB = gitRun(fixture.repoPath, ['merge-base', '--is-ancestor', shaA, shaB]);
    const cIsAncestorOfB = gitRun(fixture.repoPath, ['merge-base', '--is-ancestor', shaC, shaB]);
    assert.equal(aIsAncestorOfB.code, 0, 'A must be an ancestor of B');
    assert.equal(cIsAncestorOfB.code, 0, 'C must be an ancestor of B');

    evidence.phases.offlineWindow = {
      baseline: fixture.baseline,
      commitA: { sha: shaA, subject: 'offline feature A', hook: 'broken (missing CLI)', gitExit: commitA.code, hookStderr: (commitA.stderr.split('\n').find(line => line.includes('commit-boundary.missing.js')) || commitA.stderr.split('\n')[0]), boundaryEvents: 0 },
      commitC: { sha: shaC, subject: 'offline feature C', hook: 'broken (missing CLI)', gitExit: commitC.code, boundaryEvents: 0 },
      commitB: { sha: shaB, subject: 'offline feature B', hook: 'working (real bridge CLI)', gitExit: commitB.code, boundaryEvents: 1 },
      aIsAncestorOfB: aIsAncestorOfB.code === 0,
      cIsAncestorOfB: cIsAncestorOfB.code === 0,
    };
    commands.push(`offline window: A (broken hook, 0 events), C (broken hook, 0 events), B (working hook, 1 event); A and C are ancestors of B`);

    // ----- restart: startup drain compensates B (journal recovery works) -----
    engine = await startEngine({ dataDir, bridgeUrl, vectorUrl: vector.url, analyzer, consume: true, engineRoot: engineIdentity.root });
    await engine.listen();
    const runB = await waitUntil(async () => {
      const run = engine.runtime.store.listRuns(PROJECT_ID).find(r => r.commitSha === shaB);
      return run && run.state === 'succeeded' ? run : null;
    }, 60000, 'startup drain compensates B');
    await new Promise(resolve => setTimeout(resolve, 1500));

    const ledgerPath = sha => path.join(dataDir, 'runtime', 'processed-commits', PROJECT_ID, `${sha}.json`);
    const runsAfterStart = engine.runtime.store.listRuns(PROJECT_ID);
    const lastAnalyzedAfterStart = engine.runtime.store.getProject(PROJECT_ID)?.runtime?.lastAnalyzedCommit || null;
    evidence.phases.startupJournalRecovery = {
      runForB: { runId: runB.runId, trigger: runB.trigger, state: runB.state },
      analyzerInvocations: { forA: invocationsFor(shaA), forB: invocationsFor(shaB), forC: invocationsFor(shaC) },
      runsForA: runsAfterStart.filter(r => r.commitSha === shaA).length,
      runsForC: runsAfterStart.filter(r => r.commitSha === shaC).length,
      totalRuns: runsAfterStart.length,
      ledgerAExists: fs.existsSync(ledgerPath(shaA)),
      ledgerCExists: fs.existsSync(ledgerPath(shaC)),
      lastAnalyzedCommit: lastAnalyzedAfterStart,
      verdict: 'the startup drain compensates B (the captured event). A and C never reached the journal, so no recovery path exists for them - that is the documented journal-recovery boundary, not a defect.',
    };
    assert.equal(runB.trigger, 'git-hook');
    assert.equal(invocationsFor(shaB), 1, 'B compensated exactly once');
    assert.equal(runsAfterStart.filter(r => r.commitSha === shaA).length, 0, 'A has no run: nothing for the engine to consume');
    assert.equal(runsAfterStart.filter(r => r.commitSha === shaC).length, 0, 'C has no run: nothing for the engine to consume');
    assert.equal(fs.existsSync(ledgerPath(shaA)), false, 'A is not in the processing ledger');
    assert.equal(lastAnalyzedAfterStart, shaB, 'B\'s success moved lastAnalyzedCommit to shaB');
    commands.push(`restart -> drain compensated B (${shaB.slice(0, 8)}); A (${shaA.slice(0, 8)}) and C (${shaC.slice(0, 8)}) have no run/ledger/analysis - never captured`);

    // ----- the defect: A's boundary is captured NOW, after the head moved past it -----
    const cursorBefore = engine.runtime.store.state.journalCursors[registered.id] || 0;
    const captureA = captureBoundary({ home, repoPath: fixture.repoPath, sha: shaA });
    assert.equal(captureA.code, 0, `capturing A's boundary through the real CLI failed: ${captureA.stderr}`);
    assert.equal(captureA.payload?.ok, true, `the real boundary CLI did not report ok: ${captureA.stdout}`);
    await waitUntil(async () => (engine.runtime.store.state.journalCursors[registered.id] || 0) > cursorBefore, 30000, 'A\'s late boundary event is consumed');
    await engine.runtime.coordinator.drain();
    await new Promise(resolve => setTimeout(resolve, 1500));

    const runsAfterLateCapture = engine.runtime.store.listRuns(PROJECT_ID);
    const runA = runsAfterLateCapture.find(r => r.commitSha === shaA) || null;
    const lastAnalyzedAfterLateCapture = engine.runtime.store.getProject(PROJECT_ID)?.runtime?.lastAnalyzedCommit || null;
    const diagnostics = readDiagnostics(dataDir);
    const compensationDiagnostic = diagnostics.find(d => d.event === 'reconcile.missed_commit_compensated') || null;
    const knowledgeFileA = path.join(knowledgePath, 'changes', `${shaA.slice(0, 12)}.md`);
    const knowledgeFileB = path.join(knowledgePath, 'changes', `${shaB.slice(0, 12)}.md`);

    evidence.phases.lateDelivery = {
      capture: { code: captureA.code, ok: captureA.payload?.ok, commitSha: shaA, cli: 'pinned ai-coding-event-bridge commit-boundary CLI (the same code path the post-commit hook runs)' },
      journalCursorBefore: cursorBefore,
      journalCursorAfter: engine.runtime.store.state.journalCursors[registered.id] || 0,
      runsForA: runsAfterLateCapture.filter(r => r.commitSha === shaA).length,
      runForA: runA ? { runId: runA.runId, trigger: runA.trigger, state: runA.state, error: runA.error || null } : null,
      analyzerInvocations: { forA: invocationsFor(shaA), forB: invocationsFor(shaB), forC: invocationsFor(shaC) },
      ledgerAExists: fs.existsSync(ledgerPath(shaA)),
      knowledgeFileForA: fs.existsSync(knowledgeFileA),
      knowledgeFileForB: fs.existsSync(knowledgeFileB),
      lastAnalyzedCommit: lastAnalyzedAfterLateCapture,
      runOrder: runsAfterLateCapture.map(r => ({ commitSha: r.commitSha, state: r.state })),
      analysisOrder: readJsonl(eventsFile).filter(entry => entry.kind === 'start').map(entry => entry.commitSha),
      compensationDiagnostic: compensationDiagnostic
        ? { event: compensationDiagnostic.event, level: compensationDiagnostic.level, commitSha: compensationDiagnostic.commitSha, message: compensationDiagnostic.message }
        : null,
      runsForC: runsAfterLateCapture.filter(r => r.commitSha === shaC).length,
    };
    commands.push(`A's boundary captured through the real CLI after B was analysed -> cursor ${cursorBefore}->${evidence.phases.lateDelivery.journalCursorAfter}; runs for A: ${evidence.phases.lateDelivery.runsForA}`);

    // ----- the boundaries that must survive -----
    assert.equal(invocationsFor(shaB), 1, 'the already completed SHA is not analysed a second time');
    assert.equal(runsAfterLateCapture.filter(r => r.commitSha === shaB).length, 1, 'the already completed SHA has exactly one run');
    assert.equal(invocationsFor(shaC), 0, 'C (never captured) is still not analysed - the journal-recovery boundary is unchanged');
    assert.equal(runsAfterLateCapture.filter(r => r.commitSha === shaC).length, 0, 'C (never captured) still has no run');

    saveEvidence(ARTIFACTS, `eng007r4-evidence-${targetLabel(engineIdentity)}.json`, evidence);

    // ----- the decision: a captured commit must not be dropped -----
    assert.equal(
      evidence.phases.lateDelivery.runsForA, 1,
      `A's boundary WAS captured (real CLI, ok) and consumed (cursor advanced), but the engine produced no run for it: the captured evidence was dropped. runs=${JSON.stringify(evidence.phases.lateDelivery.runOrder)}`,
    );
    assert.equal(runA.state, 'succeeded', `A's compensated run must succeed: ${JSON.stringify(runA.error)}`);
    assert.equal(invocationsFor(shaA), 1, 'A is analysed exactly once (no duplicate paid call)');
    assert.equal(fs.existsSync(ledgerPath(shaA)), true, 'A is recorded in the processing ledger');
    assert.equal(fs.existsSync(knowledgeFileA), true, 'A reaches the knowledge tree');
    assert.ok(compensationDiagnostic, 'the compensation is recorded as a diagnostic');
    assert.equal(compensationDiagnostic.commitSha, shaA);

    evidence.verdict = {
      'never captured (hook failure)': `UNCOVERED BY CONTRACT - A and C never reached the journal (0 boundary events on disk); the engine has no Git-history traversal (CommitScanner.scan/scanProject/applyScanResult are exported but never called from src/). Startup reconciliation is journal recovery only (README 触发面, README:119, src/coordinator.js consumeJournal, src/runtime/commit-reconciler.js:173).`,
      'captured but delivered after the analysed head moved past it': `COMPENSATED - A's real boundary event is captured and consumed and A is analysed exactly once, promoted to the knowledge tree and recorded in the processing ledger; a 'reconcile.missed_commit_compensated' diagnostic records the compensation.`,
      'completed SHA not re-run': 'PASS (B analysed exactly once, one run)',
      'never-captured SHA not analysed': 'PASS (C is still not analysed - the contract boundary is unchanged)',
      'analyser invocations': 'no duplicate paid call: exactly one invocation per analysed SHA',
      analyzerStandin: 'deterministic stand-in - NO real model output covered; vector-hub real with deterministic test embeddings - the paid embedding API is NOT covered',
      consequence: `lastAnalyzedCommit moved ${shaB.slice(0, 8)} -> ${String(lastAnalyzedAfterLateCapture).slice(0, 8)} (the compensated commit is older than the analysed head, so the single pointer regresses) and the chronological analysis order becomes ${evidence.phases.lateDelivery.analysisOrder.map(sha => sha.slice(0, 8)).join(' -> ')} (B first, then the compensated A), which deviates from README:95 ("同项目按提交顺序执行"). The run list itself is returned ordered by SHA, so the order above is read from the analyzer's append-only invocation log. Recorded as a consequence of the minimal fix, not as a test assertion.`,
    };
    saveEvidence(ARTIFACTS, `eng007r4-evidence-${targetLabel(engineIdentity)}.json`, evidence);

    await engine.close();
    await vector.close();
    await bridge.close();
    console.log(`ENG-007 R4 probe PASS (engine: ${engineIdentity.origin} ${engineIdentity.version})`);
    process.exit(0);
  } catch (error) {
    evidence.verdict = { failed: String((error && error.stack) || error) };
    try { await engine?.close(); } catch {}
    try { await vector?.close(); } catch {}
    try { await bridge.close(); } catch {}
    saveEvidence(ARTIFACTS, `eng007r4-evidence-${targetLabel(engineIdentity)}.json`, evidence);
    console.error(`ENG-007 R4 probe FAIL: ${error.message}`);
    process.exit(1);
  }
}

main();
