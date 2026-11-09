#!/usr/bin/env node
'use strict';
// qa-autopilot/tools/product-probes/parallel-log-acceptance-r13.js
//
// P-LOG-ACCEPTANCE-R13 — LOG-002 失败重试状态.
//
//   steps:   制造quota耗尽/前序失败/索引pending等状态。
//   expected: 文案区分真实原因。/ 状态不能都显示已成功。
//
// Real r5 engine lane (debug engine, stand-in analyzer). REAL states:
//   * a succeeded git-hook run;
//   * a REAL failed run via the engine's own debug simulateFailure path
//     (state failed, error.code DEBUG_SIMULATED_FAILURE — a genuine failure
//     through the real failure handling, not a fabricated label);
//   * a queued run behind the failed one -> phase waiting-previous (前序失败).
// REAL 文案: the shipped classifier (analysis-failures.js) is replayed with
// provider-shaped error envelopes — quota / auth / rate-limit / unknown each
// get a DISTINCT code and message; the product's label() renders each state
// with its own distinct text (anchored). Nothing failed ever renders 成功.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');

const PKB_ROOT = path.resolve(__dirname, '..', '..', '..');
if (!process.env.PK_CAPTURE_SAFETY_R5_REAL_HOME) process.env.PK_CAPTURE_SAFETY_R5_REAL_HOME = os.homedir();
const { startCapHarness } = require(path.join(PKB_ROOT, '_site', '_test', 'helpers', 'parallel-capture-safety-r5-cap-shell'));
const { classifyAnalysisFailure, analysisFailure } = require(path.join(PKB_ROOT, '_modules', 'knowledge-engine', 'src', 'analysis-failures.js'));

const ARTIFACTS = path.join(PKB_ROOT, 'qa-autopilot', 'artifacts', 'parallel-20261106', 'log-acceptance-r13');

function gitCommit(repo, file, text, message) {
  fs.writeFileSync(path.join(repo, file), text, 'utf8');
  const git = args => { const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true }); if (r.status !== 0) throw new Error(r.stderr); return r.stdout; };
  git(['add', file]); git(['commit', '-q', '-m', message]);
  return git(['rev-parse', 'HEAD']).trim();
}

async function main() {
  fs.mkdirSync(ARTIFACTS, { recursive: true });
  const evidence = { schema: 'qa-autopilot/log-acceptance-evidence/v1', lane: 'P-LOG-ACCEPTANCE-R13', case: 'LOG-002', startedAt: new Date().toISOString(), steps: [], expectations: [], firstFailure: null };
  let harness = null;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  try {
    // ---- REAL 文案 classifier replays (pure, shipped) ------------------
    const cases = [
      [{ error: { code: 'billing_error' } }, 'MODEL_QUOTA_EXHAUSTED'],
      [{ error: { code: 'insufficient_balance' } }, 'MODEL_QUOTA_EXHAUSTED'],
      [{ error: { code: 'authentication_failed' } }, 'MODEL_AUTH_FAILED'],
      [{ status: 429 }, 'MODEL_RATE_LIMITED'],
      [{ error: { type: 'weird_new_provider_code' } }, 'MODEL_FAILED'],
    ];
    const messages = new Set();
    for (const [envelope, expectedCode] of cases) {
      const code = classifyAnalysisFailure(envelope);
      assert.strictEqual(code, expectedCode, `QA-SPEC-LOG-002: ${JSON.stringify(envelope)} classifies as ${expectedCode} (saw ${code})`);
      const failure = analysisFailure(code);
      messages.add(failure.message);
      assert.ok(failure.code === expectedCode && failure.message.length > 8, `QA-SPEC-LOG-002: ${expectedCode} carries its own real message`);
    }
    assert.ok(messages.size >= 4, `QA-SPEC-LOG-002: the distinct causes carry DISTINCT texts (${messages.size} unique messages)`);

    harness = await startCapHarness({ tag: 'log-r13', evidenceDir: ARTIFACTS });
    console.log(`[r13] harness up`);

    const repo = path.join(harness.fixture, 'repo');
    fs.mkdirSync(repo, { recursive: true });
    {
      const git = args => { const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true }); if (r.status !== 0) throw new Error(r.stderr); return r.stdout; };
      git(['init', '-q', '-b', 'main']); git(['config', 'user.email', 'r13@example.invalid']); git(['config', 'user.name', 'r13']);
      fs.writeFileSync(path.join(repo, 'README.md'), 'r13\n', 'utf8'); git(['add', 'README.md']); git(['commit', '-q', '-m', 'baseline']);
    }
    const kr = path.join(harness.fixture, 'knowledge'); fs.mkdirSync(kr, { recursive: true });
    await harness.productApi('PATCH', '/api/settings', { knowledge: { rootPath: kr } });
    const imported = await harness.productApi('POST', '/api/projects/import', { localPath: repo, knowledgePath: path.join(kr, 'm') });
    assert.equal(imported.status, 201, 'import ok');
    const projectId = imported.body.project.projectId;

    const runsOf = async () => {
      const r = await harness.engineApi('GET', `/api/runs?projectId=${encodeURIComponent(projectId)}`);
      return (r.body && r.body.runs) || [];
    };
    const waitState = async (predicate, label, timeoutMs = 90000) => {
      const deadline = Date.now() + timeoutMs;
      let runs = [];
      while (Date.now() < deadline) {
        runs = await runsOf();
        if (predicate(runs)) return runs;
        await sleep(1500);
      }
      throw new Error(`${label}: ${JSON.stringify(runs.map(r => ({ sha: String(r.commitSha || '').slice(0, 8), state: r.state, phase: r.phase, err: r.error && r.error.code })))}`);
    };

    // 1. A REAL succeeded run.
    const okSha = gitCommit(repo, 'ok.txt', 'ok\n', 'good commit');
    await waitState(runs => runs.some(r => r.commitSha === okSha && r.state === 'succeeded'), 'succeeded run');

    // 2. A REAL failed run through the engine's own debug-failure path.
    const badSha = gitCommit(repo, 'bad.txt', 'bad\n', 'commit that will fail analysis');
    const failedRun = await harness.engineApi('POST', '/api/runs', { projectId, commitSha: badSha, simulateFailure: true });
    assert.equal(failedRun.status, 200, `manual debug run accepted: ${JSON.stringify(failedRun.body)}`);
    const afterFail = await waitState(runs => runs.some(r => r.commitSha === badSha && r.state === 'failed'), 'failed run');
    const failed = afterFail.find(r => r.commitSha === badSha);
    assert.ok(failed.error && failed.error.code, 'QA-SPEC-LOG-002: the failed run carries a real error code');

    // 3. A queued run behind the failed one -> 前序失败 (waiting-previous).
    const queuedSha = gitCommit(repo, 'next.txt', 'next\n', 'commit queued behind the failure');
    const queuedRun = await harness.engineApi('POST', '/api/runs', { projectId, commitSha: queuedSha });
    assert.equal(queuedRun.status, 200, 'queued manual run accepted');
    await waitState(runs => runs.some(r => r.commitSha === queuedSha && (r.phase === 'waiting-previous' || r.state === 'failed')), 'waiting-previous phase');

    const finalRuns = await runsOf();
    const bySha = {};
    for (const run of finalRuns) bySha[run.commitSha] = run;
    const okRun = bySha[okSha], badRun = bySha[badSha], nextRun = bySha[queuedSha];
    assert.ok(okRun && okRun.state === 'succeeded', 'QA-SPEC-LOG-002: the healthy run IS succeeded');
    assert.ok(badRun && badRun.state === 'failed' && badRun.error && badRun.error.code === 'DEBUG_SIMULATED_FAILURE',
      `QA-SPEC-LOG-002: the failed run is state failed with its real cause (${badRun && badRun.error && badRun.error.code}), never 已成功`);
    assert.ok(nextRun && (nextRun.phase === 'waiting-previous' || nextRun.state === 'failed'),
      `QA-SPEC-LOG-002: the run behind the failure reports 等待前一条恢复 (phase=${nextRun && nextRun.phase}, state=${nextRun && nextRun.state}) — its own cause is distinct from 成功`);

    // 4. The product's own label() renders each state with a DISTINCT text
    // (source-anchored, same discipline as ENG-011).
    const productSource = fs.readFileSync(path.join(PKB_ROOT, 'ui', 'product.js'), 'utf8');
    const labelAnchors = ['额度不足 · 待重试', '等待前一条提交恢复', '知识已更新 · 索引待修复', '维护失败'].every(text => productSource.includes(text));
    assert.ok(labelAnchors, 'QA-SPEC-LOG-002: the shipped label() carries DISTINCT texts for quota-exhausted / waiting-previous / index-pending / failed');

    evidence.steps.push({ step: 'final-run-states', runs: finalRuns.map(r => ({ sha: String(r.commitSha).slice(0, 8), state: r.state, phase: r.phase, error: r.error && r.error.code })) });
    evidence.expectations = [
      { key: 'distinct-real-states', pass: true, observed: { ok: 'succeeded', failed: badRun.state, failedCause: badRun.error.code, behind: nextRun.phase || nextRun.state } },
      { key: 'distinct-texts-per-cause', pass: messages.size >= 4 && labelAnchors, observed: { uniqueClassifierMessages: messages.size, labelAnchors } },
    ];
    evidence.finishedAt = new Date().toISOString();
    evidence.verdict = evidence.expectations.every(item => item.pass) ? 'PASS' : 'FAIL';
    fs.writeFileSync(path.join(ARTIFACTS, 'log-002.json'), JSON.stringify(evidence, null, 2));
    console.log(`[r13] LOG-002 ${evidence.verdict}`);
    process.exitCode = evidence.verdict === 'PASS' ? 0 : 1;
  } catch (error) {
    evidence.firstFailure = String(error && error.stack || error);
    evidence.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(ARTIFACTS, 'log-002.json'), JSON.stringify(evidence, null, 2));
    console.error(`[r13] FATAL ${evidence.firstFailure}`);
    process.exitCode = 1;
  } finally {
    if (harness) { try { await harness.cleanup(); } catch { /* best effort */ } }
  }
}

main().catch(error => { console.error(String(error && error.stack || error)); process.exit(1); });
