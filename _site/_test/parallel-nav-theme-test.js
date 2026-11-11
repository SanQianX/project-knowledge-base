'use strict';
// NAV-002 — 主题同步。
//
// 迁移说明（五页简化 UI）：
// - nav [data-view] 契约：只有 home/memory/projects/search/activity 五页，
//   work 导航按钮已移除；断言导航恰好五项且不含 work。
// - '#work' 与未知 hash 经 titles 检查回落 home（history.replaceState 归位
//   '#home'，#view-home active、标题「首页」）。
// - work 不再是导航页：#view-work 仍在 DOM 且永远 hidden，内部 #workFrame
//   保留为 Workbench 服务挂载点。终端帧的打开路径从「点击 work 导航」改为
//   「#openSystem 系统抽屉 → #configureProviders」（initializeFrame('terminal')）。
// - vectorHub/vectorFrame 已删除（检索页改为服务端检索），帧列表只剩
//   terminal(workFrame) 与 eventBridge(bridgeFrame)。
// - 首页不再罗列项目：导入后的项目出现改为断言顶栏 #projectSelect 选项。
//
// The shell owns the product theme: switching it must persist, every embedded
// module that is already ready must be told about the new theme, and the
// switch must not rebuild the module task.
//
// The regression drives the real product UI in a real browser against an
// isolated instance (own port, own data dir, own knowledge dir, own Bridge
// journal, own browser profile, own vendored knowledge engine). The embedded
// module UI is a test double that speaks the real kb:* protocol: it announces
// kb:ready, records every kb:* message the shell really posted, and counts
// how often its document was really served — a rebuilt task is a served
// document. The substituted part is the module's own UI, not the shell.
//
// Screenshots are written to PK_TEST_EVIDENCE_DIR when the batch sets it, so
// this tracked file stays free of machine-specific paths.

const path = require('node:path');
const assert = require('node:assert/strict');

const { startHarness, makeRepo } = require('./helpers/parallel-nav-shell');

const EVIDENCE = process.env.PK_TEST_EVIDENCE_DIR ? path.resolve(process.env.PK_TEST_EVIDENCE_DIR) : null;

// The workbench frame survives only as a hidden service mount (opened from the
// system drawer), and the event bridge still lives on the activity page. The
// vector hub frame was removed with the work navigation page.
const FRAMES = [
  { key: 'eventBridge', id: 'bridgeFrame', view: 'activity' },
  { key: 'terminal', id: 'workFrame' },
];

async function main() {
  const harness = await startHarness({ tag: 'nav002', evidenceDir: EVIDENCE || undefined });
  try {
    const repo = makeRepo(harness.fixture, 'nav002-project');
    await harness.importProject(repo, 'NAV002 项目');

    // The shell boots on its own registry read.
    await harness.waitFor(
      () => harness.run("document.getElementById('homeContent').textContent.trim().length > 0"),
      'the shell reads the registry',
      20000,
    );
    await harness.requestRegistryRefresh();
    await harness.waitFor(
      () => harness.run("[...document.getElementById('projectSelect').options].some(option => option.textContent === 'NAV002 项目')"),
      'the imported project is listed',
      20000,
    );

    // NAV-002 navigation contract (five-page UI): exactly the five pages, no
    // work button, and the workbench survives as a hidden service mount.
    assert.deepEqual(
      await harness.run("[...document.querySelectorAll('nav [data-view]')].map(button => button.dataset.view)"),
      ['home', 'memory', 'projects', 'search', 'activity'],
      'the navigation offers exactly the five pages',
    );
    assert.equal(await harness.run("document.querySelector('[data-view=\"work\"]') === null"), true, 'the work navigation button is removed');
    assert.equal(await harness.run("document.getElementById('view-work') !== null"), true, 'the work section survives in the DOM');
    assert.equal(await harness.run("document.getElementById('view-work').hidden"), true, 'the work section stays hidden');
    assert.equal(await harness.run("document.getElementById('workFrame') !== null"), true, 'the workbench service mount (workFrame) survives');
    // Unknown hashes fall back to home through the same titles guard the
    // product uses; the workbench page itself is no longer reachable.
    for (const hash of ['#work', '#anything']) {
      await harness.run(`location.hash = ${JSON.stringify(hash)}`);
      await harness.waitFor(
        async () => (await harness.run("document.getElementById('view-home').classList.contains('active')"))
          && (await harness.run("document.getElementById('pageTitle').textContent")) === '首页'
          && (await harness.run("location.hash")) === '#home',
        `the ${hash} hash falls back to home`,
        10000,
      );
      assert.equal(await harness.run("document.getElementById('view-work').hidden"), true, `the ${hash} fallback never reveals the work section`);
    }

    const shellTheme = () => harness.run("document.documentElement.dataset.theme");
    const storedTheme = () => harness.run("localStorage.getItem('kb.theme')");

    // NAV-002 expected 1: the theme persists.
    assert.equal(await shellTheme(), 'light', 'the shell starts in the light theme');
    assert.equal(await storedTheme(), null, 'no theme is stored before the first switch');
    await harness.nativeClick('#themeToggle');
    await harness.waitFor(async () => (await shellTheme()) === 'dark', 'the shell switches to the dark theme');
    assert.equal(await storedTheme(), 'dark', 'the dark theme is persisted');
    await harness.browser.screenshot(path.join(harness.evidence, 'nav002-theme-dark.png'));

    // NAV-002 expected 2: a ready frame receives kb:theme.
    // The embedded modules are readied one after another; each frame has to
    // be ready (the shell only talks to a frame that announced itself). The
    // event bridge still opens from the activity navigation; the workbench
    // frame now opens from the system drawer's provider management, which is
    // the only remaining reason the hidden mount exists.
    for (const frame of FRAMES) {
      if (frame.key === 'eventBridge') {
        await harness.run(`document.querySelector('[data-view="${frame.view}"]').click()`);
        await harness.run("document.querySelector('[data-activity-tab=\"sessions\"]').click()");
      } else {
        await harness.nativeClick('#openSystem');
        await harness.nativeClick('#configureProviders');
      }
      await harness.waitFor(
        async () => {
          const messages = await harness.frameMessages(frame.id);
          return Array.isArray(messages) && messages.some(message => message.type === 'kb:theme');
        },
        `the ${frame.key} frame announces itself and receives kb:theme`,
        20000,
      );
      const before = await harness.frameMessages(frame.id);
      const themesBefore = before.filter(message => message.type === 'kb:theme').map(message => message.theme);
      const currentTheme = await shellTheme();
      assert.ok(themesBefore.includes(currentTheme), `the ${frame.key} frame is told the current theme when it becomes ready: ${JSON.stringify(themesBefore)} (shell theme ${currentTheme})`);

      // Switch the theme while this frame is ready and connected.
      const themeBeforeSwitch = await shellTheme();
      const expected = themeBeforeSwitch === 'dark' ? 'light' : 'dark';
      await harness.nativeClick('#themeToggle');
      await harness.waitFor(async () => {
        const messages = await harness.frameMessages(frame.id);
        return Array.isArray(messages) && messages.some(message => message.type === 'kb:theme' && message.theme === expected);
      }, `the ${frame.key} frame receives the new kb:theme`, 10000);
      const after = (await harness.frameMessages(frame.id)).filter(message => message.type === 'kb:theme').map(message => message.theme);
      assert.equal(after[after.length - 1], expected, `the ${frame.key} frame's newest kb:theme is the new theme: ${JSON.stringify(after)}`);
    }

    // NAV-002 expected 3: a theme switch never rebuilds the module task.
    const loadsBefore = harness.modulePageLoads();
    await harness.nativeClick('#themeToggle');
    await harness.waitFor(async () => (await storedTheme()) === (await shellTheme()), 'the switched theme is persisted');
    await harness.wait(500);
    assert.equal(harness.modulePageLoads(), loadsBefore, 'a theme switch does not reload an embedded module document');
    const registrations = harness.moduleUi.state.requests.filter(entry => entry.method === 'POST' && entry.path === '/api/claude-workbench/v1/projects').length;
    await harness.nativeClick('#themeToggle');
    await harness.wait(500);
    assert.equal(
      harness.moduleUi.state.requests.filter(entry => entry.method === 'POST' && entry.path === '/api/claude-workbench/v1/projects').length,
      registrations,
      'a theme switch does not re-register the project with the module',
    );

    // The persisted theme survives a real reload of the product page.
    const themeBeforeReload = await shellTheme();
    await harness.browser.send('Page.reload');
    await harness.waitFor(
      async () => (await harness.run("document.documentElement.dataset.theme")) === themeBeforeReload && (await harness.run("document.readyState")) === 'complete',
      'the reloaded shell restores the persisted theme',
      20000,
    );
    assert.equal(await shellTheme(), themeBeforeReload, 'the theme is restored from localStorage after a reload');
    assert.equal(await storedTheme(), themeBeforeReload, 'the persisted theme is unchanged by the reload');
    await harness.browser.screenshot(path.join(harness.evidence, 'nav002-theme-after-reload.png'));

    assert.equal(harness.browser.exceptions.length, 0, `no uncaught product JavaScript exceptions: ${JSON.stringify(harness.browser.exceptions)}`);

    console.log('parallel-nav-theme-test PASS (five-page nav contract, #work falls back to home, hidden workFrame mount, theme persisted, ready frames receive kb:theme, no module task rebuilt)');
  } finally {
    await harness.cleanup();
  }
}

main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
