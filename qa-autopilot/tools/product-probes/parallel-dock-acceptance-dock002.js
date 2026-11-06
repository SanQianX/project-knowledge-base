#!/usr/bin/env node
'use strict';
// P-DOCK-ACCEPTANCE-01 / DOCK-002: 标签生命周期。
//
// Real UI only: dock toggle, + picker, tab clicks, tab close buttons — no
// driver-side panel management functions. Two different tabs (the host
// knowledge panel 本次知识引用 and the native 新标签页 launcher) are opened,
// switched, one is closed, then reopened. The product registers exactly one
// host provider (kb.knowledge.references, multiInstance 'single'), so
// "两个不同标签/panelId隔离" is exercised as: two tabs with distinct ids
// holding isolated state, and the host panelId changing across close/reopen.
// Expectations (test-cases.json DOCK-002):
//   1. 状态按 panelId 隔离 — knowledge pane survives switches untouched; a
//      reopened panel gets a NEW panelId and fresh delivery; switching
//      triggers no content relays.
//   2. 关闭释放监听器 — closing the host tab removes its sandboxed iframe
//      node and stops all traffic to the dead panelId.
//   3. 不关闭主会话 — main session identity/events/process unchanged.

const os = require('os');
const path = require('path');

const PKB_ROOT = path.resolve(__dirname, '..', '..', '..');
const UI = require(path.join(PKB_ROOT, '_site', '_test', 'helpers', 'parallel-dock-acceptance-ui.js'));
const { createDockAcceptanceEnv } = require(path.join(PKB_ROOT, '_site', '_test', 'helpers', 'parallel-dock-acceptance-env.js'));

const ARTIFACTS = path.join(PKB_ROOT, 'qa-autopilot', 'artifacts', 'parallel-20261023', 'dock-acceptance-r1');
const KNOWLEDGE_TAB = '本次知识引用';
const LAUNCHER_TAB = '新标签页';
const PROVIDER = 'kb.knowledge.references';

function latestKnowledgePanel(productLog) {
  for (let i = productLog.length - 1; i >= 0; i -= 1) {
    const entry = productLog[i];
    if (entry.type !== 'kb:panel/state' || !Array.isArray(entry.panels)) continue;
    // The newest panel state is authoritative: after a close the product
    // posts panels: [] and the provider must be absent from it.
    return entry.panels.find(item => item.providerId === PROVIDER) || null;
  }
  return null;
}

async function main() {
  const evidence = {
    schema: 'qa-autopilot/dock-acceptance-evidence/v1',
    case: 'DOCK-002',
    startedAt: new Date().toISOString(),
    steps: [],
    expectations: [],
    firstFailure: null,
  };
  let env = null;
  let browser = null;
  try {
    env = await createDockAcceptanceEnv({ tag: 'dock002' });
    evidence.identity = { ...env.identity(), fileHashes: env.fileHashes() };
    evidence.env = { productUrl: env.productUrl, terminalUrl: env.terminalUrl, terminalProjectId: env.terminalProjectId };
    console.log(`[dock002] product=${env.productUrl} terminal=${env.terminalUrl}`);

    browser = await UI.launchCdpBrowser({
      chrome: UI.findChrome(),
      profileDir: path.join(os.tmpdir(), `pk-dock002-profile-${process.pid}`),
      url: env.productUrl, width: 1920, height: 1080,
    });
    await UI.installProductLog(browser);
    await UI.openWorkView(browser, env.productUrl);
    await UI.installTerminalLog(browser);

    // Real session for the dock scope (lazy start, no model call).
    const beforeList = await env.termApi(`sessions?contextId=${env.terminalProjectId}`);
    const before = beforeList.data && Array.isArray(beforeList.data.sessions) ? beforeList.data.sessions.length : 0;
    await UI.newSessionViaUi(browser);
    let sessionRow = null;
    await UI.waitFor(async () => {
      const list = await env.termApi(`sessions?contextId=${env.terminalProjectId}`);
      const rows = list.data && Array.isArray(list.data.sessions) ? list.data.sessions : [];
      if (rows.length <= before) return false;
      sessionRow = rows.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))[0];
      return true;
    }, 'session created', 30000);
    const sessionId = sessionRow.sessionId;
    await UI.waitFor(() => UI.sessionRowExists(browser, sessionId), 'session row visible', 20000);

    // Seed isolated knowledge for this session, then re-open it through the
    // real sidebar so the product caches real references to deliver.
    env.seedSessionKnowledge(sessionId, [{ entryId: 'K-ISO-1', title: '隔离引用一', text: 'DOCK-002 隔离知识内容。', projectId: env.projectId }]);
    await UI.clickSessionRow(browser, sessionId);
    await UI.waitFor(() => UI.getLogs(browser).then(logs =>
      logs.productLog.some(entry => entry.type === 'kb:knowledge' && Array.isArray(entry.knowledgeRefs) && entry.knowledgeRefs.includes('K-ISO-1'))
    ), 'knowledge cache update after session re-open', 30000);

    const baselineLoaded = await env.termApi(`sessions/${sessionId}`);
    const baselineEvents = (baselineLoaded.data && baselineLoaded.data.events) || [];
    const baselinePid = env.processes.terminal.pid;

    // Open the knowledge tab through the real dock UI.
    await UI.clickDockToggle(browser);
    await UI.clickLauncherKnowledgeRow(browser);
    await UI.waitFor(() => UI.dockSnapshot(browser).then(snap => snap.tabs.some(tab => tab.label === KNOWLEDGE_TAB)), 'knowledge tab open', 15000);
    await UI.waitFor(() => UI.dockSnapshot(browser).then(snap => snap.hostFrames === 1), 'knowledge iframe mounted', 15000);
    let panel1 = null;
    await UI.waitFor(() => UI.getLogs(browser).then(logs => {
      panel1 = latestKnowledgePanel(logs.productLog);
      return panel1 && panel1.panelId;
    }), 'panel state carries knowledge panelId', 15000);
    const panelId1 = panel1.panelId;
    await UI.waitFor(() => UI.getLogs(browser).then(logs =>
      logs.termLog.some(entry => entry.type === 'kb:panel/content' && entry.panelId === panelId1 && Array.isArray(entry.contentRefs) && entry.contentRefs.includes('K-ISO-1')) &&
      logs.termLog.some(entry => entry.type === 'kb:panel/content-ack' && entry.panelId === panelId1 && entry.ok === true)
    ), 'first content relay + ack', 20000);
    evidence.steps.push({ step: 'open-knowledge-tab', panelId1, snapshot: await UI.dockSnapshot(browser) });

    // Second, different tab through +.
    await UI.clickPlus(browser);
    await UI.waitFor(() => UI.dockSnapshot(browser).then(snap => snap.tabCount === 2 && snap.tabs.some(tab => tab.label === LAUNCHER_TAB)), 'launcher tab open', 15000);
    const relaysBeforeSwitch = await UI.getLogs(browser).then(logs => logs.termLog.filter(entry => entry.type === 'kb:panel/content').length);

    // Switch back and forth; the knowledge pane must be preserved untouched.
    await UI.clickTabByLabel(browser, KNOWLEDGE_TAB);
    await UI.waitFor(() => UI.dockSnapshot(browser).then(snap => snap.tabs.find(tab => tab.label === KNOWLEDGE_TAB)?.selected === true), 'knowledge tab selected', 10000);
    await UI.clickTabByLabel(browser, LAUNCHER_TAB);
    await UI.waitFor(() => UI.dockSnapshot(browser).then(snap => snap.tabs.find(tab => tab.label === LAUNCHER_TAB)?.selected === true), 'launcher tab selected', 10000);
    const afterSwitch = await UI.dockSnapshot(browser);
    const relaysAfterSwitch = await UI.getLogs(browser).then(logs => logs.termLog.filter(entry => entry.type === 'kb:panel/content').length);
    evidence.steps.push({ step: 'switch-tabs', snapshot: afterSwitch, relaysDuringSwitch: relaysAfterSwitch - relaysBeforeSwitch });

    // Close the launcher, then reopen it via + (再打开).
    await UI.closeTabByLabel(browser, LAUNCHER_TAB);
    await UI.waitFor(() => UI.dockSnapshot(browser).then(snap => snap.tabCount === 1 && snap.tabs[0].label === KNOWLEDGE_TAB && snap.hostFrames === 1), 'launcher closed, knowledge intact', 10000);
    await UI.clickPlus(browser);
    await UI.waitFor(() => UI.dockSnapshot(browser).then(snap => snap.tabCount === 2), 'launcher reopened', 10000);

    // Close the knowledge panel: iframe removed, traffic to panelId1 stops.
    await UI.closeTabByLabel(browser, KNOWLEDGE_TAB);
    await UI.waitFor(() => UI.dockSnapshot(browser).then(snap => snap.hostFrames === 0 && snap.tabCount === 1), 'knowledge pane removed from DOM', 10000);
    await UI.waitFor(() => UI.getLogs(browser).then(logs => {
      const panel = latestKnowledgePanel(logs.productLog);
      return !panel;
    }), 'panel state no longer lists knowledge panel', 10000);
    const closedLogs = await UI.getLogs(browser);
    const relaysToDeadPanel = closedLogs.termLog.filter(entry => entry.type === 'kb:panel/content' && entry.panelId === panelId1).length;
    evidence.steps.push({ step: 'close-knowledge-tab', relaysToDeadPanelAtClose: relaysToDeadPanel, snapshot: await UI.dockSnapshot(browser) });

    // Reopen the knowledge panel through the launcher: new panelId, fresh delivery.
    await UI.clickLauncherKnowledgeRow(browser);
    let panel2 = null;
    await UI.waitFor(() => UI.getLogs(browser).then(logs => {
      panel2 = latestKnowledgePanel(logs.productLog);
      return panel2 && panel2.panelId;
    }), 'reopened panel state', 15000);
    const panelId2 = panel2.panelId;
    await UI.waitFor(() => UI.getLogs(browser).then(logs =>
      logs.termLog.some(entry => entry.type === 'kb:panel/content' && entry.panelId === panelId2 && Array.isArray(entry.contentRefs) && entry.contentRefs.includes('K-ISO-1')) &&
      logs.termLog.some(entry => entry.type === 'kb:panel/content-ack' && entry.panelId === panelId2 && entry.ok === true)
    ), 're-delivery to new panelId + ack', 20000);
    const finalLogs = await UI.getLogs(browser);
    const relaysToDeadPanelFinal = finalLogs.termLog.filter(entry => entry.type === 'kb:panel/content' && entry.panelId === panelId1).length;
    evidence.steps.push({ step: 'reopen-knowledge-tab', panelId2, snapshot: await UI.dockSnapshot(browser) });

    // Main session untouched.
    const finalLoaded = await env.termApi(`sessions/${sessionId}`);
    const finalEvents = (finalLoaded.data && finalLoaded.data.events) || [];
    const sessionRowsFinal = await env.termApi(`sessions?contextId=${env.terminalProjectId}`);
    const sessionRows = sessionRowsFinal.data && Array.isArray(sessionRowsFinal.data.sessions) ? sessionRowsFinal.data.sessions : [];

    evidence.panelIds = { panelId1, panelId2 };
    evidence.sessionGuard = {
      sessionId,
      eventCount: `${baselineEvents.length} -> ${finalEvents.length}`,
      sessionCount: sessionRows.length,
      modulePidSame: baselinePid === env.processes.terminal.pid && env.processes.terminal.exitCode === null,
    };

    evidence.expectations.push({
      key: 'state-per-panelid',
      expect: '两个不同标签状态隔离：切换不触发内容重投；重开的面板获得新 panelId 并重新投递；知识 pane 在切换期间原样保留',
      observed: JSON.stringify({
        panelId1, panelId2,
        relaysDuringSwitch: relaysAfterSwitch - relaysBeforeSwitch,
        hostFramesPreservedDuringSwitch: afterSwitch.hostFrames === 1,
        redelivery: finalLogs.termLog.some(entry => entry.type === 'kb:panel/content' && entry.panelId === panelId2 && (entry.contentRefs || []).includes('K-ISO-1')),
        singleProviderNote: '产品仅注册一个宿主面板提供方（kb.knowledge.references，multiInstance single，ui/product.js:14-16），两个不同标签以 知识面板+新标签页 实现，panelId 隔离以 关闭/重开 换新 panelId 验证',
      }),
      pass: panelId2 !== panelId1
        && (relaysAfterSwitch - relaysBeforeSwitch) === 0
        && afterSwitch.hostFrames === 1
        && finalLogs.termLog.some(entry => entry.type === 'kb:panel/content' && entry.panelId === panelId2 && (entry.contentRefs || []).includes('K-ISO-1')),
    });
    evidence.expectations.push({
      key: 'close-releases-listeners',
      expect: '关闭释放监听器：宿主 iframe 节点从 DOM 移除，panelId 不再出现在面板状态，死后无任何内容投递',
      observed: JSON.stringify({
        hostFramesAfterClose: evidence.steps.find(step => step.step === 'close-knowledge-tab').snapshot.hostFrames,
        relaysToDeadPanel: relaysToDeadPanelFinal,
        panelStateCleared: true,
      }),
      pass: relaysToDeadPanelFinal === relaysToDeadPanel
        && relaysToDeadPanelFinal >= 1
        && evidence.steps.find(step => step.step === 'close-knowledge-tab').snapshot.hostFrames === 0,
    });
    evidence.expectations.push({
      key: 'main-session-alive',
      expect: '不关闭主会话：会话 id 与事件数不变、模块进程不变',
      observed: JSON.stringify(evidence.sessionGuard),
      pass: Boolean(
        finalLoaded.data && finalLoaded.data.session && finalLoaded.data.session.sessionId === sessionId
        && baselineEvents.length === finalEvents.length
        && evidence.sessionGuard.modulePidSame
      ),
    });

    evidence.consoleErrors = browser.consoleErrors.length;
    evidence.exceptions = browser.exceptions.length;
    if (browser.consoleErrors.length) evidence.consoleErrorSamples = browser.consoleErrors.slice(0, 5);
  } catch (error) {
    evidence.firstFailure = { message: error.message, stack: String(error.stack || '').split('\n').slice(0, 12) };
    try { if (browser) evidence.failureContext = await UI.failureContext(browser); } catch {}
  } finally {
    evidence.verdict = evidence.firstFailure ? 'FAIL' : (evidence.expectations.length && evidence.expectations.every(item => item.pass) ? 'PASS' : 'FAIL');
    evidence.finishedAt = new Date().toISOString();
    try { if (browser) await browser.close(); } catch {}
    try { if (env) await env.cleanup(); } catch (error) { console.error('[dock002] cleanup error:', error.message); }
    const writer = UI.evidenceWriter(ARTIFACTS, 'dock002-evidence.json');
    evidence.file = writer.write(evidence);
    console.log(`[dock002] verdict=${evidence.verdict} evidence=${evidence.file}`);
    process.exitCode = evidence.verdict === 'PASS' ? 0 : 1;
  }
}

main().catch(error => { console.error('[dock002] fatal:', error); process.exitCode = 1; });
