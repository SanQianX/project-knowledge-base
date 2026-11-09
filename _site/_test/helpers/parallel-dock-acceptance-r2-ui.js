// _site/_test/helpers/parallel-dock-acceptance-r2-ui.js
//
// Lane-exclusive real-UI driver for P-DOCK-ACCEPTANCE-02. Derived from the
// R1 helper (parallel-dock-acceptance-ui.js, read-only reference).
//
// All interactions happen in a REAL browser against REAL pages:
//   - the product page (pkb) with the real workbench iframe inside it,
//   - the workbench module's own shipped panel host proof page, loaded from
//     the same isolated module, used as a real host for the
//     two-simultaneous-panel case.
// Observation is additive only: extra window message listeners that record
// kb:* traffic, plus real DOM reads. Nothing in the product or the module is
// wrapped, replaced or removed.

'use strict';

const fs = require('fs');
const path = require('path');

const { launchCdpBrowser, waitFor } = require('./cdp-browser');
const { findChrome } = require('./find-chrome');

// Records every kb:* message that crosses a window boundary, including the
// requestId, so a host-issued protocol request can be matched with its
// reply. Additive: it never intercepts or rewrites a message.
const LISTENER = (slot) => `(() => {
  if (window.${slot}) return true;
  window.${slot} = [];
  window.addEventListener('message', ev => {
    const data = ev.data;
    if (!data || typeof data.type !== 'string' || !data.type.startsWith('kb:')) return;
    window.${slot}.push({
      t: Date.now(), type: data.type,
      requestId: data.requestId || null,
      panelId: data.panelId || null, providerId: data.providerId || null,
      version: data.version === undefined ? null : data.version,
      ok: data.ok === undefined ? null : data.ok,
      code: data.code || null, error: data.error || null,
      sessionId: data.sessionId || null, projectId: data.projectId || null,
      activeProjectId: data.activeProjectId || null,
      reason: data.reason || null,
      panels: Array.isArray(data.panels) ? data.panels.map(p => ({
        panelId: p.panelId, providerId: p.providerId, panelType: p.panelType || null,
        open: p.open, active: p.active, ready: p.ready, error: p.error || null,
        contentVersion: p.content && p.content.version !== undefined ? p.content.version : null,
        contentAck: p.content && p.content.ack ? { version: p.content.ack.version, ok: p.content.ack.ok, error: p.content.ack.error || null } : null,
        scope: p.scope || null,
      })) : null,
      providers: Array.isArray(data.providers) ? data.providers.map(p => ({ providerId: p.providerId, panelType: p.panelType || null, title: p.title || null })) : null,
    });
  });
  return true;
})()`;

function termExpr(body) {
  return `(() => {
    const frame = document.getElementById('workFrame');
    const doc = frame && frame.contentDocument;
    if (!doc) return null;
    ${body}
  })()`;
}

async function frameEval(browser, body) {
  return browser.evaluate(termExpr(body));
}

async function openWorkView(browser, productUrl, { timeoutMs = 90000 } = {}) {
  await waitFor(() => browser.evaluate(`!!document.querySelector('[data-select-project]')`), 'product project list on home', timeoutMs);
  await browser.evaluate(`document.querySelector('[data-select-project]').click(); true`);
  await waitFor(() => browser.evaluate(`document.getElementById('workEmpty') && document.getElementById('workEmpty').hidden === true`), 'active project', 20000);
  await browser.evaluate(`document.querySelector('[data-view="work"]').click(); true`);
  await waitFor(() => browser.evaluate(`(() => { const f = document.getElementById('workFrame'); return !!(f && f.src); })()`), 'work frame src', 20000);
  await waitFor(() => frameEval(browser, `return !!doc.getElementById('btn-new-session');`), 'terminal iframe loaded', timeoutMs);
}

async function installProductLog(browser) {
  await browser.evaluate(LISTENER('__r2ProductLog'));
}

async function installTerminalLog(browser) {
  await waitFor(() => browser.evaluate(`(() => {
    const frame = document.getElementById('workFrame');
    const win = frame && frame.contentWindow;
    if (!win) return false;
    if (win.__r2TermLog) return true;
    win.__r2TermLog = [];
    win.addEventListener('message', ev => {
      const data = ev.data;
      if (!data || typeof data.type !== 'string' || !data.type.startsWith('kb:')) return;
      win.__r2TermLog.push({
        t: Date.now(), type: data.type,
        requestId: data.requestId || null,
        panelId: data.panelId || null, providerId: data.providerId || null,
        version: data.version === undefined ? null : data.version,
        ok: data.ok === undefined ? null : data.ok,
        code: data.code || null, error: data.error || null,
      });
    });
    return true;
  })()`), 'terminal message listener', 15000);
}

async function getLogs(browser) {
  const productLog = await browser.evaluate(`window.__r2ProductLog ? window.__r2ProductLog.slice() : []`);
  const termLog = await frameEval(browser, `return (frame.contentWindow.__r2TermLog || []).slice();`);
  return { productLog, termLog };
}

async function dockSnapshot(browser) {
  return frameEval(browser, `return (() => {
    const toggle = doc.getElementById('btn-dock-toggle');
    const dock = doc.getElementById('right-dock');
    const tabs = Array.from(doc.querySelectorAll('.rd-tabs .rd-tab')).map((item, index) => ({
      index,
      label: (item.querySelector('.rd-tab-label') || { textContent: '' }).textContent || '',
      title: item.title || '',
      active: item.classList.contains('active'),
      selected: item.querySelector('.rd-tab-open') ? item.querySelector('.rd-tab-open').getAttribute('aria-selected') === 'true' : false,
      dot: (item.querySelector('.rd-dot') || { className: '' }).className || '',
      hasClose: !!item.querySelector('.rd-tab-close'),
    }));
    return {
      toggleHidden: !toggle || toggle.hidden,
      expanded: toggle ? toggle.getAttribute('aria-expanded') : null,
      toggleTitle: toggle ? toggle.title : null,
      dockHidden: !dock || dock.hidden,
      dockOpenClass: !!doc.querySelector('.dock-open'),
      tabCount: tabs.length,
      tabs,
      hostFrames: doc.querySelectorAll('.rd-host-frame').length,
      hostFrameTitles: Array.from(doc.querySelectorAll('.rd-host-frame')).map(frame => frame.getAttribute('title') || ''),
      launcherPanes: doc.querySelectorAll('.rd-launcher').length,
    };
  })();`);
}

async function termClick(browser, body, label, timeoutMs = 15000) {
  await waitFor(() => frameEval(browser, body), label, timeoutMs);
}

async function newSessionViaUi(browser) {
  await termClick(browser, `const n = doc.getElementById('btn-new-session'); if (!n) return false; n.click(); return true;`, 'new-session button');
}

async function clickSessionRow(browser, sessionId) {
  await termClick(browser, `const n = doc.querySelector('[data-session="${sessionId}"]'); if (!n) return false; n.scrollIntoView({block:'center'}); n.click(); return true;`, `session row ${sessionId}`);
}

async function clickDockToggle(browser) {
  await termClick(browser, `const n = doc.getElementById('btn-dock-toggle'); if (!n || n.hidden) return false; n.click(); return true;`, 'dock toggle button');
}

async function clickPlus(browser) {
  await termClick(browser, `const n = doc.querySelector('.rd-plus'); if (!n) return false; n.click(); return true;`, 'dock + button');
}

async function clickLauncherKnowledgeRow(browser) {
  await termClick(browser, `const n = doc.querySelector('.rd-launcher .rd-picker-host-row'); if (!n) return false; n.click(); return true;`, 'launcher knowledge row');
}

async function clickTabByLabel(browser, label) {
  await termClick(browser, `const row = Array.from(doc.querySelectorAll('.rd-tabs .rd-tab')).find(item => ((item.querySelector('.rd-tab-label') || { textContent: '' }).textContent || '') === '${label}'); if (!row) return false; row.click(); return true;`, `tab ${label}`);
}

async function closeTabByLabel(browser, label) {
  await termClick(browser, `const row = Array.from(doc.querySelectorAll('.rd-tabs .rd-tab')).find(item => ((item.querySelector('.rd-tab-label') || { textContent: '' }).textContent || '') === '${label}'); if (!row) return false; row.querySelector('.rd-tab-close').click(); return true;`, `close tab ${label}`);
}

async function sessionRowExists(browser, sessionId) {
  return frameEval(browser, `return !!doc.querySelector('[data-session="${sessionId}"]');`);
}

// The newest kb:panel/state is authoritative: after a close the workbench
// posts panels: [] and the provider must be absent from it.
function latestPanelState(productLog) {
  for (let i = productLog.length - 1; i >= 0; i -= 1) {
    const entry = productLog[i];
    if (entry.type === 'kb:panel/state') return entry;
  }
  return null;
}

function knowledgePanelOf(productLog, providerId) {
  const state = latestPanelState(productLog);
  if (!state || !Array.isArray(state.panels)) return null;
  return state.panels.find(panel => panel.providerId === providerId) || null;
}

// Real host-side protocol request: the host window posts the message to the
// workbench frame and waits for the workbench's own reply. The request is a
// legitimate protocol input (the same channel the product uses for its
// knowledge panel), never a DOM/listener manipulation.
let hostRequestSeq = 0;
async function hostPanelRequest(browser, type, payload = {}, { timeoutMs = 15000 } = {}) {
  const requestId = `r2-${++hostRequestSeq}-${Date.now()}`;
  const message = { type, requestId, ...payload };
  const sent = await browser.evaluate(`(() => {
    const frame = document.getElementById('workFrame');
    if (!frame || !frame.contentWindow) return false;
    frame.contentWindow.postMessage(${JSON.stringify(message)}, location.origin);
    return true;
  })()`);
  if (!sent) throw new Error(`host protocol request ${type} could not be posted (no workFrame)`);
  return waitFor(() => getLogs(browser).then(logs => {
    const reply = logs.productLog.find(entry => entry.requestId === requestId && entry.type !== type);
    return reply || null;
  }), `host protocol reply for ${type}`, timeoutMs);
}

// Real reload of the embedded workbench iframe (the browser re-runs the
// whole app boot, exactly like a user refreshing the frame).
async function reloadWorkFrame(browser) {
  const before = await browser.evaluate(`(() => { const f = document.getElementById('workFrame'); return f ? f.src : null; })()`);
  await browser.evaluate(`(() => { const f = document.getElementById('workFrame'); if (!f) return false; f.src = f.src; return true; })()`);
  await waitFor(() => browser.evaluate(`(() => { const f = document.getElementById('workFrame'); return !!(f && f.src); })()`), 'work frame src after reload', 20000);
  return before;
}

// ---- the module's own shipped panel host proof page ----------------------

async function openPanelProofHost(browser, url, { timeoutMs = 60000 } = {}) {
  // The embedded terminal posts kb:ready as soon as it boots, which can be
  // before a post-navigation listener is installed. Install the recorder for
  // every new document first so no early protocol message is missed.
  await browser.send('Page.addScriptToEvaluateOnNewDocument', { source: LISTENER('__r2ProofLog') });
  await browser.send('Page.navigate', { url });
  await waitFor(() => browser.evaluate(`document.readyState === 'complete'`), 'proof host page load', timeoutMs);
  await browser.evaluate(LISTENER('__r2ProofLog'));
  await waitFor(() => browser.evaluate(`!!document.getElementById('terminal-frame')`), 'proof host terminal frame', timeoutMs);
  await waitFor(() => browser.evaluate(`(() => {
    const log = window.__r2ProofLog || [];
    return log.some(entry => entry.type === 'kb:ready');
  })()`), 'proof host kb:ready', timeoutMs);
  return true;
}

async function proofLogs(browser) {
  return browser.evaluate(`window.__r2ProofLog ? window.__r2ProofLog.slice() : []`);
}

async function clickProofButton(browser, id) {
  return browser.evaluate(`(() => { const n = document.getElementById(${JSON.stringify(id)}); if (!n || n.disabled) return false; n.click(); return true; })()`);
}

async function proofStatus(browser) {
  return browser.evaluate(`(() => {
    const status = document.getElementById('panel-status');
    const lines = Array.from(document.querySelectorAll('#state-log .line')).map(n => (n.textContent || '').trim());
    return { status: status ? status.textContent : null, lines };
  })()`);
}

// Host-role protocol request issued from the proof host page itself.
async function proofHostRequest(browser, type, payload = {}, { timeoutMs = 15000 } = {}) {
  const requestId = `r2-proof-${++hostRequestSeq}-${Date.now()}`;
  const message = { type, requestId, ...payload };
  const sent = await browser.evaluate(`(() => {
    const frame = document.getElementById('terminal-frame');
    if (!frame || !frame.contentWindow) return false;
    frame.contentWindow.postMessage(${JSON.stringify(message)}, location.origin);
    return true;
  })()`);
  if (!sent) throw new Error(`proof host protocol request ${type} could not be posted`);
  return waitFor(() => proofLogs(browser).then(logs => {
    const reply = logs.find(entry => entry.requestId === requestId && entry.type !== type);
    return reply || null;
  }), `proof host protocol reply for ${type}`, timeoutMs);
}

async function failureContext(browser) {
  const out = {};
  const grab = async (key, expr) => {
    try { out[key] = await browser.evaluate(expr); } catch (error) { out[key] = `unavailable: ${error.message}`; }
  };
  await grab('url', 'location.href');
  await grab('frameSrc', `(() => { const f = document.getElementById('workFrame'); return f ? f.src : null; })()`);
  try { out.logs = await getLogs(browser); } catch (error) { out.logs = `unavailable: ${error.message}`; }
  try {
    out.terminalDom = await frameEval(browser, `return (() => {
      const btn = doc.getElementById('btn-new-session');
      const sessions = Array.from(doc.querySelectorAll('[data-session]')).map(n => ({ id: n.getAttribute('data-session'), text: (n.textContent || '').replace(/\\s+/g, ' ').slice(0, 60) }));
      return {
        newSessionButton: btn ? { hidden: btn.hidden, disabled: btn.disabled, text: (btn.textContent || '').slice(0, 40) } : null,
        sessionRows: sessions,
        bodySnippet: (doc.body.textContent || '').replace(/\\s+/g, ' ').slice(0, 600),
      };
    })();`);
  } catch (error) { out.terminalDom = `unavailable: ${error.message}`; }
  return out;
}

function evidenceWriter(artifactsDir, baseName) {
  fs.mkdirSync(artifactsDir, { recursive: true });
  return {
    write(value) {
      const file = path.join(artifactsDir, baseName);
      fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
      return file;
    },
  };
}

module.exports = {
  launchCdpBrowser, waitFor, findChrome,
  openWorkView, installProductLog, installTerminalLog, dockSnapshot,
  newSessionViaUi, clickSessionRow, sessionRowExists,
  clickDockToggle, clickPlus, clickLauncherKnowledgeRow,
  clickTabByLabel, closeTabByLabel,
  getLogs, frameEval, evidenceWriter, failureContext,
  hostPanelRequest, reloadWorkFrame,
  latestPanelState, knowledgePanelOf,
  openPanelProofHost, proofLogs, clickProofButton, proofStatus, proofHostRequest,
};
