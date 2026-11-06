#!/usr/bin/env node
'use strict';
// P-DOCK-ACCEPTANCE-01 / DOCK-003: 知识被动刷新。
//
// Dock closed, no tabs. The product's knowledge cache updates through the
// real passive flow (terminal session open fetches the module's persisted
// session knowledge and publishes kb:knowledge). Expectations:
//   1. 不得自动开标签或展开 Dock — no kb:panel/open, no tab, dock stays
//      collapsed while the cache updates.
//   2. 只有用户导航才打开 — afterwards the user expands the dock and opens
//      the knowledge tab through the real UI, and only then the panel
//      receives the passively cached references.
// Fixture knowledge data is written through the module's real persisted
// store format (isolated data dir); every behavior is real UI + real module.

const os = require('os');
const path = require('path');

const PKB_ROOT = path.resolve(__dirname, '..', '..', '..');
const UI = require(path.join(PKB_ROOT, '_site', '_test', 'helpers', 'parallel-dock-acceptance-ui.js'));
const { createDockAcceptanceEnv } = require(path.join(PKB_ROOT, '_site', '_test', 'helpers', 'parallel-dock-acceptance-env.js'));

const ARTIFACTS = path.join(PKB_ROOT, 'qa-autopilot', 'artifacts', 'parallel-20261023', 'dock-acceptance-r1');
const PROVIDER = 'kb.knowledge.references';

async function listSessions(env) {
  const response = await env.termApi(`sessions?contextId=${env.terminalProjectId}`);
  const data = response.data;
  return data && Array.isArray(data.sessions) ? data.sessions : [];
}

async function main() {
  const evidence = {
    schema: 'qa-autopilot/dock-acceptance-evidence/v1',
    case: 'DOCK-003',
    startedAt: new Date().toISOString(),
    steps: [],
    expectations: [],
    firstFailure: null,
  };
  let env = null;
  let browser = null;
  try {
    env = await createDockAcceptanceEnv({ tag: 'dock003' });
    evidence.identity = { ...env.identity(), fileHashes: env.fileHashes() };
    evidence.env = { productUrl: env.productUrl, terminalUrl: env.terminalUrl, terminalProjectId: env.terminalProjectId };
    console.log(`[dock003] product=${env.productUrl} terminal=${env.terminalUrl}`);

    browser = await UI.launchCdpBrowser({
      chrome: UI.findChrome(),
      profileDir: path.join(os.tmpdir(), `pk-dock003-profile-${process.pid}`),
      url: env.productUrl, width: 1920, height: 1080,
    });
    await UI.installProductLog(browser);
    await UI.openWorkView(browser, env.productUrl);
    await UI.installTerminalLog(browser);

    // Two real sessions through the real UI (lazy start, no model call).
    // The app drops a 新会话 click while a per-project creation is still in
    // flight (app.js creatingSessions guard), so creation B uses bounded
    // click-retry and ids are identified by set difference, not ordering.
    const baselineIds = new Set((await listSessions(env)).map(row => row.sessionId));
    await UI.newSessionViaUi(browser);
    let sessionA = null;
    await UI.waitFor(async () => {
      const rows = await listSessions(env);
      sessionA = rows.find(row => !baselineIds.has(row.sessionId)) || null;
      return Boolean(sessionA);
    }, 'session A created', 30000);
    let sessionB = null;
    for (let attempt = 1; attempt <= 5 && !sessionB; attempt += 1) {
      await UI.newSessionViaUi(browser);
      const grown = await UI.waitFor(async () => {
        const rows = await listSessions(env);
        sessionB = rows.filter(row => row.sessionId !== sessionA.sessionId && !baselineIds.has(row.sessionId))
          .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))[0] || null;
        return Boolean(sessionB);
      }, `session B created (attempt ${attempt})`, 8000).then(() => true).catch(() => false);
      if (grown) break;
    }
    if (!sessionB) throw new Error('session B creation retry exhausted');
    await UI.waitFor(() => UI.sessionRowExists(browser, sessionA.sessionId), 'session A row', 20000);
    await UI.waitFor(() => UI.sessionRowExists(browser, sessionB.sessionId), 'session B row', 20000);

    // Navigate (real sidebar click) back to A: the active session, dock closed.
    await UI.clickSessionRow(browser, sessionA.sessionId);
    await UI.waitFor(() => UI.frameEval(browser, `return doc.querySelector('[data-session="${sessionA.sessionId}"]') && doc.querySelector('[data-session="${sessionA.sessionId}"]').classList.contains('active');`), 'session A active', 20000);

    const dockClosedBaseline = await UI.dockSnapshot(browser);
    if (!(dockClosedBaseline.expanded === 'false' && dockClosedBaseline.dockHidden && dockClosedBaseline.tabCount === 0)) {
      throw new Error(`prerequisite failed: dock must start closed with no tabs, got ${JSON.stringify(dockClosedBaseline)}`);
    }

    // Passive update: seed B's knowledge in the module store, then navigate to
    // B with a real sidebar click. The terminal fetches the session knowledge
    // and publishes kb:knowledge; the product just caches it.
    env.seedSessionKnowledge(sessionB.sessionId, [
      { entryId: 'K-PASSIVE-B1', title: '被动刷新引用', text: 'DOCK-003 被动知识更新内容。', projectId: env.projectId },
    ]);
    const passiveStart = Date.now();
    await UI.clickSessionRow(browser, sessionB.sessionId);
    await UI.waitFor(() => UI.getLogs(browser).then(logs =>
      logs.productLog.some(entry => entry.t >= passiveStart && entry.type === 'kb:knowledge'
        && Array.isArray(entry.knowledgeRefs) && entry.knowledgeRefs.includes('K-PASSIVE-B1'))
    ), 'passive kb:knowledge published for session B', 30000);

    // The whole passive window must leave the dock collapsed and empty.
    await new Promise(resolve => setTimeout(resolve, 1500));
    const passiveDock = await UI.dockSnapshot(browser);
    const passiveLogs = await UI.getLogs(browser);
    const passiveWindow = {
      productEntries: passiveLogs.productLog.filter(entry => entry.t >= passiveStart),
      termEntries: passiveLogs.termLog.filter(entry => entry.t >= passiveStart),
    };
    evidence.steps.push({ step: 'passive-update', dock: passiveDock, kbKnowledge: passiveWindow.productEntries.filter(entry => entry.type === 'kb:knowledge') });

    // Only now does the user navigate: expand the dock and open the knowledge
    // tab through the real UI; the panel must receive the cached references.
    // The tab label appears before the host iframe loads, so delivery and ack
    // are awaited explicitly (same proven pattern as DOCK-002).
    await UI.clickDockToggle(browser);
    await UI.clickLauncherKnowledgeRow(browser);
    await UI.waitFor(() => UI.dockSnapshot(browser).then(snap => snap.tabs.some(tab => tab.label === '本次知识引用')), 'knowledge tab open by user navigation', 15000);
    let delivered = null;
    await UI.waitFor(() => UI.getLogs(browser).then(logs => {
      delivered = logs.termLog.find(entry =>
        entry.type === 'kb:panel/content' && Array.isArray(entry.contentRefs) && entry.contentRefs.includes('K-PASSIVE-B1')) || null;
      return Boolean(delivered);
    }), 'passively cached content delivered after user navigation', 20000);
    let acked = null;
    await UI.waitFor(() => UI.getLogs(browser).then(logs => {
      acked = logs.termLog.find(entry =>
        entry.type === 'kb:panel/content-ack' && entry.ok === true && entry.panelId === delivered.panelId) || null;
      return Boolean(acked);
    }), 'panel content ack after user navigation', 20000);
    const userNavLogs = await UI.getLogs(browser);
    evidence.steps.push({ step: 'user-navigation', dock: await UI.dockSnapshot(browser), delivered, acked: acked || null });

    const passivePanelOpens = passiveWindow.productEntries.filter(entry => entry.type === 'kb:panel/open').length;
    const passiveContent = passiveWindow.termEntries.filter(entry => entry.type === 'kb:panel/content').length;

    evidence.expectations.push({
      key: 'no-auto-open-on-passive-update',
      expect: 'Dock 关闭时知识缓存更新：不自动开标签、不展开 Dock、无面板消息',
      observed: JSON.stringify({
        dockAfterPassiveUpdate: { expanded: passiveDock.expanded, dockHidden: passiveDock.dockHidden, tabCount: passiveDock.tabCount, dockOpenClass: passiveDock.dockOpenClass },
        kbPanelOpenInPassiveWindow: passivePanelOpens,
        kbPanelContentInPassiveWindow: passiveContent,
        kbKnowledgeArrived: passiveWindow.productEntries.some(entry => entry.type === 'kb:knowledge' && (entry.knowledgeRefs || []).includes('K-PASSIVE-B1')),
      }),
      pass: passiveDock.expanded === 'false' && passiveDock.dockHidden === true && passiveDock.tabCount === 0
        && passivePanelOpens === 0 && passiveContent === 0
        && passiveWindow.productEntries.some(entry => entry.type === 'kb:knowledge' && (entry.knowledgeRefs || []).includes('K-PASSIVE-B1')),
    });
    evidence.expectations.push({
      key: 'only-user-navigation-opens',
      expect: '只有用户导航才打开：真实点击展开+选择知识面板后，被动缓存的内容才投递并确认',
      observed: JSON.stringify({
        userOpenedTab: true,
        deliveredRefs: delivered ? delivered.contentRefs : null,
        ackOk: Boolean(acked),
        deliveredAfterPassiveWindow: delivered ? delivered.t >= passiveStart : false,
      }),
      pass: Boolean(delivered && acked && delivered.t >= passiveStart),
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
    try { if (env) await env.cleanup(); } catch (error) { console.error('[dock003] cleanup error:', error.message); }
    const writer = UI.evidenceWriter(ARTIFACTS, 'dock003-evidence.json');
    evidence.file = writer.write(evidence);
    console.log(`[dock003] verdict=${evidence.verdict} evidence=${evidence.file}`);
    process.exitCode = evidence.verdict === 'PASS' ? 0 : 1;
  }
}

main().catch(error => { console.error('[dock003] fatal:', error); process.exitCode = 1; });
