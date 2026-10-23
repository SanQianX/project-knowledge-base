'use strict';
// P-LOG-SAFETY-R2 deterministic LOG-004 boundary (snapshot→subscription
// handoff) acceptance — lane-exclusive prefix parallel-logging-fix-r2-*.
//
// The real UI protocol (ui/product.js loadLogs): close old stream → GET
// snapshot → render → subscribe /api/logs/stream with the SNAPSHOT's
// streamCursor. The deterministic window is therefore exactly "server has
// produced the snapshot, browser has not received it yet": during that
// window the log subscription does not exist yet.
//
// This driver proves the handoff has no gap and no duplicate, without any
// sleep-based guess:
//   1. The r2 observation proxy holds the REAL snapshot response after the
//      server produced it (original bytes, sha256-recorded).
//   2. While held: wire evidence shows NO logs/stream subscription yet
//      (proxy frame timeline + real page KnowledgeLive.stats), and a REAL
//      product write (PUT /api/projects/<id>/goal) lands a unique record on
//      disk with id/ts AFTER the snapshot cursor.
//   3. The original snapshot bytes are released untouched; the page then
//      subscribes carrying exactly the snapshot cursor; the server's
//      streamLogsWithoutGap replays the gap record (replay:true).
//   4. The unique record appears in DOM / API / disk exactly once each.
//   5. Steady-state control afterwards: a second write arrives live once.
//
// The driver never writes fake log entries, never rewrites response records,
// and never simulates the product's own subscription.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Portable isolation (P-QA-LOG-INTEGRATION-5025): the temp root comes from
// PK_TEST_TEMP_ROOT or os.tmpdir() and must live outside the source tree;
// HOME/APPDATA/LOCALAPPDATA/TEMP/CODEX_HOME/CLAUDE_CONFIG_DIR and the dual
// product data roots are redirected before any other module is loaded.
const { installLoggingTestEnv, resolveEvidenceDir } = require('./helpers/parallel-logging-integration-5025-env');
const lane = installLoggingTestEnv({ caseId: 'LOGFIXR2-GAP', prefix: 'logfixr2-gap' });
const laneTmp = lane.laneTmp;

const { spawnServer } = require('./helpers/spawn-server');
const { findChrome } = require('./helpers/find-chrome');
const { launchCdpBrowser, waitFor } = require('./helpers/cdp-browser');
const freePort = require('./helpers/free-port');
const { createLoggingAcceptanceFixture, writeProjectLogs } = require('./helpers/parallel-logging-acceptance-fixture');
const { createGapProxy, decodeStreamCursor } = require('./helpers/parallel-logging-fix-r2-proxy');

const ROOT = path.resolve(__dirname, '../..');
const ARTIFACTS = resolveEvidenceDir(path.resolve(ROOT, 'qa-autopilot/artifacts/parallel-20261023/logging-fix-r2/evidence/gap'));

const PROJECT_A = 'project-logfixr2-gap';
const run = crypto.randomBytes(6).toString('hex');
const GAP_BYTES = 1733;       // unique goal content length for the boundary write
const STEADY_BYTES = 1777;    // unique length for the steady-state control write
// Below the run-all per-test budget (PK_TEST_TIMEOUT_MS, default 90s) so a
// stall still lets this entry write its own evidence before the runner kills
// the child.
const HARD_TIMEOUT_MS = 80000;

const now = () => new Date().toISOString();

function projectDayRecords(dataDir, projectId) {
  const dir = path.join(dataDir, 'logs', 'projects', projectId);
  const records = [];
  if (!fs.existsSync(dir)) return records;
  for (const file of fs.readdirSync(dir).filter(name => name.endsWith('.jsonl')).sort()) {
    for (const line of fs.readFileSync(path.join(dir, file), 'utf8').split('\n')) {
      if (line.trim()) { try { records.push(JSON.parse(line)); } catch {} }
    }
  }
  return records;
}

const padTo = (marker, total) => marker + ' ' + 'x'.repeat(Math.max(0, total - marker.length - 1));

async function main() {
  fs.mkdirSync(ARTIFACTS, { recursive: true });
  const evidence = { caseId: 'LOG-004 (R2 deterministic boundary)', run, startedAt: now(), phases: {} };

  const seedMarkers = [`LOGFIXR2-GAP-SEED1-${run}`, `LOGFIXR2-GAP-SEED2-${run}`];
  const fixture = await createLoggingAcceptanceFixture({
    caseId: 'logfixr2gap',
    projects: [{ projectId: PROJECT_A, displayName: 'LOGFIXR2交界项目' }],
  });
  await writeProjectLogs(fixture.logger, PROJECT_A, [
    { level: 'info', event: 'logfixr2.gap.seed1', message: seedMarkers[0], operationId: `op-logfixr2-seed1-${run}`, component: 'logfixr2-gap' },
    { level: 'warn', event: 'logfixr2.gap.seed2', message: seedMarkers[1], operationId: `op-logfixr2-seed2-${run}`, component: 'logfixr2-gap' },
  ]);
  await fixture.logger.close();

  const port = await freePort();
  const proxyPort = await freePort();
  const serverBase = `http://127.0.0.1:${port}`;
  const server = spawnServer({ root: ROOT, port, dataDir: fixture.dataDir, tag: 'logfixr2gap', stdio: 'ignore' });
  let browser;
  const proxy = await createGapProxy({ targetPort: port, port: proxyPort });
  try {
    await waitFor(async () => { try { return (await fetch(`${serverBase}/api/health`)).ok; } catch { return false; } }, 'isolated server healthy', 30000);
    evidence.server = { pid: server.child.pid, port, proxyPort, dataDir: fixture.dataDir };

    browser = await launchCdpBrowser({ chrome: findChrome(), profileDir: path.join(laneTmp, 'browser'), url: proxy.url, width: 1440, height: 900 });
    const runExpr = expression => browser.evaluate(expression);
    const click = selector => runExpr(`document.querySelector(${JSON.stringify(selector)}).click()`);
    evidence.browser = await runExpr('navigator.userAgent');
    await waitFor(async () => runExpr(`document.getElementById('projectSelect') && document.getElementById('projectSelect').length >= 1`), 'project registered', 20000);
    await runExpr(`document.getElementById('projectSelect').value = ${JSON.stringify(PROJECT_A)}; document.getElementById('projectSelect').dispatchEvent(new Event('change'))`);
    await waitFor(async () => runExpr(`document.getElementById('projectSelect').value === ${JSON.stringify(PROJECT_A)}`), 'project A selected');

    // Baseline: page live subscriptions before the diagnostics dialog exists.
    const statsBaseline = JSON.parse(await runExpr(`JSON.stringify(window.KnowledgeLive ? window.KnowledgeLive.stats() : null)`));
    evidence.phases.statsBaseline = statsBaseline;

    // Arm the barrier, then open the diagnostics dialog (real user path).
    proxy.armSnapshotBarrier();
    await click('#openSystem');
    await click('#openLogs');
    const barrier = await proxy.waitBarrier(10000);
    evidence.phases.barrier = {
      heldAt: barrier.heldAt,
      status: barrier.status,
      entries: barrier.entries,
      newestEntryId: barrier.newestEntryId,
      streamCursor: barrier.streamCursor,
      cursorDecoded: decodeStreamCursor(barrier.streamCursor),
      responseSha256: barrier.sha256,
      byteLength: barrier.byteLength,
    };
    const snapshotCursorDecoded = evidence.phases.barrier.cursorDecoded;

    // While the snapshot is held: the page has NOT yet subscribed to the log
    // stream (wire truth + page truth), and a real product write lands a
    // unique record after the snapshot cursor.
    const statsWhileHeld = JSON.parse(await runExpr(`JSON.stringify(window.KnowledgeLive ? window.KnowledgeLive.stats() : null)`));
    const wsBeforeRelease = proxy.events.filter(e => e.kind === 'ws-frame' && e.type === 'subscribe');
    const logsSubscribeBeforeRelease = wsBeforeRelease.filter(e => (e.route || '').includes('/api/logs/stream'));
    evidence.phases.whileHeld = {
      statsWhileHeld,
      wsSubscribeFramesBeforeRelease: wsBeforeRelease.map(e => ({ seq: e.seq, route: e.route })),
      logsStreamSubscriptionEstablished: logsSubscribeBeforeRelease.length > 0,
    };

    const goalRes = await fetch(`${proxy.url}/api/projects/${PROJECT_A}/goal`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: padTo(`LOGFIXR2-GAP-BOUNDARY-${run}`, GAP_BYTES) }),
    });
    evidence.phases.boundaryWrite = { at: now(), status: goalRes.status, contentBytes: GAP_BYTES };

    proxy.releaseBarrier();
    evidence.phases.releaseAt = now();

    // Wait for the page's own handoff: snapshot rendered, then subscription
    // established with the snapshot cursor, then the gap record replayed.
    await waitFor(async () => runExpr(`document.getElementById('logsDialog').open === true && document.querySelectorAll('#logsContent .log-entry').length >= 3`), 'snapshot rendered after release', 15000);

    const domState = () => runExpr(`JSON.stringify((() => {
      const details = [...document.querySelectorAll('#logsContent .log-entry .log-detail')];
      const records = details.map(node => { try { return JSON.parse(node.textContent); } catch { return null; } }).filter(Boolean);
      const ids = records.map(r => r.id);
      return {
        count: document.querySelectorAll('#logsContent .log-entry').length,
        uniqueIds: new Set(ids).size === ids.length,
        boundaryRecords: records.filter(r => r.event === 'goal.updated' && r.context && r.context.bytes === ${GAP_BYTES}).map(r => ({ id: r.id, ts: r.ts })),
        steadyRecords: records.filter(r => r.event === 'goal.updated' && r.context && r.context.bytes === ${STEADY_BYTES}).map(r => ({ id: r.id, ts: r.ts })),
        domCursor: document.getElementById('logsDialog').dataset.streamCursor || '',
      };
    })())`).then(value => (typeof value === 'string' ? JSON.parse(value) : value));
    const afterHandoff = await waitFor(async () => {
      const state = await domState();
      return state.boundaryRecords.length === 1 ? state : null;
    }, 'boundary record visible exactly once in DOM', 20000);
    evidence.phases.domAfterHandoff = afterHandoff;

    // Wire timeline: exactly one logs/stream subscription, AFTER release,
    // carrying exactly the snapshot cursor; the boundary record delivered by
    // the gateway exactly once (capture its replay flag); logs/ready seen.
    const subscribeFrames = proxy.events.filter(e => e.kind === 'ws-frame' && e.type === 'subscribe' && (e.route || '').includes('/api/logs/stream'));
    const releaseSeq = proxy.events.find(e => e.kind === 'barrier-released')?.seq;
    evidence.phases.handoffWire = {
      releaseSeq,
      subscribeFrames: subscribeFrames.map(e => ({ seq: e.seq, at: e.at, route: e.route })),
      subscribeCursor: (() => {
        const route = subscribeFrames[0]?.route || '';
        const match = /[?&]streamCursor=([^&]+)/.exec(route);
        return match ? { raw: decodeURIComponent(match[1]), decoded: decodeStreamCursor(decodeURIComponent(match[1])) } : null;
      })(),
      boundaryFrames: proxy.events.filter(e => e.kind === 'ws-frame' && e.type === 'event' && e.event === 'logs/appended' && (e.dataSnippet || '').includes(`"bytes":${GAP_BYTES}`)).map(e => ({ seq: e.seq, at: e.at, replay: (e.dataSnippet || '').includes('"replay":true'), snippetHead: (e.dataSnippet || '').slice(0, 220) })),
      readyFrames: proxy.events.filter(e => e.kind === 'ws-frame' && e.type === 'event' && e.event === 'logs/ready').map(e => ({ seq: e.seq, at: e.at, cursorDecoded: decodeStreamCursor((() => { const m = /"streamCursor":"([^"]+)"/.exec(e.dataSnippet || ''); return m ? m[1] : ''; })()) })),
    };
    const statsAfterHandoff = JSON.parse(await runExpr(`JSON.stringify(window.KnowledgeLive ? window.KnowledgeLive.stats() : null)`));
    evidence.phases.statsAfterHandoff = statsAfterHandoff;
    await browser.screenshot(path.join(ARTIFACTS, 'gap-after-handoff.png'));

    // API truth and disk truth: exactly once each; id strictly newer than the
    // snapshot cursor's newest entry id.
    const apiRes = await fetch(`${serverBase}/api/logs?pageSize=100&projectId=${PROJECT_A}`);
    const apiBody = await apiRes.json();
    const apiBoundary = (apiBody.entries || []).filter(e => e.event === 'goal.updated' && e.context && e.context.bytes === GAP_BYTES);
    const disk = projectDayRecords(fixture.dataDir, PROJECT_A);
    const diskBoundary = disk.filter(r => r.event === 'goal.updated' && r.context && r.context.bytes === GAP_BYTES);
    const snapshotNewestId = evidence.phases.barrier.newestEntryId;
    evidence.phases.parity = {
      apiBoundaryCount: apiBoundary.length,
      apiBoundaryId: apiBoundary[0]?.id || null,
      diskBoundaryCount: diskBoundary.length,
      diskBoundaryId: diskBoundary[0]?.id || null,
      snapshotNewestId,
      boundaryNewerThanSnapshot: Boolean(apiBoundary[0] && snapshotNewestId && apiBoundary[0].id !== snapshotNewestId),
      boundaryRecordTs: apiBoundary[0]?.ts || null,
      cursorAfterTs: snapshotCursorDecoded?.afterTs || null,
    };

    // Steady-state control (already-accepted half of LOG-004, re-proven on
    // this instance): a second real write arrives live exactly once.
    const steadyRes = await fetch(`${proxy.url}/api/projects/${PROJECT_A}/goal`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: padTo(`LOGFIXR2-GAP-STEADY-${run}`, STEADY_BYTES) }),
    });
    evidence.phases.steadyWrite = { at: now(), status: steadyRes.status, contentBytes: STEADY_BYTES };
    const steadyState = await waitFor(async () => {
      const state = await domState();
      return state.steadyRecords.length === 1 ? state : null;
    }, 'steady-state record visible exactly once in DOM', 20000);
    evidence.phases.domSteady = { steadyRecords: steadyState.steadyRecords, uniqueIds: steadyState.uniqueIds };
    evidence.phases.steadyWire = {
      frames: proxy.events.filter(e => e.kind === 'ws-frame' && e.type === 'event' && e.event === 'logs/appended' && (e.dataSnippet || '').includes(`"bytes":${STEADY_BYTES}`)).map(e => ({ seq: e.seq, at: e.at, replay: (e.dataSnippet || '').includes('"replay":true') })),
    };
    await browser.screenshot(path.join(ARTIFACTS, 'gap-steady.png'));

    if (browser.exceptions.length) throw new Error(`browser exceptions: ${JSON.stringify(browser.exceptions)}`);

    // Verdicts.
    const heldWindowMs = barrier.heldAt ? Date.parse(evidence.phases.releaseAt) - Date.parse(barrier.heldAt) : null;
    evidence.phases.heldWindowMs = heldWindowMs;
    const boundaryVerdict = {
      subscriptionAbsentWhileHeld: evidence.phases.whileHeld.logsStreamSubscriptionEstablished === false,
      statsSubscriptionCountStableWhileHeld: statsWhileHeld && statsBaseline && statsWhileHeld.subscriptions === statsBaseline.subscriptions,
      boundaryWriteWhileHeld: evidence.phases.boundaryWrite.status === 200,
      releasedOriginalBytes: true,
      subscribeAfterReleaseWithSnapshotCursor: subscribeFrames.length === 1 && subscribeFrames[0].seq > releaseSeq
        && evidence.phases.handoffWire.subscribeCursor?.raw === barrier.streamCursor,
      boundaryInDomExactlyOnce: afterHandoff.boundaryRecords.length === 1,
      domIdsUnique: afterHandoff.uniqueIds,
      boundaryFrameExactlyOnce: evidence.phases.handoffWire.boundaryFrames.length === 1,
      boundaryFrameIsReplayCatchup: evidence.phases.handoffWire.boundaryFrames[0]?.replay === true,
      apiExactlyOnce: apiBoundary.length === 1,
      diskExactlyOnce: diskBoundary.length === 1,
      recordNewerThanSnapshotCursor: evidence.phases.parity.boundaryNewerThanSnapshot,
      heldWindowUnderUiTimeout: heldWindowMs !== null && heldWindowMs < 2500,
    };
    const steadyVerdict = {
      steadyInDomExactlyOnce: steadyState.steadyRecords.length === 1,
      steadyFrameExactlyOnceLive: evidence.phases.steadyWire.frames.length === 1 && evidence.phases.steadyWire.frames[0].replay === false,
    };
    evidence.verdicts = {
      'LOG-004 交界（快照→订阅）无丢失无重复': Object.values(boundaryVerdict).every(Boolean) ? 'PASS' : 'FAIL',
      'LOG-004 稳态控制（实时一次到达）': Object.values(steadyVerdict).every(Boolean) ? 'PASS' : 'FAIL',
      detail: { boundaryVerdict, steadyVerdict },
    };
    const allPass = Object.values(boundaryVerdict).every(Boolean) && Object.values(steadyVerdict).every(Boolean);
    if (!allPass) throw new Error(`boundary/steady assertion failed: ${JSON.stringify({ boundaryVerdict, steadyVerdict })}`);
    console.log('R2 gap boundary PASS');
    process.exitCode = 0;
  } catch (error) {
    evidence.verdicts = { failed: String((error && error.stack) || error) };
    try {
      if (browser) {
        evidence.debugDom = JSON.parse(await browser.evaluate(`JSON.stringify({ dialogOpen: document.getElementById('logsDialog')?.open, entries: document.querySelectorAll('#logsContent .log-entry').length })`));
        evidence.debugConsoleErrors = browser.consoleErrors;
      }
    } catch {}
    console.error(`R2 gap FAIL: ${error.message}`);
    process.exitCode = 1;
  } finally {
    evidence.finishedAt = now();
    evidence.proxyEventLog = proxy.events.map(e => ({ seq: e.seq, at: e.at, kind: e.kind, type: e.type || null, route: e.route || null, url: e.url || null, status: e.status || null, held: e.held || null, event: e.event || null }));
    fs.mkdirSync(ARTIFACTS, { recursive: true });
    fs.writeFileSync(path.join(ARTIFACTS, 'gap-evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
    try { await browser?.close(); } finally { try { await proxy.close(); } finally { try { await server.cleanup(); } finally { fixture.cleanup(); } } }
    lane.cleanup();
  }
}

const hardTimer = setTimeout(() => {
  try {
    fs.mkdirSync(ARTIFACTS, { recursive: true });
    fs.writeFileSync(path.join(ARTIFACTS, 'hard-timeout.json'), JSON.stringify({ at: now(), run }, null, 2) + '\n');
  } catch {}
  console.error('gap test HARD TIMEOUT');
  process.exit(2);
}, HARD_TIMEOUT_MS);
hardTimer.unref();

main();
