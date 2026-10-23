'use strict';
// NAV-004 — 失败保留旧数据。
//
// When the registry read fails the shell must show the failure, must keep the
// project list it already has, and must pick up the new snapshot once the
// registry answers again.
//
// The failure is a real HTTP 503 injected by a proxy in front of the product:
// the browser really receives a failed answer, and the shell really reads a
// broken registry. The regression drives the real product UI in a real
// browser against an isolated instance (own port, own data dir, own knowledge
// dir, own Bridge journal, own browser profile, own vendored knowledge
// engine). Screenshots are written to PK_TEST_EVIDENCE_DIR when the batch
// sets it, so this tracked file stays free of machine-specific paths.

const path = require('node:path');
const assert = require('node:assert/strict');

const { startHarness, makeRepo } = require('./helpers/parallel-nav-shell');

const EVIDENCE = process.env.PK_TEST_EVIDENCE_DIR ? path.resolve(process.env.PK_TEST_EVIDENCE_DIR) : null;

const PROJECTION = '/api/projects/projection';

async function main() {
  const harness = await startHarness({ tag: 'nav004', evidenceDir: EVIDENCE || undefined });
  try {
    const repoA = makeRepo(harness.fixture, 'nav004-a');
    const repoB = makeRepo(harness.fixture, 'nav004-b');
    const repoC = makeRepo(harness.fixture, 'nav004-c');
    await harness.importProject(repoA, 'NAV004 甲');
    await harness.importProject(repoB, 'NAV004 乙');
    await harness.requestRegistryRefresh();
    await harness.waitFor(
      async () => {
        const text = await harness.run("document.getElementById('homeContent').textContent");
        return text.includes('NAV004 甲') && text.includes('NAV004 乙');
      },
      'both imported projects are listed',
      20000,
    );

    const listedProjects = () => harness.run(`(() => {
      const rows = [...document.querySelectorAll('#homeContent [data-select-project]')];
      return rows.map(button => {
        const name = button.parentElement.querySelector('b');
        return name ? name.textContent.trim() : '';
      });
    })()`);
    const failedReads = () => harness.productProxy.requests.filter(entry => entry.path.startsWith(PROJECTION) && entry.status === 503).length;

    // The registry read now fails at the HTTP level.
    harness.productProxy.fail(entry => entry.method === 'GET' && entry.path.startsWith(PROJECTION), 503, '注入的登记读取故障');
    const failuresBefore = failedReads();
    await harness.refreshRegistryAndWait();
    await harness.waitFor(async () => failedReads() > failuresBefore, 'the registry read really failed with an HTTP 503', 20000);

    // NAV-004 expected 1: the failure is visible.
    await harness.waitFor(
      () => harness.run("document.getElementById('toast').hidden === false && document.getElementById('toast').textContent.includes('暂未刷新')"),
      'the failed refresh is reported to the user',
      10000,
    );
    const toast = await harness.run("document.getElementById('toast').textContent");
    assert.ok(toast.includes('已有内容已保留'), `the failure message says the content was kept: ${toast}`);
    await harness.browser.screenshot(path.join(harness.evidence, 'nav004-read-failure.png'));

    // NAV-004 expected 2: the list that was already there is not cleared.
    const listed = (await listedProjects()).sort();
    assert.deepEqual(listed, ['NAV004 乙', 'NAV004 甲'], 'the project list still holds the projects it had before the failure');
    const homeText = await harness.run("document.getElementById('homeContent').textContent");
    assert.ok(homeText.includes('NAV004 甲'), 'the failed read keeps the first project');
    assert.ok(homeText.includes('NAV004 乙'), 'the failed read keeps the second project');
    const selectorText = await harness.run("document.getElementById('projectSelect').textContent");
    assert.ok(selectorText.includes('NAV004 甲') && selectorText.includes('NAV004 乙'), 'the failed read keeps the project selector entries');

    // A project that appears while the registry is broken must not slip into
    // the list as if it had been read.
    await harness.importProject(repoC, 'NAV004 丙');
    const failuresBeforeSecond = failedReads();
    await harness.refreshRegistryAndWait();
    await harness.waitFor(async () => failedReads() > failuresBeforeSecond, 'the second registry read really failed too', 20000);
    const duringFailure = await harness.run("document.getElementById('homeContent').textContent");
    assert.ok(duringFailure.includes('NAV004 甲') && duringFailure.includes('NAV004 乙'), 'the old projects survive the repeated failure');
    assert.equal(duringFailure.includes('NAV004 丙'), false, 'a project that was never read is not shown while the registry is broken');
    assert.deepEqual((await listedProjects()).sort(), ['NAV004 乙', 'NAV004 甲'], 'the project rows are exactly the projects read before the failure');
    await harness.browser.screenshot(path.join(harness.evidence, 'nav004-old-data-kept.png'));

    // NAV-004 expected 3: after the registry answers again, the list is
    // updated from the new snapshot.
    harness.productProxy.clearFaults();
    await harness.refreshRegistryAndWait();
    await harness.waitFor(
      () => harness.run("document.getElementById('homeContent').textContent.includes('NAV004 丙')"),
      'the recovered read shows the new project',
      20000,
    );
    const recovered = await harness.run("document.getElementById('homeContent').textContent");
    assert.ok(recovered.includes('NAV004 甲') && recovered.includes('NAV004 乙'), 'the recovered read keeps the earlier projects');
    assert.deepEqual((await listedProjects()).sort(), ['NAV004 丙', 'NAV004 乙', 'NAV004 甲'], 'the recovered list is the new snapshot');
    await harness.browser.screenshot(path.join(harness.evidence, 'nav004-recovered.png'));

    // The failure was an HTTP failure of a real read, not a shell-side guess.
    const failed = harness.productProxy.requests.filter(entry => entry.path.startsWith(PROJECTION) && entry.status === 503);
    assert.ok(failed.length >= 2, `the registry read failed at the HTTP level ${failed.length} times`);
    // The failure notice is transient: the recovery does not leave a permanent
    // error behind in the shell.
    await harness.wait(4500);
    assert.equal(await harness.run("document.getElementById('toast').hidden"), true, 'the failure message is not left behind after the recovery');

    assert.equal(harness.browser.exceptions.length, 0, `no uncaught product JavaScript exceptions: ${JSON.stringify(harness.browser.exceptions)}`);

    console.log('parallel-nav-failure-test PASS (the failure is visible, the old list survives, the recovery updates from the new snapshot)');
  } finally {
    await harness.cleanup();
  }
}

main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
