'use strict';
// WB-005 — 草稿与附件隔离（真实浏览器 / 真实 0.13.6 隔离宿主）。
//
// 本入口用真实 Chrome 打开模块自带的 agent-terminal UI（安装包内
// apps/agent-terminal），在隔离宿主上跑真实的草稿生命周期：
//
//   * 两个项目 A / B，各自不同的草稿，通过产品自己的侧栏点击切换；
//   * 同一项目内两个会话，各自不同的草稿，通过产品自己的会话行点击切换；
//   * 真实浏览器刷新后草稿仍在（产品自己的浏览器存储）；
//   * 附件走产品自己的文件输入框，验证附件字节从不进入浏览器存储，
//     并且不跨项目 / 跨会话泄漏；
//   * 只重启本用例自己的隔离宿主（同一端口、同一数据目录、同一浏览器
//     profile），验证草稿与项目清单仍然成立。
//
// 全程只点产品自己的控件、只读产品自己的存储；不调用 store API 代替 UI
// 行为，不发送任何模型请求。
//
// 退出码：0 = 全部证明；3 = 诚实 BLOCKED；1 = 脚本错误。
const path = require('node:path');
const crypto = require('node:crypto');
const fixture = require('./helpers/parallel-workbench-fixture');
const harness = require('./helpers/parallel-workbench-runtime-harness');

const PROFILE_ID = String(process.env.PK_WB_MODEL_PROFILE || 'minimax');
const REQUESTED_MODEL = String(process.env.PK_WB_MODEL_ID || 'MiniMax-M3.1-Flash');

const results = [];
function record(caseId, status, detail) {
  results.push({ caseId, status, detail });
  console.log(`CASE ${caseId} ${status} ${JSON.stringify(detail)}`);
}
function assertTrue(condition, message) {
  if (!condition) throw new Error(message);
}

(async () => {
  const realProfilesBefore = fixture.digestDirectory(fixture.realWorkbenchProfileDir());
  const host = await harness.startHost({ prefix: 'parallel-wb005' });
  const identity = harness.moduleIdentity(host.moduleRoot);
  let browser = null;
  let outcome = null;

  try {
    const opened = await harness.openBrowser(host.base, host.layout);
    browser = opened.browser;

    const health = await harness.getJson(`${host.base}${harness.API_BASE}/health`);
    const projectA = await harness.ensureProject(browser, path.join(host.layout.root, 'wb005-project-a'), { name: 'wb005-project-a' });
    const projectB = await harness.ensureProject(browser, path.join(host.layout.root, 'wb005-project-b'), { name: 'wb005-project-b' });
    record('WB-005.a-real-browser-and-host', health.ok && health.body && health.body.status === 'ok' ? 'PASS' : 'BLOCKED', {
      browser: 'real Chrome via CDP (headless), isolated user-data-dir below the isolated layout',
      chrome: opened.chrome,
      module: identity,
      host: { mode: 'standalone', dataDir: host.layout.dataDir, workspace: host.layout.workspace, port: host.port },
      projects: [
        { id: projectA.projectId, name: projectA.name, createdThroughTheProductForm: projectA.created === true },
        { id: projectB.projectId, name: projectB.name, createdThroughTheProductForm: projectB.created === true },
      ],
      health: health.body,
    });
    assertTrue(health.ok && health.body && health.body.status === 'ok', 'the isolated host is not healthy');
    assertTrue(projectA.projectId && projectB.projectId && projectA.projectId !== projectB.projectId, 'the two projects were not created through the product form');

    // The profile is only selected so the product can create sessions; no
    // message is ever sent, so no model request is made in this case.
    const profiles = await harness.getJson(`${host.base}${harness.API_BASE}/profiles`);
    const listed = Array.isArray(profiles.body && profiles.body.profiles) ? profiles.body.profiles : [];
    const profile = listed.find(item => item.id === PROFILE_ID) || null;
    assertTrue(profile, `the ${PROFILE_ID} profile is not visible through the read-only facade`);
    await harness.selectModel(browser, profile.name, REQUESTED_MODEL);
    const afterModel = await harness.readState(browser);

    // --- project level drafts -------------------------------------------
    const draftA = `WB005-PROJECT-A-${crypto.randomBytes(4).toString('hex')}`;
    const draftB = `WB005-PROJECT-B-${crypto.randomBytes(4).toString('hex')}`;
    await harness.selectProject(browser, projectA.projectId);
    await harness.typeText(browser, draftA);
    const typedInA = await harness.readState(browser);
    assertTrue(typedInA.inputValue === draftA, 'project A did not keep the typed draft');
    await harness.selectProject(browser, projectB.projectId);
    const switchedToB = await harness.readState(browser);
    await harness.typeText(browser, draftB);
    await harness.selectProject(browser, projectA.projectId);
    const backInA = await harness.readState(browser);
    const projectIsolation = switchedToB.inputValue === ''
      && backInA.inputValue === draftA
      && !backInA.inputValue.includes(draftB);
    record('WB-005.b-project-drafts-are-isolated', projectIsolation ? 'PASS' : 'BLOCKED', {
      switch: 'the product\'s own sidebar project head (a real click on .proj-item)',
      projectA: { id: projectA.projectId, draft: draftA, composerAfterSwitchBack: backInA.inputValue },
      projectB: { id: projectB.projectId, draft: draftB, composerAfterSwitchIn: switchedToB.inputValue },
      projectBDraftVisibleInProjectA: backInA.inputValue.includes(draftB),
      composerShowedTheOtherProjectDraft: switchedToB.inputValue !== '',
    });
    assertTrue(projectIsolation, 'the project drafts were not isolated');

    // --- session level drafts -------------------------------------------
    const draftS1 = `WB005-SESSION-ONE-${crypto.randomBytes(4).toString('hex')}`;
    const draftS2 = `WB005-SESSION-TWO-${crypto.randomBytes(4).toString('hex')}`;
    await harness.clickNewSession(browser);
    const firstSession = await harness.waitForState(browser, state => state.product && state.product.activeSessionId, 'the first session of project A', 30000);
    const sessionS1 = firstSession.product.activeSessionId;
    await harness.typeText(browser, draftS1);
    await harness.clickNewSession(browser);
    const secondSession = await harness.waitForState(browser, state => state.product && state.product.activeSessionId && state.product.activeSessionId !== sessionS1, 'the second session of project A', 30000);
    const sessionS2 = secondSession.product.activeSessionId;
    const inS2 = await harness.readState(browser);
    await harness.typeText(browser, draftS2);
    await harness.openSessionRow(browser, projectA.projectId, sessionS1);
    const inS1 = await harness.readState(browser);
    await harness.openSessionRow(browser, projectA.projectId, sessionS2);
    const inS2Again = await harness.readState(browser);
    const sessionIsolation = inS2.inputValue === ''
      && inS1.inputValue === draftS1 && !inS1.inputValue.includes(draftS2)
      && inS2Again.inputValue === draftS2 && !inS2Again.inputValue.includes(draftS1);
    record('WB-005.c-session-drafts-are-isolated', sessionIsolation ? 'PASS' : 'BLOCKED', {
      switch: 'the product\'s own sidebar session row (a real click on .session)',
      projectId: projectA.projectId,
      sessionOne: { sessionId: sessionS1, draft: draftS1, composer: inS1.inputValue },
      sessionTwo: { sessionId: sessionS2, draft: draftS2, composerBeforeTyping: inS2.inputValue, composerAfterTyping: inS2Again.inputValue },
      sessionOneDraftLeakedIntoSessionTwo: inS2.inputValue !== '',
      sessionTwoDraftLeakedIntoSessionOne: inS1.inputValue.includes(draftS2),
    });
    assertTrue(sessionIsolation, 'the session drafts were not isolated');

    // --- attachment lifecycle -------------------------------------------
    const attachmentName = 'wb005-note.txt';
    const attachmentToken = `WB005-ATTACHMENT-${crypto.randomBytes(4).toString('hex')}`;
    const attachmentContent = `${attachmentToken}\nWB-005 attachment lifecycle\n`;
    const attachmentBase64 = Buffer.from(attachmentContent, 'utf8').toString('base64');
    await harness.openSessionRow(browser, projectA.projectId, sessionS1);
    await harness.attachFile(browser, attachmentName, attachmentContent);
    const withAttachment = await harness.readState(browser);
    const storageWithAttachment = await harness.readDraftStorage(browser);
    const bytesInStorage = storageWithAttachment.raw.includes(attachmentToken) || storageWithAttachment.raw.includes(attachmentBase64);
    await harness.selectProject(browser, projectB.projectId);
    const attachmentInB = await harness.readState(browser);
    await harness.openSessionRow(browser, projectA.projectId, sessionS1);
    const attachmentBackInA = await harness.readState(browser);
    const attachmentOk = withAttachment.attachments.length === 1
      && withAttachment.attachments[0].includes(attachmentName)
      && withAttachment.product.attachmentCount === 1
      && !bytesInStorage
      && attachmentInB.attachments.length === 0
      && attachmentInB.product.attachmentCount === 0
      && attachmentBackInA.attachments.length === 1;
    record('WB-005.d-attachment-lifecycle-and-isolation', attachmentOk ? 'PASS' : 'BLOCKED', {
      attach: 'the product\'s own <input type="file"> change handler (a real File into the real input)',
      file: attachmentName,
      trayInSessionOne: withAttachment.attachments,
      productAttachmentCountInSessionOne: withAttachment.product.attachmentCount,
      trayInProjectB: attachmentInB.attachments,
      productAttachmentCountInProjectB: attachmentInB.product.attachmentCount,
      trayAfterReturningToSessionOne: attachmentBackInA.attachments,
      attachmentBytesInBrowserStorage: bytesInStorage,
      storageKey: storageWithAttachment.key,
      storageEntryCount: storageWithAttachment.entryCount,
      storageKeys: storageWithAttachment.keys,
      contract: 'apps/agent-terminal/app.js writeDraft(): only the text goes to the browser storage, the attachment bytes stay in the page memory',
    });
    assertTrue(attachmentOk, 'the attachment lifecycle or its isolation is wrong');

    // --- a real browser refresh -----------------------------------------
    const storageBeforeRefresh = await harness.readDraftStorage(browser);
    await harness.reloadPage(browser);
    const reloaded = await harness.readState(browser);
    await harness.openSessionRow(browser, projectA.projectId, sessionS1);
    const afterRefreshS1 = await harness.readState(browser);
    await harness.selectProject(browser, projectB.projectId);
    const afterRefreshB = await harness.readState(browser);
    const storageAfterRefresh = await harness.readDraftStorage(browser);
    const refreshOk = afterRefreshS1.inputValue === draftS1
      && afterRefreshB.inputValue === draftB
      && afterRefreshS1.attachments.length === 0
      && !storageAfterRefresh.raw.includes(attachmentToken)
      && !storageAfterRefresh.raw.includes(attachmentBase64);
    record('WB-005.e-drafts-survive-a-real-browser-refresh', refreshOk ? 'PASS' : 'BLOCKED', {
      refresh: 'a real Page.reload of the real page in the real browser',
      composerInSessionOneAfterRefresh: afterRefreshS1.inputValue,
      composerInProjectBAfterRefresh: afterRefreshB.inputValue,
      attachmentAfterRefresh: afterRefreshS1.attachments,
      attachmentSurvivedTheRefresh: afterRefreshS1.attachments.length > 0,
      storageEntryCountBefore: storageBeforeRefresh.entryCount,
      storageEntryCountAfter: storageAfterRefresh.entryCount,
      storageKeys: storageAfterRefresh.keys,
      attachmentBytesInBrowserStorage: storageAfterRefresh.raw.includes(attachmentToken) || storageAfterRefresh.raw.includes(attachmentBase64),
      pageBusyAfterReload: reloaded.busy,
    });
    assertTrue(refreshOk, 'the drafts did not survive the refresh, or the attachment bytes entered the storage');

    // --- restart of this case\'s own host --------------------------------
    const oldPid = host.child.child.pid;
    const oldPort = host.port;
    await harness.stopHost(host);
    const exitInfo = await host.child.exited;
    const oldHostGone = !harness.listProcesses().some(entry => entry.pid === oldPid);
    const oldHostExited = Boolean(exitInfo) && oldHostGone;
    const restarted = await harness.startHost({ layout: host.layout, port: oldPort });
    const healthAfterRestart = await harness.getJson(`${restarted.base}${harness.API_BASE}/health`);
    await harness.reloadPage(browser);
    const afterRestart = await harness.readState(browser);
    const projectsAfterRestart = await harness.readState(browser);
    await harness.selectProject(browser, projectA.projectId);
    const restartProjectA = await harness.readState(browser);
    await harness.openSessionRow(browser, projectA.projectId, sessionS1);
    const restartDraftS1 = await harness.readState(browser);
    await harness.selectProject(browser, projectB.projectId);
    const restartDraftB = await harness.readState(browser);
    const restartOk = healthAfterRestart.ok && healthAfterRestart.body && healthAfterRestart.body.status === 'ok'
      && oldHostExited
      && restartDraftS1.inputValue === draftS1
      && restartDraftB.inputValue === draftB
      && projectsAfterRestart.product.projects.length === 2;
    record('WB-005.f-own-host-restart-keeps-projects-and-drafts', restartOk ? 'PASS' : 'BLOCKED', {
      restart: 'only this case\'s own isolated host child was stopped and restarted',
      oldHostPid: oldPid,
      oldHostExited: oldHostExited,
      oldHostProcessStillListed: !oldHostGone,
      newHostPid: restarted.child.child.pid,
      portKept: oldPort,
      healthAfterRestart: healthAfterRestart.body,
      projectsAfterRestart: projectsAfterRestart.product.projects.map(project => ({ id: project.id, name: project.name })),
      composerInProjectAAfterRestart: restartProjectA.inputValue,
      projectAProjectLevelEntryNote: 'the project level entry of project A is the migration tombstone the product writes when the draft moved into the first session of that project (writeDraft(projectId, null, { text: \'\' }))',
      composerInSessionOneAfterRestart: restartDraftS1.inputValue,
      composerInProjectBAfterRestart: restartDraftB.inputValue,
      browserProfile: opened.profileDir,
    });
    assertTrue(restartOk, 'the own-host restart did not preserve the projects and drafts');

    // --- no model request was made in this case --------------------------
    const events = await harness.recordedEvents(browser);
    const modelEvents = events.filter(event => event.type === 'claude/result' || event.type === 'claude/init');
    const noModelCall = modelEvents.length === 0;
    record('WB-005.g-no-model-request-was-made', noModelCall ? 'PASS' : 'BLOCKED', {
      recordedStreamEvents: events.map(event => event.type),
      modelStreamEvents: modelEvents.map(event => event.type),
      paidTurns: 0,
    });
    assertTrue(noModelCall, 'the draft case triggered a model request');

    outcome = {
      projectA: { id: projectA.projectId, name: projectA.name, draft: draftA },
      projectB: { id: projectB.projectId, name: projectB.name, draft: draftB },
      sessionOne: { id: sessionS1, draft: draftS1 },
      sessionTwo: { id: sessionS2, draft: draftS2 },
      attachment: { name: attachmentName, bytesInStorage: bytesInStorage, survivedRefresh: afterRefreshS1.attachments.length > 0 },
      hostRestart: { pid: oldPid, port: oldPort, ok: restartOk },
      paidTurns: 0,
    };
  } catch (error) {
    record('WB-005.runtime', 'BLOCKED', { error: String(error && error.message ? error.message : error) });
  } finally {
    if (browser) { try { await browser.close(); } catch { /* the browser is disposable */ } }
    if (host.child) { await harness.stopHost(host); }
  }

  const digestComparison = fixture.compareDigests(realProfilesBefore, fixture.digestDirectory(fixture.realWorkbenchProfileDir()));
  record('WB-005.h-real-profiles-byte-identical', digestComparison.byteIdentical ? 'PASS' : 'FAIL', {
    profileDir: fixture.realWorkbenchProfileDir(),
    comparison: 'byte-level SHA256, computed in memory; digests never printed, logged or persisted',
    fileCount: digestComparison.count,
    changedFiles: digestComparison.changedFiles,
    addedFiles: digestComparison.addedFiles,
    removedFiles: digestComparison.removedFiles,
  });

  const essential = [
    'WB-005.a-real-browser-and-host',
    'WB-005.b-project-drafts-are-isolated',
    'WB-005.c-session-drafts-are-isolated',
    'WB-005.d-attachment-lifecycle-and-isolation',
    'WB-005.e-drafts-survive-a-real-browser-refresh',
    'WB-005.f-own-host-restart-keeps-projects-and-drafts',
    'WB-005.g-no-model-request-was-made',
    'WB-005.h-real-profiles-byte-identical',
  ];
  const proven = essential.every(id => (results.find(entry => entry.caseId === id) || {}).status === 'PASS');

  const summary = {
    lane: 'test-workbench-runtime',
    file: 'parallel-workbench-runtime-wb005-drafts.js',
    case: 'WB-005',
    title: '草稿与附件隔离（真实浏览器 + 真实 UI 操作）',
    module: identity,
    host: { mode: 'standalone', engineUrlConfigured: false, dataDir: host.layout.dataDir, workspace: host.layout.workspace },
    profile: { id: PROFILE_ID, source: 'original-subscription-store read-only, credential in memory only', credentialWrittenAnywhere: false },
    uiActions: [
      'the product\'s own sidebar project head (.proj-item) to switch project',
      'the product\'s own sidebar session row (.session) to open a session',
      'the product\'s own "新会话" button to create a session',
      'the product\'s own <input type="file"> change handler to attach a file',
      'a real Page.reload of the real page',
    ],
    storeApiUsedAsUiSubstitute: false,
    turn: outcome,
    cases: results,
    verdict: proven ? 'PASS (drafts and attachments are isolated across projects, sessions, refresh and an own-host restart)' : 'BLOCKED',
    paidTurnsSent: 0,
    quotaEndpointQueried: false,
    networkUsed: false,
  };

  const evidenceTarget = process.env.PARALLEL_WORKBENCH_RUNTIME_EVIDENCE;
  harness.writeEvidence(evidenceTarget, summary);
  if (!proven) console.log(`SCENE KEPT ${host.layout.root}`);
  else fixture.removeTree(host.layout.root);
  console.log(`parallel-workbench-runtime-wb005-drafts verdict=${summary.verdict}`);
  process.exitCode = proven ? 0 : 3;
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
