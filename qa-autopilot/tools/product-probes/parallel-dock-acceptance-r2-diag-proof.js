// qa-autopilot/tools/product-probes/parallel-dock-acceptance-r2-diag-proof.js
//
// Diagnostic (not a verdict): boots the isolated lane env and inspects the
// module's own shipped panel host proof page to find out why the R2 DOCK-002
// probe could not observe kb:ready there. Read-only observation.

'use strict';

const os = require('os');
const path = require('path');

const { createDockAcceptanceEnv } = require('../../../_site/_test/helpers/parallel-dock-acceptance-r2-env');
const { launchCdpBrowser, waitFor, findChrome } = require('../../../_site/_test/helpers/parallel-dock-acceptance-r2-ui');

async function main() {
  const env = await createDockAcceptanceEnv({ tag: 'dock-acceptance-r2-diag' });
  const chrome = findChrome();
  let browser = null;
  try {
    browser = await launchCdpBrowser({
      chrome,
      profileDir: path.join(os.tmpdir(), `pk-dock002-r2-diag-${process.pid}`),
      url: 'about:blank', width: 1600, height: 900,
    });
    // Install the recorder BEFORE navigation so no early message is missed.
    await browser.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `(() => {
        window.__diag = [];
        window.addEventListener('message', ev => {
          const d = ev.data;
          if (!d || typeof d.type !== 'string' || !d.type.startsWith('kb:')) return;
          window.__diag.push({ t: Date.now(), type: d.type, origin: ev.origin, data: JSON.stringify(d).slice(0, 400) });
        });
      })()`,
    });
    const url = env.panelProofHostUrl();
    console.log('[diag] proof url', url);
    await browser.send('Page.navigate', { url });
    await waitFor(() => browser.evaluate(`document.readyState === 'complete'`), 'proof load', 60000);
    await new Promise(r => setTimeout(r, 8000));
    const info = await browser.evaluate(`(() => {
      const frame = document.getElementById('terminal-frame');
      const status = document.getElementById('panel-status');
      const lines = Array.from(document.querySelectorAll('#state-log .line')).map(n => (n.textContent || '').trim());
      let inner = null;
      try {
        const doc = frame && frame.contentDocument;
        inner = {
          hasDoc: !!doc,
          readyState: doc ? doc.readyState : null,
          bodyLen: doc && doc.body ? (doc.body.textContent || '').length : null,
          bodyHead: doc && doc.body ? (doc.body.textContent || '').replace(/\\s+/g, ' ').slice(0, 300) : null,
          scripts: doc ? Array.from(doc.scripts).map(s => s.src).slice(0, 10) : null,
        };
      } catch (e) { inner = { error: String(e) }; }
      return {
        diag: window.__diag || [],
        status: status ? status.textContent : null,
        lines,
        frameSrc: frame ? frame.getAttribute('src') : null,
        inner,
      };
    })()`);
    console.log(JSON.stringify(info, null, 1));
    console.log('[diag] terminal log tail:', env.terminalLogText().slice(-3000));
    console.log('[diag] product log tail:', env.productLogText().slice(-2000));
  } finally {
    if (browser) { try { await browser.close(); } catch {} }
    await env.cleanup();
  }
}

main().then(() => process.exit(0)).catch((error) => { console.error('[diag] failed:', error); process.exit(1); });
