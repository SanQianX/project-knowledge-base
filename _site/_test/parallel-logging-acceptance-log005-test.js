'use strict';
// P-LOG-ACCEPTANCE-01 LOG-005 acceptance driver (real product page in a real
// browser against an isolated managed instance).
//
// Case (qa-autopilot/config/test-cases.json LOG-005, P1):
//   steps:    写入超过100条日志，查看DOM有界且早期记录仍可查询。
//   expected: 1) DOM 渲染有界（≤100），不随总量增长。
//             2) 早期（超出首页的）记录仍可通过查询/导出获取。
//
// Real behaviour under test: the diagnostics dialog GETs pageSize=100 and
// appendLog caps #logsContent at 100 entries (ui/product.js appendLog trims
// firstElementChild), including live stream appends. With 140 seeded records
// the first page shows exactly 100; three real GOAL updates stream in and the
// DOM must stay bounded at 100. The oldest records stay reachable through the
// real query path (unique marker search in the UI), cursor pagination, export
// and the on-disk JSONL.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Portable isolation (P-QA-LOG-INTEGRATION-5025): the temp root comes from
// PK_TEST_TEMP_ROOT or os.tmpdir() and must live outside the source tree;
// HOME/APPDATA/LOCALAPPDATA/TEMP/CODEX_HOME/CLAUDE_CONFIG_DIR and the dual
// product data roots are redirected before any other module is loaded.
const { installLoggingTestEnv, resolveEvidenceDir } = require('./helpers/parallel-logging-integration-5025-env');
const lane = installLoggingTestEnv({ caseId: 'LOG-005', prefix: 'log005' });
const laneTmp = lane.laneTmp;

const { spawnServer } = require('./helpers/spawn-server');
const { findChrome } = require('./helpers/find-chrome');
const { launchCdpBrowser, waitFor } = require('./helpers/cdp-browser');
const freePort = require('./helpers/free-port');
const { createLoggingAcceptanceFixture, writeProjectLogs } = require('./helpers/parallel-logging-acceptance-fixture');
const { createObservationProxy } = require('./helpers/parallel-logging-acceptance-proxy');
// The logger names its day files by LOCAL day; the disk assertions must use
// the same clock, not the UTC day (a UTC+8 machine runs 00:00-08:00 on the
// previous UTC date).
const { localDay } = require('../lib/structured-logger');

const ROOT = path.resolve(__dirname, '../..');
const ARTIFACTS = resolveEvidenceDir(path.resolve(ROOT, 'qa-autopilot/artifacts/parallel-20261023/logging-acceptance-r1/evidence/log005'));

const PROJECT_A = 'project-log005-alpha';
const run = crypto.randomBytes(6).toString('hex');
const TOTAL = 140;
const markerOf = index => `LOG005-R-${index}-${run}`;
const GOAL_EVENT = 'goal.updated';
const GOAL_BYTES = { a: 1600, b: 1601, c: 1602 };

async function main() {
  fs.mkdirSync(ARTIFACTS, { recursive: true });
  const evidence = { caseId: 'LOG-005', startedAt: new Date().toISOString(), total: TOTAL, oldestMarker: markerOf(0), newestMarker: markerOf(TOTAL - 1), phases: {} };

  const fixture = await createLoggingAcceptanceFixture({
    caseId: 'log005',
    projects: [{ projectId: PROJECT_A, displayName: 'LOG005甲项目' }],
  });
  await writeProjectLogs(fixture.logger, PROJECT_A, Array.from({ length: TOTAL }, (_, index) => ({
    level: index % 3 === 0 ? 'info' : index % 3 === 1 ? 'warn' : 'debug',
    event: `log005.bulk.${index}`,
    message: `${markerOf(index)} LOG005 bulk record ${index}`,
    operationId: `op-log005-r${index}-${run}`,
  })));
  await fixture.logger.close();

  const port = await freePort();
  const proxyPort = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const server = spawnServer({ root: ROOT, port, dataDir: fixture.dataDir, tag: 'log005', stdio: 'ignore' });
  const putGoal = async target => {
    const content = `LOG005-LIVE ${run} ${target}`.padEnd(target, '.');
    const res = await fetch(`${base}/api/projects/${PROJECT_A}/goal`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content }) });
    return { status: res.status, bytes: Buffer.byteLength(content, 'utf8') };
  };
  let browser;
  let proxy;
  try {
    await waitFor(async () => { try { return (await fetch(`${base}/api/health`)).ok; } catch { return false; } }, 'isolated web shell', 20000);
    proxy = await createObservationProxy({ targetPort: port, port: proxyPort });
    evidence.server = { pid: server.child.pid, port, proxyPort, dataDir: fixture.dataDir };

    browser = await launchCdpBrowser({ chrome: findChrome(), profileDir: path.join(laneTmp, 'browser'), url: proxy.url, width: 1440, height: 900 });
    const runExpr = expression => browser.evaluate(expression);
    const click = selector => runExpr(`document.querySelector(${JSON.stringify(selector)}).click()`);
    const readDom = () => runExpr(`JSON.stringify({ count: document.querySelectorAll('#logsContent .log-entry').length, records: [...document.querySelectorAll('#logsContent .log-detail')].map(node => JSON.parse(node.textContent)) })`);
    evidence.browser = await runExpr('navigator.userAgent');

    await waitFor(() => runExpr(`document.getElementById('projectSelect') && document.getElementById('projectSelect').length >= 1`), 'isolated project registered', 20000);
    await runExpr(`document.getElementById('projectSelect').value = ${JSON.stringify(PROJECT_A)}; document.getElementById('projectSelect').dispatchEvent(new Event('change'))`);
    await waitFor(() => runExpr(`document.getElementById('projectSelect').value === ${JSON.stringify(PROJECT_A)}`), 'project A selected');

    // 系统状态 → 诊断 (project scope, empty search).
    await click('#openSystem');
    await runExpr(`document.getElementById('logsScope').value = 'project'`);
    await click('#openLogs');
    await waitFor(async () => {
      const dom = JSON.parse(await readDom());
      return dom.count === 100 && dom.records.length === 100;
    }, 'DOM renders exactly the 100-entry first page', 20000);
    const domPage1 = JSON.parse(await readDom());
    const oldestInPage1 = domPage1.records.some(record => (record.message || '').includes(markerOf(0)));
    const newestInPage1 = domPage1.records.some(record => (record.message || '').includes(markerOf(TOTAL - 1)));

    // expected1 (bounded): live appends must keep the DOM capped at 100.
    const putA = await putGoal(GOAL_BYTES.a);
    await waitFor(async () => {
      const dom = JSON.parse(await readDom());
      return dom.records.some(record => record.event === GOAL_EVENT && record.context && record.context.bytes === GOAL_BYTES.a);
    }, 'live append lands in the open dialog', 20000);
    const putB = await putGoal(GOAL_BYTES.b);
    const putC = await putGoal(GOAL_BYTES.c);
    await waitFor(async () => {
      const dom = JSON.parse(await readDom());
      return dom.records.some(record => record.event === GOAL_EVENT && record.context && record.context.bytes === GOAL_BYTES.c);
    }, 'all live appends received', 20000);
    const domCapped = JSON.parse(await readDom());
    const cappedIds = domCapped.records.map(record => record.id);
    evidence.phases.boundedDom = {
      page1Count: domPage1.count,
      oldestMarkerInPage1: oldestInPage1,
      newestMarkerInPage1: newestInPage1,
      liveAppends: [putA, putB, putC],
      countAfterLiveAppends: domCapped.count,
      cappedAt100: domCapped.count === 100,
      domIdsUnique: new Set(cappedIds).size === cappedIds.length,
      oldestTrimmed: !domCapped.records.some(record => (record.message || '').includes(markerOf(0))) || domCapped.count === 100,
    };
    if (domCapped.count !== 100) throw new Error(`DOM is not bounded at 100 after live appends: ${domCapped.count}`);
    if (!newestInPage1) throw new Error('first page lost the newest seeded record');
    await browser.screenshot(path.join(ARTIFACTS, 'log005-bounded-dom.png'));

    // expected2 (early records still queryable) — via the real UI search.
    await runExpr(`document.getElementById('logsSearch').value = ${JSON.stringify(markerOf(0))}`);
    await click('#loadLogs');
    await waitFor(async () => {
      const dom = JSON.parse(await readDom());
      return dom.count === 1 && dom.records.length === 1 && (dom.records[0].message || '').includes(markerOf(0));
    }, 'UI search finds the oldest (page-2) record', 20000);
    evidence.phases.uiOldestQuery = { found: true, marker: markerOf(0) };
    await browser.screenshot(path.join(ARTIFACTS, 'log005-oldest-query.png'));

    // Via cursor pagination (API parity with the UI's own query mechanics).
    const page1 = await fetch(`${base}/api/logs?pageSize=100&q=&projectId=${PROJECT_A}`).then(r => r.json());
    const page2 = await fetch(`${base}/api/logs?pageSize=100&cursor=${encodeURIComponent(page1.nextCursor)}&projectId=${PROJECT_A}`).then(r => r.json());
    const oldestApi = [...page1.entries, ...(page2.entries || [])].filter(entry => (entry.message || '').includes(markerOf(0)));
    evidence.phases.cursorPagination = {
      page1Count: page1.entries.length,
      page1NextCursor: Boolean(page1.nextCursor),
      page2Count: (page2.entries || []).length,
      page2HasOldest: oldestApi.length === 1,
    };
    if (page1.entries.length !== 100 || !page1.nextCursor) throw new Error('first page is not a full bounded page with a cursor');
    if (oldestApi.length !== 1) throw new Error('cursor pagination lost the oldest record');

    // Via export (real file re-query path).
    const exportRes = await fetch(`${base}/api/logs/export?projectId=${PROJECT_A}`);
    const exportText = await exportRes.text();
    const exportRecords = exportText.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    const exportOldest = exportRecords.filter(record => (record.message || '').includes(markerOf(0)));
    evidence.phases.export = {
      status: exportRes.status,
      contentType: exportRes.headers.get('content-type'),
      exportedCount: exportRecords.length,
      hasAllSeeded: exportRecords.filter(record => (record.message || '').includes(`LOG005-R-`)).length >= TOTAL,
      oldestExactlyOnce: exportOldest.length === 1,
    };
    if (exportRes.status !== 200 || exportOldest.length !== 1 || evidence.phases.export.hasAllSeeded === false) throw new Error('export lost early records');

    // Disk truth.
    const day = localDay();
    const projectFile = path.join(fixture.dataDir, 'logs', 'projects', PROJECT_A, `${day}.jsonl`);
    const diskRecords = fs.readFileSync(projectFile, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    const diskOldest = diskRecords.filter(record => (record.message || '').includes(markerOf(0)));
    evidence.phases.disk = {
      diskCount: diskRecords.length,
      diskSeededCount: diskRecords.filter(record => (record.message || '').includes('LOG005-R-')).length,
      oldestExactlyOnceOnDisk: diskOldest.length === 1,
    };
    if (diskRecords.filter(record => (record.message || '').includes('LOG005-R-')).length !== TOTAL) throw new Error('disk does not hold every seeded record');
    if (diskOldest.length !== 1) throw new Error('disk lost or duplicated the oldest record');

    if (browser.exceptions.length) throw new Error(`browser exceptions: ${JSON.stringify(browser.exceptions)}`);
    evidence.verdict = { 'expected1 DOM有界(≤100)': 'PASS', 'expected2 早期记录仍可查询': 'PASS' };
    console.log('LOG-005 PASS');
    process.exitCode = 0;
  } catch (error) {
    evidence.verdict = { failed: String((error && error.stack) || error) };
    try {
      if (browser) {
        evidence.debugDom = JSON.parse(await browser.evaluate(`JSON.stringify({ dialogOpen: document.getElementById('logsDialog').open, entries: document.querySelectorAll('#logsContent .log-entry').length, search: document.getElementById('logsSearch').value })`));
        evidence.debugConsoleErrors = browser.consoleErrors;
      }
      if (proxy) evidence.debugProxy = proxy.state.snapshot();
    } catch {}
    process.exitCode = 1;
    console.error(`LOG-005 FAIL: ${error.message}`);
  } finally {
    evidence.finishedAt = new Date().toISOString();
    try { if (browser) await browser.screenshot(path.join(ARTIFACTS, 'log005-final.png')); } catch {}
    fs.mkdirSync(ARTIFACTS, { recursive: true });
    fs.writeFileSync(path.join(ARTIFACTS, 'log005-evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
    try { await browser?.close(); } finally { try { if (proxy) await proxy.close(); } finally { try { await server.cleanup(); } finally { fixture.cleanup(); } } }
    lane.cleanup();
  }
}

main();
