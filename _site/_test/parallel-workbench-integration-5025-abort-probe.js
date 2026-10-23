'use strict';
// P-WB-QA-INTEGRATION-5025 canonical copy of the accepted WB-008 entry
// (_site/_test/parallel-workbench-runtime-wb008-abort.js, frozen untracked).
// P-WB-CANONICAL-R2 wiring: the entry goes through the canonical launcher boot
// (paid gate + explicit real-profile authorization → read-only discovery with
// the real environment → FULL driver isolation incl. APPDATA/LOCALAPPDATA/
// CODEX_HOME → carried-through captures), and the real-profile digest helpers
// come from the launcher's authorized layer instead of the pre-R5 tracked
// fixture whose whitelist lacked those keys. Case logic and expecteds are
// unchanged. Real paid model probe (two turns, real network to the provider) —
// run only explicitly via the integration-5025 runner with
// PK_WB_ALLOW_PAID_TURNS=1 and an explicit PK_WB_REAL_PROFILE_DIR.
// WB-008 — 中止隔离（真实浏览器 / 真实 0.13.6 隔离宿主 / 真实 MiniMax）。
//
// 本入口用真实 Chrome 打开模块自带的 agent-terminal UI（安装包内
// apps/agent-terminal），在隔离宿主上跑两个同时进行的真实会话 A / B：
//
//   * A 与 B 都是真实模型请求，两个会话同时在跑；
//   * 只通过产品自己的 UI 停止 B：切到 B，点发送按钮（忙碌时该按钮就是
//     产品自己的“停止”控件），不做任何绕过 UI 的中止调用；
//   * 判定只看产品自身的事实：B 的流以 claude/aborted 结束且没有
//     claaude/result、B 的 CLI 进程真的退出、A 的 CLI 进程还在、A 的流
//     在中止之后继续并且最后以 claude/result 正常完成。
//
// 进程普查只读，且只取本用例自己的宿主子进程子树；5757/5760 与任何
// 未知进程都不触碰。
//
// 退出码：0 = 全部证明；3 = 诚实 BLOCKED；1 = 脚本错误。
const path = require('node:path');
const crypto = require('node:crypto');
const launcher = require('./helpers/parallel-workbench-integration-5025-launcher');
const fixture = require('./helpers/parallel-workbench-integration-5025-fixture');
const harness = require('./helpers/parallel-workbench-integration-5025-runtime-harness');

const PROFILE_ID = String(process.env.PK_WB_MODEL_PROFILE || 'minimax');
const REQUESTED_MODEL = String(process.env.PK_WB_MODEL_ID || 'MiniMax-M3.1-Flash');
const TURN_TIMEOUT_MS = Number(process.env.PK_WB_TURN_TIMEOUT_MS || 420000);

const results = [];
function record(caseId, status, detail) {
  results.push({ caseId, status, detail });
  console.log(`CASE ${caseId} ${status} ${JSON.stringify(detail)}`);
}
function assertTrue(condition, message) {
  if (!condition) throw new Error(message);
}

// The runtime processes of THIS host child only.
function runtimeProcesses(hostPid) {
  return harness.runtimeProcesses(hostPid);
}

async function waitForRuntimeProcesses(hostPid, minimum, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = [];
  while (Date.now() < deadline) {
    last = runtimeProcesses(hostPid);
    if (last.length >= minimum) return last;
    await harness.wait(250);
  }
  return last;
}

(async () => {
  // The single safe entry discipline: gates, real-env discovery, full driver
  // isolation, carried-through captures — before anything else happens.
  const boot = launcher.boot({ prefix: 'parallel-wb008', paid: true, needsRealProfile: true });
  const realProfilesBefore = launcher.digestDirectory(boot.discovery.realProfileDir);
  const host = await harness.startHost({
    prefix: 'parallel-wb008',
    moduleRoot: boot.discovery.moduleRoot,
    realProfileDir: boot.discovery.realProfileDir,
  });
  const identity = harness.moduleIdentity(host.moduleRoot);
  const hostPid = host.child.child.pid;
  let browser = null;
  let outcome = null;

  const tokenA = `WBRT-ABORT-A-${crypto.randomBytes(5).toString('hex')}`;
  const tokenB = `WBRT-ABORT-B-${crypto.randomBytes(5).toString('hex')}`;
  // A long answer keeps session A running while B is aborted.
  const questionA = `这是 WB-008 中止隔离的真实抽测（第 1 问，会话 A）。请输出 400 行，每行形如 "行 0001 编号 xxxxx"，最后一行原样包含标记 ${tokenA}。`;
  const questionB = `这是 WB-008 中止隔离的真实抽测（第 2 问，会话 B）。请输出 200 行，每行形如 "行 0001 编号 xxxxx"，最后一行原样包含标记 ${tokenB}。`;

  const eventsA = [];
  const eventsB = [];
  let abortAt = null;

  try {
    const opened = await harness.openBrowser(host.base, host.layout, { chrome: boot.discovery.chrome });
    browser = opened.browser;

    const health = await harness.getJson(`${host.base}${harness.API_BASE}/health`);
    const project = await harness.ensureProject(browser, path.join(host.layout.root, 'wb008-project'), { name: 'wb008-project' });
    record('WB-008.a-real-browser-and-host', health.ok && health.body && health.body.status === 'ok' ? 'PASS' : 'BLOCKED', {
      browser: 'real Chrome via CDP (headless), isolated user-data-dir below the isolated layout',
      chrome: opened.chrome,
      module: identity,
      host: { mode: 'standalone', dataDir: host.layout.dataDir, workspace: host.layout.workspace, port: host.port, hostPid },
      project: { id: project.projectId, name: project.name, createdThroughTheProductForm: project.created === true },
      health: health.body,
    });
    assertTrue(health.ok && health.body && health.body.status === 'ok', 'the isolated host is not healthy');

    const profiles = await harness.getJson(`${host.base}${harness.API_BASE}/profiles`);
    const listed = Array.isArray(profiles.body && profiles.body.profiles) ? profiles.body.profiles : [];
    const profile = listed.find(item => item.id === PROFILE_ID) || null;
    assertTrue(profile, `the ${PROFILE_ID} profile is not visible through the read-only facade`);
    await harness.selectModel(browser, profile.name, REQUESTED_MODEL);
    const afterModel = await harness.readState(browser);
    record('WB-008.b-model-selected-through-the-real-ui', afterModel.product.currentProfileId === PROFILE_ID && afterModel.product.currentModel === REQUESTED_MODEL ? 'PASS' : 'BLOCKED', {
      profileId: PROFILE_ID,
      profileName: profile.name,
      requestedModel: REQUESTED_MODEL,
      uiProfileId: afterModel.product.currentProfileId,
      uiModel: afterModel.product.currentModel,
      credentialConfigured: profile.credentialConfigured === true,
      credentialWrittenAnywhere: false,
    });
    assertTrue(afterModel.product.currentProfileId === PROFILE_ID, 'the profile was not selected through the UI');

    // --- session A ------------------------------------------------------
    await harness.clickNewSession(browser);
    const firstSession = await harness.waitForState(browser, state => state.product && state.product.activeSessionId, 'session A', 30000);
    const sessionA = firstSession.product.activeSessionId;
    const streamA = harness.consumeSessionEvents(
      harness.sessionEventsUrl(host.base, sessionA),
      event => eventsA.push(event),
      event => event.type === 'claude/result' || event.type === 'claude/error',
      TURN_TIMEOUT_MS,
    );
    await harness.typeText(browser, questionA);
    await harness.clickSend(browser);
    const aBusy = await harness.waitForState(browser, state => state.busy === true, 'session A to start', 90000);
    const procsA = await waitForRuntimeProcesses(hostPid, 1, 90000);
    record('WB-008.c-session-a-is-running', aBusy.busy === true && procsA.length >= 1 ? 'PASS' : 'BLOCKED', {
      sessionId: sessionA,
      uiSendTitleWhileBusy: aBusy.sendTitle,
      uiSessionState: aBusy.product.sessionState,
      runtimeProcessesOfThisHost: procsA,
      tokenA,
    });
    assertTrue(procsA.length >= 1, 'session A has no runtime process');

    // --- session B, started while A is still running --------------------
    await harness.clickNewSession(browser);
    const secondSession = await harness.waitForState(browser, state => state.product && state.product.activeSessionId && state.product.activeSessionId !== sessionA, 'session B', 30000);
    const sessionB = secondSession.product.activeSessionId;
    const streamB = harness.consumeSessionEvents(
      harness.sessionEventsUrl(host.base, sessionB),
      event => eventsB.push(event),
      event => event.type === 'claude/result' || event.type === 'claude/aborted' || event.type === 'claude/error',
      TURN_TIMEOUT_MS,
    );
    await harness.typeText(browser, questionB);
    await harness.clickSend(browser);
    const bBusy = await harness.waitForState(browser, state => state.busy === true, 'session B to start', 90000);
    const procsB = await waitForRuntimeProcesses(hostPid, procsA.length + 1, 90000);
    // The processes that were already running for A when B started are A's;
    // the ones that appeared with B are B's. A short-lived helper of A may
    // have exited on its own in between, so the mapping is the intersection
    // and the difference, not the raw first census.
    const aPids = procsA.filter(entry => procsB.some(other => other.pid === entry.pid)).map(entry => entry.pid);
    const bPids = procsB.filter(entry => !procsA.some(other => other.pid === entry.pid)).map(entry => entry.pid);
    const aStillRunning = aPids.length >= 1 && bPids.length >= 1;
    record('WB-008.d-two-sessions-run-at-the-same-time', bBusy.busy === true && aStillRunning ? 'PASS' : 'BLOCKED', {
      sessionA: { id: sessionA, runtimeProcesses: procsA.map(entry => ({ pid: entry.pid, name: entry.name, commandLine: entry.commandLine })) },
      sessionB: { id: sessionB, runtimeProcesses: procsB.map(entry => ({ pid: entry.pid, name: entry.name, commandLine: entry.commandLine })) },
      sessionAProcessPids: aPids,
      sessionBProcessPids: bPids,
      runtimeProcessesAddedForSessionB: bPids,
      sessionAProcessStillAlive: aStillRunning,
      uiSendTitleWhileBusy: bBusy.sendTitle,
    });
    assertTrue(aStillRunning, 'session A stopped running while session B started');

    // --- abort B through the product's own stop control -----------------
    await harness.openSessionRow(browser, project.projectId, sessionB);
    const bBusyInUi = await harness.waitForState(browser, state => state.busy === true && state.product.activeSessionId === sessionB, 'session B to be busy in the UI', 30000);
    const beforeAbort = runtimeProcesses(hostPid);
    abortAt = Date.now();
    await harness.clickSend(browser);
    const bIdle = await harness.waitForState(browser, state => state.busy === false && state.product.activeSessionId === sessionB, 'session B to become idle after the stop', 60000);
    await harness.wait(3000);
    const afterAbort = runtimeProcesses(hostPid);
    const afterPids = new Set(afterAbort.map(entry => entry.pid));
    const exitedPids = beforeAbort.map(entry => entry.pid).filter(pid => !afterPids.has(pid));
    const survivedA = aPids.filter(pid => afterPids.has(pid));
    const bStillAlive = bPids.filter(pid => afterPids.has(pid));
    const bAborted = eventsB.some(event => event.type === 'claude/aborted');
    const bResulted = eventsB.some(event => event.type === 'claude/result');
    const stopNoteInUi = bIdle.streamText.includes('已停止');
    const abortOk = bAborted && !bResulted && exitedPids.length >= 1
      && survivedA.length === aPids.length && survivedA.length >= 1
      && bStillAlive.length === 0
      && bIdle.busy === false;
    record('WB-008.e-only-b-was-aborted', abortOk ? 'PASS' : 'BLOCKED', {
      abortControl: 'the product\'s own send button, which the product itself turns into “停止” while the turn runs (btn-send.title === "停止")',
      sendTitleWhileBusy: bBusyInUi.sendTitle,
      sessionB: {
        sessionId: sessionB,
        abortedEvent: bAborted,
        resultEvent: bResulted,
        eventTypes: eventsB.map(event => event.type),
        uiSendTitleAfterAbort: bIdle.sendTitle,
        uiSessionStateAfterAbort: bIdle.product.sessionState,
        stopNoteRenderedInTheTranscript: stopNoteInUi,
      },
      processCensus: {
        scope: 'the descendants of this case\'s own host child only',
        beforeAbort: beforeAbort.map(entry => ({ pid: entry.pid, name: entry.name, commandLine: entry.commandLine })),
        afterAbort: afterAbort.map(entry => ({ pid: entry.pid, name: entry.name, commandLine: entry.commandLine })),
        exitedPids,
        sessionAPidsBeforeTheAbort: aPids,
        sessionAPidsStillAlive: survivedA,
        sessionBPidsBeforeTheAbort: bPids,
        sessionBPidsStillAlive: bStillAlive,
      },
    });
    assertTrue(abortOk, 'the abort did not isolate B');

    // --- A keeps running and finishes on its own ------------------------
    // The UI is put back onto A while A is still running, so the answer of A
    // is observed in the product's own live rendering. The completion gate is
    // the session's own result event, not the marker inside the answer.
    await harness.openSessionRow(browser, project.projectId, sessionA);
    await harness.waitUntil(() => eventsA.some(event => event.type === 'claude/result'), 'the result event of session A', TURN_TIMEOUT_MS, 500);
    const aAnswerInUi = await harness.waitForState(
      browser,
      state => state.product && state.product.activeSessionId === sessionA && state.busy === false
        && state.assistantMessages.some(text => text.includes(tokenA)),
      'the finished answer of session A in the UI',
      30000,
      200,
    );
    const aEventsAfterAbort = eventsA.filter(event => Date.parse(event.at) >= abortAt - 500);
    const aResult = eventsA.find(event => event.type === 'claude/result') || null;
    const aAnswer = aResult ? String(aResult.result || '') : '';
    const aFinishedAfterAbort = aResult ? Date.parse(aResult.at) >= abortAt : false;
    const aOk = aEventsAfterAbort.length > 0 && Boolean(aResult) && aFinishedAfterAbort
      && aAnswer.includes(tokenA);
    record('WB-008.f-session-a-kept-running-and-completed', aOk ? 'PASS' : 'BLOCKED', {
      sessionA: {
        sessionId: sessionA,
        eventCount: eventsA.length,
        eventsAfterTheAbortOfB: aEventsAfterAbort.length,
        eventTypesAfterTheAbortOfB: [...new Set(aEventsAfterAbort.map(event => event.type))],
        resultAt: aResult ? aResult.at : null,
        finishedAfterTheAbortOfB: aFinishedAfterAbort,
        tokenEchoedInTheAnswer: aAnswer.includes(tokenA),
        answerPreview: aAnswer.slice(0, 120),
        tokenEchoedInTheUi: aAnswerInUi.assistantMessages.some(text => text.includes(tokenA)),
        uiSendTitleAfterTheAnswer: aAnswerInUi.sendTitle,
        uiSessionStateAfterTheAnswer: aAnswerInUi.product.sessionState,
      },
      paidTurns: 2,
    });
    assertTrue(aOk, 'session A did not keep running after B was aborted');

    // --- the UI shows both facts ----------------------------------------
    // The reopened session renders its own history, so the transcript is
    // waited for instead of being read in the middle of the replay.
    await harness.openSessionRow(browser, project.projectId, sessionB);
    const bView = await harness.waitForState(browser, state => state.streamText.includes('已停止'), 'the stopped note of session B in the reopened transcript', 30000, 200);
    const bTranscriptStopped = bView.streamText.includes('已停止');
    const bHasNoAnswer = !bView.assistantMessages.some(text => text.includes(tokenB));
    await harness.openSessionRow(browser, project.projectId, sessionA);
    const aView = await harness.waitForState(browser, state => state.assistantMessages.some(text => text.includes(tokenA)), 'the answer of session A in the reopened transcript', 30000, 200);
    const aHasAnswer = aView.assistantMessages.some(text => text.includes(tokenA));
    const uiOk = bTranscriptStopped && bHasNoAnswer && aHasAnswer;
    record('WB-008.g-the-ui-shows-the-abort-of-b-and-the-answer-of-a', uiOk ? 'PASS' : 'BLOCKED', {
      sessionB: { stoppedNoteInTheTranscript: bTranscriptStopped, answerWithTheTokenPresent: bView.assistantMessages.some(text => text.includes(tokenB)), assistantMessageCount: bView.assistantMessages.length },
      sessionA: { answerWithTheTokenPresent: aHasAnswer, assistantMessageCount: aView.assistantMessages.length },
      reopenedFrom: 'the product\'s own session history (the newest page of the session\'s own history file)',
    });
    assertTrue(uiOk, 'the UI does not show the abort of B and the answer of A');

    outcome = {
      sessionA: { id: sessionA, tokenA, answered: aAnswer.includes(tokenA), events: eventsA.length, eventsAfterTheAbortOfB: aEventsAfterAbort.length },
      sessionB: { id: sessionB, tokenB, aborted: bAborted, result: bResulted, events: eventsB.length },
      processCensus: { beforeAbort: beforeAbort.map(entry => entry.pid), afterAbort: afterAbort.map(entry => entry.pid), exitedPids },
      paidTurns: 2,
    };
  } catch (error) {
    record('WB-008.runtime', 'BLOCKED', { error: String(error && error.message ? error.message : error) });
  } finally {
    if (browser) { try { await browser.close(); } catch { /* the browser is disposable */ } }
    if (host.child) { await harness.stopHost(host); }
  }

  const digestComparison = launcher.compareDigests(realProfilesBefore, launcher.digestDirectory(boot.discovery.realProfileDir));
  record('WB-008.h-real-profiles-byte-identical', digestComparison.byteIdentical ? 'PASS' : 'FAIL', {
    profileDir: boot.discovery.realProfileDir,
    comparison: 'byte-level SHA256, computed in memory; digests never printed, logged or persisted',
    fileCount: digestComparison.count,
    changedFiles: digestComparison.changedFiles,
    addedFiles: digestComparison.addedFiles,
    removedFiles: digestComparison.removedFiles,
  });

  const essential = [
    'WB-008.a-real-browser-and-host',
    'WB-008.b-model-selected-through-the-real-ui',
    'WB-008.c-session-a-is-running',
    'WB-008.d-two-sessions-run-at-the-same-time',
    'WB-008.e-only-b-was-aborted',
    'WB-008.f-session-a-kept-running-and-completed',
    'WB-008.g-the-ui-shows-the-abort-of-b-and-the-answer-of-a',
    'WB-008.h-real-profiles-byte-identical',
  ];
  const proven = essential.every(id => (results.find(entry => entry.caseId === id) || {}).status === 'PASS');

  const summary = {
    lane: 'test-workbench-runtime',
    file: 'parallel-workbench-runtime-wb008-abort.js',
    case: 'WB-008',
    title: '中止隔离（真实浏览器 + 真实模型 + 真实进程退出证明）',
    module: identity,
    host: { mode: 'standalone', engineUrlConfigured: false, dataDir: host.layout.dataDir, workspace: host.layout.workspace, hostPid },
    profile: { id: PROFILE_ID, source: 'original-subscription-store read-only, credential in memory only', credentialWrittenAnywhere: false },
    abortControl: 'the product\'s own send button in its own busy state (停止) — no out-of-band abort call',
    processCensusScope: 'the descendants of this case\'s own host child only; 5757/5760 and every unknown process are never enumerated, signalled or stopped',
    turn: outcome,
    cases: results,
    verdict: proven ? 'PASS (only B was aborted and terminated, A kept running and completed)' : 'BLOCKED',
    paidTurnsSent: outcome ? outcome.paidTurns : 0,
    quotaEndpointQueried: false,
    networkUsed: true,
  };

  const evidenceTarget = process.env.PARALLEL_WORKBENCH_RUNTIME_EVIDENCE;
  harness.writeEvidence(evidenceTarget, summary);
  if (!proven) console.log(`SCENE KEPT ${host.layout.root}`);
  else fixture.removeTree(host.layout.root);
  console.log(`parallel-workbench-runtime-wb008-abort verdict=${summary.verdict}`);
  process.exitCode = proven ? 0 : 3;
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
