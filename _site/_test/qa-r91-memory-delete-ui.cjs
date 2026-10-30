'use strict';
// _site/_test/qa-r91-memory-delete-ui.cjs — P-MEMORY-DELETE-R91
//
// Isolated real-browser acceptance for user-visible memory deletion.
// Runs the real product shell (own port/data/knowledge root), the real R91
// source engine in-process behind the token proxy, and a real Chrome in its
// own profile. QA_R91_EXPECT_RED=1 runs the pre-UI-hunk red form: it stops at
// the first missing delete control and exits non-zero.
//
// Flows (green):
//   manual add global/domain/project + agent candidate through the real UI
//   and the real pipeline; cancel sends NO delete; real delete removes only
//   its target; page reload and a real engine restart keep it gone; the
//   markdown and the injected context exclude it; a rapid double confirm
//   sends exactly ONE DELETE; a repeated candidate run does not resurrect a
//   deleted candidate; the candidate badge count reaches zero.
const fs = require('node:fs');
const path = require('node:path');

const { startHarness, makeRepo } = require('./helpers/qa-r91-harness.cjs');
const { installEgressGuard } = require('./helpers/parallel-qa-engine-endpoint-guard');

const LANE = path.resolve(__dirname, '..', '..', 'qa-autopilot', 'artifacts', 'parallel-20261023', 'memory-delete-r91');
const UI_EVIDENCE = path.join(LANE, 'evidence', 'ui');
const EXPECT_RED = process.env.QA_R91_EXPECT_RED === '1';

const TEXT = {
  a: '全局甲：对外错误信息一律使用中文',
  e: '领域戊：领域内优先复用成熟消息流',
  f: '项目己：本项目保持零新增依赖',
  g: '全局庚：保留的邻项记忆',
  h: '全局辛：用于验证双击只发一次删除',
  d: '自动候选癸：软件保持简单避免无必要实体',
};

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  fs.mkdirSync(UI_EVIDENCE, { recursive: true });
  const egress = installEgressGuard();
  const h = await startHarness({ tag: 'memory-delete', evidenceDir: UI_EVIDENCE });
  const steps = [];
  const step = (name, detail) => { steps.push({ name, ok: true, detail: detail ?? null }); console.log(`ok - ${name}`); };
  const fail = (name, detail) => { steps.push({ name, ok: false, detail: String(detail) }); throw Object.assign(new Error(`${name}: ${detail}`), { step: name }); };

  const shot = async name => { await h.browser.screenshot(path.join(UI_EVIDENCE, `${name}.png`)); };
  const deleteRequests = id => h.network.requests.filter(entry => entry.method === 'DELETE' && entry.url.includes(`/api/engine/memories/${encodeURIComponent(id)}`));
  const openDialogGone = () => h.run("!document.getElementById('memoryDialog').open");
  const cardIds = () => h.run("[...document.querySelectorAll('#memoryContent .memory-card')].map(card => card.dataset.memoryId)");
  const cardTexts = () => h.run("[...document.querySelectorAll('#memoryContent .memory-card p')].map(p => p.textContent)");
  const memoryIdOf = async text => {
    const memories = await h.productMemories();
    const found = memories.find(m => m.text === text);
    return found ? found.id : null;
  };
  const waitCard = async (text, { tab = 'confirmed', present = true } = {}) => {
    await h.waitFor(async () => {
      const texts = await cardTexts();
      return texts.includes(text) === present;
    }, `memory card "${text}" ${present ? 'appears' : 'disappears'} in the ${tab} list`, 15000);
  };
  const gotoMemoryView = async () => {
    await h.nativeClick("nav button[data-view='memory']");
    await h.waitFor(() => h.run("document.querySelector('.view.active') && document.querySelector('.view.active').id === 'view-memory'"), 'the memory view activates', 10000);
  };
  const addViaDialog = async (text, scopeType = 'global', scopeId) => {
    await h.nativeClick('#addMemory');
    await h.waitFor(() => h.run("document.getElementById('memoryDialog').open"), 'the add dialog opens', 5000);
    await h.nativeClick('#memoryText');
    await h.typeText(text);
    await h.selectOption('#memoryScope', scopeType);
    if (scopeType !== 'global') await h.selectOption('#memoryTarget', scopeId);
    await h.nativeClick('#confirmMemory');
    await h.waitFor(openDialogGone, 'the add dialog closes after saving', 10000);
    await waitCard(text);
  };
  const deleteViaDialog = async (text) => {
    const id = await memoryIdOf(text);
    if (!id) fail(`find memory id for "${text}"`, 'not in the product snapshot');
    await h.nativeClick(`[data-memory-card='${id}'] [data-memory-action='delete']`);
    await h.waitFor(() => h.run("document.getElementById('memoryDeleteDialog').open"), 'the delete dialog opens', 5000);
    const shown = await h.run("({ text: document.getElementById('memoryDeleteText').textContent, scope: document.getElementById('memoryDeleteScope').textContent })");
    if (shown.text !== text) fail('the delete dialog shows the exact memory text', JSON.stringify(shown));
    if (!shown.scope || !shown.scope.includes('适用范围')) fail('the delete dialog shows the scope', JSON.stringify(shown));
    await h.nativeClick('#confirmMemoryDelete');
    await h.waitFor(() => h.run("!document.getElementById('memoryDeleteDialog').open"), 'the delete dialog closes', 10000);
    await waitCard(text, { present: false });
    return id;
  };

  try {
    // ---------------------------------------------------------------- world
    const repo = makeRepo(h.knowledgeRoot, 'r91-code');
    const domain = await h.addDomain('删除验收领域');
    const imported = await h.importProject(repo, 'r91-项目', { domainId: domain.id });
    const projectId = imported.projectId;
    step('world', `project ${projectId} domain ${domain.id} imported through the real API`);

    await gotoMemoryView();
    await h.waitFor(() => h.run("document.getElementById('addMemory').disabled === false"), 'the engine connection makes the add button usable', 15000);

    // ------------------------------------------------------- RED short form
    if (EXPECT_RED) {
      const created = await h.productApi('POST', '/api/engine/memories', { text: TEXT.g });
      if (created.status !== 200) fail('seed one memory through the product proxy', JSON.stringify(created.body));
      await h.reload();
      await gotoMemoryView();
      await waitCard(TEXT.g);
      await shot('red-no-delete-control');
      const hasDelete = await h.run("Boolean(document.querySelector(\"[data-memory-action='delete']\"))");
      if (!hasDelete) fail('RED: the confirmed memory card has no delete control on the unpatched UI', 'data-memory-action="delete" absent');
      fail('RED expected the unpatched UI to lack the delete control', 'control present?!');
    }

    // --------------------------------------------------------- green world
    await addViaDialog(TEXT.a);
    await addViaDialog(TEXT.e, 'domain', domain.id);
    await addViaDialog(TEXT.f, 'project', projectId);
    await addViaDialog(TEXT.g);
    await shot('01-list-before');
    step('manual adds', 'global/domain/project/manual memories added through the real dialog');

    const candidate = await h.produceCandidate({ repo, projectId, text: TEXT.d });
    if (!candidate.capture || candidate.capture.accepted !== 1) fail('the real pipeline captures the agent candidate', JSON.stringify(candidate.capture));
    await h.reload();
    await gotoMemoryView();
    await h.nativeClick("#memoryTabs [data-memory-tab='candidate']");
    await waitCard(TEXT.d, { tab: 'candidate' });
    const badgeBefore = await h.run("document.getElementById('candidateCount').textContent.trim()");
    if (badgeBefore !== '1') fail('the candidate badge shows 1 before deletion', badgeBefore);
    step('agent candidate', 'captured through a real run and visible in the inbox');

    await h.reload();
    await gotoMemoryView();
    for (const text of [TEXT.a, TEXT.e, TEXT.f, TEXT.g]) await waitCard(text);
    step('reload keeps all', 'all four confirmed memories survive a page reload');

    // ------------------------------------------------------------- cancel
    const idA = await memoryIdOf(TEXT.a);
    const deletesBefore = deleteRequests(idA).length;
    await h.nativeClick(`[data-memory-card='${idA}'] [data-memory-action='delete']`);
    await h.waitFor(() => h.run("document.getElementById('memoryDeleteDialog').open"), 'cancel case: the delete dialog opens', 5000);
    await shot('02-delete-dialog');
    await h.nativeClick("#memoryDeleteDialog [data-close='memoryDeleteDialog']");
    await h.waitFor(() => h.run("!document.getElementById('memoryDeleteDialog').open"), 'cancel closes the dialog', 5000);
    await waitCard(TEXT.a);
    if (deleteRequests(idA).length !== deletesBefore) fail('cancel sends no DELETE request', `${deleteRequests(idA).length} > ${deletesBefore}`);
    step('cancel', 'cancel keeps the memory and sends no DELETE');

    // ------------------------------------------------------------ deletes
    await deleteViaDialog(TEXT.a);
    if (deleteRequests(idA).length !== 1) fail('exactly one DELETE for the deleted memory', String(deleteRequests(idA).length));
    const tombstoneA = h.engine.store.state.memories.find(m => m.id === idA);
    if (!tombstoneA || tombstoneA.status !== 'deleted' || tombstoneA.text !== undefined) fail('the engine keeps a textless tombstone', JSON.stringify(tombstoneA && { status: tombstoneA.status, hasText: 'text' in tombstoneA }));
    step('delete global manual', 'one DELETE on the wire, tombstone persisted, card gone');

    await deleteViaDialog(TEXT.e);
    await deleteViaDialog(TEXT.f);
    for (const text of [TEXT.e, TEXT.f]) await waitCard(text, { present: false });
    await waitCard(TEXT.g);
    step('delete domain/project', 'domain and project memories deleted, neighbour stays');

    const ids = { a: idA, e: await memoryIdOf(TEXT.e) || 'gone', f: await memoryIdOf(TEXT.f) || 'gone' };
    const confirmedMd = fs.readFileSync(path.join(h.brainScopePath(), 'memories', 'confirmed.md'), 'utf8');
    if (confirmedMd.includes(TEXT.a) || confirmedMd.includes(TEXT.e) || confirmedMd.includes(TEXT.f)) fail('materialized markdown drops the deleted texts', 'deleted text still in memories/confirmed.md');
    if (!confirmedMd.includes(TEXT.g)) fail('materialized markdown keeps the neighbour', TEXT.g);
    const injectedTexts = (await h.injectedMemories(projectId)).map(m => m.text).filter(Boolean);
    if (injectedTexts.some(t => [TEXT.a, TEXT.e, TEXT.f].includes(t))) fail('the injected context excludes the deleted memories', JSON.stringify(injectedTexts));
    if (!injectedTexts.includes(TEXT.g)) fail('the injected context still contains the neighbour', JSON.stringify(injectedTexts));
    step('markdown + injection', 'deleted texts gone from memories/confirmed.md and from /api/context; neighbour kept');

    // ------------------------------------------------------------ reload
    await h.reload();
    await gotoMemoryView();
    await waitCard(TEXT.g);
    await h.waitFor(async () => {
      const texts = await cardTexts();
      return !texts.includes(TEXT.a) && !texts.includes(TEXT.e) && !texts.includes(TEXT.f);
    }, 'deleted memories stay gone after a page reload', 10000);
    await shot('03-after-reload');
    step('reload after delete', 'deleted memories stay gone after the reload');

    // ---------------------------------------------------- engine restart
    await h.restartEngine();
    await h.reload();
    await gotoMemoryView();
    await waitCard(TEXT.g);
    await h.waitFor(async () => {
      const texts = await cardTexts();
      return !texts.includes(TEXT.a) && !texts.includes(TEXT.e) && !texts.includes(TEXT.f);
    }, 'deleted memories stay gone after a real engine restart', 10000);
    const restartedTombstones = h.engine.store.state.memories.filter(m => m.status === 'deleted');
    if (restartedTombstones.length !== 3) fail('three tombstones survive the restart in engine state', String(restartedTombstones.length));
    await shot('04-after-engine-restart');
    step('engine restart', 'restart on the same data dir keeps the three tombstones and the list honest');

    // ------------------------------------------------------- double click
    await addViaDialog(TEXT.h);
    const idH = await memoryIdOf(TEXT.h);
    await h.nativeClick(`[data-memory-card='${idH}'] [data-memory-action='delete']`);
    await h.waitFor(() => h.run("document.getElementById('memoryDeleteDialog').open"), 'double-click case: dialog opens', 5000);
    await h.nativeClick('#confirmMemoryDelete');
    await h.nativeClick('#confirmMemoryDelete');
    await h.waitFor(async () => {
      const texts = await cardTexts();
      return !texts.includes(TEXT.h);
    }, 'the double-clicked memory disappears', 10000);
    if (deleteRequests(idH).length !== 1) fail('rapid double confirm sends exactly ONE DELETE', String(deleteRequests(idH).length));
    step('double click', 'rapid double confirm = one DELETE request, one deletion');

    // --------------------------------------------------- candidate delete
    await h.nativeClick("#memoryTabs [data-memory-tab='candidate']");
    await waitCard(TEXT.d, { tab: 'candidate' });
    const idD = await memoryIdOf(TEXT.d);
    await h.nativeClick(`[data-memory-card='${idD}'] [data-memory-action='delete']`);
    await h.waitFor(() => h.run("document.getElementById('memoryDeleteDialog').open"), 'candidate delete dialog opens', 5000);
    await h.nativeClick('#confirmMemoryDelete');
    await waitCard(TEXT.d, { present: false, tab: 'candidate' });
    await h.waitFor(() => h.run("document.getElementById('candidateCount').textContent.trim() === ''"), 'the candidate badge reaches zero', 10000);
    await shot('05-candidate-deleted');
    step('candidate delete', 'agent candidate deleted from the inbox, badge at zero');

    // ------------------------------------------------ no resurrection
    const again = await h.produceCandidate({ repo, projectId, text: TEXT.d, file: 'src/candidate-again.js' });
    if (!again.capture || again.capture.accepted !== 0 || again.capture.deduplicated < 1) fail('the repeated candidate run deduplicates against the tombstone', JSON.stringify(again.capture));
    await h.reload();
    await gotoMemoryView();
    await h.nativeClick("#memoryTabs [data-memory-tab='candidate']");
    await waitCard(TEXT.d, { present: false, tab: 'candidate' });
    step('no resurrection', 'the same candidate run again does not re-enter the inbox');

    // ------------------------------------------------------ home screen
    await h.nativeClick("nav button[data-view='home']");
    await h.waitFor(() => h.run("document.querySelector('.view.active').id === 'view-home'"), 'home view activates', 10000);
    const badgeHidden = await h.run("document.getElementById('memoryCount').hidden");
    if (!badgeHidden) fail('the home candidate badge hides at zero candidates', String(badgeHidden));
    await shot('06-home-badge-zero');
    step('home stats', 'candidate badge hidden with an empty inbox');

    const report = {
      task: 'P-MEMORY-DELETE-R91',
      mode: EXPECT_RED ? 'red' : 'green',
      finishedAt: new Date().toISOString(),
      engineSource: require('./helpers/qa-r91-harness.cjs').ENGINE_SOURCE_ROOT,
      deletedIds: ids,
      steps,
      egress: { blockedCount: egress.blocked.length, blocked: egress.blocked.slice(0, 5) },
      networkDeletes: h.network.requests.filter(entry => entry.method === 'DELETE').map(entry => ({ url: entry.url, status: entry.status })),
    };
    fs.writeFileSync(path.join(UI_EVIDENCE, EXPECT_RED ? 'ui-red.json' : 'ui-green.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(`\nP-MEMORY-DELETE-R91 UI ${EXPECT_RED ? 'RED' : 'GREEN'}: ${steps.length} steps passed`);
  } catch (error) {
    const shotName = EXPECT_RED ? 'red-failure' : 'green-failure';
    try { await h.browser.screenshot(path.join(UI_EVIDENCE, `${shotName}.png`)); } catch { /* browser may be gone */ }
    fs.writeFileSync(path.join(UI_EVIDENCE, EXPECT_RED ? 'ui-red.json' : 'ui-green.json'), `${JSON.stringify({
      task: 'P-MEMORY-DELETE-R91',
      mode: EXPECT_RED ? 'red' : 'green',
      finishedAt: new Date().toISOString(),
      failed: String(error && error.message || error),
      steps,
    }, null, 2)}\n`, 'utf8');
    console.error(`FAIL (${EXPECT_RED ? 'red' : 'green'}): ${error && error.stack || error}`);
    process.exitCode = 1;
  } finally {
    await h.cleanup().catch(error => console.error(`cleanup: ${error.message}`));
    egress.uninstall();
  }
}

main().catch(error => { console.error(error); process.exit(1); });
