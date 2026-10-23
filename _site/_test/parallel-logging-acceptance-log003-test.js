'use strict';
// P-LOG-ACCEPTANCE-01 LOG-003 日志查询 acceptance driver (real product page in a
// real browser against an isolated managed instance).
//
// Case (qa-autopilot/config/test-cases.json LOG-003, P1):
//   steps:    系统状态→诊断，输入唯一operationId，选择当前项目。
//   expected: 1) GET返回与UI一致。
//             2) 不含其他项目敏感信息。
//
// Real behaviour under test: the diagnostics dialog (ui/product.js loadLogs)
// queries GET /api/logs?pageSize=100&q=<operationId>&projectId=<current>; the
// repository filters by q (full text incl. operationId) and projectId; project
// logs live in per-project directories (<dataDir>/logs/projects/<id>/). Two
// isolated projects with unique per-run operationIds and private markers prove
// the project boundary in DOM, API and on disk. No stubs on the UI path.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Portable isolation (P-QA-LOG-INTEGRATION-5025): the temp root comes from
// PK_TEST_TEMP_ROOT or os.tmpdir() and must live outside the source tree;
// HOME/APPDATA/LOCALAPPDATA/TEMP/CODEX_HOME/CLAUDE_CONFIG_DIR and the dual
// product data roots are redirected before any other module is loaded.
const { installLoggingTestEnv, resolveEvidenceDir } = require('./helpers/parallel-logging-integration-5025-env');
const lane = installLoggingTestEnv({ caseId: 'LOG-003', prefix: 'log003' });
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
const ARTIFACTS = resolveEvidenceDir(path.resolve(ROOT, 'qa-autopilot/artifacts/parallel-20261023/logging-acceptance-r1/evidence/log003'));

const PROJECT_A = 'project-log003-alpha';
const PROJECT_B = 'project-log003-beta';
const run = crypto.randomBytes(6).toString('hex');
const OP_ALPHA = `op-log003-alpha-${run}`;
const OP_BETA = `op-log003-beta-${run}`;
const MARKER_ALPHA = `LOG003-ALPHA-PRIVATE-${run}`;
const MARKER_BETA = `LOG003-BETA-PRIVATE-${run}`;

async function main() {
  fs.mkdirSync(ARTIFACTS, { recursive: true });
  const evidence = { caseId: 'LOG-003', startedAt: new Date().toISOString(), opAlpha: OP_ALPHA, opBeta: OP_BETA, markerAlpha: MARKER_ALPHA, markerBeta: MARKER_BETA, phases: {} };

  const fixture = await createLoggingAcceptanceFixture({
    caseId: 'log003',
    projects: [
      { projectId: PROJECT_A, displayName: 'LOG003甲项目' },
      { projectId: PROJECT_B, displayName: 'LOG003乙项目' },
    ],
  });
  await writeProjectLogs(fixture.logger, PROJECT_A, [
    ...Array.from({ length: 4 }, (_, index) => ({ level: index % 2 ? 'warn' : 'info', event: `log003.alpha.flow.${index}`, message: `${MARKER_ALPHA} 甲项目流程记录 ${index}`, operationId: OP_ALPHA })),
    ...Array.from({ length: 6 }, (_, index) => ({ level: 'info', event: `log003.alpha.other.${index}`, message: `${MARKER_ALPHA} 甲项目普通记录 ${index}`, operationId: `op-log003-alpha-other-${run}-${index}` })),
  ]);
  await writeProjectLogs(fixture.logger, PROJECT_B, [
    ...Array.from({ length: 3 }, (_, index) => ({ level: 'info', event: `log003.beta.flow.${index}`, message: `${MARKER_BETA} 乙项目流程记录 ${index}`, operationId: OP_BETA })),
    ...Array.from({ length: 5 }, (_, index) => ({ level: 'debug', event: `log003.beta.other.${index}`, message: `${MARKER_BETA} 乙项目普通记录 ${index}`, operationId: `op-log003-beta-other-${run}-${index}` })),
  ]);
  await fixture.logger.info('log003.system.note', 'LOG003 系统范围记录', {});
  await fixture.logger.close();

  const port = await freePort();
  const proxyPort = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const server = spawnServer({ root: ROOT, port, dataDir: fixture.dataDir, tag: 'log003', stdio: 'ignore' });
  let browser;
  let proxy;
  try {
    await waitFor(async () => { try { return (await fetch(`${base}/api/health`)).ok; } catch { return false; } }, 'isolated web shell', 20000);
    proxy = await createObservationProxy({ targetPort: port, port: proxyPort });
    proxy.trackPrefix('/api/logs/stream');
    evidence.server = { pid: server.child.pid, port, dataDir: fixture.dataDir, proxyPort };

    browser = await launchCdpBrowser({ chrome: findChrome(), profileDir: path.join(laneTmp, 'browser'), url: proxy.url, width: 1440, height: 900 });
    const runExpr = expression => browser.evaluate(expression);
    const click = selector => runExpr(`document.querySelector(${JSON.stringify(selector)}).click()`);
    evidence.browser = await runExpr('navigator.userAgent');

    await waitFor(() => runExpr(`document.getElementById('projectSelect') && document.getElementById('projectSelect').length >= 2`), 'both isolated projects registered', 20000);
    await runExpr(`document.getElementById('projectSelect').value = ${JSON.stringify(PROJECT_A)}; document.getElementById('projectSelect').dispatchEvent(new Event('change'))`);
    await waitFor(() => runExpr(`document.getElementById('projectSelect').value === ${JSON.stringify(PROJECT_A)}`), 'project A selected');

    // Real server activity (e.g. project-scoped engine snapshot calls) also
    // lands in per-project logs, so fixed counts are not the invariant here.
    // The isolation invariants are: every rendered record belongs to the
    // selected project, private markers never cross the boundary, the unique
    // operationId query returns exactly its own 4 records, and the same-filter
    // GET returns exactly what the UI rendered (id-set identity).
    const readDom = () => runExpr(`JSON.stringify({ count: document.querySelectorAll('#logsContent .log-entry').length, records: [...document.querySelectorAll('#logsContent .log-detail')].map(node => JSON.parse(node.textContent)), status: document.getElementById('logsStatus').textContent, dialogText: document.getElementById('logsDialog').textContent })`);

    // 系统状态 → 诊断 with 当前项目 scope.
    await click('#openSystem');
    await click('#openLogs');
    await runExpr(`document.getElementById('logsScope').value = 'project'; document.getElementById('logsScope').dispatchEvent(new Event('change'))`);
    await waitFor(async () => {
      const dom = JSON.parse(await readDom());
      return dom.count >= 10 && dom.status.includes('当前项目') && dom.records.every(record => record.projectId === PROJECT_A);
    }, 'project A scope renders only project A records', 20000);
    const domA = JSON.parse(await readDom());
    evidence.phases.projectScopeA = {
      domEntries: domA.count,
      status: domA.status,
      domProjectIds: [...new Set(domA.records.map(record => record.projectId))],
      alphaMarkerPresent: domA.dialogText.includes(MARKER_ALPHA),
      betaMarkerVisibleInA: domA.dialogText.includes(MARKER_BETA),
    };
    if (evidence.phases.projectScopeA.domProjectIds.some(id => id !== PROJECT_A)) throw new Error('project A view rendered records from another project');
    if (evidence.phases.projectScopeA.betaMarkerVisibleInA) throw new Error('project A view leaked project B records');
    if (!evidence.phases.projectScopeA.alphaMarkerPresent) throw new Error('project A view lost its own records');

    // expected1 (project scope): same-filter GET matches the UI rendering.
    const getA = await (await fetch(`${base}/api/logs?pageSize=100&q=&projectId=${PROJECT_A}`)).json();
    const domAAfterGet = JSON.parse(await readDom());
    const getAIds = getA.entries.map(entry => entry.id).sort();
    const domAIds = domA.records.map(record => record.id).sort();
    const domAAfterIds = domAAfterGet.records.map(record => record.id).sort();
    const consistentA = JSON.stringify(getAIds) === JSON.stringify(domAIds) || JSON.stringify(getAIds) === JSON.stringify(domAAfterIds);
    evidence.phases.getUiConsistencyProjectA = {
      getEntryCount: getA.entries.length,
      domEntryCount: domA.count,
      domEntryCountAfterGet: domAAfterGet.count,
      identical: consistentA,
      getIdSet: getAIds,
    };
    if (!consistentA) throw new Error('GET (project A scope) differs from the UI rendering');

    // Case step: 输入唯一operationId → exactly its 4 flow records.
    await runExpr(`document.getElementById('logsSearch').value = ${JSON.stringify(OP_ALPHA)}`);
    await click('#loadLogs');
    await waitFor(async () => {
      const dom = JSON.parse(await readDom());
      return dom.count === 4 && dom.records.every(record => record.operationId === OP_ALPHA);
    }, 'unique operationId query narrows the DOM to its 4 records', 20000);
    const domOp = JSON.parse(await readDom());
    if (domOp.records.some(record => record.projectId !== PROJECT_A)) throw new Error('unique operationId query returned records from another project');

    // expected1 (unique operationId): GET returns exactly what the UI shows.
    const getOp = await (await fetch(`${base}/api/logs?pageSize=100&q=${encodeURIComponent(OP_ALPHA)}&projectId=${PROJECT_A}`)).json();
    const getOpIds = getOp.entries.map(entry => entry.id).sort();
    const domOpIds = domOp.records.map(record => record.id).sort();
    evidence.phases.getUiConsistencyOperationId = {
      getEntryCount: getOp.entries.length,
      domEntryCount: domOp.count,
      identical: JSON.stringify(getOpIds) === JSON.stringify(domOpIds),
      getIdSet: getOpIds,
      domIdSet: domOpIds,
    };
    if (JSON.stringify(getOpIds) !== JSON.stringify(domOpIds)) throw new Error('GET (unique operationId) differs from the UI rendering');

    await browser.screenshot(path.join(ARTIFACTS, 'log003-alpha-operationId.png'));

    // expected2: scope 系统与所有项目 keeps the unique query exact.
    await runExpr(`document.getElementById('logsScope').value = 'all'; document.getElementById('logsScope').dispatchEvent(new Event('change'))`);
    await waitFor(async () => {
      const dom = JSON.parse(await readDom());
      return dom.count === 4 && dom.records.every(record => record.operationId === OP_ALPHA) && dom.status.includes('系统与所有项目');
    }, 'scope all still finds exactly the alpha flow');
    // And switching the current project flips the isolation boundary.
    // (Scope and search are set silently; selectProject's reload reads them.)
    await runExpr(`document.getElementById('logsScope').value = 'project'; document.getElementById('logsSearch').value = ''`);
    await runExpr(`document.getElementById('projectSelect').value = ${JSON.stringify(PROJECT_B)}; document.getElementById('projectSelect').dispatchEvent(new Event('change'))`);
    await waitFor(async () => {
      const dom = JSON.parse(await readDom());
      return dom.count >= 8 && dom.status.includes('当前项目') && dom.records.every(record => record.projectId === PROJECT_B) && dom.dialogText.includes(MARKER_BETA);
    }, 'project B scope renders only project B records', 20000);
    const domB = JSON.parse(await readDom());
    const alphaLeakInB = domB.dialogText.includes(OP_ALPHA) || domB.dialogText.includes(MARKER_ALPHA);
    evidence.phases.projectScopeB = { domEntries: domB.count, domProjectIds: [...new Set(domB.records.map(record => record.projectId))], betaMarkerPresent: true, alphaVisibleInB: alphaLeakInB };
    if (evidence.phases.projectScopeB.domProjectIds.some(id => id !== PROJECT_B)) throw new Error('project B view rendered records from another project');
    if (alphaLeakInB) throw new Error('project B view leaked project A records');
    await browser.screenshot(path.join(ARTIFACTS, 'log003-beta-isolation.png'));

    // Disk correspondence: per-project directories hold only their own flows.
    const day = localDay();
    const readDay = dir => fs.readFileSync(path.join(fixture.dataDir, 'logs', 'projects', dir, `${day}.jsonl`), 'utf8');
    const diskA = readDay(PROJECT_A);
    const diskB = readDay(PROJECT_B);
    evidence.phases.disk = {
      alphaFileHasFlow: diskA.split(OP_ALPHA).length - 1 === 4,
      alphaFileHasNoBeta: !diskA.includes(MARKER_BETA),
      betaFileHasFlow: diskB.split(OP_BETA).length - 1 === 3,
      betaFileHasNoAlpha: !diskB.includes(MARKER_ALPHA),
    };
    if (!evidence.phases.disk.alphaFileHasFlow || !evidence.phases.disk.alphaFileHasNoBeta || !evidence.phases.disk.betaFileHasFlow || !evidence.phases.disk.betaFileHasNoAlpha) {
      throw new Error('per-project log directories violated the isolation boundary');
    }

    if (browser.exceptions.length) throw new Error(`browser exceptions: ${JSON.stringify(browser.exceptions)}`);
    evidence.verdict = { 'expected1 GET返回与UI一致': 'PASS', 'expected2 不含其他项目敏感信息': 'PASS' };
    console.log('LOG-003 PASS');
    process.exitCode = 0;
  } catch (error) {
    evidence.verdict = { failed: String((error && error.stack) || error) };
    try {
      if (browser) {
        evidence.debugDom = JSON.parse(await browser.evaluate(`JSON.stringify({ dialogOpen: document.getElementById('logsDialog').open, scope: document.getElementById('logsScope').value, status: document.getElementById('logsStatus').textContent, entries: document.querySelectorAll('#logsContent .log-entry').length, project: document.getElementById('projectSelect').value, projectOptions: [...document.getElementById('projectSelect').options].map(o => o.value) })`));
        evidence.debugConsoleErrors = browser.consoleErrors;
      }
      if (proxy) evidence.debugProxyLogsRequests = proxy.state.requests.filter(r => r.pathname.startsWith('/api/logs')).map(r => ({ method: r.method, url: r.url, status: r.status, error: r.error || null }));
    } catch {}
    process.exitCode = 1;
    console.error(`LOG-003 FAIL: ${error.message}`);
  } finally {
    evidence.finishedAt = new Date().toISOString();
    try { if (browser) await browser.screenshot(path.join(ARTIFACTS, 'log003-final.png')); } catch {}
    fs.mkdirSync(ARTIFACTS, { recursive: true });
    fs.writeFileSync(path.join(ARTIFACTS, 'log003-evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
    try { await browser?.close(); } finally { try { if (proxy) await proxy.close(); } finally { try { await server.cleanup(); } finally { fixture.cleanup(); } } }
    lane.cleanup();
  }
}

main();
