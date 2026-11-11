'use strict';
// _site/_test/parallel-memory-capture-r3-mem005-persistence-test.js
//
// MEM-005 忽略候选 — the persistence half that the frozen P-MEMORY-01 run
// never proved.
//
// What the frozen run (helpers/parallel-memory-shell.js +
// parallel-memory-candidate-test.js) already proved: the real UI really
// ignores a real candidate, the engine answers {status:'ignored'}, the record
// keeps its frozen source and an ignored memory is never injected.
//
// What was still missing: that the ignored state SURVIVES. The old run read
// the stored record through the API right after the click, i.e. from the
// same live process that had just answered the PATCH. Nothing proved that a
// later page load still shows the candidate as ignored and still finds the
// untouched frozen source.
//
// This case therefore:
//   1. produces a real candidate (real commit, real frozen event, the real
//      engine admission, the lane stand-in analyzer for the model step only);
//   2. fingerprints the frozen source (promoted entry file bytes + Git tree
//      + frozen event hash) BEFORE the ignore;
//   3. ignores it through the real UI with a real pointer click;
//   4. RELOADS the page in the real browser and RE-OPENS the memory view;
//   5. proves the UI no longer offers it as a candidate and never shows it
//      as confirmed;
//   6. proves the engine still reports status 'ignored' — through the
//      product's own endpoint, through the engine's own endpoint AND from
//      the engine's persisted state file on disk;
//   7. proves the frozen source is byte-identical to the fingerprint taken
//      before the ignore, and that the memory is still not injected.
//
// HONEST SCOPE LABEL: the analysis step is the frozen P-MEMORY-01 stand-in
// analyzer. This case is evidence about the engine's admission, the ignore
// action, the persistence of that state and the frozen source — never about
// the model's judgement.
//
// 迁移说明（五页简化 UI，见 patches/ui-test-mapping-spec.md）：
//   * 导入项目已列出的等待：旧首页项目面板（homeContent 含项目名）已删除，
//     等价为顶栏 #projectSelect 选项里出现项目名（同一 registry projection）。
//   * 候选卡片：[data-memory-card=<id>] → 候选箱行（.row）内的
//     [data-action="review-candidate"][data-id=<id>]「审核」按钮（行存在 ⇔
//     按钮存在）；已确认卡片 → 记忆库 .memory-item 内的
//     [data-action="memory-detail"][data-id=<id>]。
//   * 忽略动作：旧行内 [data-memory-action="ignore"][data-memory-id=<id>] →
//     新审核流：点候选行的「审核」打开 #appDialog 内 #reviewForm，忽略 =
//     #appDialogActions button.danger（引擎 PATCH {status:'ignored'} 不变）。
//   * 候选计数：旧 #candidateCount（已删除）→ 导航徽标 #memoryCount
//     （overview.totals.candidates；无候选时整个徽标 hidden）。为避免读到
//     overview 尚未加载的空窗，重载后先等首页「待确认记忆」面板渲染完成。
//   * 确认 tab：[data-memory-tab="confirmed"] → [data-memory-tab="library"]
//     （旧 confirmed tab）；空态文案「还没有已确认的长期记忆」→「没有匹配的
//     记忆。」。重载后记忆页先渲染离线横幅，tab 栏要等 boot snapshot 应答
//     后才存在，点击前先等 tab 栏出现。
//   * 引擎/冻结源/注入断言（productMemories、engineApi、engineStateOnDisk、
//     sourceFingerprint/compareFrozen、injectedMemories）完全不变；本测试
//     使用真实引擎（dataSchemaVersion 由引擎自报，当前为 4）。

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const { startHarness, makeRepo } = require('./helpers/parallel-memory-shell');
const r3 = require('./helpers/parallel-memory-capture-r3-shell');

const EVIDENCE = process.env.PK_TEST_EVIDENCE_DIR ? path.resolve(process.env.PK_TEST_EVIDENCE_DIR) : null;
const CANDIDATE_TEXT = 'R3 忽略持久性：对外错误信息使用中文表述，并优先复用已有模块。';
const REPO_NAME = 'mem005r3-repo';

/**
 * Open a nav view with retries against the known reload commit-gap race
 * (the shell's reload() gate proves the FRESH document, but a CDP click
 * dispatched right at the commit boundary can still be lost — see the
 * parallel-memory-shell.js reload comment). Driver robustness only: the
 * assertion stays "the view is really active".
 */
async function openView(harness, view) {
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await harness.nativeClick(`nav [data-view="${view}"]`);
    try {
      await harness.waitFor(
        () => harness.run(`document.getElementById('view-${view}').classList.contains('active')`),
        `the ${view} view is open`,
        5000,
      );
      return;
    } catch (error) { lastError = error; }
  }
  throw lastError;
}

const openMemoryView = harness => openView(harness, 'memory');

/** The memory tab bar exists only after the reloaded page read engine data. */
async function waitForMemoryTabs(harness) {
  await harness.waitFor(
    () => harness.run("document.querySelector('#memoryContent [data-memory-tab=\"candidate\"]') !== null"),
    'the memory tab bar is rendered from real engine data',
    20000,
  );
}

async function openCandidateBox(harness) {
  await openMemoryView(harness);
  await waitForMemoryTabs(harness);
  await harness.nativeClick('#memoryContent [data-memory-tab="candidate"]');
  await harness.waitFor(
    () => harness.run("document.getElementById('memoryContent').textContent.length > 0"),
    'the candidate box is rendered',
    15000,
  );
}

/** A candidate is offered by the real UI iff its 审核 (review) button exists. */
const candidateOffered = (harness, memoryId) => harness.run(
  `Boolean(document.querySelector('#memoryContent [data-action="review-candidate"][data-id=${JSON.stringify(memoryId)}]'))`,
);

/** A confirmed memory is listed in the library iff its detail card exists. */
const libraryCardPresent = (harness, memoryId) => harness.run(
  `Boolean(document.querySelector('#memoryContent [data-action="memory-detail"][data-id=${JSON.stringify(memoryId)}]'))`,
);

async function main() {
  const harness = await startHarness({ tag: 'mem005r3', evidenceDir: EVIDENCE || undefined });
  const evidence = [];
  try {
    const repo = makeRepo(harness.fixture, REPO_NAME, { 'README.md': '# R3 忽略持久性夹具\n' });
    const { projectId, knowledgePath } = await harness.importProject(repo, 'R3忽略持久性');
    await harness.requestRegistryRefresh();
    // The new home page no longer lists projects; the registry projection is
    // surfaced by the topbar project selector instead.
    await harness.waitFor(
      () => harness.run("document.getElementById('projectSelect').textContent.includes('R3忽略持久性')"),
      'the imported project is listed',
      20000,
    );

    // 1. A real candidate through the real pipeline.
    const produced = await harness.produceCandidate({ repo, projectId, text: CANDIDATE_TEXT, scopeType: 'global' });
    assert.equal(produced.capture.accepted, 1, `the real run admitted one candidate: ${JSON.stringify(produced.capture)}`);
    const candidate = (await harness.productMemories()).find(memory => memory.text === CANDIDATE_TEXT);
    assert.ok(candidate, 'the candidate really exists in the engine');
    assert.equal(candidate.status, 'candidate', 'the automatic memory starts as a candidate');
    assert.equal(candidate.evidence.commitSha, produced.commitSha, 'the frozen source names the real commit');

    // 2. The frozen source, fingerprinted before anything is clicked.
    const before = (() => {
      const events = harness.engine.coordinator.conversations.readEvents(projectId);
      return {
        source: r3.sourceFingerprint({
          knowledgePath,
          entryId: candidate.evidence.entryId,
          repoPath: repo.path,
          commitSha: produced.commitSha,
          eventId: candidate.sourceEventId,
          events,
        }),
        memory: r3.memoryFrozenFields(candidate),
      };
    })();
    assert.ok(before.source.entry.exists, 'the promoted entry file really exists on disk');
    assert.ok(before.source.entry.sha256, 'the promoted entry file really has a hash');
    assert.equal(before.source.git.commitExists, true, 'the frozen commit really exists in the Git fixture');
    assert.ok(before.source.git.tree, 'the frozen commit really has a tree');
    assert.ok(before.source.event, 'the frozen conversation event really exists');
    assert.equal(before.source.event.contentHash, candidate.sourceHash, 'the frozen event hash matches the memory');

    // 3. The real UI ignores the real candidate: the candidate row's 审核
    //    button opens the review dialog (#appDialog > #reviewForm) and the
    //    danger action sends the same engine PATCH {status:'ignored'}.
    await harness.reload();
    await openCandidateBox(harness);
    await harness.waitFor(
      () => harness.run(`document.getElementById('memoryContent').textContent.includes(${JSON.stringify(CANDIDATE_TEXT)})`),
      'the candidate is listed in the candidate box',
      15000,
    );
    assert.equal(await candidateOffered(harness, candidate.id), true, 'the candidate really has a card (review button)');
    if (harness.evidence) await harness.browser.screenshot(path.join(harness.evidence, 'mem005-r3-before-ignore.png'));

    await harness.nativeClick(`#memoryContent [data-action="review-candidate"][data-id="${candidate.id}"]`);
    await harness.waitFor(
      () => harness.run("document.getElementById('appDialog').open === true && document.getElementById('reviewForm') !== null"),
      'the candidate review dialog is open',
      10000,
    );
    await harness.nativeClick('#appDialogActions button.danger');
    await harness.waitFor(
      () => harness.run(`document.getElementById('appDialog').open === false && !document.getElementById('memoryContent').textContent.includes(${JSON.stringify(CANDIDATE_TEXT)})`),
      'the ignored candidate leaves the candidate box',
      15000,
    );
    const ignorePatch = harness.network.find(entry => entry.method === 'PATCH' && entry.url.includes(`/api/engine/memories/${candidate.id}`)).pop();
    assert.ok(ignorePatch, 'the shell really ignored the candidate');
    assert.equal(ignorePatch.status, 200, `the ignore answers 200: ${JSON.stringify(ignorePatch.body)}`);
    assert.deepEqual(ignorePatch.body, { status: 'ignored' }, 'the ignore only changes the status');
    const ignoreBody = await harness.network.body(ignorePatch);
    assert.equal(ignoreBody.memory.status, 'ignored', 'the ignored memory is ignored');

    // 4. RELOAD the page in the real browser, then RE-OPEN the memory view.
    await harness.reload();
    await harness.waitFor(
      () => harness.run("document.readyState === 'complete'"),
      'the reloaded page is complete',
      20000,
    );
    // Re-open the view the way a user does: leave the memory view and come
    // back, so the check is not a stale render of the old view. Opening home
    // first also loads the overview, so the #memoryCount badge read below is
    // never taken from an unloaded boot state.
    await openView(harness, 'home');
    await harness.waitFor(
      () => harness.run("document.getElementById('homeContent').textContent.includes('待确认记忆')"),
      'the home overview really answered after the reload',
      20000,
    );
    await openCandidateBox(harness);
    await harness.waitFor(
      () => harness.run(`!document.getElementById('memoryContent').textContent.includes(${JSON.stringify(CANDIDATE_TEXT)})`),
      'the candidate box is rendered without the ignored candidate',
      15000,
    );

    // 5. The UI after the reload: the ignored candidate does not come back,
    //    and it is not presented as a confirmed memory either. The new UI has
    //    no per-row ignore/confirm buttons — the row's only action is 审核
    //    (review-candidate), so "no card" also means "no ignore action".
    const afterReload = {
      candidateCardPresent: await candidateOffered(harness, candidate.id),
      textInMemoryView: await harness.run(`document.getElementById('memoryContent').textContent.includes(${JSON.stringify(CANDIDATE_TEXT)})`),
      candidateBadgeHidden: await harness.run("document.getElementById('memoryCount').hidden"),
      candidateBadgeText: await harness.run("document.getElementById('memoryCount').textContent"),
      ignoreButtonPresent: await candidateOffered(harness, candidate.id),
    };
    assert.equal(afterReload.candidateCardPresent, false, 'the ignored candidate has no card after the reload');
    assert.equal(afterReload.textInMemoryView, false, 'the ignored candidate is not in the memory view after the reload');
    assert.equal(afterReload.candidateBadgeHidden, true, 'the candidate counter badge is hidden after the reload (no candidates left)');
    assert.equal(afterReload.ignoreButtonPresent, false, 'the ignored candidate offers no ignore (review) action after the reload');

    await harness.nativeClick('#memoryContent [data-memory-tab="library"]');
    await harness.waitFor(
      () => harness.run(`(!document.getElementById('memoryContent').textContent.includes(${JSON.stringify('知识引擎暂时不可用')}) && (document.getElementById('memoryContent').textContent.includes('没有匹配的记忆。') || document.querySelectorAll('#memoryContent .memory-item').length > 0))`),
      'the library tab (old confirmed tab) is rendered after the reload',
      15000,
    );
    const confirmedTab = {
      cardPresent: await libraryCardPresent(harness, candidate.id),
      textPresent: await harness.run(`document.getElementById('memoryContent').textContent.includes(${JSON.stringify(CANDIDATE_TEXT)})`),
    };
    assert.equal(confirmedTab.cardPresent, false, 'the ignored candidate is not shown as a confirmed memory');
    assert.equal(confirmedTab.textPresent, false, 'the ignored text is not shown in the confirmed tab');
    if (harness.evidence) await harness.browser.screenshot(path.join(harness.evidence, 'mem005-r3-after-reload.png'));

    // 6. The engine state after the reload: through the product, through the
    //    engine itself and from the engine's own persisted state file.
    const productView = (await harness.productMemories()).find(memory => memory.id === candidate.id);
    assert.ok(productView, 'the ignored memory is still served by the product after the reload');
    assert.equal(productView.status, 'ignored', 'the product still reports the ignored status after the reload');

    const engineList = await harness.engineApi('GET', '/api/memories');
    assert.equal(engineList.status, 200, `the engine memory list must be readable: ${JSON.stringify(engineList.body)}`);
    const engineView = (engineList.body.memories || []).find(memory => memory.id === candidate.id);
    assert.ok(engineView, 'the engine still knows the ignored memory after the reload');
    assert.equal(engineView.status, 'ignored', 'the engine still reports the ignored status after the reload');

    const onDisk = r3.engineStateOnDisk(harness.engine);
    assert.equal(onDisk.exists, true, 'the engine really persisted a state file');
    const diskView = onDisk.memories.find(memory => memory.id === candidate.id);
    assert.ok(diskView, 'the ignored memory is really persisted in the engine state file');
    assert.equal(diskView.status, 'ignored', 'the persisted record on disk carries the ignored status');

    // 7. The frozen source is untouched by the ignore.
    const after = (() => {
      const events = harness.engine.coordinator.conversations.readEvents(projectId);
      return {
        source: r3.sourceFingerprint({
          knowledgePath,
          entryId: productView.evidence.entryId,
          repoPath: repo.path,
          commitSha: productView.evidence.commitSha,
          eventId: productView.sourceEventId,
          events,
        }),
        memory: r3.memoryFrozenFields(productView),
      };
    })();
    const comparison = r3.compareFrozen(before, after);
    assert.equal(comparison.identical, true, `the frozen source must not change: ${JSON.stringify(comparison.diffs)}`);
    assert.equal(comparison.entrySha256Same, true, 'the promoted entry file is byte-identical after the ignore');
    assert.equal(comparison.gitTreeSame, true, 'the frozen commit tree is unchanged after the ignore');
    assert.equal(comparison.eventHashSame, true, 'the frozen event hash is unchanged after the ignore');
    assert.equal(comparison.memoryFrozenFieldsSame, true, 'the frozen fields of the record are unchanged after the ignore');

    // 8. Still not injected after the reload.
    const injected = await harness.injectedMemories(projectId);
    assert.ok(
      !injected.some(entry => entry.memoryId === candidate.id),
      `an ignored memory is still never injected: ${JSON.stringify(injected)}`,
    );

    assert.equal(harness.browser.exceptions.length, 0, `no uncaught product JavaScript exceptions: ${JSON.stringify(harness.browser.exceptions)}`);

    evidence.push({
      case: 'MEM-005-persistence',
      run: { projectId, commitSha: produced.commitSha, memoryCapture: produced.capture, knowledgePath },
      candidate: { id: candidate.id, statusBefore: 'candidate', statusAfter: productView.status },
      ignoreRequest: { method: ignorePatch.method, url: ignorePatch.url.replace(harness.base, ''), status: ignorePatch.status, request: ignorePatch.body, response: ignoreBody },
      uiAfterReload: { ...afterReload, confirmedTab, pageReloaded: true, viewReopenedAfterReload: true },
      engineStateAfterReload: {
        productEndpoint: { status: productView.status, id: productView.id },
        engineEndpoint: { status: engineView.status, id: engineView.id },
        engineStateFile: { file: onDisk.file, exists: onDisk.exists, sha256: onDisk.sha256, status: diskView.status },
      },
      frozenSource: { before: before.source, after: after.source, comparison },
      injectedAfterReload: injected.map(entry => entry.memoryId),
      provenance: r3.provenance(),
      scopeLabel: 'honest: the analysis step is the frozen P-MEMORY-01 stand-in analyzer, not a model',
    });

    if (harness.evidence) {
      fs.mkdirSync(harness.evidence, { recursive: true });
      fs.writeFileSync(path.join(harness.evidence, 'mem005-r3-persistence.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
    }

    console.log('parallel-memory-capture-r3-mem005-persistence-test PASS (the ignored candidate survives a real page reload: the UI no longer offers it, the engine and its persisted state still report ignored, and the frozen source is byte-identical)');
  } finally {
    await harness.cleanup();
  }
}

main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
