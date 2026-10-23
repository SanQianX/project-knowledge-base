'use strict';

// P-ENGINE-REVIEW-R3 ENG-011 UI PRODUCT PROBE (explicit probe, not a canonical
// *-test.js entry).
//
// Why this is a probe and not a canonical test entry: it measures the UI bytes
// that are actually SHIPPED (the pinned/vendored copy in _modules). The
// knowledge-engine fix for this defect lives in the module SOURCE repo and is
// NOT vendored yet (no re-vendor, no publish, no pin change is authorized), so
// the shipped bytes still carry the defect and a default-red canonical entry
// would misrepresent the pinned package. This probe therefore keeps both
// truths visible:
//   * default run  -> vendored bytes  -> RED, with the defect signature
//   * KB_ENG011_UI_DIR=<module source ui> -> candidate bytes -> GREEN
// The canonical runner (_site/_test/run-all-tests.js) collects only *-test.js,
// so this probe is never part of the default suite.
//
// Case (qa-autopilot/config/test-cases.json ENG-011, P1):
//   steps:    UI点击指定run重试，连续双击与网络响应丢失分别测试。
//   expected: 1) 同一意图不会重复派发。
//             2) 活动状态正确。
//             3) 请求结果未知先查询。
//
// Every acceptance observation comes from the PRODUCT'S OWN behaviour: CDP
// Network events emitted by the product page after native
// Input.dispatchMouseEvent clicks, and the product's own DOM (badge, toast,
// button state). The driver NEVER issues the "correct GET" on the client's
// behalf; driver-side API calls only prepare the failed-run precondition and
// read the engine's internal state for cross-checking.
//
// Topology (mirrors the product shell wiring): real vendored engine on an
// ephemeral port <- lane-exclusive ui-host reverse proxy (same-origin /api/*,
// browser Origin terminated) <- real product UI bytes served from UI_DIR.
//
// Engine-side isolation: the engine refuses to start a NEW run for a project
// whose previous run is still failed (coordinator.pump: "等待前一条失败提交
// 恢复"). Every scenario therefore gets its OWN project (own knowledge path,
// own commit) inside the same engine, so one failed run never blocks another
// scenario's precondition.
//
// Fault injection lives in the ui-host proxy only:
//   * dropRetry         - the retry really executes upstream, the response is
//                         killed mid-flight (truncated body -> BAD_JSON).
//   * retryDelayMs      - the retry response is held (real latency).
//   * holdRetryForward  - the retry POST is parked unforwarded, so the engine
//                         still reports the run as failed and every detail
//                         re-render rebuilds a retry button for the SAME
//                         in-flight intent (the re-render counter-proof).
//   * rejectRetryStatus - the retry is refused with an explicit error status.
//
// Scenarios, in order (so a RED baseline captures the earliest defect first):
//   1) detail 重绘/切回 — slow response (>2s in flight), real detail rebuild +
//      switch to another run and back, then a second native click: the
//      product must still dispatch exactly ONE retry.
//   2) 网络响应丢失   - the response is lost: the client must query first.
//   3) 连续双击       - two native clicks in flight: exactly ONE dispatch.
//   4) 显式 409 拒绝  - an explicit refusal must release the lock so the user
//      can retry again (no permanent lockout).
//
// Browser dependency: requires helpers/cdp-browser (Chrome or Edge).
// Isolation: own lane temp root (PK_TEST_TEMP_ROOT or the OS temp dir),
// ephemeral 127.0.0.1 ports, consume:false engine with a dead bridge URL,
// real vector-hub with deterministic test embeddings (paid embedding API NOT
// exercised), analyzer = deterministic stand-in (NO real model output).
// No quota access, no PAYG, no publish/vendor.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  REPO_ROOT, makeLaneDir, buildFixtureRepo, startVector, startEngine, waitUntil, callJson,
  readJsonl, saveEvidence, RUNTIME_IDENTITY,
} = require('./helpers/parallel-engine-final-harness.js');
const { createStandinAnalyzer } = require('./helpers/parallel-engine-final-standin-analyzer.js');
const { startUiHost } = require('./helpers/parallel-engine-advanced-ui-host.js');
const { launchCdpBrowser } = require('./helpers/cdp-browser.js');
const { findChrome } = require('./helpers/find-chrome.js');
const { attachNetworkCapture } = require('./helpers/cdp-network-capture.js');

const ARTIFACTS = process.env.KB_ENG011_EVIDENCE_DIR
  || path.resolve(__dirname, '../../qa-autopilot/artifacts/parallel-20261023/engine-review-r3/evidence/eng011ui');
const UI_DIR = process.env.KB_ENG011_UI_DIR
  || path.join(REPO_ROOT, '_modules', 'knowledge-engine', 'ui');

function isRetryPost(entry) {
  return entry.method === 'POST' && /\/api\/runs\/[^/]+\/retry$/.test(new URL(entry.url).pathname);
}
function isApi(entry) {
  return new URL(entry.url).pathname.startsWith('/api/');
}

async function nativeClick(browser, selector) {
  const rect = await browser.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
  if (!rect || typeof rect.x !== 'number') throw new Error(`element not clickable: ${selector}`);
  await browser.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
  await browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
}

function domTools(browser) {
  return {
    badge: () => browser.evaluate(`(() => { const el = document.querySelector('#runDetail #runMeta .badge'); return el ? el.textContent.trim() : null; })()`),
    toastShown: () => browser.evaluate(`(() => { const el = document.querySelector('#toast'); return el ? { text: el.textContent, shown: el.classList.contains('show') } : null; })()`),
    retryDisabled: () => browser.evaluate(`(() => { const b = document.querySelector('#retryRun'); return b ? b.disabled : null; })()`),
    detailRunId: () => browser.evaluate(`(() => { const el = document.querySelector('#runDetailId'); return el ? el.textContent.trim() : null; })()`),
  };
}

async function openRunsView(browser, base) {
  await browser.send('Page.navigate', { url: `${base}/` });
  await waitUntil(() => browser.evaluate("document.readyState === 'complete'"), 15000, 'page load');
  await nativeClick(browser, '.nav-item[data-view="runs"]');
  await waitUntil(() => browser.evaluate('document.querySelectorAll(\'#runsBody tr[data-run]\').length > 0'), 15000, 'runs table rows');
}

// Select a run in the runs table and wait until the DETAIL really shows it
// (a real re-render of the detail panel, which is where the retry button
// lives).
async function selectRun(browser, runId) {
  await nativeClick(browser, `#runsBody tr[data-run="${runId}"]`);
  await waitUntil(async () => (await browser.evaluate(`(() => { const el = document.querySelector('#runDetailId'); return el ? el.textContent.trim() : null; })()`)) === runId, 15000, `detail shows run ${runId}`);
}

async function main() {
  const lane = makeLaneDir('eng011ui-probe');
  const fixture = buildFixtureRepo(lane, 'eng011ui-probe', ['A', 'B', 'C', 'D', 'E']);
  const chrome = findChrome();
  const evidence = {
    caseId: 'ENG-011 UI product probe (real browser native clicks)',
    probe: 'explicit product probe - NOT a canonical *-test.js entry (the vendored/pinned UI bytes still carry the defect until the module fix is vendored, which is NOT authorized here)',
    targetIdentity: {
      shipped: 'knowledge-engine 0.2.7-rc.10 vendored at _modules/knowledge-engine (pinned, unchanged by this lane)',
      candidate: 'knowledge-engine source ui/ (module repo main, uncommitted fix) - reachable only through KB_ENG011_UI_DIR',
    },
    runtimeIdentity: RUNTIME_IDENTITY,
    laneDir: lane,
    uiDir: path.resolve(UI_DIR),
    chrome: path.resolve(chrome),
    fixture: { repoPath: fixture.repoPath, baseline: fixture.baseline, shas: fixture.shas },
    scenarios: {},
    engineStandin: 'deterministic stand-in analyzer (no real model output); vector-hub real with deterministic test embeddings',
    runs: [],
  };
  const persist = label => { evidence.runs.push(label); saveEvidence(ARTIFACTS, 'eng011-ui-probe-evidence.json', evidence); };

  const projectIds = {
    rerender: 'project-eng011ui-rerender',
    other: 'project-eng011ui-other',
    lost: 'project-eng011ui-lost',
    double: 'project-eng011ui-double',
    refusal: 'project-eng011ui-refusal',
  };
  const knowledgePath = path.join(lane, 'knowledge-ui');
  fs.mkdirSync(knowledgePath, { recursive: true });
  const dataDir = path.join(lane, 'engine-data');
  const vectorRoot = path.join(lane, 'vector-root');
  const eventsFile = path.join(lane, 'analyzer-events.jsonl');

  const vector = await startVector(vectorRoot);
  const analyzer = createStandinAnalyzer({ eventsFile });
  const engine = await startEngine({ dataDir, bridgeUrl: 'http://127.0.0.1:9', vectorUrl: vector.url, analyzer });
  let browser = null;
  let host = null;
  try {
    const base = await engine.listen();
    for (const [key, projectId] of Object.entries(projectIds)) {
      engine.runtime.store.addProject({
        projectId, name: `eng011ui-${key}`, repoPath: fixture.repoPath,
        knowledgePath: path.join(knowledgePath, key), trackingStartCommit: fixture.baseline,
      });
    }

    host = startUiHost({ uiDir: UI_DIR, engineBase: base });
    const hostBase = await host.listen();
    evidence.uiHashes = host.uiHashes;
    evidence.engineBase = base;
    evidence.hostBase = hostBase;

    const runsOf = async projectId => (await callJson(base, `/api/runs?projectId=${projectId}`)).body.runs;
    const waitState = (projectId, runId, state, ms, what) => waitUntil(async () => {
      const run = (await runsOf(projectId)).find(r => r.runId === runId);
      return run?.state === state ? run : null;
    }, ms, what);
    const invocationsFor = sha => readJsonl(eventsFile).filter(e => e.kind === 'start' && e.commitSha === sha).length;
    // Precondition: a real run that fails with the engine's debug simulated
    // fault (retryable) - the UI then renders its "重试失败阶段" button.
    const createFailedRun = async (projectId, sha) => {
      const created = await callJson(base, '/api/runs', { projectId, commitSha: sha, simulateFailure: true });
      assert.equal(created.status, 200, `precondition run creation failed: ${JSON.stringify(created.body)}`);
      const run = created.body.run;
      const failed = await waitState(projectId, run.runId, 'failed', 30000, `precondition: first attempt fails (${projectId}, debug simulated fault, retryable)`);
      assert.equal(failed.error.code, 'DEBUG_SIMULATED_FAILURE');
      assert.equal(failed.error.retryable, true, 'precondition: failed run must expose a retryable error for the UI button');
      return { run, failed };
    };

    const target = await createFailedRun(projectIds.rerender, fixture.shas.A);
    const other = await createFailedRun(projectIds.other, fixture.shas.B);
    const lost = await createFailedRun(projectIds.lost, fixture.shas.C);
    const twice = await createFailedRun(projectIds.double, fixture.shas.D);
    const refused = await createFailedRun(projectIds.refusal, fixture.shas.E);
    evidence.preconditions = {
      rerender: { projectId: projectIds.rerender, runId: target.run.runId, state: target.failed.state, error: target.failed.error },
      other: { projectId: projectIds.other, runId: other.run.runId, state: other.failed.state, error: other.failed.error },
      lost: { projectId: projectIds.lost, runId: lost.run.runId, state: lost.failed.state, error: lost.failed.error },
      double: { projectId: projectIds.double, runId: twice.run.runId, state: twice.failed.state, error: twice.failed.error },
      refusal: { projectId: projectIds.refusal, runId: refused.run.runId, state: refused.failed.state, error: refused.failed.error },
    };
    persist('preconditions ready');

    browser = await launchCdpBrowser({
      chrome,
      profileDir: path.join(lane, 'browser-profile'),
      url: `${hostBase}/`,
    });
    const capture = attachNetworkCapture(browser);
    await capture.enable();
    const networkFailures = [];
    browser.socket.on('message', raw => {
      try {
        const message = JSON.parse(String(raw));
        if (message.method === 'Network.loadingFailed') {
          networkFailures.push({ requestId: message.params.requestId, errorText: message.params.errorText, canceled: message.params.canceled });
        }
      } catch {}
    });
    const dom = domTools(browser);

    // ---------- Scenario 1: detail 重绘/切回后同一在途意图仍只派发一次 ----------
    await openRunsView(browser, hostBase);
    await selectRun(browser, target.run.runId);
    host.configure({ retryDelayMs: 2000, dropRetry: false, rejectRetryStatus: 0, holdRetryForward: true });
    const markRerender = capture.requests.length;
    const receivedBefore = host.state.receivedRetryPosts;
    const clickedAt = Date.now();
    await nativeClick(browser, '#retryRun');
    await waitUntil(() => host.state.receivedRetryPosts > receivedBefore, 15000, 'the retry intent reached the ui-host');
    assert.equal(host.state.forwardedRetryPosts, 0, 'the parked intent has not reached the engine yet');
    await new Promise(resolve => setTimeout(resolve, 2200)); // the intent stays in flight well past the 2s response delay

    await selectRun(browser, other.run.runId); // switch to another failed run
    const otherRunDisabled = await dom.retryDisabled();
    await selectRun(browser, target.run.runId); // switch back: the detail (and the button) is rebuilt
    const rebuiltDisabled = await dom.retryDisabled();
    const receivedBeforeSecondClick = host.state.receivedRetryPosts;
    await nativeClick(browser, '#retryRun'); // second native click on the REBUILT button
    await new Promise(resolve => setTimeout(resolve, 500));
    const receivedAfterSecondClick = host.state.receivedRetryPosts;
    const inFlightWindowMs = Date.now() - clickedAt;
    const releasedAt = Date.now();
    const productRetryPostsRerender = capture.requests.slice(markRerender).filter(isRetryPost);
    evidence.scenarios.detailRerender = {
      faultInjection: 'ui-host parked the retry POST (holdRetryForward) and answers the released retry with a 2s delayed response; the engine keeps reporting the run as failed so every detail re-render rebuilds a retry button for the SAME in-flight intent',
      nativeClicks: 2,
      inFlightWindowMs,
      rebuiltButtonDisabledDuringFlight: rebuiltDisabled,
      otherRunButtonDisabled: otherRunDisabled,
      hostReceivedRetryPosts: { before: receivedBeforeSecondClick, after: receivedAfterSecondClick },
      hostForwardedRetryPosts: host.state.forwardedRetryPosts,
      productRetryPostCount: productRetryPostsRerender.length,
      productRetryPosts: productRetryPostsRerender.map(r => ({ url: r.url, status: r.status })),
    };
    persist('scenario detailRerender observed');
    assert.equal(receivedAfterSecondClick, receivedBeforeSecondClick, 'ENG-011 UI defect: the rebuilt button re-dispatched the same in-flight retry intent (the guard must be stable per runId, not per DOM element)');
    assert.equal(productRetryPostsRerender.length, 1, 'ENG-011 UI defect: the product dispatched the same retry intent twice across the detail re-render');
    assert.equal(rebuiltDisabled, true, 'ENG-011 UI defect: the rebuilt retry button does not reflect the in-flight state');
    assert.equal(otherRunDisabled, false, 'ENG-011 UI defect: an unrelated run is blocked by the in-flight guard');
    assert.ok(inFlightWindowMs >= 2000, `the in-flight window must exceed the 2s response delay (got ${inFlightWindowMs}ms)`);

    host.configure({ holdRetryForward: false });
    const released = host.releaseHeldRetries();
    const healed = await waitState(projectIds.rerender, target.run.runId, 'succeeded', 60000, 'the released retry really executed');
    await waitUntil(async () => (await dom.badge()) === '可检索', 30000, 'the badge converges after the delayed response');
    const invocationsA = invocationsFor(fixture.shas.A);
    const runsForA = (await runsOf(projectIds.rerender)).filter(r => r.commitSha === fixture.shas.A);
    evidence.scenarios.detailRerender.releasedHeldRetries = released;
    evidence.scenarios.detailRerender.totalInFlightMs = Date.now() - clickedAt;
    evidence.scenarios.detailRerender.responseDeliveredAfterReleaseMs = Date.now() - releasedAt;
    evidence.scenarios.detailRerender.engineTruth = {
      state: healed.state, phase: healed.phase, indexState: healed.indexState,
      analyzerInvocationsForCommit: invocationsA, runRecordsForCommit: runsForA.length,
    };
    assert.equal(host.state.forwardedRetryPosts, 1, 'exactly one retry reached the engine');
    assert.equal(invocationsA, 1, `the retry dispatched exactly one analysis (got ${invocationsA})`);
    assert.equal(runsForA.length, 1, 'no duplicate run record');
    persist('scenario detailRerender PASS');

    // ---------- Scenario 2: 网络响应丢失 (retry really executes, browser never sees the answer) ----------
    await selectRun(browser, lost.run.runId);
    const mark1 = capture.requests.length;
    const forwardsBeforeClick = host.state.forwardedRetryPosts;
    host.configure({ retryDelayMs: 0, dropRetry: true, rejectRetryStatus: 0, holdRetryForward: false });
    await nativeClick(browser, '#retryRun');
    await waitUntil(() => host.state.droppedRetryResponses >= 1, 15000, 'ui-host dropped the retry response after the engine executed it');
    await new Promise(resolve => setTimeout(resolve, 1200)); // early sample: the toast auto-hides after 2.6s
    const toastEarly = await dom.toastShown();
    await new Promise(resolve => setTimeout(resolve, 1800)); // rest of the observation window (3s total)
    const toastLate = await dom.toastShown();
    const badgeStale = await dom.badge();

    const pageAfterDrop = capture.requests.slice(mark1);
    const droppedPost = pageAfterDrop.filter(isRetryPost)[0] || null;
    const droppedPostFailure = droppedPost ? networkFailures.find(f => f.requestId === droppedPost.id) : null;
    const apiAfterPost = pageAfterDrop.filter(entry => isApi(entry) && entry !== droppedPost);
    const specificQuery = apiAfterPost.find(entry => entry.method === 'GET' && new URL(entry.url).pathname === `/api/runs/${lost.run.runId}`);
    const healedLost = await waitState(projectIds.lost, lost.run.runId, 'succeeded', 60000, 'the retry behind the dropped response really executed');
    const invocationsC = invocationsFor(fixture.shas.C);
    const runsForC = (await runsOf(projectIds.lost)).filter(r => r.commitSha === fixture.shas.C);
    const ledgerC = path.join(dataDir, 'runtime', 'processed-commits', projectIds.lost, `${fixture.shas.C}.json`);
    evidence.scenarios.lostResponse = {
      faultInjection: 'ui-host forwarded the retry POST (engine executed it), started the response, then killed the socket mid-flight',
      droppedPostObservedByPage: droppedPost ? { url: droppedPost.url, status: droppedPost.status, loadingFailed: droppedPostFailure ? { errorText: droppedPostFailure.errorText, canceled: droppedPostFailure.canceled === true } : null } : null,
      hostForwardedRetryPostsDuringScenario: host.state.forwardedRetryPosts - forwardsBeforeClick,
      hostDroppedRetryResponses: host.state.droppedRetryResponses,
      productApiRequestsAfterDrop: apiAfterPost.map(r => ({ method: r.method, url: r.url, status: r.status })),
      productSpecificRunQueryFired: !!specificQuery,
      productFirstApiRequestAfterDrop: apiAfterPost[0] ? { method: apiAfterPost[0].method, url: apiAfterPost[0].url } : null,
      toastEarly,
      toastLate,
      domBadgeWhileEngineHadSucceeded: badgeStale,
      engineTruth: {
        stateBehindLostResponse: healedLost.state,
        analyzerInvocationsForCommit: invocationsC,
        runRecordsForCommit: runsForC.length,
        ledgerStatus: fs.existsSync(ledgerC) ? JSON.parse(fs.readFileSync(ledgerC, 'utf8')).status : null,
      },
      browserConsoleErrors: browser.consoleErrors.map(entry => entry.text).slice(-10),
    };
    persist('scenario lostResponse observed');
    assert.ok(droppedPost, 'the page dispatched the retry POST (captured from the browser network layer)');
    assert.ok(droppedPostFailure && droppedPostFailure.canceled !== true, `the retry fetch failed in the browser (unknown result), loadingFailed=${droppedPostFailure ? droppedPostFailure.errorText : 'missing'}`);
    assert.equal(host.state.forwardedRetryPosts - forwardsBeforeClick, 1, 'exactly one retry POST reached the engine in this scenario (no transport-level re-dispatch)');
    assert.ok(specificQuery, 'ENG-011 UI defect: after the lost response the product client never queried the run state (请求结果未知先查询 violated)');
    assert.ok(apiAfterPost.length >= 1 && apiAfterPost[0] === specificQuery, 'ENG-011 UI defect: the first product API call after the unknown result was not the specific run query');
    assert.equal(pageAfterDrop.filter(isRetryPost).length, 1, 'ENG-011 UI defect: the product client re-dispatched the retry after the unknown result');
    assert.ok(toastEarly && toastEarly.shown === true && toastEarly.text, 'ENG-011 UI defect: the product client left the unknown result invisible to the user (no toast)');
    assert.notEqual(badgeStale, '失败', 'ENG-011 UI defect: the UI kept showing 失败 while the engine had already executed the retry');
    await waitUntil(async () => (await dom.badge()) === '可检索', 20000, 'UI badge converges to 可检索 after the query');
    assert.equal(invocationsC, 1, `the retry behind the lost response dispatched exactly one analysis (got ${invocationsC})`);
    assert.equal(runsForC.length, 1, 'no duplicate run record after the unknown-result retry');
    assert.ok(fs.existsSync(ledgerC), 'completed SHA recorded in the processing ledger');
    persist('scenario lostResponse PASS');

    // ---------- Scenario 3: 连续双击 (two native clicks while the retry response is in flight) ----------
    await selectRun(browser, twice.run.runId);
    const mark2 = capture.requests.length;
    host.configure({ retryDelayMs: 800, dropRetry: false });
    await nativeClick(browser, '#retryRun');
    await new Promise(resolve => setTimeout(resolve, 60));
    const disabledDuringFlight = await dom.retryDisabled();
    await nativeClick(browser, '#retryRun');
    await new Promise(resolve => setTimeout(resolve, 2200)); // delayed responses (800ms) settle + refresh

    const pageAfterClick1 = capture.requests.slice(mark2);
    const retryPostsDoubleClick = pageAfterClick1.filter(isRetryPost);
    const healedTwice = await waitState(projectIds.double, twice.run.runId, 'succeeded', 60000, 'retried run reaches 可检索');
    const invocationsD = invocationsFor(fixture.shas.D);
    const runsForD = (await runsOf(projectIds.double)).filter(r => r.commitSha === fixture.shas.D);
    const badgeD = await dom.badge();
    evidence.scenarios.doubleClick = {
      faultInjection: 'ui-host holds retry responses 800ms so the second native click lands in-flight',
      nativeClicks: 2,
      productRetryPostCount: retryPostsDoubleClick.length,
      productRetryPosts: retryPostsDoubleClick.map(r => ({ url: r.url, status: r.status })),
      buttonDisabledDuringFlight: disabledDuringFlight,
      engineContainment: {
        analyzerInvocationsForCommit: invocationsD,
        runRecordsForCommit: runsForD.length,
        finalState: healedTwice.state,
        finalPhase: healedTwice.phase,
        indexState: healedTwice.indexState,
      },
      finalDomBadge: badgeD,
    };
    persist('scenario doubleClick observed');
    assert.equal(retryPostsDoubleClick.length, 1, `ENG-011 UI defect: the product page dispatched the same retry intent ${retryPostsDoubleClick.length} times under a double click (expected exactly 1)`);
    assert.equal(disabledDuringFlight, true, 'ENG-011 UI defect: the retry button stayed enabled while the intent was in flight');
    assert.equal(invocationsD, 1, `the accepted retry dispatched exactly one analysis (got ${invocationsD})`);
    assert.equal(runsForD.length, 1, 'no duplicate run record for the same commit');
    assert.equal(healedTwice.state, 'succeeded');
    assert.equal(healedTwice.phase, 'ready');
    assert.equal(healedTwice.indexState, 'succeeded');
    assert.equal(badgeD, '可检索', 'UI run detail badge must reach 可检索 after the retry');
    persist('scenario doubleClick PASS');

    // ---------- Scenario 4: 显式 409 拒绝后可恢复重试 ----------
    await selectRun(browser, refused.run.runId);
    host.configure({ retryDelayMs: 0, dropRetry: false, rejectRetryStatus: 409 });
    const forwardsBeforeRefusal = host.state.forwardedRetryPosts;
    const mark4 = capture.requests.length;
    await nativeClick(browser, '#retryRun');
    await waitUntil(() => host.state.rejectedRetryResponses >= 1, 15000, 'the explicit refusal reached the product');
    const refusalToastSamples = [];
    for (let index = 0; index < 8; index += 1) {
      refusalToastSamples.push(await dom.toastShown());
      await new Promise(resolve => setTimeout(resolve, 120));
    }
    const refusalToast = refusalToastSamples.find(sample => sample && sample.shown === true) || refusalToastSamples[0];
    const forwardedAfterRefusal = host.state.forwardedRetryPosts;
    await selectRun(browser, refused.run.runId); // the detail is rebuilt after the refusal
    const disabledAfterRefusal = await dom.retryDisabled();
    host.configure({ rejectRetryStatus: 0 });
    await nativeClick(browser, '#retryRun');
    await waitUntil(() => host.state.forwardedRetryPosts > forwardedAfterRefusal, 15000, 'the second intent reached the engine');
    const healedRefused = await waitState(projectIds.refusal, refused.run.runId, 'succeeded', 60000, 'the retried run converges');
    await waitUntil(async () => (await dom.badge()) === '可检索', 30000, 'the badge converges after the recovered retry');
    const invocationsE = invocationsFor(fixture.shas.E);
    const runsForE = (await runsOf(projectIds.refusal)).filter(r => r.commitSha === fixture.shas.E);
    evidence.scenarios.explicitRefusalRecovery = {
      faultInjection: 'ui-host refuses the retry POST with an explicit 409 (the intent never reaches the engine)',
      toastAfterRefusal: refusalToast,
      toastSamplesAfterRefusal: refusalToastSamples,
      productRequestsAfterRefusal: capture.requests.slice(mark4).map(r => ({ method: r.method, url: r.url, status: r.status })),
      browserConsoleErrors: browser.consoleErrors.map(entry => entry.text).slice(-10),
      hostForwardedRetryPostsBeforeRefusal: forwardsBeforeRefusal,
      hostForwardedRetryPostsAfterRefusal: forwardedAfterRefusal,
      rebuiltButtonDisabledAfterRefusal: disabledAfterRefusal,
      hostForwardedRetryPostsAfterRecovery: host.state.forwardedRetryPosts,
      engineTruth: {
        state: healedRefused.state, phase: healedRefused.phase, indexState: healedRefused.indexState,
        analyzerInvocationsForCommit: invocationsE, runRecordsForCommit: runsForE.length,
      },
      finalDomBadge: await dom.badge(),
    };
    persist('scenario explicitRefusalRecovery observed');
    assert.ok(refusalToast && refusalToast.shown === true && /refusal/.test(refusalToast.text), `ENG-011 UI defect: the explicit refusal was not surfaced to the user (toast: ${JSON.stringify(refusalToast)})`);
    assert.equal(forwardedAfterRefusal, forwardsBeforeRefusal, 'the refused intent must not reach the engine');
    assert.equal(disabledAfterRefusal, false, 'ENG-011 UI defect: an explicit API refusal left the retry permanently locked');
    assert.equal(invocationsE, 1, `the recovered retry dispatched exactly one analysis (got ${invocationsE})`);
    assert.equal(runsForE.length, 1, 'no duplicate run record');
    persist('scenario explicitRefusalRecovery PASS');

    evidence.verdict = {
      'expected1 同一意图不会重复派发': 'PASS (product client: exactly 1 retry POST under a native double click AND across a real detail re-render/switch-back; the guard is stable per runId, not per DOM element; button disabled in flight; engine: 1 analysis, 1 run record)',
      'expected2 活动状态正确': 'PASS (engine state machine preparing/analyzing/promoting/ready -> succeeded; UI badge converges to 可检索 in every scenario, including after the unknown result)',
      'expected3 请求结果未知先查询': 'PASS (after the dropped response the product client queried GET /api/runs/<runId> FIRST and never re-dispatched; user informed via toast)',
      'explicit refusal recovery': 'PASS (a 409 releases the lock: the rebuilt button is enabled and the next click dispatches again)',
      boundary: 'engine-level guards (per-project single writer, 409 on non-retryable, completed-SHA ledger) are covered by parallel-engine-final-eng011-test.js; this probe covers the product UI client behaviour with a real browser',
      targetIdentity: 'these observations describe the UI bytes served from ' + path.resolve(UI_DIR) + '; the pinned/vendored bytes are unchanged by this lane',
    };
    await browser.close(); browser = null;
    await host.close(); host = null;
    await engine.close();
    await vector.close();
    saveEvidence(ARTIFACTS, 'eng011-ui-probe-evidence.json', evidence);
    console.log('ENG-011 UI PROBE PASS');
    process.exit(0);
  } catch (error) {
    evidence.verdict = { failed: String((error && error.stack) || error) };
    try { if (browser) await browser.close(); } catch {}
    try { if (host) await host.close(); } catch {}
    try { await engine.close(); } catch {}
    try { await vector.close(); } catch {}
    saveEvidence(ARTIFACTS, 'eng011-ui-probe-evidence.json', evidence);
    console.error(`ENG-011 UI PROBE FAIL: ${error.message}`);
    process.exit(1);
  }
}

main();
