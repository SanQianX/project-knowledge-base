#!/usr/bin/env node
'use strict';
// P-DOCK-ISOLATION-R3 / DOCK-002 (+ DOCK-004 on the same fixture).
//
// DOCK-002 (标签生命周期) needs TWO panels that exist at the SAME time with
// their own panelIds, because the shipped knowledge provider is
// multiInstance:'single' and can therefore never be opened twice. This probe
// therefore uses the PUBLIC panel protocol of the real product host:
//
//   phase A - the product's OWN knowledge panel (opened through the real
//             dock UI) is closed and reopened; the OLD panelId is then
//             attacked with a real, legitimate kb:panel/content request and
//             must be refused by the workbench (UNKNOWN_PANEL).
//   phase B - a second SAME-ORIGIN panel surface is registered through the
//             public kb:panel/register protocol from the product host
//             window (the registry allows any host to register providers),
//             so the product's knowledge panel and the peer panel exist
//             simultaneously with distinct panelIds, distinct content and
//             distinct acks. Closing one leaves the other untouched; the
//             reopened one gets a NEW panelId and the old id stays dead.
//   phase C - corroboration with the MODULE'S OWN shipped panel host proof
//             page (apps/agent-terminal/panel-host-proof.html): a shipped
//             multiInstance provider opened twice through its real buttons.
//
// DOCK-004 (知识重新注册) reuses the same fixture: the embedded workbench
// iframe is really reloaded, the product re-registers its provider, the old
// panelId is refused and only the new panelId receives content + ack.
//
// No product source, module source or shared helper is modified: the probes
// only use the public panel protocol, the real UI and public read APIs.

const fs = require('fs');
const path = require('path');

const PKB_ROOT = path.resolve(__dirname, '..', '..', '..');
const UI = require(path.join(PKB_ROOT, '_site', '_test', 'helpers', 'parallel-dock-isolation-r3-ui.js'));
const { createDockIsolationEnv } = require(path.join(PKB_ROOT, '_site', '_test', 'helpers', 'parallel-dock-isolation-r3-env.js'));

const ARTIFACTS = process.env.PK_R3_ARTIFACTS
  || path.join(PKB_ROOT, 'qa-autopilot', 'artifacts', 'parallel-20261023', 'dock-isolation-r3');
const HANDOFF_FILE = process.env.PK_R3_HANDOFF || null;
const PRODUCT_PROVIDER = 'kb.knowledge.references';
const PEER_PROVIDER = 'kb.r3.knowledge.peer';
const KNOWLEDGE_TAB = '本次知识引用';
const PEER_TAB = 'R3 对照面板';
const TOTAL_BUDGET_MS = Number(process.env.R3_DOCK_BUDGET_MS || 15 * 60 * 1000);
const deadline = Date.now() + TOTAL_BUDGET_MS;

function budgetGuard(label) {
  if (Date.now() > deadline) throw new Error(`total probe budget exceeded before ${label}`);
}

function knowledgeContent(entryId, title, text, theme) {
  return {
    title: '本次知识引用', projectId: 'r3-fixture', projectName: 'Dock Acceptance Fixture',
    theme: theme || 'dark', status: 'ready',
    references: [{ entryId, title, text, source: 'dock-isolation-r3 / ' + entryId }],
  };
}

function peerContent(entryId, title, text) {
  return {
    title: PEER_TAB, projectId: 'r3-fixture', projectName: 'Dock Acceptance Fixture',
    theme: 'dark', status: 'ready',
    references: [{ entryId, title, text, source: 'dock-isolation-r3 / ' + entryId }],
  };
}

async function listSessions(env) {
  const response = await env.termApi(`sessions?contextId=${env.terminalProjectId}`);
  const data = response.data;
  return data && Array.isArray(data.sessions) ? data.sessions : [];
}

// The module process is owned by the launcher; the probe proves it is still
// the same, living instance through its own health endpoint.
async function moduleAlive(env) {
  try {
    const response = await env.moduleApi('health');
    return response.status === 200;
  } catch { return false; }
}

async function main() {
  const dock002 = {
    schema: 'qa-autopilot/dock-acceptance-evidence/v1',
    case: 'DOCK-002',
    startedAt: new Date().toISOString(),
    steps: [],
    expectations: [],
    firstFailure: null,
  };
  const dock004 = {
    schema: 'qa-autopilot/dock-acceptance-evidence/v1',
    case: 'DOCK-004',
    startedAt: new Date().toISOString(),
    steps: [],
    expectations: [],
    firstFailure: null,
  };
  let env = null;
  let browser = null;
  let proofBrowser = null;
  try {
    if (!HANDOFF_FILE) {
      throw new Error('this probe only runs through parallel-dock-isolation-r3-launch.js (PK_R3_HANDOFF missing): the isolated environment is the point of this lane');
    }
    const handoff = JSON.parse(fs.readFileSync(HANDOFF_FILE, 'utf8'));
    env = await createDockIsolationEnv({ tag: 'dock002-r3', handoff });
    dock002.identity = { ...env.identity(), fileHashes: env.fileHashes() };
    dock004.identity = dock002.identity;
    dock002.env = { productUrl: env.productUrl, terminalUrl: env.terminalUrl, terminalProjectId: env.terminalProjectId };
    dock002.isolation = {
      layoutRoot: env.layout.root,
      probeEnvKeys: Object.keys(process.env).sort(),
      productEnvKeys: env.productEnvKeys(),
      browserProfile: env.layout.browserProfile,
      proofBrowserProfile: path.join(env.layout.root, 'chrome-profile-proof'),
    };
    console.log(`[r3-dock002] product=${env.productUrl} terminal=${env.terminalUrl}`);

    // A purely fictional profile with a fake key, created through the
    // module's REAL ProfileStore. It needs no provider call at all.
    dock002.fictionalProfile = await env.seedFictionalProfile({});

    browser = await UI.launchCdpBrowser({
      chrome: env.chromePath,
      profileDir: env.layout.browserProfile,
      url: env.productUrl, width: 1920, height: 1080,
    });
    await UI.installProductLog(browser);
    await UI.openWorkView(browser, env.productUrl);
    await UI.installTerminalLog(browser);

    // A real session through the real UI (lazy start, no model call).
    const baselineIds = new Set((await listSessions(env)).map(row => row.sessionId));
    await UI.newSessionViaUi(browser);
    let session = null;
    await UI.waitFor(async () => {
      const rows = await listSessions(env);
      session = rows.find(row => !baselineIds.has(row.sessionId)) || null;
      return Boolean(session);
    }, 'session created', 30000);
    const sessionId = session.sessionId;
    await UI.waitFor(() => UI.sessionRowExists(browser, sessionId), 'session row', 20000);

    // Real knowledge for that session so the product's own panel has content.
    env.seedSessionKnowledge(sessionId, [{
      entryId: 'K-R3-PRODUCT-1', title: '产品知识引用', text: 'DOCK-002 产品面板真实内容。', projectId: env.projectId,
    }]);
    await UI.clickSessionRow(browser, sessionId);
    await UI.waitFor(() => UI.getLogs(browser).then(logs =>
      logs.productLog.some(entry => entry.type === 'kb:knowledge')
    ), 'product knowledge cache update', 30000);

    const baselineLoaded = await env.termApi(`sessions/${sessionId}`);
    const baselineEvents = (baselineLoaded.data && baselineLoaded.data.events) || [];
    const baselinePid = env.handoff.modulePid;
    const baselineSessionIds = (await listSessions(env)).map(row => row.sessionId).sort();

    // ---------- phase A: the product's own knowledge panel -------------
    budgetGuard('phase A');
    await UI.clickDockToggle(browser);
    await UI.clickLauncherKnowledgeRow(browser);
    await UI.waitFor(() => UI.dockSnapshot(browser).then(snap => snap.tabs.some(tab => tab.label === KNOWLEDGE_TAB)), 'knowledge tab open', 20000);
    let panelA = null;
    await UI.waitFor(() => UI.getLogs(browser).then(logs => {
      panelA = UI.knowledgePanelOf(logs.productLog, PRODUCT_PROVIDER);
      return panelA && panelA.panelId;
    }), 'knowledge panel state', 20000);
    const panelA1 = panelA.panelId;
    await UI.waitFor(() => UI.getLogs(browser).then(logs =>
      logs.termLog.some(entry => entry.type === 'kb:panel/content' && entry.panelId === panelA1)
      && logs.termLog.some(entry => entry.type === 'kb:panel/content-ack' && entry.panelId === panelA1 && entry.ok === true)
    ), 'product panel content + ack', 25000);
    dock002.steps.push({ step: 'A-open-product-panel', panelId: panelA1, snapshot: await UI.dockSnapshot(browser) });

    // Close it through the real dock tab close button.
    await UI.closeTabByLabel(browser, KNOWLEDGE_TAB);
    await UI.waitFor(() => UI.dockSnapshot(browser).then(snap => snap.hostFrames === 0), 'knowledge pane removed', 15000);
    await UI.waitFor(() => UI.getLogs(browser).then(logs => !UI.knowledgePanelOf(logs.productLog, PRODUCT_PROVIDER)),
      'panel state no longer lists the product panel', 15000);

    // The dead target must refuse a REAL, legitimate content request.
    const deadRequest = await UI.hostPanelRequest(browser, 'kb:panel/content', {
      panelId: panelA1, providerId: PRODUCT_PROVIDER, version: 901,
      content: knowledgeContent('K-R3-DEAD-1', '关闭后的旧面板输入', '关闭后发往旧 panelId 的合法输入。'),
    });
    dock002.steps.push({ step: 'A-old-panel-refused', request: 'kb:panel/content', panelId: panelA1, reply: deadRequest });

    // Reopen through the real UI: a NEW panelId with fresh content + ack.
    const snapshotAfterClose = await UI.dockSnapshot(browser);
    if (snapshotAfterClose.dockHidden || !(await UI.dockSnapshot(browser)).tabs.some(t => t.label === KNOWLEDGE_TAB)) {
      await UI.clickDockToggle(browser);
      await UI.clickLauncherKnowledgeRow(browser);
    } else {
      await UI.clickLauncherKnowledgeRow(browser);
    }
    let panelA2 = null;
    await UI.waitFor(() => UI.getLogs(browser).then(logs => {
      panelA2 = UI.knowledgePanelOf(logs.productLog, PRODUCT_PROVIDER);
      return panelA2 && panelA2.panelId && panelA2.panelId !== panelA1;
    }), 'reopened knowledge panel with a new panelId', 25000);
    const panelA2Id = panelA2.panelId;
    await UI.waitFor(() => UI.getLogs(browser).then(logs =>
      logs.termLog.some(entry => entry.type === 'kb:panel/content' && entry.panelId === panelA2Id)
      && logs.termLog.some(entry => entry.type === 'kb:panel/content-ack' && entry.panelId === panelA2Id && entry.ok === true)
    ), 'reopened panel content + ack', 25000);
    dock002.steps.push({ step: 'A-reopen-product-panel', panelId: panelA2Id, snapshot: await UI.dockSnapshot(browser) });

    // ---------- phase B: two panels alive at the same time --------------
    budgetGuard('phase B');
    const registered = await UI.hostPanelRequest(browser, 'kb:panel/register', {
      panel: {
        providerId: PEER_PROVIDER, panelType: 'knowledge', title: PEER_TAB,
        url: '/knowledge-panel.html', capabilities: ['read-only'],
        multiInstance: 'single', appliesTo: { projects: '*' },
      },
    });
    dock002.steps.push({ step: 'B-register-peer-provider', reply: registered });
    const openedPeer = await UI.hostPanelRequest(browser, 'kb:panel/open', { providerId: PEER_PROVIDER });
    const panelB1 = openedPeer.panelId;
    dock002.steps.push({ step: 'B-open-peer-panel', reply: openedPeer });

    // Both panels must exist simultaneously with their own ids.
    let simultaneous = null;
    await UI.waitFor(() => UI.getLogs(browser).then(logs => {
      const state = UI.latestPanelState(logs.productLog);
      if (!state || !Array.isArray(state.panels)) return false;
      const ids = state.panels.map(panel => panel.panelId);
      simultaneous = state.panels;
      return ids.includes(panelA2Id) && ids.includes(panelB1);
    }), 'two panels alive at the same time', 20000);

    // Distinct content per panel, each acknowledged by its own panel.
    const relayToProduct = await UI.hostPanelRequest(browser, 'kb:panel/content', {
      panelId: panelA2Id, providerId: PRODUCT_PROVIDER, version: 11,
      content: knowledgeContent('K-R3-PRODUCT-2', '产品面板内容', '产品面板与对照面板的内容不同。'),
    });
    const relayToPeer = await UI.hostPanelRequest(browser, 'kb:panel/content', {
      panelId: panelB1, providerId: PEER_PROVIDER, version: 22,
      content: peerContent('K-R3-PEER-1', '对照面板内容', '对照面板收到的是另一份内容。'),
    });
    await UI.waitFor(() => UI.getLogs(browser).then(logs =>
      logs.termLog.some(entry => entry.type === 'kb:panel/content-ack' && entry.panelId === panelA2Id && entry.version === 11 && entry.ok === true)
      && logs.termLog.some(entry => entry.type === 'kb:panel/content-ack' && entry.panelId === panelB1 && entry.version === 22 && entry.ok === true)
    ), 'per-panel acks', 20000);
    dock002.steps.push({
      step: 'B-two-panels', panelA2Id, panelB1, simultaneous,
      relayToProduct, relayToPeer,
    });

    // Switching the active panel must not cross content over.
    const versionsBeforeSwitch = await UI.getLogs(browser).then(logs => {
      const state = UI.latestPanelState(logs.productLog);
      return Object.fromEntries((state.panels || []).map(panel => [panel.panelId, panel.contentVersion]));
    });
    const activatePeer = await UI.hostPanelRequest(browser, 'kb:panel/activate', { panelId: panelB1 });
    await UI.waitFor(() => UI.getLogs(browser).then(logs => {
      const state = UI.latestPanelState(logs.productLog);
      const peer = (state.panels || []).find(panel => panel.panelId === panelB1);
      return peer && peer.active === true;
    }), 'peer panel active', 10000);
    const activateProduct = await UI.hostPanelRequest(browser, 'kb:panel/activate', { panelId: panelA2Id });
    await UI.waitFor(() => UI.getLogs(browser).then(logs => {
      const state = UI.latestPanelState(logs.productLog);
      const product = (state.panels || []).find(panel => panel.panelId === panelA2Id);
      return product && product.active === true;
    }), 'product panel active again', 10000);
    const versionsAfterSwitch = await UI.getLogs(browser).then(logs => {
      const state = UI.latestPanelState(logs.productLog);
      return Object.fromEntries((state.panels || []).map(panel => [panel.panelId, panel.contentVersion]));
    });
    dock002.steps.push({ step: 'B-switch', activatePeer, activateProduct, versionsBeforeSwitch, versionsAfterSwitch });

    // Close the peer panel through the real dock tab close button.
    await UI.closeTabByLabel(browser, PEER_TAB);
    await UI.waitFor(() => UI.dockSnapshot(browser).then(snap => snap.hostFrames === 1), 'peer pane removed, product pane kept', 15000);
    const deadPeerRequest = await UI.hostPanelRequest(browser, 'kb:panel/content', {
      panelId: panelB1, providerId: PEER_PROVIDER, version: 23,
      content: peerContent('K-R3-PEER-DEAD', '关闭后的旧对照输入', '关闭后发往旧 panelId 的合法输入。'),
    });
    const survivorRequest = await UI.hostPanelRequest(browser, 'kb:panel/content', {
      panelId: panelA2Id, providerId: PRODUCT_PROVIDER, version: 12,
      content: knowledgeContent('K-R3-PRODUCT-3', '幸存面板内容', '关闭对照面板后，产品面板仍然正常工作。'),
    });
    await UI.waitFor(() => UI.getLogs(browser).then(logs =>
      logs.termLog.some(entry => entry.type === 'kb:panel/content-ack' && entry.panelId === panelA2Id && entry.version === 12 && entry.ok === true)
    ), 'survivor panel ack after peer close', 15000);
    dock002.steps.push({ step: 'B-close-peer', deadPeerRequest, survivorRequest });

    // Reopen the closed panel: a NEW panelId; the old id stays dead.
    const reopenedPeer = await UI.hostPanelRequest(browser, 'kb:panel/open', { providerId: PEER_PROVIDER });
    const panelB2 = reopenedPeer.panelId;
    const oldIdStillDead = await UI.hostPanelRequest(browser, 'kb:panel/content', {
      panelId: panelB1, providerId: PEER_PROVIDER, version: 24,
      content: peerContent('K-R3-PEER-STALE', '旧 ID 输入', '重开后的新 panelId 不应接受旧 ID 的消息。'),
    });
    const relayToNewPeer = await UI.hostPanelRequest(browser, 'kb:panel/content', {
      panelId: panelB2, providerId: PEER_PROVIDER, version: 33,
      content: peerContent('K-R3-PEER-2', '新对照面板内容', '重开后的新 panelId 正常接收内容。'),
    });
    await UI.waitFor(() => UI.getLogs(browser).then(logs =>
      logs.termLog.some(entry => entry.type === 'kb:panel/content-ack' && entry.panelId === panelB2 && entry.version === 33 && entry.ok === true)
    ), 'new peer panel ack', 20000);
    dock002.steps.push({ step: 'B-reopen-peer', panelB2, oldIdStillDead, relayToNewPeer });

    // Main session must be untouched by every panel operation above.
    const finalLoaded = await env.termApi(`sessions/${sessionId}`);
    const finalEvents = (finalLoaded.data && finalLoaded.data.events) || [];
    const finalSessionIds = (await listSessions(env)).map(row => row.sessionId).sort();
    const sessionGuard = {
      sessionId,
      eventCount: `${baselineEvents.length} -> ${finalEvents.length}`,
      sessionIdsUnchanged: JSON.stringify(finalSessionIds) === JSON.stringify(baselineSessionIds),
      modulePidSame: baselinePid === env.handoff.modulePid && await moduleAlive(env),
    };
    dock002.sessionGuard = sessionGuard;

    // ---------- phase C: the module's own shipped proof host ------------
    budgetGuard('phase C');
    let phaseC = { attempted: true };
    try {
      proofBrowser = await UI.launchCdpBrowser({
        chrome: env.chromePath,
        profileDir: path.join(env.layout.root, 'chrome-profile-proof'),
        url: env.panelProofHostUrl(), width: 1600, height: 900,
      });
      await UI.openPanelProofHost(proofBrowser, env.panelProofHostUrl());
      await UI.clickProofButton(proofBrowser, 'btn-register');
      await UI.waitFor(() => UI.proofLogs(proofBrowser).then(logs =>
        logs.some(entry => entry.type === 'kb:panel/registered' && entry.ok === true)
      ), 'proof provider registered', 15000);
      await UI.clickProofButton(proofBrowser, 'btn-open-1');
      await UI.clickProofButton(proofBrowser, 'btn-open-2');
      let proofState = null;
      await UI.waitFor(() => UI.proofLogs(proofBrowser).then(logs => {
        const state = logs.filter(entry => entry.type === 'kb:panel/state').pop();
        if (!state || !Array.isArray(state.panels) || state.panels.length < 2) return false;
        proofState = state;
        return true;
      }), 'two shipped-provider panels alive', 20000);
      const proofIds = proofState.panels.map(panel => panel.panelId);
      const activateFirst = await UI.clickProofButton(proofBrowser, 'btn-activate-first');
      await UI.waitFor(() => UI.proofLogs(proofBrowser).then(logs => {
        const state = logs.filter(entry => entry.type === 'kb:panel/state').pop();
        const first = (state.panels || [])[0];
        return first && first.active === true;
      }), 'proof first panel active', 10000);
      await UI.clickProofButton(proofBrowser, 'btn-close-last');
      const closedId = proofIds[proofIds.length - 1];
      const deadProofRequest = await UI.proofHostRequest(proofBrowser, 'kb:panel/content', {
        panelId: closedId, providerId: 'kb.proof.knowledge', version: 44,
        content: { marker: 'r3-dead-proof' },
      });
      phaseC = {
        attempted: true,
        providerId: 'kb.proof.knowledge',
        panelIds: proofIds,
        simultaneous: proofState.panels,
        activateFirst,
        closedId,
        deadProofRequest,
        status: await UI.proofStatus(proofBrowser),
      };
    } catch (error) {
      phaseC = { attempted: true, error: error.message };
    }
    dock002.steps.push({ step: 'C-shipped-proof-host', ...phaseC });

    // ---------- DOCK-004: reload the workbench iframe -------------------
    budgetGuard('DOCK-004');
    const beforeReload = UI.knowledgePanelOf((await UI.getLogs(browser)).productLog, PRODUCT_PROVIDER);
    const oldPanelId = beforeReload ? beforeReload.panelId : null;
    // Anchor every post-reload wait to the reload itself: log entries older
    // than the reload belong to the previous app instance and must not be
    // accepted as evidence of the new handshake.
    const reloadStartedAt = Date.now();
    const reloadSrc = await UI.reloadWorkFrame(browser);
    await UI.waitFor(() => UI.getLogs(browser).then(logs =>
      logs.productLog.some(entry => entry.type === 'kb:ready' && entry.t >= reloadStartedAt)
    ), 'workbench kb:ready after reload', 60000);
    const registeredAfterReload = await UI.waitFor(() => UI.getLogs(browser).then(logs => {
      const entry = logs.productLog.filter(item =>
        item.type === 'kb:panel/registered' && item.ok === true && item.t >= reloadStartedAt).pop();
      return entry || null;
    }), 'provider re-registered after reload', 30000);
    dock004.steps.push({ step: 'reload', reloadSrc, oldPanelId, registeredAfterReload });

    // The old panelId belongs to the previous app instance: it must be refused.
    let oldIdRefused = null;
    if (oldPanelId) {
      oldIdRefused = await UI.hostPanelRequest(browser, 'kb:panel/content', {
        panelId: oldPanelId, providerId: PRODUCT_PROVIDER, version: 77,
        content: knowledgeContent('K-R3-RELOAD-OLD', '重载后的旧 panelId 输入', '重载后旧 panelId 必须被拒绝。'),
      });
    }
    dock004.steps.push({ step: 'old-panel-refused', oldPanelId, reply: oldIdRefused });

    // Only the NEW panelId receives content + ack.
    await UI.waitFor(() => UI.frameEval(browser, `return !!doc.getElementById('btn-new-session');`), 'terminal iframe reloaded', 60000);
    await UI.installTerminalLog(browser);
    await UI.clickDockToggle(browser);
    await UI.clickLauncherKnowledgeRow(browser);
    let newPanel = null;
    await UI.waitFor(() => UI.getLogs(browser).then(logs => {
      newPanel = UI.knowledgePanelOf(logs.productLog, PRODUCT_PROVIDER);
      return newPanel && newPanel.panelId && newPanel.panelId !== oldPanelId;
    }), 'new panelId after reload', 30000);
    const newPanelId = newPanel.panelId;
    await UI.waitFor(() => UI.getLogs(browser).then(logs =>
      logs.termLog.some(entry => entry.type === 'kb:panel/content' && entry.panelId === newPanelId)
      && logs.termLog.some(entry => entry.type === 'kb:panel/content-ack' && entry.panelId === newPanelId && entry.ok === true)
    ), 'new panel content + ack after reload', 30000);
    dock004.steps.push({ step: 'new-panel', panelId: newPanelId, snapshot: await UI.dockSnapshot(browser) });

    const finalAfterReload = await env.termApi(`sessions/${sessionId}`);
    const eventsAfterReload = (finalAfterReload.data && finalAfterReload.data.events) || [];
    dock004.sessionGuard = {
      sessionId,
      eventCount: `${baselineEvents.length} -> ${eventsAfterReload.length}`,
      modulePidSame: baselinePid === env.handoff.modulePid && await moduleAlive(env),
    };

    // ---------- expectations -------------------------------------------
    const productDeadRefused = deadRequest && deadRequest.ok === false && deadRequest.code === 'UNKNOWN_PANEL';
    dock002.expectations.push({
      key: 'state-per-panelid',
      expect: '两个同时存在的面板各自持有独立的 panelId、独立的投递版本与独立的 ack；切换不会把内容串到另一个面板；关闭 A 不影响 B；重开 A 得到新 panelId，旧 panelId 之后仍然被拒绝',
      observed: JSON.stringify({
        productPanelId: panelA2Id,
        peerPanelId: panelB1,
        reopenedPeerPanelId: panelB2,
        simultaneousPanels: simultaneous,
        relayToProduct: { ok: relayToProduct.ok, version: relayToProduct.version },
        relayToPeer: { ok: relayToPeer.ok, version: relayToPeer.version },
        versionsBeforeSwitch, versionsAfterSwitch,
        closedPeerReply: { ok: deadPeerRequest.ok, code: deadPeerRequest.code },
        survivorReply: { ok: survivorRequest.ok, version: survivorRequest.version },
        staleIdReply: { ok: oldIdStillDead.ok, code: oldIdStillDead.code },
        newPeerRelay: { ok: relayToNewPeer.ok, version: relayToNewPeer.version },
        shippedProofHost: phaseC,
      }),
      pass: Boolean(
        panelA2Id && panelB1 && panelB2
        && panelA2Id !== panelB1 && panelB2 !== panelB1 && panelB2 !== panelA2Id
        && simultaneous && simultaneous.length >= 2
        && relayToProduct.ok === true && relayToPeer.ok === true
        && versionsBeforeSwitch[panelA2Id] === versionsAfterSwitch[panelA2Id]
        && versionsBeforeSwitch[panelB1] === versionsAfterSwitch[panelB1]
        && deadPeerRequest.ok === false && deadPeerRequest.code === 'UNKNOWN_PANEL'
        && survivorRequest.ok === true
        && oldIdStillDead.ok === false && oldIdStillDead.code === 'UNKNOWN_PANEL'
        && relayToNewPeer.ok === true
      ),
    });
    dock002.expectations.push({
      key: 'close-releases-listeners',
      expect: '关闭释放监听器：面板关闭后，针对旧 panelId 的合法内容请求被工作台明确拒绝（UNKNOWN_PANEL），旧面板不再接收任何投递；剩余面板继续正常工作',
      observed: JSON.stringify({
        productPanelClosedRequest: { ok: deadRequest.ok, code: deadRequest.code, error: deadRequest.error },
        productPanelReopenedWithNewId: panelA2Id !== panelA1,
        peerClosedRequest: { ok: deadPeerRequest.ok, code: deadPeerRequest.code },
        survivorStillWorks: { ok: survivorRequest.ok, version: survivorRequest.version },
        hostFramesAfterPeerClose: 1,
      }),
      pass: Boolean(
        productDeadRefused
        && panelA2Id !== panelA1
        && deadPeerRequest.ok === false && deadPeerRequest.code === 'UNKNOWN_PANEL'
        && survivorRequest.ok === true
      ),
    });
    dock002.expectations.push({
      key: 'main-session-alive',
      expect: '不关闭主会话：面板生命周期操作前后，主会话 id、会话列表与模块进程不变',
      observed: JSON.stringify(sessionGuard),
      pass: Boolean(
        finalLoaded.data && finalLoaded.data.session && finalLoaded.data.session.sessionId === sessionId
        && sessionGuard.sessionIdsUnchanged
        && sessionGuard.modulePidSame
      ),
    });

    dock004.expectations.push({
      key: 're-register-after-reload',
      expect: '重载 Workbench iframe 后重新注册 panel/register 成功',
      observed: JSON.stringify({ registeredAfterReload, reloadSrc }),
      pass: Boolean(registeredAfterReload && registeredAfterReload.ok === true),
    });
    dock004.expectations.push({
      key: 'stale-panelid-rejected',
      expect: '旧 panelId 被拒绝：重载后旧 panelId 已经不存在，针对它的合法内容请求被工作台明确拒绝',
      observed: JSON.stringify({ oldPanelId, reply: oldIdRefused }),
      pass: Boolean(oldIdRefused && oldIdRefused.ok === false && oldIdRefused.code === 'UNKNOWN_PANEL'),
    });
    dock004.expectations.push({
      key: 'new-panelid-receives-content',
      expect: '新 panelId 正常接收内容：重载后重新打开知识面板获得新的 panelId，只有它收到内容投递与 ack',
      observed: JSON.stringify({ newPanelId, oldPanelId }),
      pass: Boolean(newPanelId && newPanelId !== oldPanelId),
    });

    dock002.consoleErrors = browser.consoleErrors.length;
    dock002.exceptions = browser.exceptions.length;
    if (browser.consoleErrors.length) dock002.consoleErrorSamples = browser.consoleErrors.slice(0, 5);
    dock004.consoleErrors = browser.consoleErrors.length;
    dock004.exceptions = browser.exceptions.length;
    if (browser.consoleErrors.length) dock004.consoleErrorSamples = browser.consoleErrors.slice(0, 5);
  } catch (error) {
    const failure = { message: error.message, stack: String(error.stack || '').split('\n').slice(0, 12) };
    dock002.firstFailure = failure;
    dock004.firstFailure = failure;
    try { if (browser) dock002.failureContext = await UI.failureContext(browser); } catch {}
  } finally {
    for (const item of [dock002, dock004]) {
      item.verdict = item.firstFailure ? 'FAIL' : (item.expectations.length && item.expectations.every(expectation => expectation.pass) ? 'PASS' : 'FAIL');
      item.finishedAt = new Date().toISOString();
    }
    try { if (proofBrowser) await proofBrowser.close(); } catch {}
    try { if (browser) await browser.close(); } catch {}
    try { if (env) await env.cleanup(); } catch (error) { console.error('[r3-dock002] cleanup error:', error.message); }
    UI.evidenceWriter(ARTIFACTS, 'dock002-evidence.json').write(dock002);
    UI.evidenceWriter(ARTIFACTS, 'dock004-evidence.json').write(dock004);
    console.log(`[r3-dock002] DOCK-002=${dock002.verdict} DOCK-004=${dock004.verdict}`);
    process.exitCode = (dock002.verdict === 'PASS' && dock004.verdict === 'PASS') ? 0 : 1;
  }
}

main().catch(error => { console.error('[r3-dock002] fatal:', error); process.exitCode = 1; });
