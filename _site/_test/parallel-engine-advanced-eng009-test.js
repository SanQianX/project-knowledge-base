'use strict';

// P-ENG-ADVANCED ENG-009 晋升中断恢复 (promotion interruption recovery) acceptance driver.
//
// Case (qa-autopilot/config/test-cases.json ENG-009, P0):
//   steps:    在许可的故障注入点中断测试writer，再重启。
//   expected: 1) journal恢复一致。 2) 不留下半晋升的假成功。 3) pointer顺序正确。
//
// Layer A (server-level real crash): the vendored engine child is HARD-KILLED
// (Windows TerminateProcess via kill(), no graceful cleanup) while a real run is
// mid-analysis, then a second engine child starts on the same data directory -
// exercising the real single-writer stale-lock break, initialize() recoverAll(),
// run recovery (running -> queued/recovering), and claim retry semantics.
//
// Layer B (fault-point crashes): the vendored KnowledgePromotionService's own
// production `fault` constructor hook hard-exits a child process at three
// permitted phases (journal-prepared / operation-applied:0 / promotion-verified,
// journal already persisted as awaiting-state-advance), then a fresh process
// runs the same recoverAll() the coordinator runs at every startup.
//
// Analyzer = declarative stand-in (NO real model output). Vector endpoint =
// loopback double.

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  makeLaneDir, buildFixtureRepo, waitUntil, callJson, startVectorDouble,
  startEngineChild, readEventsFile, writePlan, saveEvidence, isolatedEnv,
} = require('./helpers/parallel-engine-advanced-harness.js');

const ARTIFACTS = process.env.PK_TEST_EVIDENCE_ROOT
  ? path.join(process.env.PK_TEST_EVIDENCE_ROOT, 'eng009')
  : path.resolve(__dirname, '../../qa-autopilot/artifacts/parallel-20261023/engine-review-r3/reruns/eng009');
const FAULT_WRITER = path.join(__dirname, 'helpers', 'parallel-engine-advanced-fault-writer.js');
const PROJECT_ID = 'project-eng009';

function runFaultWriter(mode, workDir) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [FAULT_WRITER, mode, workDir], { windowsHide: true, env: isolatedEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', chunk => { stderr += chunk; });
    proc.on('error', reject);
    proc.on('close', code => resolve({ mode, code, stderr: stderr.slice(0, 500) }));
  });
}

function hashFile(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 16);
}

async function main() {
  const lane = makeLaneDir('eng009');
  const commands = [];
  const evidence = { caseId: 'ENG-009', laneDir: lane, phases: {}, commands };

  // ---------- Layer A: hard crash of a live engine child, then restart ----------
  const fixture = buildFixtureRepo(lane, 'eng009', ['X']);
  const knowledgePath = path.join(lane, 'knowledge-eng009');
  fs.mkdirSync(knowledgePath, { recursive: true });
  const planFile = path.join(lane, 'analyzer-plan.json');
  const eventsFile = path.join(lane, 'analyzer-events.jsonl');
  writePlan(planFile, { default: {}, rules: [{ projectId: PROJECT_ID, commitSha: fixture.shas.X, delayMs: 5000 }] });

  const vector = await startVectorDouble();
  const dataDir = path.join(lane, 'engine-data');
  const engine1 = await startEngineChild({ label: 'eng009', dataDir, vectorUrl: vector.url, planFile, eventsFile });
  commands.push('LayerA: POST /api/runs X (analyzer stall 5s)', 'LayerA: hard-kill engine child mid-analysis', 'LayerA: restart engine child on same dataDir');

  try {
    assert.equal((await callJson(engine1.base, '/api/projects', {
      projectId: PROJECT_ID, name: 'eng009', repoPath: fixture.repoPath, knowledgePath, trackingStartCommit: fixture.baseline,
    })).status, 200);
    const runX = (await callJson(engine1.base, '/api/runs', { projectId: PROJECT_ID, commitSha: fixture.shas.X })).body.run;
    await waitUntil(() => readEventsFile(eventsFile).some(e => e.kind === 'start' && e.commitSha === fixture.shas.X), 20000, 'analyzer started X');

    const killCode = await engine1.killHard();
    const stateRaw = JSON.parse(fs.readFileSync(path.join(dataDir, 'engine-state.json'), 'utf8'));
    const crashedRun = stateRaw.runs.find(r => r.runId === runX.runId);
    const lockFile = path.join(dataDir, 'engine-runtime.lock');
    const lockOwner = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
    const promotionsDir = path.join(dataDir, 'runtime', 'promotions', PROJECT_ID);
    evidence.phases.layerACrash = {
      killExitCode: killCode,
      runStateOnDiskAfterKill: { state: crashedRun.state, phase: crashedRun.phase },
      lockOwnerPid: lockOwner.pid,
      lockOwnerPidWasEngineChild: lockOwner.pid === engine1.proc.pid,
      promotionJournalsOnDisk: fs.existsSync(promotionsDir) ? fs.readdirSync(promotionsDir) : [],
      pointerAtCrash: stateRaw.projects.find(p => p.projectId === PROJECT_ID).runtime.lastAnalyzedCommit,
    };
    assert.equal(crashedRun.state, 'running', 'run was live when the writer was interrupted');
    assert.equal(lockOwner.pid, engine1.proc.pid, 'single-writer lock belonged to the killed engine');
    assert.equal(evidence.phases.layerACrash.pointerAtCrash, fixture.baseline, 'pointer untouched before durable promotion');

    // Restart on the same dataDir: stale lock must break via dead owner pid.
    const engine2 = await startEngineChild({ label: 'eng009-restart', dataDir, vectorUrl: vector.url, planFile, eventsFile });
    try {
      const recovered = await waitUntil(async () => {
        const runs = (await callJson(engine2.base, `/api/runs?projectId=${PROJECT_ID}`)).body.runs;
        return runs.length === 1 && runs[0].state === 'succeeded' ? runs[0] : null;
      }, 45000, 'restarted engine completes the interrupted run');
      const events = readEventsFile(eventsFile);
      const starts = events.filter(e => e.kind === 'start' && e.commitSha === fixture.shas.X);
      const runtime = (await callJson(engine2.base, `/api/snapshot?projectId=${PROJECT_ID}`)).body.projects.find(p => p.projectId === PROJECT_ID).runtime;
      const knowledgeFiles = fs.readdirSync(path.join(knowledgePath, 'changes'));
      const journalFiles = fs.readdirSync(promotionsDir);
      const journal = JSON.parse(fs.readFileSync(path.join(promotionsDir, journalFiles[0]), 'utf8'));
      evidence.phases.layerARecovery = {
        runId: recovered.runId,
        sameRunIdAsBeforeCrash: recovered.runId === runX.runId,
        state: recovered.state,
        promotedAt: recovered.promotedAt,
        analyzerStartsForX: starts.length,
        attemptEvidence: 'crash before durable state advance -> engine re-runs analysis (attempt 2) rather than faking success',
        lastAnalyzedCommit: runtime.lastAnalyzedCommit,
        knowledgeChangesFiles: knowledgeFiles,
        journalPhase: journal.phase,
        journalOperationsApplied: journal.operations.map(op => ({ path: op.path, applied: op.applied })),
        lockFileRecreatedByRestart: JSON.parse(fs.readFileSync(lockFile, 'utf8')).pid === engine2.proc.pid,
      };
      assert.equal(recovered.runId, runX.runId, 'no duplicate run created by recovery');
      assert.equal(starts.length, 2, 'analyzer ran once pre-crash and once after restart (no fake success)');
      assert.equal(runtime.lastAnalyzedCommit, fixture.shas.X, 'pointer advanced exactly to X after recovery');
      assert.deepEqual(knowledgeFiles, [`${fixture.shas.X.slice(0, 12)}.md`], 'exactly one promoted knowledge file');
      assert.equal(journal.phase, 'completed', 'promotion journal reaches terminal completed phase');
      assert.ok(journal.operations.every(op => op.applied), 'all journal operations applied');
      await engine2.stop();
    } catch (error) {
      try { await engine2.stop(); } catch {}
      throw error;
    }

    // ---------- Layer B: fault-point crashes through the promotion service's own hook ----------
    const scenarios = [
      { mode: 'crash-prepared', expect: 'rolled-back' },
      { mode: 'crash-mid-apply', expect: 'rolled-back' },
      { mode: 'crash-after-apply', expect: 'completed' },
    ];
    evidence.phases.layerB = {};
    for (const scenario of scenarios) {
      const workDir = path.join(lane, `fault-${scenario.mode}`);
      const crash = await runFaultWriter(scenario.mode, workDir);
      commands.push(`LayerB ${scenario.mode}: fault-writer exit ${crash.code}`);
      assert.equal(crash.code, 137, `${scenario.mode} child hard-exited at the fault point (got ${crash.code}, stderr: ${crash.stderr})`);
      const recover = await runFaultWriter('recover', workDir);
      assert.equal(recover.code, 0, `${scenario.mode} recovery process succeeded (${recover.stderr})`);
      const result = JSON.parse(fs.readFileSync(path.join(workDir, 'fault-result.json'), 'utf8'));
      const readme = fs.readFileSync(path.join(workDir, 'knowledge', 'README.md'), 'utf8');
      const changesDir = path.join(workDir, 'knowledge', 'changes');
      const recoverAgain = await runFaultWriter('recover', workDir);
      const againResult = JSON.parse(fs.readFileSync(path.join(workDir, 'fault-result.json'), 'utf8'));
      evidence.phases.layerB[scenario.mode] = {
        crashExitCode: crash.code,
        recoverAll: result.recoverAll,
        lastAnalyzedCommit: result.lastAnalyzedCommit,
        activeClaimRunId: result.activeClaimRunId,
        readmeStartsWith: readme.slice(0, 40),
        changesFiles: result.changesFiles,
        indexDirty: result.indexDirty,
        indexGeneration: result.indexGeneration,
        secondRecoverAll: againResult.recoverAll,
      };
      if (scenario.expect === 'rolled-back') {
        assert.equal(result.recoverAll[0].phase, 'rolled-back', `${scenario.mode}: journal rolled back consistently`);
        assert.ok(readme.startsWith('# eng009 fixture knowledge (original)'), `${scenario.mode}: knowledge restored - no half-promoted state`);
        assert.deepEqual(result.changesFiles, [], `${scenario.mode}: created file removed by rollback`);
        assert.equal(result.lastAnalyzedCommit, null, `${scenario.mode}: pointer NOT advanced`);
        assert.equal(result.activeClaimRunId, 'run-11111111-2222-3333-4444-555555555555', `${scenario.mode}: claim retained for explicit retry, not silently faked`);
      } else {
        assert.equal(result.recoverAll[0].phase, 'completed', 'after-apply: journal completed forward');
        assert.ok(readme.startsWith('# eng009 fixture knowledge (replaced)'), 'after-apply: both operations final');
        assert.equal(result.changesFiles.length, 1, 'after-apply: created file present');
        assert.equal(result.lastAnalyzedCommit, 'a'.repeat(40), 'after-apply: pointer advanced exactly once via recovery');
        assert.equal(result.activeClaimRunId, null, 'after-apply: active claim cleared');
        assert.equal(result.indexDirty, true, 'after-apply: index marked dirty for repair');
        assert.equal(result.indexGeneration, 1, 'after-apply: index generation advanced once');
      }
      assert.ok(againResult.recoverAll.every(r => r.skipped === true || r.phase === 'rolled-back' || r.phase === 'completed'), 'second recovery is idempotent (skipped)');
    }

    evidence.verdict = {
      'expected1 journal恢复一致(终端相位+二次恢复幂等)': 'PASS',
      'expected2 不留下半晋升的假成功(mid-apply回滚/after-apply完整推进/崩溃后重分析而非假成功)': 'PASS',
      'expected3 pointer顺序正确(仅经journal完成推进, 基线→X单一序列)': 'PASS',
      injectionPoints: 'Layer A: real process hard-kill mid-analysis; Layer B: vendored KnowledgePromotionService production fault hook (journal-prepared / operation-applied:0 / promotion-verified)',
      analyzerStandin: 'declarative stand-in - NO real model output covered',
      vectorDouble: 'loopback HTTP double - vector-hub itself not covered',
    };
    await vector.close();
    saveEvidence(ARTIFACTS, 'eng009-evidence.json', evidence);
    console.log('ENG-009 PASS');
    process.exitCode = 0;
  } catch (error) {
    evidence.verdict = { failed: String(error && error.stack || error) };
    try { await engine1.stop(); } catch {}
    try { await vector.close(); } catch {}
    saveEvidence(ARTIFACTS, 'eng009-evidence.json', evidence);
    console.error(`ENG-009 FAIL: ${error.message}`);
    process.exitCode = 1;
  }
}

main();
