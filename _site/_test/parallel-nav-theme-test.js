'use strict';
// NAV-002 — 主题同步。
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

const FRAMES = [
  { key: 'terminal', id: 'workFrame', view: 'work' },
  { key: 'vectorHub', id: 'vectorFrame', view: 'search' },
  { key: 'eventBridge', id: 'bridgeFrame', view: 'activity' },
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
      () => harness.run("document.getElementById('homeContent').textContent.includes('NAV002 项目')"),
      'the imported project is listed',
      20000,
    );

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
    // The three embedded modules are opened one after another; each frame has
    // to be ready (the shell only talks to a frame that announced itself).
    for (const frame of FRAMES) {
      await harness.run(`document.querySelector('[data-view="${frame.view}"]').click()`);
      if (frame.key === 'eventBridge') {
        await harness.run("document.querySelector('[data-activity-tab=\"sessions\"]').click()");
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

    console.log('parallel-nav-theme-test PASS (theme persisted, ready frames receive kb:theme, no module task rebuilt)');
  } finally {
    await harness.cleanup();
  }
}

main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
