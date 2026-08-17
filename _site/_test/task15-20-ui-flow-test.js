const assert = require('assert');
const os = require('os');
const path = require('path');
const { spawnServer } = require('./helpers/spawn-server');
const { findChrome } = require('./helpers/find-chrome');
const { launchCdpBrowser, requestJson, waitFor } = require('./helpers/cdp-browser');
const { createLoggingUiFixture } = require('./helpers/logging-ui-fixture');

const ROOT = path.resolve(__dirname, '..', '..');
const sitePort = 8200 + (process.pid % 250);
const debugPort = 9800 + (process.pid % 250);
const profileDir = path.join(os.tmpdir(), 'pk-ui-flow-profile-' + process.pid);

(async () => {
  const fixture = await createLoggingUiFixture({ totalLogs: 64 });
  const server = spawnServer({ root: ROOT, port: sitePort, dataDir: fixture.dataDir, tag: 'ui-flow-v2', stdio: 'ignore' });
  let browser;
  try {
    await waitFor(() => requestJson('http://127.0.0.1:' + sitePort + '/api/health').then(body => body.ok), 'flow server', 20000);
    browser = await launchCdpBrowser({
      chrome: findChrome(),
      debugPort,
      profileDir,
      url: 'http://127.0.0.1:' + sitePort + '/',
      width: 1360,
      height: 940,
    });
    await waitFor(() => browser.evaluate('window.__PK_LOG_UI__ && window.__PK_LOG_UI__.getState().entryCount >= 64'), 'initial log page', 20000);

    await browser.evaluate('(() => { const input = document.getElementById("filter-page-size"); input.value = "50"; input.dispatchEvent(new Event("change", { bubbles: true })); })()');
    await waitFor(() => browser.evaluate('window.__PK_LOG_UI__.getState().entryCount === 50 && Boolean(window.__PK_LOG_UI__.getState().nextCursor)'), 'first cursor page');
    assert.strictEqual(await browser.evaluate('document.getElementById("next-page").disabled'), false);

    await browser.evaluate('document.getElementById("next-page").click()');
    await waitFor(() => browser.evaluate('window.__PK_LOG_UI__.getState().page === 2 && window.__PK_LOG_UI__.getState().entryCount > 0 && document.getElementById("loading-state").hidden && !document.getElementById("previous-page").disabled'), 'second cursor page');
    assert.strictEqual(await browser.evaluate('document.getElementById("previous-page").disabled'), false);

    await browser.evaluate('document.querySelector(".level-filter[data-level=trace]").click()');
    await waitFor(() => browser.evaluate('window.__PK_LOG_UI__.getState().page === 1 && window.__PK_LOG_UI__.getState().activeLevels.length === 5'), 'filter cursor reset');
    assert.strictEqual(await browser.evaluate('document.querySelector(".level-filter[data-level=trace]").getAttribute("aria-pressed")'), 'false');

    await browser.evaluate('(() => { const input = document.getElementById("filter-operation"); input.value = "op-flow-visual"; input.dispatchEvent(new Event("input", { bubbles: true })); })()');
    await waitFor(() => browser.evaluate('window.__PK_LOG_UI__.getState().entryCount === 3'), 'operation filter');
    await browser.evaluate('document.querySelector("#log-rows tr").click()');
    await waitFor(() => browser.evaluate('document.getElementById("detail-panel").dataset.empty === "false" && document.querySelectorAll("#operation-flow .flow-step").length === 4'), 'operation detail flow');

    const detail = await browser.evaluate('({ flow: document.querySelectorAll("#operation-flow .flow-step").length, errorVisible: !document.getElementById("structured-error").hidden, stack: document.getElementById("structured-error-stack").textContent, raw: document.getElementById("raw-log").textContent, scripts: document.querySelectorAll("#detail-panel script").length, selected: window.__PK_LOG_UI__.getState().selectedId })');
    assert.strictEqual(detail.flow, 4, 'operation flow must be chronological and complete');
    assert.strictEqual(detail.errorVisible, true, 'structured error should render separately');
    assert(detail.stack.includes('VALIDATION_FAILED') || detail.stack.includes('Error'), 'long-form stack should remain readable');
    assert(detail.raw.includes('<script>window.__xss=1</script>'), 'raw JSON must preserve escaped diagnostic text');
    assert.strictEqual(detail.scripts, 0, 'raw error content must not become DOM');
    assert(detail.selected, 'selected log identity must remain stable');

    await browser.evaluate('document.getElementById("pause-button").click()');
    assert.strictEqual(await browser.evaluate('window.__PK_LOG_UI__.getState().paused'), true);
    assert.strictEqual(await browser.evaluate('document.getElementById("pause-button").getAttribute("aria-pressed")'), 'true');
    await browser.evaluate('document.getElementById("pause-button").click()');
    assert.strictEqual(await browser.evaluate('window.__PK_LOG_UI__.getState().paused'), false);

    await browser.evaluate('document.getElementById("settings-button").click()');
    await waitFor(() => browser.evaluate('document.getElementById("settings-dialog").open'), 'settings dialog');
    await browser.evaluate('(() => { document.getElementById("setting-retention").value = "30"; document.getElementById("setting-capacity").value = "1024"; document.getElementById("save-settings").click(); })()');
    await waitFor(() => browser.evaluate('!document.getElementById("settings-dialog").open'), 'settings save');
    const settings = await requestJson('http://127.0.0.1:' + sitePort + '/api/settings');
    assert.strictEqual(settings.settings.logging.retentionDays, 30);
    assert.strictEqual(settings.settings.logging.maxTotalSizeMB, 1024);

    assert.strictEqual(browser.exceptions.length, 0, 'browser runtime exceptions: ' + JSON.stringify(browser.exceptions));
    console.log('task15-20 UI flow test PASS');
  } finally {
    if (browser) await browser.close();
    server.cleanup();
    fixture.cleanup();
  }
})().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
