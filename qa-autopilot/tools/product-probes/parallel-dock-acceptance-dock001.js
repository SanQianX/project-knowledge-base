#!/usr/bin/env node
'use strict';
// P-DOCK-ACCEPTANCE-01 / DOCK-001: 右上角显示隐藏控制循环。
//
// Real product page + real pinned terminal module + real Chrome. A real
// session is created through the terminal UI (lazy start: no model call),
// then the top-right dock toggle (#btn-dock-toggle) is clicked in a loop.
// Expectations (test-cases.json DOCK-001):
//   1. 不改变会话和任务 — session/task identity, module process and
//      listeners, and panel state are compared before/after (non-empty
//      session side; the empty task side is reported honestly, never used
//      as sole proof).
//   2. 按钮实际可点 — each click really flips aria-expanded and the dock
//      visibility together.
//   3. 缺实现先标需求差异 — if the button stays missing/hidden, record the
//      requirement gap instead of fabricating one.

const os = require('os');
const path = require('path');

const PKB_ROOT = path.resolve(__dirname, '..', '..', '..');
const UI = require(path.join(PKB_ROOT, '_site', '_test', 'helpers', 'parallel-dock-acceptance-ui.js'));
const { createDockAcceptanceEnv } = require(path.join(PKB_ROOT, '_site', '_test', 'helpers', 'parallel-dock-acceptance-env.js'));

const ARTIFACTS = path.join(PKB_ROOT, 'qa-autopilot', 'artifacts', 'parallel-20261023', 'dock-acceptance-r1');
const TOGGLES = 4;

function verdictOf(expectations) {
  return expectations.every(item => item.pass) ? 'PASS' : 'FAIL';
}

async function main() {
  const evidence = {
    schema: 'qa-autopilot/dock-acceptance-evidence/v1',
    case: 'DOCK-001',
    startedAt: new Date().toISOString(),
    toggles: [],
    dockSnapshots: [],
    expectations: [],
    firstFailure: null,
  };
  let env = null;
  let browser = null;
  try {
    env = await createDockAcceptanceEnv({ tag: 'dock001' });
    evidence.identity = { ...env.identity(), fileHashes: env.fileHashes() };
    evidence.env = {
      productUrl: env.productUrl, terminalUrl: env.terminalUrl,
      terminalProjectId: env.terminalProjectId, fixtureRoot: env.fixtureRoot,
    };
    console.log(`[dock001] product=${env.productUrl} terminal=${env.terminalUrl} pid(term)=${env.processes.terminal.pid}`);

    browser = await UI.launchCdpBrowser({
      chrome: UI.findChrome(),
      profileDir: path.join(os.tmpdir(), `pk-dock001-profile-${process.pid}`),
      url: env.productUrl, width: 1920, height: 1080,
    });
    await UI.installProductLog(browser);
    await UI.openWorkView(browser, env.productUrl);
    await UI.installTerminalLog(browser);

    // Panel registration evidence through the real handshake.
    await UI.waitFor(() => UI.getLogs(browser).then(logs =>
      logs.productLog.some(entry => entry.type === 'kb:ready') &&
      logs.productLog.some(entry => entry.type === 'kb:panel/registered' && entry.ok === true)
    ), 'kb:ready + panel registration', 30000);

    // Real session through the real UI (no model call: start is lazy).
    const before = (await env.termApi(`sessions?contextId=${env.terminalProjectId}`));
    const beforeCount = before.data && Array.isArray(before.data.sessions) ? before.data.sessions.length : 0;
    await UI.newSessionViaUi(browser);
    let sessionSummary = null;
    await UI.waitFor(async () => {
      const list = await env.termApi(`sessions?contextId=${env.terminalProjectId}`);
      const rows = list.data && Array.isArray(list.data.sessions) ? list.data.sessions : [];
      if (rows.length <= beforeCount) return false;
      sessionSummary = rows.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))[0];
      return true;
    }, 'session created via UI', 30000);
    const sessionId = sessionSummary.sessionId;
    await UI.waitFor(() => UI.sessionRowExists(browser, sessionId), 'session row visible', 20000);

    const loaded = await env.termApi(`sessions/${sessionId}`);
    const sessionEvents = Array.isArray(loaded.data && loaded.data.events) ? loaded.data.events : [];
    evidence.sessionBaseline = {
      sessionId,
      title: sessionSummary.title || null,
      agentId: sessionSummary.agentId || null,
      eventCount: sessionEvents.length,
      eventTypes: sessionEvents.map(event => event.type).slice(0, 10),
      sessionsBefore: beforeCount,
      sessionsAfter: beforeCount + 1,
    };
    if (!sessionId || sessionEvents.length === 0) throw new Error('non-empty session prerequisite failed: no session events');

    // The toggle button must become real and clickable once a session exists.
    let toggleVisible = true;
    try {
      await UI.waitFor(() => UI.dockSnapshot(browser).then(snap => snap && snap.toggleHidden === false), 'dock toggle button visible', 20000);
    } catch (error) {
      toggleVisible = false;
      evidence.requirementGap = {
        text: '右上角显示/隐藏按钮（#btn-dock-toggle）在有会话后仍未出现/保持 hidden，按用例要求先记录需求差异，不伪造按钮。',
        error: error.message,
      };
    }
    evidence.toggleVisible = toggleVisible;

    const baseline = await UI.dockSnapshot(browser);
    evidence.dockSnapshots.push({ step: 'baseline', snapshot: baseline });

    const baselineHealth = {
      terminal: await env.termApi('health'),
      sessions: ((await env.termApi(`sessions?contextId=${env.terminalProjectId}`)).data || {}).sessions || [],
      pid: env.processes.terminal.pid,
      exitCode: env.processes.terminal.exitCode,
    };

    if (toggleVisible) {
      for (let i = 1; i <= TOGGLES; i++) {
        await UI.clickDockToggle(browser);
        const expectedExpanded = i % 2 === 1;
        const snap = await UI.waitFor(
          () => UI.dockSnapshot(browser).then(value => (value.expanded === String(expectedExpanded) ? value : null)),
          `toggle ${i} -> expanded=${expectedExpanded}`, 10000
        );
        evidence.toggles.push({
          click: i,
          expectedExpanded,
          snapshot: {
            expanded: snap.expanded,
            dockHidden: snap.dockHidden,
            dockOpenClass: snap.dockOpenClass,
            toggleTitle: snap.toggleTitle,
            tabCount: snap.tabCount,
            tabs: snap.tabs,
          },
        });
      }
      const afterLogs = await UI.getLogs(browser);
      evidence.finalDockState = await UI.dockSnapshot(browser);
      evidence.messageCounts = {
        product: afterLogs.productLog.length,
        terminal: afterLogs.termLog.length,
        panelOpenRequests: afterLogs.productLog.filter(entry => entry.type === 'kb:panel/open').length,
      };
      evidence.productLog = afterLogs.productLog;
      evidence.termLog = afterLogs.termLog;
    }

    const afterLoaded = await env.termApi(`sessions/${sessionId}`);
    const afterEvents = Array.isArray(afterLoaded.data && afterLoaded.data.events) ? afterLoaded.data.events : [];
    const afterHealth = {
      terminal: await env.termApi('health'),
      sessions: ((await env.termApi(`sessions?contextId=${env.terminalProjectId}`)).data || {}).sessions || [],
      pid: env.processes.terminal.pid,
      exitCode: env.processes.terminal.exitCode,
    };

    const sessionIdsBefore = baselineHealth.sessions.map(row => row.sessionId).sort().join(',');
    const sessionIdsAfter = afterHealth.sessions.map(row => row.sessionId).sort().join(',');

    evidence.expectations.push({
      key: 'button-clickable',
      expect: '按钮实际可点：每次点击 aria-expanded 翻转且 #right-dock.hidden 同步变化',
      observed: toggleVisible
        ? evidence.toggles.map(item => `click${item.click}: expanded=${item.snapshot.expanded} dockHidden=${item.snapshot.dockHidden}`)
        : '按钮未出现（需求差异已记录）',
      pass: toggleVisible
        && evidence.toggles.length === TOGGLES
        && evidence.toggles.every(item => String(item.expectedExpanded) === item.snapshot.expanded && item.snapshot.dockHidden === !item.expectedExpanded),
    });
    evidence.expectations.push({
      key: 'no-session-task-change',
      expect: '循环切换不改变会话和任务：会话 id/事件数不变、会话列表不增减、模块进程与端口不变',
      observed: JSON.stringify({
        sessionIdSame: afterLoaded.data && afterLoaded.data.session && afterLoaded.data.session.sessionId === sessionId,
        eventCount: `${sessionEvents.length} -> ${afterEvents.length}`,
        sessionCount: `${baselineHealth.sessions.length} -> ${afterHealth.sessions.length}`,
        sessionIdsSame: sessionIdsBefore === sessionIdsAfter,
        modulePidSame: baselineHealth.pid === afterHealth.pid && afterHealth.exitCode === null,
        healthOk: baselineHealth.terminal.status === 200 && afterHealth.terminal.status === 200,
        taskSide: '任务列表始终为空（无原生任务/委派）；按合同不以空==空作为充分证明，充分性来自会话身份+事件+进程+面板状态',
      }),
      pass: Boolean(
        afterLoaded.data && afterLoaded.data.session && afterLoaded.data.session.sessionId === sessionId
        && sessionEvents.length === afterEvents.length
        && baselineHealth.sessions.length === afterHealth.sessions.length
        && sessionIdsBefore === sessionIdsAfter
        && baselineHealth.pid === afterHealth.pid && afterHealth.exitCode === null
        && baselineHealth.terminal.status === 200 && afterHealth.terminal.status === 200
      ),
    });
    if (toggleVisible) {
      evidence.expectations.push({
        key: 'panel-state-untouched',
        expect: '切换不触发面板打开或内容投递（无 kb:panel/open；知识面板注册保持 ok）',
        observed: JSON.stringify({
          panelOpenRequests: evidence.messageCounts.panelOpenRequests,
          registered: evidence.productLog.some(entry => entry.type === 'kb:panel/registered' && entry.ok === true),
        }),
        pass: evidence.messageCounts.panelOpenRequests === 0
          && evidence.productLog.some(entry => entry.type === 'kb:panel/registered' && entry.ok === true),
      });
    }

    evidence.consoleErrors = browser.consoleErrors.length;
    evidence.exceptions = browser.exceptions.length;
    if (browser.consoleErrors.length) evidence.consoleErrorSamples = browser.consoleErrors.slice(0, 5);
    if (browser.exceptions.length) evidence.exceptionSamples = browser.exceptions.slice(0, 5);
  } catch (error) {
    evidence.firstFailure = { message: error.message, stack: String(error.stack || '').split('\n').slice(0, 12) };
    try { if (browser) evidence.failureContext = await UI.failureContext(browser); } catch {}
  } finally {
    evidence.verdict = evidence.firstFailure ? 'FAIL' : verdictOf(evidence.expectations);
    if (!evidence.firstFailure && !evidence.expectations.length) evidence.verdict = 'FAIL';
    evidence.finishedAt = new Date().toISOString();
    try {
      if (browser) await browser.close();
    } catch {}
    try { if (env) await env.cleanup(); } catch (error) { console.error('[dock001] cleanup error:', error.message); }
    const writer = UI.evidenceWriter(ARTIFACTS, 'dock001-evidence.json');
    evidence.file = writer.write(evidence);
    console.log(`[dock001] verdict=${evidence.verdict} evidence=${evidence.file}`);
    process.exitCode = evidence.verdict === 'PASS' ? 0 : 1;
  }
}

main().catch(error => { console.error('[dock001] fatal:', error); process.exitCode = 1; });
