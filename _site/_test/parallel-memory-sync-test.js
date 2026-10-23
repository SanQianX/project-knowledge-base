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
//                                 shows 写入待恢复 / 待同步 and the real toast
//                                 warns that the unsynced memory is not
//                                 injected;
//   * 未同步内容不注入。        -> the engine injects nothing for the unsynced
//                                 memory, and it does inject it again once
//                                 the file can really be written.

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const { startHarness, makeRepo } = require('./helpers/parallel-memory-shell');

const EVIDENCE = process.env.PK_TEST_EVIDENCE_DIR ? path.resolve(process.env.PK_TEST_EVIDENCE_DIR) : null;
const MEMORY_TEXT = '同步失败回归：对外错误信息使用中文表述。';

async function openMemoryView(harness) {
  await harness.nativeClick('nav [data-view="memory"]');
  await harness.waitFor(
    () => harness.run("document.getElementById('view-memory').classList.contains('active')"),
    'the memory view is open',
    10000,
  );
}

async function main() {
  const harness = await startHarness({ tag: 'memsync', evidenceDir: EVIDENCE || undefined });
  const evidence = [];
  try {
    const repo = makeRepo(harness.fixture, 'memsync-repo', { 'README.md': '# 同步甲\n' });
    const { projectId } = await harness.importProject(repo, '同步甲');
    await harness.requestRegistryRefresh();
    await harness.waitFor(
      () => harness.run("document.getElementById('homeContent').textContent.includes('同步甲')"),
      'the imported project is listed',
      20000,
    );

    await openMemoryView(harness);
    await harness.waitFor(
      () => harness.run("!document.getElementById('addMemory').disabled"),
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

    // Add the memory through the real UI as a global memory.
    await harness.nativeClick('#addMemory');
    await harness.waitFor(
      () => harness.run("document.getElementById('memoryDialog').open === true"),
      'the add dialog is open',
      10000,
    );
    await harness.typeText(MEMORY_TEXT);
    await harness.selectOption('#memoryScope', 'global');
    const postsBefore = harness.network.find(entry => entry.method === 'POST' && entry.url.includes('/api/engine/memories')).length;
    await harness.nativeClick('#confirmMemory');
    await harness.waitFor(
      () => harness.run("document.getElementById('memoryDialog').open === false"),
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

    // The real UI shows the pending state.
    const toast = await harness.run("document.getElementById('toast').textContent");
    assert.match(String(toast), /记忆文件待恢复/, `the toast warns about the pending file: ${toast}`);
    assert.match(String(toast), /未同步内容不会注入任务。/, 'the toast warns that the unsynced memory is not injected');

    const card = await harness.run(`(() => {
      const el = document.querySelector('[data-memory-card=${JSON.stringify(created.id)}]');
      return el ? el.textContent : null;
    })()`);
    assert.ok(card, 'the confirmed memory is really listed');
    assert.match(card, /写入待恢复/, `the card shows the pending write: ${card}`);
    assert.match(card, /待同步/, 'the card shows the pending sync state');
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
      ui: { toast, card },
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
    await harness.nativeClick('[data-memory-tab="confirmed"]');
    await harness.waitFor(
      () => harness.run(`document.getElementById('memoryContent').textContent.includes(${JSON.stringify(MEMORY_TEXT)})`),
      'the recovered memory is listed again',
      15000,
    );
    const recoveredCard = await harness.run(`(() => {
      const el = document.querySelector('[data-memory-card=${JSON.stringify(created.id)}]');
      return el ? el.textContent : null;
    })()`);
    assert.ok(recoveredCard, 'the recovered memory has a card');
    assert.ok(!recoveredCard.includes('写入待恢复'), `the card no longer shows the pending write: ${recoveredCard}`);
    assert.match(recoveredCard, /已确认/, 'the card shows the confirmed state again');
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

    console.log('parallel-memory-sync-test PASS (MEM-006 the real write failure shows sync pending, the unsynced memory is not injected, and the recovered memory is injected again)');
  } finally {
    await harness.cleanup();
  }
}

main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
