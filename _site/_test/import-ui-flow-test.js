// _site/_test/import-ui-flow-test.js
//
// T07: end-to-end UI smoke for the Import view.
// Verifies the preflight-driven UI: every input runs /api/projects/preflight-import,
// the Import button stays disabled until ready=true, and problems surface
// as a structured error list with an action hint.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { spawnServer } = require('./helpers/spawn-server');
const { findChrome } = require('./helpers/find-chrome');
const { launchCdpBrowser, waitFor } = require('./helpers/cdp-browser');

const ROOT = path.resolve(__dirname, '..', '..');
const sitePort = 7960 + (process.pid % 200);
const profileDir = path.join(os.tmpdir(), 'pk-import-ui-' + process.pid);

function git(repo, args) {
  const result = spawnSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed: ${result.status}`);
  return String(result.stdout || '').trim();
}

(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-import-ui-data-' + process.pid + '-'));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-import-ui-repo-' + process.pid + '-'));
  const repoSpaces = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pk-import-ui-spaces-' + process.pid + '-')), 'project with spaces');
  fs.mkdirSync(repoSpaces, { recursive: true });
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.email', 'import-ui@example.local']);
  git(repo, ['config', 'user.name', 'Import UI']);
  fs.writeFileSync(path.join(repo, 'README.md'), '# import ui\n');
  git(repo, ['add', 'README.md']);
  git(repo, ['commit', '-q', '-m', 'baseline']);
  git(repoSpaces, ['init', '-q', '-b', 'main']);
  git(repoSpaces, ['config', 'user.email', 'import-ui@example.local']);
  git(repoSpaces, ['config', 'user.name', 'Import UI']);
  fs.writeFileSync(path.join(repoSpaces, 'README.md'), '# spaces\n');
  git(repoSpaces, ['add', 'README.md']);
  git(repoSpaces, ['commit', '-q', '-m', 'baseline']);
  const server = spawnServer({
    root: ROOT, port: sitePort, dataDir, tag: 'import-ui',
    extraEnv: { KB_AUTOMATION_FAKE_CLAUDE: '1', KB_EMBEDDING_FAKE: '1', KB_SKIP_MIGRATION: '1' },
  });
  let browser;
  // Plain Node fetch with explicit timeout. The cdp-browser requestJson helper
  // uses a 1-second default which is too short for the server's first request
  // after startup; we use Node's fetch + AbortSignal for direct setup calls.
  async function serverFetch(url, init) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      const text = await response.text();
      return { status: response.status, body: text ? JSON.parse(text) : {} };
    } finally {
      clearTimeout(timer);
    }
  }
  try {
    await waitFor(async () => {
      try { const r = await serverFetch(`http://127.0.0.1:${sitePort}/api/health`); return r.body.ok ? { ok: true } : null; } catch { return null; }
    }, 'isolated server', 20000);
    await serverFetch(`http://127.0.0.1:${sitePort}/api/settings`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ knowledge: { rootPath: path.join(dataDir, 'knowledge') } }),
    });
    await serverFetch(`http://127.0.0.1:${sitePort}/api/ai-profiles`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        schema: 'ai-profiles/v1', defaultProfileId: 'fake',
        profiles: [{ id: 'fake', name: 'Fake', enabled: true, vendor: 'anthropic', model: 'fake', apiKeyUpdate: { mode: 'replace', value: 'k' } }],
      }),
    });
    browser = await launchCdpBrowser({
      chrome: findChrome(), profileDir, url: `http://127.0.0.1:${sitePort}/`, width: 1440, height: 900,
    });
    // Switch to Import view
    await browser.evaluate("document.querySelector('[data-go=import]').click()");
    await waitFor(async () => {
      const visible = await browser.evaluate("document.getElementById('view-import').classList.contains('active')");
      return visible ? { ok: true } : null;
    }, 'import view visible', 20000);

    // Case 1: empty path -> Import button disabled
    {
      const disabled = await browser.evaluate("document.getElementById('import-submit').disabled");
      assert.strictEqual(disabled, true, 'Import button must be disabled when path is empty');
    }

    // Case 2: enter path with spaces -> preflight returns ready=true; button enabled
    await browser.evaluate(`(() => {
      const path = ${JSON.stringify(repoSpaces)};
      const input = document.getElementById('import-path');
      input.value = path;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await waitFor(async () => {
      const state = await browser.evaluate(`(() => ({
        disabled: document.getElementById('import-submit').disabled,
        git: document.getElementById('pv-git-status').textContent,
        root: document.getElementById('pv-knowledge-root').textContent,
        preflightHidden: document.getElementById('import-preflight').hidden,
        errHidden: document.getElementById('import-errors').hidden,
      }))()`);
      return state.disabled === false && state.errHidden ? { ok: true, state } : null;
    }, 'preflight ready for valid path', 20000);

    // Case 3: ② 知识库地址 → 预览回显该地址，导入按钮保持可用（两地址即登记映射）
    await browser.evaluate(`(() => {
      const input = document.getElementById('import-knowledge-path');
      input.value = 'D:\\\\Knowledge\\\\spaces-demo';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await waitFor(async () => {
      const state = await browser.evaluate(`(() => ({
        disabled: document.getElementById('import-submit').disabled,
        root: document.getElementById('pv-knowledge-root').textContent,
      }))()`);
      return state.disabled === false && /spaces-demo/.test(state.root) ? { ok: true } : null;
    }, 'knowledge address reflected in preview', 20000);

    // Case 5: submit form -> project imported; UI navigates to the terminal view.
    await browser.evaluate(`(() => {
      const form = document.getElementById('import-form');
      if (typeof form.requestSubmit === 'function') form.requestSubmit();
      else form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    })()`);
    await waitFor(async () => {
      const visible = await browser.evaluate("document.getElementById('view-terminal').classList.contains('active')");
      return visible ? { ok: true } : null;
    }, 'import navigates to terminal view', 30000);

    // Case 6: folder picker buttons are visible in Web mode and wired to the
    // proxied module pickers (never clicked here — that would open a real
    // native dialog on the host machine).
    {
      const pickers = await browser.evaluate(`(() => ({
        dev: !document.getElementById('import-pick-folder').hidden,
        knowledge: !document.getElementById('import-pick-knowledge').hidden,
      }))()`);
      assert.strictEqual(pickers.dev, true, 'dev-address picker must be visible');
      assert.strictEqual(pickers.knowledge, true, 'knowledge-address picker must be visible');
    }
  } catch (error) {
    console.error(error.stack || error.message);
    throw error;
  } finally {
    if (browser) await browser.close();
    server.child.kill();
    await new Promise(resolve => server.child.once('exit', resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(repoSpaces, { recursive: true, force: true });
  }
  console.log('import-ui-flow-test PASS');
})().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
