'use strict';

// P-ENG-ADVANCED ENG-005 单项目顺序 (single-project ordering) acceptance driver.
//
// Case (qa-autopilot/config/test-cases.json ENG-005):
//   steps:    连续提交A/B/C，令B失败。
//   expected: 1) A成功、B失败、C等待。 2) 不能越过B宣告分析到C。
//
// Real behavior under test: vendored knowledge-engine child process, real
// fixture git commits, real disk state (engine-state.json, knowledge tree),
// analyzer = declarative stand-in (NO real model output), failure of B via the
// engine's own debug fault surface (simulateFailure, honored before the
// analyzer runs). Vector endpoint is a loopback double (vector-hub not covered).

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  makeLaneDir, buildFixtureRepo, waitUntil, callJson, startVectorDouble,
  startEngineChild, readEventsFile, writePlan, saveEvidence,
} = require('./helpers/parallel-engine-advanced-harness.js');

const ARTIFACTS = process.env.PK_TEST_EVIDENCE_ROOT
  ? path.join(process.env.PK_TEST_EVIDENCE_ROOT, 'eng005')
  : path.resolve(__dirname, '../../qa-autopilot/artifacts/parallel-20261023/engine-review-r3/reruns/eng005');
const PROJECT_ID = 'project-eng005';

async function main() {
  const lane = makeLaneDir('eng005');
  const commands = [];
  const evidence = { caseId: 'ENG-005', laneDir: lane, phases: {}, commands };
  const fixture = buildFixtureRepo(lane, 'eng005', ['A', 'B', 'C']);
  const knowledgePath = path.join(lane, 'knowledge-eng005');
  fs.mkdirSync(knowledgePath, { recursive: true });
  const planFile = path.join(lane, 'analyzer-plan.json');
  const eventsFile = path.join(lane, 'analyzer-events.jsonl');
  writePlan(planFile, { default: { delayMs: 250 }, rules: [] });

  const vector = await startVectorDouble();
  const engine = await startEngineChild({ label: 'eng005', dataDir: path.join(lane, 'engine-data'), vectorUrl: vector.url, planFile, eventsFile });
  commands.push(`POST /api/projects (trackingStartCommit=${fixture.baseline.slice(0, 7)})`, 'POST /api/runs A', 'POST /api/runs B simulateFailure:true', 'POST /api/runs C');

  try {
    const registered = await callJson(engine.base, '/api/projects', {
      projectId: PROJECT_ID, name: 'eng005', repoPath: fixture.repoPath, knowledgePath, trackingStartCommit: fixture.baseline,
    });
    assert.equal(registered.status, 200, `project registration failed: ${JSON.stringify(registered.body)}`);

    const runA = (await callJson(engine.base, '/api/runs', { projectId: PROJECT_ID, commitSha: fixture.shas.A })).body.run;
    const runB = (await callJson(engine.base, '/api/runs', { projectId: PROJECT_ID, commitSha: fixture.shas.B, simulateFailure: true })).body.run;
    const runC = (await callJson(engine.base, '/api/runs', { projectId: PROJECT_ID, commitSha: fixture.shas.C })).body.run;
    assert.ok(runA && runB && runC, 'enqueue responses carry run objects');

    // --- Expected 1: A成功、B失败、C等待 ---
    await waitUntil(async () => {
      const runs = (await callJson(engine.base, `/api/runs?projectId=${PROJECT_ID}`)).body.runs;
      const by = sha => runs.find(r => r.commitSha === sha);
      return by(fixture.shas.A)?.state === 'succeeded' && by(fixture.shas.B)?.state === 'failed' && by(fixture.shas.C)?.state === 'queued';
    }, 30000, 'A succeeded / B failed / C queued');

    const snapshot1 = (await callJson(engine.base, `/api/runs?projectId=${PROJECT_ID}`)).body.runs;
    const sA = snapshot1.find(r => r.commitSha === fixture.shas.A);
    const sB = snapshot1.find(r => r.commitSha === fixture.shas.B);
    const sC = snapshot1.find(r => r.commitSha === fixture.shas.C);
    assert.equal(sA.state, 'succeeded'); assert.equal(sA.phase, 'ready');
    assert.equal(sB.state, 'failed'); assert.equal(sB.error.code, 'DEBUG_SIMULATED_FAILURE');
    assert.equal(sC.state, 'queued'); assert.equal(sC.phase, 'waiting-previous');
    evidence.phases.afterBfailed = {
      A: { state: sA.state, phase: sA.phase, promotedAt: sA.promotedAt },
      B: { state: sB.state, phase: sB.phase, error: sB.error },
      C: { state: sC.state, phase: sC.phase },
    };

    // --- Expected 2: 不能越过B宣告分析到C ---
    const events1 = readEventsFile(eventsFile);
    const startedShas = new Set(events1.filter(e => e.kind === 'start').map(e => e.commitSha));
    assert.equal(events1.filter(e => e.kind === 'start' && e.commitSha === fixture.shas.A).length, 1, 'A analyzed exactly once');
    assert.ok(!startedShas.has(fixture.shas.B), 'B never reached the analyzer (engine refuses before stand-in)');
    assert.ok(!startedShas.has(fixture.shas.C), 'C was never analyzed while B failed - no skipping past B');
    assert.ok(!fs.existsSync(path.join(knowledgePath, 'changes', `${fixture.shas.B.slice(0, 12)}.md`)), 'no B knowledge file');
    assert.ok(!fs.existsSync(path.join(knowledgePath, 'changes', `${fixture.shas.C.slice(0, 12)}.md`)), 'no C knowledge file');
    assert.ok(fs.existsSync(path.join(knowledgePath, 'changes', `${fixture.shas.A.slice(0, 12)}.md`)), 'A knowledge file exists');

    const stateAfterFailure = (await callJson(engine.base, `/api/snapshot?projectId=${PROJECT_ID}`)).body;
    const runtime1 = stateAfterFailure.projects.find(p => p.projectId === PROJECT_ID).runtime;
    assert.equal(runtime1.lastAnalyzedCommit, fixture.shas.A, 'pointer stays at A while B failed');
    evidence.phases.pointerAfterBfailed = runtime1.lastAnalyzedCommit;

    // Recovery: retry B, then C must proceed strictly after B.
    commands.push('POST /api/runs/:B/retry', 'wait C succeeded');
    const retried = await callJson(engine.base, `/api/runs/${encodeURIComponent(runB.runId)}/retry`, {});
    assert.equal(retried.status, 200, `retry B failed: ${JSON.stringify(retried.body)}`);
    await waitUntil(async () => {
      const runs = (await callJson(engine.base, `/api/runs?projectId=${PROJECT_ID}`)).body.runs;
      return runs.every(r => r.state === 'succeeded');
    }, 30000, 'B retry and C both succeed');
    const snapshot2 = (await callJson(engine.base, `/api/runs?projectId=${PROJECT_ID}`)).body.runs;
    const events2 = readEventsFile(eventsFile);
    const bStart = events2.find(e => e.kind === 'start' && e.commitSha === fixture.shas.B);
    const cStart = events2.find(e => e.kind === 'start' && e.commitSha === fixture.shas.C);
    const bFinish = events2.find(e => e.kind === 'finish' && e.commitSha === fixture.shas.B);
    assert.ok(bStart && cStart && bFinish, 'analyzer saw B (after retry) then C');
    assert.ok(new Date(cStart.at) >= new Date(bFinish.at), 'C analysis started only after B finished');
    for (const sha of ['A', 'B', 'C']) {
      assert.equal(events2.filter(e => e.kind === 'start' && e.commitSha === fixture.shas[sha]).length, 1, `${sha} analyzed exactly once across failure+retry`);
    }
    const runtime2 = (await callJson(engine.base, `/api/snapshot?projectId=${PROJECT_ID}`)).body.projects.find(p => p.projectId === PROJECT_ID).runtime;
    assert.equal(runtime2.lastAnalyzedCommit, fixture.shas.C, 'pointer ends at C after ordered recovery');
    evidence.phases.afterRecovery = {
      runs: snapshot2.map(r => ({ commit: r.commitSha.slice(0, 7), state: r.state, phase: r.phase, promotedAt: r.promotedAt })),
      analyzerStarts: events2.filter(e => e.kind === 'start').map(e => ({ sha: e.commitSha.slice(0, 7), at: e.at })),
      lastAnalyzedCommit: runtime2.lastAnalyzedCommit,
    };

    evidence.verdict = {
      'expected1 A成功、B失败、C等待': 'PASS',
      'expected2 不能越过B宣告分析到C': 'PASS',
      analyzerStandin: 'declarative stand-in - real staged bytes, NO real model output covered',
      vectorDouble: 'loopback HTTP double - vector-hub itself not covered',
    };
    await engine.stop();
    await vector.close();
    saveEvidence(ARTIFACTS, 'eng005-evidence.json', evidence);
    console.log('ENG-005 PASS');
    process.exitCode = 0;
  } catch (error) {
    evidence.verdict = { failed: String(error && error.stack || error) };
    try { await engine.stop(); } catch {}
    try { await vector.close(); } catch {}
    saveEvidence(ARTIFACTS, 'eng005-evidence.json', evidence);
    console.error(`ENG-005 FAIL: ${error.message}`);
    process.exitCode = 1;
  }
}

main();
