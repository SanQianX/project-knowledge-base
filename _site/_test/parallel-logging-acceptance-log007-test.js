'use strict';
// P-LOG-ACCEPTANCE-01 LOG-007 acceptance driver (real product page in a real
// browser against an isolated managed instance).
//
// Case (qa-autopilot/config/test-cases.json LOG-007, P1):
//   steps:    分别核对API日志级别、时间、component字段与当前UI控件。
//   expected: 1) API支持不等于UI已提供控件（如实记录差异）。
//             2) README与DOM差异记录而不造按钮。
//
// What this driver does NOT do: invent level/time/component controls. The
// real dialog DOM is inventoried; the real API filter surface is probed with
// fixture records; the README claims are hashed and diffed against the DOM
// inventory and the logger source. Differences are recorded, not patched.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Portable isolation (P-QA-LOG-INTEGRATION-5025): the temp root comes from
// PK_TEST_TEMP_ROOT or os.tmpdir() and must live outside the source tree;
// HOME/APPDATA/LOCALAPPDATA/TEMP/CODEX_HOME/CLAUDE_CONFIG_DIR and the dual
// product data roots are redirected before any other module is loaded.
const { installLoggingTestEnv, resolveEvidenceDir } = require('./helpers/parallel-logging-integration-5025-env');
const lane = installLoggingTestEnv({ caseId: 'LOG-007', prefix: 'log007' });
const laneTmp = lane.laneTmp;

const { spawnServer } = require('./helpers/spawn-server');
const { findChrome } = require('./helpers/find-chrome');
const { launchCdpBrowser, waitFor } = require('./helpers/cdp-browser');
const freePort = require('./helpers/free-port');
const { createLoggingAcceptanceFixture, writeProjectLogs } = require('./helpers/parallel-logging-acceptance-fixture');
const { createObservationProxy } = require('./helpers/parallel-logging-acceptance-proxy');
// The API filters from/to are compared against the record's LOCAL day
// (LogRepository.matches recomputes localDay(record.ts)). The day probes are
// anchored to the record ts the server itself echoes — never to a second
// clock — so day boundaries and machine zones cannot desynchronize them.
const { localDay } = require('../lib/structured-logger');

const ROOT = path.resolve(__dirname, '../..');
const ARTIFACTS = resolveEvidenceDir(path.resolve(ROOT, 'qa-autopilot/artifacts/parallel-20261023/logging-acceptance-r1/evidence/log007'));

const PROJECT_A = 'project-log007-alpha';
const run = crypto.randomBytes(6).toString('hex');
const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

async function main() {
  fs.mkdirSync(ARTIFACTS, { recursive: true });
  const evidence = { caseId: 'LOG-007', startedAt: new Date().toISOString(), run, phases: {} };

  // Fixture records engineered so every API filter has an exact expected set.
  // groupEarly and groupLate are separated by a real wall-clock gap so from/to
  // windows split them deterministically.
  const early = [
    { level: 'info', event: `log007.early.info`, component: 'log007-comp-a', message: `LOG007-EARLY-INFO-${run} 早组信息`, operationId: `op-log007-early-info-${run}`, commitSha: 'a'.repeat(40) },
    { level: 'warn', event: `log007.early.warn`, component: 'log007-comp-b', message: `LOG007-EARLY-WARN-${run} 早组警告`, operationId: `op-log007-early-warn-${run}`, commitSha: 'b'.repeat(40) },
  ];
  const late = [
    { level: 'warn', event: `log007.late.warn`, component: 'log007-comp-b', message: `LOG007-LATE-WARN-${run} 晚组警告`, operationId: `op-log007-late-warn-${run}`, commitSha: 'c'.repeat(40) },
    { level: 'error', event: `log007.late.error`, component: 'log007-comp-c', message: `LOG007-LATE-ERROR-${run} 晚组错误`, operationId: `op-log007-late-error-${run}`, commitSha: 'd'.repeat(40) },
  ];

  const fixture = await createLoggingAcceptanceFixture({
    caseId: 'log007',
    projects: [{ projectId: PROJECT_A, displayName: 'LOG007甲项目' }],
  });
  await writeProjectLogs(fixture.logger, PROJECT_A, early);
  await writeProjectLogs(fixture.logger, PROJECT_A, late);
  await fixture.logger.close();

  const port = await freePort();
  const proxyPort = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const server = spawnServer({ root: ROOT, port, dataDir: fixture.dataDir, tag: 'log007', stdio: 'ignore' });
  let browser;
  let proxy;
  try {
    await waitFor(async () => { try { return (await fetch(`${base}/api/health`)).ok; } catch { return false; } }, 'isolated web shell', 20000);
    proxy = await createObservationProxy({ targetPort: port, port: proxyPort });
    evidence.server = { pid: server.child.pid, port, proxyPort, dataDir: fixture.dataDir };

    // API filter surface (real server, exact expected sets).
    const query = async params => {
      const res = await fetch(`${base}/api/logs?${params}`);
      const body = await res.json();
      return { status: res.status, count: (body.entries || []).length, events: (body.entries || []).map(entry => entry.event).sort(), levels: [...new Set((body.entries || []).map(entry => entry.level))], entries: body.entries || [] };
    };
    const apiAll = await query(`pageSize=100&projectId=${PROJECT_A}`);
    const apiWarn = await query(`pageSize=100&projectId=${PROJECT_A}&levels=warn`);
    const apiError = await query(`pageSize=100&projectId=${PROJECT_A}&levels=error`);
    const apiComponent = await query(`pageSize=100&projectId=${PROJECT_A}&component=log007-comp-b`);
    // from/to are local-day strings by design (LogRepository.matches compares
    // localDay(record.ts)). The day windows are anchored to the records the
    // server itself echoed (never a second clock, never now±24h) and moved by
    // pure day-string arithmetic. The live server ALSO writes project-scoped
    // startup records (bridge_consumer.identity_backfilled lands in the same
    // day file ~0.2-1s after health), so a bare count===4 is a race against
    // the server's own async writes — the R7 CI failure on both Linux jobs.
    // The actual contract: every entry of a from=X&to=X window carries
    // localDay(ts)===X, and the four fixture records appear in exactly their
    // own day's window.
    const fixtureEvents = [...early, ...late].map(record => record.event);
    const fixtureDay = localDay(apiError.entries[0].ts);
    const shiftDay = (day, delta) => new Date(Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)) + delta)).toISOString().slice(0, 10);
    const nextDay = shiftDay(fixtureDay, 1);
    const prevDay = shiftDay(fixtureDay, -1);
    const apiFromToday = await query(`pageSize=100&projectId=${PROJECT_A}&from=${fixtureDay}&to=${fixtureDay}`);
    const apiFromTomorrow = await query(`pageSize=100&projectId=${PROJECT_A}&from=${nextDay}&to=${nextDay}`);
    const apiToYesterday = await query(`pageSize=100&projectId=${PROJECT_A}&from=${prevDay}&to=${prevDay}`);
    const apiEvent = await query(`pageSize=100&projectId=${PROJECT_A}&event=log007.late.error`);
    const apiOperation = await query(`pageSize=100&projectId=${PROJECT_A}&operationId=op-log007-early-warn-${run}`);
    const apiCommit = await query(`pageSize=100&projectId=${PROJECT_A}&commitSha=${'d'.repeat(40)}`);
    const apiFullTextMarker = await query(`pageSize=100&projectId=${PROJECT_A}&q=${encodeURIComponent(`LOG007-EARLY-WARN-${run}`)}`);
    evidence.phases.apiFilters = { apiAll, apiWarn, apiError, apiComponent, apiEvent, apiOperation, apiCommit, apiFullTextMarker };
    evidence.phases.apiDayWindows = {
      fixtureDay, nextDay, prevDay,
      today: { count: apiFromToday.count, events: apiFromToday.events, nonFixtureRecords: apiFromToday.entries.filter(entry => !fixtureEvents.includes(entry.event)).map(entry => ({ event: entry.event, component: entry.component, ts: entry.ts })) },
      tomorrow: { count: apiFromTomorrow.count, events: apiFromTomorrow.events },
      yesterday: { count: apiToYesterday.count, events: apiToYesterday.events },
    };
    const everyEntryOnDay = (result, day) => result.entries.every(entry => localDay(entry.ts) === day);
    const containsAllEvents = (result, events) => events.every(event => result.events.includes(event));
    const excludesFixtureEvents = result => result.entries.every(entry => !fixtureEvents.includes(entry.event));
    const apiSupported = {
      levels: apiWarn.count === 2 && apiWarn.levels.every(level => level === 'warn') && apiError.count === 1,
      component: apiComponent.count === 2 && apiComponent.events.filter(event => event.endsWith('warn')).length === 2,
      timeDayGranularity: apiFromToday.count >= fixtureEvents.length
        && containsAllEvents(apiFromToday, fixtureEvents)
        && everyEntryOnDay(apiFromToday, fixtureDay)
        && excludesFixtureEvents(apiFromTomorrow) && everyEntryOnDay(apiFromTomorrow, nextDay)
        && excludesFixtureEvents(apiToYesterday) && everyEntryOnDay(apiToYesterday, prevDay),
      event: apiEvent.count === 1,
      operationId: apiOperation.count === 1,
      commitSha: apiCommit.count === 1,
      fullText: apiFullTextMarker.count === 1,
    };
    // component events check: both warn records share comp-b.
    apiSupported.component = apiComponent.count === 2 && apiComponent.events.filter(event => event.endsWith('warn')).length === 2;
    evidence.phases.apiSupported = apiSupported;

    // Real UI DOM inventory: every control that actually exists.
    browser = await launchCdpBrowser({ chrome: findChrome(), profileDir: path.join(laneTmp, 'browser'), url: proxy.url, width: 1440, height: 900 });
    const runExpr = expression => browser.evaluate(expression);
    const click = selector => runExpr(`document.querySelector(${JSON.stringify(selector)}).click()`);
    evidence.browser = await runExpr('navigator.userAgent');
    await waitFor(() => runExpr(`document.getElementById('projectSelect') && document.getElementById('projectSelect').length >= 1`), 'isolated project registered', 20000);
    await runExpr(`document.getElementById('projectSelect').value = ${JSON.stringify(PROJECT_A)}; document.getElementById('projectSelect').dispatchEvent(new Event('change'))`);
    await waitFor(() => runExpr(`document.getElementById('projectSelect').value === ${JSON.stringify(PROJECT_A)}`), 'project A selected');
    await click('#openSystem');
    await click('#openLogs');
    await waitFor(() => runExpr(`document.getElementById('logsDialog').open === true && document.querySelectorAll('#logsContent .log-entry').length >= 4`), 'diagnostics dialog rendered', 20000);
    const domInventory = JSON.parse(await runExpr(`JSON.stringify({
      controls: [...document.querySelectorAll('#logsDialog button, #logsDialog input, #logsDialog select, #logsDialog textarea')].map(node => ({ tag: node.tagName.toLowerCase(), id: node.id || null, type: node.getAttribute('type'), ariaLabel: node.getAttribute('aria-label'), text: (node.textContent || '').trim().slice(0, 24) })),
      statusText: document.getElementById('logsStatus').textContent,
      searchPlaceholder: document.getElementById('logsSearch').placeholder,
      scopeOptions: [...document.getElementById('logsScope').options].map(option => ({ value: option.value, text: option.textContent })),
    })`));
    evidence.phases.domInventory = domInventory;
    const controls = domInventory.controls;
    const ids = controls.map(control => control.id).filter(Boolean);
    const uiHasOnly = { scope: ids.includes('logsScope'), search: ids.includes('logsSearch'), load: ids.includes('loadLogs'), export: ids.includes('exportLogs') };
    const banned = /level|级别|time|时间|component|组件|event|事件|commit/i;
    const extraFilterControls = controls.filter(control => control.id !== 'logsScope' && control.id !== 'logsSearch' && control.id !== 'loadLogs' && control.id !== 'exportLogs' && !(control.tag === 'button' && !control.id && (control.text === '×' || control.ariaLabel === '关闭')));
    evidence.phases.uiControlSurface = {
      uiHasOnly,
      unexpectedFilterControls: extraFilterControls,
      anyControlMentionsBannedFilter: controls.filter(control => banned.test([control.id, control.ariaLabel, control.text, control.searchPlaceholder || ''].join(' '))).map(control => control.id || control.text),
    };
    // The one input's own placeholder names its full-text nature.
    evidence.phases.uiControlSurface.searchPlaceholder = domInventory.searchPlaceholder;
    await browser.screenshot(path.join(ARTIFACTS, 'log007-dom-inventory.png'));

    // README vs DOM/source difference record (read-only; never patched here).
    const readmePath = path.join(ROOT, 'docs', 'README.zh-CN.md');
    const readmeHash = sha256(readmePath);
    const readmeLines = fs.readFileSync(readmePath, 'utf8').split('\n');
    const claimLines = readmeLines.slice(170, 181).map((text, offset) => ({ line: offset + 171, text: text.trim() })).filter(entry => entry.text);
    const loggerSource = fs.readFileSync(path.join(ROOT, '_site', 'lib', 'structured-logger.js'), 'utf8');
    const productSourceHash = sha256(path.join(ROOT, 'ui', 'product.js'));
    evidence.phases.readmeVsReality = {
      readmeSha256: readmeHash,
      uiProductSha256: productSourceHash,
      claimLines,
      loggerHas: {
        segmentRotation: /segment|rotat/i.test(loggerSource),
        retentionEnforcement: /retentionDays|prune[A-Z_]|\bdeleteOld|cleanupOld/i.test(loggerSource),
        totalSizePolicy: /maxTotalSize|enforceQuota/i.test(loggerSource),
      },
      domOffers: { scope: true, fullText: true, level: false, time: false, component: false, event: false, commitSha: false, pause: false },
      apiOffers: apiSupported,
    };

    if (browser.exceptions.length) throw new Error(`browser exceptions: ${JSON.stringify(browser.exceptions)}`);
    const expected1 = apiSupported.levels && apiSupported.component && apiSupported.timeDayGranularity && apiSupported.event && apiSupported.operationId && apiSupported.commitSha && uiHasOnly.scope && uiHasOnly.search && extraFilterControls.length === 0;
    const expected2 = claimLines.length > 0 && extraFilterControls.length === 0;
    evidence.verdict = {
      'expected1 API支持而UI未提供控件(差异已记录)': expected1 ? 'PASS' : 'FAIL',
      'expected2 README与DOM差异已记录且未造按钮': expected2 ? 'PASS' : 'FAIL',
    };
    if (!expected1 || !expected2) throw new Error(`difference recording failed: ${JSON.stringify({ apiSupported, uiHasOnly, extraFilterControls: extraFilterControls.length })}`);
    console.log('LOG-007 PASS');
    process.exitCode = 0;
  } catch (error) {
    evidence.verdict = { failed: String((error && error.stack) || error) };
    try {
      if (browser) {
        evidence.debugDom = JSON.parse(await browser.evaluate(`JSON.stringify({ dialogOpen: document.getElementById('logsDialog').open, entries: document.querySelectorAll('#logsContent .log-entry').length })`));
        evidence.debugConsoleErrors = browser.consoleErrors;
      }
      if (proxy) evidence.debugProxy = proxy.state.snapshot();
    } catch {}
    process.exitCode = 1;
    console.error(`LOG-007 FAIL: ${error.message}`);
  } finally {
    evidence.finishedAt = new Date().toISOString();
    try { if (browser) await browser.screenshot(path.join(ARTIFACTS, 'log007-final.png')); } catch {}
    fs.mkdirSync(ARTIFACTS, { recursive: true });
    fs.writeFileSync(path.join(ARTIFACTS, 'log007-evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
    try { await browser?.close(); } finally { try { if (proxy) await proxy.close(); } finally { try { await server.cleanup(); } finally { fixture.cleanup(); } } }
    lane.cleanup();
  }
}

main();
