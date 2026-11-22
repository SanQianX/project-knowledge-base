'use strict';
// NAV-007 — 首页待处理直达处理。
//
// 迁移说明（五页简化 UI）：
// - 首页不再罗列项目：导入成功的可见面改为顶栏 #projectSelect 的选项
//   （与旧首页列表读同一份 state.projects）。
// - 需要处理面板改为服务端 /api/engine/overview 的 needsPreview 投影；
//   行级「去处理」入口（data-open-run）移植到 needRow() 的 run 行上，
//   断言选择器不变。
// - 活动记录视图新增过滤栏；默认「全部」即包含失败运行，展开行的
//   .error 与 [data-retry-run] 结构不变。
//
// The home「需要处理」panel names a failed maintenance run, so it must be an
// entry into handling, not a read-only preview: one real pointer click on the
// issue row must land on THAT exact run in the activity view, already
// expanded, with its failure details loaded and the retry control within
// reach. The old shell showed the failure on the home page and offered only a
// generic "查看运行详情" jump, leaving the user to find the record again in
// the activity list — view-only where handling was expected.
//
// The regression drives the real product UI in a real browser against an
// isolated instance (own port, own data dir, own knowledge dir, own Bridge
// journal, own browser profile). The failed run is real engine state, written
// into the real vendored engine's store through its own API; the shell reads
// it through the same snapshot the user's browser would. Every pointer action
// is a CDP Input.dispatchMouseEvent on the real coordinates of the real
// control, and the page itself records that the click it received carried
// isTrusted === true.
//
// Screenshots are written to PK_TEST_EVIDENCE_DIR when the batch sets it, so
// this tracked file stays free of machine-specific paths.

const path = require('node:path');
const assert = require('node:assert/strict');

const { startHarness, makeRepo } = require('./helpers/parallel-nav-shell');

const EVIDENCE = process.env.PK_TEST_EVIDENCE_DIR ? path.resolve(process.env.PK_TEST_EVIDENCE_DIR) : null;

const FAILURE_MESSAGE = '注入的额度故障：后台维护模型额度不足';

/** Record every click the page really receives on the home issue entry. */
async function installHomeClickRecorder(harness) {
  await harness.run(`(() => {
    window.__homeIssueClicks = [];
    if (!window.__homeIssueHooked) {
      window.__homeIssueHooked = true;
      document.addEventListener('click', event => {
        const button = event.target.closest ? event.target.closest('[data-open-run]') : null;
        if (button) window.__homeIssueClicks.push({
          trusted: event.isTrusted === true,
          runId: button.getAttribute('data-open-run'),
          label: (button.textContent || '').trim(),
        });
      }, true);
    }
    return true;
  })()`);
}

async function main() {
  const harness = await startHarness({ tag: 'nav007', evidenceDir: EVIDENCE || undefined });
  try {
    // A real project, imported through the real product API. The five-page
    // shell surfaces the registry in the top-bar project selector.
    const repo = makeRepo(harness.fixture, 'nav007-a');
    const project = await harness.importProject(repo, 'NAV007 甲');
    await harness.requestRegistryRefresh();
    await harness.waitFor(
      () => harness.run("document.getElementById('projectSelect').textContent.includes('NAV007 甲')"),
      'the imported project is listed',
      20000,
    );

    // Real engine state: one failed maintenance run for that project, with a
    // quota-style error the way a real failed phase leaves it.
    const created = harness.engine.store.addRun({ projectId: project.projectId, commitSha: repo.headCommit, trigger: 'manual' });
    harness.engine.store.updateRun(created.runId, {
      state: 'failed',
      phase: 'analyze',
      error: { code: 'MODEL_QUOTA_EXHAUSTED', message: FAILURE_MESSAGE },
      finishedAt: new Date().toISOString(),
    });

    await installHomeClickRecorder(harness);

    // NAV-007 expected 1: the home panel not only names the failure, it
    // exposes a per-item handling entry bound to that exact run.
    await harness.requestRegistryRefresh();
    await harness.waitFor(
      () => harness.run(`(() => {
        const button = document.querySelector('#homeContent [data-open-run]');
        if (!button) return false;
        const panel = button.closest('section.panel');
        const row = button.closest('.row');
        return panel && panel.querySelector('h2').textContent.includes('需要处理')
          && row && row.textContent.includes(${JSON.stringify(FAILURE_MESSAGE)})
          && button.getAttribute('data-run-project') === ${JSON.stringify(project.projectId)};
      })()`),
      'the home 需要处理 panel offers a handling entry for the exact failed run',
      20000,
    );
    await harness.browser.screenshot(path.join(harness.evidence, 'nav007-home-issue-entry.png'));

    // NAV-007 expected 2: one trusted pointer click lands on THAT run in the
    // activity view — expanded, details loaded, retry reachable.
    await harness.nativeClick('#homeContent [data-open-run]');
    const clicks = await harness.run('window.__homeIssueClicks || []');
    assert.ok(clicks.length >= 1, 'the page really received the home issue click');
    const click = clicks[clicks.length - 1];
    assert.equal(click.trusted, true, `the click the page received is a trusted browser event: ${JSON.stringify(click)}`);
    assert.equal(click.runId, created.runId, `the click is bound to the failed run: ${JSON.stringify(click)}`);

    await harness.waitFor(
      () => harness.run(`document.getElementById('view-activity').classList.contains('active')`),
      'the activity view is open',
    );
    const openRun = `(() => {
      const row = document.querySelector(${JSON.stringify(`details.run[data-run-id="${created.runId}"][open]`)});
      if (!row) return null;
      return {
        open: true,
        error: (row.querySelector('.error') || {}).textContent || '',
        retryRunId: row.querySelector('[data-retry-run]') ? row.querySelector('[data-retry-run]').getAttribute('data-retry-run') : '',
      };
    })()`;
    const landed = await harness.waitFor(
      () => harness.run(openRun),
      'the exact failed run is expanded with its retry control',
      20000,
    );
    assert.ok(landed.error.includes(FAILURE_MESSAGE), `the expanded run shows the real failure detail: ${JSON.stringify(landed)}`);
    assert.equal(landed.retryRunId, created.runId, `the retry control belongs to the exact failed run: ${JSON.stringify(landed)}`);
    await harness.browser.screenshot(path.join(harness.evidence, 'nav007-activity-run-opened.png'));

    // NAV-007 expected 2 (continued): the flow repeats from a warmed shell —
    // the already-loaded list must not swallow the second expansion.
    await harness.nativeClick('nav [data-view="home"]');
    await harness.waitFor(
      () => harness.run("document.getElementById('view-home').classList.contains('active') && !!document.querySelector('#homeContent [data-open-run]')"),
      'the home view is back with the handling entry',
      20000,
    );
    await harness.nativeClick('#homeContent [data-open-run]');
    await harness.waitFor(
      () => harness.run(`!!document.querySelector(${JSON.stringify(`details.run[data-run-id="${created.runId}"][open]`)})`),
      'the second click opens the same run again',
      20000,
    );

    assert.equal(harness.browser.exceptions.length, 0, `no uncaught product JavaScript exceptions: ${JSON.stringify(harness.browser.exceptions)}`);

    console.log('parallel-nav-home-issues-test PASS (the home 需要处理 entry opens the exact failed run, expanded, with retry reachable)');
  } finally {
    await harness.cleanup();
  }
}

main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
