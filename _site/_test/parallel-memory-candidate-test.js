'use strict';
// _site/_test/parallel-memory-candidate-test.js
//
// MEM-003 候选记忆 / MEM-005 忽略候选.
//
// Both cases run against a real isolated product instance with the REAL
// vendored knowledge engine behind a pass-through proxy: its own port, data
// dir, knowledge root, Bridge journal home and browser profile.
//
// The candidate is produced by the REAL pipeline: a real follow-up commit in a
// real Git fixture, a real frozen user event, the real promotion of a staged
// Markdown file and the engine's own MemoryService.capture() with its own
// provenance gate. The review happens in the real UI in a real Chrome.
//
// HONEST SCOPE LABEL: the analysis step is this lane's declared stand-in
// analyzer (helpers/parallel-memory-analyzer.js). It replaces the model, so
// these cases are evidence about the engine's admission, review, scope and
// injection machinery, never about the model's judgement.
//
// MEM-003 expected:
//   * 保存为candidate。     -> the memory the engine really stored has status
//                              'candidate', no manual source and a frozen
//                              source record;
//   * 未确认不注入。         -> before the user confirms it the engine injects
//                              nothing for that memory, and the real UI lists
//                              it in 候选箱 with the review actions.
// MEM-005 expected:
//   * 状态ignored。          -> the real PATCH answers with status 'ignored';
//   * 来源保持记录（冻结）。 -> the ignored record keeps the same commit, entry,
//                              quote, source event and eligibility, and injects
//                              nothing.
//
// 迁移说明（五页简化 UI，见 patches/ui-test-mapping-spec.md）：
//   * 候选箱 tab：[data-memory-tab="candidate"] 选择器不变（标签从「候选」/
//     confirmed-tab 体系改为「记忆库/候选箱」，confirmed tab → library tab）。
//   * 候选卡片：[data-memory-card=<id>] → 候选箱 .row 行（以
//     [data-action="review-candidate"][data-id=<id>] 定位）；行上的
//     「审核确认 / 忽略」两个按钮合并为一个「审核」按钮，审核动作移入
//     #appDialog 内 #reviewForm 的动作区：确认收录 =
//     #appDialogActions button.primary，忽略 = #appDialogActions
//     button.danger，取消 = #appDialogActions button:not(.primary):not(.danger)。
//   * 审核对话框：旧 #memoryDialog 内 #memoryText（可编辑正文）+
//     #memoryEvidence/#memoryQuote/#memoryEvidenceDetails → #reviewForm 冻结
//     正文/来源行（#appDialogBody 文本含 commit 前 8 位、entryId）+
//     details.agent-detail（点击 summary 展开冻结 quote）。等价断言改为读
//     #appDialogBody 与展开后的 details。
//   * 旧「保存候选」（#saveMemoryCandidate：改正文但不确认，PATCH 不带
//     status）在新 UI 已移除（候选正文冻结，不可编辑）。等价语义保留为：
//     打开审核后点「取消」——不发任何 PATCH、记忆仍是 candidate、仍不注入。
//     「未确认不注入」本身始终由引擎注入门（/api/context）断言证明。
//   * 确认收录仍 PATCH { status: 'confirmed' }、忽略仍 PATCH
//     { status: 'ignored' }（网络捕获断言请求体不变）；引擎侧冻结来源、
//     注入矩阵断言全部保持。
//   * 「导入项目已列出」等待：旧首页项目面板已删除 → 顶栏 #projectSelect。
//   * 确认后的列表断言：confirmed tab → [data-memory-tab="library"]。

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const { startHarness, makeRepo } = require('./helpers/parallel-memory-shell');

const EVIDENCE = process.env.PK_TEST_EVIDENCE_DIR ? path.resolve(process.env.PK_TEST_EVIDENCE_DIR) : null;
const CANDIDATE_TEXT = '对外错误信息使用中文表述，并优先复用已有模块。';
const IGNORED_TEXT = '新增对外接口必须补充中文字段说明文档。';

/**
 * Open the memory view with retries against the known reload commit-gap race
 * (driver robustness only: the assertion stays "the view is really active").
 */
async function openMemoryView(harness) {
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await harness.nativeClick('nav [data-view="memory"]');
    try {
      await harness.waitFor(
        () => harness.run("document.getElementById('view-memory').classList.contains('active')"),
        'the memory view is open',
        5000,
      );
      return;
    } catch (error) { lastError = error; }
  }
  throw lastError;
}

async function openCandidateBox(harness) {
  await openMemoryView(harness);
  await harness.waitFor(
    () => harness.run("document.querySelector('#memoryContent [data-memory-tab=\"candidate\"]') !== null"),
    'the memory tab bar is rendered from real data',
    20000,
  );
  await harness.nativeClick('#memoryContent [data-memory-tab="candidate"]');
}

/** The candidate-box row (.row) of one candidate, located by its review button. */
const candidateRowText = (harness, memoryId) => harness.run(`(() => {
  const button = document.querySelector('#memoryContent [data-action="review-candidate"][data-id=${JSON.stringify(memoryId)}]');
  const row = button ? button.closest('.row') : null;
  return row ? row.textContent : null;
})()`);

async function main() {
  const harness = await startHarness({ tag: 'memcand', evidenceDir: EVIDENCE || undefined });
  const evidence = [];
  try {
    const repo = makeRepo(harness.fixture, 'memcand-repo', { 'README.md': '# 候选甲\n' });
    const { projectId } = await harness.importProject(repo, '候选甲');
    await harness.requestRegistryRefresh();
    // The new home page no longer lists projects; the registry projection is
    // surfaced by the topbar project selector instead.
    await harness.waitFor(
      () => harness.run("document.getElementById('projectSelect').textContent.includes('候选甲')"),
      'the imported project is listed',
      20000,
    );

    // ---------------------------------------------------------------- MEM-003
    const produced = await harness.produceCandidate({ repo, projectId, text: CANDIDATE_TEXT, scopeType: 'global' });
    assert.equal(produced.capture.accepted, 1, `the real run admitted one candidate: ${JSON.stringify(produced.capture)}`);
    assert.deepEqual(produced.capture.rejected, [], 'the real gate rejected nothing for a human source');

    const stored = (await harness.productMemories()).find(memory => memory.text === CANDIDATE_TEXT);
    assert.ok(stored, 'the candidate really exists in the engine');
    assert.equal(stored.status, 'candidate', 'the automatic memory is saved as a candidate');
    assert.notEqual(stored.sourceType, 'manual', 'an automatic candidate is not a manual memory');
    assert.equal(stored.scopeType, 'global', 'a global candidate keeps the global scope');
    assert.equal(stored.scopeId, stored.brainId, 'a global candidate targets the brain itself');
    assert.equal(stored.evidence.projectId, projectId, 'the frozen source names the source project');
    assert.equal(stored.evidence.commitSha, produced.commitSha, 'the frozen source names the real commit');
    assert.ok(stored.evidence.entryId, 'the frozen source names the promoted entry');
    assert.ok(stored.evidence.quote, 'the frozen source keeps the quoted text');
    assert.equal(stored.sourceEventId, produced.event.eventId, 'the frozen source names the human event');
    assert.equal(stored.sourceHash, produced.event.contentHash, 'the frozen source keeps the event hash');
    assert.equal(stored.eligibility.durable, true, 'the candidate records why it is durable');
    assert.equal(stored.eligibility.crossProject, true, 'the candidate records why it crosses projects');

    // The candidate is really injected nowhere before the user confirms it.
    const beforeReview = await harness.injectedMemories(projectId);
    assert.ok(
      !beforeReview.some(entry => entry.memoryId === stored.id),
      `an unconfirmed candidate is never injected: ${JSON.stringify(beforeReview)}`,
    );

    // The real UI lists it in 候选箱 with the review action.
    await harness.reload();
    await openCandidateBox(harness);
    await harness.waitFor(
      () => harness.run(`document.getElementById('memoryContent').textContent.includes(${JSON.stringify(CANDIDATE_TEXT)})`),
      'the candidate is listed in the candidate box',
      15000,
    );
    const listed = await candidateRowText(harness, stored.id);
    assert.ok(listed, 'the candidate really has a row in the candidate box');
    assert.match(listed, /来源/, 'the row names the source of the candidate');
    assert.ok(listed.includes(produced.commitSha.slice(0, 8)), 'the row shows the frozen commit');
    assert.ok(
      await harness.run(`Boolean(document.querySelector('#memoryContent [data-action="review-candidate"][data-id=${JSON.stringify(stored.id)}]'))`),
      'the candidate offers 审核 (the review entry point)',
    );
    if (harness.evidence) await harness.browser.screenshot(path.join(harness.evidence, 'mem003-candidate-box.png'));

    // The old card-level 审核确认/忽略 pair became the review dialog's action
    // buttons: open the review and check the frozen source plus both actions.
    await harness.nativeClick(`#memoryContent [data-action="review-candidate"][data-id="${stored.id}"]`);
    await harness.waitFor(
      () => harness.run("document.getElementById('appDialog').open === true && document.getElementById('reviewForm') !== null"),
      'the review dialog is open',
      10000,
    );
    const dialogBody = await harness.run("document.getElementById('appDialogBody').textContent");
    assert.ok(dialogBody.includes(CANDIDATE_TEXT), `the review dialog freezes the candidate body: ${dialogBody}`);
    assert.ok(dialogBody.includes(produced.commitSha.slice(0, 8)), `the dialog shows the frozen commit: ${dialogBody}`);
    assert.ok(dialogBody.includes(stored.evidence.entryId), 'the dialog shows the frozen entry');
    // The frozen quote is folded into a details element; a real click unfolds it.
    assert.ok(
      await harness.run("Boolean(document.querySelector('#reviewForm details.agent-detail summary'))"),
      'the frozen quote is offered behind a details toggle',
    );
    await harness.nativeClick('#reviewForm details.agent-detail summary');
    assert.equal(
      await harness.run("document.querySelector('#reviewForm details.agent-detail').open === true"),
      true,
      'the frozen source is really visible for a candidate',
    );
    const shownQuote = await harness.run("document.querySelector('#reviewForm details.agent-detail').textContent");
    assert.ok(shownQuote.includes(stored.evidence.quote), `the dialog shows the frozen quote: ${shownQuote}`);
    assert.equal(await harness.run("document.querySelector('#appDialogActions button.primary').textContent"), '确认收录', 'the review offers 审核确认 (确认收录)');
    assert.equal(await harness.run("document.querySelector('#appDialogActions button.danger').textContent"), '忽略', 'the review offers 忽略');
    if (harness.evidence) await harness.browser.screenshot(path.join(harness.evidence, 'mem003-review-dialog.png'));

    // The step's own path first: leave the review WITHOUT confirming (the old
    // 保存候选 button is gone; the frozen candidate cannot be edited) — the
    // memory has to stay a candidate and stay un-injected, and no PATCH leaves
    // the page at all.
    const patchesBeforeCancel = harness.network.find(entry => entry.method === 'PATCH' && entry.url.includes(`/api/engine/memories/${stored.id}`)).length;
    await harness.nativeClick('#appDialogActions button:not(.primary):not(.danger)');
    await harness.waitFor(
      () => harness.run("document.getElementById('appDialog').open === false"),
      'cancelling the review closes the dialog',
      10000,
    );
    assert.equal(
      harness.network.find(entry => entry.method === 'PATCH' && entry.url.includes(`/api/engine/memories/${stored.id}`)).length,
      patchesBeforeCancel,
      'cancelling the review sends no PATCH at all',
    );
    const afterCancel = (await harness.productMemories()).find(memory => memory.id === stored.id);
    assert.equal(afterCancel.status, 'candidate', 'the memory is still a candidate after leaving the review unconfirmed');
    assert.equal(afterCancel.text, CANDIDATE_TEXT, 'the candidate text is untouched (frozen in the new review form)');
    const notInjectedAfterCancel = await harness.injectedMemories(projectId);
    assert.ok(
      !notInjectedAfterCancel.some(entry => entry.memoryId === stored.id),
      `a candidate left unconfirmed is never injected: ${JSON.stringify(notInjectedAfterCancel)}`,
    );

    // 审核确认: reopen the review and confirm — the confirmation keeps the
    // frozen source and only changes the status.
    await harness.nativeClick(`#memoryContent [data-action="review-candidate"][data-id="${stored.id}"]`);
    await harness.waitFor(
      () => harness.run("document.getElementById('appDialog').open === true && document.getElementById('reviewForm') !== null"),
      'the review dialog is open again',
      10000,
    );
    await harness.nativeClick('#appDialogActions button.primary');
    await harness.waitFor(
      () => harness.run("document.getElementById('appDialog').open === false"),
      'the dialog closes after the confirmation',
      15000,
    );
    const patch = harness.network.find(entry => entry.method === 'PATCH' && entry.url.includes(`/api/engine/memories/${stored.id}`)).pop();
    assert.ok(patch, 'the shell really patched the candidate');
    assert.deepEqual(patch.body, { status: 'confirmed' }, 'the confirmation only changes the status');
    assert.equal(patch.status, 200, `the confirmation answers 200: ${JSON.stringify(patch.body)}`);
    const patchBody = await harness.network.body(patch);
    assert.ok(patchBody && patchBody.memory, `the confirmation answers with the memory: ${JSON.stringify(patchBody)}`);
    assert.equal(patchBody.memory.status, 'confirmed', 'the confirmed memory is confirmed');
    assert.equal(patchBody.memory.evidence.commitSha, produced.commitSha, 'the confirmation keeps the frozen source');
    const confirmToast = await harness.run("document.getElementById('toast').textContent");
    assert.match(String(confirmToast), /已确认/, `the toast reports the confirmation: ${confirmToast}`);

    const afterConfirm = await harness.injectedMemories(projectId);
    assert.ok(
      afterConfirm.some(entry => entry.memoryId === stored.id),
      `the confirmed memory is injected: ${JSON.stringify(afterConfirm)}`,
    );

    // The confirmed memory is listed in the library tab (旧 confirmed tab) of
    // the real UI.
    await harness.nativeClick('#memoryContent [data-memory-tab="library"]');
    await harness.waitFor(
      () => harness.run(`document.getElementById('memoryContent').textContent.includes(${JSON.stringify(CANDIDATE_TEXT)})`),
      'the confirmed memory is listed',
      15000,
    );
    if (harness.evidence) await harness.browser.screenshot(path.join(harness.evidence, 'mem003-confirmed.png'));

    evidence.push({
      case: 'MEM-003',
      run: { commitSha: produced.commitSha, memoryCapture: produced.capture },
      candidate: { id: stored.id, status: stored.status, scopeType: stored.scopeType, scopeId: stored.scopeId, evidence: stored.evidence, sourceEventId: stored.sourceEventId, sourceHash: stored.sourceHash, eligibility: stored.eligibility },
      reviewLeftUnconfirmed: { patchesSent: 0, stillCandidate: afterCancel.status, injected: notInjectedAfterCancel.map(entry => entry.memoryId) },
      confirmation: { method: patch.method, url: patch.url.replace(harness.base, ''), status: patch.status, request: patch.body, response: patchBody },
      injectedBeforeReview: beforeReview.map(entry => entry.memoryId),
      injectedAfterReview: afterConfirm.map(entry => entry.memoryId),
      scopeLabel: 'honest: the analysis step is the lane stand-in analyzer, not a model',
    });

    // ---------------------------------------------------------------- MEM-005
    const second = await harness.produceCandidate({ repo, projectId, text: IGNORED_TEXT, scopeType: 'global', file: 'src/ignored.js' });
    assert.equal(second.capture.accepted, 1, `the second real run admitted one candidate: ${JSON.stringify(second.capture)}`);
    const toIgnore = (await harness.productMemories()).find(memory => memory.text === IGNORED_TEXT);
    assert.ok(toIgnore, 'the second candidate really exists in the engine');
    assert.equal(toIgnore.status, 'candidate', 'the second candidate starts as a candidate');

    await harness.reload();
    await openCandidateBox(harness);
    await harness.waitFor(
      () => harness.run(`document.getElementById('memoryContent').textContent.includes(${JSON.stringify(IGNORED_TEXT)})`),
      'the second candidate is listed in the candidate box',
      15000,
    );
    if (harness.evidence) await harness.browser.screenshot(path.join(harness.evidence, 'mem005-candidate-before-ignore.png'));

    // 忽略 is the review dialog's danger action now (the old card-level ignore
    // button is gone); it still PATCHes exactly { status: 'ignored' }.
    await harness.nativeClick(`#memoryContent [data-action="review-candidate"][data-id="${toIgnore.id}"]`);
    await harness.waitFor(
      () => harness.run("document.getElementById('appDialog').open === true && document.getElementById('reviewForm') !== null"),
      'the review dialog is open for the second candidate',
      10000,
    );
    await harness.nativeClick('#appDialogActions button.danger');
    await harness.waitFor(
      () => harness.run(`!document.getElementById('memoryContent').textContent.includes(${JSON.stringify(IGNORED_TEXT)})`),
      'the ignored candidate leaves the candidate box',
      15000,
    );
    const ignorePatch = harness.network.find(entry => entry.method === 'PATCH' && entry.url.includes(`/api/engine/memories/${toIgnore.id}`)).pop();
    assert.ok(ignorePatch, 'the shell really ignored the candidate');
    assert.equal(ignorePatch.status, 200, `the ignore answers 200: ${JSON.stringify(ignorePatch.body)}`);
    assert.deepEqual(ignorePatch.body, { status: 'ignored' }, 'the ignore only changes the status');
    const ignoreBody = await harness.network.body(ignorePatch);
    assert.equal(ignoreBody.memory.status, 'ignored', 'the ignored memory is ignored');
    const ignoreToast = await harness.run("document.getElementById('toast').textContent");
    assert.match(String(ignoreToast), /已忽略候选。/, `the toast reports the ignore: ${ignoreToast}`);

    const ignored = (await harness.productMemories()).find(memory => memory.id === toIgnore.id);
    assert.ok(ignored, 'the ignored memory is still stored');
    assert.equal(ignored.status, 'ignored', 'the stored memory carries the ignored status');
    assert.equal(ignored.evidence.commitSha, second.commitSha, 'the ignored memory keeps the frozen commit');
    assert.equal(ignored.evidence.entryId, toIgnore.evidence.entryId, 'the ignored memory keeps the frozen entry');
    assert.equal(ignored.evidence.quote, toIgnore.evidence.quote, 'the ignored memory keeps the frozen quote');
    assert.equal(ignored.sourceEventId, toIgnore.sourceEventId, 'the ignored memory keeps the frozen source event');
    assert.equal(ignored.sourceHash, toIgnore.sourceHash, 'the ignored memory keeps the frozen source hash');
    assert.equal(ignored.eligibility.reason, toIgnore.eligibility.reason, 'the ignored memory keeps the recorded reason');

    const afterIgnore = await harness.injectedMemories(projectId);
    assert.ok(
      !afterIgnore.some(entry => entry.memoryId === toIgnore.id),
      `an ignored memory is never injected: ${JSON.stringify(afterIgnore)}`,
    );

    // The confirmed memory is untouched by the ignore of another candidate.
    const stillConfirmed = (await harness.productMemories()).find(memory => memory.id === stored.id);
    assert.equal(stillConfirmed.status, 'confirmed', 'ignoring one candidate does not change the confirmed memory');
    if (harness.evidence) await harness.browser.screenshot(path.join(harness.evidence, 'mem005-candidate-after-ignore.png'));

    evidence.push({
      case: 'MEM-005',
      run: { commitSha: second.commitSha, memoryCapture: second.capture },
      ignored: { id: ignored.id, status: ignored.status, evidence: ignored.evidence, sourceEventId: ignored.sourceEventId, sourceHash: ignored.sourceHash, eligibility: ignored.eligibility },
      ignoreRequest: { method: ignorePatch.method, url: ignorePatch.url.replace(harness.base, ''), status: ignorePatch.status, request: ignorePatch.body, response: ignoreBody },
      injectedAfterIgnore: afterIgnore.map(entry => entry.memoryId),
    });

    assert.equal(harness.browser.exceptions.length, 0, `no uncaught product JavaScript exceptions: ${JSON.stringify(harness.browser.exceptions)}`);

    if (harness.evidence) {
      fs.mkdirSync(harness.evidence, { recursive: true });
      fs.writeFileSync(path.join(harness.evidence, 'mem003-mem005-candidate.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
    }

    console.log('parallel-memory-candidate-test PASS (MEM-003 candidate saved and not injected before the review; MEM-005 ignored keeps the frozen source and injects nothing)');
  } finally {
    await harness.cleanup();
  }
}

main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
