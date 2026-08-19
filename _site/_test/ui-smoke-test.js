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
  const server = spawnServer({ root: ROOT, port: sitePort, dataDir: fixture.dataDir, tag: 'ui-smoke-v13', stdio: 'ignore' });
  let browser;
  try {
    await waitFor(() => requestJson(`http://127.0.0.1:${sitePort}/api/health`).then(payload => payload.ok), 'isolated server', 20000);
    browser = await launchCdpBrowser({ chrome: findChrome(), debugPort, profileDir, url: `http://127.0.0.1:${sitePort}/`, width: 1440, height: 900 });
    await waitFor(() => browser.evaluate('window.__PK_APP__ && window.__PK_APP__.getState().projects === 1'), 'v13 shell', 20000);

    const snapshot = await browser.evaluate(`(() => ({
      title: document.title,
      shell: document.querySelectorAll('.shell').length,
      sidebar: getComputedStyle(document.querySelector('.sidebar')).display,
      workbench: document.getElementById('view-workbench').classList.contains('active'),
      projects: document.querySelectorAll('#project-list .project-button').length,
      unsafeImages: document.querySelectorAll('img').length,
      xss: window.__xss,
      bodyWidth: document.body.scrollWidth,
      viewportWidth: document.documentElement.clientWidth
    }))()`);
    assert.strictEqual(snapshot.title, 'Project Knowledge');
    assert.strictEqual(snapshot.shell, 1);
    assert.notStrictEqual(snapshot.sidebar, 'none');
    assert.strictEqual(snapshot.workbench, true);
    assert.strictEqual(snapshot.projects, 1);
    assert.strictEqual(snapshot.unsafeImages, 0);
    assert.strictEqual(snapshot.xss, undefined);
    assert(snapshot.bodyWidth <= snapshot.viewportWidth + 1, 'desktop shell must not overflow horizontally');

    await browser.evaluate("document.getElementById('theme-button').click()");
    assert.strictEqual(await browser.evaluate('document.documentElement.dataset.theme'), 'dark');

    await browser.setViewport(390, 844);
    const mobile = await browser.evaluate(`(() => ({
      sidebar: getComputedStyle(document.querySelector('.sidebar')).display,
      mobileBar: getComputedStyle(document.querySelector('.mobile-bar')).display,
      bodyWidth: document.body.scrollWidth,
      viewportWidth: document.documentElement.clientWidth,
      projectUsable: document.getElementById('mobile-project').getBoundingClientRect().width > 100
    }))()`);
    assert.strictEqual(mobile.sidebar, 'none');
    assert.notStrictEqual(mobile.mobileBar, 'none');
    assert.strictEqual(mobile.projectUsable, true);
    assert(mobile.bodyWidth <= mobile.viewportWidth + 1, 'mobile shell must not overflow horizontally');

    await browser.screenshot(screenshotPath);
    assert(fs.statSync(screenshotPath).size > 10000, 'real browser screenshot should contain rendered UI');
    assert.strictEqual(browser.exceptions.length, 0, 'browser runtime exceptions: ' + JSON.stringify(browser.exceptions));
    console.log('ui smoke test PASS');
  } finally {
    if (browser) await browser.close();
    await server.cleanup();
    fixture.cleanup();
    try { fs.rmSync(screenshotPath, { force: true }); } catch {}
  }
})().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
