'use strict';
// NAV-003 — 空项目。
//
// 迁移说明（五页简化 UI）：
// - 首页空项目态保留：成功读取登记且零项目时显示「从第一个项目开始 /
//   导入第一个项目」。新首页该态依赖 /api/engine/overview 成功，因此本
//   测试实例接入真实 vendored 知识引擎（无项目、零数据），失败注入仍只
//   针对 /api/projects/projection 的首次读取（HTTP 503）。
// - work 空态已删除：改为断言导航恰好五页不含 work、#view-work 永远
//   hidden、#workFrame 服务挂载仍在、'#work' hash 回落 home。
// - 检索页空态：#searchEmpty 已删除，检索页空态是 #searchContent 的
//   「输入关键词…」引导文案。
// - 记忆页空态：记忆库列表为空时显示「没有匹配的记忆。」（引擎可用、
//   零记忆）。
// - 项目页空态：#projectTree/#projectDetail 已删除，改为 #projectsContent
//   的「没有匹配的项目。」且无 .project-row。
//
// A brand new data directory must show real empty states, a failed registry
// read must not be presented as an empty library, and nothing may create a
// placeholder project on the way.
//
// The registry read is failed by injecting an HTTP 503 response from a proxy
// in front of the product: the read fails at the HTTP level (the browser
// really receives a failure answer), which is deliberately not a
// network-level disconnection. The regression drives the real UI in a real
// browser against an isolated instance (own port, own data dir, own knowledge
// dir, own Bridge journal, own browser profile). Screenshots are written to
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
const { createProductProxy, createUpstreamProxy } = require('./helpers/module-fixture');
const freePort = require('./helpers/free-port');

const ROOT = path.resolve(__dirname, '../..');
const ENGINE_ENTRY = path.join(path.dirname(require.resolve('@sanqianx/ai-coding-knowledge-engine/package.json', { paths: [ROOT] })), 'src', 'server.js');

async function main() {
  const fixture = fs.mkdtempSync(path.join(TEMP_ROOT, 'pk-product-empty-state-'));
  const evidenceDir = process.env.PK_TEST_EVIDENCE_DIR ? path.resolve(process.env.PK_TEST_EVIDENCE_DIR) : path.join(fixture, 'evidence');
  fs.mkdirSync(evidenceDir, { recursive: true });
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  // The new home page renders its empty-project state only after the engine
  // overview answered, so this instance runs the real vendored engine with
  // its own empty data directory (and dead vector/bridge endpoints, so it
  // can never reach a real desktop hub). The engine sits behind the shared
  // upstream proxy so the product's per-instance runtime token is rewritten
  // into the engine's own token, exactly like the parallel-nav harness.
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
    tag: 'product-empty-state',
    analysisOwner: 'engine',
    extraEnv: { KB_KNOWLEDGE_ENGINE_URL: engineProxy.url },
  });
  const proxy = createProductProxy({ target: base, tag: 'product-empty-state' });
  let browser;
  try {
    await waitFor(async () => {
      try { return (await fetch(base + '/api/health')).ok; } catch { return false; }
    }, 'the isolated shell', 20000);
    const proxyUrl = await proxy.start();

    // The very first registry read of this instance is answered with an
    // injected HTTP 503 by the proxy in front of the product.
    proxy.fail(
      entry => entry.method === 'GET' && entry.path.startsWith('/api/projects/projection'),
      503,
      '注入的登记读取故障',
      { once: true },
    );

    browser = await launchCdpBrowser({
      chrome: findChrome(),
      profileDir: path.join(fixture, 'browser'),
      url: proxyUrl + '/',
      width: 1920,
      height: 1080,
    });
    await browser.setViewport(1920, 1080);
    const capture = attachNetworkCapture(browser);
    await capture.enable();
    const run = expression => browser.evaluate(expression);

    // NAV-003 expected 2: the failed read is reported, never dressed up as an
    // empty library.
    await waitFor(() => run("document.getElementById('homeContent').textContent.includes('项目登记读取失败')"), 'the failed registry read is reported', 20000);
    const failedRead = proxy.requests.find(entry => entry.path.startsWith('/api/projects/projection'));
    assert.ok(failedRead, 'the registry read really left the browser for the product proxy');
    assert.equal(failedRead.status, 503, 'the proxy really answered the registry read with an HTTP 503 failure');
    assert.equal(await run("document.getElementById('homeContent').textContent.includes('从第一个项目开始')"), false, 'a failed read is not shown as an empty library');
    assert.equal(await run("document.querySelectorAll('#homeContent [data-action=\"refresh\"]').length"), 1, 'the failed read offers a real retry');
    await waitFor(() => run("document.getElementById('toast').textContent.includes('暂未刷新')"), 'the failed read is reported to the user', 10000);
    await browser.screenshot(path.join(evidenceDir, 'empty-state-read-failure.png'));

    // The retry reads the registry for real; now the empty state is a fact.
    await run("document.querySelector('#homeContent [data-action=\"refresh\"]').click()");
    await waitFor(() => run("document.getElementById('homeContent').textContent.includes('从第一个项目开始')"), 'the real empty home', 20000);
    assert.equal(await run("document.getElementById('homeContent').textContent.includes('导入第一个项目')"), true, 'the empty home keeps its real import entry point');
    assert.equal(await run("document.getElementById('homeContent').textContent.includes('项目登记读取失败')"), false, 'the recovered read clears the failure');
    await browser.screenshot(path.join(evidenceDir, 'empty-state-home.png'));

    // NAV-003 expected 1 (work): the workbench page is gone from the
    // navigation, keeps no empty state of its own, and survives only as the
    // hidden service mount.
    assert.deepEqual(
      await run("[...document.querySelectorAll('nav [data-view]')].map(button => button.dataset.view)"),
      ['home', 'memory', 'projects', 'search', 'activity'],
      'the navigation offers exactly the five pages',
    );
    assert.equal(await run("document.querySelector('[data-view=\"work\"]') === null"), true, 'the work navigation button is removed');
    assert.equal(await run("document.getElementById('view-work') !== null"), true, 'the work section survives in the DOM');
    assert.equal(await run("document.getElementById('view-work').hidden"), true, 'the work section stays hidden');
    assert.equal(await run("document.getElementById('workFrame') !== null"), true, 'the workbench service mount (workFrame) survives');
    assert.equal(await run("document.getElementById('workEmpty') === null"), true, 'the retired work empty state is really gone');
    await run("location.hash = '#work'");
    await waitFor(
      async () => (await run("document.getElementById('view-home').classList.contains('active')"))
        && (await run("location.hash")) === '#home',
      'the #work hash falls back to home',
      10000,
    );
    assert.equal(await run("document.getElementById('view-work').hidden"), true, 'the fallback never reveals the work section');
    await browser.screenshot(path.join(evidenceDir, 'empty-state-nav-contract.png'));

    // NAV-003 expected 1 (search): the search page shows its real empty
    // guidance instead of an embedded module.
    await run("document.querySelector('[data-view=\"search\"]').click()");
    await waitFor(() => run("document.getElementById('view-search').classList.contains('active')"), 'the search view');
    assert.equal(await run("document.getElementById('searchContent').textContent.includes('输入关键词')"), true, 'the search view shows its empty guidance');
    assert.equal(await run("document.getElementById('searchForm') !== null"), true, 'the search view offers the real search form');
    assert.equal(await run("document.getElementById('searchEmpty') === null"), true, 'the retired search empty element is really gone');
    await browser.screenshot(path.join(evidenceDir, 'empty-state-search.png'));

    // NAV-003 expected 1 (memory): an empty memory library is a fact of the
    // engine, not a placeholder list.
    await run("document.querySelector('[data-view=\"memory\"]').click()");
    await waitFor(() => run("document.getElementById('view-memory').classList.contains('active')"), 'the memory view');
    await waitFor(() => run("document.getElementById('memoryContent').textContent.includes('没有匹配的记忆')"), 'the real empty memory library', 20000);
    assert.equal(await run("document.querySelectorAll('#memoryContent .memory-item').length"), 0, 'the memory library lists no memory');
    await browser.screenshot(path.join(evidenceDir, 'empty-state-memory.png'));

    // NAV-003 expected 1 (projects): the project page shows its real empty
    // state.
    await run("document.querySelector('[data-view=\"projects\"]').click()");
    await waitFor(() => run("document.getElementById('view-projects').classList.contains('active')"), 'the projects view');
    await waitFor(() => run("document.getElementById('projectsContent').textContent.includes('没有匹配的项目')"), 'the real empty project list', 20000);
    assert.equal(await run("document.querySelectorAll('#projectsContent .project-row').length"), 0, 'the project page lists no project');
    await browser.screenshot(path.join(evidenceDir, 'empty-state-projects.png'));

    const brain = await (await fetch(base + '/api/brain')).json();
    assert.equal((brain.brain.domains || []).length, 0, 'a fresh instance owns no domain');

    // NAV-003 expected 3: nothing created a placeholder project.
    assert.equal(await run("document.getElementById('projectSelect').disabled"), true, 'the project selector stays disabled');
    assert.equal(await run("document.getElementById('projectSelect').value"), '', 'no project is selected');
    assert.equal(await run("localStorage.getItem('kb.project')"), null, 'no project id is remembered');
    const aggregated = await (await fetch(base + '/api/projects/aggregated')).json();
    assert.equal(aggregated.projects.length, 0, 'the product registers no project');
    const registryPath = path.join(server.dataDir, 'projects.json');
    if (fs.existsSync(registryPath)) {
      const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
      assert.equal(Object.keys(registry.projects || {}).length, 0, 'the project registry stays empty');
    }
    const projectDirs = path.join(server.dataDir, 'projects');
    assert.equal(fs.existsSync(projectDirs) ? fs.readdirSync(projectDirs).length : 0, 0, 'no project metadata directory is created');
    const writes = capture.find(entry => entry.url.includes('/api/') && !['GET', 'HEAD', 'OPTIONS'].includes(entry.method));
    assert.deepEqual(writes.map(entry => `${entry.method} ${entry.url}`), [], 'the empty state never writes a project');
    assert.equal(browser.exceptions.length, 0, `no uncaught product JavaScript exceptions: ${JSON.stringify(browser.exceptions)}`);

    console.log('product-empty-state-test PASS (real empty states, a failed read is not an empty library, no placeholder project)');
  } finally {
    await browser?.close();
    await proxy.close();
    await server.cleanup();
    await engineProxy.close();
    await engine.close().catch(() => {});
    fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
