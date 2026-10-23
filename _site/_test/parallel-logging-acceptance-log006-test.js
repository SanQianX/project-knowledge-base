'use strict';
// P-LOG-ACCEPTANCE-01 LOG-006 acceptance driver (real product page in a real
// browser against an isolated managed instance).
//
// Case (qa-autopilot/config/test-cases.json LOG-006, P0):
//   steps:    使用完全虚构的 canary 密钥（嵌套 error/context），验证写入、
//             查询、导出全链路脱敏。
//   expected: 1) 写入路径：磁盘 JSONL 不含 canary 明文。
//             2) 查询与导出路径（API + 真实 UI DOM）：不含 canary 明文，
//                敏感位置显示 [REDACTED]。
//
// Canary discipline: every canary is a fully fictional random string prefixed
// 'pkz-canary-'. Evidence records only sha256 prefixes, never raw canaries.
// Redaction under test is the real product path: write-time normalizeRecord
// (key-name pattern), query-time and export-time re-redaction, and the real
// diagnostics UI rendering the redacted JSON.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Portable isolation (P-QA-LOG-INTEGRATION-5025): the temp root comes from
// PK_TEST_TEMP_ROOT or os.tmpdir() and must live outside the source tree;
// HOME/APPDATA/LOCALAPPDATA/TEMP/CODEX_HOME/CLAUDE_CONFIG_DIR and the dual
// product data roots are redirected before any other module is loaded.
const { installLoggingTestEnv, resolveEvidenceDir } = require('./helpers/parallel-logging-integration-5025-env');
const lane = installLoggingTestEnv({ caseId: 'LOG-006', prefix: 'log006' });
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
const ARTIFACTS = resolveEvidenceDir(path.resolve(ROOT, 'qa-autopilot/artifacts/parallel-20261023/logging-acceptance-r1/evidence/log006'));

const PROJECT_A = 'project-log006-alpha';
const run = crypto.randomBytes(6).toString('hex');
const MARK = `LOG006-REDACT-${run}`;
const CANARY = {
  apiKey: `pkz-canary-apikey-${run}-KQ7`,
  clientSecret: `pkz-canary-clientsecret-${run}-W21`,
  refreshToken: `pkz-canary-refreshtoken-${run}-ZX9`,
  authorization: `pkz-canary-authorization-${run}-AA3`,
  bearer: `pkz-canary-bearer-${run}-BB4`,
  urlToken: `pkz-canary-urltoken-${run}-CC5`,
  errorBearer: `pkz-canary-errbearer-${run}-DD6`,
  password: `pkz-canary-password-${run}-EE7`,
};
const canaryHashes = Object.fromEntries(Object.entries(CANARY).map(([name, value]) => [name, crypto.createHash('sha256').update(value).digest('hex').slice(0, 16)]));

async function main() {
  fs.mkdirSync(ARTIFACTS, { recursive: true });
  const evidence = { caseId: 'LOG-006', startedAt: new Date().toISOString(), marker: MARK, canarySha256Prefixes: canaryHashes, phases: {} };
  const canaryValues = Object.values(CANARY);
  const leakedCanaries = text => canaryValues.filter(canary => String(text).includes(canary));

  const fixture = await createLoggingAcceptanceFixture({
    caseId: 'log006',
    projects: [{ projectId: PROJECT_A, displayName: 'LOG006甲项目' }],
  });
  const plainError = new Error(`auth failed for Bearer ${CANARY.errorBearer}`);
  await writeProjectLogs(fixture.logger, PROJECT_A, [
    {
      level: 'info',
      event: 'log006.redact.keys',
      message: `${MARK} 键名模式脱敏记录`,
      operationId: `op-log006-keys-${run}`,
      context: {
        apiKey: CANARY.apiKey,
        clientSecret: CANARY.clientSecret,
        refreshToken: CANARY.refreshToken,
        nested: { authorization: CANARY.authorization, note: '普通字段' },
      },
    },
    {
      level: 'warn',
      event: 'log006.redact.string',
      message: `${MARK} 字符串值脱敏记录`,
      operationId: `op-log006-string-${run}`,
      context: {
        tokenText: `Bearer ${CANARY.bearer}`,
        callbackUrl: `https://example.test/cb?token=${CANARY.urlToken}`,
        plain: '普通值',
      },
    },
    {
      level: 'error',
      event: 'log006.redact.error',
      message: `${MARK} error 序列化脱敏记录`,
      operationId: `op-log006-error-${run}`,
      context: { password: CANARY.password },
      error: plainError,
    },
  ]);
  await fixture.logger.close();

  const port = await freePort();
  const proxyPort = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const server = spawnServer({ root: ROOT, port, dataDir: fixture.dataDir, tag: 'log006', stdio: 'ignore' });
  let browser;
  let proxy;
  try {
    await waitFor(async () => { try { return (await fetch(`${base}/api/health`)).ok; } catch { return false; } }, 'isolated web shell', 20000);
    proxy = await createObservationProxy({ targetPort: port, port: proxyPort });
    evidence.server = { pid: server.child.pid, port, proxyPort, dataDir: fixture.dataDir };

    // expected1 (write path): raw disk JSONL never contains a canary.
    const day = localDay();
    const projectFile = path.join(fixture.dataDir, 'logs', 'projects', PROJECT_A, `${day}.jsonl`);
    const diskRaw = fs.readFileSync(projectFile, 'utf8');
    const diskLeak = leakedCanaries(diskRaw);
    const diskRecords = diskRaw.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    const redactedRecordCount = diskRecords.filter(record => JSON.stringify(record).includes('[REDACTED]')).length;
    evidence.phases.diskWrite = {
      diskRecordCount: diskRecords.length,
      diskLeakedCanaries: diskLeak.length,
      recordsWithRedactedPlaceholder: redactedRecordCount,
      redactedKeySample: (() => { const record = diskRecords.find(r => r.event === 'log006.redact.keys'); return record ? { apiKey: record.context && record.context.apiKey, nestedAuthorization: record.context && record.context.nested && record.context.nested.authorization } : null; })(),
    };
    if (diskLeak.length) throw new Error(`write path leaked canaries to disk: ${diskLeak.join(', ')}`);
    if (redactedRecordCount < 3) throw new Error('write path did not redact every canary-bearing record');

    // Query path (API parity before the UI step).
    const getQuery = await fetch(`${base}/api/logs?pageSize=100&q=${encodeURIComponent(MARK)}&projectId=${PROJECT_A}`).then(r => r.json());
    const getLeak = leakedCanaries(JSON.stringify(getQuery));
    evidence.phases.queryApi = {
      entryCount: (getQuery.entries || []).length,
      leakedCanaries: getLeak.length,
      redactedPlaceholdersPerEntry: (getQuery.entries || []).map(entry => (JSON.stringify(entry).match(/\[REDACTED\]/g) || []).length),
    };
    if ((getQuery.entries || []).length !== 3) throw new Error('canary records missing from the query path');
    if (getLeak.length) throw new Error(`query path leaked canaries: ${getLeak.join(', ')}`);
    if (evidence.phases.queryApi.redactedPlaceholdersPerEntry.some(count => count < 1)) throw new Error('query path returned unredacted sensitive fields');

    // Real UI: open the diagnostics dialog and search the marker.
    browser = await launchCdpBrowser({ chrome: findChrome(), profileDir: path.join(laneTmp, 'browser'), url: proxy.url, width: 1440, height: 900 });
    const runExpr = expression => browser.evaluate(expression);
    const click = selector => runExpr(`document.querySelector(${JSON.stringify(selector)}).click()`);
    const readDom = () => runExpr(`JSON.stringify({ count: document.querySelectorAll('#logsContent .log-entry').length, records: [...document.querySelectorAll('#logsContent .log-detail')].map(node => JSON.parse(node.textContent)), dialogText: document.getElementById('logsDialog').textContent })`);
    evidence.browser = await runExpr('navigator.userAgent');

    await waitFor(() => runExpr(`document.getElementById('projectSelect') && document.getElementById('projectSelect').length >= 1`), 'isolated project registered', 20000);
    await runExpr(`document.getElementById('projectSelect').value = ${JSON.stringify(PROJECT_A)}; document.getElementById('projectSelect').dispatchEvent(new Event('change'))`);
    await waitFor(() => runExpr(`document.getElementById('projectSelect').value === ${JSON.stringify(PROJECT_A)}`), 'project A selected');
    await click('#openSystem');
    await runExpr(`document.getElementById('logsScope').value = 'project'; document.getElementById('logsSearch').value = ${JSON.stringify(MARK)}`);
    await click('#openLogs');
    await waitFor(async () => {
      const dom = JSON.parse(await readDom());
      return dom.count === 3 && dom.records.length === 3;
    }, 'UI search renders the 3 canary records', 20000);
    const domRedact = JSON.parse(await readDom());
    const domLeak = leakedCanaries(domRedact.dialogText);
    evidence.phases.uiDom = {
      domEntryCount: domRedact.count,
      leakedCanariesInDialog: domLeak.length,
      redactedPlaceholdersPerRecord: domRedact.records.map(record => (JSON.stringify(record).match(/\[REDACTED\]/g) || []).length),
      apiKeyFieldInDom: domRedact.records.find(r => r.event === 'log006.redact.keys')?.context?.apiKey,
    };
    if (domLeak.length) throw new Error(`UI leaked canaries into the DOM: ${domLeak.join(', ')}`);
    if (evidence.phases.uiDom.redactedPlaceholdersPerRecord.some(count => count < 1)) throw new Error('UI rendered unredacted sensitive fields');
    if (evidence.phases.uiDom.apiKeyFieldInDom !== '[REDACTED]') throw new Error('UI apiKey field is not the redaction placeholder');
    await browser.screenshot(path.join(ARTIFACTS, 'log006-ui-redacted.png'));

    // Export path: the real export file must be redacted end to end.
    const exportRes = await fetch(`${base}/api/logs/export?q=${encodeURIComponent(MARK)}&projectId=${PROJECT_A}`);
    const exportText = await exportRes.text();
    const exportLeak = leakedCanaries(exportText);
    const exportRecords = exportText.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    evidence.phases.export = {
      status: exportRes.status,
      exportedCount: exportRecords.length,
      leakedCanaries: exportLeak.length,
      redactedPlaceholdersPerRecord: exportRecords.map(record => (JSON.stringify(record).match(/\[REDACTED\]/g) || []).length),
    };
    if (exportRes.status !== 200 || exportRecords.length !== 3) throw new Error('export path lost canary records');
    if (exportLeak.length) throw new Error(`export path leaked canaries: ${exportLeak.join(', ')}`);
    if (evidence.phases.export.redactedPlaceholdersPerRecord.some(count => count < 1)) throw new Error('export path returned unredacted sensitive fields');

    if (browser.exceptions.length) throw new Error(`browser exceptions: ${JSON.stringify(browser.exceptions)}`);
    evidence.verdict = { 'expected1 写入路径磁盘无canary明文': 'PASS', 'expected2 查询/导出/API/UI全脱敏': 'PASS' };
    console.log('LOG-006 PASS');
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
    console.error(`LOG-006 FAIL: ${error.message}`);
  } finally {
    evidence.finishedAt = new Date().toISOString();
    try { if (browser) await browser.screenshot(path.join(ARTIFACTS, 'log006-final.png')); } catch {}
    fs.mkdirSync(ARTIFACTS, { recursive: true });
    fs.writeFileSync(path.join(ARTIFACTS, 'log006-evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
    try { await browser?.close(); } finally { try { if (proxy) await proxy.close(); } finally { try { await server.cleanup(); } finally { fixture.cleanup(); } } }
    lane.cleanup();
  }
}

main();
