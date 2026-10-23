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
//                              it in 候选箱 with 审核确认 / 忽略.
// MEM-005 expected:
//   * 状态ignored。          -> the real PATCH answers with status 'ignored';
//   * 来源保持记录（冻结）。 -> the ignored record keeps the same commit, entry,
//                              quote, source event and eligibility, and injects
//                              nothing.

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const { startHarness, makeRepo } = require('./helpers/parallel-memory-shell');

const EVIDENCE = process.env.PK_TEST_EVIDENCE_DIR ? path.resolve(process.env.PK_TEST_EVIDENCE_DIR) : null;
const CANDIDATE_TEXT = '对外错误信息使用中文表述，并优先复用已有模块。';
const IGNORED_TEXT = '新增对外接口必须补充中文字段说明文档。';

async function openMemoryView(harness) {
  await harness.nativeClick('nav [data-view="memory"]');
  await harness.waitFor(
    () => harness.run("document.getElementById('view-memory').classList.contains('active')"),
    'the memory view is open',
    10000,
  );
}

async function openCandidateBox(harness) {
  await openMemoryView(harness);
  await harness.nativeClick('[data-memory-tab="candidate"]');
}

async function cardText(harness, memoryId) {
  return harness.run(`(() => {
    const el = document.querySelector('[data-memory-card=${JSON.stringify(memoryId)}]');
    return el ? el.textContent : null;
  })()`);
}

async function main() {
  const harness = await startHarness({ tag: 'memcand', evidenceDir: EVIDENCE || undefined });
  const evidence = [];
  try {
    const repo = makeRepo(harness.fixture, 'memcand-repo', { 'README.md': '# 候选甲\n' });
    const { projectId } = await harness.importProject(repo, '候选甲');
    await harness.requestRegistryRefresh();
    await harness.waitFor(
      () => harness.run("document.getElementById('homeContent').textContent.includes('候选甲')"),
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

    // The real UI lists it in 候选箱 with the review actions.
    await harness.reload();
    await openCandidateBox(harness);
    await harness.waitFor(
      () => harness.run(`document.getElementById('memoryContent').textContent.includes(${JSON.stringify(CANDIDATE_TEXT)})`),
      'the candidate is listed in the candidate box',
      15000,
    );
    const listed = await cardText(harness, stored.id);
    assert.ok(listed, 'the candidate really has a card in the candidate box');
    assert.match(listed, /来源/, 'the card names the source of the candidate');
    assert.ok(listed.includes(produced.commitSha.slice(0, 8)), 'the card shows the frozen commit');
    assert.ok(
      await harness.run(`Boolean(document.querySelector('[data-memory-action="confirm"][data-memory-id=${JSON.stringify(stored.id)}]'))`),
      'the candidate offers 审核确认',
    );
    assert.ok(
      await harness.run(`Boolean(document.querySelector('[data-memory-action="ignore"][data-memory-id=${JSON.stringify(stored.id)}]'))`),
      'the candidate offers 忽略',
    );
    if (harness.evidence) await harness.browser.screenshot(path.join(harness.evidence, 'mem003-candidate-box.png'));

    // The step's own path first: edit the candidate and click 保存候选 WITHOUT
    // confirming — the memory has to stay a candidate and stay un-injected.
    const EDIT_SUFFIX = '（修订）';
    await harness.nativeClick(`[data-memory-action="confirm"][data-memory-id="${stored.id}"]`);
    await harness.waitFor(
      () => harness.run("document.getElementById('memoryDialog').open === true"),
      'the review dialog is open',
      10000,
    );
    await harness.nativeClick('#memoryText');
    await harness.pressKey('End', { code: 'End', keyCode: 35 });
    await harness.typeText(EDIT_SUFFIX);
    const editedBody = await harness.run("document.getElementById('memoryText').value");
    assert.equal(editedBody, CANDIDATE_TEXT + EDIT_SUFFIX, 'the real edit reached the textarea');

    await harness.nativeClick('#saveMemoryCandidate');
    await harness.waitFor(
      () => harness.run("document.getElementById('memoryDialog').open === false"),
      'the dialog closes after saving the candidate',
      15000,
    );
    const saveCandidatePatch = harness.network.find(entry => entry.method === 'PATCH' && entry.url.includes(`/api/engine/memories/${stored.id}`)).pop();
    assert.ok(saveCandidatePatch, 'the shell really patched the candidate');
    assert.deepEqual(Object.keys(saveCandidatePatch.body).sort(), ['scopeId', 'scopeType', 'text'], '保存候选 sends no status at all');
    const saveCandidateBody = await harness.network.body(saveCandidatePatch);
    assert.equal(saveCandidatePatch.status, 200, `保存候选 answers 200: ${JSON.stringify(saveCandidatePatch.body)}`);
    assert.equal(saveCandidateBody.memory.status, 'candidate', '保存候选 keeps the memory a candidate');
    assert.equal(saveCandidateBody.memory.text, CANDIDATE_TEXT + EDIT_SUFFIX, '保存候选 keeps the edited text');
    assert.equal(saveCandidateBody.memory.originalText, CANDIDATE_TEXT, '保存候选 keeps the frozen original summary');
    const saveToast = await harness.run("document.getElementById('toast').textContent");
    assert.match(String(saveToast), /候选已保存，尚未生效。/, `the toast says the candidate is not yet effective: ${saveToast}`);

    const afterSaveCandidate = await harness.injectedMemories(projectId);
    assert.ok(
      !afterSaveCandidate.some(entry => entry.memoryId === stored.id),
      `a saved-but-unconfirmed candidate is never injected: ${JSON.stringify(afterSaveCandidate)}`,
    );
    const stillCandidate = (await harness.productMemories()).find(memory => memory.id === stored.id);
    assert.equal(stillCandidate.status, 'candidate', 'the stored memory is still a candidate after 保存候选');
    await harness.waitFor(
      () => harness.run(`document.getElementById('memoryContent').textContent.includes(${JSON.stringify(CANDIDATE_TEXT + EDIT_SUFFIX)})`),
      'the edited candidate is listed in the candidate box',
      15000,
    );
    if (harness.evidence) await harness.browser.screenshot(path.join(harness.evidence, 'mem003-saved-candidate.png'));

    // 审核确认: the dialog shows the frozen source, and confirming confirms it.
    await harness.nativeClick(`[data-memory-action="confirm"][data-memory-id="${stored.id}"]`);
    await harness.waitFor(
      () => harness.run("document.getElementById('memoryDialog').open === true"),
      'the review dialog is open',
      10000,
    );
    const shownEvidence = await harness.run("document.getElementById('memoryEvidence').textContent");
    assert.ok(shownEvidence.includes(produced.commitSha), `the dialog shows the frozen commit: ${shownEvidence}`);
    assert.ok(shownEvidence.includes(stored.evidence.entryId), 'the dialog shows the frozen entry');
    const shownQuote = await harness.run("document.getElementById('memoryQuote').textContent");
    assert.ok(shownQuote.includes(stored.evidence.quote), 'the dialog shows the frozen quote');
    assert.ok(
      await harness.run("document.getElementById('memoryEvidenceDetails').hidden === false"),
      'the frozen source is really visible for a candidate',
    );
    if (harness.evidence) await harness.browser.screenshot(path.join(harness.evidence, 'mem003-review-dialog.png'));

    await harness.nativeClick('#confirmMemory');
    await harness.waitFor(
      () => harness.run("document.getElementById('memoryDialog').open === false"),
      'the dialog closes after the confirmation',
      15000,
    );
    const patch = harness.network.find(entry => entry.method === 'PATCH' && entry.url.includes('/api/engine/memories/')).pop();
    assert.ok(patch, 'the shell really patched the candidate');
    assert.equal(patch.status, 200, `the confirmation answers 200: ${JSON.stringify(patch.body)}`);
    const patchBody = await harness.network.body(patch);
    assert.ok(patchBody && patchBody.memory, `the confirmation answers with the memory: ${JSON.stringify(patchBody)}`);
    assert.equal(patchBody.memory.status, 'confirmed', 'the confirmed memory is confirmed');
    assert.equal(patchBody.memory.evidence.commitSha, produced.commitSha, 'the confirmation keeps the frozen source');

    const afterConfirm = await harness.injectedMemories(projectId);
    assert.ok(
      afterConfirm.some(entry => entry.memoryId === stored.id),
      `the confirmed memory is injected: ${JSON.stringify(afterConfirm)}`,
    );

    // The confirmed memory is listed in the confirmed tab of the real UI.
    await harness.nativeClick('[data-memory-tab="confirmed"]');
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
      saveCandidateWithoutConfirm: { method: saveCandidatePatch.method, url: saveCandidatePatch.url.replace(harness.base, ''), status: saveCandidatePatch.status, request: saveCandidatePatch.body, response: saveCandidateBody },
      injectedBeforeReview: beforeReview.map(entry => entry.memoryId),
      confirmation: { method: patch.method, url: patch.url.replace(harness.base, ''), status: patch.status, request: patch.body, response: patchBody },
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

    await harness.nativeClick(`[data-memory-action="ignore"][data-memory-id="${toIgnore.id}"]`);
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
