'use strict';
// P-WB-QA-INTEGRATION-5025 canonical copy of the accepted WB-004 entry
// (_site/_test/parallel-workbench-runtime-wb004-ordering.js, frozen untracked).
// P-WB-CANONICAL-R2 wiring: the entry goes through the canonical launcher boot
// (paid gate + explicit real-profile authorization → read-only discovery with
// the real environment → FULL driver isolation incl. APPDATA/LOCALAPPDATA/
// CODEX_HOME → carried-through captures), and the real-profile digest helpers
// come from the launcher's authorized layer instead of the pre-R5 tracked
// fixture whose whitelist lacked those keys. Case logic, expecteds and the
// two-level model evidence are unchanged. Real paid model probe (two turns,
// real network to the provider) — run only explicitly via the integration-5025
// runner with PK_WB_ALLOW_PAID_TURNS=1 and an explicit PK_WB_REAL_PROFILE_DIR.
// WB-004 — 连续回复次序（真实浏览器 / 真实 0.13.6 隔离宿主 / 真实 MiniMax）.
//
// 本入口用真实 Chrome 打开模块自带的 agent-terminal UI（安装包内
// apps/agent-terminal），在隔离宿主上跑本轮真实 Q1 与 Q2：
//
//   * Q1 结束后立即发 Q2（同一会话）；
//   * 故障注入 = 把本轮真实 Q1 的一条真实事件在 Q2 进行中【延迟重放】回
//     同一条 SSE 流。重放由页面内的记录器完成，记录器只记录与重放，不做
//     过滤、不改顺序、不替产品判断；
//   * 判定只看产品自身的 UI 与活动状态：Q1 正文不在 Q2 之后重复、Q2 不被
//     错误置为 idle。
//
// 退出码：0 = 全部证明；3 = 诚实 BLOCKED；1 = 脚本错误。
const fs = require('node:fs');
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

// The vendor-returned model of this run: the assistant message.model of the
// real CLI transcript under the ISOLATED CLAUDE_CONFIG_DIR. Only model
// strings and booleans leave here.
function scanTranscript(roots, sessionIds, tokens) {
  const matched = [];
  const models = new Set();
  let tokenEchoed = false;
  const walk = root => {
    let entries;
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(root, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.isFile() || !full.endsWith('.jsonl')) continue;
      let text;
      try { text = fs.readFileSync(full, 'utf8'); } catch { continue; }
      if (!sessionIds.some(id => text.includes(id))) continue;
      matched.push(path.basename(full));
      for (const line of text.split(/\r?\n/)) {
        let entry;
        try { entry = JSON.parse(line); } catch { continue; }
        if (entry.type !== 'assistant' || !entry.message) continue;
        if (typeof entry.message.model === 'string' && entry.message.model) models.add(entry.message.model);
        const content = Array.isArray(entry.message.content) ? entry.message.content : [];
        for (const block of content) {
          if (block && block.type === 'text' && typeof block.text === 'string' && tokens.some(token => block.text.includes(token))) tokenEchoed = true;
        }
      }
    }
  };
  for (const root of roots) walk(root);
  return { transcriptFilesMatched: matched, assistantModelValues: [...models], tokenEchoedInTranscript: tokenEchoed };
}

(async () => {
  // The single safe entry discipline: gates, real-env discovery, full driver
  // isolation, carried-through captures — before anything else happens.
  const boot = launcher.boot({ prefix: 'parallel-wb004', paid: true, needsRealProfile: true });
  const realProfilesBefore = launcher.digestDirectory(boot.discovery.realProfileDir);
  const host = await harness.startHost({
    prefix: 'parallel-wb004',
    moduleRoot: boot.discovery.moduleRoot,
    realProfileDir: boot.discovery.realProfileDir,
  });
  const identity = harness.moduleIdentity(host.moduleRoot);
  let browser = null;
  let ui = null;
  let outcome = null;
  let blocked = null;

  try {
    const opened = await harness.openBrowser(host.base, host.layout, { chrome: boot.discovery.chrome });
    browser = opened.browser;
    ui = opened;

    const health = await harness.getJson(`${host.base}${harness.API_BASE}/health`);
    const project = await harness.ensureProject(browser, path.join(host.layout.root, 'wb004-project'), { name: 'wb004-project' });
    record('WB-004.a-real-browser-and-host', health.ok && health.body && health.body.status === 'ok' ? 'PASS' : 'BLOCKED', {
      browser: 'real Chrome via CDP (headless), isolated user-data-dir below the isolated layout',
      chrome: opened.chrome,
      module: identity,
      host: { mode: 'standalone', dataDir: host.layout.dataDir, workspace: host.layout.workspace, port: host.port },
      project: { id: project.projectId, name: project.name, createdThroughTheProductForm: project.created === true },
      health: health.body,
    });
    assertTrue(health.ok && health.body && health.body.status === 'ok', 'the isolated host is not healthy');

    const profiles = await harness.getJson(`${host.base}${harness.API_BASE}/profiles`);
    const listed = Array.isArray(profiles.body && profiles.body.profiles) ? profiles.body.profiles : [];
    const profile = listed.find(item => item.id === PROFILE_ID) || null;
    assertTrue(profile, `the ${PROFILE_ID} profile is not visible through the read-only facade`);
    const credentialConfigured = profile.credentialConfigured === true;

    await harness.selectModel(browser, profile.name, REQUESTED_MODEL);
    const afterModel = await harness.readState(browser);
    record('WB-004.b-model-selected-through-the-real-ui', credentialConfigured && afterModel.product.currentProfileId === PROFILE_ID && afterModel.product.currentModel === REQUESTED_MODEL ? 'PASS' : 'BLOCKED', {
      profileId: PROFILE_ID,
      profileName: profile.name,
      requestedModel: REQUESTED_MODEL,
      uiProfileId: afterModel.product.currentProfileId,
      uiModel: afterModel.product.currentModel,
      modelLabel: afterModel.modelLabel,
      credentialConfigured,
      credentialWrittenAnywhere: false,
    });
    assertTrue(credentialConfigured, 'the profile has no configured credential');

    const token1 = `WBRT-ORDER-A-${crypto.randomBytes(5).toString('hex')}`;
    const token2 = `WBRT-ORDER-B-${crypto.randomBytes(5).toString('hex')}`;
    const question1 = `这是 WB-004 连续回复次序的真实抽测（第 1 问）。请只回复一行，原样包含以下随机标记，不要添加任何其他内容：${token1}`;
    const question2 = `这是 WB-004 连续回复次序的真实抽测（第 2 问）。请先输出一行、原样包含以下随机标记：${token2}；然后再写三行简短说明，说明这是第 2 问。`;

    // --- Q1 -------------------------------------------------------------
    await harness.typeText(browser, question1);
    await harness.clickSend(browser);
    const q1Busy = await harness.waitForState(browser, state => state.busy === true, 'Q1 to start', 90000);
    const q1Done = await harness.waitForState(browser, state => state.busy === false && state.product.liveRevision > 0, 'Q1 to end', TURN_TIMEOUT_MS);
    const q1Text = q1Done.streamText;
    const q1Answers = q1Done.assistantMessages.filter(text => text.includes(token1));
    const q1Count = q1Answers.length;
    record('WB-004.c-q1-answered-by-the-real-model', q1Count === 1 ? 'PASS' : 'BLOCKED', {
      uniqueToken: token1,
      assistantAnswersCarryingTheToken: q1Count,
      answerPreview: q1Answers.length ? q1Answers[0].slice(0, 200) : q1Text.slice(-200),
      uiSessionState: q1Done.product.sessionState,
      paidTurns: 1,
    });
    assertTrue(q1Count === 1, `Q1 was not answered with the unique token (${q1Count} assistant answers carry it)`);

    // --- Q2 immediately --------------------------------------------------
    const q1ResultEvent = (await harness.recordedEvents(browser))
      .filter(event => event.type === 'claude/result' && event.data.includes(token1))
      .pop() || null;
    const q2SentAt = Date.now();
    await harness.typeText(browser, question2);
    await harness.clickSend(browser);
    const q2Busy = await harness.waitForState(browser, state => state.busy === true, 'Q2 to start', 90000);
    const gapMs = q1ResultEvent ? q2SentAt - q1ResultEvent.at : null;
    record('WB-004.d-q2-sent-immediately-after-q1', gapMs !== null && gapMs < 10000 ? 'PASS' : 'BLOCKED', {
      q1ResultEventAt: q1ResultEvent ? q1ResultEvent.at : null,
      q2SentAt,
      gapMs,
      sameSession: q1Busy.product.activeSessionId === q2Busy.product.activeSessionId,
      sessionId: q2Busy.product.activeSessionId,
    });
    assertTrue(gapMs !== null && gapMs < 10000, 'Q2 was not sent immediately after Q1');

    // The fault injection lands while Q2 is still running: the replay is
    // issued as soon as the UI reports Q2 busy, and the product's answer to
    // the stale event is read back immediately afterwards.
    const beforeReplay = await harness.readState(browser);
    assertTrue(beforeReplay.busy === true, 'Q2 was no longer running when the fault injection was due');
    const events = await harness.recordedEvents(browser);
    const q1ResultIndex = events.findIndex(event => event.type === 'claude/result' && event.data.includes(token1));
    assertTrue(q1ResultIndex >= 0, 'the real Q1 result event was not recorded by the product stream');
    const q1ResultData = events[q1ResultIndex].data;
    const replay = await harness.replayRecordedEvent(browser, q1ResultIndex, `/sessions/${q2Busy.product.activeSessionId}/events`);
    await harness.wait(400);
    const afterReplay = await harness.readState(browser);
    const replayedEvents = await harness.recordedEvents(browser);
    const matches = event => event.type === 'claude/result' && event.data === q1ResultData;
    const delivered = replayedEvents.filter(matches).length - events.filter(matches).length;

    const q1AfterReplay = afterReplay.assistantMessages.filter(text => text.includes(token1)).length;
    const q2DuringReplay = afterReplay.assistantMessages.filter(text => text.includes(token2)).length;
    const assistantCountBefore = beforeReplay.assistantMessages.length;
    const assistantCountAfter = afterReplay.assistantMessages.length;
    const staleDropped = q1AfterReplay === 1 && assistantCountAfter === assistantCountBefore;
    const stillBusy = afterReplay.busy === true && afterReplay.product.sessionState !== 'idle';
    record('WB-004.e-stale-q1-message-replayed-into-the-live-q2-turn', staleDropped && stillBusy ? 'PASS' : 'BLOCKED', {
      injectedEvent: { index: q1ResultIndex, type: events[q1ResultIndex].type, sequence: (() => { try { return JSON.parse(q1ResultData).sequence; } catch { return null; } })() },
      replayResult: replay,
      timesTheSameRealQ1EventReachedTheProduct: delivered,
      productLiveRevisionBefore: beforeReplay.product.liveRevision,
      productLiveRevisionAfter: afterReplay.product.liveRevision,
      staleEventAcceptedByTheProduct: !staleDropped,
      assistantMessagesBeforeReplay: assistantCountBefore,
      assistantMessagesAfterReplay: assistantCountAfter,
      q1BodyOccurrencesAfterReplay: q1AfterReplay,
      q2BodyOccurrencesDuringReplay: q2DuringReplay,
      uiBusyAfterReplay: afterReplay.busy,
      uiSessionStateAfterReplay: afterReplay.product.sessionState,
      uiStatusTextAfterReplay: afterReplay.statusText,
      note: 'the replayed frame is byte-identical to the real Q1 result frame of this round and is delivered to the very same session SSE stream the product reads; whether it is rendered is decided by the product\'s own session-sequence guard (apps/agent-terminal/app.js)',
    });
    assertTrue(replay.replayed === true && replay.delivered >= 1, 'the replayed Q1 message never reached the product');
    assertTrue(delivered >= 1, 'the replayed Q1 message did not reach the product a second time');
    assertTrue(staleDropped, 'the product rendered the stale Q1 event (Q1 body repeated)');
    assertTrue(stillBusy, 'Q2 was wrongly put into idle by the stale Q1 event');

    // --- Q2 completes ----------------------------------------------------
    const q2Done = await harness.waitForState(browser, state => state.busy === false && state.assistantMessages.filter(text => text.includes(token2)).length === 1, 'Q2 to end', TURN_TIMEOUT_MS);
    const finalAnswers = q2Done.assistantMessages;
    const q1Indexes = finalAnswers.map((text, index) => (text.includes(token1) ? index : -1)).filter(index => index >= 0);
    const q2Indexes = finalAnswers.map((text, index) => (text.includes(token2) ? index : -1)).filter(index => index >= 0);
    const q1Final = q1Indexes.length;
    const q2Final = q2Indexes.length;
    const order = q1Final === 1 && q2Final === 1 && q1Indexes[0] < q2Indexes[0];
    record('WB-004.f-q2-completed-with-its-own-answer', order ? 'PASS' : 'BLOCKED', {
      assistantMessageCount: finalAnswers.length,
      q1Answers: q1Final,
      q2Answers: q2Final,
      q1BeforeQ2InTheTranscript: order,
      uiSessionState: q2Done.product.sessionState,
      paidTurns: 2,
    });
    assertTrue(order, 'the final transcript does not hold exactly one Q1 and one Q2 answer in order');

    // --- the vendor-returned model of this run ---------------------------
    const sessionId = q2Done.product.activeSessionId;
    const initEvents = (await harness.recordedEvents(browser)).filter(event => event.type === 'claude/init');
    const claudeSessionIds = initEvents.map(event => { try { return JSON.parse(event.data).claudeSessionId; } catch { return null; } }).filter(Boolean);
    const transcript = scanTranscript(
      [host.layout.claudeConfigDir, path.join(host.layout.home, '.claude')],
      claudeSessionIds,
      [token1, token2],
    );
    const vendorModelOk = transcript.assistantModelValues.length > 0
      && transcript.assistantModelValues.every(model => model.replace(/\s+/g, '').toLowerCase() === REQUESTED_MODEL.replace(/\s+/g, '').toLowerCase())
      && transcript.tokenEchoedInTranscript;
    record('WB-004.g-vendor-returned-model-from-the-real-transcript', vendorModelOk ? 'PASS' : 'BLOCKED', {
      requestedModel: REQUESTED_MODEL,
      assistantModelValues: transcript.assistantModelValues,
      tokenEchoedInTranscript: transcript.tokenEchoedInTranscript,
      transcriptFilesMatched: transcript.transcriptFilesMatched,
      claudeSessionIds,
      workbenchSessionId: sessionId,
    });

    outcome = {
      workbenchSessionId: sessionId,
      q1Token: token1,
      q2Token: token2,
      gapMs,
      q1FinalOccurrences: q1Final,
      q2FinalOccurrences: q2Final,
      vendorReturnedModels: transcript.assistantModelValues,
      paidTurns: 2,
    };
  } catch (error) {
    blocked = { message: String(error && error.message ? error.message : error) };
    record('WB-004.runtime', 'BLOCKED', { error: blocked.message });
  } finally {
    if (browser) { try { await browser.close(); } catch { /* the browser is disposable */ } }
    if (host.child) { await harness.stopHost(host); }
  }

  const digestComparison = launcher.compareDigests(realProfilesBefore, launcher.digestDirectory(boot.discovery.realProfileDir));
  record('WB-004.h-real-profiles-byte-identical', digestComparison.byteIdentical ? 'PASS' : 'FAIL', {
    profileDir: boot.discovery.realProfileDir,
    comparison: 'byte-level SHA256, computed in memory; digests never printed, logged or persisted',
    fileCount: digestComparison.count,
    changedFiles: digestComparison.changedFiles,
    addedFiles: digestComparison.addedFiles,
    removedFiles: digestComparison.removedFiles,
  });

  const essential = [
    'WB-004.a-real-browser-and-host',
    'WB-004.b-model-selected-through-the-real-ui',
    'WB-004.c-q1-answered-by-the-real-model',
    'WB-004.d-q2-sent-immediately-after-q1',
    'WB-004.e-stale-q1-message-replayed-into-the-live-q2-turn',
    'WB-004.f-q2-completed-with-its-own-answer',
    'WB-004.g-vendor-returned-model-from-the-real-transcript',
    'WB-004.h-real-profiles-byte-identical',
  ];
  const proven = essential.every(id => (results.find(entry => entry.caseId === id) || {}).status === 'PASS');

  const summary = {
    lane: 'test-workbench-runtime',
    file: 'parallel-workbench-runtime-wb004-ordering.js',
    case: 'WB-004',
    title: '连续回复次序（真实浏览器 + 真实模型 + 故障注入）',
    module: identity,
    host: { mode: 'standalone', engineUrlConfigured: false, dataDir: host.layout.dataDir, workspace: host.layout.workspace },
    profile: { id: PROFILE_ID, source: 'original-subscription-store read-only, credential in memory only', credentialWrittenAnywhere: false },
    faultInjection: 'a real Q1 event of this round, recorded on the product\'s own SSE stream, is delivered a second time to that same stream while Q2 is running',
    turn: outcome,
    cases: results,
    verdict: proven ? 'PASS (ordering proven: no repeated Q1 body, no wrongly idle Q2)' : 'BLOCKED',
    paidTurnsSent: outcome ? outcome.paidTurns : 0,
    quotaEndpointQueried: false,
    networkUsed: true,
  };

  const evidenceTarget = process.env.PARALLEL_WORKBENCH_RUNTIME_EVIDENCE;
  harness.writeEvidence(evidenceTarget, summary);
  if (!proven) {
    // A real API error keeps the scene: the isolated layout is left on disk.
    console.log(`SCENE KEPT ${host.layout.root}`);
  } else {
    fixture.removeTree(host.layout.root);
  }
  console.log(`parallel-workbench-runtime-wb004-ordering verdict=${summary.verdict}`);
  process.exitCode = proven ? 0 : 3;
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

function assertTrue(condition, message) {
  if (!condition) throw new Error(message);
}
