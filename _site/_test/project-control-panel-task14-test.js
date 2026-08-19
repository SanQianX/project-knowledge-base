const assert = require('assert');
const os = require('os');
const path = require('path');
const { spawnServer } = require('./helpers/spawn-server');
const { findChrome } = require('./helpers/find-chrome');
const { launchCdpBrowser, requestJson, waitFor } = require('./helpers/cdp-browser');
const { createLoggingUiFixture } = require('./helpers/logging-ui-fixture');

const ROOT = path.resolve(__dirname, '..', '..');
const sitePort = 8500 + (process.pid % 200);
const debugPort = 10100 + (process.pid % 200);
const profileDir = path.join(os.tmpdir(), 'pk-project-status-profile-' + process.pid);

(async () => {
  const fixture = await createLoggingUiFixture({ totalLogs: 8 });
  const server = spawnServer({ root: ROOT, port: sitePort, dataDir: fixture.dataDir, tag: 'project-status-v13', stdio: 'ignore' });
  let browser;
  try {
    await waitFor(() => requestJson(`http://127.0.0.1:${sitePort}/api/projects`).then(body => body.projects.length === 1), 'project API', 20000);
    browser = await launchCdpBrowser({ chrome: findChrome(), debugPort, profileDir, url: `http://127.0.0.1:${sitePort}/`, width: 1200, height: 860 });
    await waitFor(() => browser.evaluate('window.__PK_APP__ && window.__PK_APP__.getState().projects === 1'), 'project shell');

    const shell = await browser.evaluate(`(() => ({
      projectButtons: document.querySelectorAll('#project-list .project-card').length,
      selected: document.querySelector('#project-list .project-card.active')?.dataset.projectId,
      name: document.querySelector('#project-list .project-card.active .project-name')?.textContent,
      chip: document.getElementById('wb-project').textContent,
      path: document.querySelector('#project-list .project-card.active .project-path')?.textContent,
      workbench: !document.getElementById('view-workbench').hidden && document.getElementById('view-workbench').classList.contains('active'),
      manualControls: document.querySelectorAll('[data-install-hook], [data-uninstall-hook], [data-analyze], [data-simulate]').length,
      mainConversationLinks: [...document.querySelectorAll('.sidebar-nav .nav-btn, .mobile-strip button')].filter(node => /开发对话|运行记录|系统日志/.test(node.textContent)).length
    }))()`);
    assert.strictEqual(shell.projectButtons, 1);
    assert.strictEqual(shell.selected, fixture.projectId);
    assert.strictEqual(shell.name, '视觉检测知识库');
    assert.strictEqual(shell.chip, '视觉检测知识库');
    assert(shell.path.includes(fixture.repo.path));
    assert.strictEqual(shell.workbench, true);
    assert.strictEqual(shell.manualControls, 0);
    assert.strictEqual(shell.mainConversationLinks, 0);

    await browser.evaluate("window.__PK_APP__.openSettings('knowledge')");
    await waitFor(() => browser.evaluate("document.getElementById('settings-knowledge').classList.contains('active')"), 'knowledge settings');
    await browser.evaluate("document.getElementById('open-delete').click()");
    await waitFor(() => browser.evaluate("document.getElementById('delete-dialog').open"), 'delete modal');
    assert((await browser.evaluate("document.getElementById('delete-copy').textContent")).includes('视觉检测知识库'));
    await browser.evaluate("document.getElementById('delete-knowledge').click()");
    assert.strictEqual(await browser.evaluate("document.getElementById('delete-confirm-field').hidden"), false, 'knowledge deletion needs explicit project-id confirmation');
    assert.strictEqual(browser.exceptions.length, 0, 'browser runtime exceptions: ' + JSON.stringify(browser.exceptions));
    console.log('project control panel task14 test PASS');
  } finally {
    if (browser) await browser.close();
    await server.cleanup();
    fixture.cleanup();
  }
})().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
