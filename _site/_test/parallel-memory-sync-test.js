'use strict';
// _site/_test/parallel-memory-sync-test.js
//
// MEM-006 同步失败（sync pending）.
//
// Real isolated product instance, real browser, real HTTP and real disk.
//
// The write really fails: the brain's shared memory file path is occupied by
// a directory, so the engine's own materialize() cannot write the confirmed
// memory file. Nothing is faked here — the engine records the real write
// error, the shell renders the real pending state and the real injection gate
// refuses to hand the unsynced memory to a task.
//
// MEM-006 expected:
//   * sync pending真实显示。   -> the engine really answers syncStatus
//                                 'pending' with the write error, the real UI
//                                 shows the pending write badge on the memory
//                                 card (写入待恢复) and the real injection gate
//                                 refuses the unsynced memory;
//   * 未同步内容不注入。        -> the engine injects nothing for the unsynced
//                                 memory, and it does inject it again once
//                                 the file can really be written.
//
// 迁移说明（五页简化 UI，见 patches/ui-test-mapping-spec.md）：
//   * 添加记忆入口：#addMemory → 记忆库 tab 头部 [data-action="new-memory"]；
//     「引擎可达」等待从「#addMemory 未禁用」等价为「[data-action="new-memory"]
//     已渲染」（engineAvailable 为 false 时 renderMemories 只渲染离线横幅，
//     不渲染该按钮）。
//   * 添加表单：#memoryDialog/#memoryText/#memoryScope/#confirmMemory →
//     #appDialog 内 #memoryForm：标题 input[name="title"]（新契约必填）与
//     正文 textarea[name="text"] 都用 CDP Input.insertText（真实粘贴路径），
//     适用范围 select[name="scopeType"]=global，提交 =
//     #appDialogActions button.primary（type=submit 关联 #memoryForm）。
//   * 记忆卡片：[data-memory-card=<id>] → .memory-item（以
//     [data-action="memory-detail"][data-id=<id>] 定位）。旧卡片的
//     「写入待恢复 / 待同步」两个标签在新 UI 合并为单个「写入待恢复」徽标
//     （ui/product.js memoryCard），断言等价为：pending 时徽标在、恢复后消失。
//   * 旧 toast「记忆文件待恢复 / 未同步内容不会注入任务。」在新产品里不再
//     弹出（同步失败改为呈现在卡片徽标上），被动 toast 观察器随之移除；
//     「未同步内容不注入」语义仍由引擎注入门（/api/context）断言证明。
//   * 恢复后的「已确认」卡片文案在新 UI 不存在；等价断言 = 恢复的记忆重新
//     出现在「记忆库」tab（[data-memory-tab="library"]，旧 confirmed tab，
//     仅列出 status=confirmed 的记忆）、卡片带「全局记忆」作用域行且无
//     pending 徽标。
//   * 导入项目已列出的等待：旧首页项目面板（homeContent 含项目名）已删除，
//     等价为顶栏 #projectSelect 选项里出现项目名（同一 registry projection）。
//   * 引擎/数据断言（POST 200、created.status=confirmed、syncStatus=pending、
//     syncError、注入门、confirmed.md 物化与恢复）保持不变；本测试使用真实
//     引擎（dataSchemaVersion 由引擎自身报告，当前为 4），无需同步任何桩。

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const { startHarness, makeRepo } = require('./helpers/parallel-memory-shell');

const EVIDENCE = process.env.PK_TEST_EVIDENCE_DIR ? path.resolve(process.env.PK_TEST_EVIDENCE_DIR) : null;
const MEMORY_TITLE = '同步失败回归';
const MEMORY_TEXT = '同步失败回归：对外错误信息使用中文表述。';

/**
 * Open the memory view with retries against the known reload commit-gap race
 * (the shell's reload() gate proves the FRESH document, but a CDP click
 * dispatched right at the commit boundary can still be lost — see the
 * parallel-memory-shell.js reload comment). Driver robustness only: the
 * assertion stays "the view is really active".
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

/** The library card (.memory-item) of one memory, located by its detail button. */
const memoryCardText = (harness, memoryId) => harness.run(`(() => {
  const button = document.querySelector('#memoryContent [data-action="memory-detail"][data-id=${JSON.stringify(memoryId)}]');
  const card = button ? button.closest('.memory-item') : null;
  return card ? card.textContent : null;
})()`);

async function main() {
  const harness = await startHarness({ tag: 'memsync', evidenceDir: EVIDENCE || undefined });
  const evidence = [];
  try {
    const repo = makeRepo(harness.fixture, 'memsync-repo', { 'README.md': '# 同步甲\n' });
    const { projectId } = await harness.importProject(repo, '同步甲');
    await harness.requestRegistryRefresh();
    // The new home page no longer lists projects (领域/项目面板已删除)；the
    // registry projection is surfaced by the topbar project selector instead.
    await harness.waitFor(
      () => harness.run("document.getElementById('projectSelect').textContent.includes('同步甲')"),
      'the imported project is listed',
      20000,
    );

    await openMemoryView(harness);
    await harness.waitFor(
      () => harness.run("document.querySelector('#memoryContent [data-action=\"new-memory\"]') !== null"),
      'the engine is reachable and the add button is live',
      20000,
    );

    // Break the real write path: the confirmed memory file path becomes a
    // directory, so the engine cannot write the memory file.
    const brainScope = harness.brainScopePath();
    const memoryFile = path.join(brainScope, 'memories', 'confirmed.md');
    fs.rmSync(memoryFile, { recursive: true, force: true });
    fs.mkdirSync(memoryFile, { recursive: true });
    assert.ok(fs.lstatSync(memoryFile).isDirectory(), 'the confirmed memory file path really is occupied by a directory');

    // Add the memory through the real UI as a global memory: the new-memory
    // dialog (#appDialog > #memoryForm) with title + multiline body, scope
    // global, submitted by the primary (type=submit) action button.
    await harness.nativeClick('#memoryContent [data-action="new-memory"]');
    await harness.waitFor(
      () => harness.run("document.getElementById('appDialog').open === true && document.getElementById('memoryForm') !== null"),
      'the add dialog with the memory form is open',
      10000,
    );
    await harness.nativeClick('#memoryForm input[name="title"]');
    await harness.browser.send('Input.insertText', { text: MEMORY_TITLE });
    await harness.nativeClick('#memoryForm textarea[name="text"]');
    await harness.browser.send('Input.insertText', { text: MEMORY_TEXT });
    await harness.selectOption('#memoryForm select[name="scopeType"]', 'global');
    const postsBefore = harness.network.find(entry => entry.method === 'POST' && entry.url.includes('/api/engine/memories')).length;
    await harness.nativeClick('#appDialogActions button.primary');
    await harness.waitFor(
      () => harness.run("document.getElementById('appDialog').open === false"),
      'the dialog closes after the save',
      15000,
    );

    const post = harness.network.find(entry => entry.method === 'POST' && entry.url.includes('/api/engine/memories'))[postsBefore];
    assert.ok(post, 'the shell really posted the memory');
    assert.equal(post.status, 200, `the real POST answers 200: ${JSON.stringify(post.body)}`);
    const postBody = await harness.network.body(post);
    const created = postBody.memory;
    assert.equal(created.status, 'confirmed', 'the memory itself is confirmed');
    assert.equal(created.syncStatus, 'pending', `the engine really answers syncStatus pending: ${JSON.stringify(created)}`);
    assert.ok(created.syncError, `the engine reports the real write error: ${JSON.stringify(created.syncError)}`);

    // The real UI shows the pending state: the memory's card in the library
    // (记忆库) tab carries the 写入待恢复 badge (ui/product.js memoryCard —
    // the new UI's single pending indicator, replacing the old card's
    // 写入待恢复 + 待同步 pair and the old pending toast).
    const debugUiFailure = async stage => {
      try {
        const dump = await harness.run(`(() => ({
          feedback: document.getElementById('appDialogFeedback').textContent,
          feedbackHidden: document.getElementById('appDialogFeedback').hidden,
          dialogOpen: document.getElementById('appDialog').open,
          activeView: (document.querySelector('.view.active') || {}).id || null,
          memoryContent: document.getElementById('memoryContent').textContent.slice(0, 400),
        }))()`);
        console.error(`MEM-006 UI failure at ${stage}: ${JSON.stringify(dump)}`);
        if (harness.evidence) await harness.browser.screenshot(path.join(harness.evidence, `mem006-failure-${stage}.png`));
      } catch {}
    };
    let card;
    try {
      card = await harness.waitFor(
        () => memoryCardText(harness, created.id),
        'the confirmed memory is really listed with its pending badge',
        15000,
      );
    } catch (error) { await debugUiFailure('card-listed'); throw error; }
    assert.match(card, /写入待恢复/, `the card shows the pending write: ${card}`);
    if (harness.evidence) await harness.browser.screenshot(path.join(harness.evidence, 'mem006-sync-pending.png'));

    // 未同步内容不注入: the real injection gate refuses the unsynced memory.
    const injected = await harness.injectedMemories(projectId);
    assert.ok(
      !injected.some(entry => entry.memoryId === created.id),
      `the unsynced memory is never injected: ${JSON.stringify(injected)}`,
    );

    const pendingRecord = (await harness.productMemories()).find(memory => memory.id === created.id);
    assert.equal(pendingRecord.syncStatus, 'pending', 'the stored memory still carries the pending sync state');

    evidence.push({
      case: 'MEM-006',
      request: { method: post.method, url: post.url.replace(harness.base, ''), status: post.status, response: postBody },
      memory: { id: created.id, status: created.status, syncStatus: created.syncStatus, syncError: created.syncError, scopeType: created.scopeType, scopeId: created.scopeId },
      ui: { card, pendingBadge: '写入待恢复', note: 'the new five-page UI surfaces sync-pending on the card badge; the old pending toast no longer exists' },
      injectedWhilePending: injected.map(entry => entry.memoryId),
      blockedPath: memoryFile,
    });

    // ---------------------------------------------------------------- recovery
    // The write really works again: the directory is removed and the engine's
    // own recovery writes the file. The memory becomes injectable again.
    fs.rmSync(memoryFile, { recursive: true, force: true });
    await harness.waitFor(
      async () => {
        const memories = await harness.productMemories();
        const memory = memories.find(entry => entry.id === created.id);
        return memory && memory.syncStatus === 'ready' ? memory : null;
      },
      'the engine recovers the pending write',
      30000,
    );
    assert.ok(fs.existsSync(memoryFile), 'the confirmed memory file is really written again');
    const fileText = fs.readFileSync(memoryFile, 'utf8');
    assert.ok(fileText.includes(created.id), 'the recovered file holds the memory');
    assert.ok(fileText.includes(MEMORY_TEXT), 'the recovered file holds the text');

    const afterRecovery = await harness.injectedMemories(projectId);
    assert.ok(
      afterRecovery.some(entry => entry.memoryId === created.id),
      `the recovered memory is injected again: ${JSON.stringify(afterRecovery)}`,
    );

    await harness.reload();
    await openMemoryView(harness);
    // The reloaded page first renders the offline banner until its boot
    // snapshot answers; the tab bar (and the library tab) exist only after
    // the real engine data is in.
    await harness.waitFor(
      () => harness.run("document.querySelector('#memoryContent [data-memory-tab=\"library\"]') !== null"),
      'the memory tab bar is rendered from real data',
      20000,
    );
    await harness.nativeClick('#memoryContent [data-memory-tab="library"]');
    await harness.waitFor(
      () => harness.run(`document.getElementById('memoryContent').textContent.includes(${JSON.stringify(MEMORY_TEXT)})`),
      'the recovered memory is listed again',
      15000,
    );
    const recoveredCard = await memoryCardText(harness, created.id);
    assert.ok(recoveredCard, 'the recovered memory has a card');
    assert.ok(!recoveredCard.includes('写入待恢复'), `the card no longer shows the pending write: ${recoveredCard}`);
    assert.match(recoveredCard, /全局记忆/, 'the card is a live library card with its global scope (the 记忆库 tab only lists confirmed memories)');
    if (harness.evidence) await harness.browser.screenshot(path.join(harness.evidence, 'mem006-recovered.png'));

    evidence.push({
      case: 'MEM-006-recovery',
      memoryFile,
      injectedAfterRecovery: afterRecovery.map(entry => entry.memoryId),
      ui: { card: recoveredCard },
    });

    assert.equal(harness.browser.exceptions.length, 0, `no uncaught product JavaScript exceptions: ${JSON.stringify(harness.browser.exceptions)}`);

    if (harness.evidence) {
      fs.mkdirSync(harness.evidence, { recursive: true });
      fs.writeFileSync(path.join(harness.evidence, 'mem006-sync.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
    }

    console.log('parallel-memory-sync-test PASS (MEM-006 the real write failure shows the pending badge on the memory card, the unsynced memory is not injected, and the recovered memory is injected again)');
  } finally {
    await harness.cleanup();
  }
}

main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
