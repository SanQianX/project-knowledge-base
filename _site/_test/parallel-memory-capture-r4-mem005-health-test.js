'use strict';
// _site/_test/parallel-memory-capture-r4-mem005-health-test.js
//
// MEM-005 R4 — the UI half that R3 never proved on a healthy page.
//
// The Leader review of the R3 run found the vacuous pass: the after-reload
// screenshot showed the memory view's offline fallback ("知识引擎暂时不可用。
// 未读取到的记忆不会显示为已确认。"), so "no candidate card / no candidate
// text" was trivially true on an unavailable page. R3's waits accepted any
// non-empty #memoryContent — including that banner — before the page's own
// boot snapshot had answered.
//
// This case keeps the accepted R3 layers (product API ignored, engine API
// ignored, engine state file ignored, frozen source byte-identical, never
// injected) and re-proves the UI half with three gates that cannot pass on an
// unhealthy or empty projection:
//   * a CONTRAST memory B is produced through the same real pipeline and must
//     stay visible in the candidate box — before the ignore, right after it,
//     and again after a real page reload. A box that empties, errors or falls
//     back offline can never satisfy "B visible".
//   * the offline banner text must be absent from the memory view AND from the
//     home view at every gate.
//   * the page's own /api/engine/snapshot requests after the reload must have
//     answered 200 (network capture of the real browser).
// Only then: the ignored A has no card, no text, no ignore button, is not
// counted by the candidate badge and is not presented as confirmed.
//
// HONEST SCOPE: the analysis step is the frozen P-MEMORY-01 stand-in analyzer
// (helpers/parallel-memory-analyzer.js); this case is evidence about the
// engine's admission, the ignore action, the persistence of that state, the
// frozen source and the real UI's healthy-page projection — never about the
// model's judgement. The health gates are read-only observations of the real
// page; the driver never sets any availability flag.

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const { startHarness, makeRepo } = require('./helpers/parallel-memory-shell');
const r3 = require('./helpers/parallel-memory-capture-r3-shell');

const EVIDENCE = process.env.PK_TEST_EVIDENCE_DIR ? path.resolve(process.env.PK_TEST_EVIDENCE_DIR) : null;
const BANNER = '知识引擎暂时不可用';
const TEXT_A = 'R4 健康页忽略持久性（忽略项）：对外错误信息使用中文表述，并优先复用已有模块。';
const TEXT_B = 'R4 对照记忆（保持候选）：发布前必须运行隔离回归，不允许跳过。';
const REPO_NAME = 'mem005r4-repo';

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

/** A memory card's text is rendered by the real page (implies engine data). */
const cardTextVisible = (harness, text) => harness.run(
  `document.getElementById('memoryContent').textContent.includes(${JSON.stringify(text)})`,
);

const bannerInMemoryView = harness => harness.run(
  `document.getElementById('memoryContent').textContent.includes(${JSON.stringify(BANNER)})`,
);

const bannerInHome = harness => harness.run(
  `document.getElementById('homeContent').textContent.includes(${JSON.stringify(BANNER)})`,
);

/**
 * The healthy-page gate: the contrast candidate B must be visible AND the
 * offline banner absent. Waiting for B's real text is the essential part —
 * only a page that actually read engine data can render it.
 */
async function waitHealthyCandidateBox(harness, label) {
  const startedAt = Date.now();
  await harness.waitFor(
    () => cardTextVisible(harness, TEXT_B),
    `${label}: the contrast candidate is visible in the candidate box (a page that fell back offline cannot render it)`,
    20000,
  );
  await harness.waitFor(
    () => harness.run(`!document.getElementById('memoryContent').textContent.includes(${JSON.stringify(BANNER)})`),
    `${label}: the offline banner is absent from the memory view`,
    10000,
  );
  return { waitedMs: Date.now() - startedAt };
}

async function main() {
  const harness = await startHarness({ tag: 'mem005r4', evidenceDir: EVIDENCE || undefined });
  const evidence = [];
  try {
    const repo = makeRepo(harness.fixture, REPO_NAME, { 'README.md': '# R4 健康页忽略持久性夹具\n' });
    const { projectId, knowledgePath } = await harness.importProject(repo, 'R4健康页忽略持久性');
    await harness.requestRegistryRefresh();
    await harness.waitFor(
      () => harness.run("document.getElementById('homeContent').textContent.includes('R4健康页忽略持久性')"),
      'the imported project is listed',
      20000,
    );

    // 1. Two real candidates through the real pipeline: A will be ignored,
    //    B stays candidate and is the healthy-page contrast.
    const producedA = await harness.produceCandidate({ repo, projectId, text: TEXT_A, scopeType: 'global', file: 'src/r4-candidate-a.js' });
    const producedB = await harness.produceCandidate({ repo, projectId, text: TEXT_B, scopeType: 'global', file: 'src/r4-candidate-b.js' });
    assert.equal(producedA.capture.accepted, 1, `run A admitted one candidate: ${JSON.stringify(producedA.capture)}`);
    assert.equal(producedB.capture.accepted, 1, `run B admitted one candidate: ${JSON.stringify(producedB.capture)}`);
    const memories = await harness.productMemories();
    const candidateA = memories.find(memory => memory.text === TEXT_A);
    const candidateB = memories.find(memory => memory.text === TEXT_B);
    assert.ok(candidateA, 'candidate A really exists in the engine');
    assert.ok(candidateB, 'candidate B really exists in the engine');
    assert.equal(candidateA.status, 'candidate', 'A starts as a candidate');
    assert.equal(candidateB.status, 'candidate', 'B starts as a candidate');
    assert.equal(candidateA.evidence.commitSha, producedA.commitSha, 'A\'s frozen source names its real commit');
    assert.equal(candidateB.evidence.commitSha, producedB.commitSha, 'B\'s frozen source names its real commit');

    // 2. The frozen sources, fingerprinted before anything is clicked.
    const fingerprint = (candidate, produced) => {
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
    };
    const beforeA = fingerprint(candidateA, producedA);
    assert.equal(beforeA.source.git.commitExists, true, 'A\'s frozen commit really exists');
    assert.ok(beforeA.source.event, 'A\'s frozen conversation event really exists');

    // 3. Healthy candidate box BEFORE the ignore: both cards visible, no banner.
    await harness.reload();
    await openCandidateBox(harness);
    const gateBefore = await waitHealthyCandidateBox(harness, 'before ignore');
    assert.equal(await cardTextVisible(harness, TEXT_A), true, 'A is listed alongside B before the ignore');
    const cardsBefore = await harness.run("document.querySelectorAll('#memoryContent [data-memory-card]').length");
    assert.ok(Number(cardsBefore) >= 2, `the healthy candidate box really shows both cards: ${cardsBefore}`);
    if (harness.evidence) await harness.browser.screenshot(path.join(harness.evidence, 'mem005-r4-healthy-before-ignore.png'));

    // 4. Ignore A through the real UI. The strong half: A must leave while B
    //    STAYS — an emptied, errored or offline box can never pass this.
    await harness.nativeClick(`[data-memory-action="ignore"][data-memory-id="${candidateA.id}"]`);
    await harness.waitFor(
      () => harness.run(`!document.getElementById('memoryContent').textContent.includes(${JSON.stringify(TEXT_A)})`),
      'the ignored candidate A leaves the candidate box',
      15000,
    );
    assert.equal(await cardTextVisible(harness, TEXT_B), true, 'the contrast candidate B is STILL visible right after the ignore (the box did not empty or fall back offline)');
    const ignorePatch = harness.network.find(entry => entry.method === 'PATCH' && entry.url.includes(`/api/engine/memories/${candidateA.id}`)).pop();
    assert.ok(ignorePatch, 'the shell really ignored A');
    assert.equal(ignorePatch.status, 200, `the ignore answers 200: ${JSON.stringify(ignorePatch.body)}`);
    assert.deepEqual(ignorePatch.body, { status: 'ignored' }, 'the ignore only changes the status');

    // 5. RELOAD. Re-open the view the way a user does. First gate: the page
    //    must really have read engine data again — B visible, banner absent,
    //    and the page's own snapshot requests answered 200.
    await harness.reload();
    await harness.waitFor(() => harness.run("document.readyState === 'complete'"), 'the reloaded page is complete', 20000);
    await harness.nativeClick('nav [data-view="home"]');
    await harness.waitFor(
      () => harness.run("document.getElementById('view-home').classList.contains('active')"),
      'the home view is open after the reload',
      10000,
    );
    await harness.waitFor(
      () => harness.run(`document.getElementById('homeContent').textContent.includes(${JSON.stringify(TEXT_B)})`),
      'the home view\'s 待确认记忆 panel lists the contrast candidate B after the reload',
      20000,
    );
    assert.equal(await bannerInHome(harness), false, 'the home view shows real updates, not the engine-offline fallback, after the reload');

    await openCandidateBox(harness);
    const gateAfter = await waitHealthyCandidateBox(harness, 'after reload');
    const afterReload = {
      candidateACardPresent: await harness.run(`Boolean(document.querySelector('[data-memory-card=${JSON.stringify(candidateA.id)}]'))`),
      textAInMemoryView: await cardTextVisible(harness, TEXT_A),
      candidateCountBadge: await harness.run("document.getElementById('candidateCount').textContent"),
      ignoreButtonPresent: await harness.run(`Boolean(document.querySelector('[data-memory-action="ignore"][data-memory-id=${JSON.stringify(candidateA.id)}]'))`),
      confirmButtonPresent: await harness.run(`Boolean(document.querySelector('[data-memory-action="confirm"][data-memory-id=${JSON.stringify(candidateA.id)}]'))`),
      contrastCardPresent: await harness.run(`Boolean(document.querySelector('[data-memory-card=${JSON.stringify(candidateB.id)}]'))`),
    };
    assert.equal(afterReload.candidateACardPresent, false, 'the ignored A has no card after the reload');
    assert.equal(afterReload.textAInMemoryView, false, 'A\'s text is not in the memory view after the reload');
    assert.equal(String(afterReload.candidateCountBadge).trim(), '1', `the candidate counter counts only the contrast candidate B after the reload: ${JSON.stringify(afterReload.candidateCountBadge)}`);
    assert.equal(afterReload.ignoreButtonPresent, false, 'A offers no ignore button after the reload');
    assert.equal(afterReload.confirmButtonPresent, false, 'A offers no confirm button after the reload');
    assert.equal(afterReload.contrastCardPresent, true, 'B\'s card is right there — the absence of A is a real filtered-out record, not an offline fallback');
    if (harness.evidence) await harness.browser.screenshot(path.join(harness.evidence, 'mem005-r4-after-reload-healthy-candidates.png'));

    // 6. The confirmed tab: rendered from real data (B is not confirmed, so
    //    the real empty-state text shows), banner absent, A not confirmed.
    await harness.nativeClick('[data-memory-tab="confirmed"]');
    await harness.waitFor(
      () => harness.run(`(!document.getElementById('memoryContent').textContent.includes(${JSON.stringify(BANNER)}) && (document.getElementById('memoryContent').textContent.includes('还没有已确认的长期记忆') || document.querySelectorAll('[data-memory-card]').length > 0))`),
      'the confirmed tab is rendered from real data (not the offline banner)',
      15000,
    );
    const confirmedTab = {
      cardAPresent: await harness.run(`Boolean(document.querySelector('[data-memory-card=${JSON.stringify(candidateA.id)}]'))`),
      textAPresent: await cardTextVisible(harness, TEXT_A),
      bannerPresent: await bannerInMemoryView(harness),
    };
    assert.equal(confirmedTab.cardAPresent, false, 'A is not shown as a confirmed memory');
    assert.equal(confirmedTab.textAPresent, false, 'A\'s text is not shown in the confirmed tab');
    assert.equal(confirmedTab.bannerPresent, false, 'the confirmed tab is not the offline fallback');
    if (harness.evidence) await harness.browser.screenshot(path.join(harness.evidence, 'mem005-r4-after-reload-confirmed.png'));

    // 7. The page's own snapshot requests after the reload answered 200.
    const pageSnapshotRequests = harness.network
      .find(entry => entry.method === 'GET' && entry.url.includes('/api/engine/snapshot'))
      .map(entry => ({ url: entry.url.replace(harness.base, ''), status: entry.status }));
    assert.ok(
      pageSnapshotRequests.some(entry => entry.status === 200),
      `the real page loaded its engine snapshot successfully after the reload: ${JSON.stringify(pageSnapshotRequests.slice(-5))}`,
    );

    // 8. The engine state after the reload — kept from R3: through the
    //    product, through the engine itself and from the persisted file.
    const productView = (await harness.productMemories()).find(memory => memory.id === candidateA.id);
    assert.ok(productView, 'A is still served by the product after the reload');
    assert.equal(productView.status, 'ignored', 'the product still reports A as ignored after the reload');
    const productB = (await harness.productMemories()).find(memory => memory.id === candidateB.id);
    assert.equal(productB.status, 'candidate', 'the contrast B is still a candidate after the reload');

    const engineList = await harness.engineApi('GET', '/api/memories');
    assert.equal(engineList.status, 200, `the engine memory list must be readable: ${JSON.stringify(engineList.body)}`);
    const engineA = (engineList.body.memories || []).find(memory => memory.id === candidateA.id);
    const engineB = (engineList.body.memories || []).find(memory => memory.id === candidateB.id);
    assert.ok(engineA, 'the engine still knows A after the reload');
    assert.equal(engineA.status, 'ignored', 'the engine still reports A as ignored after the reload');
    assert.equal(engineB.status, 'candidate', 'the engine still reports B as a candidate after the reload');

    const onDisk = r3.engineStateOnDisk(harness.engine);
    assert.equal(onDisk.exists, true, 'the engine really persisted a state file');
    const diskA = onDisk.memories.find(memory => memory.id === candidateA.id);
    const diskB = onDisk.memories.find(memory => memory.id === candidateB.id);
    assert.ok(diskA, 'A is really persisted in the engine state file');
    assert.equal(diskA.status, 'ignored', 'the persisted record on disk carries A\'s ignored status');
    assert.equal(diskB.status, 'candidate', 'the persisted record on disk keeps B a candidate');

    // 9. A's frozen source is untouched by the ignore.
    const afterA = fingerprint(productView, producedA);
    const comparison = r3.compareFrozen(beforeA, afterA);
    assert.equal(comparison.identical, true, `A's frozen source must not change: ${JSON.stringify(comparison.diffs)}`);
    assert.equal(comparison.entrySha256Same, true, 'A\'s promoted entry file is byte-identical after the ignore');
    assert.equal(comparison.gitTreeSame, true, 'A\'s frozen commit tree is unchanged after the ignore');
    assert.equal(comparison.eventHashSame, true, 'A\'s frozen event hash is unchanged after the ignore');
    assert.equal(comparison.memoryFrozenFieldsSame, true, 'A\'s frozen record fields are unchanged after the ignore');

    // 10. Still not injected after the reload.
    const injected = await harness.injectedMemories(projectId);
    assert.ok(
      !injected.some(entry => entry.memoryId === candidateA.id),
      `an ignored memory is still never injected: ${JSON.stringify(injected)}`,
    );

    assert.equal(harness.browser.exceptions.length, 0, `no uncaught product JavaScript exceptions: ${JSON.stringify(harness.browser.exceptions)}`);

    evidence.push({
      case: 'MEM-005-persistence-healthy-page',
      run: {
        projectId,
        commitA: producedA.commitSha,
        commitB: producedB.commitSha,
        knowledgePath,
      },
      candidates: {
        ignored: { id: candidateA.id, text: TEXT_A, statusBefore: 'candidate', statusAfter: productView.status },
        contrast: { id: candidateB.id, text: TEXT_B, statusBefore: 'candidate', statusAfter: productB.status },
      },
      healthyPageGates: {
        banner: BANNER,
        beforeIgnore: { ...gateBefore, bothCardsVisible: true },
        afterIgnoreClick: { contrastStillVisible: true },
        afterReload: { ...gateAfter, contrastVisible: true, homeListsContrast: true, bannerInMemoryView: false, bannerInHome: false },
        pageSnapshotRequests: pageSnapshotRequests.slice(-6),
      },
      uiAfterReload: { ...afterReload, confirmedTab, pageReloaded: true, viewReopenedAfterReload: true },
      ignoreRequest: { method: 'PATCH', url: ignorePatch.url.replace(harness.base, ''), status: ignorePatch.status, request: ignorePatch.body },
      engineStateAfterReload: {
        productEndpoint: { A: productView.status, B: productB.status },
        engineEndpoint: { A: engineA.status, B: engineB.status },
        engineStateFile: { file: onDisk.file, exists: onDisk.exists, sha256: onDisk.sha256, A: diskA.status, B: diskB.status },
      },
      frozenSourceIgnored: { before: beforeA.source, after: afterA.source, comparison },
      injectedAfterReload: injected.map(entry => entry.memoryId),
      provenance: r3.provenance(),
      scopeLabel: 'honest: the analysis step is the frozen P-MEMORY-01 stand-in analyzer, not a model; health gates only read the real page (banner absence + contrast visibility + page snapshot 200s), the driver never sets an availability flag',
    });

    if (harness.evidence) {
      fs.mkdirSync(harness.evidence, { recursive: true });
      fs.writeFileSync(path.join(harness.evidence, 'mem005-r4-healthy-persistence.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
    }

    console.log('parallel-memory-capture-r4-mem005-health-test PASS (on a provably healthy page — contrast candidate visible, offline banner absent, page snapshot 200s — the ignored candidate stays ignored across a real reload and never returns as candidate or confirmed, while the engine, its persisted state and the frozen source are unchanged)');
  } finally {
    await harness.cleanup();
  }
}

main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
