'use strict';

// P-ENG-FINAL ENG-011 故障重试 (fault retry) acceptance driver.
//
// Case (qa-autopilot/config/test-cases.json ENG-011, P1):
//   steps:    UI点击指定run重试，连续双击与网络响应丢失分别测试。
//   expected: 1) 同一意图不会重复派发。
//             2) 活动状态正确。
//             3) 请求结果未知先查询。
//
// Real behaviour under test (vendored knowledge-engine, real HTTP surface):
//   * POST /api/runs/:runId/retry (server.js:130-133 -> coordinator.retry)
//     - 409 when the run is no longer in a retryable state
//     - re-queues the SAME run (no second run record for the same commit)
//   * the engine's per-project `active` map (coordinator.pump) keeps a single
//     writer per project, so a double click cannot dispatch the analysis twice
//   * the analyzer stand-in fails only the FIRST attempt of a commit (a
//     transient fault), so the retry can really succeed
//   * the engine's own event log (/api/events) is the record of the active
//     state machine - no sampling races involved
//
// Isolation: real vendored engine on an isolated data dir, real vector-hub on
// an isolated root, ephemeral loopback port. The engine runs with consume:false
// and a dead bridge URL so it can never reach the production bridge/vector
// services (8787/8790 untouched). Analyzer = deterministic stand-in (NO real
// model output). No quota access, no PAYG.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  makeLaneDir, buildFixtureRepo, startVector, startEngine, waitUntil, callJson,
  callJsonAndLoseResponse, readJsonl, saveEvidence,
} = require('./helpers/parallel-engine-final-harness.js');
const { createStandinAnalyzer } = require('./helpers/parallel-engine-final-standin-analyzer.js');

const ARTIFACTS = process.env.PK_TEST_EVIDENCE_ROOT
  ? path.join(process.env.PK_TEST_EVIDENCE_ROOT, 'eng011')
  : path.resolve(__dirname, '../../qa-autopilot/artifacts/parallel-20261023/engine-review-r3/reruns/eng011');
const PROJECT_ID = 'project-eng011';

function analyzerInvocations(eventsFile, sha) {
  return readJsonl(eventsFile).filter(entry => entry.kind === 'start' && entry.commitSha === sha).length;
}

async function main() {
  const lane = makeLaneDir('eng011');
  const commands = [];
  const evidence = { caseId: 'ENG-011', laneDir: lane, phases: {}, commands };

  const fixture = buildFixtureRepo(lane, 'eng011', ['A', 'B']);
  const knowledgePath = path.join(lane, 'knowledge-eng011');
  fs.mkdirSync(knowledgePath, { recursive: true });
  const dataDir = path.join(lane, 'engine-data');
  const vectorRoot = path.join(lane, 'vector-root');
  const eventsFile = path.join(lane, 'analyzer-events.jsonl');

  const vector = await startVector(vectorRoot);
  const analyzer = createStandinAnalyzer({ eventsFile, failOnceShas: new Set([fixture.shas.A, fixture.shas.B]) });
  // consume:false -> the engine never contacts a bridge; the dead URL can only
  // fail fast if something tried.
  const engine = await startEngine({ dataDir, bridgeUrl: 'http://127.0.0.1:9', vectorUrl: vector.url, analyzer });

  try {
    const base = await engine.listen();
    engine.runtime.store.addProject({
      projectId: PROJECT_ID,
      name: 'eng011',
      repoPath: fixture.repoPath,
      knowledgePath,
      trackingStartCommit: fixture.baseline,
    });
    commands.push('engine project registered (consume:false, dead bridge URL)');

    const runsOf = async () => (await callJson(base, `/api/runs?projectId=${PROJECT_ID}`)).body.runs;
    const runOf = async runId => (await runsOf()).find(r => r.runId === runId);
    const waitState = async (runId, state, ms, what) => waitUntil(async () => {
      const run = await runOf(runId);
      return run?.state === state ? run : null;
    }, ms, what);
    const phasesOf = async runId => (await callJson(base, `/api/events?projectId=${PROJECT_ID}`)).body.events
      .filter(event => event.runId === runId)
      .map(event => ({ phase: event.phase, summary: event.summary, at: event.at || null }));

    // ---------- Scenario 1: double click on retry ----------
    const createdA = await callJson(base, '/api/runs', { projectId: PROJECT_ID, commitSha: fixture.shas.A });
    assert.equal(createdA.status, 200, `run creation failed: ${JSON.stringify(createdA.body)}`);
    const runA = createdA.body.run;
    const failedA = await waitState(runA.runId, 'failed', 30000, 'first attempt fails (transient stand-in fault)');
    assert.equal(failedA.error.code, 'STANDIN_ANALYZER_FAILURE');
    commands.push(`run A created -> failed (${failedA.error.code})`);

    const [doubleA, doubleB] = await Promise.all([
      callJson(base, `/api/runs/${encodeURIComponent(runA.runId)}/retry`, {}),
      callJson(base, `/api/runs/${encodeURIComponent(runA.runId)}/retry`, {}),
    ]);
    commands.push(`double click retry A -> statuses ${doubleA.status}/${doubleB.status}`);
    const healedA = await waitState(runA.runId, 'succeeded', 30000, 'retried run A succeeds');
    const runsAfterDouble = await runsOf();
    const runsForA = runsAfterDouble.filter(r => r.commitSha === fixture.shas.A);
    const health = (await callJson(base, '/api/health')).body;
    const invocationsA = analyzerInvocations(eventsFile, fixture.shas.A);
    const phasesA = await phasesOf(runA.runId);
    evidence.phases.doubleClick = {
      retryResponses: [{ status: doubleA.status, error: doubleA.body?.error || null }, { status: doubleB.status, error: doubleB.body?.error || null }],
      runRecordCountForCommitA: runsForA.length,
      analyzerInvocationsForA: invocationsA,
      finalState: healedA.state,
      finalPhase: healedA.phase,
      indexState: healedA.indexState,
      engineStateEvents: phasesA,
      healthCounts: health.counts,
      healthConcurrency: health.concurrency,
    };
    assert.equal(runsForA.length, 1, 'double click did not create a second run for the same commit');
    assert.equal(invocationsA, 2, `one intent dispatched once: expected 2 analyzer runs (1 failed + 1 retry), got ${invocationsA}`);
    assert.equal(healedA.state, 'succeeded');
    assert.equal(healedA.phase, 'ready');
    assert.equal(healedA.indexState, 'succeeded');
    assert.ok(doubleA.status === 200 || doubleB.status === 200, 'at least one retry request was accepted');
    assert.ok([doubleA.status, doubleB.status].every(status => status === 200 || status === 409), `unexpected retry status (${doubleA.status}/${doubleB.status})`);
    assert.equal(health.counts.running, 0, 'no run left active after the retry settled');
    const phasesSeen = phasesA.map(entry => entry.phase);
    for (const phase of ['preparing', 'analyzing', 'promoting', 'ready']) {
      assert.ok(phasesSeen.includes(phase), `engine state machine did not record phase ${phase}: ${phasesSeen.join(',')}`);
    }

    // ---------- Scenario 2: lost network response ----------
    const createdB = await callJson(base, '/api/runs', { projectId: PROJECT_ID, commitSha: fixture.shas.B });
    const runB = createdB.body.run;
    await waitState(runB.runId, 'failed', 30000, 'run B first attempt fails');
    commands.push('run B created -> failed');

    const lost = await callJsonAndLoseResponse(base, `/api/runs/${encodeURIComponent(runB.runId)}/retry`, {});
    commands.push(`retry B with the response dropped: ${JSON.stringify(lost)}`);
    assert.equal(lost.lost, true, 'response was not actually dropped');

    // 结果未知先查询: the client lost the answer, so it asks the engine first.
    const queried = await callJson(base, `/api/runs?projectId=${PROJECT_ID}`);
    assert.equal(queried.status, 200);
    const queriedRun = queried.body.runs.find(r => r.runId === runB.runId);
    assert.ok(queriedRun, 'query after an unknown result returns the run');
    const queriedState = queriedRun.state;
    const healedB = await waitState(runB.runId, 'succeeded', 30000, 'the dropped-response retry really took effect');
    const invocationsB = analyzerInvocations(eventsFile, fixture.shas.B);

    // The client retries once more because it never saw the answer.
    const repeated = await callJson(base, `/api/runs/${encodeURIComponent(runB.runId)}/retry`, {});
    await new Promise(resolve => setTimeout(resolve, 500));
    const invocationsBAfterRepeat = analyzerInvocations(eventsFile, fixture.shas.B);
    const runsForB = (await runsOf()).filter(r => r.commitSha === fixture.shas.B);
    const ledgerB = path.join(dataDir, 'runtime', 'processed-commits', PROJECT_ID, `${fixture.shas.B}.json`);
    evidence.phases.lostResponse = {
      droppedResponse: lost,
      queriedStateImmediatelyAfterDrop: queriedState,
      queriedRunId: queriedRun.runId,
      finalState: healedB.state,
      repeatRetryStatus: repeated.status,
      repeatRetryError: repeated.body?.error || null,
      runRecordCountForCommitB: runsForB.length,
      analyzerInvocationsForB: invocationsB,
      analyzerInvocationsAfterRepeat: invocationsBAfterRepeat,
      ledgerExists: fs.existsSync(ledgerB),
      ledgerStatus: fs.existsSync(ledgerB) ? JSON.parse(fs.readFileSync(ledgerB, 'utf8')).status : null,
      engineStateEvents: await phasesOf(runB.runId),
    };
    assert.equal(healedB.state, 'succeeded', 'the retry behind the lost response really executed');
    assert.equal(invocationsB, 2, `lost-response retry dispatched exactly once (got ${invocationsB} analyzer runs)`);
    assert.equal(invocationsBAfterRepeat, invocationsB, 'repeating the retry after an unknown result did not dispatch again');
    assert.equal(runsForB.length, 1, 'no duplicate run after the unknown-result retry');
    assert.equal(repeated.status, 409, `repeat retry must be refused, got ${repeated.status}`);
    assert.ok(fs.existsSync(ledgerB), 'completed SHA recorded in the processing ledger');

    evidence.verdict = {
      'expected1 同一意图不会重复派发': 'PASS',
      'expected2 活动状态正确': 'PASS',
      'expected3 请求结果未知先查询': 'PASS',
      analyzerStandin: 'deterministic stand-in with a one-shot transient fault - NO real model output covered',
      vectorService: 'real vector-hub server, deterministic test embeddings - paid embedding API NOT covered',
      boundary: 'engine-level retry surface (HTTP retry endpoint, run state machine, per-project active map, processing ledger, engine event log). The Workbench UI double-click handling itself is outside the engine and was not exercised.',
    };
    await engine.close();
    await vector.close();
    saveEvidence(ARTIFACTS, 'eng011-evidence.json', evidence);
    console.log('ENG-011 PASS');
    process.exitCode = 0;
  } catch (error) {
    evidence.verdict = { failed: String((error && error.stack) || error) };
    try { await engine.close(); } catch {}
    try { await vector.close(); } catch {}
    saveEvidence(ARTIFACTS, 'eng011-evidence.json', evidence);
    console.error(`ENG-011 FAIL: ${error.message}`);
    process.exitCode = 1;
  }
}

main();
