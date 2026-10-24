'use strict';
// P-LINUX-CI-CLOSEOUT-R7 focused case: the log007 day-filter contract, pinned
// deterministically OFFLINE (real Logger + real LogRepository; no server, no
// browser, no clock race).
//
// CI shape reproduced (run 40062048045, linux22+24, log007
// timeDayGranularity=false while every other filter stayed green): the live
// server writes a project-scoped bridge_consumer.identity_backfilled record
// into the same local-day file ~0.2-1s after health, so the old
// count === 4 day-window expectation raced the server's own async startup
// write and lost on the Linux boot timing (Windows CI landed it after the
// queries). Here the same five-record shape is built with the real logger and
// the record-anchored contract is asserted: all four fixture records appear in
// their day's window, and EVERY entry of a from=X&to=X window carries
// localDay(ts) === X.
//
// Day-boundary contract: records with explicit timestamps one millisecond
// either side of a UTC midnight keep whatever local days the machine's zone
// assigns; the windows derived from the records themselves return exactly the
// records dated inside them (file-day naming and matches-day must agree in
// any zone — the property the old now/now±24h window construction could not
// guarantee).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

const { installLoggingTestEnv, resolveEvidenceDir } = require('./helpers/parallel-logging-integration-5025-env');
const lane = installLoggingTestEnv({ caseId: 'LINUX-CI-R7-LOG007-DAY', prefix: 'lcr7day' });

const { Logger, LogRepository, localDay } = require('../lib/structured-logger');
const { StorageLayout } = require('../lib/storage-layout');

const ROOT = path.resolve(__dirname, '../..');
const ARTIFACTS = resolveEvidenceDir(path.resolve(ROOT, 'qa-autopilot/artifacts/parallel-20261023/linux-ci-closeout-r7/evidence/log007-day'));
const PROJECT = 'project-lcr7-day';

const shiftDay = (day, delta) => new Date(Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)) + delta)).toISOString().slice(0, 10);

(async () => {
  fs.mkdirSync(ARTIFACTS, { recursive: true });
  const evidence = { caseId: 'LINUX-CI-R7-LOG007-DAY', startedAt: new Date().toISOString(), platform: process.platform };
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-r7-day-'));
  const layout = new StorageLayout({ dataDir });
  const settings = { levels: ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] };
  const logger = new Logger({ layout, settingsProvider: () => settings });
  const repository = new LogRepository({ layout });
  try {
    // --- 1. the CI five-record shape ------------------------------------
    const baseTs = new Date().toISOString();
    const fixtureEvents = ['lcr7.early.info', 'lcr7.early.warn', 'lcr7.late.warn', 'lcr7.late.error'];
    for (const [index, event] of fixtureEvents.entries()) {
      await logger.log(index === 3 ? 'error' : index === 0 ? 'info' : 'warn', event, `LCR7 ${event}`, { ts: baseTs, projectId: PROJECT, component: `lcr7-comp-${'abc'[index % 3]}` });
    }
    // The server's own startup record: project-scoped, same day, written by
    // the same real logger path.
    await logger.log('info', 'bridge_consumer.identity_backfilled', 'identity backfilled', { ts: baseTs, projectId: PROJECT, component: 'bridge-consumer' });

    const day = localDay(baseTs);
    const window = await repository.query({ projectId: PROJECT, from: day, to: day, pageSize: 100 });
    const events = window.entries.map(entry => entry.event).sort();
    const oldExpectationHeld = window.entries.length === 4;
    assert.equal(window.entries.length, 5, 'the CI shape holds five same-day project records, not four');
    assert.equal(oldExpectationHeld, false, 'the old count === 4 day-window expectation is exactly what failed on CI');
    for (const event of fixtureEvents) assert.ok(events.includes(event), `fixture record ${event} must appear in its day window`);
    for (const entry of window.entries) assert.equal(localDay(entry.ts), day, `every from=X&to=X entry must be dated X (${entry.event})`);
    const next = await repository.query({ projectId: PROJECT, from: shiftDay(day, 1), to: shiftDay(day, 1), pageSize: 100 });
    const prev = await repository.query({ projectId: PROJECT, from: shiftDay(day, -1), to: shiftDay(day, -1), pageSize: 100 });
    assert.equal(next.entries.length, 0, 'the next-day window is empty for same-day records');
    assert.equal(prev.entries.length, 0, 'the previous-day window is empty for same-day records');
    evidence.ciShape = { day, count: window.entries.length, events, oldCountFourWouldFail: true };

    // --- 2. day-boundary records in whatever zone the machine runs ------
    const beforeMidnight = '2026-01-01T23:59:59.999Z';
    const afterMidnight = '2026-01-02T00:00:00.001Z';
    await logger.log('info', 'lcr7.boundary.before', 'boundary before', { ts: beforeMidnight, projectId: PROJECT, component: 'lcr7-boundary' });
    await logger.log('info', 'lcr7.boundary.after', 'boundary after', { ts: afterMidnight, projectId: PROJECT, component: 'lcr7-boundary' });
    const dayBefore = localDay(beforeMidnight);
    const dayAfter = localDay(afterMidnight);
    const windowBefore = await repository.query({ projectId: PROJECT, component: 'lcr7-boundary', from: dayBefore, to: dayBefore, pageSize: 100 });
    const windowAfter = await repository.query({ projectId: PROJECT, component: 'lcr7-boundary', from: dayAfter, to: dayAfter, pageSize: 100 });
    assert.ok(windowBefore.entries.some(entry => entry.event === 'lcr7.boundary.before'), 'the pre-midnight record is in its own local-day window');
    assert.ok(windowAfter.entries.some(entry => entry.event === 'lcr7.boundary.after'), 'the post-midnight record is in its own local-day window');
    assert.equal(windowBefore.entries.some(entry => entry.event === 'lcr7.boundary.after'), dayBefore === dayAfter,
      'the post-midnight record appears in the pre-midnight window only when the zone maps both timestamps to one local day');
    for (const entry of windowBefore.entries) assert.equal(localDay(entry.ts), dayBefore, `boundary window entry dated outside the window (${entry.event})`);
    for (const entry of windowAfter.entries) assert.equal(localDay(entry.ts), dayAfter, `boundary window entry dated outside the window (${entry.event})`);
    evidence.dayBoundary = { zoneOffsetMinutes: new Date().getTimezoneOffset(), dayBefore, dayAfter, sameLocalDay: dayBefore === dayAfter };

    // --- 3. the day-string arithmetic the driver now uses ---------------
    assert.equal(shiftDay('2026-01-01', -1), '2025-12-31', 'previous day crosses the year boundary');
    assert.equal(shiftDay('2026-02-28', 1), '2026-03-01', 'next day crosses the non-leap February boundary');
    assert.equal(shiftDay('2026-10-24', 1), '2026-10-25', 'next day of the CI failure date');
    assert.equal(shiftDay('2026-10-24', -1), '2026-10-23', 'previous day of the CI failure date');
    evidence.shiftDay = { yearBoundary: true, februaryBoundary: true };

    evidence.verdict = 'PASS — five-record CI shape returns all four fixture records with every window entry correctly dated (old count===4 expectation reproduced as false); UTC-millisecond boundary records land in their zone-assigned local-day windows; day-string arithmetic is boundary-correct';
  } finally {
    evidence.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(ARTIFACTS, 'log007-day-evidence.json'), JSON.stringify(evidence, null, 2) + '\n', 'utf8');
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    lane.cleanup();
  }
  console.log('LINUX-CI-R7 LOG-007 DAY PASS');
  process.exitCode = 0;
})().catch(error => {
  console.error(`LINUX-CI-R7 LOG-007 DAY FAIL: ${error.message}`);
  process.exitCode = 1;
});
