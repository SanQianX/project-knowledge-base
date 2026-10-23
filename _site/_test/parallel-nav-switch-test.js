'use strict';
// NAV-005 — 项目快速切换。
//
// Switching projects quickly must show one project at a time, a late answer
// must not paint another project over the current one, and the project that
// reaches the embedded module must be the current one.
//
// The regression drives the real product UI in a real browser against an
// isolated instance (own port, own data dir, own knowledge dir, own Bridge
// journal, own browser profile). The project switch is a real pointer click
// on the real project row. The late answer is a real held HTTP response in a
// proxy in front of the product: the shell really receives it, late. The
// knowledge snapshot is real engine state — the vendored knowledge engine is
// started for this case and the runs are written into its store.
//
// The embedded module UI is a test double that speaks the real kb:*
// protocol; it records the kb:select-project the shell really posted, so the
// project -> module mapping under test is the shell's own mapping.
//
// Screenshots are written to PK_TEST_EVIDENCE_DIR when the batch sets it, so
// this tracked file stays free of machine-specific paths.

const path = require('node:path');
const assert = require('node:assert/strict');

const { startHarness, makeRepo } = require('./helpers/parallel-nav-shell');

const EVIDENCE = process.env.PK_TEST_EVIDENCE_DIR ? path.resolve(process.env.PK_TEST_EVIDENCE_DIR) : null;

const SNAPSHOT = '/api/engine/snapshot';

/**
 * Ask the shell to read the registry again and wait until a new matching
 * read really left the browser.
 *
 * The case owns this loop instead of the shared helper because the held
 * read lives inside the shell's three second read timeout: every hundred
 * milliseconds of polling is a hundred milliseconds less of the budget the
 * late answer has to arrive in.
 */
async function refreshUntil(harness, match, timeoutMs = 20000) {
  const before = harness.productProxy.requests.filter(match).length;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await harness.requestRegistryRefresh();
    await harness.wait(50);
    const now = harness.productProxy.requests.filter(match).length;
    if (now > before) return now;
  }
  throw new Error('the shell did not make the expected read');
}

/**
 * Record every read the page really made and how it ended.
 *
 * The late answer of the previous project is only evidence if it really
 * reached the product's promise chain: a read that the shell abandons after
 * its three second timeout never reaches the guard, so the case would pass
 * without a late answer ever arriving. The hook therefore records the state
 * of every read, and the case waits for the late answer to be consumed.
 */
const FETCH_HOOK = `(() => {
  window.__fetches = [];
  const nativeFetch = window.fetch;
  window.fetch = function (input) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const entry = { url: String(url), state: 'pending', at: Date.now() };
    window.__fetches.push(entry);
    const args = arguments;
    return nativeFetch.apply(this, args).then(response => {
      entry.state = 'responded';
      entry.status = response.status;
      const originalJson = response.json.bind(response);
      response.json = () => originalJson().then(data => {
        entry.state = 'consumed';
        entry.endedAt = Date.now();
        return data;
      }, error => {
        entry.state = 'failed';
        entry.endedAt = Date.now();
        throw error;
      });
      return response;
    }, error => {
      entry.state = 'aborted';
      entry.endedAt = Date.now();
      throw error;
    });
  };
})()`;

/** The reads of the given project the page really made. */
const projectReads = (harness, projectId, skip = 0) => harness.run(`(window.__fetches || []).filter(entry => entry.url.includes('/api/engine/snapshot') && entry.url.includes(${JSON.stringify(`projectId=${projectId}`)})).slice(${skip})`);

async function main() {
  const harness = await startHarness({ tag: 'nav005', evidenceDir: EVIDENCE || undefined });
  try {
    // The hook is installed before the case starts, so every read of the
    // case is recorded.
    await harness.run(FETCH_HOOK);
    const repoA = makeRepo(harness.fixture, 'nav005-a');
    const repoB = makeRepo(harness.fixture, 'nav005-b');
    const projectA = await harness.importProject(repoA, 'NAV005 甲');
    const projectB = await harness.importProject(repoB, 'NAV005 乙');

    // Real engine state: one run per project, on the real baseline commit.
    harness.engine.store.addRun({ projectId: projectA.projectId, commitSha: repoA.headCommit, trigger: 'manual' });
    harness.engine.store.addRun({ projectId: projectB.projectId, commitSha: repoB.headCommit, trigger: 'manual' });
    const shortA = repoA.headCommit.slice(0, 8);
    const shortB = repoB.headCommit.slice(0, 8);

    await harness.requestRegistryRefresh();
    await harness.waitFor(
      () => harness.run(`document.getElementById('homeContent').textContent.includes(${JSON.stringify(shortA)})`),
      'the current project shows its own run',
      20000,
    );

    const homeText = () => harness.run("document.getElementById('homeContent').textContent");
    const currentProject = () => harness.run("document.getElementById('projectSelect').value");

    // The terminal frame is opened once so the project mapping the shell
    // really posts is observable.
    await harness.run("document.querySelector('[data-view=\"work\"]').click()");
    await harness.waitFor(
      async () => {
        const messages = await harness.frameMessages('workFrame');
        return Array.isArray(messages) && messages.some(message => message.type === 'kb:select-project');
      },
      'the terminal frame receives kb:select-project',
      20000,
    );
    await harness.run("document.querySelector('[data-view=\"home\"]').click()");
    await harness.waitFor(() => harness.run("document.getElementById('view-home').classList.contains('active')"), 'the home view');

    assert.equal(await currentProject(), projectA.projectId, 'the first project is the current one');

    // How many reads of the first project the page already made: the held
    // read is the next one, and the late answer is the one after it.
    const readsBeforeHold = (await projectReads(harness, projectA.projectId)).length;

    // A registry refresh reads the snapshot of the current project; that read
    // is held so it can be released after the switch.
    harness.productProxy.hold(entry => entry.method === 'GET' && entry.path.startsWith(SNAPSHOT) && entry.path.includes(`projectId=${projectA.projectId}`), { once: true });
    await refreshUntil(harness, entry => entry.path.startsWith(SNAPSHOT) && entry.path.includes(`projectId=${projectA.projectId}`));
    await harness.waitFor(
      () => harness.productProxy.heldCount() > 0,
      'the snapshot read of the current project is held',
      20000,
    );

    // The switch to the other project is a real pointer click on the row.
    await harness.nativeClick(`#homeContent [data-select-project="${projectB.projectId}"]`);
    await harness.waitFor(async () => (await currentProject()) === projectB.projectId, 'the second project becomes the current one');
    await harness.waitFor(
      () => harness.run(`document.getElementById('homeContent').textContent.includes(${JSON.stringify(shortB)})`),
      'the second project shows its own run',
      20000,
    );

    // NAV-005 expected 1: only the current project is shown.
    let text = await homeText();
    assert.ok(text.includes(shortB), 'the current project run is shown');
    assert.equal(text.includes(shortA), false, 'the other project run is not shown while the second project is current');

    // NAV-005 expected 2: the late answer of the previous project must not
    // paint over the current project.
    //
    // The snapshot reads are broken from here on, so that no automatic
    // refresh can repair the page and hide a late answer that was wrongly
    // applied. Without the shell's epoch and project guard the late snapshot
    // of the other project would replace the current one, and the home would
    // lose the run of the current project.
    harness.productProxy.fail(entry => entry.method === 'GET' && entry.path.startsWith(SNAPSHOT), 503, '注入的快照读取故障');
    const released = harness.productProxy.releaseHeld();
    assert.ok(released >= 1, 'the held snapshot read is really delivered late');

    // The late answer must really have reached the page: a read the shell
    // abandons after its three second timeout never reaches the guard, and
    // the case would prove nothing about a late answer that never arrived.
    const lateRead = await harness.waitFor(
      async () => {
        const reads = await projectReads(harness, projectA.projectId, readsBeforeHold);
        const last = reads[reads.length - 1];
        if (!last || last.state === 'pending' || last.state === 'responded') return null;
        return last;
      },
      'the late answer really reached the page',
      20000,
    );
    assert.equal(lateRead.state, 'consumed', `the late answer was really consumed by the page: ${JSON.stringify(lateRead)}`);
    // Two frames: the page really painted the outcome of the late answer.
    await harness.run('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))');

    // The fault must really bite a real read. The shell reads the snapshot
    // again on its own schedule, but the case does not wait for that: it
    // asks the shell to read the registry again and waits until the proxy
    // really saw a failed snapshot read. Without a failed read the case
    // could not claim that no successful refresh was able to mask the late
    // answer.
    const failedReads = await refreshUntil(harness, entry => entry.path.startsWith(SNAPSHOT) && entry.status === 503);
    assert.ok(failedReads >= 1, `the snapshot read really failed while the late answer was delivered: ${failedReads}`);

    text = await homeText();
    assert.equal(await currentProject(), projectB.projectId, 'the current project did not change because of the late answer');
    assert.ok(text.includes(shortB), 'the current project run is still shown after the late answer');
    assert.equal(text.includes(shortA), false, 'the late answer of the other project did not overwrite the current project');
    const failedSnapshotReads = harness.productProxy.requests.filter(entry => entry.path.startsWith(SNAPSHOT) && entry.status === 503).length;
    assert.ok(failedSnapshotReads >= 1, `the snapshot reads really failed while the late answer was delivered, so no refresh could mask it: ${failedSnapshotReads} failed reads`);
    harness.productProxy.clearFaults();

    // The switch back is a real pointer click as well.
    await harness.nativeClick(`#homeContent [data-select-project="${projectA.projectId}"]`);
    await harness.waitFor(async () => (await currentProject()) === projectA.projectId, 'the first project becomes the current one again');
    await harness.waitFor(
      () => harness.run(`document.getElementById('homeContent').textContent.includes(${JSON.stringify(shortA)})`),
      'the first project shows its own run again',
      20000,
    );
    text = await homeText();
    assert.equal(text.includes(shortB), false, 'the other project run is not shown after switching back');
    await harness.browser.screenshot(path.join(harness.evidence, 'nav005-switch-back.png'));

    // NAV-005 expected 3: the project that reaches the embedded module is the
    // current one, and the mapping is the one the product registered.
    const mappings = (await harness.frameMessages('workFrame')).filter(message => message.type === 'kb:select-project');
    const last = mappings[mappings.length - 1];
    assert.ok(last, 'the terminal frame really received kb:select-project');
    assert.equal(last.projectId, projectA.projectId, 'the newest kb:select-project carries the current project');
    assert.equal(last.project, projectA.project.state.modules.terminal.projectId, 'the newest kb:select-project carries the module project the product registered for it');
    const forB = mappings.find(message => message.projectId === projectB.projectId);
    assert.ok(forB, 'the terminal frame really received the mapping of the other project');
    assert.equal(forB.project, projectB.project.state.modules.terminal.projectId, 'the mapping of the other project is the module project the product registered for it');
    const requestIds = mappings.map(message => message.requestId);
    assert.ok(requestIds.every(requestId => /^\d+:terminal$/.test(String(requestId))), `every mapping carries the shell request id: ${JSON.stringify(requestIds)}`);
    assert.notEqual(forB.requestId, last.requestId, 'the switch to the other project used a new request id');
    assert.ok(mappings.every(message => message.projectId === projectA.projectId || message.projectId === projectB.projectId), 'no mapping carries a project that was never current');

    assert.equal(harness.browser.exceptions.length, 0, `no uncaught product JavaScript exceptions: ${JSON.stringify(harness.browser.exceptions)}`);

    console.log('parallel-nav-switch-test PASS (one project at a time, the late answer does not cross projects, the module mapping follows the current project)');
  } finally {
    await harness.cleanup();
  }
}

main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
