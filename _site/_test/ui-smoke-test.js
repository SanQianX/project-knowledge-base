const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnServer } = require('./helpers/spawn-server');
const { findChrome } = require('./helpers/find-chrome');
const { launchCdpBrowser, requestJson, waitFor } = require('./helpers/cdp-browser');
const { createLoggingUiFixture } = require('./helpers/logging-ui-fixture');

const ROOT = path.resolve(__dirname, '..', '..');
const sitePort = 7900 + (process.pid % 300);
const debugPort = 9500 + (process.pid % 300);
const profileDir = path.join(os.tmpdir(), 'pk-ui-smoke-profile-' + process.pid);
const screenshotPath = path.join(os.tmpdir(), 'pk-ui-smoke-' + process.pid + '.png');

(async () => {
  const fixture = await createLoggingUiFixture({ totalLogs: 18 });
  const server = spawnServer({
    root: ROOT,
    port: sitePort,
    dataDir: fixture.dataDir,
    tag: 'ui-smoke-v2',
    stdio: 'ignore',
  });
  let browser;
  try {
    await waitFor(
      () => requestJson('http://127.0.0.1:' + sitePort + '/api/health').then(payload => payload.ok),
      'isolated logging server',
      20000,
    );
    browser = await launchCdpBrowser({
      chrome: findChrome(),
      debugPort,
      profileDir,
      url: 'http://127.0.0.1:' + sitePort + '/',
      width: 1440,
      height: 960,
    });
    await waitFor(
      () => browser.evaluate('Boolean(window.__PK_LOG_UI__) && document.getElementById("loading-state").hidden && window.__PK_LOG_UI__.getState().entryCount > 0'),
      'logging rows',
      20000,
    );

    const snapshot = await browser.evaluate('(() => { const from = document.getElementById("filter-from").value; const to = document.getElementById("filter-to").value; return { title: document.title, appRoots: document.querySelectorAll("[data-logging-app]").length, tableRoots: document.querySelectorAll("[data-log-table]").length, rows: document.querySelectorAll("#log-rows tr").length, levels: document.querySelectorAll(".level-filter").length, rangeDays: Math.round((new Date(to + "T12:00:00") - new Date(from + "T12:00:00")) / 86400000), health: document.getElementById("health-pill").dataset.status, unsafeImages: document.querySelectorAll("#log-rows img").length, xss: window.__xss, manualControls: document.querySelectorAll("[data-install-hook], [data-analyze], [data-simulate]").length }; })()');

    assert(snapshot.title.includes('系统日志'));
    assert.strictEqual(snapshot.appRoots, 1);
    assert.strictEqual(snapshot.tableRoots, 1);
    assert(snapshot.rows >= 18, 'seeded logs must render');
    assert.strictEqual(snapshot.levels, 6);
    assert.strictEqual(snapshot.rangeDays, 6, 'local today-6 through today is seven inclusive days');
    assert.strictEqual(snapshot.health, 'ok');
    assert.strictEqual(snapshot.unsafeImages, 0, 'XSS fixture must remain text');
    assert.strictEqual(snapshot.xss, undefined, 'XSS fixture must not execute');
    assert.strictEqual(snapshot.manualControls, 0);

    await browser.evaluate('document.getElementById("theme-toggle").click()');
    assert.strictEqual(await browser.evaluate('document.documentElement.dataset.theme'), 'dark');

    await browser.setViewport(580, 820);
    const mobile = await browser.evaluate('({ rowDisplay: getComputedStyle(document.querySelector("#log-rows tr")).display, filters: getComputedStyle(document.getElementById("filter-form")).gridTemplateColumns, bodyWidth: document.body.scrollWidth, viewportWidth: document.documentElement.clientWidth })');
    assert.strictEqual(mobile.rowDisplay, 'grid');
    assert(mobile.bodyWidth <= mobile.viewportWidth + 1, 'mobile page must not overflow horizontally');

    await browser.screenshot(screenshotPath);
    assert(fs.statSync(screenshotPath).size > 10000, 'real browser screenshot should contain rendered UI');
    assert.strictEqual(browser.exceptions.length, 0, 'browser runtime exceptions: ' + JSON.stringify(browser.exceptions));
    console.log('ui smoke test PASS');
  } finally {
    if (browser) await browser.close();
    server.cleanup();
    fixture.cleanup();
    try { fs.rmSync(screenshotPath, { force: true }); } catch {}
  }
})().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
