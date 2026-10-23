'use strict';
// NAV-008 — 断网恢复。
//
// When the browser loses the network the shell must close the old stream, and
// when the network comes back it must restore the snapshot and open a new
// stream — exactly one subscription per stream, and no content that pretends
// to be live while it is not.
//
// The regression drives the real product UI in a real browser against an
// isolated instance (own port, own data dir, own knowledge dir, own Bridge
// journal, own browser profile, own vendored knowledge engine). The network
// outage is a real browser outage: CDP Network.emulateNetworkConditions puts
// the browser offline, so navigator.onLine really turns false, the browser
// really cannot reach the product, and the real 'offline' and 'online' events
// really fire.
//
// The evidence is taken from three independent places:
//
//   * the page itself: every WebSocket the shell opened and every
//     subscription message it sent, recorded before the page's own scripts
//     run;
//   * the product proxy: the reads the browser really made;
//   * the engine proxy: the streams the product really opened on the engine.
//
// Screenshots are written to PK_TEST_EVIDENCE_DIR when the batch sets it, so
// this tracked file stays free of machine-specific paths.

const path = require('node:path');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');

const { startHarness, makeRepo } = require('./helpers/parallel-nav-shell');

const EVIDENCE = process.env.PK_TEST_EVIDENCE_DIR ? path.resolve(process.env.PK_TEST_EVIDENCE_DIR) : null;

const SNAPSHOT = '/api/engine/snapshot';

/**
 * Record every WebSocket the page opens, every subscription message it
 * sends and every close the browser really performed. The hook is installed
 * before the page's own scripts run, so the first stream of the page is
 * recorded too.
 *
 * The close event is the evidence that the browser really closed the old
 * stream: the shell drops its own bookkeeping as soon as it asks the socket
 * to close, while the browser reaches the closed state only when the
 * connection is really gone.
 */
const SOCKET_HOOK = `(() => {
  window.__sockets = [];
  window.__sent = [];
  window.__closed = [];
  const Native = window.WebSocket;
  const Wrapped = function (...args) {
    const ws = new Native(...args);
    const generation = window.__sockets.length;
    window.__sockets.push(ws);
    ws.addEventListener('close', event => {
      window.__closed.push({ generation, code: event.code, wasClean: event.wasClean, readyState: ws.readyState, at: Date.now() });
    });
    const send = ws.send.bind(ws);
    ws.send = function (data) {
      try {
        const parsed = JSON.parse(data);
        window.__sent.push({ generation, type: parsed.type || '', id: parsed.id || '', route: parsed.route || '' });
      } catch {}
      return send(data);
    };
    return ws;
  };
  Wrapped.prototype = Native.prototype;
  Object.setPrototypeOf(Wrapped, Native);
  window.WebSocket = Wrapped;
})()`;

const socketStates = harness => harness.run('window.__sockets.map(socket => socket.readyState)');
const sentMessages = harness => harness.run('window.__sent || []');
const closeEvents = harness => harness.run('window.__closed || []');
const liveStats = harness => harness.run('window.KnowledgeLive.stats()');
const connectionLabel = harness => harness.run("document.getElementById('activityConnection').textContent");
const homeText = harness => harness.run("document.getElementById('homeContent').textContent");

/** The subscriptions that are still live on one socket generation. */
function activeSubscriptions(messages, generation) {
  const active = new Map();
  for (const message of messages) {
    if (message.generation !== generation) continue;
    if (message.type === 'subscribe') active.set(message.id, message.route);
    else if (message.type === 'unsubscribe') active.delete(message.id);
  }
  return active;
}

function gitCommit(repo, fileName, content) {
  const fs = require('node:fs');
  fs.writeFileSync(path.join(repo, fileName), content);
  const run = args => {
    const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
    return String(result.stdout || '').trim();
  };
  run(['add', '.']);
  run(['commit', '-qm', `second ${fileName}`]);
  return run(['rev-parse', 'HEAD']);
}

async function main() {
  const harness = await startHarness({ tag: 'nav008', evidenceDir: EVIDENCE || undefined });
  try {
    const repo = makeRepo(harness.fixture, 'nav008-a');
    const project = await harness.importProject(repo, 'NAV008 甲');
    const shortFirst = repo.headCommit.slice(0, 8);
    // Real engine state: the first run of the project.
    harness.engine.store.addRun({ projectId: project.projectId, commitSha: repo.headCommit, trigger: 'manual' });

    // The page is reloaded with the socket hook in place, so the very first
    // stream of the page is recorded as well.
    await harness.browser.send('Page.addScriptToEvaluateOnNewDocument', { source: SOCKET_HOOK });
    await harness.browser.send('Page.reload', { ignoreCache: true });
    await harness.waitFor(() => harness.run("document.readyState === 'complete'"), 'the reloaded page');
    await harness.waitFor(
      async () => (await homeText(harness)).includes(shortFirst),
      'the reloaded page shows the run of the project',
      20000,
    );
    await harness.waitFor(
      async () => {
        const stats = await liveStats(harness);
        return stats.connections === 1 && stats.subscriptions >= 2;
      },
      'the live channel is connected',
      20000,
    );
    await harness.waitFor(
      async () => (await connectionLabel(harness)).includes('已连接实时更新'),
      'the shell reports the live connection',
      20000,
    );

    // The baseline of the healthy state.
    const baselineStats = await liveStats(harness);
    const baselineSockets = await socketStates(harness);
    const baselineSent = await sentMessages(harness);
    assert.equal(baselineSockets.length, 1, `the page opened one live socket: ${JSON.stringify(baselineSockets)}`);
    assert.equal(baselineSockets[0], 1, 'the live socket is open');
    assert.equal(baselineStats.subscriptions, 2, `the shell holds two subscriptions: ${JSON.stringify(baselineStats)}`);
    const baselineActive = activeSubscriptions(baselineSent, 0);
    assert.equal(baselineActive.size, 2, `the shell subscribed two channels: ${JSON.stringify([...baselineActive])}`);
    assert.equal(new Set(baselineActive.values()).size, 2, `the two baseline subscriptions are for two different streams: ${JSON.stringify([...baselineActive])}`);
    const baselineProgressReads = harness.engineProxy.requests.filter(entry => entry.path.startsWith('/api/progress')).length;
    assert.ok(baselineProgressReads >= 1, `the engine really holds a progress stream: ${baselineProgressReads}`);

    // The second commit of the fixture repository gives the second run a
    // real commit of its own.
    const secondSha = gitCommit(repo.path, 'SECOND.md', '# second\n');
    const shortSecond = secondSha.slice(0, 8);

    // ---- the network goes away ----
    await harness.setOffline(true);
    await harness.waitFor(() => harness.run('navigator.onLine === false'), 'the browser really goes offline');
    await harness.waitFor(
      async () => {
        const stats = await liveStats(harness);
        return stats.connections === 0 && stats.subscriptions === 0;
      },
      'the shell closes the old stream',
      20000,
    );

    const offlineSockets = await socketStates(harness);
    assert.equal(offlineSockets.length, 1, `the page still holds one socket object: ${JSON.stringify(offlineSockets)}`);
    // The browser closes the stream on its own schedule: the shell drops its
    // bookkeeping as soon as it asks the socket to close, so the closed
    // state has to be waited for instead of being sampled right away.
    const closedOld = await harness.waitFor(
      async () => {
        const events = await closeEvents(harness);
        const close = events.find(event => event.generation === 0);
        if (!close) return null;
        const states = await socketStates(harness);
        return { close, states };
      },
      'the browser really closes the old stream',
      20000,
    );
    assert.equal(closedOld.states[0], 3, `the old stream is really closed by the browser: ${JSON.stringify(closedOld)}`);
    assert.equal(closedOld.close.readyState, 3, `the browser closed the old stream in the closed state: ${JSON.stringify(closedOld.close)}`);

    // NAV-008 expected 3: the content does not pretend to be live. The shell
    // says the connection is broken, and it does not show the update list as
    // if it were live information.
    const offlineLabel = await connectionLabel(harness);
    assert.equal(offlineLabel.includes('已连接实时更新'), false, `the shell does not claim a live connection while it is offline: ${offlineLabel}`);
    assert.ok(offlineLabel.includes('连接中断'), `the shell reports the broken connection: ${offlineLabel}`);
    const offlineHome = await homeText(harness);
    assert.ok(offlineHome.includes('知识引擎暂时不可用'), `the home does not show stale updates as live information: ${offlineHome}`);
    await harness.browser.screenshot(path.join(harness.evidence, 'nav008-offline.png'));

    // No read of the snapshot reached the product while the browser was
    // offline: the outage is real, not a silent retry.
    const requestsBeforeOffline = harness.productProxy.requests.length;
    await harness.wait(1200);
    const requestsDuringOffline = harness.productProxy.requests.slice(requestsBeforeOffline);
    const snapshotDuringOffline = requestsDuringOffline.filter(entry => entry.path.startsWith(SNAPSHOT));
    assert.deepEqual(snapshotDuringOffline, [], `no snapshot read reached the product while the browser was offline: ${JSON.stringify(snapshotDuringOffline)}`);

    // Real engine state that the browser cannot know while it is offline.
    harness.engine.store.addRun({ projectId: project.projectId, commitSha: secondSha, trigger: 'manual' });

    // ---- the network comes back ----
    await harness.setOffline(false);
    await harness.waitFor(() => harness.run('navigator.onLine === true'), 'the browser really comes online');
    await harness.waitFor(
      async () => {
        const stats = await liveStats(harness);
        return stats.connections === 1 && stats.subscriptions === 2;
      },
      'the shell opens the new stream',
      20000,
    );
    await harness.waitFor(
      async () => (await connectionLabel(harness)).includes('已连接实时更新'),
      'the shell reports the new live connection',
      20000,
    );

    const recoveredStats = await liveStats(harness);
    const recoveredSockets = await socketStates(harness);
    const recoveredSent = await sentMessages(harness);
    const recoveredClosed = await closeEvents(harness);
    assert.equal(recoveredSockets.length, 2, `the page opened a second socket after the recovery: ${JSON.stringify(recoveredSockets)}`);
    assert.equal(recoveredSockets[0], 3, `the old socket stays closed: ${JSON.stringify(recoveredSockets)} ${JSON.stringify(recoveredClosed)}`);
    assert.equal(recoveredSockets[1], 1, 'the new socket is open');
    assert.equal(recoveredClosed.filter(event => event.generation === 1).length, 0, `the new stream was not closed by the outage: ${JSON.stringify(recoveredClosed)}`);

    // NAV-008 expected 2: no duplicated subscription. The subscriptions of
    // the new socket are exactly the two streams of the shell, each of them
    // once, and the count of the shell matches them.
    const recoveredActive = activeSubscriptions(recoveredSent, 1);
    assert.equal(recoveredActive.size, 2, `the new socket carries exactly two subscriptions: ${JSON.stringify([...recoveredActive])}`);
    assert.equal(new Set(recoveredActive.values()).size, 2, `the two recovered subscriptions are for two different streams: ${JSON.stringify([...recoveredActive])}`);
    assert.equal(recoveredStats.subscriptions, recoveredActive.size, `the shell counts the live subscriptions exactly: ${JSON.stringify(recoveredStats)} ${JSON.stringify([...recoveredActive])}`);
    assert.equal(recoveredStats.connections, 1, 'the shell holds exactly one live connection');
    const progressReads = harness.engineProxy.requests.filter(entry => entry.path.startsWith('/api/progress')).length;
    assert.equal(progressReads, baselineProgressReads + 1, `the engine holds one progress stream more, not more: ${progressReads}`);

    // NAV-008 expected 1: the snapshot is restored. The run that appeared
    // while the browser was offline is on the page now, and the page was
    // updated by a real read of the snapshot after the recovery.
    const snapshotReads = harness.productProxy.requests.filter(entry => entry.path.startsWith(SNAPSHOT));
    assert.ok(snapshotReads.length >= 1, 'the shell read the snapshot after the recovery');
    const lastSnapshot = snapshotReads[snapshotReads.length - 1];
    assert.equal(lastSnapshot.status, 200, `the last snapshot read really succeeded: ${JSON.stringify(lastSnapshot)}`);
    await harness.waitFor(
      async () => (await homeText(harness)).includes(shortSecond),
      'the run that appeared while the browser was offline is on the page now',
      20000,
    );
    const recoveredHome = await homeText(harness);
    assert.ok(recoveredHome.includes(shortFirst), 'the run of before the outage is still on the page');
    assert.equal(recoveredHome.includes('知识引擎暂时不可用'), false, 'the page shows the real records again');
    await harness.browser.screenshot(path.join(harness.evidence, 'nav008-recovered.png'));

    assert.equal(harness.browser.exceptions.length, 0, `no uncaught product JavaScript exceptions: ${JSON.stringify(harness.browser.exceptions)}`);

    console.log('parallel-nav-offline-test PASS (the old stream is closed, the snapshot and a new stream are restored, no duplicated subscription, nothing pretends to be live)');
  } finally {
    await harness.cleanup();
  }
}

main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
