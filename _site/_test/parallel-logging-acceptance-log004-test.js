'use strict';
// P-LOG-ACCEPTANCE-01 LOG-004 查询-订阅交界 acceptance driver (real product page
// in a real browser against an isolated managed instance).
//
// Case (qa-autopilot/config/test-cases.json LOG-004, P1):
//   steps:    系统状态→诊断，在查询与订阅交界插入新记录，检查无丢失无重复；
//             关闭窗口后流断开。
//   expected: 1) 交界插入的记录在DOM与流中不丢失不重复。
//             2) 关闭窗口后无残留订阅、流断开。
//
// Real behaviour under test: loadLogs (ui/product.js) GETs /api/logs then
// subscribes the stream channel (live-client.js multiplexes /api/live WS;
// the live-gateway re-fetches /api/logs/stream SSE with a streamCursor
// watermark and replays with dedup, so boundary inserts must arrive exactly
// once). New project records are inserted through the REAL project GOAL.md
// update API (PUT /api/projects/<id>/goal → logger.info goal.updated with
// context.bytes; a unique byte size identifies each insert).
//
// Lane finding (documented separately, server-app.js is read-only for this
// lane): POST /api/hooks/post-commit with a semantically invalid event makes
// the background task reject; the route drops taskForProject's promise, the
// unhandledRejection process handler then terminates the whole server
// (reproduced in parallel-logging-acceptance-log004-probe.js).

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Portable isolation (P-QA-LOG-INTEGRATION-5025): the temp root comes from
// PK_TEST_TEMP_ROOT or os.tmpdir() and must live outside the source tree;
// HOME/APPDATA/LOCALAPPDATA/TEMP/CODEX_HOME/CLAUDE_CONFIG_DIR and the dual
// product data roots are redirected before any other module is loaded.
const { installLoggingTestEnv, resolveEvidenceDir } = require('./helpers/parallel-logging-integration-5025-env');
const lane = installLoggingTestEnv({ caseId: 'LOG-004', prefix: 'log004' });
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
const ARTIFACTS = resolveEvidenceDir(path.resolve(ROOT, 'qa-autopilot/artifacts/parallel-20261023/logging-acceptance-r1/evidence/log004'));

const PROJECT_A = 'project-log004-alpha';
const run = crypto.randomBytes(6).toString('hex');
const GOAL_EVENT = 'goal.updated';
const GOAL_BYTES = { insert1: 1500, insert2: 1501, insert3: 1502 };
const goalContent = target => `LOG004-LIVE ${run} ${target}`.padEnd(target, '.');

async function main() {
  fs.mkdirSync(ARTIFACTS, { recursive: true });
  const evidence = { caseId: 'LOG-004', startedAt: new Date().toISOString(), inserts: GOAL_BYTES, phases: {} };

  const fixture = await createLoggingAcceptanceFixture({
    caseId: 'log004',
    projects: [{ projectId: PROJECT_A, displayName: 'LOG004甲项目' }],
  });
  await writeProjectLogs(fixture.logger, PROJECT_A, [
    { level: 'info', event: 'log004.seed.1', message: `LOG004 seed 1 ${run}`, operationId: `op-log004-seed-1-${run}` },
    { level: 'warn', event: 'log004.seed.2', message: `LOG004 seed 2 ${run}`, operationId: `op-log004-seed-2-${run}` },
    { level: 'info', event: 'log004.seed.3', message: `LOG004 seed 3 ${run}`, operationId: `op-log004-seed-3-${run}` },
  ]);
  await fixture.logger.close();

  const port = await freePort();
  const proxyPort = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const server = spawnServer({ root: ROOT, port, dataDir: fixture.dataDir, tag: 'log004', stdio: 'ignore' });
  const putGoal = async target => {
    const content = goalContent(target);
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
    const readDom = () => runExpr(`JSON.stringify({ count: document.querySelectorAll('#logsContent .log-entry').length, records: [...document.querySelectorAll('#logsContent .log-detail')].map(node => JSON.parse(node.textContent)), liveStats: window.KnowledgeLive ? KnowledgeLive.stats() : null })`);
    evidence.browser = await runExpr('navigator.userAgent');

    await waitFor(() => runExpr(`document.getElementById('projectSelect') && document.getElementById('projectSelect').length >= 1`), 'isolated project registered', 20000);
    await runExpr(`document.getElementById('projectSelect').value = ${JSON.stringify(PROJECT_A)}; document.getElementById('projectSelect').dispatchEvent(new Event('change'))`);
    await waitFor(() => runExpr(`document.getElementById('projectSelect').value === ${JSON.stringify(PROJECT_A)}`), 'project A selected');

    // 系统状态 → 诊断, project scope, empty search → snapshot + live stream.
    await click('#openSystem');
    await runExpr(`document.getElementById('logsScope').value = 'project'`);
    await click('#openLogs');
    await waitFor(async () => {
      const dom = JSON.parse(await readDom());
      return dom.count >= 3 && dom.records.length === dom.count;
    }, 'project A diagnostics rendered', 20000);

    // Boundary insert #1: fire the real GOAL update while the query→subscribe
    // hand-off is in progress.
    const put1 = await putGoal(GOAL_BYTES.insert1);
    await waitFor(async () => {
      const dom = JSON.parse(await readDom());
      return dom.records.filter(record => record.event === GOAL_EVENT && record.context && record.context.bytes === GOAL_BYTES.insert1).length === 1;
    }, 'boundary insert #1 (during query→subscribe hand-off) appears in the DOM exactly once', 20000);

    // Insert #2 after the stream has settled: steady-state live append.
    await new Promise(resolve => setTimeout(resolve, 600));
    const put2 = await putGoal(GOAL_BYTES.insert2);
    await waitFor(async () => {
      const dom = JSON.parse(await readDom());
      return dom.records.filter(record => record.event === GOAL_EVENT && record.context && record.context.bytes === GOAL_BYTES.insert2).length === 1;
    }, 'steady-state insert #2 appears in the DOM exactly once', 20000);

    const domLive = JSON.parse(await readDom());
    const domIds = domLive.records.map(record => record.id);
    const uniqueDomIds = new Set(domIds).size === domIds.length;
    evidence.phases.boundaryNoLossNoDup = {
      put1, put2,
      insert1InDom: domLive.records.filter(record => record.event === GOAL_EVENT && record.context && record.context.bytes === GOAL_BYTES.insert1).length,
      insert2InDom: domLive.records.filter(record => record.event === GOAL_EVENT && record.context && record.context.bytes === GOAL_BYTES.insert2).length,
      domEntryCount: domLive.count,
      domIdsUnique: uniqueDomIds,
      liveStats: domLive.liveStats,
    };
    if (evidence.phases.boundaryNoLossNoDup.insert1InDom !== 1 || evidence.phases.boundaryNoLossNoDup.insert2InDom !== 1) throw new Error('boundary insert was lost or duplicated in the DOM');
    if (!uniqueDomIds) throw new Error('DOM rendered duplicate record ids');

    // API parity for the same filters the UI holds.
    const getAll = await fetch(`${base}/api/logs?pageSize=100&q=&projectId=${PROJECT_A}`).then(r => r.json());
    const apiInsert1 = getAll.entries.filter(entry => entry.event === GOAL_EVENT && entry.context && entry.context.bytes === GOAL_BYTES.insert1);
    const apiInsert2 = getAll.entries.filter(entry => entry.event === GOAL_EVENT && entry.context && entry.context.bytes === GOAL_BYTES.insert2);
    evidence.phases.apiParity = {
      apiInsert1Count: apiInsert1.length,
      apiInsert2Count: apiInsert2.length,
      apiInsert1Ids: apiInsert1.map(entry => entry.id),
      apiInsert2Ids: apiInsert2.map(entry => entry.id),
    };
    if (apiInsert1.length !== 1 || apiInsert2.length !== 1) throw new Error('API query path lost or duplicated a boundary record');
    await browser.screenshot(path.join(ARTIFACTS, 'log004-live-appends.png'));

    // expected2: close the dialog → the logs channel must unsubscribe.
    const statsBefore = JSON.parse(await readDom()).liveStats;
    await click('#logsDialog [data-close="logsDialog"]');
    await waitFor(() => runExpr(`document.getElementById('logsDialog').open === false`), 'dialog closed');
    await new Promise(resolve => setTimeout(resolve, 800));
    const statsAfter = JSON.parse(await readDom()).liveStats;

    // A record inserted after the close must NOT stream into the closed dialog.
    const put3 = await putGoal(GOAL_BYTES.insert3);
    await new Promise(resolve => setTimeout(resolve, 1600));
    const domAfterClose = JSON.parse(await readDom());
    const insert3InClosedDom = domAfterClose.records.some(record => record.event === GOAL_EVENT && record.context && record.context.bytes === GOAL_BYTES.insert3);
    evidence.phases.streamDisconnect = {
      statsBefore,
      statsAfter,
      subscriptionsDroppedByOne: statsAfter && statsBefore && statsAfter.subscriptions === statsBefore.subscriptions - 1,
      put3,
      entriesWhileClosed: domAfterClose.count,
      insert3StreamedIntoClosedDialog: insert3InClosedDom,
    };
    if (!evidence.phases.streamDisconnect.subscriptionsDroppedByOne) throw new Error(`logs stream subscription survived the dialog close: ${JSON.stringify({ statsBefore, statsAfter })}`);
    if (insert3InClosedDom) throw new Error('closed dialog still received streamed records');
    await browser.screenshot(path.join(ARTIFACTS, 'log004-closed-dialog.png'));

    // Reopen: durable catch-up shows the record inserted while closed.
    await click('#openLogs');
    await waitFor(async () => {
      const dom = JSON.parse(await readDom());
      return dom.records.filter(record => record.event === GOAL_EVENT && record.context && record.context.bytes === GOAL_BYTES.insert3).length === 1;
    }, 'reopen catches up the record inserted while the dialog was closed', 20000);
    const domReopen = JSON.parse(await readDom());
    const reopenIds = domReopen.records.map(record => record.id);
    evidence.phases.reopenCatchUp = {
      insert3InDom: domReopen.records.filter(record => record.event === GOAL_EVENT && record.context && record.context.bytes === GOAL_BYTES.insert3).length,
      domEntryCount: domReopen.count,
      domIdsUnique: new Set(reopenIds).size === reopenIds.length,
    };
    if (evidence.phases.reopenCatchUp.insert3InDom !== 1) throw new Error('reopen lost the record inserted while closed');
    if (!evidence.phases.reopenCatchUp.domIdsUnique) throw new Error('reopen rendered duplicate record ids');
    await browser.screenshot(path.join(ARTIFACTS, 'log004-reopen-catchup.png'));

    // Disk truth: each inserted record exists exactly once in the project file.
    const day = localDay();
    const projectFile = path.join(fixture.dataDir, 'logs', 'projects', PROJECT_A, `${day}.jsonl`);
    const diskRecords = fs.readFileSync(projectFile, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    const diskIds = diskRecords.map(record => record.id);
    const diskCount = key => diskRecords.filter(record => record.event === GOAL_EVENT && record.context && record.context.bytes === GOAL_BYTES[key]).length;
    evidence.phases.disk = {
      insert1OnDisk: diskCount('insert1'),
      insert2OnDisk: diskCount('insert2'),
      insert3OnDisk: diskCount('insert3'),
      diskIdsUnique: new Set(diskIds).size === diskIds.length,
    };
    if (evidence.phases.disk.insert1OnDisk !== 1 || evidence.phases.disk.insert2OnDisk !== 1 || evidence.phases.disk.insert3OnDisk !== 1) throw new Error('disk lost or duplicated a boundary record');
    if (!evidence.phases.disk.diskIdsUnique) throw new Error('disk contains duplicate record ids');

    if (browser.exceptions.length) throw new Error(`browser exceptions: ${JSON.stringify(browser.exceptions)}`);
    evidence.verdict = { 'expected1 交界插入不丢失不重复': 'PASS', 'expected2 关闭窗口后流断开': 'PASS' };
    console.log('LOG-004 PASS');
    process.exitCode = 0;
  } catch (error) {
    evidence.verdict = { failed: String((error && error.stack) || error) };
    try {
      if (browser) {
        evidence.debugDom = JSON.parse(await browser.evaluate(`JSON.stringify({ dialogOpen: document.getElementById('logsDialog').open, scope: document.getElementById('logsScope').value, entries: document.querySelectorAll('#logsContent .log-entry').length, liveStats: window.KnowledgeLive ? KnowledgeLive.stats() : null })`));
        evidence.debugConsoleErrors = browser.consoleErrors;
      }
      if (proxy) evidence.debugProxy = proxy.state.snapshot();
    } catch {}
    process.exitCode = 1;
    console.error(`LOG-004 FAIL: ${error.message}`);
  } finally {
    evidence.finishedAt = new Date().toISOString();
    try { if (browser) await browser.screenshot(path.join(ARTIFACTS, 'log004-final.png')); } catch {}
    fs.mkdirSync(ARTIFACTS, { recursive: true });
    fs.writeFileSync(path.join(ARTIFACTS, 'log004-evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
    try { await browser?.close(); } finally { try { if (proxy) await proxy.close(); } finally { try { await server.cleanup(); } finally { fixture.cleanup(); } } }
    lane.cleanup();
  }
}

main();
