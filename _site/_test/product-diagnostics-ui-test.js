'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawnServer } = require('./helpers/spawn-server');
const { findChrome } = require('./helpers/find-chrome');
const { launchCdpBrowser, waitFor } = require('./helpers/cdp-browser');
const { createLoggingUiFixture } = require('./helpers/logging-ui-fixture');
const ROOT = path.resolve(__dirname, '../..');

async function main() {
  const fixture = await createLoggingUiFixture({ totalLogs: 240 });
  const offline = http.createServer((req, res) => { res.writeHead(503, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: { message: '验收中的离线模块' } })); });
  await new Promise(resolve => offline.listen(0, '127.0.0.1', resolve));
  const offlineUrl = `http://127.0.0.1:${offline.address().port}`;
  const port = 8050 + process.pid % 200;
  const base = `http://127.0.0.1:${port}`;
  const server = spawnServer({ root: ROOT, port, dataDir: fixture.dataDir, tag: 'product-diagnostics-ui', analysisOwner: 'engine', extraEnv: {
    KB_TERMINAL_URL: offlineUrl, KB_VECTORHUB_URL: offlineUrl, KB_EVENTBRIDGE_URL: offlineUrl, KB_KNOWLEDGE_ENGINE_URL: offlineUrl,
  } });
  let browser;
  try {
    await waitFor(async () => { try { return (await fetch(base + '/api/health')).ok; } catch { return false; } }, 'web shell', 20000);
    browser = await launchCdpBrowser({ chrome: findChrome(), profileDir: path.join(fixture.dataDir, 'browser'), url: base, width: 1920, height: 1080 });
    await browser.setViewport(1920, 1080);
    const run = expression => browser.evaluate(expression);
    const click = selector => run(`document.querySelector(${JSON.stringify(selector)}).click()`);
    await waitFor(() => run(`document.getElementById('projectSelect').value === ${JSON.stringify(fixture.projectId)}`), 'registry projection');
    for (const view of ['home', 'memory', 'projects', 'activity']) {
      await click(`[data-view="${view}"]`); assert.equal(await run('document.documentElement.scrollWidth > innerWidth'), false, view);
    }
    assert.ok(await run("document.getElementById('projectDetail').textContent.includes('视觉检测知识库')"));
    assert.ok(await run("document.getElementById('activityUpdates').textContent.includes('离线')"), 'offline cannot masquerade as empty/success');
    await click('#openSystem'); await click('#openLogs');
    await waitFor(() => run("document.querySelectorAll('#logsContent .log-entry').length === 100"), 'bounded diagnostic rendering');
    assert.equal(await run("document.querySelectorAll('#logsDialog img, #logsDialog script').length"), 0);
    await run("document.getElementById('logsSearch').value='<img src=x onerror=window.__xss=1>'"); await click('#loadLogs');
    await waitFor(() => run("document.querySelectorAll('#logsContent .log-entry').length === 1"), 'real server query filter');
    assert.equal(await run('window.__xss'), undefined);
    await run("document.getElementById('logsSearch').value='模型输出校验失败'"); await click('#loadLogs');
    await waitFor(() => run("document.querySelectorAll('#logsContent .log-entry').length === 1 && document.getElementById('logsContent').textContent.includes('VALIDATION_FAILED')"), 'retained error detail');
    await click('#logsContent summary');
    assert.equal(await run("document.querySelector('#logsContent details').open"), true);
    assert.ok(await run("document.querySelector('#logsContent .log-detail').textContent.includes('promotionStep')"), 'failure stack remains diagnosable');
    assert.equal(await run('window.__xss'), undefined);
    await browser.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: fixture.dataDir });
    await click('#exportLogs');
    const exportFile = path.join(fixture.dataDir, 'knowledge-diagnostics.jsonl');
    await waitFor(() => fs.existsSync(exportFile), 'UI diagnostic export');
    const entries = fs.readFileSync(exportFile, 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line));
    assert.equal(entries.length, 1); assert.equal(entries[0].projectId, fixture.projectId);
    await click('[data-close="logsDialog"]'); await click('#themeToggle');
    await browser.send('Page.navigate', { url: base + '/#projects' });
    await waitFor(() => run("document.getElementById('projectDetail').textContent.includes('视觉检测知识库')"), 'reload');
    assert.equal(await run('document.documentElement.dataset.theme'), 'dark');
    const codeFiles = fs.readdirSync(fixture.repo.path);
    // The registry does not own knowledge bytes. Use its actual double-directory binding.
    const project = (await (await fetch(base + '/api/projects/aggregated')).json()).projects[0];
    const retained = path.join(project.knowledgePath, 'keep.md'); fs.writeFileSync(retained, '# 保留知识\n');
    await run('window.confirm = () => true'); await click('[data-action="unbind"]');
    await waitFor(() => run("document.getElementById('toast').textContent.includes('无法安全停止写入')"), 'offline writer prevents unsafe unbind');
    assert.equal((await (await fetch(base + '/api/projects/aggregated')).json()).projects.length, 1);
    assert.deepEqual(fs.readdirSync(fixture.repo.path), codeFiles); assert.ok(fs.existsSync(retained));
    assert.equal(browser.exceptions.length, 0, JSON.stringify(browser.exceptions));
    console.log('product-diagnostics-ui-test PASS (1920x1080; XSS/filter/expanded failure/export/theme/offline writer protection)');
  } catch (error) {
    if (browser) console.error(await browser.evaluate("JSON.stringify({ toast:document.getElementById('toast').textContent, project:document.getElementById('projectSelect').value, detail:document.getElementById('projectDetail').textContent })"));
    throw error;
  } finally {
    await browser?.close(); await server.cleanup(); offline.closeAllConnections(); await new Promise(resolve => offline.close(resolve)); fixture.cleanup();
  }
}
main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
