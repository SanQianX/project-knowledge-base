'use strict';
// NAV-004 — 失败保留旧数据。
//
// 迁移说明（五页简化 UI）：
// - 首页不再罗列项目：登记读取（/api/projects/projection）的 UI 投影改为
//   顶栏 #projectSelect 的选项（renderProjectOptions 与旧首页列表读同一份
//   state.projects），「已登记项目列表」的断言全部改查 #projectSelect。
// - 旧 `#homeContent [data-select-project]` 行已删除：listedProjects() 改为
//   枚举 #projectSelect 选项文本。
// - 「首页保留旧数据」等价断言：失败后首页不得翻回「正在读取项目登记…」或
//   「项目登记读取失败」空态，仍显示已载入的总览面板（需要处理/待确认/记忆组合）。
// - 失败可见性（toast「部分状态暂未刷新，已有内容已保留。」）与恢复后按新
//   快照更新的断言不变：产品文案未变。
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
        const text = await harness.run("document.getElementById('projectSelect').textContent");
        return text.includes('NAV004 甲') && text.includes('NAV004 乙');
      },
      'both imported projects are listed',
      20000,
    );

    // The registry projection surface of the five-page shell is the top-bar
    // project selector: it renders the same state.projects the old home list
    // rendered, and a failed read never reaches renderProjectOptions.
    const listedProjects = () => harness.run(`(() => {
      const select = document.getElementById('projectSelect');
      return [...select.options].filter(option => option.value).map(option => option.textContent.trim());
    })()`);
    const homeKeepsLoadedContent = async () => {
      const text = await harness.run("document.getElementById('homeContent').textContent");
      assert.equal(text.includes('正在读取项目登记'), false, `the home page is not flipped back into the loading state: ${text}`);
      assert.equal(text.includes('项目登记读取失败'), false, `the home page is not flipped into the read-failure state: ${text}`);
      assert.ok(text.includes('记忆组合'), `the home page keeps its loaded overview panels: ${text}`);
      return text;
    };
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
    await homeKeepsLoadedContent();
    const selectorText = await harness.run("document.getElementById('projectSelect').textContent");
    assert.ok(selectorText.includes('NAV004 甲') && selectorText.includes('NAV004 乙'), 'the failed read keeps the project selector entries');

    // A project that appears while the registry is broken must not slip into
    // the list as if it had been read.
    await harness.importProject(repoC, 'NAV004 丙');
    const failuresBeforeSecond = failedReads();
    await harness.refreshRegistryAndWait();
    await harness.waitFor(async () => failedReads() > failuresBeforeSecond, 'the second registry read really failed too', 20000);
    const duringFailure = await harness.run("document.getElementById('projectSelect').textContent");
    assert.ok(duringFailure.includes('NAV004 甲') && duringFailure.includes('NAV004 乙'), 'the old projects survive the repeated failure');
    assert.equal(duringFailure.includes('NAV004 丙'), false, 'a project that was never read is not shown while the registry is broken');
    assert.deepEqual((await listedProjects()).sort(), ['NAV004 乙', 'NAV004 甲'], 'the project entries are exactly the projects read before the failure');
    await homeKeepsLoadedContent();
    await harness.browser.screenshot(path.join(harness.evidence, 'nav004-old-data-kept.png'));

    // NAV-004 expected 3: after the registry answers again, the list is
    // updated from the new snapshot.
    harness.productProxy.clearFaults();
    await harness.refreshRegistryAndWait();
    await harness.waitFor(
      () => harness.run("document.getElementById('projectSelect').textContent.includes('NAV004 丙')"),
      'the recovered read shows the new project',
      20000,
    );
    const recovered = await harness.run("document.getElementById('projectSelect').textContent");
    assert.ok(recovered.includes('NAV004 甲') && recovered.includes('NAV004 乙'), 'the recovered read keeps the earlier projects');
    assert.deepEqual((await listedProjects()).sort(), ['NAV004 丙', 'NAV004 乙', 'NAV004 甲'], 'the recovered list is the new snapshot');
    await harness.browser.screenshot(path.join(harness.evidence, 'nav004-recovered.png'));

    // The failure was an HTTP failure of a real read, not a shell-side guess.
    const failed = harness.productProxy.requests.filter(entry => entry.path.startsWith(PROJECTION) && entry.status === 503);
    assert.ok(failed.length >= 2, `the registry read failed at the HTTP level ${failed.length} times`);
    // The failure notice is transient: the recovery does not leave a permanent
    // error behind in the shell (the notice hides on its own timer).
    await harness.waitFor(
      () => harness.run("document.getElementById('toast').hidden === true"),
      'the failure message is not left behind after the recovery',
      10000,
    );

    assert.equal(harness.browser.exceptions.length, 0, `no uncaught product JavaScript exceptions: ${JSON.stringify(harness.browser.exceptions)}`);

    console.log('parallel-nav-failure-test PASS (the failure is visible, the old list survives, the recovery updates from the new snapshot)');
  } finally {
    await harness.cleanup();
  }
}

main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
