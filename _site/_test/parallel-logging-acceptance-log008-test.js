'use strict';
// P-LOG-ACCEPTANCE-01 LOG-008 acceptance driver (real product page in a real
// browser against an isolated managed instance).
//
// Case (qa-autopilot/config/test-cases.json LOG-008, P1):
//   steps:    查询超时和导出失败分别触发。
//   expected: 1) UI显示失败。
//             2) 不能生成空文件冒充成功导出。
//
// Real behaviour under test: api() (ui/product.js:31-43) aborts GETs after
// 3s and loadLogs leaves the previous DOM intact on failure; on() toasts the
// error message. The lane observation proxy delays /api/logs by 5s (> the 3s
// timeout) for the query-timeout phase. For export failure, a file placed at
// <dataDir>/cache/exports makes exportToFile's mkdirSync throw → the route
// returns 500 → exportLogs throws 诊断导出失败。 → toast, and no download may
// appear. A control export after unblocking proves the route recovers.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Portable isolation (P-QA-LOG-INTEGRATION-5025): the temp root comes from
// PK_TEST_TEMP_ROOT or os.tmpdir() and must live outside the source tree;
// HOME/APPDATA/LOCALAPPDATA/TEMP/CODEX_HOME/CLAUDE_CONFIG_DIR and the dual
// product data roots are redirected before any other module is loaded.
const { installLoggingTestEnv, resolveEvidenceDir } = require('./helpers/parallel-logging-integration-5025-env');
const lane = installLoggingTestEnv({ caseId: 'LOG-008', prefix: 'log008' });
const laneTmp = lane.laneTmp;

const { spawnServer } = require('./helpers/spawn-server');
const { findChrome } = require('./helpers/find-chrome');
const { launchCdpBrowser, waitFor } = require('./helpers/cdp-browser');
const freePort = require('./helpers/free-port');
const { createLoggingAcceptanceFixture, writeProjectLogs } = require('./helpers/parallel-logging-acceptance-fixture');
const { createObservationProxy } = require('./helpers/parallel-logging-acceptance-proxy');

const ROOT = path.resolve(__dirname, '../..');
const ARTIFACTS = resolveEvidenceDir(path.resolve(ROOT, 'qa-autopilot/artifacts/parallel-20261023/logging-acceptance-r1/evidence/log008'));

const PROJECT_A = 'project-log008-alpha';
const run = crypto.randomBytes(6).toString('hex');
const MARK = `LOG008-Q-${run}`;

async function main() {
  fs.mkdirSync(ARTIFACTS, { recursive: true });
  const evidence = { caseId: 'LOG-008', startedAt: new Date().toISOString(), marker: MARK, phases: {} };

  const fixture = await createLoggingAcceptanceFixture({
    caseId: 'log008',
    projects: [{ projectId: PROJECT_A, displayName: 'LOG008甲项目' }],
  });
  await writeProjectLogs(fixture.logger, PROJECT_A, [
    { level: 'info', event: 'log008.seed.1', message: `LOG008 seed 1 ${run}`, operationId: `op-log008-seed-1-${run}` },
    { level: 'warn', event: 'log008.seed.2', message: `LOG008 seed 2 ${run}`, operationId: `op-log008-seed-2-${run}` },
    { level: 'info', event: `log008.hit`, message: `${MARK} 命中记录`, operationId: `op-log008-hit-${run}` },
  ]);
  await fixture.logger.close();

  const port = await freePort();
  const proxyPort = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const server = spawnServer({ root: ROOT, port, dataDir: fixture.dataDir, tag: 'log008', stdio: 'ignore' });
  let browser;
  let proxy;
  try {
    await waitFor(async () => { try { return (await fetch(`${base}/api/health`)).ok; } catch { return false; } }, 'isolated web shell', 20000);
    proxy = await createObservationProxy({ targetPort: port, port: proxyPort });
    evidence.server = { pid: server.child.pid, port, proxyPort, dataDir: fixture.dataDir };

    browser = await launchCdpBrowser({ chrome: findChrome(), profileDir: path.join(laneTmp, 'browser'), url: proxy.url, width: 1440, height: 900 });
    const runExpr = expression => browser.evaluate(expression);
    const click = selector => runExpr(`document.querySelector(${JSON.stringify(selector)}).click()`);
    const readDom = () => runExpr(`JSON.stringify({ count: document.querySelectorAll('#logsContent .log-entry').length, toastHidden: document.getElementById('toast').hidden, toastText: document.getElementById('toast').textContent })`);
    evidence.browser = await runExpr('navigator.userAgent');

    await waitFor(() => runExpr(`document.getElementById('projectSelect') && document.getElementById('projectSelect').length >= 1`), 'isolated project registered', 20000);
    await runExpr(`document.getElementById('projectSelect').value = ${JSON.stringify(PROJECT_A)}; document.getElementById('projectSelect').dispatchEvent(new Event('change'))`);
    await waitFor(() => runExpr(`document.getElementById('projectSelect').value === ${JSON.stringify(PROJECT_A)}`), 'project A selected');

    // Baseline: healthy query first (search narrows to the marker's record).
    await click('#openSystem');
    await runExpr(`document.getElementById('logsScope').value = 'project'; document.getElementById('logsSearch').value = ''`);
    await click('#openLogs');
    await waitFor(async () => {
      const dom = JSON.parse(await readDom());
      return dom.count >= 3;
    }, 'diagnostics dialog rendered the project records', 20000);
    const domBaseline = JSON.parse(await readDom());

    // expected1a (query timeout): delay /api/logs past api()'s 3s timeout.
    proxy.setDelay('/api/logs', 5000);
    await runExpr(`document.getElementById('logsSearch').value = ${JSON.stringify(MARK)}`);
    await click('#loadLogs');
    await waitFor(async () => {
      const dom = JSON.parse(await readDom());
      return !dom.toastHidden && dom.toastText.includes('状态读取超时');
    }, 'timeout toast appears for the slow query', 8000);
    const domTimeout = JSON.parse(await readDom());
    evidence.phases.queryTimeout = {
      baselineEntries: domBaseline.count,
      entriesAfterTimeout: domTimeout.count,
      toastText: domTimeout.toastText,
      previousContentPreserved: domTimeout.count === domBaseline.count,
      delayedQueryStillNotNarrowed: domTimeout.count !== 1,
    };
    if (!domTimeout.toastText.includes('状态读取超时')) throw new Error('UI did not surface the query timeout');
    if (domTimeout.count !== domBaseline.count) throw new Error('timeout wiped the previously rendered records');
    await browser.screenshot(path.join(ARTIFACTS, 'log008-query-timeout-toast.png'));
    proxy.setDelay('/api/logs', null);
    // Let the delayed response land and the toast clear before the next phase.
    await new Promise(resolve => setTimeout(resolve, 5200));

    // expected1b + expected2 (export failure): block cache/exports with a file.
    const downloadDir = path.join(ARTIFACTS, 'downloads');
    fs.mkdirSync(downloadDir, { recursive: true });
    await browser.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDir });
    const exportsPath = path.join(fixture.dataDir, 'cache', 'exports');
    const exportsWasDirectory = fs.existsSync(exportsPath) && fs.statSync(exportsPath).isDirectory();
    if (exportsWasDirectory) fs.rmSync(exportsPath, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(exportsPath), { recursive: true });
    fs.writeFileSync(exportsPath, 'blocked by LOG-008 driver');
    const downloadsBefore = fs.readdirSync(downloadDir).length;

    await runExpr(`document.getElementById('logsSearch').value = ''`);
    await click('#exportLogs');
    await waitFor(async () => {
      const dom = JSON.parse(await readDom());
      return !dom.toastHidden && dom.toastText.includes('诊断导出失败');
    }, 'export failure toast appears', 8000);
    await new Promise(resolve => setTimeout(resolve, 1500));
    const downloadsAfter = fs.readdirSync(downloadDir).length;
    const domExportFail = JSON.parse(await readDom());
    const exportProxyEntry = proxy.state.requests.filter(r => r.pathname === '/api/logs/export').slice(-1)[0] || null;
    evidence.phases.exportFailure = {
      toastText: domExportFail.toastText,
      exportStatusViaProxy: exportProxyEntry && exportProxyEntry.status,
      downloadsBefore, downloadsAfter,
      downloadedFileCount: downloadsAfter - downloadsBefore,
      noFakeEmptyFile: downloadsAfter === downloadsBefore,
    };
    if (!domExportFail.toastText.includes('诊断导出失败')) throw new Error('UI did not surface the export failure');
    if (downloadsAfter !== downloadsBefore) throw new Error('a download file appeared despite the failed export');
    await browser.screenshot(path.join(ARTIFACTS, 'log008-export-failure-toast.png'));

    // Control: unblock and confirm the export route recovers (no lasting damage).
    fs.rmSync(exportsPath, { force: true });
    const controlRes = await fetch(`${base}/api/logs/export?projectId=${PROJECT_A}`);
    const controlText = await controlRes.text();
    evidence.phases.exportRecovery = {
      status: controlRes.status,
      exportedLines: controlText.trim().split('\n').filter(Boolean).length,
    };
    if (controlRes.status !== 200 || !controlText.includes('log008.seed.1')) throw new Error('export route did not recover after unblocking');

    if (browser.exceptions.length) throw new Error(`browser exceptions: ${JSON.stringify(browser.exceptions)}`);
    evidence.verdict = { 'expected1 UI显示失败(超时+导出)': 'PASS', 'expected2 未生成空文件冒充导出成功': 'PASS' };
    console.log('LOG-008 PASS');
    process.exitCode = 0;
  } catch (error) {
    evidence.verdict = { failed: String((error && error.stack) || error) };
    try {
      if (browser) {
        evidence.debugDom = JSON.parse(await browser.evaluate(`JSON.stringify({ dialogOpen: document.getElementById('logsDialog').open, entries: document.querySelectorAll('#logsContent .log-entry').length, toast: document.getElementById('toast').textContent })`));
        evidence.debugConsoleErrors = browser.consoleErrors;
      }
      if (proxy) evidence.debugProxy = proxy.state.snapshot();
    } catch {}
    process.exitCode = 1;
    console.error(`LOG-008 FAIL: ${error.message}`);
  } finally {
    evidence.finishedAt = new Date().toISOString();
    try { if (browser) await browser.screenshot(path.join(ARTIFACTS, 'log008-final.png')); } catch {}
    fs.mkdirSync(ARTIFACTS, { recursive: true });
    fs.writeFileSync(path.join(ARTIFACTS, 'log008-evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
    try { await browser?.close(); } finally { try { if (proxy) await proxy.close(); } finally { try { await server.cleanup(); } finally { fixture.cleanup(); } } }
    lane.cleanup();
  }
}

main();
