'use strict';
// NAV-001 — 主导航。
//
// Each click and restored hash selects one navigation entry and one page
// with matching titles. Navigation must not write product data.
//
// The regression drives the real product UI in a real browser against an
// isolated instance (own port, own data dir, own knowledge dir, own Bridge
// journal, own browser profile). Screenshots are written to
// PK_TEST_EVIDENCE_DIR when the batch sets it, so this tracked file stays
// free of machine-specific paths.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');

// One temp root per run, resolved from the caller's environment: the batch
// contract's TEMP/TMP/TMPDIR (and a CI runner's) flow into os.tmpdir(), so
// this tracked file carries no machine-specific path and never rewrites the
// process environment.
const TEMP_ROOT = os.tmpdir();

const { spawnServer } = require('./helpers/spawn-server');
const { findChrome } = require('./helpers/find-chrome');
const { launchCdpBrowser, waitFor } = require('./helpers/cdp-browser');
const { attachNetworkCapture } = require('./helpers/cdp-network-capture');
const { createUpstreamProxy } = require('./helpers/module-fixture');
const freePort = require('./helpers/free-port');

const ROOT = require("./paths").ROOT;
const ENGINE_ENTRY = path.join(path.dirname(require.resolve('@sanqianx/ai-coding-knowledge-engine/package.json', { paths: [ROOT] })), 'src', 'server.js');

const VIEWS = ['home', 'work', 'team', 'memory', 'projects', 'search', 'activity'];
const TITLES = {
  home: '首页',
  work: '开始工作',
  team: 'AI 团队',
  memory: '长期记忆',
  projects: '项目',
  search: '知识检索',
  activity: '活动记录',
};

async function main() {
  const fixture = fs.mkdtempSync(path.join(TEMP_ROOT, 'pk-product-navigation-'));
  const evidenceDir = process.env.PK_TEST_EVIDENCE_DIR ? path.resolve(process.env.PK_TEST_EVIDENCE_DIR) : path.join(fixture, 'evidence');
  fs.mkdirSync(evidenceDir, { recursive: true });
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  // The home page renders its empty-project state only after the engine
  // overview answered, so this instance runs the real vendored engine with
  // its own empty data directory (and dead vector/bridge endpoints, so it
  // can never reach a real desktop hub). The engine sits behind the shared
  // upstream proxy so the product's per-instance runtime token is rewritten
  // into the engine's own token.
  const { createEngineServer } = require(ENGINE_ENTRY);
  const engineToken = crypto.randomBytes(24).toString('hex');
  const engine = createEngineServer({
    dataDir: path.join(fixture, 'engine'),
    runtimeToken: engineToken,
    consume: false,
    debug: true,
    vectorUrl: 'http://127.0.0.1:0',
    bridgeUrl: 'http://127.0.0.1:0',
  });
  await engine.ready;
  await new Promise(resolve => engine.server.listen(0, '127.0.0.1', resolve));
  const engineUrl = `http://127.0.0.1:${engine.server.address().port}`;
  const engineProxy = createUpstreamProxy({ target: engineUrl, token: engineToken, tag: 'engine' });
  await engineProxy.start();
  const server = spawnServer({
    root: ROOT,
    port,
    dataDir: path.join(fixture, 'data'),
    tag: 'product-navigation',
    analysisOwner: 'engine',
    extraEnv: { KB_KNOWLEDGE_ENGINE_URL: engineProxy.url },
  });
  let browser;
  try {
    await waitFor(async () => {
      try { return (await fetch(base + '/api/health')).ok; } catch { return false; }
    }, 'the isolated shell', 20000);

    browser = await launchCdpBrowser({
      chrome: findChrome(),
      profileDir: path.join(fixture, 'browser'),
      url: base + '/',
      width: 1920,
      height: 1080,
    });
    await browser.setViewport(1920, 1080);
    const capture = attachNetworkCapture(browser);
    await capture.enable();
    const run = expression => browser.evaluate(expression);

    await waitFor(() => run("document.getElementById('homeContent').textContent.includes('第一个项目')"), 'the real empty home', 20000);
    assert.deepEqual(await run("[...document.querySelectorAll('nav [data-view]')].map(button => button.dataset.view)"), VIEWS);
    assert.equal(await run("document.querySelectorAll('.view').length"), VIEWS.length);
    assert.equal(await run("document.getElementById('workFrame').hasAttribute('src')"), false, 'Workbench loads on first entry to Start Work');

    const readShell = () => run(`(() => ({
      marker: window.__navMarker === undefined ? null : String(window.__navMarker),
      activeNav: [...document.querySelectorAll('[data-view].active')].map(button => button.dataset.view),
      activeView: [...document.querySelectorAll('.view.active')].map(section => section.id),
      title: (document.getElementById('pageTitle').textContent || '').trim(),
      hash: location.hash,
      href: location.href,
      navCount: document.querySelectorAll('[data-view]').length,
      documentTitle: document.title,
      workVisible: document.getElementById('view-work').getClientRects().length > 0,
    }))()`);

    const assertShell = (shell, view, phase) => {
      const where = `${phase} (href=${shell.href}, nav=${shell.navCount}, title=${shell.documentTitle}, exceptions=${JSON.stringify(browser.exceptions)})`;
      assert.deepEqual(shell.activeNav, [view], `${where}: only ${view} is the active navigation entry`);
      assert.deepEqual(shell.activeView, [`view-${view}`], `${where}: only view-${view} is the visible page`);
      assert.equal(shell.title, TITLES[view], `${where}: the page title matches ${view}`);
      assert.equal(shell.hash, `#${view}`, `${where}: the hash matches ${view}`);
      assert.equal(shell.workVisible, view === 'work', `${where}: Workbench is visible on Start Work`);
    };

    // NAV-001 expected 1 + 2: one active entry, and title/hash/selection in
    // agreement, after every navigation click.
    for (const view of VIEWS) {
      await run(`document.querySelector('[data-view="${view}"]').click()`);
      await waitFor(() => run(`document.querySelector('[data-view="${view}"]').classList.contains('active')`), `${view} becomes the active entry`);
      assertShell(await readShell(), view, `click ${view}`);
      await browser.screenshot(path.join(evidenceDir, `nav-click-${view}.png`));
    }

    // The same four properties after the hash alone restores the page.
    const bootedInto = view => shell => shell && shell.marker === null
      && shell.activeNav.length === 1 && shell.activeNav[0] === view
      && shell.activeView.length === 1 && shell.activeView[0] === `view-${view}`
      && shell.title === TITLES[view] && shell.hash === `#${view}`;
    for (const view of VIEWS) {
      await run(`location.hash = '#${view}'`);
      await waitFor(() => run(`location.hash === '#${view}'`), `the ${view} hash`);
      await run(`window.__navMarker = 'nav-${view}'`);
      await browser.send('Page.reload');
      // Readiness is the reloaded document itself reaching the target state:
      // the marker disappearing proves the document really swapped, and the
      // shell properties prove the product booted into that view - a complete
      // readyState alone cannot show that. One atomic evaluation per attempt;
      // two round-trips can straddle the document swap.
      await waitFor(async () => bootedInto(view)(await readShell()), `the reloaded ${view} page reaches its booted state`, 20000);
      assertShell(await readShell(), view, `reload ${view}`);
      await browser.screenshot(path.join(evidenceDir, `nav-reload-${view}.png`));
    }

    await run("location.hash = '#unknown-view'");
    await waitFor(() => run("location.hash === '#home' && document.querySelector('[data-view].active')?.dataset.view === 'home'"), 'an unknown hash falls back to home');
    assertShell(await readShell(), 'home', 'unknown hash falls back');
    await run("history.replaceState(null, '', '#unknown-view'); window.__navMarker = 'nav-unknown-boot'");
    await browser.send('Page.reload');
    await waitFor(async () => bootedInto('home')(await readShell()), 'an unknown hash reload falls back to home', 20000);
    assertShell(await readShell(), 'home', 'unknown hash reload falls back');
    await browser.screenshot(path.join(evidenceDir, 'nav-unknown-fallback.png'));

    // NAV-001 expected 3: moving around writes nothing.
    const writes = capture.find(entry => entry.url.includes('/api/') && !['GET', 'HEAD', 'OPTIONS'].includes(entry.method));
    assert.deepEqual(writes.map(entry => `${entry.method} ${entry.url}`), [], 'navigation performs no business write');
    const aggregated = await (await fetch(base + '/api/projects/aggregated')).json();
    assert.equal(aggregated.projects.length, 0, 'navigation registers no project');
    const brain = await (await fetch(base + '/api/brain')).json();
    assert.equal((brain.brain.domains || []).length, 0, 'navigation creates no domain');
    const registryPath = path.join(server.dataDir, 'projects.json');
    if (fs.existsSync(registryPath)) {
      const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
      assert.equal(Object.keys(registry.projects || {}).length, 0, 'the project registry stays empty');
    }
    const projectDirs = path.join(server.dataDir, 'projects');
    if (fs.existsSync(projectDirs)) assert.deepEqual(fs.readdirSync(projectDirs), [], 'no project metadata directory is created');
    assert.equal(browser.exceptions.length, 0, `no uncaught product JavaScript exceptions: ${JSON.stringify(browser.exceptions)}`);

    console.log(`product-navigation-test PASS (${VIEWS.length} pages including Start Work, click and hash reload, unknown hash fallback, no business write)`);
  } finally {
    await browser?.close();
    await server.cleanup();
    await engineProxy.close();
    await engine.close().catch(() => {});
    fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
