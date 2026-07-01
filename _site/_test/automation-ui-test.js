// UI coverage for project post-commit automation settings.
// Starts an isolated server and drives the browser through Chrome CDP.

const { spawn, spawnSync } = require('child_process');
const { spawnServer } = require('./helpers/spawn-server');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const WebSocket = require('ws');

const ROOT = path.resolve(__dirname, '..', '..');
const SERVER = path.join(ROOT, '_site', 'server.js');
// Pre-create a temp data dir and seed it BEFORE requiring any lib modules
// that capture getDataDir() at module load. Both the test process and
// the spawned server will use this dir.
let DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), `kb-data-automation-ui-${process.pid}-`));
process.env.KB_DATA_DIR = DATA_DIR;
require('../lib/data-dir')._resetCache();
fs.writeFileSync(path.join(DATA_DIR, 'projects.json'), '{}\n', 'utf-8');
try { fs.copyFileSync(path.join(ROOT, 'claude-prompts.json'), path.join(DATA_DIR, 'claude-prompts.json')); } catch {}

let PROJECTS_JSON = path.join(DATA_DIR, 'projects.json');

const BASELINE_AI_PROFILES = {
  schema: 'ai-profiles/v1',
  profiles: [{
    id: 'minimax-m3',
    name: 'MiniMax M3',
    enabled: true,
    implementation: 'claude-code-agent',
    baseUrl: 'https://example.test/anthropic',
    apiKey: 'test-key',
    mainModel: 'MiniMax-M3',
  }],
};
fs.writeFileSync(path.join(DATA_DIR, 'ai-profiles.json'), JSON.stringify(BASELINE_AI_PROFILES, null, 2) + '\n', 'utf-8');
const CHROME = 'C:\\Users\\SanQian\\AppData\\Local\\ms-playwright\\chromium-1223\\chrome-win64\\chrome.exe';
const OUT_DIR = path.join(__dirname, 'ui-screenshots');
const PROFILE = path.join(OUT_DIR, `automation-profile-${process.pid}`);
const SERVER_PORT = process.env.KB_AUTOMATION_UI_PORT || '7813';
const CHROME_PORT = Number(process.env.KB_AUTOMATION_UI_CHROME_PORT || (9300 + (process.pid % 500)));
const BASE_URL = `http://127.0.0.1:${SERVER_PORT}`;
const SLUG = 'automation-ui-test';
const SLUG2 = 'automation-ui-test-other';
const TEMP_REPO = path.join(os.tmpdir(), `kb-automation-ui-repo-${process.pid}`);
const TEMP_KB = path.join(os.tmpdir(), `kb-automation-ui-kb-${process.pid}`);
const TEMP_REPO2 = path.join(os.tmpdir(), `kb-automation-ui-repo-other-${process.pid}`);
const TEMP_KB2 = path.join(os.tmpdir(), `kb-automation-ui-kb-other-${process.pid}`);

function assert(cond, msg) {
  if (!cond) throw new Error('ASSERT: ' + msg);
}

function rmrf(p) {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch {}
}

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  return (r.stdout || '').trim();
}

function enabledProfileId() {
  const p = (BASELINE_AI_PROFILES.profiles || []).find(item => item.enabled !== false);
  return p && p.id || 'minimax';
}

function initFixture() {
  rmrf(TEMP_REPO);
  rmrf(TEMP_KB);
  rmrf(TEMP_REPO2);
  rmrf(TEMP_KB2);
  fs.mkdirSync(TEMP_REPO, { recursive: true });
  fs.mkdirSync(TEMP_KB, { recursive: true });
  fs.mkdirSync(TEMP_REPO2, { recursive: true });
  fs.mkdirSync(TEMP_KB2, { recursive: true });
  git(TEMP_REPO, ['init', '--initial-branch=main']);
  git(TEMP_REPO, ['config', 'user.email', 'automation-ui@example.com']);
  git(TEMP_REPO, ['config', 'user.name', 'Automation UI']);
  git(TEMP_REPO, ['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(TEMP_REPO, 'README.md'), '# automation ui\n', 'utf-8');
  git(TEMP_REPO, ['add', 'README.md']);
  git(TEMP_REPO, ['commit', '-m', 'feat: initial automation ui']);
  fs.writeFileSync(path.join(TEMP_REPO, 'feature.txt'), 'ui feature\n', 'utf-8');
  git(TEMP_REPO, ['add', 'feature.txt']);
  git(TEMP_REPO, ['commit', '-m', 'feat: add ui automation feature']);
  fs.writeFileSync(path.join(TEMP_KB, 'README.md'), '# automation kb\n', 'utf-8');
  fs.writeFileSync(path.join(TEMP_KB, 'GOAL.md'), '# goal\n', 'utf-8');
  git(TEMP_REPO2, ['init', '--initial-branch=main']);
  git(TEMP_REPO2, ['config', 'user.email', 'automation-ui@example.com']);
  git(TEMP_REPO2, ['config', 'user.name', 'Automation UI']);
  git(TEMP_REPO2, ['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(TEMP_REPO2, 'README.md'), '# automation ui other\n', 'utf-8');
  git(TEMP_REPO2, ['add', 'README.md']);
  git(TEMP_REPO2, ['commit', '-m', 'feat: initial other automation ui']);
  fs.writeFileSync(path.join(TEMP_KB2, 'README.md'), '# automation kb other\n', 'utf-8');
  fs.writeFileSync(path.join(TEMP_KB2, 'GOAL.md'), '# goal other\n', 'utf-8');
}

function registerProject() {
  const projects = JSON.parse(fs.readFileSync(PROJECTS_JSON, 'utf-8'));
  projects[SLUG] = {
    displayName: 'Automation UI Test',
    localPath: TEMP_REPO,
    gitPath: TEMP_REPO,
    isReference: false,
    primaryLanguage: 'JavaScript',
    tags: ['test'],
    docConvention: 'frontmatter-relations',
    kbPath: TEMP_KB,
    enabled: true,
    repoStatus: 'ok',
    headCommit: null,
    lastSeenCommit: null,
    lastAnalyzedCommit: null,
    aiProfileId: enabledProfileId(),
    kbSchemaVersion: 'v1',
    goalStatus: 'accepted',
    automation: {
      enabled: false,
      postCommitEnabled: false,
      knowledgeMode: 'requestApproval',
      allowReadOnlyBash: true,
      hookPromptTemplate: 'UI automation {{projectSlug}} {{shortHash}} {{changedFiles}} {{knowledgeMode}} {{permissionMode}}',
    },
    claudeWorkbench: { permissionMode: 'default' },
  };
  projects[SLUG2] = {
    displayName: 'Automation UI Test Other',
    localPath: TEMP_REPO2,
    gitPath: TEMP_REPO2,
    isReference: false,
    primaryLanguage: 'JavaScript',
    tags: ['test'],
    docConvention: 'frontmatter-relations',
    kbPath: TEMP_KB2,
    enabled: true,
    repoStatus: 'ok',
    headCommit: null,
    lastSeenCommit: null,
    lastAnalyzedCommit: null,
    aiProfileId: enabledProfileId(),
    kbSchemaVersion: 'v1',
    goalStatus: 'accepted',
    automation: {
      enabled: false,
      postCommitEnabled: false,
      knowledgeMode: 'requestApproval',
      allowReadOnlyBash: true,
      hookPromptTemplate: 'Other automation {{projectSlug}}',
    },
    claudeWorkbench: { permissionMode: 'default' },
  };
  fs.writeFileSync(PROJECTS_JSON, JSON.stringify(projects, null, 2) + '\n', 'utf-8');
}

function unregisterProject() {
  try {
    const projects = JSON.parse(fs.readFileSync(PROJECTS_JSON, 'utf-8'));
    if (projects[SLUG] || projects[SLUG2]) {
      delete projects[SLUG];
      delete projects[SLUG2];
      fs.writeFileSync(PROJECTS_JSON, JSON.stringify(projects, null, 2) + '\n', 'utf-8');
    }
  } catch {}
}

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

async function waitFor(fn, label, ms = 20000) {
  const deadline = Date.now() + ms;
  let last;
  while (Date.now() < deadline) {
    try {
      const got = await fn();
      if (got) return got;
    } catch (e) {
      last = e;
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`timeout: ${label}${last ? ` :: ${last.message}` : ''}`);
}

(async () => {
  initFixture();
  unregisterProject();
  registerProject();
  fs.mkdirSync(OUT_DIR, { recursive: true });
  rmrf(PROFILE);
  fs.mkdirSync(PROFILE, { recursive: true });

  const _spawned = spawnServer({ root: ROOT, port: Number(SERVER_PORT), dataDir: DATA_DIR, tag: 'automation-ui', extraEnv: { KB_AUTOMATION_FAKE_CLAUDE: '1' }, });
  DATA_DIR = _spawned.dataDir;
  PROJECTS_JSON = path.join(DATA_DIR, 'projects.json');
  const server = _spawned.child;
  let serverOutput = '';
  server.stdout.on('data', d => { serverOutput += d.toString(); });
  server.stderr.on('data', d => { serverOutput += d.toString(); });

  const chrome = spawn(CHROME, [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    `--remote-debugging-port=${CHROME_PORT}`,
    `--user-data-dir=${PROFILE}`,
    '--window-size=1440,980',
    'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });

  const errors = [];
  let debugEval = null;
  try {
    await waitFor(() => fetchJson(`${BASE_URL}/api/state`), 'server state');
    const pages = await waitFor(() => fetchJson(`http://127.0.0.1:${CHROME_PORT}/json/list`), 'chrome page list');
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
    debugEval = evalJs;

    await send('Runtime.enable');
    await send('Page.enable');
    await send('Network.enable');
    await send('Page.navigate', { url: `${BASE_URL}/` });
    await waitFor(() => evalJs('document.readyState === "complete"'), 'document ready');
    await evalJs('localStorage.setItem("kb-ui-language", "en"); location.reload()');
    await waitFor(() => evalJs('document.querySelector("#app") && document.body.innerText.includes("Project Supervision")'), 'app ready');

    await evalJs(`(() => {
      const projectBtn = [...document.querySelectorAll('aside button')].find(b => b.innerText.includes('Automation UI Test'));
      projectBtn && projectBtn.click();
      return !!projectBtn;
    })()`);
    await waitFor(() => evalJs('document.body.innerText.includes("Automation UI Test") && document.body.innerText.includes("Goal")'), 'dashboard project selected');
    await evalJs(`(() => {
      const goalBtn = document.querySelector('[data-dashboard-goal-card]');
      goalBtn && goalBtn.click();
      return !!goalBtn;
    })()`);
    await waitFor(() => evalJs('document.querySelector("[data-project-goal-modal-field=\\"content\\"]")'), 'dashboard goal modal open');
    await waitFor(() => evalJs(`(() => {
      const panel = document.querySelector('[data-project-goal-floating]');
      const ta = document.querySelector('[data-project-goal-modal-field="content"]');
      const input = document.querySelector('textarea[placeholder*="Claude"], textarea');
      const pr = panel && panel.getBoundingClientRect();
      const tr = ta && ta.getBoundingClientRect();
      return !!(panel && ta && pr.left > 240 && pr.left < 520 && pr.width >= 560 && pr.height >= 720 && tr.width >= 560 && tr.height >= 400 && document.body.innerText.includes('Claude Code'));
    })()`), 'dashboard goal editor is non-modal and spacious');
    await evalJs(`(() => {
      const panel = document.querySelector('[data-project-goal-floating]');
      const handle = document.querySelector('[data-project-goal-drag-handle]');
      if (!panel || !handle) return false;
      window.__goalLeftBefore = panel.getBoundingClientRect().left;
      handle.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 520, clientY: 140 }));
      window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 680, clientY: 210 }));
      window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 680, clientY: 210 }));
      return true;
    })()`);
    await waitFor(() => evalJs(`(() => {
      const panel = document.querySelector('[data-project-goal-floating]');
      return !!(panel && Math.abs(panel.getBoundingClientRect().left - window.__goalLeftBefore) > 40);
    })()`), 'dashboard goal editor can be dragged');
    await evalJs(`(() => {
      const ta = document.querySelector('[data-project-goal-modal-field="content"]');
      if (!ta) return false;
      ta.value = '# Goal\\n\\nDashboard modal saved project goal.';
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      const btn = [...document.querySelectorAll('button')].find(b => b.innerText.includes('Save Project Goal'));
      btn && btn.click();
      return !!btn;
    })()`);
    await waitFor(async () => {
      const state = await fetchJson(`${BASE_URL}/api/projects`);
      return state[SLUG] && state[SLUG].goalStatus === 'accepted';
    }, 'dashboard goal modal saved status');
    await waitFor(() => evalJs(`!document.querySelector('[data-project-goal-modal-field="content"]') && document.body.innerText.includes('accepted')`), 'dashboard goal card updated');

    await evalJs(`(() => {
      const btn = [...document.querySelectorAll('button')].find(b => /^Settings/.test(b.innerText.trim()));
      btn && btn.click();
      return !!btn;
    })()`);
    await waitFor(() => evalJs('document.body.innerText.includes("Project Git / Hook Settings")'), 'settings drawer open');
    await evalJs(`(() => {
      const btn = [...document.querySelectorAll('button')].find(b => b.innerText.includes('Project Git / Hook Settings'));
      btn && btn.click();
      return !!btn;
    })()`);
    await waitFor(() => evalJs('document.body.innerText.includes("Git Snapshot")'), 'project git settings');

    await evalJs(`(() => {
      const select = [...document.querySelectorAll('select')].find(s => [...s.options].some(o => o.value === '${SLUG}'));
      if (!select) return false;
      select.value = '${SLUG}';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    await waitFor(() => evalJs('document.body.innerText.includes("Enable automation") && document.body.innerText.includes("Preview prompt")'), 'automation controls');
    const savedGoal = await fetchJson(`${BASE_URL}/api/projects/${SLUG}/goal`);
    assert(savedGoal.content.includes('Dashboard modal saved project goal.'), 'goal content should persist through API');

    await evalJs(`(() => {
      const label = [...document.querySelectorAll('label')].find(l => l.innerText.includes('Enable automation'));
      const input = label && label.querySelector('input');
      if (input && !input.checked) input.click();
      const post = [...document.querySelectorAll('label')].find(l => l.innerText.includes('Run after commit'))?.querySelector('input');
      if (post && !post.checked) post.click();
      const mode = [...document.querySelectorAll('select')].find(s => [...s.options].some(o => o.value === 'directWriteKb'));
      if (mode) { mode.value = 'directWriteKb'; mode.dispatchEvent(new Event('change', { bubbles: true })); }
      const ta = [...document.querySelectorAll('textarea')].find(t => t.value.includes('UI automation') || t.value.includes('{{projectSlug}}'));
      if (ta) { ta.value = 'UI automation {{projectSlug}} {{shortHash}} {{changedFiles}} {{knowledgeMode}} {{permissionMode}}'; ta.dispatchEvent(new Event('input', { bubbles: true })); }
      return !!label;
    })()`);
    await evalJs(`(() => {
      const proxy = document.querySelector('#app')?.__vue_app__?._instance?.proxy;
      if (!proxy || typeof proxy.refreshAll !== 'function') return false;
      return Promise.resolve(proxy.refreshAll()).then(() => true);
    })()`);
    await waitFor(() => evalJs(`(() => {
      const enabled = [...document.querySelectorAll('label')].find(l => l.innerText.includes('Enable automation'))?.querySelector('input');
      const post = [...document.querySelectorAll('label')].find(l => l.innerText.includes('Run after commit'))?.querySelector('input');
      const mode = [...document.querySelectorAll('select')].find(s => [...s.options].some(o => o.value === 'directWriteKb'));
      const ta = [...document.querySelectorAll('textarea')].find(t => t.value.includes('UI automation') || t.value.includes('{{projectSlug}}'));
      return !!(enabled && enabled.checked && post && post.checked && mode && mode.value === 'directWriteKb' && ta && ta.value.includes('UI automation'));
    })()`), 'automation draft survived settings poll');
    await evalJs(`(() => {
      const btn = [...document.querySelectorAll('button')].find(b => b.innerText.includes('Preview prompt'));
      btn && btn.click();
      return !!btn;
    })()`);
    await waitFor(() => evalJs('document.body.innerText.includes("feature.txt") && document.body.innerText.includes("directWriteKb")'), 'unsaved draft preview rendered');
    await evalJs(`(() => {
      const select = [...document.querySelectorAll('select')].find(s => [...s.options].some(o => o.value === '${SLUG2}'));
      if (!select) return false;
      select.value = '${SLUG2}';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    await waitFor(async () => {
      const state = await fetchJson(`${BASE_URL}/api/projects`);
      return state[SLUG]
        && state[SLUG].automation
        && state[SLUG].automation.enabled === true
        && state[SLUG].automation.postCommitEnabled === true
        && state[SLUG].automation.knowledgeMode === 'directWriteKb'
        && state[SLUG].automation.hookPromptTemplate.includes('UI automation');
    }, 'automation draft autosaved on project switch');
    await evalJs(`(() => {
      const select = [...document.querySelectorAll('select')].find(s => [...s.options].some(o => o.value === '${SLUG}'));
      if (!select) return false;
      select.value = '${SLUG}';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    await waitFor(() => evalJs(`(() => {
      const enabled = [...document.querySelectorAll('label')].find(l => l.innerText.includes('Enable automation'))?.querySelector('input');
      const post = [...document.querySelectorAll('label')].find(l => l.innerText.includes('Run after commit'))?.querySelector('input');
      const mode = [...document.querySelectorAll('select')].find(s => [...s.options].some(o => o.value === 'directWriteKb'));
      const ta = [...document.querySelectorAll('textarea')].find(t => t.value.includes('UI automation') || t.value.includes('{{projectSlug}}'));
      return !!(enabled && enabled.checked && post && post.checked && mode && mode.value === 'directWriteKb' && ta && ta.value.includes('UI automation'));
    })()`), 'autosaved automation settings restored after switching back');
    await evalJs(`(() => {
      const ta = [...document.querySelectorAll('textarea')].find(t => t.value.includes('UI automation'));
      const panel = ta && ta.closest('.panel2');
      const btn = panel && [...panel.querySelectorAll('button')].find(b => b.innerText.includes('Save Hook settings'));
      btn && btn.click();
      return !!btn;
    })()`);
    await waitFor(() => evalJs('document.body.innerText.includes("saved.")'), 'automation settings saved');
    await waitFor(() => evalJs(`(() => {
      const root = document.querySelector('[data-automation-settings]');
      const enabled = root?.querySelector('[data-automation-field="enabled"]');
      const post = root?.querySelector('[data-automation-field="postCommitEnabled"]');
      const bash = root?.querySelector('[data-automation-field="allowReadOnlyBash"]');
      const mode = root?.querySelector('[data-automation-field="knowledgeMode"]');
      const ta = root?.querySelector('[data-automation-field="hookPromptTemplate"]');
      return !!(enabled?.checked && post?.checked && bash?.checked && mode?.value === 'directWriteKb' && ta?.value.includes('UI automation'));
    })()`), 'automation settings retained after explicit save');

    await evalJs(`(() => {
      const btn = [...document.querySelectorAll('button')].find(b => b.innerText.includes('Preview prompt'));
      btn && btn.click();
      return !!btn;
    })()`);
    await waitFor(() => evalJs('document.body.innerText.includes("feature.txt") && document.body.innerText.includes("directWriteKb")'), 'preview prompt rendered');

    await evalJs(`(() => {
      const btn = [...document.querySelectorAll('button')].find(b => b.innerText.includes('Init project KB') || b.innerText.includes('Simulate trigger'));
      btn && btn.click();
      return !!btn;
    })()`);
    await waitFor(() => evalJs('document.body.innerText.includes("dispatched:") && document.body.innerText.includes("directWriteKb")'), 'simulate trigger dispatched');

    await evalJs(`(() => {
      const projectBtn = [...document.querySelectorAll('aside button')].find(b => b.innerText.includes('Automation UI Test'));
      projectBtn && projectBtn.click();
      return !!projectBtn;
    })()`);
    await waitFor(() => evalJs('document.body.innerText.includes("Claude Code")'), 'claude workbench visible');
    await evalJs(`(() => {
      const modeBtn = [...document.querySelectorAll('button')].find(b => b.innerText.includes('Default Mode'));
      modeBtn && modeBtn.click();
      return !!modeBtn;
    })()`);
    await waitFor(() => evalJs('document.body.innerText.includes("Bypass Permissions")'), 'permission menu open');
    await evalJs(`(() => {
      const item = [...document.querySelectorAll('div')].find(d => d.innerText.trim().startsWith('Bypass Permissions'));
      item && item.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      return !!item;
    })()`);
    await waitFor(async () => {
      const state = await fetchJson(`${BASE_URL}/api/projects`);
      return state[SLUG] && state[SLUG].claudeWorkbench && state[SLUG].claudeWorkbench.permissionMode === 'bypassPermissions';
    }, 'permission mode persisted');

    assert(errors.length === 0, `console errors: ${errors.join('\n')}`);
    console.log('automation UI test passed');
    ws.close();
  } catch (e) {
    console.error('automation UI test failed:', e.message);
    if (debugEval) {
      try {
        console.error(await debugEval(`(() => {
          const panel = document.querySelector('[data-project-goal-floating]');
          const ta = document.querySelector('[data-project-goal-modal-field="content"]');
          const pr = panel && panel.getBoundingClientRect();
          const tr = ta && ta.getBoundingClientRect();
          return JSON.stringify({ panel: !!panel, textarea: !!ta, pr: pr && { width: pr.width, height: pr.height }, tr: tr && { width: tr.width, height: tr.height }, hasClaude: document.body.innerText.includes('Claude Code') });
        })()`));
        console.error(await debugEval('document.body.innerText.slice(-3000)'));
      } catch {}
    }
    if (serverOutput) console.error(serverOutput.slice(-2000));
    process.exitCode = 1;
  } finally {
    try { chrome.kill(); } catch {}
    try { server.kill(); } catch {}
    unregisterProject();
    rmrf(TEMP_REPO);
    rmrf(TEMP_KB);
    rmrf(TEMP_REPO2);
    rmrf(TEMP_KB2);
    rmrf(path.join(DATA_DIR, '_ai', SLUG));
    rmrf(path.join(DATA_DIR, '_ai', SLUG2));
    rmrf(PROFILE);
  }
})();
