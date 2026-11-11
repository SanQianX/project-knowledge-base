'use strict';
// NAV-001 — 五页导航。
//
// The shell owns the five-page navigation: exactly one active navigation
// entry, exactly one visible page, and a title/hash pair that matches the
// active view — both after a click and after the same page is restored from
// its hash. The retired `work` page must fall back to home from its hash
// while its hidden service mount stays in the DOM. Moving around must not
// write anything into the product.
//
// 迁移说明（五页简化 UI，见 patches/ui-test-mapping-spec.md）：
// - 导航从六页改为五页：home/memory/projects/search/activity；`work` 导航
//   按钮已删除，`nav [data-view]` 数量 6 → 5。
// - `#view-work` section 仍在 DOM（Workbench 隐藏服务挂载点，`#workFrame`
//   保留），`.view` 总数仍为 6，但 work 永远 hidden、永无 active。
// - 页面标题映射：home「智脑首页」→「首页」、projects「领域与项目」→「项目」；
//   其余不变（memory 长期记忆 / search 知识检索 / activity 活动记录）。
// - `#work` 回落：hash `#work` 经 setView 未知视图回落 home 并改写为
//   `#home`；载入时（boot）同样回落。原 work 页的点击/重载断言由
//   「#work hash 回落 + work 挂载点保持 hidden」取代。
// - 新首页空项目态依赖 /api/engine/overview 成功，因此测试实例接入真实
//   vendored 知识引擎（独立空数据目录、vector/bridge 指向死端口），经
//   createUpstreamProxy 改写 per-instance runtime token（与已迁移的
//   product-empty-state-test 相同模式）。
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

const ROOT = path.resolve(__dirname, '../..');
const ENGINE_ENTRY = path.join(path.dirname(require.resolve('@sanqianx/ai-coding-knowledge-engine/package.json', { paths: [ROOT] })), 'src', 'server.js');

const VIEWS = ['home', 'memory', 'projects', 'search', 'activity'];
const TITLES = {
  home: '首页',
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
  // The five-page home renders its empty-project state only after the engine
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
    assert.equal(await run("document.querySelectorAll('nav [data-view]').length"), 5, 'the shell exposes five navigation entries');
    assert.equal(await run("document.querySelector('[data-view=\"work\"]')"), null, 'the retired work page no longer has a navigation entry');
    assert.equal(await run("document.querySelectorAll('.view').length"), 6, 'five pages plus the hidden work service mount');

    const readShell = () => run(`(() => ({
      marker: window.__navMarker === undefined ? null : String(window.__navMarker),
      activeNav: [...document.querySelectorAll('[data-view].active')].map(button => button.dataset.view),
      activeView: [...document.querySelectorAll('.view.active')].map(section => section.id),
      title: (document.getElementById('pageTitle').textContent || '').trim(),
      hash: location.hash,
      href: location.href,
      navCount: document.querySelectorAll('[data-view]').length,
      documentTitle: document.title,
      workHidden: document.getElementById('view-work').hidden,
      workActive: document.getElementById('view-work').classList.contains('active'),
      workFrameKept: Boolean(document.getElementById('workFrame')),
    }))()`);

    const assertShell = (shell, view, phase) => {
      const where = `${phase} (href=${shell.href}, nav=${shell.navCount}, title=${shell.documentTitle}, exceptions=${JSON.stringify(browser.exceptions)})`;
      assert.deepEqual(shell.activeNav, [view], `${where}: only ${view} is the active navigation entry`);
      assert.deepEqual(shell.activeView, [`view-${view}`], `${where}: only view-${view} is the visible page`);
      assert.equal(shell.title, TITLES[view], `${where}: the page title matches ${view}`);
      assert.equal(shell.hash, `#${view}`, `${where}: the hash matches ${view}`);
      assert.equal(shell.workHidden, true, `${where}: the hidden work service mount never becomes a page`);
      assert.equal(shell.workActive, false, `${where}: view-work is never the active page`);
      assert.equal(shell.workFrameKept, true, `${where}: the workbench service mount iframe survives without a work page`);
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

    // The retired work page must fall back to home, both from a live hash
    // change and when the document boots with the stale #work hash, while its
    // service mount stays hidden in the DOM.
    await run("location.hash = '#work'");
    await waitFor(() => run("location.hash === '#home' && document.querySelector('[data-view].active')?.dataset.view === 'home'"), 'the #work hash to fall back to home');
    assertShell(await readShell(), 'home', 'work hash falls back');
    await run("history.replaceState(null, '', '#work'); window.__navMarker = 'nav-work-boot'");
    await browser.send('Page.reload');
    await waitFor(async () => bootedInto('home')(await readShell()), 'a reloaded #work page to boot into home', 20000);
    assertShell(await readShell(), 'home', 'work hash reload falls back');
    await browser.screenshot(path.join(evidenceDir, 'nav-work-fallback.png'));

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

    console.log(`product-navigation-test PASS (${VIEWS.length} pages, click + hash reload, #work falls back to home, one active entry, no business write)`);
  } finally {
    await browser?.close();
    await server.cleanup();
    await engineProxy.close();
    await engine.close().catch(() => {});
    fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
