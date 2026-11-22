'use strict';
// MEM-HOME — 首页待确认记忆直达审核。
//
// 迁移说明（五页简化 UI）：
// - 首页不再罗列项目：导入成功的可见面改为顶栏 #projectSelect 的选项。
// - 首页候选行的审核入口改为 data-action="review-candidate"（data-id 绑定
//   具体候选），与「长期记忆」页候选箱共用 reviewCandidate() 的
//   #appDialog 审核对话框；确认动作为表单提交（reviewForm 的提交按钮）。
// - 冻结依据的展示从「原始总结」字段改为「查看原始依据（冻结原文）」
//   折叠块；确认后面板空态文案为「没有待确认的记忆」。
//
// The home「待确认记忆」panel names a candidate memory, so it must be an
// entry into review, not a read-only preview: one real pointer click on the
// candidate row must open the review dialog for THAT exact candidate — text,
// scope and frozen evidence included — and the confirm action in the dialog
// must complete the handling without ever visiting the memory view. The old
// shell offered only a generic「查看候选箱」jump, leaving the user to find
// the candidate again in the full list.
//
// The regression drives the real product UI in a real browser against an
// isolated instance (own port, own data dir, own knowledge dir, own Bridge
// journal, own browser profile). The candidate is produced by the REAL
// pipeline — a real follow-up commit, a real conversation event, a real
// maintenance run, the real eligibility gate — so the home panel lists what
// the engine really stored. Every pointer action is a CDP
// Input.dispatchMouseEvent on the real coordinates of the real control, and
// the page itself records that the click it received carried
// isTrusted === true.
//
// Screenshots are written to PK_TEST_EVIDENCE_DIR when the batch sets it, so
// this tracked file stays free of machine-specific paths.

const path = require('node:path');
const assert = require('node:assert/strict');

const { startHarness, makeRepo } = require('./helpers/parallel-memory-shell');

const EVIDENCE = process.env.PK_TEST_EVIDENCE_DIR ? path.resolve(process.env.PK_TEST_EVIDENCE_DIR) : null;

const CANDIDATE_TEXT = '对外错误信息使用中文表述，并优先复用已有模块。';

/** Record every click the page really receives on the home review entry. */
async function installHomeReviewClickRecorder(harness) {
  await harness.run(`(() => {
    window.__homeReviewClicks = [];
    if (!window.__homeReviewHooked) {
      window.__homeReviewHooked = true;
      document.addEventListener('click', event => {
        const button = event.target.closest ? event.target.closest('#homeContent [data-action="review-candidate"]') : null;
        if (button) window.__homeReviewClicks.push({
          trusted: event.isTrusted === true,
          memoryId: button.getAttribute('data-id'),
          label: (button.textContent || '').trim(),
        });
      }, true);
    }
    return true;
  })()`);
}

async function main() {
  const harness = await startHarness({ tag: 'memhome', evidenceDir: EVIDENCE || undefined });
  try {
    // A real project, imported through the real product API. The five-page
    // shell surfaces the registry in the top-bar project selector.
    const repo = makeRepo(harness.fixture, 'memhome-repo', { 'README.md': '# 首页候选\n' });
    const { projectId } = await harness.importProject(repo, '首页候选甲');
    await harness.requestRegistryRefresh();
    await harness.waitFor(
      () => harness.run("document.getElementById('projectSelect').textContent.includes('首页候选甲')"),
      'the imported project is listed',
      20000,
    );

    // A real candidate through the real pipeline (commit + event + run + gate).
    const produced = await harness.produceCandidate({ repo, projectId, text: CANDIDATE_TEXT, scopeType: 'global' });
    assert.equal(produced.capture.accepted, 1, `the real run admitted one candidate: ${JSON.stringify(produced.capture)}`);
    const stored = (await harness.productMemories()).find(m => m.text === CANDIDATE_TEXT);
    assert.ok(stored, 'the candidate really exists in the engine');
    assert.equal(stored.status, 'candidate', 'the stored candidate is still pending review');

    await installHomeReviewClickRecorder(harness);

    // MEM-HOME expected 1: the home panel not only names the candidate, it
    // exposes a per-item review entry bound to that exact memory.
    await harness.requestRegistryRefresh();
    await harness.waitFor(
      () => harness.run(`(() => {
        const button = document.querySelector('#homeContent [data-action="review-candidate"]');
        if (!button) return false;
        const panel = button.closest('section.panel');
        const row = button.closest('.row');
        return panel && panel.querySelector('h2').textContent.includes('待确认记忆')
          && row && row.textContent.includes(${JSON.stringify(CANDIDATE_TEXT)})
          && button.getAttribute('data-id') === ${JSON.stringify(stored.id)};
      })()`),
      'the home 待确认记忆 panel offers a review entry for the exact candidate',
      20000,
    );
    await harness.browser.screenshot(path.join(harness.evidence, 'memhome-home-review-entry.png'));

    // MEM-HOME expected 2: one trusted pointer click opens the review dialog
    // for that exact candidate, straight from the home view.
    await harness.nativeClick('#homeContent [data-action="review-candidate"]');
    const clicks = await harness.run('window.__homeReviewClicks || []');
    assert.ok(clicks.length >= 1, 'the page really received the home review click');
    const click = clicks[clicks.length - 1];
    assert.equal(click.trusted, true, `the click the page received is a trusted browser event: ${JSON.stringify(click)}`);
    assert.equal(click.memoryId, stored.id, `the click is bound to the exact candidate: ${JSON.stringify(click)}`);

    await harness.waitFor(
      () => harness.run(`(() => document.getElementById('appDialog').open === true
        && document.getElementById('appDialogTitle').textContent.includes('审核候选记忆')
        && document.getElementById('appDialogBody').textContent.includes(${JSON.stringify(CANDIDATE_TEXT)}))()`),
      'the review dialog opens with the exact candidate',
      10000,
    );
    const dialogText = await harness.run("document.getElementById('appDialog').textContent");
    assert.ok(dialogText.includes('原始依据'), `the dialog carries the frozen source evidence: ${dialogText.slice(0, 120)}`);
    await harness.browser.screenshot(path.join(harness.evidence, 'memhome-review-dialog.png'));

    // MEM-HOME expected 3: the handling completes in place — confirm inside
    // the dialog, and the home panel itself reflects the resolved candidate.
    await harness.nativeClick('#appDialogActions button[type="submit"]');
    await harness.waitFor(
      () => harness.run("document.getElementById('appDialog').open === false"),
      'the review dialog closes after confirming',
      10000,
    );
    await harness.waitFor(
      () => harness.run(`(() => document.getElementById('homeContent').textContent.includes('没有待确认的记忆')
        && !document.querySelectorAll('#homeContent [data-action="review-candidate"]').length)()`),
      'the home panel no longer offers the confirmed candidate for review',
      20000,
    );
    const confirmed = (await harness.productMemories()).find(m => m.id === stored.id);
    assert.equal(confirmed.status, 'confirmed', `the engine really holds the confirmed memory: ${JSON.stringify(confirmed.status)}`);
    await harness.browser.screenshot(path.join(harness.evidence, 'memhome-confirmed-home.png'));

    assert.equal(harness.browser.exceptions.length, 0, `no uncaught product JavaScript exceptions: ${JSON.stringify(harness.browser.exceptions)}`);

    console.log('parallel-memory-home-review-test PASS (the home 待确认记忆 entry opens the exact candidate for review and confirm completes in place)');
  } finally {
    await harness.cleanup();
  }
}

main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
