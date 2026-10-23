'use strict';
// NAV-003 — 空项目。
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
const { createProductProxy } = require('./helpers/module-fixture');
const freePort = require('./helpers/free-port');

const ROOT = path.resolve(__dirname, '../..');

async function main() {
  const fixture = fs.mkdtempSync(path.join(TEMP_ROOT, 'pk-product-empty-state-'));
  const evidenceDir = process.env.PK_TEST_EVIDENCE_DIR ? path.resolve(process.env.PK_TEST_EVIDENCE_DIR) : path.join(fixture, 'evidence');
  fs.mkdirSync(evidenceDir, { recursive: true });
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const server = spawnServer({
    root: ROOT,
    port,
    dataDir: path.join(fixture, 'data'),
    tag: 'product-empty-state',
    analysisOwner: 'engine',
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
    assert.equal(await run("document.getElementById('homeContent').textContent.includes('项目登记读取失败')"), false, 'the recovered read clears the failure');
    await browser.screenshot(path.join(evidenceDir, 'empty-state-home.png'));

    // NAV-003 expected 1: work, search, domains and projects show empty
    // states.
    await run("document.querySelector('[data-view=\"work\"]').click()");
    await waitFor(() => run("document.getElementById('view-work').classList.contains('active')"), 'the work view');
    assert.equal(await run("document.getElementById('workEmpty').hidden"), false, 'the work view shows its empty state');
    assert.equal(await run("document.getElementById('workEmpty').textContent.includes('导入项目后')"), true, 'the work empty state explains what is missing');
    assert.equal(await run("document.getElementById('workLayout').hidden"), true, 'the work layout stays hidden without a project');
    await browser.screenshot(path.join(evidenceDir, 'empty-state-work.png'));

    await run("document.querySelector('[data-view=\"search\"]').click()");
    await waitFor(() => run("document.getElementById('view-search').classList.contains('active')"), 'the search view');
    assert.equal(await run("document.getElementById('searchEmpty').hidden"), false, 'the search view shows its empty state');
    assert.equal(await run("document.getElementById('searchEmpty').textContent.includes('尚未导入项目')"), true, 'the search empty state explains what is missing');
    await browser.screenshot(path.join(evidenceDir, 'empty-state-search.png'));

    await run("document.querySelector('[data-view=\"projects\"]').click()");
    await waitFor(() => run("document.getElementById('view-projects').classList.contains('active')"), 'the projects view');
    assert.equal(await run("document.getElementById('projectTree').textContent.includes('暂无项目')"), true, 'the project tree shows the empty group');
    assert.equal(await run("document.getElementById('projectTree').textContent.includes('未分组')"), true, 'the empty project tree still shows the ungrouped domain');
    assert.equal(await run("document.getElementById('projectDetail').textContent.includes('尚未导入项目')"), true, 'the project detail shows the empty state');
    await browser.screenshot(path.join(evidenceDir, 'empty-state-projects.png'));

    const brain = await (await fetch(base + '/api/brain')).json();
    assert.equal((brain.brain.domains || []).length, 0, 'a fresh instance owns no domain');

    // NAV-003 expected 3: nothing created a placeholder project.
    assert.equal(await run("document.querySelectorAll('#projectTree [data-select-project]').length"), 0, 'the project tree offers no project');
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
    fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
