// UI smoke test - runs in a real Chromium via CDP.
//
// It verifies the backend-driven control center renders, core navigation is
// visible, project status data appears, tab switching works, and no console or
// network errors are emitted during load.
//
// Run: node _site/_test/ui-smoke-test.js [URL]

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const WebSocket = require('ws');
const { spawnServer } = require('./helpers/spawn-server');

const CHROME = 'C:\\Users\\SanQian\\AppData\\Local\\ms-playwright\\chromium-1223\\chrome-win64\\chrome.exe';
const ROOT = path.resolve(__dirname, '..', '..');
const SERVER = path.join(ROOT, '_site', 'server.js');
const SITE_PORT = process.env.KB_UI_SMOKE_SITE_PORT || '7814';
const TARGET_URL = process.argv[2] || `http://127.0.0.1:${SITE_PORT}/`;
const OUT_DIR = path.join(__dirname, 'ui-screenshots');
const PROFILE = path.join(OUT_DIR, 'smoke-profile');
const PORT = 9340;

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.rmSync(PROFILE, { recursive: true, force: true });
fs.mkdirSync(PROFILE, { recursive: true });

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

async function waitFor(fn, label, ms = 15000) {
  const deadline = Date.now() + ms;
  let last;
  while (Date.now() < deadline) {
    try {
      const result = await fn();
      if (result) return result;
    } catch (e) {
      last = e;
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('timeout: ' + label + ' :: ' + (last && last.message));
}

function assert(cond, msg) {
  if (!cond) throw new Error('ASSERT: ' + msg);
}

(async () => {
  // Pre-create an isolated temp data dir and seed a project so the smoke
  // test sees a selected project on the dashboard (otherwise the empty
  // state hides status cards).
  const SMOKE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), `kb-data-ui-smoke-${process.pid}-`));
  fs.writeFileSync(path.join(SMOKE_DATA_DIR, 'projects.json'), '{}\n', 'utf-8');
  const smokeProjects = {
    'smoke-proj': {
      displayName: 'Smoke Project',
      localPath: ROOT,
      gitPath: ROOT,
      enabled: true,
      aiProfileId: 'minimax',
      repoStatus: 'ok',
      headCommit: null,
      lastSeenCommit: null,
      lastAnalyzedCommit: null,
      kbSchemaVersion: 'minimal',
      goalStatus: 'accepted',
      kbPath: path.join(SMOKE_DATA_DIR, 'projects', 'smoke-proj'),
    },
  };
  fs.writeFileSync(path.join(SMOKE_DATA_DIR, 'projects.json'), JSON.stringify(smokeProjects, null, 2));
  fs.writeFileSync(path.join(SMOKE_DATA_DIR, 'ai-profiles.json'), JSON.stringify({
    schema: 'ai-profiles/v1',
    profiles: [{
      id: 'minimax',
      name: 'MiniMax',
      provider: 'MiniMax',
      enabled: true,
      implementation: 'claude-code-agent',
      baseUrl: 'https://api.minimaxi.com/anthropic',
      apiKey: 'smoke-test-key',
      mainModel: 'MiniMax-M3',
      model: 'MiniMax-M3',
    }],
  }, null, 2));
  fs.writeFileSync(path.join(SMOKE_DATA_DIR, 'knowledge-store.json'), JSON.stringify({
    schema: 'knowledge-store/v1',
    rootPath: path.join(SMOKE_DATA_DIR, 'projects'),
    git: {
      enabled: false,
      remoteUrl: '',
      branch: 'main',
      autoCommit: false,
      autoPush: false,
    },
    configured: true,
  }, null, 2));
  fs.mkdirSync(path.join(SMOKE_DATA_DIR, 'projects', 'smoke-proj'), { recursive: true });

  const siteServer = process.argv[2] ? null : spawnServer({ root: ROOT, port: Number(SITE_PORT), dataDir: SMOKE_DATA_DIR, tag: 'ui-smoke' }).child;
  const child = spawn(CHROME, [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + PROFILE,
    '--window-size=1280,900',
    'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  child.stderr.on('data', () => {});

  const errors = [];
  const warnings = [];
  const requestFailures = [];

  try {
    if (siteServer) {
      await waitFor(() => new Promise((resolve) => {
        http.get(TARGET_URL, res => { res.resume(); resolve(res.statusCode < 500); }).on('error', () => resolve(false));
      }), 'site server');
    }
    const pages = await waitFor(async () => {
      const list = await fetchJson(`http://127.0.0.1:${PORT}/json/list`);
      return Array.isArray(list) && list.length ? list : null;
    }, 'list');
    const page = pages.find(p => p.type === 'page') || pages[0];
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
    });

    let nextId = 1;
    const pending = new Map();
    ws.on('message', m => {
      const msg = JSON.parse(m.toString());
      if (msg.id && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
        return;
      }

      if (msg.method === 'Runtime.consoleAPICalled') {
        const type = msg.params.type;
        const text = (msg.params.args || []).map(arg => arg.value !== undefined ? arg.value : arg.description).join(' ');
        if (/cdn\.tailwindcss\.com should not be used in production/.test(text)) return;
        if (type === 'error') errors.push(text);
        else if (type === 'warning') warnings.push(text);
      } else if (msg.method === 'Network.loadingFailed') {
        requestFailures.push(msg.params);
      } else if (msg.method === 'Network.responseReceived' && msg.params.response.status >= 500) {
        requestFailures.push({ url: msg.params.response.url, status: msg.params.response.status });
      }
    });

    function send(method, params = {}) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      });
    }

    await send('Runtime.enable');
    await send('Page.enable');
    await send('Network.enable');

    await send('Page.navigate', { url: TARGET_URL });
    await waitFor(async () => {
      const r = await send('Runtime.evaluate', {
        expression: 'document.readyState === "complete" && document.querySelector("#app") && /Control Center|控制中心/.test(document.querySelector("#app").innerText)',
        returnByValue: true,
      });
      return r.result.value === true;
    }, '#app to render control center', 15000);
    await send('Runtime.evaluate', {
      expression: 'localStorage.setItem("kb-ui-language", "en"); location.reload();',
      returnByValue: true,
    });
    await waitFor(async () => {
      const r = await send('Runtime.evaluate', {
        expression: 'document.readyState === "complete" && document.querySelector("#app") && /Control Center/.test(document.querySelector("#app").innerText)',
        returnByValue: true,
      });
      return r.result.value === true;
    }, '#app to render control center in English', 15000);
    await new Promise(resolve => setTimeout(resolve, 1000));

    let r = await send('Runtime.evaluate', {
      expression: 'document.querySelector("#app") && document.querySelector("#app").innerHTML.trim()',
      returnByValue: true,
    });
    const appHtml = r.result.value;
    assert(appHtml && appHtml.length > 500, `appHtml too short: ${(appHtml || '').length}`);
    assert(!appHtml.includes('<!---->') || appHtml.indexOf('header') >= 0, 'app rendered as comment');

    r = await send('Runtime.evaluate', {
      expression: 'document.querySelector("h1") ? document.querySelector("h1").innerText : ""',
      returnByValue: true,
    });
    assert(/Project Supervision|项目监督/.test(r.result.value), 'header missing');

    r = await send('Runtime.evaluate', {
      expression: 'Array.from(document.querySelectorAll("button, a")).map(e => e.innerText.trim()).filter(Boolean)',
      returnByValue: true,
    });
    const navText = r.result.value;
    assert(!navText.some(t => /^Dashboard|^仪表盘/.test(t)), 'Dashboard nav should not render as a standalone control');
    assert(navText.some(t => /^Import Project|^导入项目/.test(t)), 'Import project action missing');
    assert(navText.some(t => /^Runs \/ Drafts|^运行 \/ 草稿/.test(t)), 'Runs / Drafts nav missing');
    assert(navText.some(t => /^Logs|^日志/.test(t)), 'Logs nav missing');
    assert(navText.some(t => /^Settings|^设置|^璁剧疆/.test(t)), 'Settings drawer trigger missing');

    r = await send('Runtime.evaluate', {
      expression: 'document.body.innerText',
      returnByValue: true,
    });
    const bodyText = r.result.value;
    assert(/Running Jobs|运行中的任务/.test(bodyText), 'running jobs panel missing');
    assert(/Repo|仓库/.test(bodyText), 'repo status missing');
    assert(!/Run Knowledge Update|运行知识库更新/.test(bodyText), 'deprecated knowledge update button should not render');
    assert(!/Edit Project Goal|编辑项目目标/.test(bodyText), 'deprecated edit goal button should not render');
    assert(!/Open KB|打开知识库/.test(bodyText), 'deprecated open KB button should not render');
    assert(!/Show advanced diagnostics|显示高级诊断/.test(bodyText), 'advanced diagnostics should not render');
    assert(!/Validate Git|校验 Git|Migrate KB framework|迁移知识库框架/.test(bodyText), 'advanced diagnostic actions should not render');

    r = await send('Runtime.evaluate', {
      expression: 'getComputedStyle(document.querySelector("aside")).backgroundColor',
      returnByValue: true,
    });
    assert(!/^rgba?\(255,\s*255,\s*255/.test(r.result.value), `sidebar background is not themed: ${r.result.value}`);

    await send('Page.reload', { ignoreCache: true });
    await new Promise(resolve => setTimeout(resolve, 5000));
    r = await send('Runtime.evaluate', {
      expression: '/Project Supervision|项目监督/.test(document.body.innerText) && /Repo|仓库/.test(document.body.innerText)',
      returnByValue: true,
    });
    assert(r.result.value, 'after reload dashboard did not render');

    r = await send('Runtime.evaluate', {
      expression: '(() => { const settings = Array.from(document.querySelectorAll("button, a")).find(b => /^Settings|^设置|^璁剧疆/.test(b.innerText)); if (settings) settings.click(); return !!settings; })()',
      returnByValue: true,
    });
    assert(r.result.value, 'Settings drawer trigger not found for Schedule');
    await new Promise(resolve => setTimeout(resolve, 300));
    r = await send('Runtime.evaluate', {
      expression: '(() => { const btn = Array.from(document.querySelectorAll("button, a")).find(b => /^Schedule|^定时任务/.test(b.innerText)); if (btn) btn.click(); return btn ? btn.innerText : "NO BTN"; })()',
      returnByValue: true,
    });
    assert(r.result.value !== 'NO BTN', 'Schedule drawer action missing');
    await new Promise(resolve => setTimeout(resolve, 1000));
    r = await send('Runtime.evaluate', {
      expression: '/Schedule|定时任务/.test(document.body.innerText) && /Controls|控制/.test(document.body.innerText)',
      returnByValue: true,
    });
    assert(r.result.value, 'Schedule tab did not render its content');

    r = await send('Runtime.evaluate', {
      expression: '(() => { const btn = Array.from(document.querySelectorAll("button, a")).find(b => /Runs \\/ Drafts|运行 \\/ 草稿/.test(b.innerText)); if (btn) btn.click(); return btn ? btn.innerText : "NO BTN"; })()',
      returnByValue: true,
    });
    await new Promise(resolve => setTimeout(resolve, 1000));
    r = await send('Runtime.evaluate', {
      expression: '/Runs|运行/.test(document.body.innerText) && /Drafts|草稿/.test(document.body.innerText)',
      returnByValue: true,
    });
    assert(r.result.value, 'Runs / Drafts tab did not render its content');

    r = await send('Runtime.evaluate', {
      expression: '(() => { const settings = Array.from(document.querySelectorAll("button, a")).find(b => /^Settings|^设置|^璁剧疆/.test(b.innerText)); if (settings) settings.click(); return !!settings; })()',
      returnByValue: true,
    });
    assert(r.result.value, 'Settings drawer trigger not found for Git settings');
    await new Promise(resolve => setTimeout(resolve, 300));
    r = await send('Runtime.evaluate', {
      expression: '(() => { const btn = Array.from(document.querySelectorAll("button, a")).find(b => /Project Git \\/ Hook Settings|项目 Git \\/ Hook 设置|椤圭洰 Git \\/ Hook 璁剧疆/.test(b.innerText)); if (btn) btn.click(); return btn ? btn.innerText : "NO BTN"; })()',
      returnByValue: true,
    });
    assert(r.result.value !== 'NO BTN', 'Project Git / Hook drawer action missing');
    await new Promise(resolve => setTimeout(resolve, 1000));
    r = await send('Runtime.evaluate', {
      expression: '/Project Git \\/ Hook Settings|椤圭洰 Git \\/ Hook 璁剧疆/.test(document.body.innerText) && /Git Snapshot|Git 蹇収/.test(document.body.innerText) && /Check hook|妫€鏌?Hook/.test(document.body.innerText)',
      returnByValue: true,
    });
    assert(r.result.value, 'project Git / Hook settings did not render');

    r = await send('Runtime.evaluate', {
      expression: '(() => { const settings = Array.from(document.querySelectorAll("button, a")).find(b => /^Settings|^设置|^璁剧疆/.test(b.innerText)); if (settings) settings.click(); return !!settings; })()',
      returnByValue: true,
    });
    assert(r.result.value, 'Settings drawer trigger not found for AI profiles');
    await new Promise(resolve => setTimeout(resolve, 300));
    r = await send('Runtime.evaluate', {
      expression: '(() => { const btn = Array.from(document.querySelectorAll("button, a")).find(b => /^AI Profiles|^AI 配置/.test(b.innerText)); if (btn) btn.click(); return btn ? btn.innerText : "NO BTN"; })()',
      returnByValue: true,
    });
    assert(r.result.value !== 'NO BTN', 'AI Profiles drawer action missing');
    await new Promise(resolve => setTimeout(resolve, 1000));
    await send('Runtime.evaluate', {
      expression: '(() => { const btn = Array.from(document.querySelectorAll("button, a")).find(b => /Edit profile|缂栬緫閰嶇疆|编辑配置/.test(b.innerText)); if (btn) btn.click(); return !!btn; })()',
      returnByValue: true,
    });
    await new Promise(resolve => setTimeout(resolve, 300));
    r = await send('Runtime.evaluate', {
      expression: '/AI Profiles/.test(document.body.innerText) && /Profile editor/.test(document.body.innerText) && /Test model/.test(document.body.innerText) && /Request URL/.test(document.body.innerText) && /\\bModel\\b/.test(document.body.innerText) && /Provider name/.test(document.body.innerText)',
      returnByValue: true,
    });
    assert(r.result.value, 'AI model settings did not render');

    const shot = await send('Page.captureScreenshot', { format: 'png', fullPage: true });
    fs.writeFileSync(path.join(OUT_DIR, 'smoke-final.png'), Buffer.from(shot.data, 'base64'));

    assert(errors.length === 0, `console errors: ${JSON.stringify(errors, null, 2)}`);
    assert(requestFailures.length === 0, `request failures: ${JSON.stringify(requestFailures, null, 2)}`);

    console.log('UI smoke test passed');
    console.log('  - nav items:', navText.length);
    console.log('  - warnings:', warnings.length);
    console.log('  - errors:', errors.length);
    ws.close();
  } catch (e) {
    console.error('UI smoke test failed:', e.message);
    if (errors.length) console.error('console errors:', JSON.stringify(errors, null, 2));
    if (requestFailures.length) console.error('request failures:', JSON.stringify(requestFailures, null, 2));
    process.exitCode = 1;
  } finally {
    try { if (siteServer) siteServer.kill(); } catch {}
    try { child.kill(); } catch {}
  }
})();
