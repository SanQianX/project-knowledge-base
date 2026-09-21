const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnServer } = require('./helpers/spawn-server');
const { findChrome } = require('./helpers/find-chrome');
const { launchCdpBrowser, requestJson, waitFor } = require('./helpers/cdp-browser');
const { createLoggingUiFixture } = require('./helpers/logging-ui-fixture');

const ROOT = path.resolve(__dirname, '..', '..');
const sitePort = 8200 + (process.pid % 250);
const profileDir = path.join(os.tmpdir(), 'pk-ui-flow-profile-' + process.pid);
const artifactDir = path.join(ROOT, '.agent-state', 'ui-v13');

async function capture(browser, name) {
  const filePath = path.join(artifactDir, name + '.png');
  await browser.screenshot(filePath);
  assert(fs.statSync(filePath).size > 10000, `screenshot ${name} must contain rendered UI`);
}

(async () => {
  const fixture = await createLoggingUiFixture({ totalLogs: 240 });
  const server = spawnServer({ root: ROOT, port: sitePort, dataDir: fixture.dataDir, tag: 'ui-flow-v13', stdio: 'ignore' });
  let browser;
  try {
    await waitFor(() => requestJson(`http://127.0.0.1:${sitePort}/api/health`).then(body => body.ok), 'flow server', 20000);
    browser = await launchCdpBrowser({ chrome: findChrome(), profileDir, url: `http://127.0.0.1:${sitePort}/`, width: 1366, height: 768 });
    await waitFor(() => browser.evaluate('window.__PK_APP__ && window.__PK_APP__.getState().projects === 1'), 'full shell', 20000);

    await browser.setViewport(1920, 1080);
    await capture(browser, '01-main-shell-1920-light');
    // T2: 聊天由内嵌终端提供 —— 壳断言嵌入视图与 iframe 挂载
    assert.strictEqual(await browser.evaluate("document.getElementById('view-terminal').classList.contains('active')"), true);
    assert.strictEqual(await browser.evaluate("document.getElementById('fr-5760').src.includes('/agent-terminal/')"), true);
    await capture(browser, '02-terminal-embed-1920-light');

    await browser.evaluate("document.querySelector('[data-go=\"import\"]').click()");
    assert.strictEqual(await browser.evaluate("document.getElementById('import-path').required"), true);
    assert.strictEqual(await browser.evaluate("document.querySelectorAll('#import-knowledge-path').length"), 1, 'Import takes an explicit knowledge address (T3.2)');
    await capture(browser, '03-import-1920-light');

    // 开发对话已迁移到 ai-coding-event-bridge 模块：设置抽屉只有日志一节
    await browser.evaluate("window.__PK_APP__.openSettings()");
    await waitFor(() => browser.evaluate("document.getElementById('settings-logs').classList.contains('active')"), 'logs settings');
    assert.strictEqual(await browser.evaluate("document.querySelectorAll('[data-settings]').length"), 1, 'settings drawer must only expose logs (conversation moved to event-bridge module)');
    await capture(browser, '04-settings-logs-1920-light');

    await browser.setViewport(1366, 768);
    await browser.evaluate("window.__PK_APP__.showSettings('logs')");
    // 等 DOM 实际渲染出全部行（loadLogs 先清空再异步渲染，只看内存状态会撞上清空间隙）
    await waitFor(() => browser.evaluate('window.__PK_APP__.getState().logCount >= 240 && document.querySelectorAll(".record-row").length >= 240'), '200+ log rows', 20000);
    const auditLogs = () => browser.evaluate(`(() => {
      const rows = [...document.querySelectorAll('.record-row')];
      const drawer = document.getElementById('settings-drawer');
      const list = document.getElementById('record-list');
      const card = document.querySelector('.logs-card').getBoundingClientRect();
      const content = document.querySelector('.settings-content').getBoundingClientRect();
      const overlaps = rows.filter(row => {
        const body = row.querySelector('.record-main').getBoundingClientRect();
        const time = row.querySelector('.record-time').getBoundingClientRect();
        return body.right + 8 > time.left;
      }).length;
      const scrollables = [...drawer.querySelectorAll('*')].filter(node => {
        const style = getComputedStyle(node);
        return /(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 1;
      }).map(node => node.id || node.className);
      const colorParts = level => {
        const row = document.querySelector('.record-entry[data-level=' + level + '] .record-row');
        return row ? [row, row.querySelector('.record-title'), row.querySelector('.record-meta'), row.querySelector('.record-time')].map(node => getComputedStyle(node).color) : [];
      };
      return {
        rows: rows.length,
        overlaps,
        scrollables,
        maxHeight: getComputedStyle(list).maxHeight,
        listOverflow: getComputedStyle(list).overflowY,
        cardBottomGap: Math.round(content.bottom - card.bottom),
        warnColors: colorParts('warn'),
        errorColors: colorParts('error'),
        severityMarks: document.querySelectorAll('.record-entry svg, .record-entry img, .record-entry .dot, .record-entry .severity').length,
        pageOverflow: document.body.scrollWidth > document.documentElement.clientWidth + 1,
        recordHeight: document.querySelector('.record-shell').getBoundingClientRect().height,
      };
    })()`);
    const desktopLogs = await auditLogs();
    assert(desktopLogs.rows >= 240);
    assert.strictEqual(desktopLogs.overlaps, 0, 'message/meta must never overlap the fixed time column');
    assert.deepStrictEqual(desktopLogs.scrollables, ['record-list'], 'record-list must be the only vertical scroller in the active logs drawer');
    assert(desktopLogs.maxHeight === 'none');
    assert.strictEqual(desktopLogs.listOverflow, 'auto');
    assert(desktopLogs.cardBottomGap <= 23, 'logs card must reach the settings content bottom');
    assert(desktopLogs.warnColors.length === 4 && new Set(desktopLogs.warnColors).size === 1, 'warn message/meta/time must share whole-row color');
    assert(desktopLogs.errorColors.length === 4 && new Set(desktopLogs.errorColors).size === 1, 'error message/meta/time must share whole-row color');
    assert.strictEqual(desktopLogs.severityMarks, 0);
    assert.strictEqual(desktopLogs.pageOverflow, false);

    await browser.evaluate("document.querySelector('.record-entry[data-level=error] .record-row').click()");
    assert.strictEqual(await browser.evaluate("document.querySelector('.record-entry[data-level=error]').classList.contains('open')"), true);
    await capture(browser, '07-logs-1366x768-expanded-light');
    await browser.evaluate("document.getElementById('record-list').scrollTop = 0");
    await browser.evaluate("fetch('/api/health?ui-sse=' + Date.now()).then(response => response.json())");
    await waitFor(() => browser.evaluate('window.__PK_APP__.getState().newLogs > 0'), 'new-record banner', 20000);
    assert.strictEqual(await browser.evaluate("document.getElementById('new-records').hidden"), false);
    assert.strictEqual(await browser.evaluate("document.getElementById('record-list').scrollTop"), 0, 'SSE append must not steal a scrolled-up position');
    await capture(browser, '08-logs-scrolled-new-banner-light');
    await browser.evaluate("document.getElementById('new-records').click()");
    await waitFor(() => browser.evaluate("window.__PK_APP__.getState().newLogs === 0 && document.getElementById('record-list').scrollHeight - document.getElementById('record-list').scrollTop - document.getElementById('record-list').clientHeight < 2"), 'return to log bottom');

    await browser.setViewport(1920, 1080);
    const tallLogs = await auditLogs();
    assert(tallLogs.recordHeight > desktopLogs.recordHeight + 200, 'record shell must grow with viewport height');
    await browser.evaluate("document.getElementById('theme-button').click()");
    assert.strictEqual(await browser.evaluate('document.documentElement.dataset.theme'), 'dark');
    await capture(browser, '09-logs-1920x1080-dark');

    await browser.setViewport(820, 900);
    const narrowLogs = await auditLogs();
    assert.strictEqual(narrowLogs.overlaps, 0);
    assert.strictEqual(narrowLogs.pageOverflow, false);
    await capture(browser, '10-logs-820x900-dark');

    await browser.setViewport(390, 844);
    const mobileLogs = await auditLogs();
    assert.strictEqual(mobileLogs.overlaps, 0);
    assert.strictEqual(mobileLogs.pageOverflow, false);
    assert.strictEqual(await browser.evaluate("getComputedStyle(document.querySelector('.settings-nav')).flexDirection"), 'row');
    await capture(browser, '11-mobile-logs-390x844-dark');

    await browser.evaluate(`(() => {
      window.__PK_APP__.showSettings('logs');
      const card = document.querySelector('#project-list .project-card');
      card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 100, clientY: 300 }));
    })()`);
    await waitFor(() => browser.evaluate("document.getElementById('context-menu').classList.contains('show')"), 'mobile context menu');
    await browser.evaluate("document.getElementById('remove-project').click()");
    await waitFor(() => browser.evaluate("document.getElementById('delete-dialog').open"), 'project delete modal');
    await capture(browser, '13-mobile-delete-modal-dark');
    assert.strictEqual(browser.exceptions.length, 0, 'browser runtime exceptions: ' + JSON.stringify(browser.exceptions));
    console.log('task15-20 UI flow test PASS');
  } finally {
    if (browser) await browser.close();
    await server.cleanup();
    fixture.cleanup();
  }
})().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
