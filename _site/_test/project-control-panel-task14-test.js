const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnServer } = require('./helpers/spawn-server');
const { findChrome } = require('./helpers/find-chrome');
const { launchCdpBrowser, requestJson, waitFor } = require('./helpers/cdp-browser');
const { createLoggingUiFixture } = require('./helpers/logging-ui-fixture');

const ROOT = path.resolve(__dirname, '..', '..');
const html = fs.readFileSync(path.join(ROOT, 'ui', 'index.html'), 'utf8');
const sitePort = 8500 + (process.pid % 200);
const debugPort = 10100 + (process.pid % 200);
const profileDir = path.join(os.tmpdir(), 'pk-project-status-profile-' + process.pid);

assert(html.includes('data-hook-readonly'), 'read-only managed Hook project status is required');
assert(!html.includes('data-install-hook') && !html.includes('data-uninstall-hook'), 'Hook mutation controls must be absent');
assert(!html.includes('remove-project') && !html.includes('DELETE", "/api/projects/'), 'focused logging UI must not mutate projects');

(async () => {
  const fixture = await createLoggingUiFixture({ totalLogs: 8 });
  const server = spawnServer({ root: ROOT, port: sitePort, dataDir: fixture.dataDir, tag: 'project-status-v2', stdio: 'ignore' });
  let browser;
  try {
    await waitFor(() => requestJson('http://127.0.0.1:' + sitePort + '/api/projects').then(body => body.projects.length === 1), 'project API', 20000);
    browser = await launchCdpBrowser({
      chrome: findChrome(),
      debugPort,
      profileDir,
      url: 'http://127.0.0.1:' + sitePort + '/',
      width: 1200,
      height: 860,
    });
    await waitFor(() => browser.evaluate('document.querySelectorAll("#filter-project option").length === 2'), 'project filter options');
    await browser.evaluate('(() => { const select = document.getElementById("filter-project"); select.value = "visual-project"; select.dispatchEvent(new Event("change", { bubbles: true })); })()');
    await waitFor(() => browser.evaluate('window.__PK_LOG_UI__.getState().filters.projectId === "visual-project" && document.getElementById("project-status-name").textContent.includes("视觉检测知识库")'), 'read-only project status');

    const status = await browser.evaluate('({ name: document.getElementById("project-status-name").textContent, hook: document.getElementById("project-hook-status").textContent, analysis: document.getElementById("project-analysis-status").textContent, index: document.getElementById("project-index-status").textContent, controls: document.querySelectorAll("[data-hook-readonly] button").length, filtered: window.__PK_LOG_UI__.getState().filters.projectId })');
    assert(status.name.includes('视觉检测知识库'));
    assert(status.name.includes(fixture.repo.path));
    assert(/^managed\/v2$/.test(status.hook), 'managed Hook version must be read-only');
    assert(status.analysis.length > 0);
    assert(status.index.includes('ready'));
    assert.strictEqual(status.controls, 0);
    assert.strictEqual(status.filtered, fixture.projectId);
    console.log('project control panel task14 test PASS');
  } finally {
    if (browser) await browser.close();
    server.cleanup();
    fixture.cleanup();
  }
})().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
