// UI flow coverage for TASK-015..020.
// Uses a real Chromium via CDP and writes screenshots to _site/_test/ui-screenshots.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const WebSocket = require('ws');
const { spawnServer } = require('./helpers/spawn-server');
const { findChrome } = require('./helpers/find-chrome');

const CHROME = findChrome();
const ROOT = path.resolve(__dirname, '..', '..');
const SERVER = path.join(ROOT, '_site', 'server.js');
const SITE_PORT = process.env.KB_TASK15_UI_SITE_PORT || '7815';
const TARGET_URL = process.argv[2] || `http://127.0.0.1:${SITE_PORT}/`;
const OUT_DIR = path.join(__dirname, 'ui-screenshots');
const PROFILE = path.join(OUT_DIR, 'task15-20-profile');
const PORT = 9341;

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.rmSync(PROFILE, { recursive: true, force: true });
fs.mkdirSync(PROFILE, { recursive: true });

function assert(cond, msg) { if (!cond) throw new Error('ASSERT: ' + msg); }
function fetchJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}
async function waitFor(fn, label, ms = 15000) {
  const deadline = Date.now() + ms;
  let last;
  while (Date.now() < deadline) {
    try {
      const got = await fn();
      if (got) return got;
    } catch (e) { last = e; }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`timeout: ${label}${last ? ` :: ${last.message}` : ''}`);
}

(async () => {
  // Pre-create an isolated temp data dir and seed projects for the Claude
  // workbench project switch flow.
  const FLOW_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), `kb-data-task15-20-ui-flow-${process.pid}-`));
  fs.writeFileSync(path.join(FLOW_DATA_DIR, 'projects.json'), '{}\n', 'utf-8');
  const flowProjects = {
    'flow-proj-a': {
      displayName: 'Flow A',
      localPath: ROOT, gitPath: ROOT, enabled: true,
      aiProfileId: 'minimax', repoStatus: 'ok', headCommit: null,
      lastSeenCommit: null, lastAnalyzedCommit: null,
      kbSchemaVersion: 'minimal', goalStatus: 'accepted',
      kbPath: path.join(FLOW_DATA_DIR, 'projects', 'flow-proj-a'),
    },
    'flow-proj-b': {
      displayName: 'Flow B',
      localPath: ROOT, gitPath: ROOT, enabled: true,
      aiProfileId: 'minimax', repoStatus: 'ok', headCommit: null,
      lastSeenCommit: null, lastAnalyzedCommit: null,
      kbSchemaVersion: 'minimal', goalStatus: 'accepted',
      kbPath: path.join(FLOW_DATA_DIR, 'projects', 'flow-proj-b'),
    },
  };
  fs.writeFileSync(path.join(FLOW_DATA_DIR, 'projects.json'), JSON.stringify(flowProjects, null, 2));
  fs.mkdirSync(path.join(FLOW_DATA_DIR, 'projects', 'flow-proj-a'), { recursive: true });
  fs.mkdirSync(path.join(FLOW_DATA_DIR, 'projects', 'flow-proj-b'), { recursive: true });

  const siteServer = process.argv[2] ? null : spawnServer({ root: ROOT, port: Number(SITE_PORT), dataDir: FLOW_DATA_DIR, tag: 'task15-20-ui-flow' }).child;
  const child = spawn(CHROME, [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`,
    '--window-size=1440,980',
    'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });

  const errors = [];
  try {
    if (siteServer) {
      await waitFor(() => new Promise((resolve) => {
        http.get(TARGET_URL, res => { res.resume(); resolve(res.statusCode < 500); }).on('error', () => resolve(false));
      }), 'site server');
    }
    const pages = await waitFor(() => fetchJson(`http://127.0.0.1:${PORT}/json/list`), 'chrome page list');
    const page = pages.find(p => p.type === 'page') || pages[0];
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });

    let nextId = 1;
    const pending = new Map();
    ws.on('message', m => {
      const msg = JSON.parse(m.toString());
      if (msg.id && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        errors.push((msg.params.args || []).map(arg => arg.value || arg.description || '').join(' '));
      }
    });
    function send(method, params = {}) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      });
    }
    async function evalJs(expression) {
      const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      return r.result.value;
    }
    async function screenshot(name) {
      const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
      const file = path.join(OUT_DIR, name);
      fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
      return file;
    }

    await send('Runtime.enable');
    await send('Page.enable');
    await send('Network.enable');
    await send('Page.navigate', { url: TARGET_URL });
    await waitFor(() => evalJs('document.readyState === "complete"'), 'document ready');
    await evalJs('localStorage.setItem("kb-ui-language", "en"); location.reload()');
    await waitFor(() => evalJs('document.querySelector("#app") && document.querySelector("#app").innerText.includes("Claude Code")'), 'app English Claude workbench');
    await new Promise(resolve => setTimeout(resolve, 800));
    const dashboardShot = await screenshot('task15-20-dashboard.png');

    assert(await evalJs(`(() => {
      const view = document.querySelector('.dashboard-view');
      const panel = view?.querySelector(':scope > section');
      return !!(view && panel && !document.body.innerText.includes('Pending commit details')
        && !document.body.innerText.includes('Issue center')
        && !document.body.innerText.includes('Project Operations'));
    })()`), 'daily page should contain only the full-width Claude workbench');

    await evalJs(`[...document.querySelectorAll('aside button')].find(b => b.innerText.includes('Flow B'))?.click()`);
    await waitFor(() => evalJs('document.body.innerText.includes("Claude Code")'), 'Claude workbench remains available after project switch');

    assert(await evalJs(`![...document.querySelectorAll('button')].some(b => b.innerText.includes('Runs / Drafts'))`),
      'legacy review/drafts navigation should be removed');
    assert(await evalJs(`![...document.querySelectorAll('button')].some(b => b.innerText.trim() === 'Schedule')`),
      'legacy schedule navigation should be removed');

    assert(errors.length === 0, `console errors: ${errors.join('\\n')}`);
    console.log('TASK-015..020 UI flow test passed');
    console.log(`screenshots:\n${dashboardShot}`);
  } catch (e) {
    console.error('TASK-015..020 UI flow test failed:', e.message);
    process.exitCode = 1;
  } finally {
    try { if (siteServer) siteServer.kill(); } catch {}
    child.kill();
  }
})();
