// _site/_test/helpers/parallel-dock-acceptance-ui.js
//
// Lane-exclusive real-UI driver for P-DOCK-ACCEPTANCE-01. All interactions
// happen through the REAL product page in a real CDP browser: the terminal
// iframe is reached same-origin (the product proxies the module UI), and
// clicks are dispatched on the real DOM nodes the product itself renders.
// Observation is additive only: extra window message listeners that record
// kb:* traffic. Nothing in the product is wrapped or replaced.

'use strict';

const fs = require('fs');
const path = require('path');

const { launchCdpBrowser, waitFor } = require('./cdp-browser');
const { findChrome } = require('./find-chrome');

const PRODUCT_LISTENER = `(() => {
  if (window.__dkProductLog) return true;
  window.__dkProductLog = [];
  window.addEventListener('message', ev => {
    const data = ev.data;
    if (!data || typeof data.type !== 'string' || !data.type.startsWith('kb:')) return;
    window.__dkProductLog.push({
      t: Date.now(), type: data.type,
      panelId: data.panelId || null, providerId: data.providerId || null,
      version: data.version === undefined ? null : data.version, ok: data.ok === undefined ? null : data.ok,
      sessionId: data.sessionId || null, projectId: data.projectId || null,
      knowledgeStatus: data.knowledge && data.knowledge.status || null,
      knowledgeRefs: data.knowledge && Array.isArray(data.knowledge.references) ? data.knowledge.references.map(r => r.entryId || r.title || '') : null,
      contentRefs: data.content && Array.isArray(data.content.references) ? data.content.references.map(r => r.entryId || r.title || '') : null,
      panels: Array.isArray(data.panels) ? data.panels.map(p => ({ panelId: p.panelId, providerId: p.providerId, open: p.open, active: p.active, ready: p.ready, error: p.error || null })) : null,
    });
  });
  return true;
})()`;

const TERMINAL_LISTENER = `(() => {
  const frame = document.getElementById('workFrame');
  const win = frame && frame.contentWindow;
  if (!win) return false;
  if (win.__dkTermLog) return true;
  win.__dkTermLog = [];
  win.addEventListener('message', ev => {
    const data = ev.data;
    if (!data || typeof data.type !== 'string' || !data.type.startsWith('kb:')) return;
    win.__dkTermLog.push({
      t: Date.now(), type: data.type,
      panelId: data.panelId || null, providerId: data.providerId || null,
      version: data.version === undefined ? null : data.version, ok: data.ok === undefined ? null : data.ok,
      sessionId: data.sessionId || null,
      contentRefs: data.content && Array.isArray(data.content.references) ? data.content.references.map(r => r.entryId || r.title || '') : null,
      ackVersion: data.version === undefined ? null : data.version,
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
  await browser.evaluate(PRODUCT_LISTENER);
}

async function installTerminalLog(browser) {
  await waitFor(() => browser.evaluate(TERMINAL_LISTENER), 'terminal message listener', 15000);
}

async function dockSnapshot(browser) {
  return frameEval(browser, `return (() => {
    const toggle = doc.getElementById('btn-dock-toggle');
    const dock = doc.getElementById('right-dock');
    const tabs = Array.from(doc.querySelectorAll('.rd-tabs .rd-tab')).map(item => ({
      label: (item.querySelector('.rd-tab-label') || { textContent: '' }).textContent || '',
      selected: item.querySelector('.rd-tab-open') ? item.querySelector('.rd-tab-open').getAttribute('aria-selected') === 'true' : false,
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
      launcherPanes: doc.querySelectorAll('.rd-launcher').length,
      emptyPane: (doc.querySelector('.rd-empty') || { textContent: '' }).textContent || null,
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
  await termClick(browser, `const row = Array.from(doc.querySelectorAll('.rd-tabs .rd-tab')).find(item => ((item.querySelector('.rd-tab-label') || { textContent: '' }).textContent || '') === '${label}'); if (!row) return false; row.querySelector('.rd-tab-open').click(); return true;`, `tab ${label}`);
}

async function closeTabByLabel(browser, label) {
  await termClick(browser, `const row = Array.from(doc.querySelectorAll('.rd-tabs .rd-tab')).find(item => ((item.querySelector('.rd-tab-label') || { textContent: '' }).textContent || '') === '${label}'); if (!row) return false; row.querySelector('.rd-tab-close').click(); return true;`, `close tab ${label}`);
}

async function getLogs(browser) {
  const productLog = await browser.evaluate(`window.__dkProductLog ? window.__dkProductLog.slice() : []`);
  const termLog = await frameEval(browser, `return (frame.contentWindow.__dkTermLog || []).slice();`);
  return { productLog, termLog };
}

async function sessionRowExists(browser, sessionId) {
  return frameEval(browser, `return !!doc.querySelector('[data-session="${sessionId}"]');`);
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
};
