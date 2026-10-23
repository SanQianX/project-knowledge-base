'use strict';
// _site/_test/parallel-memory-manual-test.js
//
// MEM-001 手动添加 / MEM-002 空白拒绝.
//
// Every step runs against a real isolated product instance: its own port,
// data dir, knowledge root, Bridge journal home and browser profile, with the
// REAL vendored knowledge engine in-process behind a pass-through proxy. The
// memory is added through the real UI in a real Chrome: a real pointer click
// opens the dialog, real key events type the content, a real pointer click
// submits it.
//
// MEM-001 expected:
//   * POST真实保存为confirmed。        -> the captured POST really answers
//                                         status 'confirmed', sourceType
//                                         'manual', evidence null;
//   * 刷新后保留。                    -> after a real page reload the memory
//                                         is still listed, still confirmed, and
//                                         the memory file on disk still holds
//                                         it.
// MEM-002 expected:
//   * 前后端均拒绝。                  -> the UI refuses a blank body without
//                                         sending a request, and the engine
//                                         itself rejects a blank body;
//   * 不出现空记忆。                  -> no memory exists anywhere afterwards.

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const { startHarness, makeRepo } = require('./helpers/parallel-memory-shell');

const EVIDENCE = process.env.PK_TEST_EVIDENCE_DIR ? path.resolve(process.env.PK_TEST_EVIDENCE_DIR) : null;
const MEMORY_TEXT = '对外错误信息使用中文表述，并优先复用已有模块。';

async function openMemoryView(harness) {
  await harness.nativeClick('nav [data-view="memory"]');
  await harness.waitFor(
    () => harness.run("document.getElementById('view-memory').classList.contains('active')"),
    'the memory view is open',
    10000,
  );
}

async function main() {
  const harness = await startHarness({ tag: 'mem001', evidenceDir: EVIDENCE || undefined });
  const evidence = [];
  try {
    const repo = makeRepo(harness.fixture, 'mem001-repo', { 'README.md': '# 记忆甲\n' });
    const { projectId } = await harness.importProject(repo, '记忆甲');

    // The shell has to know the project before it can bind a project scope.
    await harness.requestRegistryRefresh();
    await harness.waitFor(
      () => harness.run("document.getElementById('homeContent').textContent.includes('记忆甲')"),
      'the imported project is listed',
      20000,
    );

    await openMemoryView(harness);
    await harness.waitFor(
      () => harness.run("!document.getElementById('addMemory').disabled"),
      'the engine is reachable and the add button is live',
      20000,
    );

    // ---------------------------------------------------------------- MEM-002
    await harness.nativeClick('#addMemory');
    await harness.waitFor(
      () => harness.run("document.getElementById('memoryDialog').open === true"),
      'the add dialog is open',
      10000,
    );
    // Real key events into the really focused textarea.
    await harness.typeText('   ');
    const typed = await harness.run("document.getElementById('memoryText').value");
    assert.equal(typed, '   ', 'the blank body really reached the textarea');

    const postsBefore = harness.network.find(entry => entry.method === 'POST' && entry.url.includes('/api/engine/memories')).length;
    await harness.nativeClick('#confirmMemory');
    await harness.waitFor(
      () => harness.run("document.getElementById('memoryFeedback').hidden === false"),
      'the shell refuses the blank body in the dialog',
      10000,
    );
    const feedback = await harness.run("document.getElementById('memoryFeedback').textContent");
    assert.match(String(feedback), /请填写记忆内容。/, 'the shell names the missing content');
    const postsAfter = harness.network.find(entry => entry.method === 'POST' && entry.url.includes('/api/engine/memories')).length;
    assert.equal(postsAfter, postsBefore, 'the shell must not send a request for a blank body');

    // The backend refuses the same blank body on its own.
    const backendBlank = await harness.productApi('POST', '/api/engine/memories', { text: '   ', scopeType: 'global', scopeId: 'brain-default', brainId: 'brain-default' });
    assert.equal(backendBlank.status, 400, `the engine refuses a blank body: ${JSON.stringify(backendBlank.body)}`);
    assert.equal(backendBlank.body.error, 'INVALID_ARGUMENT', 'the engine reports an invalid argument');
    assert.match(String(backendBlank.body.message), /记忆内容必须为 1–2000 个字符。/, 'the engine names the length rule');

    const afterBlank = await harness.productMemories();
    assert.deepEqual(afterBlank, [], 'a refused blank body creates no memory at all');
    if (harness.evidence) await harness.browser.screenshot(path.join(harness.evidence, 'mem002-blank-refused.png'));

    evidence.push({
      case: 'MEM-002',
      frontEnd: { feedback, requestsSent: postsAfter - postsBefore },
      backEnd: { status: backendBlank.status, body: backendBlank.body },
      memoriesAfter: afterBlank.length,
    });

    // ---------------------------------------------------------------- MEM-001
    // The same dialog now carries a real body. The rejected submit left the
    // focus on the confirm button, so the real user clicks back into the field.
    await harness.nativeClick('#memoryText');
    await harness.pressBackspace(3);
    await harness.typeText(MEMORY_TEXT);
    const body = await harness.run("document.getElementById('memoryText').value");
    assert.equal(body, MEMORY_TEXT, 'the real body reached the textarea');

    await harness.nativeClick('#confirmMemory');
    await harness.waitFor(
      () => harness.run("document.getElementById('memoryDialog').open === false"),
      'the dialog closes after a confirmed save',
      15000,
    );

    const post = harness.network.find(entry => entry.method === 'POST' && entry.url.includes('/api/engine/memories')).pop();
    assert.ok(post, 'the shell really posted a memory');
    assert.equal(post.status, 200, `the real POST answers 200: ${JSON.stringify(post.body)}`);
    const postBody = await harness.network.body(post);
    assert.ok(postBody && postBody.memory, `the real POST answers with the memory: ${JSON.stringify(postBody)}`);
    const created = postBody.memory;
    assert.equal(created.status, 'confirmed', 'the memory is saved as confirmed');
    assert.equal(created.sourceType, 'manual', 'a manual memory has no model source');
    assert.equal(created.evidence, null, 'a manual memory invents no evidence');
    assert.equal(created.text, MEMORY_TEXT, 'the saved text is the text that was typed');
    assert.equal(created.scopeType, 'project', 'the default scope of an active project is the project itself');
    assert.equal(created.scopeId, projectId, 'the scope target is the active project');
    assert.ok(created.id, 'the memory has an id');

    // The memory is listed in the real UI.
    await harness.waitFor(
      () => harness.run(`document.getElementById('memoryContent').textContent.includes(${JSON.stringify(MEMORY_TEXT)})`),
      'the new memory is listed',
      15000,
    );
    if (harness.evidence) await harness.browser.screenshot(path.join(harness.evidence, 'mem001-confirmed.png'));

    // The memory file really holds the memory.
    const brainScope = harness.brainScopePath();
    const memoryFile = path.join(brainScope, 'memories', 'projects', `${projectId}.md`);
    assert.ok(fs.existsSync(memoryFile), `the memory file exists: ${memoryFile}`);
    const fileText = fs.readFileSync(memoryFile, 'utf8');
    assert.ok(fileText.includes(created.id), 'the memory file names the memory');
    assert.ok(fileText.includes(MEMORY_TEXT), 'the memory file holds the text');
    assert.match(fileText, /来源：手动添加（用户确认）/, 'the memory file records the manual source');

    // A confirmed, applicable memory is injected into the task.
    const injected = await harness.injectedMemories(projectId);
    assert.ok(injected.some(memory => memory.memoryId === created.id), `the confirmed memory is injected: ${JSON.stringify(injected)}`);

    // 刷新后保留: a real reload of the real page.
    await harness.reload();
    await harness.waitFor(
      () => harness.run(`document.getElementById('memoryContent').textContent.includes(${JSON.stringify(MEMORY_TEXT)})`),
      'the memory is still listed after a real reload',
      25000,
    );
    if (harness.evidence) await harness.browser.screenshot(path.join(harness.evidence, 'mem001-after-reload.png'));
    const afterReload = await harness.productMemories();
    const kept = afterReload.find(memory => memory.id === created.id);
    assert.ok(kept, 'the memory survives the reload');
    assert.equal(kept.status, 'confirmed', 'the memory is still confirmed after the reload');
    assert.equal(kept.text, MEMORY_TEXT, 'the memory text survives the reload');
    assert.equal(kept.scopeType, 'project', 'the scope survives the reload');
    assert.equal(kept.scopeId, projectId, 'the scope target survives the reload');
    assert.equal(kept.syncStatus, 'ready', 'the memory file is in sync');

    evidence.push({
      case: 'MEM-001',
      request: { method: post.method, url: post.url.replace(harness.base, ''), status: post.status, request: post.body, response: postBody },
      memoryFile: { path: memoryFile, sha256: require('node:crypto').createHash('sha256').update(fileText).digest('hex') },
      afterReload: kept,
      injected: injected.map(memory => memory.memoryId),
    });

    assert.equal(harness.browser.exceptions.length, 0, `no uncaught product JavaScript exceptions: ${JSON.stringify(harness.browser.exceptions)}`);

    if (harness.evidence) {
      fs.mkdirSync(harness.evidence, { recursive: true });
      fs.writeFileSync(path.join(harness.evidence, 'mem001-manual.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
    }

    console.log(`parallel-memory-manual-test PASS (MEM-001 confirmed + survives a real reload; MEM-002 refused by the shell without a request and by the engine with 400)`);
  } finally {
    await harness.cleanup();
  }
}

main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
