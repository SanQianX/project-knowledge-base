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

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const { startHarness, makeRepo } = require('./helpers/parallel-memory-shell');
const r3 = require('./helpers/parallel-memory-capture-r3-shell');

const EVIDENCE = process.env.PK_TEST_EVIDENCE_DIR ? path.resolve(process.env.PK_TEST_EVIDENCE_DIR) : null;
const CANDIDATE_TEXT = 'R3 忽略持久性：对外错误信息使用中文表述，并优先复用已有模块。';
const REPO_NAME = 'mem005r3-repo';

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
  await harness.waitFor(
    () => harness.run("document.getElementById('memoryContent').textContent.length > 0"),
    'the candidate box is rendered',
    15000,
  );
}

async function cardPresent(harness, memoryId) {
  return harness.run(`Boolean(document.querySelector('[data-memory-card=${JSON.stringify(memoryId)}]'))`);
}

async function main() {
  const harness = await startHarness({ tag: 'mem005r3', evidenceDir: EVIDENCE || undefined });
  const evidence = [];
  try {
    const repo = makeRepo(harness.fixture, REPO_NAME, { 'README.md': '# R3 忽略持久性夹具\n' });
    const { projectId, knowledgePath } = await harness.importProject(repo, 'R3忽略持久性');
    await harness.requestRegistryRefresh();
    await harness.waitFor(
      () => harness.run("document.getElementById('homeContent').textContent.includes('R3忽略持久性')"),
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

    // 3. The real UI ignores the real candidate.
    await harness.reload();
    await openCandidateBox(harness);
    await harness.waitFor(
      () => harness.run(`document.getElementById('memoryContent').textContent.includes(${JSON.stringify(CANDIDATE_TEXT)})`),
      'the candidate is listed in the candidate box',
      15000,
    );
    assert.equal(await cardPresent(harness, candidate.id), true, 'the candidate really has a card');
    if (harness.evidence) await harness.browser.screenshot(path.join(harness.evidence, 'mem005-r3-before-ignore.png'));

    await harness.nativeClick(`[data-memory-action="ignore"][data-memory-id="${candidate.id}"]`);
    await harness.waitFor(
      () => harness.run(`!document.getElementById('memoryContent').textContent.includes(${JSON.stringify(CANDIDATE_TEXT)})`),
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
    // back, so the check is not a stale render of the old view.
    await harness.nativeClick('nav [data-view="home"]');
    await harness.waitFor(
      () => harness.run("document.getElementById('view-home').classList.contains('active')"),
      'the home view is open after the reload',
      10000,
    );
    await harness.nativeClick('nav [data-view="memory"]');
    await harness.waitFor(
      () => harness.run("document.getElementById('view-memory').classList.contains('active')"),
      'the memory view is re-opened after the reload',
      10000,
    );
    await harness.nativeClick('[data-memory-tab="candidate"]');
    await harness.waitFor(
      () => harness.run("document.getElementById('memoryContent').textContent.length > 0"),
      'the candidate box is rendered after the reload',
      15000,
    );

    // 5. The UI after the reload: the ignored candidate does not come back,
    //    and it is not presented as a confirmed memory either.
    const afterReload = {
      candidateCardPresent: await cardPresent(harness, candidate.id),
      textInMemoryView: await harness.run(`document.getElementById('memoryContent').textContent.includes(${JSON.stringify(CANDIDATE_TEXT)})`),
      candidateCountBadge: await harness.run("document.getElementById('candidateCount').textContent"),
      ignoreButtonPresent: await harness.run(`Boolean(document.querySelector('[data-memory-action="ignore"][data-memory-id=${JSON.stringify(candidate.id)}]'))`),
    };
    assert.equal(afterReload.candidateCardPresent, false, 'the ignored candidate has no card after the reload');
    assert.equal(afterReload.textInMemoryView, false, 'the ignored candidate is not in the memory view after the reload');
    assert.equal(String(afterReload.candidateCountBadge).trim(), '', 'the candidate counter is empty after the reload');
    assert.equal(afterReload.ignoreButtonPresent, false, 'the ignored candidate offers no ignore button after the reload');

    await harness.nativeClick('[data-memory-tab="confirmed"]');
    await harness.waitFor(
      () => harness.run("document.getElementById('memoryContent').textContent.length > 0 || document.querySelectorAll('[data-memory-card]').length === 0"),
      'the confirmed tab is rendered after the reload',
      15000,
    );
    const confirmedTab = {
      cardPresent: await cardPresent(harness, candidate.id),
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
