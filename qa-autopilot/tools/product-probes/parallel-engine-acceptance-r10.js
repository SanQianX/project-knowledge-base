#!/usr/bin/env node
'use strict';
// qa-autopilot/tools/product-probes/parallel-engine-acceptance-r10.js
//
// P-ENGINE-ACCEPTANCE-R10 — ENG-007 (离线提交补偿) + LOG-001 (活动分页) in
// ONE r5 cap-shell lane: real product server, real console, real vendored
// engine in-process (frozen stand-in analyzer with an empty plan — runs
// triggered by real commit boundaries complete, stated honestly), real
// managed post-commit hooks, real git commits.
//
//   ENG-007 steps: 仅停测试服务，Git提交成功后再启动。
//     expected: Git不被Hook故障阻塞。/ 启动对账补漏。/ 已完成SHA不重跑。
//       -> pause the journal consumer (the analysis service being down),
//          commit for real (git must succeed; the hook fires `|| true; exit 0`
//          and the boundary lands in the journal), resume -> the cursor
//          catch-up creates the missed run; replaying the same boundary
//          through the real hook NEVER creates a second run for that SHA.
//
//   LOG-001 steps: 生成多页知识run，切页并打开详情再更新。
//     expected: 按游标稳定分页。/ 打开详情不被刷新重置。
//       -> 8 real runs; walk /api/runs?summary=1 pages with the before-cursor
//          (no dup/missing), fetch a run detail mid-walk, then add a new run
//          and re-read the SAME cursor page — byte-identical (cursor stable).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawnSync, execFileSync } = require('node:child_process');

const PKB_ROOT = path.resolve(__dirname, '..', '..', '..');
// The r5 shell contract normally provided by its wrapper: the real home for
// the read-only leak comparison, and the pre-resolved Chrome binary. This
// probe runs outside that wrapper, so it pins the same two values itself
// (read-only: the shell only digests the real home, never writes it).
if (!process.env.PK_CAPTURE_SAFETY_R5_REAL_HOME) process.env.PK_CAPTURE_SAFETY_R5_REAL_HOME = os.homedir();
if (!process.env.KB_CHROME_PATH) {
  const chromeCandidates = [
    path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  ];
  process.env.KB_CHROME_PATH = chromeCandidates.find(candidate => candidate && fs.existsSync(candidate)) || '';
}
const { startCapHarness } = require(path.join(PKB_ROOT, '_site', '_test', 'helpers', 'parallel-capture-safety-r5-cap-shell'));

const ARTIFACTS = path.join(PKB_ROOT, 'qa-autopilot', 'artifacts', 'parallel-20261106', 'engine-acceptance-r10');

function gitCommit(repo, file, text, message) {
  fs.writeFileSync(path.join(repo, file), text, 'utf8');
  const git = args => { const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true }); if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`); return r.stdout; };
  git(['add', file]);
  git(['commit', '-q', '-m', message]);
  return git(['rev-parse', 'HEAD']).trim();
}

async function main() {
  fs.mkdirSync(ARTIFACTS, { recursive: true });
  const evidence = { schema: 'qa-autopilot/engine-acceptance-evidence/v1', lane: 'P-ENGINE-ACCEPTANCE-R10', startedAt: new Date().toISOString(), cases: {}, steps: [], firstFailure: null };
  let harness = null;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  try {
    harness = await startCapHarness({ tag: 'eng-r10', evidenceDir: ARTIFACTS });
    console.log(`[r10] harness up fixture=${harness.fixture}`);

    // ---- project with the real managed hook ---------------------------
    const repo = path.join(harness.fixture, 'repo');
    fs.mkdirSync(repo, { recursive: true });
    {
      const git = args => { const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true }); if (r.status !== 0) throw new Error(r.stderr); return r.stdout; };
      git(['init', '-q', '-b', 'main']); git(['config', 'user.email', 'r10@example.invalid']); git(['config', 'user.name', 'r10']);
      fs.writeFileSync(path.join(repo, 'README.md'), 'r10\n', 'utf8'); git(['add', 'README.md']); git(['commit', '-q', '-m', 'baseline']);
    }
    const knowledgeRoot = path.join(harness.fixture, 'knowledge');
    fs.mkdirSync(knowledgeRoot, { recursive: true });
    const settings = await harness.productApi('PATCH', '/api/settings', { knowledge: { rootPath: knowledgeRoot } });
    assert.equal(settings.status, 200, `settings: ${JSON.stringify(settings.body)}`);
    const knowledgePath = path.join(knowledgeRoot, 'main');
    fs.mkdirSync(knowledgePath, { recursive: true });
    const imported = await harness.productApi('POST', '/api/projects/import', { localPath: repo, knowledgePath });
    assert.equal(imported.status, 201, `import: ${JSON.stringify(imported.body)}`);
    const projectId = imported.body.project.projectId;
    assert.ok((imported.body.modules || {}).engine && imported.body.modules.engine.ok === true, `engine module registered: ${JSON.stringify(imported.body.modules)}`);
    const hookFile = path.join(repo, '.git', 'hooks', 'post-commit');
    assert.ok(fs.existsSync(hookFile), 'the managed post-commit hook exists');
    evidence.steps.push({ step: 'project-imported', projectId });

    // ---- wait for the engine to be consuming --------------------------
    let health = null;
    await harness.waitFor(async () => {
      const result = await harness.engineApi('GET', '/api/health');
      health = result.body;
      return Boolean(health && health.journal && health.journal.enabled === true);
    }, 'engine journal consumption enabled', 60000);

    const runsOf = async () => {
      const r = await harness.engineApi('GET', `/api/runs?projectId=${encodeURIComponent(projectId)}`);
      return (r.body && r.body.runs) || [];
    };
    const waitRunCount = async (n, label, timeoutMs = 90000) => {
      const deadline = Date.now() + timeoutMs;
      let runs = [];
      while (Date.now() < deadline) {
        runs = await runsOf();
        const done = runs.filter(run => run.state === 'succeeded').length;
        if (done >= n) return runs;
        await sleep(1500);
      }
      throw new Error(`${label}: expected >=${n} succeeded runs, saw ${JSON.stringify(runs.map(r => ({ sha: r.commitSha && r.commitSha.slice(0, 8), state: r.state })))}`);
    };

    // ================= ENG-007: 离线提交补偿 ============================
    {
      const ev = { case: 'ENG-007', expectations: [] };

      // (1) 停测试服务: the journal consumer pauses (the analysis service is
      // "down"); everything else (git, hook, journal) keeps running.
      harness.engine.coordinator.consume = false;
      evidence.steps.push({ step: 'consumer-paused' });

      // (2) A real commit while the consumer is down. Git MUST succeed.
      const offlineSha = gitCommit(repo, 'offline.txt', 'offline commit\n', 'commit while the analyzer is down');
      evidence.steps.push({ step: 'offline-commit-created', sha: offlineSha });
      // Diagnostic: what the managed hook actually invokes.
      evidence.steps.push({ step: 'hook-file-content', content: fs.readFileSync(hookFile, 'utf8') });
      ev.expectations.push({ key: 'git-not-blocked-by-hook', pass: true, observed: { note: 'the real git commit returned 0 while the consumer was paused; the managed hook is structural `|| true; exit 0`' } });

      // The hook really fired while the consumer was down: the product's
      // own data-dir log carries hook.boundary.captured with this SHA (the
      // durable capture record — proven location, see the r10 diagnostics).
      const projectLog = path.join(harness.fixture, 'data', 'logs', 'projects', projectId, new Date().toISOString().slice(0, 10) + '.jsonl');
      await harness.waitFor(async () => {
        try {
          const lines = fs.readFileSync(projectLog, 'utf8').split('\n');
          return lines.some(line => line.includes('hook.boundary.captured') && line.includes(offlineSha));
        } catch { return false; }
      }, 'the offline boundary was durably captured while the consumer was down', 30000);
      ev.expectations.push({ key: 'boundary-captured-while-down', pass: true, observed: { note: 'the managed hook durably captured the commit boundary while consumption was paused (hook.boundary.captured in the product data-dir log)' } });

      // (3) 启动: resume; the cursor catch-up must pick the missed commit up.
      harness.engine.coordinator.consume = true;
      let catchUpRuns = [];
      const deadline = Date.now() + 90000;
      while (Date.now() < deadline) {
        catchUpRuns = await runsOf();
        if (catchUpRuns.some(run => run.commitSha === offlineSha && run.state === 'succeeded')) break;
        await sleep(1500);
      }
      ev.expectations.push({
        key: 'startup-catchup-completes-missed-commit',
        pass: catchUpRuns.some(run => run.commitSha === offlineSha && run.state === 'succeeded'),
        observed: { offlineSha, runsAfterCatchUp: catchUpRuns.map(r => ({ sha: r.commitSha.slice(0, 8), state: r.state, trigger: r.trigger })) },
      });

      // (4) 已完成SHA不重跑: replay the SAME boundary by running the real
      // managed hook again (HEAD unchanged) — the skip logic must keep the
      // run count for this SHA at exactly one.
      const replay = spawnSync('sh', [hookFile], { cwd: repo, encoding: 'utf8', windowsHide: true, timeout: 30000 });
      evidence.steps.push({ step: 'boundary-replayed-through-real-hook', exit: replay.status, stderr: String(replay.stderr || '').slice(0, 120) });
      await sleep(8000); // let the drain poll process the duplicate
      const afterReplay = await runsOf();
      const runsForSha = afterReplay.filter(run => run.commitSha === offlineSha);
      ev.expectations.push({
        key: 'completed-sha-never-rerun',
        pass: runsForSha.length === 1,
        observed: { runsForOfflineSha: runsForSha.map(r => ({ runId: r.runId, state: r.state })) },
      });
      ev.verdict = ev.expectations.every(item => item.pass) ? 'PASS' : 'FAIL';
      evidence.cases['ENG-007'] = ev;
      console.log(`[r10] ENG-007 ${ev.verdict}`);
    }

    // ================= LOG-001: 活动分页 ================================
    {
      const ev = { case: 'LOG-001', expectations: [] };
      // More commits -> more real runs (8 total incl. the offline one).
      for (let i = 1; i <= 7; i += 1) gitCommit(repo, `f${i}.txt`, `content ${i}\n`, `commit ${i}`);
      const all = await waitRunCount(8, 'eight succeeded runs');
      ev.expectations.push({ key: 'eight-real-runs', pass: all.length >= 8, observed: { total: all.length } });

      // Walk the pages with the before-cursor.
      const pageShape = await harness.engineApi('GET', `/api/runs?summary=1&projectId=${encodeURIComponent(projectId)}&limit=3`);
      const firstPage = pageShape.body;
      const cursorOf = page => page && (page.nextCursor !== undefined && page.nextCursor !== null ? page.nextCursor : page.nextBefore !== undefined ? page.nextBefore : page.cursor !== undefined ? page.cursor : page.next !== undefined ? page.next : null);
      const runsOfPage = page => (page && (page.runs || page.items)) || [];
      assert.ok(runsOfPage(firstPage).length === 3, `first page has 3 rows: ${JSON.stringify(Object.keys(firstPage || {}))}`);
      const collected = [];
      let cursor = cursorOf(firstPage);
      collected.push(...runsOfPage(firstPage).map(r => r.runId));
      // Detail fetch mid-walk (打开详情).
      const detail = await harness.engineApi('GET', `/api/runs/${encodeURIComponent(runsOfPage(firstPage)[0].runId)}`);
      ev.expectations.push({ key: 'detail-readable-mid-paging', pass: detail.status === 200 && detail.body && detail.body.run, observed: { detailStatus: detail.status, detailBodyKeys: detail.body ? Object.keys(detail.body) : null, hasRun: Boolean(detail.body && detail.body.run) } });
      let guard = 0;
      const savedCursor = cursor;
      const savedPageTwoFetch = cursor ? await harness.engineApi('GET', `/api/runs?summary=1&projectId=${encodeURIComponent(projectId)}&limit=3&before=${encodeURIComponent(cursor)}`) : null;
      const savedPageTwo = savedPageTwoFetch && savedPageTwoFetch.body;
      while (cursor && guard++ < 10) {
        const r = await harness.engineApi('GET', `/api/runs?summary=1&projectId=${encodeURIComponent(projectId)}&limit=3&before=${encodeURIComponent(cursor)}`);
        const page = r.body;
        const rows = runsOfPage(page);
        if (!rows.length) break;
        collected.push(...rows.map(x => x.runId));
        cursor = cursorOf(page);
      }
      const unique = new Set(collected);
      ev.expectations.push({
        key: 'cursor-paging-complete-no-dup',
        pass: collected.length === unique.size && unique.size >= 8,
        observed: { collected: collected.length, unique: unique.size },
      });

      // A NEW run must not disturb the saved cursor page (游标稳定).
      gitCommit(repo, 'new.txt', 'after paging\n', 'commit after paging');
      await waitRunCount(9, 'ninth run');
      const sameCursorFetch = await harness.engineApi('GET', `/api/runs?summary=1&projectId=${encodeURIComponent(projectId)}&limit=3&before=${encodeURIComponent(savedCursor)}`);
      const samePage = sameCursorFetch.body;
      const stable = JSON.stringify(runsOfPage(samePage).map(r => r.runId)) === JSON.stringify(runsOfPage(savedPageTwo).map(r => r.runId));
      ev.expectations.push({
        key: 'cursor-page-stable-across-new-runs',
        pass: stable,
        observed: { savedPage: runsOfPage(savedPageTwo).map(r => r.runId), refetched: runsOfPage(samePage).map(r => r.runId) },
      });
      ev.verdict = ev.expectations.every(item => item.pass) ? 'PASS' : 'FAIL';
      evidence.cases['LOG-001'] = ev;
      console.log(`[r10] LOG-001 ${ev.verdict}`);
    }

    // ================= ENG-011: 重试不重复委派 ==========================
    {
      const ev = { case: 'ENG-011', expectations: [] };
      const runs = await runsOf();
      const succeeded = runs.find(run => run.state === 'succeeded');
      assert.ok(succeeded, 'a succeeded run exists for the retry-gate probe');
      // (1) The API gate: a COMPLETED intent can never be re-dispatched —
      // retry answers 409 with the exact refusal (同一意图不会重复派发).
      const retryDone = await harness.engineApi('POST', `/api/runs/${encodeURIComponent(succeeded.runId)}/retry`, {});
      ev.expectations.push({
        key: 'completed-intent-refused',
        pass: retryDone.status === 409,
        observed: { status: retryDone.status, body: String(JSON.stringify(retryDone.body || '')).slice(0, 160) },
      });
      // (2) 活动状态正确 + 请求结果未知先查询: the run detail GET answers
      // the CURRENT state (query-first), and the product's own UI renders the
      // retry affordance ONLY for failed/index-pending states (source-bound).
      const detail = await harness.engineApi('GET', `/api/runs/${encodeURIComponent(succeeded.runId)}`);
      ev.expectations.push({
        key: 'query-first-state-correct',
        pass: detail.status === 200 && detail.body && detail.body.run && detail.body.run.state === 'succeeded',
        observed: { status: detail.status, state: detail.body && detail.body.run && detail.body.run.state },
      });
      const productSource = fs.readFileSync(path.join(PKB_ROOT, 'ui', 'product.js'), 'utf8');
      const uiGate = productSource.includes("['failed', 'index-pending'].includes(r.state)") && productSource.includes('data-retry-run');
      ev.expectations.push({
        key: 'ui-retry-affordance-state-gated',
        pass: uiGate,
        observed: { uiGate, anchor: "ui/product.js: ['failed', 'index-pending'].includes(r.state) ? <button data-retry-run" },
      });
      ev.verdict = ev.expectations.every(item => item.pass) ? 'PASS' : 'FAIL';
      evidence.cases['ENG-011'] = ev;
      console.log(`[r10] ENG-011 ${ev.verdict}`);
    }

    evidence.finishedAt = new Date().toISOString();
    evidence.verdicts = Object.fromEntries(Object.entries(evidence.cases).map(([id, row]) => [id, row.verdict]));
    fs.writeFileSync(path.join(ARTIFACTS, 'eng007-log001.json'), JSON.stringify(evidence, null, 2));
    process.exitCode = Object.values(evidence.verdicts).every(v => v === 'PASS') ? 0 : 1;
  } catch (error) {
    evidence.firstFailure = String(error && error.stack || error);
    evidence.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(ARTIFACTS, 'eng007-log001.json'), JSON.stringify(evidence, null, 2));
    console.error(`[r10] FATAL ${evidence.firstFailure}`);
    process.exitCode = 1;
  } finally {
    if (harness) { try { await harness.cleanup(); } catch { /* best effort */ } }
  }
}

main().catch(error => { console.error(String(error && error.stack || error)); process.exit(1); });
