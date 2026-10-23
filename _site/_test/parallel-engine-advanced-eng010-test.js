'use strict';

// P-ENG-ADVANCED ENG-010 索引独立失败 (independent index failure) acceptance driver.
//
// Case (qa-autopilot/config/test-cases.json ENG-010, P1):
//   steps:    Markdown晋升成功后令向量服务失败。
//   expected: 1) 知识已更新/索引待修复分开。
//             2) 不回滚Markdown、不重复付费分析。
//
// Real behavior under test: vendored knowledge-engine child process, real
// promotion to the project knowledge tree on disk, then the vector endpoint
// (loopback double scripted to HTTP 503 EMBEDDING_UNAVAILABLE) failing exactly
// at index time. Verified via coordinator.index() semantics (src/coordinator.js):
// promotedAt is persisted BEFORE index(); an index failure moves the run to
// state 'index-pending' with error INDEX_FAILED “知识已更新，索引待修复。”
// while the Markdown promotion stays on disk; retry()/restart re-enter
// execute()'s promotedAt fast-path (line 219) which only re-indexes.
//
// Analyzer = declarative stand-in (NO real model output). Vector endpoint =
// loopback double (vector-hub itself not covered).

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  makeLaneDir, buildFixtureRepo, waitUntil, callJson, startVectorDouble,
  startEngineChild, readEventsFile, writePlan, saveEvidence,
} = require('./helpers/parallel-engine-advanced-harness.js');

const ARTIFACTS = process.env.PK_TEST_EVIDENCE_ROOT
  ? path.join(process.env.PK_TEST_EVIDENCE_ROOT, 'eng010')
  : path.resolve(__dirname, '../../qa-autopilot/artifacts/parallel-20261023/engine-review-r3/reruns/eng010');
const PROJECT_ID = 'project-eng010';
const VECTOR_FAILURE = { kind: 'fail', httpStatus: 503, code: 'EMBEDDING_UNAVAILABLE', message: 'embedding backend unavailable (scripted)' };

function hashFile(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 16);
}

function readRunFromDisk(dataDir, runId) {
  const state = JSON.parse(fs.readFileSync(path.join(dataDir, 'engine-state.json'), 'utf8'));
  return { state, run: state.runs.find(r => r.runId === runId) };
}

async function main() {
  const lane = makeLaneDir('eng010');
  const commands = [];
  const evidence = { caseId: 'ENG-010', laneDir: lane, phases: {}, commands };
  const fixture = buildFixtureRepo(lane, 'eng010', ['X', 'Y']);
  const knowledgePath = path.join(lane, 'knowledge-eng010');
  fs.mkdirSync(knowledgePath, { recursive: true });
  const planFile = path.join(lane, 'analyzer-plan.json');
  const eventsFile = path.join(lane, 'analyzer-events.jsonl');
  writePlan(planFile, { default: { delayMs: 300 }, rules: [] });

  const vector = await startVectorDouble();
  vector.setMode(VECTOR_FAILURE);
  const dataDir = path.join(lane, 'engine-data');
  const engine1 = await startEngineChild({ label: 'eng010', dataDir, vectorUrl: vector.url, planFile, eventsFile });
  commands.push('POST /api/runs X while vector double scripted 503 EMBEDDING_UNAVAILABLE', 'POST /api/runs/X retry after vector double restored', 'stop engine, re-fail vector, POST /api/runs Y -> index-pending', 'restart engine with vector restored (initialize() auto-retry)');

  const changesDir = path.join(knowledgePath, 'changes');
  const fileFor = sha => path.join(changesDir, `${sha.slice(0, 12)}.md`);
  const startsFor = sha => readEventsFile(eventsFile).filter(e => e.kind === 'start' && e.commitSha === sha).length;
  const runById = async (engine, runId) => (await callJson(engine.base, `/api/runs?projectId=${PROJECT_ID}`)).body.runs.find(r => r.runId === runId);
  const runtimeOf = async engine => (await callJson(engine.base, `/api/snapshot?projectId=${PROJECT_ID}`)).body.projects.find(p => p.projectId === PROJECT_ID).runtime;

  try {
    assert.equal((await callJson(engine1.base, '/api/projects', {
      projectId: PROJECT_ID, name: 'eng010', repoPath: fixture.repoPath, knowledgePath, trackingStartCommit: fixture.baseline,
    })).status, 200);
    const runX = (await callJson(engine1.base, '/api/runs', { projectId: PROJECT_ID, commitSha: fixture.shas.X })).body.run;

    // --- Expected 1: 知识已更新 / 索引待修复 分开 ---
    const stuck = await waitUntil(async () => {
      const run = await runById(engine1, runX.runId);
      return run?.state === 'index-pending' ? run : null;
    }, 30000, 'run reaches index-pending (promotion done, index failed)');
    const runtime1 = await runtimeOf(engine1);
    const fileX = fileFor(fixture.shas.X);
    const hashX = hashFile(fileX);
    const diskX = readRunFromDisk(dataDir, runX.runId);
    evidence.phases.indexFailure = {
      run: { state: stuck.state, phase: stuck.phase, indexState: stuck.indexState, promotedAt: stuck.promotedAt, error: stuck.error },
      runtime: { lastAnalyzedCommit: runtime1.lastAnalyzedCommit, indexDirty: runtime1.index.dirty, indexStatus: runtime1.index.status },
      knowledgeFile: { path: path.basename(fileX), bytes: fs.statSync(fileX).size, hash: hashX },
      analyzerStartsForX: startsFor(fixture.shas.X),
      vectorSyncRequests: vector.requests.filter(r => r.url === '/api/sync').length,
      diskIndexAttempts: diskX.run.indexAttempts,
      diskState: diskX.run.state,
    };
    assert.equal(stuck.state, 'index-pending', 'index failure is a SEPARATE state, not failed');
    assert.equal(stuck.phase, 'index-pending');
    assert.equal(stuck.indexState, 'failed');
    assert.ok(stuck.promotedAt, 'promotion timestamp recorded - knowledge IS updated');
    assert.equal(stuck.error.code, 'INDEX_FAILED');
    assert.equal(stuck.error.message, '知识已更新，索引待修复。');
    assert.equal(stuck.error.retryable, true);
    assert.equal(stuck.error.details.failureKind, 'HTTP_ERROR');
    assert.equal(stuck.error.details.httpStatus, 503);
    assert.equal(stuck.error.details.upstreamCode, 'EMBEDDING_UNAVAILABLE');
    assert.equal(stuck.error.details.attempt, 1);
    assert.equal(runtime1.lastAnalyzedCommit, fixture.shas.X, 'pointer advanced - Markdown promotion committed');
    assert.equal(runtime1.index.dirty, true, 'runtime index marked dirty while knowledge is current');
    assert.ok(fs.existsSync(fileX), 'promoted Markdown exists on disk');
    assert.ok(fs.statSync(fileX).size > 0, 'promoted Markdown has real bytes');
    assert.equal(startsFor(fixture.shas.X), 1, 'analyzer ran exactly once');
    assert.equal(diskX.run.indexAttempts, 1, 'disk state records exactly one index attempt');

    // --- Expected 2 (part 1): explicit retry repairs the index only ---
    const promotedAtX = stuck.promotedAt;
    vector.setMode({ kind: 'ok' });
    const retried = await callJson(engine1.base, `/api/runs/${encodeURIComponent(runX.runId)}/retry`, {});
    assert.equal(retried.status, 200, `retry failed: ${JSON.stringify(retried.body)}`);
    const healed = await waitUntil(async () => {
      const run = await runById(engine1, runX.runId);
      return run?.state === 'succeeded' ? run : null;
    }, 30000, 'retried run succeeds after vector restored');
    const runtime2 = await runtimeOf(engine1);
    const diskX2 = readRunFromDisk(dataDir, runX.runId);
    evidence.phases.explicitRetry = {
      run: { state: healed.state, phase: healed.phase, indexState: healed.indexState, promotedAt: healed.promotedAt, error: healed.error },
      promotedAtUnchanged: healed.promotedAt === promotedAtX,
      knowledgeFileHashAfterRetry: hashFile(fileX),
      knowledgeFileHashBefore: hashX,
      analyzerStartsForX: startsFor(fixture.shas.X),
      diskIndexAttempts: diskX2.run.indexAttempts,
      vectorSyncRequests: vector.requests.filter(r => r.url === '/api/sync').length,
      runtime: { indexDirty: runtime2.index.dirty, indexStatus: runtime2.index.status },
    };
    assert.equal(healed.phase, 'ready');
    assert.equal(healed.indexState, 'succeeded');
    assert.equal(healed.error, null);
    assert.equal(healed.promotedAt, promotedAtX, 'promotion timestamp untouched by index retry');
    assert.equal(hashFile(fileX), hashX, 'Markdown bytes NOT rolled back or rewritten by index retry');
    assert.equal(startsFor(fixture.shas.X), 1, 'no second analyzer run - no duplicate paid analysis');
    assert.equal(diskX2.run.indexAttempts, 2, 'second index attempt recorded on disk');
    assert.equal(vector.requests.filter(r => r.url === '/api/sync').length, 2, 'one failed + one successful sync request');
    assert.equal(runtime2.index.dirty, false, 'index repaired: dirty cleared');
    assert.equal(runtime2.index.status, 'ready');

    // --- Expected 2 (part 2): restart auto-repairs index-pending without re-analysis ---
    vector.setMode(VECTOR_FAILURE);
    const runY = (await callJson(engine1.base, '/api/runs', { projectId: PROJECT_ID, commitSha: fixture.shas.Y })).body.run;
    const stuckY = await waitUntil(async () => {
      const run = await runById(engine1, runY.runId);
      return run?.state === 'index-pending' ? run : null;
    }, 30000, 'second run also reaches index-pending');
    const promotedAtY = stuckY.promotedAt;
    const fileY = fileFor(fixture.shas.Y);
    const hashY = hashFile(fileY);
    const startsYBeforeRestart = startsFor(fixture.shas.Y);
    await engine1.stop();
    const diskY = readRunFromDisk(dataDir, runY.runId);
    evidence.phases.restartSetup = {
      runY: { state: diskY.run.state, phase: diskY.run.phase, promotedAt: diskY.run.promotedAt, diskIndexAttempts: diskY.run.indexAttempts },
      knowledgeFileY: { hash: hashY, analyzerStarts: startsYBeforeRestart },
    };
    assert.equal(diskY.run.state, 'index-pending', 'index-pending persisted across shutdown');

    vector.setMode({ kind: 'ok' });
    const engine2 = await startEngineChild({ label: 'eng010-restart', dataDir, vectorUrl: vector.url, planFile, eventsFile });
    try {
      const autoHealed = await waitUntil(async () => {
        const run = await runById(engine2, runY.runId);
        return run?.state === 'succeeded' ? run : null;
      }, 45000, 'restart auto-retries index-pending run at initialize()');
      const diskY2 = readRunFromDisk(dataDir, runY.runId);
      const runtime3 = await runtimeOf(engine2);
      evidence.phases.restartAutoRetry = {
        runY: { state: autoHealed.state, phase: autoHealed.phase, indexState: autoHealed.indexState, promotedAt: autoHealed.promotedAt, error: autoHealed.error },
        promotedAtUnchanged: autoHealed.promotedAt === promotedAtY,
        knowledgeFileYHashAfterRestart: hashFile(fileY),
        knowledgeFileYHashBefore: hashY,
        analyzerStartsForYTotal: startsFor(fixture.shas.Y),
        diskIndexAttempts: diskY2.run.indexAttempts,
        runtime: { indexDirty: runtime3.index.dirty, indexStatus: runtime3.index.status },
        syncsForY: vector.requests.filter(r => r.url === '/api/sync' && r.body.project === PROJECT_ID).length,
      };
      assert.equal(autoHealed.promotedAt, promotedAtY, 'restart did not re-promote');
      assert.equal(hashFile(fileY), hashY, 'Markdown bytes unchanged across restart auto-repair');
      assert.equal(startsFor(fixture.shas.Y), startsYBeforeRestart, 'restart auto-repair did NOT run the analyzer again');
      assert.equal(diskY2.run.indexAttempts, 2, 'restart performed exactly one more index attempt');
      assert.equal(runtime3.index.dirty, false, 'index clean after auto-repair');
      await engine2.stop();
    } catch (error) {
      try { await engine2.stop(); } catch {}
      throw error;
    }

    evidence.verdict = {
      'expected1 知识已更新/索引待修复分开(index-pending独立状态+INDEX_FAILED可重试+指针已推进+dirty标记)': 'PASS',
      'expected2 不回滚Markdown、不重复付费分析(字节hash不变/analyzer恰好1次/promotedAt不变/重试只补索引)': 'PASS',
      extraRestartAutoRetry: 'PASS - initialize() automatically retries persisted index-pending without re-analysis',
      analyzerStandin: 'declarative stand-in - NO real model output covered',
      vectorDouble: 'loopback HTTP double scripted 503 EMBEDDING_UNAVAILABLE - vector-hub itself not covered',
    };
    await vector.close();
    saveEvidence(ARTIFACTS, 'eng010-evidence.json', evidence);
    console.log('ENG-010 PASS');
    process.exitCode = 0;
  } catch (error) {
    evidence.verdict = { failed: String(error && error.stack || error) };
    try { await engine1.stop(); } catch {}
    try { await vector.close(); } catch {}
    saveEvidence(ARTIFACTS, 'eng010-evidence.json', evidence);
    console.error(`ENG-010 FAIL: ${error.message}`);
    process.exitCode = 1;
  }
}

main();
