'use strict';
// _site/_test/qa-r94-memory-readd-ui.cjs — P-MEMORY-DELETE-REVIEW-R94
//
// Minimal real-browser acceptance for the R94 review corrections, riding the
// patched qa-r91 harness (same isolation stack: own port/data/knowledge root,
// R91 source engine in-process behind the token proxy, real Chrome in its own
// profile, egress guard, no contact with live endpoints/HOME/real memories):
//
//   1. USER_DIALOG_COPY — the delete confirmation shows the simplified copy
//      (still usable as a long-term memory? no; original conversation and
//      knowledge sources kept; manual re-add possible) and no implementation
//      details (fingerprint/dedup/index/irreversible), and the post-delete
//      toast matches.
//   2. EXPLICIT_MANUAL_READD — after a real dialog delete, re-adding the
//      SAME text in the SAME scope through the real dialog succeeds, leaves
//      exactly ONE live card, survives a page reload and a real engine
//      restart, and the engine state holds one live record + one tombstone.
//   3. UI_HARNESS_CLEANUP proof — the run itself uses restartEngine() and
//      must exit cleanly: a wedged handle can no longer hang the driver.
const fs = require('node:fs');
const path = require('node:path');

const { startHarness, makeRepo } = require('./helpers/qa-r91-harness.cjs');
const { installEgressGuard } = require('./helpers/parallel-qa-engine-endpoint-guard');

const LANE = path.resolve(__dirname, '..', '..', 'qa-autopilot', 'artifacts', 'parallel-20261023', 'memory-delete-review-r94');
// R99: QA_R94_EVIDENCE_DIR reroutes the evidence of a NEW run (official
// prefix / later re-acceptance) so the frozen R94 lane evidence is never
// overwritten. Unset = the original R94 lane location, unchanged.
const UI_EVIDENCE = process.env.QA_R94_EVIDENCE_DIR ? path.resolve(process.env.QA_R94_EVIDENCE_DIR) : path.join(LANE, 'evidence', 'ui');

const TEXT_R = '全局甲（R94）：同一内容删除后手动重加';

async function main() {
  fs.mkdirSync(UI_EVIDENCE, { recursive: true });
  const egress = installEgressGuard();
  const h = await startHarness({ tag: 'r94-memory-readd', evidenceDir: UI_EVIDENCE });
  const steps = [];
  const step = (name, detail) => { steps.push({ name, ok: true, detail: detail ?? null }); console.log(`ok - ${name}`); };
  const fail = (name, detail) => { steps.push({ name, ok: false, detail: String(detail) }); throw Object.assign(new Error(`${name}: ${detail}`), { step: name }); };

  const shot = async name => { await h.browser.screenshot(path.join(UI_EVIDENCE, `${name}.png`)); };
  const deleteRequests = id => h.network.requests.filter(entry => entry.method === 'DELETE' && entry.url.includes(`/api/engine/memories/${encodeURIComponent(id)}`));
  const cardTexts = () => h.run("[...document.querySelectorAll('#memoryContent .memory-card p')].map(p => p.textContent)");
  const cardCount = async text => (await cardTexts()).filter(t => t === text).length;
  const memoryIdOf = async text => {
    const memories = await h.productMemories();
    const found = memories.find(m => m.text === text);
    return found ? found.id : null;
  };
  const waitCardCount = async (text, count) => {
    await h.waitFor(() => cardCount(text).then(n => n === count), `exactly ${count} card(s) for "${text}"`, 15000);
  };
  const gotoMemoryView = async () => {
    await h.nativeClick("nav button[data-view='memory']");
    await h.waitFor(() => h.run("document.querySelector('.view.active') && document.querySelector('.view.active').id === 'view-memory'"), 'the memory view activates', 10000);
  };
  const addViaDialog = async (text, scopeType = 'global') => {
    await h.nativeClick('#addMemory');
    await h.waitFor(() => h.run("document.getElementById('memoryDialog').open"), 'the add dialog opens', 5000);
    await h.nativeClick('#memoryText');
    await h.typeText(text);
    await h.selectOption('#memoryScope', scopeType);
    await h.nativeClick('#confirmMemory');
    await h.waitFor(() => h.run("!document.getElementById('memoryDialog').open"), 'the add dialog closes after saving', 10000);
  };

  try {
    // --------------------------------------------------------------- world
    const repo = makeRepo(h.knowledgeRoot, 'r94-code');
    const domain = await h.addDomain('重加验收领域');
    const imported = await h.importProject(repo, 'r94-项目', { domainId: domain.id });
    const projectId = imported.projectId;
    step('world', `project ${projectId} domain ${domain.id} imported through the real API`);

    await gotoMemoryView();
    await h.waitFor(() => h.run("document.getElementById('addMemory').disabled === false"), 'the engine connection makes the add button usable', 15000);

    // ------------------------------------------------- add + open delete UI
    await addViaDialog(TEXT_R);
    await waitCardCount(TEXT_R, 1);
    const idR = await memoryIdOf(TEXT_R);
    if (!idR) fail('find the live memory id', 'not in the product snapshot');
    await shot('qa-r94-01-added');
    step('manual add', 'global memory added through the real dialog');

    await h.nativeClick(`[data-memory-card='${idR}'] [data-memory-action='delete']`);
    await h.waitFor(() => h.run("document.getElementById('memoryDeleteDialog').open"), 'the delete dialog opens', 5000);

    // --------------------------------------- USER_DIALOG_COPY (review item 4)
    const copy = await h.run("document.querySelector('#memoryDeleteDialog p.muted:not([id])').textContent");
    for (const word of ['长期记忆', '原始对话', '知识来源', '重新添加']) {
      if (!copy.includes(word)) fail(`the simplified delete copy mentions ${word}`, copy);
    }
    for (const detail of ['指纹', '去重', '索引', '候选箱', '不可撤销']) {
      if (copy.includes(detail)) fail(`the simplified delete copy hides the implementation detail "${detail}"`, copy);
    }
    await shot('qa-r94-02-delete-dialog-copy');
    step('dialog copy', `simplified confirmation copy: ${copy}`);

    await h.nativeClick('#confirmMemoryDelete');
    await h.waitFor(() => h.run("!document.getElementById('memoryDeleteDialog').open"), 'the delete dialog closes', 10000);
    await waitCardCount(TEXT_R, 0);
    if (deleteRequests(idR).length !== 1) fail('exactly one DELETE on the wire', String(deleteRequests(idR).length));
    const toastText = await h.run("document.getElementById('toast').hidden ? '' : document.getElementById('toast').textContent");
    if (toastText !== '记忆已删除，不再作为长期记忆使用。') fail('the post-delete toast matches the simplified copy', toastText);
    const afterDelete = h.engine.store.state.memories;
    if (afterDelete.some(m => m.id === idR && m.status !== 'deleted')) fail('the engine keeps a tombstone for the deleted memory', 'record not deleted');
    if (afterDelete.find(m => m.id === idR).text !== undefined) fail('the tombstone carries no text', 'text kept');
    step('real delete', 'one DELETE, card gone, simplified toast, textless tombstone persisted');

    // ------------------------------- EXPLICIT_MANUAL_READD (review item 1)
    await addViaDialog(TEXT_R, 'global');
    await waitCardCount(TEXT_R, 1);
    const stateOne = h.engine.store.state.memories;
    const live = stateOne.filter(m => m.text === TEXT_R);
    const tombstones = stateOne.filter(m => m.status === 'deleted');
    if (live.length !== 1 || live[0].status !== 'confirmed') fail('the engine holds exactly one live record for the re-added text', JSON.stringify({ live: live.length }));
    if (tombstones.length !== 1 || tombstones[0].id !== idR) fail('the old tombstone survives the manual re-add', JSON.stringify(tombstones.map(m => m.id)));
    await shot('qa-r94-03-readded');
    step('same-scope manual re-add', 'the SAME text re-adds in the SAME scope: one live card, one live record, tombstone intact');

    // ------------------------------------------------------------ reload
    await h.reload();
    await gotoMemoryView();
    await waitCardCount(TEXT_R, 1);
    await shot('qa-r94-04-after-reload');
    step('reload keeps the re-add', 'exactly one card survives the page reload');

    // ------------------- engine restart + harness-handle proof (item 6)
    await h.restartEngine();
    if (h.engine.store.state.memories.filter(m => m.text === TEXT_R).length !== 1) fail('the live record survives the engine restart', 'engine state mismatch');
    if (h.engine.store.state.memories.filter(m => m.status === 'deleted').length !== 1) fail('the tombstone survives the engine restart', 'tombstone count mismatch');
    await h.reload();
    await gotoMemoryView();
    await waitCardCount(TEXT_R, 1);
    await shot('qa-r94-05-after-engine-restart');
    step('engine restart', 'restarted engine keeps one live record + one tombstone; cleanup now closes the LIVE handle');

    const report = {
      task: 'P-MEMORY-DELETE-REVIEW-R94',
      mode: 'green',
      finishedAt: new Date().toISOString(),
      engineSource: require('./helpers/qa-r91-harness.cjs').ENGINE_SOURCE_ROOT,
      memoryId: idR,
      dialogCopy: copy,
      steps,
      egress: { blockedCount: egress.blocked.length, blocked: egress.blocked.slice(0, 5) },
      networkDeletes: h.network.requests.filter(entry => entry.method === 'DELETE').map(entry => ({ url: entry.url, status: entry.status })),
    };
    fs.writeFileSync(path.join(UI_EVIDENCE, 'ui-green.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(`\nP-MEMORY-DELETE-REVIEW-R94 UI GREEN: ${steps.length} steps passed`);
  } catch (error) {
    try { await h.browser.screenshot(path.join(UI_EVIDENCE, 'green-failure.png')); } catch { /* browser may be gone */ }
    fs.writeFileSync(path.join(UI_EVIDENCE, 'ui-green.json'), `${JSON.stringify({
      task: 'P-MEMORY-DELETE-REVIEW-R94',
      mode: 'green',
      finishedAt: new Date().toISOString(),
      failed: String(error && error.message || error),
      steps,
    }, null, 2)}\n`, 'utf8');
    console.error(`FAIL (green): ${error && error.stack || error}`);
    process.exitCode = 1;
  } finally {
    await h.cleanup().catch(error => console.error(`cleanup: ${error.message}`));
    egress.uninstall();
  }
}

main().catch(error => { console.error(error); process.exit(1); });
