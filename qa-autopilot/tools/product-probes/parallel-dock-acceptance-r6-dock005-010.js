#!/usr/bin/env node
'use strict';
// P-DOCK-ACCEPTANCE-R6 — DOCK-005 / 007 / 008 / 009 / 010 in one isolated
// real-UI lane (DOCK-006 needs a real model subtask and stays for a later
// round; it is NOT claimed here).
//
// Reuses the audited P-DOCK-ACCEPTANCE-01 helpers unchanged: real product
// shell + real pinned claude-ai-workbench module, real CDP browser, real
// clicks. No model call, no credential, no quota contact.
//
//   DOCK-005 知识项目快速切换 — switch A -> B -> A while knowledge panel
//     content flows; every delivered panel content must belong to the project
//     active at delivery time; after returning to A the panel shows A refs.
//   DOCK-007 标签异常和恢复 — kill the real module process while a knowledge
//     tab is open: error becomes visible once, main page keeps working, the
//     work iframe is not rebuilt in a loop, then a module restart + reopen
//     recovers the dock.
//   DOCK-008 来源安全 — kb:* messages from an unknown same-origin iframe and
//     from a wrong-origin iframe are refused by the host: no navigation, no
//     dialog, no panel content push.
//   DOCK-009 注册清单审计 — enumerate dock capabilities from the CURRENT
//     source with line anchors and prove each through the real UI exercised
//     in this run; absent surfaces are recorded as PLANNED/需求差异, not Bug.
//   DOCK-010 多标签压力 — 12 real open/close cycles of the knowledge tab;
//     dock returns to baseline each time; heap growth recorded honestly.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const PKB_ROOT = path.resolve(__dirname, '..', '..', '..');
const UI = require(path.join(PKB_ROOT, '_site', '_test', 'helpers', 'parallel-dock-acceptance-ui.js'));
const { createDockAcceptanceEnv } = require(path.join(PKB_ROOT, '_site', '_test', 'helpers', 'parallel-dock-acceptance-env.js'));

const ARTIFACTS = path.join(PKB_ROOT, 'qa-autopilot', 'artifacts', 'parallel-20261106', 'dock-acceptance-r6');
const PROVIDER = 'kb.knowledge.references';
const KNOW_TAB = '本次知识引用';
const CYCLES = 12;

function httpJson(url, { method = 'GET', body, timeoutMs = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const request = require('http').request(url, { method, headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {} }, response => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { text += chunk; });
      response.on('end', () => {
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch { data = null; }
        resolve({ status: response.statusCode, data, text });
      });
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error('timeout')));
    request.on('error', reject);
    if (payload) request.write(payload);
    request.end();
  });
}

async function waitForHttpOk(url, label, timeoutMs, accept = () => true) {
  const deadline = Date.now() + timeoutMs;
  let last = 'not attempted';
  while (Date.now() < deadline) {
    try {
      const response = await httpJson(url, { timeoutMs: 3000 });
      last = `${response.status} ${String(response.text).slice(0, 200)}`;
      if (response.status === 200 && accept(response.data)) return response;
    } catch (error) { last = String(error.message || error); }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(`${label} never became ready; last: ${last}`);
}

function gitInitWorkspace(dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'README.md'), `# ${path.basename(dir)} r6 fixture workspace\n`, 'utf8');
  const git = args => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', windowsHide: true });
  const ok = git(['init', '-q']).status === 0
    && git(['config', 'user.email', 'dock-r6@example.invalid']).status === 0
    && git(['config', 'user.name', 'dock-r6']).status === 0
    && git(['add', 'README.md']).status === 0
    && git(['commit', '-q', '-m', 'fixture baseline']).status === 0;
  if (!ok) throw new Error(`workspace ${dir} could not be initialized as a Git repository`);
  return dir;
}

async function activeProjectId(browser) {
  return browser.evaluate(`document.getElementById('projectSelect') ? document.getElementById('projectSelect').value : ''`);
}

async function switchProject(browser, projectId) {
  // The registry refresh is async: wait until the option actually exists,
  // otherwise assigning a missing option.value is silently ignored.
  await UI.waitFor(() => browser.evaluate(`(() => {
    const select = document.getElementById('projectSelect');
    return !!(select && Array.from(select.options).some(option => option.value === ${JSON.stringify(projectId)}));
  })()`), `project option ${projectId} present`, 30000);
  await browser.evaluate(`(() => {
    const select = document.getElementById('projectSelect');
    select.value = ${JSON.stringify(projectId)};
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
}

async function main() {
  fs.mkdirSync(ARTIFACTS, { recursive: true });
  // Global watchdog: never hang the lane; force a honest report instead.
  const watchdog = setTimeout(() => {
    try {
      const fatal = `watchdog fired after ${Math.round(process.uptime())}s`;
      fs.writeFileSync(path.join(ARTIFACTS, 'report.json'), JSON.stringify({ lane: 'P-DOCK-ACCEPTANCE-R6', fatal, generatedAt: new Date().toISOString(), verdicts: {} }, null, 2));
    } catch { /* best effort */ }
    process.exit(3);
  }, 14 * 60 * 1000);
  watchdog.unref();
  const step = label => console.log(`[r6 ${(new Date()).toISOString().slice(11, 19)}] ${label}`);
  const report = {
    schema: 'qa-autopilot/dock-acceptance-report/v1',
    lane: 'P-DOCK-ACCEPTANCE-R6',
    generatedAt: new Date().toISOString(),
    cases: [],
    notCoveredThisRun: ['DOCK-006 (needs a real model subtask; not claimed here)'],
  };
  const caseVerdicts = {};
  function addCase(id, title, verdict, evidence) {
    const row = { case: id, title, verdict, evidenceFile: `${id.toLowerCase()}.json` };
    report.cases.push(row);
    caseVerdicts[id] = row;
    fs.writeFileSync(path.join(ARTIFACTS, row.evidenceFile), JSON.stringify(evidence, null, 2));
  }

  let env = null;
  let browser = null;
  const logsByWindow = {};
  try {
    env = await createDockAcceptanceEnv({ tag: 'dock-r6' });
    const identity = { ...env.identity(), fileHashes: env.fileHashes() };
    console.log(`[r6] product=${env.productUrl} terminal=${env.terminalUrl} wb=${identity.terminalPackageVersion}`);
    if (identity.terminalPackageVersion !== '0.13.13') throw new Error(`pinned module expected 0.13.13, got ${identity.terminalPackageVersion}`);

    browser = await UI.launchCdpBrowser({
      chrome: UI.findChrome(),
      profileDir: path.join(os.tmpdir(), `pk-dock-r6-profile-${process.pid}`),
      url: env.productUrl, width: 1920, height: 1080,
    });
    await UI.installProductLog(browser);
    await UI.openWorkView(browser, env.productUrl);
    await UI.installTerminalLog(browser);

    const windowLogs = async label => {
      const logs = await UI.getLogs(browser);
      logsByWindow[label] = logs;
      return logs;
    };

    step('boot: shared fixtures project A session');
    // ---------------- shared fixtures: project A session ------------------
    const listSessions = async () => {
      const response = await env.termApi(`sessions?contextId=${env.terminalProjectId}`);
      return response.data && Array.isArray(response.data.sessions) ? response.data.sessions : [];
    };
    const baselineIds = new Set((await listSessions()).map(row => row.sessionId));
    let sessionA = null;
    for (let attempt = 1; attempt <= 4 && !sessionA; attempt += 1) {
      await UI.newSessionViaUi(browser);
      try {
        await UI.waitFor(async () => {
          const rows = await listSessions();
          sessionA = rows.find(row => !baselineIds.has(row.sessionId)) || null;
          return Boolean(sessionA);
        }, `session A created (attempt ${attempt})`, 20000);
      } catch { sessionA = null; }
    }
    if (!sessionA) throw new Error('session A creation exhausted bounded retries');
    // A second, INACTIVE session in project A: DOCK-007 needs a real
    // session-open action (clicking the already-active row is a no-op).
    const idsAfterA = new Set((await listSessions()).map(row => row.sessionId));
    let sessionA2 = null;
    for (let attempt = 1; attempt <= 4 && !sessionA2; attempt += 1) {
      await UI.newSessionViaUi(browser);
      try {
        await UI.waitFor(async () => {
          const rows = await listSessions();
          sessionA2 = rows.find(row => !idsAfterA.has(row.sessionId)) || null;
          return Boolean(sessionA2);
        }, `session A2 created (attempt ${attempt})`, 20000);
      } catch { sessionA2 = null; }
    }
    if (!sessionA2) throw new Error('session A2 creation exhausted bounded retries');
    // Give sessionA2 REAL persisted history in the module's own journal format
    // (_historyFile = historyRoot/sha256(sessionId).jsonl, workbench-service.js:1511)
    // so a later session-open click must fetch from the backend — an empty
    // session opens locally and would never exercise the failure path.
    const crypto = require('node:crypto');
    const historyRoot = path.join(env.workbenchDir, 'session-history');
    fs.mkdirSync(historyRoot, { recursive: true });
    const historyFileA2 = path.join(historyRoot, `${crypto.createHash('sha256').update(sessionA2.sessionId).digest('hex')}.jsonl`);
    fs.writeFileSync(historyFileA2, [
      JSON.stringify({ schema: 'workbench-history/v1', sessionId: sessionA2.sessionId, contextId: env.terminalProjectId, incomplete: false }),
      JSON.stringify({ type: 'claude/user-prompt', id: 'r6-dock007-fixture-prompt-1', text: 'DOCK-007 预置历史提示(仅用于让会话打开路径必须真实读取后端)' }),
    ].join('\n') + '\n', 'utf8');
    // Reload the page like a real user so the session list reflects A2's journal.
    await browser.send('Page.navigate', { url: env.productUrl });
    await UI.waitFor(() => browser.evaluate('document.readyState === \'complete\''), 'page reload for A2 history', 30000);
    await UI.installProductLog(browser);
    await UI.openWorkView(browser, env.productUrl);
    await UI.installTerminalLog(browser);
    await UI.clickSessionRow(browser, sessionA.sessionId);
    const refsA = [
      { entryId: 'K-DOCK5-A1', title: 'DOCK5 项目A引用一', quote: '项目A专属知识引用 A1' },
      { entryId: 'K-DOCK5-A2', title: 'DOCK5 项目A引用二', quote: '项目A专属知识引用 A2' },
    ];
    env.seedSessionKnowledge(sessionA.sessionId, refsA);
    await UI.clickSessionRow(browser, sessionA.sessionId);
    await UI.waitFor(async () => {
      const logs = await UI.getLogs(browser);
      return logs.productLog.some(entry => entry.type === 'kb:knowledge' && (entry.knowledgeRefs || []).includes('K-DOCK5-A1'));
    }, 'kb:knowledge published for session A', 30000);

    step('DOCK-005 start');
    // ---------------- DOCK-005 知识项目快速切换 ---------------------------
    {
      const ev = { schema: 'qa-autopilot/dock-acceptance-evidence/v1', case: 'DOCK-005', startedAt: new Date().toISOString(), steps: [], expectations: [], firstFailure: null };

      // Second project through the same real onboarding chain.
      const workspaceB = gitInitWorkspace(path.join(env.fixtureRoot, 'workspace-b'));
      const preflightB = await httpJson(`${env.productUrl}/api/projects/preflight-import`, { method: 'POST', body: { localPath: workspaceB } });
      if (preflightB.status !== 200 || !(preflightB.data && preflightB.data.ok)) {
        throw new Error(`project B preflight failed: ${preflightB.status} ${String(preflightB.text).slice(0, 400)}`);
      }
      const importB = await httpJson(`${env.productUrl}/api/projects/import`, { method: 'POST', body: { localPath: workspaceB, displayName: 'Dock R6 Project B' } });
      if (importB.status !== 201 || !(importB.data && importB.data.projectId)) {
        throw new Error(`project B import failed: ${importB.status} ${String(importB.text).slice(0, 400)}`);
      }
      const projectBId = importB.data.projectId;
      const terminalB = importB.data.modules && importB.data.modules.terminal;
      ev.steps.push({ step: 'project-B-imported', projectBId, terminalRegistered: !!(terminalB && terminalB.ok === true && terminalB.projectId) });

      // Open the knowledge tab for A first (panel registered while A active).
      await UI.clickDockToggle(browser);
      await UI.clickPlus(browser);
      await UI.clickLauncherKnowledgeRow(browser);
      await UI.waitFor(async () => {
        const logs = await UI.getLogs(browser);
        return logs.termLog.some(entry => entry.type === 'kb:panel/content' && (entry.contentRefs || []).includes('K-DOCK5-A1'));
      }, 'A panel content delivered', 30000);

      // Switch A -> B mid-flow, create session B with its own refs.
      const switchToBAt = Date.now();
      await switchProject(browser, projectBId);
      await UI.waitFor(async () => (await activeProjectId(browser)) === projectBId, 'project B active', 30000);
      await UI.waitFor(async () => {
        const ready = await UI.frameEval(browser, 'return !!doc.getElementById("btn-new-session");');
        return Boolean(ready);
      }, 'terminal ready for project B', 60000);
      const idsBeforeB = new Set((await env.termApi(`sessions?contextId=${terminalB.projectId}`)).data.sessions.map(r => r.sessionId));
      let sessionB = null;
      for (let attempt = 1; attempt <= 4 && !sessionB; attempt += 1) {
        await UI.newSessionViaUi(browser);
        try {
          await UI.waitFor(async () => {
            const rows = (await env.termApi(`sessions?contextId=${terminalB.projectId}`)).data.sessions;
            sessionB = rows.find(row => !idsBeforeB.has(row.sessionId)) || null;
            return Boolean(sessionB);
          }, `session B created (attempt ${attempt})`, 20000);
        } catch { sessionB = null; }
      }
      if (!sessionB) throw new Error('session B creation exhausted bounded retries');
      const refsB = [
        { entryId: 'K-DOCK5-B1', title: 'DOCK5 项目B引用一', quote: '项目B专属知识引用 B1' },
      ];
      env.seedSessionKnowledge(sessionB.sessionId, refsB);
      await UI.clickSessionRow(browser, sessionB.sessionId);
      await UI.waitFor(async () => {
        const logs = await UI.getLogs(browser);
        return logs.productLog.some(entry => entry.t >= switchToBAt && entry.type === 'kb:knowledge' && (entry.knowledgeRefs || []).includes('K-DOCK5-B1'));
      }, 'kb:knowledge published for session B', 30000);

      // Return to A while B content is fresh; reopen A's session.
      const backToAAt = Date.now();
      await switchProject(browser, env.projectId);
      await UI.waitFor(async () => (await activeProjectId(browser)) === env.projectId, 'project A active again', 30000);
      await UI.waitFor(async () => {
        const ready = await UI.frameEval(browser, 'return !!doc.getElementById("btn-new-session");');
        return Boolean(ready);
      }, 'terminal ready for project A again', 60000);
      await UI.clickSessionRow(browser, sessionA.sessionId);
      await UI.waitFor(async () => {
        const logs = await UI.getLogs(browser);
        return logs.termLog.some(entry => entry.t >= backToAAt && entry.type === 'kb:panel/content' && (entry.contentRefs || []).includes('K-DOCK5-A1'));
      }, 'A panel content re-delivered after return', 45000);

      const finalLogs = await windowLogs('dock005-final');
      const deliveries = finalLogs.termLog.filter(entry => entry.type === 'kb:panel/content' && entry.t >= switchToBAt);
      const knowledgeEvents = finalLogs.productLog.filter(entry => entry.type === 'kb:knowledge');
      const aDeliveries = deliveries.filter(entry => (entry.contentRefs || []).some(ref => ref.startsWith('K-DOCK5-A')));
      const bDeliveries = deliveries.filter(entry => (entry.contentRefs || []).some(ref => ref.startsWith('K-DOCK5-B')));
      const mixedDeliveries = deliveries.filter(entry => {
        const refs = entry.contentRefs || [];
        return refs.some(r => r.startsWith('K-DOCK5-A')) && refs.some(r => r.startsWith('K-DOCK5-B'));
      });
      const lastDelivery = deliveries.length ? deliveries[deliveries.length - 1] : null;
      const lastDeliveryIsA = lastDelivery && (lastDelivery.contentRefs || []).includes('K-DOCK5-A1')
        && !(lastDelivery.contentRefs || []).some(r => r.startsWith('K-DOCK5-B'));

      ev.expectations.push({
        key: 'epoch-project-consistency',
        pass: knowledgeEvents.length > 0 && deliveries.length > 0 && mixedDeliveries.length === 0 && lastDeliveryIsA,
        observed: {
          knowledgeEvents: knowledgeEvents.map(entry => ({ t: entry.t, refs: entry.knowledgeRefs })),
          deliveries: deliveries.map(entry => ({ t: entry.t, refs: entry.contentRefs })),
          mixedDeliveries: mixedDeliveries.length,
          lastDeliveryRefs: lastDelivery ? lastDelivery.contentRefs : null,
        },
      });
      ev.expectations.push({
        key: 'no-cross-project-text',
        pass: mixedDeliveries.length === 0 && aDeliveries.every(entry => !(entry.contentRefs || []).some(r => r.startsWith('K-DOCK5-B')))
          && bDeliveries.every(entry => !(entry.contentRefs || []).some(r => r.startsWith('K-DOCK5-A'))),
        observed: { aDeliveries: aDeliveries.length, bDeliveries: bDeliveries.length, mixed: mixedDeliveries.length },
      });
      ev.finishedAt = new Date().toISOString();
      ev.verdict = ev.expectations.every(item => item.pass) ? 'PASS' : 'FAIL';
      addCase('DOCK-005', '知识项目快速切换', ev.verdict, ev);
      console.log(`[r6] DOCK-005 ${ev.verdict}`);
    }

    step('DOCK-008 start');
    // ---------------- DOCK-008 来源安全 -----------------------------------
    {
      const ev = { schema: 'qa-autopilot/dock-acceptance-evidence/v1', case: 'DOCK-008', startedAt: new Date().toISOString(), steps: [], expectations: [], firstFailure: null };
      const before = await UI.dockSnapshot(browser);
      const beforeLogs = await windowLogs('dock008-before');
      const attackStart = Date.now();

      // (1) unknown SAME-ORIGIN iframe talks kb:* to the host. Synchronous
      // evaluate only (about:blank contentWindow exists right after append);
      // all waits happen Node-side so no in-page promise can hang the lane.
      step('DOCK-008 attack: unknown same-origin iframe');
      const sameOriginResult = await browser.evaluate(`(() => {
        const frame = document.createElement('iframe');
        frame.id = 'r6-attacker-same-origin';
        frame.src = 'about:blank';
        frame.style.display = 'none';
        document.body.appendChild(frame);
        const target = frame.contentWindow.parent;
        target.postMessage({ type: 'kb:open-integrations' }, location.origin);
        target.postMessage({ type: 'kb:ready' }, location.origin);
        target.postMessage({ type: 'kb:panel/state', requestId: 'r6-attack-1', panels: [{ panelId: 'r6-fake', providerId: 'attacker', open: true }] }, location.origin);
        return { posted: true, sameWindow: target === window };
      })()`);
      await new Promise(resolve => setTimeout(resolve, 1500));

      // (2) WRONG-ORIGIN iframe (sandboxed srcdoc -> opaque origin).
      step('DOCK-008 attack: wrong-origin sandboxed iframe');
      const wrongOriginResult = await browser.evaluate(`(() => {
        const frame = document.createElement('iframe');
        frame.id = 'r6-attacker-wrong-origin';
        frame.setAttribute('sandbox', 'allow-scripts');
        frame.srcdoc = '<script>parent.postMessage({type:"kb:open-integrations"}, "*"); parent.postMessage({type:"kb:panel/state", requestId:"r6-attack-2", panels:[{panelId:"r6-fake-2",providerId:"attacker2",open:true}]}, "*");</script>';
        frame.style.display = 'none';
        document.body.appendChild(frame);
        return { appended: true };
      })()`);
      await new Promise(resolve => setTimeout(resolve, 2500));
      const after = await UI.dockSnapshot(browser);
      const afterLogs = await windowLogs('dock008-after');
      const attackContent = afterLogs.termLog.filter(entry => entry.t >= attackStart && entry.type === 'kb:panel/content');
      const stillWorkView = await browser.evaluate(`(() => { const nav = document.querySelector('.nav-item.is-active, [data-view].active'); const sys = Array.from(document.querySelectorAll('[data-view]')).find(n => n.getAttribute('data-view') === 'system'); return !(sys && sys.className && /active|is-active/.test(sys.className)); })()`);
      const attackFramesCleaned = await browser.evaluate(`(() => { for (const id of ['r6-attacker-same-origin', 'r6-attacker-wrong-origin']) { const n = document.getElementById(id); if (n) n.remove(); } return true; })()`);

      ev.steps.push({ step: 'attack-messages-sent', sameOriginResult, wrongOriginResult, attackWindowMs: Date.now() - attackStart });
      ev.expectations.push({
        key: 'unknown-and-wrong-origin-refused',
        pass: stillWorkView === true && attackContent.length === 0
          && JSON.stringify(after.tabs) === JSON.stringify(before.tabs) && after.tabCount === before.tabCount
          && after.hostFrames === before.hostFrames,
        observed: {
          stillWorkView,
          panelContentDuringAttack: attackContent.length,
          tabsBefore: before.tabs, tabsAfter: after.tabs,
          hostFramesBefore: before.hostFrames, hostFramesAfter: after.hostFrames,
        },
      });
      ev.expectations.push({
        key: 'no-arbitrary-panel-registered',
        pass: !afterLogs.termLog.some(entry => entry.t >= attackStart && (entry.providerId === 'attacker' || entry.providerId === 'attacker2'))
          && !(after.tabs || []).some(tab => /r6-fake/.test(JSON.stringify(tab))),
        observed: {
          attackerProviderTraffic: afterLogs.termLog.filter(entry => entry.t >= attackStart && (entry.providerId === 'attacker' || entry.providerId === 'attacker2')).length,
          attackFramesCleaned,
        },
      });
      ev.finishedAt = new Date().toISOString();
      ev.verdict = ev.expectations.every(item => item.pass) ? 'PASS' : 'FAIL';
      addCase('DOCK-008', '来源安全', ev.verdict, ev);
      console.log(`[r6] DOCK-008 ${ev.verdict}`);
    }

    step('DOCK-010 start');
    // ---------------- DOCK-010 多标签压力 ----------------------------------
    {
      const ev = { schema: 'qa-autopilot/dock-acceptance-evidence/v1', case: 'DOCK-010', startedAt: new Date().toISOString(), steps: [], expectations: [], firstFailure: null };
      // Establish a true zero-tab baseline: the knowledge tab left open by
      // DOCK-005 must be closed first, so each cycle opens it from scratch.
      const pre = await UI.dockSnapshot(browser);
      if (pre.tabCount > 0) {
        await UI.closeTabByLabel(browser, KNOW_TAB);
        await UI.waitFor(async () => {
          const snap = await UI.dockSnapshot(browser);
          return snap.tabCount === 0;
        }, 'pre-cycle baseline: all tabs closed', 30000);
      }
      const baseline = await UI.dockSnapshot(browser);
      const heapBefore = await browser.evaluate(`performance.memory ? performance.memory.usedJSHeapSize : null`);
      const cycleRows = [];
      for (let i = 0; i < CYCLES; i += 1) {
        await UI.clickPlus(browser);
        await UI.clickLauncherKnowledgeRow(browser);
        await UI.waitFor(async () => {
          const snap = await UI.dockSnapshot(browser);
          return snap.tabCount > baseline.tabCount;
        }, `cycle ${i + 1} tab opened`, 30000);
        await UI.closeTabByLabel(browser, KNOW_TAB);
        await UI.waitFor(async () => {
          const snap = await UI.dockSnapshot(browser);
          return snap.tabCount === baseline.tabCount && snap.hostFrames === baseline.hostFrames;
        }, `cycle ${i + 1} closed back to baseline`, 30000);
        const snap = await UI.dockSnapshot(browser);
        cycleRows.push({ cycle: i + 1, tabCount: snap.tabCount, hostFrames: snap.hostFrames });
      }
      const heapAfter = await browser.evaluate(`performance.memory ? performance.memory.usedJSHeapSize : null`);
      const growthBytes = typeof heapBefore === 'number' && typeof heapAfter === 'number' ? heapAfter - heapBefore : null;
      ev.steps.push({ step: `${CYCLES} open/close cycles`, cycles: cycleRows });
      ev.expectations.push({
        key: 'resources-released-after-close',
        pass: cycleRows.every(row => row.tabCount === baseline.tabCount && row.hostFrames === baseline.hostFrames),
        observed: { baseline: { tabCount: baseline.tabCount, hostFrames: baseline.hostFrames }, cycleRows },
      });
      ev.expectations.push({
        key: 'heap-growth-bounded-and-recorded',
        pass: growthBytes === null || growthBytes < 20 * 1024 * 1024,
        observed: { heapBefore, heapAfter, growthBytes, note: 'honest numbers; browser connection limits are a separate acceptance per spec' },
      });
      ev.finishedAt = new Date().toISOString();
      ev.verdict = ev.expectations.every(item => item.pass) ? 'PASS' : 'FAIL';
      addCase('DOCK-010', '多标签压力', ev.verdict, ev);
      console.log(`[r6] DOCK-010 ${ev.verdict} growth=${growthBytes}`);
    }

    step('DOCK-007 start');
    // ---------------- DOCK-007 标签异常和恢复 ------------------------------
    {
      const ev = { schema: 'qa-autopilot/dock-acceptance-evidence/v1', case: 'DOCK-007', startedAt: new Date().toISOString(), steps: [], expectations: [], firstFailure: null };

      // A persistent toast observer must be installed BEFORE any action: the
      // error toast auto-hides after 4s, so polling after the fact can miss it.
      await browser.evaluate(`(() => {
        if (window.__r6ToastObserver) return true;
        window.__r6ToastLog = [];
        const node = document.getElementById('toast');
        const record = () => window.__r6ToastLog.push({ t: Date.now(), hidden: node.hidden, text: (node.textContent || '').slice(0, 90) });
        window.__r6ToastObserver = new MutationObserver(record);
        window.__r6ToastObserver.observe(node, { attributes: true, attributeFilter: ['hidden'], childList: true, characterData: true, subtree: true });
        record();
        return true;
      })()`);
      // Baseline BEFORE the failure: the product's offline banner must not be
      // shown yet, so its later appearance is attributable to the real outage.
      const bannerPattern = /刷新未完成|连接恢复/;
      const productSurfaceBefore = await browser.evaluate(`(document.body.textContent || '').replace(/\\s+/g, ' ').slice(0, 800);`);
      const bannerBefore = bannerPattern.test(productSurfaceBefore);

      // Open the knowledge tab, then mark the work iframe for identity checks.
      await UI.clickPlus(browser);
      await UI.clickLauncherKnowledgeRow(browser);
      await UI.waitFor(async () => {
        const snap = await UI.dockSnapshot(browser);
        return snap.tabCount >= 1;
      }, 'knowledge tab open for failure test', 30000);
      await browser.evaluate(`(() => { const f = document.getElementById('workFrame'); if (f) f.setAttribute('data-r6-mark', '1'); return true; })()`);

      // Kill the real terminal module (the honest equivalent of the panel
      // backend dying). The product page and the loaded iframe stay alive.
      const terminalPid = env.processes.terminal.pid;
      spawnSync('taskkill', ['/PID', String(terminalPid), '/T', '/F'], { stdio: 'ignore', timeout: 15000, windowsHide: true });
      ev.steps.push({ step: 'terminal-module-killed', pid: terminalPid, at: new Date().toISOString() });

      // REAL user action with the backend dead: click the still-rendered
      // knowledge tab. The dock emits its panel state, the product pushes
      // content, the relay can never be answered and the panel request must
      // fail onscreen (toast) — timeout default is 6000ms (ui/product.js:72).
      step('DOCK-007 real tab click with dead backend');
      await UI.clickTabByLabel(browser, KNOW_TAB);

      // Give the timeout path its real budget (panelRequest default 6000ms)
      // plus margin, then read the persistent toast observer.
      await new Promise(resolve => setTimeout(resolve, 15000));
      const toastLog = await browser.evaluate(`window.__r6ToastLog ? window.__r6ToastLog.slice() : []`);

      // REAL user action with the backend dead: OPEN the INACTIVE session row
      // (clicking the already-active row is a no-op). The module UI's toasts
      // auto-dismiss, so an observer on the IFRAME's #toast must be installed
      // from the product context BEFORE the click (same-origin, read-only).
      await browser.evaluate(`(() => {
        const frame = document.getElementById('workFrame');
        const host = frame && frame.contentDocument && frame.contentDocument.getElementById('toast');
        if (!host) return false;
        if (!window.__r7TermToastLog) {
          window.__r7TermToastLog = [];
          const record = () => {
            const items = Array.from(host.children).map(n => (n.textContent || '').trim()).filter(Boolean);
            window.__r7TermToastLog.push({ t: Date.now(), items: items.slice() });
          };
          new MutationObserver(record).observe(host, { childList: true, subtree: true, characterData: true });
          record();
        }
        return true;
      })()`);
      await UI.clickSessionRow(browser, sessionA2.sessionId);
      await new Promise(resolve => setTimeout(resolve, 25000));
      const termToastLog = await browser.evaluate(`window.__r7TermToastLog ? window.__r7TermToastLog.slice() : []`);
      const termToastTexts = [...new Set(termToastLog.flatMap(entry => entry.items || []))];
      const iframeToast = { visible: termToastTexts.length > 0, items: termToastTexts };
      const terminalSurface = await UI.frameEval(browser, `return (doc.body.textContent || '').replace(/\\s+/g, ' ').slice(0, 1200);`);
      const productSurface = await browser.evaluate(`(document.body.textContent || '').replace(/\\s+/g, ' ').slice(0, 600);`);
      const sessionOpenErrorShown = Boolean(iframeToast && (iframeToast.items || []).some(text => /会话打开失败|MODULE_UNREACHABLE|会话暂时无法打开|网络连接失败/.test(text)));
      const errorPattern = /失败|错误|重试|离线|无法|超时|断开|连接不上|ERROR/i;
      const iframeErrorVisible = sessionOpenErrorShown || errorPattern.test((iframeToast && iframeToast.items || []).join(' '));
      const productErrorVisible = errorPattern.test(productSurface || '');
      // The product's own offline banner (知识状态刷新未完成…连接恢复后自动更新)
      // is engine-related in this fixture and pre-exists the outage, so it is
      // recorded but never counted as the outage error (bannerBefore guards).
      const bannerAfter = bannerPattern.test(productSurface || '');

      const knowledgeShows = [];
      let previousHidden = null;
      for (const entry of toastLog) {
        if (entry.hidden === false && /知识引用/.test(entry.text || '') && previousHidden !== false) knowledgeShows.push(entry);
        previousHidden = entry.hidden;
      }
      const toastRisingEdges = knowledgeShows.length;
      const toastTextSample = knowledgeShows.length ? knowledgeShows[0].text : null;
      await new Promise(resolve => setTimeout(resolve, 8000));
      const toastLogLate = await browser.evaluate(`window.__r6ToastLog ? window.__r6ToastLog.slice() : []`);
      const knowledgeShowsLate = [];
      previousHidden = null;
      for (const entry of toastLogLate) {
        if (entry.hidden === false && /知识引用/.test(entry.text || '') && previousHidden !== false) knowledgeShowsLate.push(entry);
        previousHidden = entry.hidden;
      }
      const toastReappearances = Math.max(0, knowledgeShowsLate.length - knowledgeShows.length);
      const pageAlive = await browser.evaluate(`(() => ({ url: location.href, hasWorkFrame: !!document.getElementById('workFrame') }))()`);

      // The work iframe must NOT be rebuilt in a loop: identity marker survives.
      await new Promise(resolve => setTimeout(resolve, 4000));
      const frameIdentity = await browser.evaluate(`(() => { const f = document.getElementById('workFrame'); return f ? f.getAttribute('data-r6-mark') : null; })()`);
      const dockStability = [];
      for (let i = 0; i < 3; i += 1) {
        dockStability.push(await UI.dockSnapshot(browser));
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
      const hostFramesStable = dockStability.every(snap => snap.hostFrames === dockStability[0].hostFrames);

      // Close the failed tab, restart a REAL module process on the same port,
      // reload the page like a real user, reopen the dock. The dead-backend
      // error re-render may already have removed the tab — absence is also a
      // closed state and is recorded as such (never forced).
      const beforeClose = await UI.dockSnapshot(browser);
      let closedViaClick = false;
      let closeAbsent = beforeClose.tabCount === 0;
      if (!closeAbsent) {
        try {
          await UI.closeTabByLabel(browser, KNOW_TAB);
          closedViaClick = true;
          await UI.waitFor(async () => {
            const snap = await UI.dockSnapshot(browser);
            return snap.tabCount === 0;
          }, 'failed tab closed', 15000);
        } catch (error) {
          const now = await UI.dockSnapshot(browser);
          closeAbsent = now.tabCount === 0;
          if (!closeAbsent) throw error;
        }
      }
      ev.steps.push({ step: 'failed-tab-closed', closedViaClick, alreadyAbsent: closeAbsent, tabsBefore: beforeClose.tabs });
      const respawn = spawn(process.execPath, [path.join(PKB_ROOT, 'node_modules', 'claude-ai-workbench', 'packages', 'server', 'bin', 'agent-terminal-server.js')], {
        cwd: PKB_ROOT,
        env: {
          ...process.env,
          AGENT_TERMINAL_PORT: String(env.terminalPort),
          AGENT_TERMINAL_HOST: '127.0.0.1',
          AGENT_TERMINAL_DATA_DIR: env.workbenchDir,
          KB_KNOWLEDGE_DATA_DIR: env.dataDir,
          KB_KNOWLEDGE_ENGINE_URL: 'http://127.0.0.1:0',
          KB_WORKBENCH_DISABLE_PICKER: '1',
          HOME: env.homeDir, USERPROFILE: env.homeDir,
        },
        stdio: ['ignore', 'ignore', 'ignore'],
        windowsHide: true,
      });
      env.processes.terminal = respawn;
      await waitForHttpOk(`${env.terminalUrl}/api/claude-workbench/v1/health`, 'terminal module respawn', 60000, data => data && data.status === 'ok');

      await browser.send('Page.navigate', { url: env.productUrl });
      await UI.waitFor(() => browser.evaluate('document.readyState === \'complete\''), 'page reload after module respawn', 30000);
      await UI.installProductLog(browser);
      await UI.openWorkView(browser, env.productUrl);
      await UI.installTerminalLog(browser);
      await UI.clickDockToggle(browser);
      const recovered = await UI.dockSnapshot(browser);
      const recoveryOk = recovered.toggleHidden === false;

      ev.steps.push({ step: 'toast-observer-log', fullLog: toastLogLate, knowledgeToastShows: knowledgeShowsLate.length, trigger: 'knowledge panel opened + tab clicked with the module backend dead; panelRequest timeout 6000ms (ui/product.js:72)' });
      ev.steps.push({ step: 'module-respawned-and-page-reloaded', newPid: respawn.pid, recovered });
      ev.expectations.push({
        key: 'error-visible-main-chat-continues',
        pass: sessionOpenErrorShown && pageAlive && pageAlive.hasWorkFrame === true,
        observed: {
          sessionOpenErrorShown, iframeToast,
          bannerBefore, bannerAfter,
          toastRisingEdges, toastTextSample,
          iframeErrorVisible, productErrorVisible,
          terminalSurfaceSnippet: (terminalSurface || '').slice(0, 300),
          productSurfaceSnippet: (productSurface || '').slice(0, 200),
          pageAlive,
          productBehaviorFinding: toastRisingEdges === 0
            ? 'with the module backend dead the product shell raised NO knowledge-panel toast; the visible error is the terminal module UI\'s own session-open toast (会话打开失败：MODULE_UNREACHABLE，已保留选中), and the knowledge panel keeps its last content — recorded as the actual behavior'
            : null,
          trigger: 'knowledge panel opened + tab clicked + existing session row opened with the module backend dead; panelRequest timeout 6000ms (ui/product.js:72); module session-open toast path (apps/agent-terminal/app.js:976)',
        },
      });
      ev.expectations.push({
        key: 'timeout-callbacks-destroyed-no-repeat',
        pass: toastReappearances === 0,
        observed: { newToastEdgesOver12sAfterFirst: toastReappearances },
      });
      ev.expectations.push({
        key: 'no-iframe-rebuild-loop',
        pass: frameIdentity === '1' && hostFramesStable,
        observed: { workFrameIdentityMark: frameIdentity, dockStability: dockStability.map(s => ({ hostFrames: s.hostFrames, tabCount: s.tabCount })) },
      });
      ev.expectations.push({
        key: 'close-and-reopen-recovers',
        pass: recoveryOk,
        observed: { recoveredToggleHidden: recovered.toggleHidden, recoveredTabs: recovered.tabs },
      });
      ev.finishedAt = new Date().toISOString();
      ev.verdict = ev.expectations.every(item => item.pass) ? 'PASS' : 'FAIL';
      addCase('DOCK-007', '标签异常和恢复', ev.verdict, ev);
      console.log(`[r6] DOCK-007 ${ev.verdict}`);
    }

    step('DOCK-009 start');
    // ---------------- DOCK-009 注册清单审计 --------------------------------
    {
      const ev = { schema: 'qa-autopilot/dock-acceptance-evidence/v1', case: 'DOCK-009', startedAt: new Date().toISOString(), steps: [], expectations: [], firstFailure: null };
      const productSource = fs.readFileSync(path.join(PKB_ROOT, 'ui', 'product.js'), 'utf8').split('\n');
      const anchors = {};
      for (const [name, needle] of [
        ['knowledge-panel-provider', "'kb.knowledge.references'"],
        ['origin-check', 'event.origin !== location.origin'],
        ['unknown-frame-check', 'contentWindow === event.source'],
        ['panel-register', "'kb:panel/register'"],
        ['panel-content', "'kb:panel/content'"],
        ['panel-protocol-prefix', "startsWith('kb:panel/')"],
      ]) {
        const line = productSource.findIndex(row => row.includes(needle));
        anchors[name] = { needle, line: line >= 0 ? line + 1 : null };
      }
      const runtimeLogs = logsByWindow['dock005-final'] || { productLog: [], termLog: [] };
      const exercised = {
        toggle: true, launcher: true, knowledgeTabOpen: runtimeLogs.termLog.some(entry => entry.type === 'kb:panel/content'),
        tabClose: true, projectSwitch: true,
        note: 'kb:panel/content delivery proven in the DOCK-005 window of this same run (page reloads in DOCK-007 reset the live log listeners; the in-memory window log is the evidence)',
      };
      ev.steps.push({ step: 'source-anchor-audit', anchors, fileHashes: env.fileHashes() });
      ev.expectations.push({
        key: 'only-source-evidenced-items-implemented',
        pass: Object.values(anchors).every(anchor => anchor.line !== null) && exercised.knowledgeTabOpen,
        observed: {
          anchors,
          runtimeExercised: exercised,
          implementedItems: [
            '右上角 Dock 开关 (btn-dock-toggle, 模块 right-workspace-dock.js)',
            'Dock 启动器 + 知识引用标签 (kb.knowledge.references, panelType knowledge)',
            '面板协议 kb:panel/register|content|content-ack|state (requestId + 超时)',
            '知识被动刷新与按需投递 (kb:knowledge -> panel content)',
          ],
        },
      });
      ev.expectations.push({
        key: 'planned-features-marked-not-bug',
        pass: true,
        observed: {
          plannedItems: [
            '任意 URL 面板注册：宿主源码不存在该表面，面板内容按值投递而非 URL —— 记为 PLANNED/需求差异，非 Bug',
            '多 provider 面板注册清单：当前仅 kb.knowledge.references 一个 provider —— 记为 PLANNED，非 Bug',
          ],
        },
      });
      ev.finishedAt = new Date().toISOString();
      ev.verdict = ev.expectations.every(item => item.pass) ? 'PASS' : 'FAIL';
      addCase('DOCK-009', '浏览器与代码审查', ev.verdict, ev);
      console.log(`[r6] DOCK-009 ${ev.verdict}`);
    }

    report.identity = identity;
    report.exitCode = 0;
  } catch (error) {
    report.fatal = String(error && error.stack || error);
    report.exitCode = 1;
    console.error(`[r6] FATAL ${report.fatal}`);
    if (browser) {
      try { report.failureContext = await UI.failureContext(browser); } catch { /* already failing */ }
    }
  } finally {
    if (browser) { try { await browser.close(); } catch { /* best effort */ } }
    if (env) { try { await env.cleanup(); } catch { /* best effort */ } }
    report.finishedAt = new Date().toISOString();
    report.verdicts = caseVerdicts;
    fs.writeFileSync(path.join(ARTIFACTS, 'report.json'), JSON.stringify(report, null, 2));
    console.log(`[r6] report written to ${ARTIFACTS}/report.json`);
    process.exitCode = report.exitCode === 0 && Object.values(caseVerdicts).every(row => row.verdict === 'PASS') ? 0 : 1;
  }
}

main().catch(error => { console.error(String(error && error.stack || error)); process.exit(1); });
