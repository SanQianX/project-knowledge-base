'use strict';
// _site/_test/parallel-memory-manual-test.js
//
// MEM-001 手动添加 / MEM-002 空白拒绝.
//
// Every step runs against a real isolated product instance: its own port,
// data dir, knowledge root, Bridge journal home and browser profile, with the
// REAL vendored knowledge engine in-process behind a pass-through proxy. The
// memory is added through the real UI in a real Chrome: a real pointer click
// opens the dialog, a real paste (CDP Input.insertText, the same path a real
// paste takes) fills the content, a real pointer click submits it.
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
//
// 迁移说明（五页简化 UI，见 patches/ui-test-mapping-spec.md）：
//   * 添加记忆入口：#addMemory → 记忆库 tab 头部
//     #memoryContent [data-action="new-memory"]；「引擎可达」等待从
//     「#addMemory 未禁用」等价为「[data-action="new-memory"] 已渲染」
//     （engineAvailable 为 false 时 renderMemories 只渲染离线横幅）。
//   * 添加对话框：#memoryDialog/#memoryText/#confirmMemory → #appDialog 内
//     #memoryForm（标题 input[name="title"]（新契约必填）+ 正文
//     textarea[name="text"]），提交 = #appDialogActions button.primary
//     （type=submit 关联 #memoryForm）。标题/正文都用 CDP
//     Input.insertText（真实粘贴路径）录入。
//   * MEM-002 空白拒绝：新编辑器靠原生 required——空标题+空正文时点击提交
//     不触发 submit、不发请求、对话框保持打开（等 1.5s 仍 open + POST 计数
//     不变）；仅空格正文能穿过原生 required（值非空），由 shell 的提交处理
//     器拦下，等价旧 #memoryFeedback 的 #appDialogFeedback 报
//     「请填写标题和记忆内容。」，同样不发请求。
//   * 引擎空白拒绝保持（400 INVALID_ARGUMENT / 记忆内容必须为 1–N 个字符）；
//     N 随引擎版本由 2000 变为 8000（MEMORY_TEXT_LIMIT），断言语义不变。
//   * 旧 UI 的默认作用域=当前项目；新表单默认=组合记忆。MEM-001 的「项目
//     作用域存储」语义保持：在表单里显式选择 适用范围=项目 +
//     适用目标=当前项目（#memoryForm select[name="scopeType"] 与
//     [data-role="scope-target"] select[name="scopeTarget"]），存储的
//     scopeType/scopeId 另用 engineApi GET /api/memories 复核。
//   * 「导入项目已列出」等待：旧首页项目面板（homeContent 含项目名）已删除，
//     等价为顶栏 #projectSelect 选项里出现项目名（同一 registry projection）。
//   * 其余引擎断言（POST 200、confirmed/manual/evidence null、磁盘记忆文件
//     memories/projects/<projectId>.md 与「来源：手动添加（用户确认）」、
//     注入门 /api/context、真实 reload 后保留、syncStatus=ready）保持不变。

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const { startHarness, makeRepo } = require('./helpers/parallel-memory-shell');

const EVIDENCE = process.env.PK_TEST_EVIDENCE_DIR ? path.resolve(process.env.PK_TEST_EVIDENCE_DIR) : null;
const MEMORY_TITLE = '对外表述约定';
const MEMORY_TEXT = '对外错误信息使用中文表述，并优先复用已有模块。';

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

async function main() {
  const harness = await startHarness({ tag: 'mem001', evidenceDir: EVIDENCE || undefined });
  const evidence = [];
  try {
    const repo = makeRepo(harness.fixture, 'mem001-repo', { 'README.md': '# 记忆甲\n' });
    const { projectId } = await harness.importProject(repo, '记忆甲');

    // The shell has to know the project before it can bind a project scope.
    await harness.requestRegistryRefresh();
    // The new home page no longer lists projects; the registry projection is
    // surfaced by the topbar project selector instead.
    await harness.waitFor(
      () => harness.run("document.getElementById('projectSelect').textContent.includes('记忆甲')"),
      'the imported project is listed',
      20000,
    );

    await openMemoryView(harness);
    await harness.waitFor(
      () => harness.run("document.querySelector('#memoryContent [data-action=\"new-memory\"]') !== null"),
      'the engine is reachable and the add action is live',
      20000,
    );

    // ---------------------------------------------------------------- MEM-002
    await harness.nativeClick('#memoryContent [data-action="new-memory"]');
    await harness.waitFor(
      () => harness.run("document.getElementById('appDialog').open === true && document.getElementById('memoryForm') !== null"),
      'the add dialog with the memory form is open',
      10000,
    );

    // Native required: an empty title AND an empty body never even submit —
    // the browser blocks the form-associated submit button, so no request
    // leaves the page and the dialog stays open.
    const postsBeforeEmpty = harness.network.find(entry => entry.method === 'POST' && entry.url.includes('/api/engine/memories')).length;
    await harness.nativeClick('#appDialogActions button.primary');
    await harness.wait(1500);
    assert.equal(
      await harness.run("document.getElementById('appDialog').open === true && document.getElementById('memoryForm') !== null"),
      true,
      'the native required check keeps the dialog open for an empty form',
    );
    assert.equal(
      await harness.run("document.getElementById('appDialogFeedback').hidden === true"),
      true,
      'no submit ever ran, so the dialog feedback stays hidden',
    );
    assert.equal(
      harness.network.find(entry => entry.method === 'POST' && entry.url.includes('/api/engine/memories')).length,
      postsBeforeEmpty,
      'the empty form sends no request at all',
    );

    // A whitespace-only body passes the native required check (the value is
    // not empty) and is then refused by the shell's own submit handler, which
    // names the missing content exactly like the old #memoryFeedback did.
    await harness.nativeClick('#memoryForm input[name="title"]');
    await harness.browser.send('Input.insertText', { text: MEMORY_TITLE });
    await harness.nativeClick('#memoryForm textarea[name="text"]');
    await harness.browser.send('Input.insertText', { text: '   ' });
    const typed = await harness.run("document.getElementById('memoryForm').elements.text.value");
    assert.equal(typed, '   ', 'the blank body really reached the textarea');

    const postsBefore = harness.network.find(entry => entry.method === 'POST' && entry.url.includes('/api/engine/memories')).length;
    await harness.nativeClick('#appDialogActions button.primary');
    await harness.waitFor(
      () => harness.run("document.getElementById('appDialogFeedback').hidden === false"),
      'the shell refuses the blank body in the dialog',
      10000,
    );
    const feedback = await harness.run("document.getElementById('appDialogFeedback').textContent");
    assert.match(String(feedback), /请填写标题和记忆内容。/, 'the shell names the missing content');
    assert.equal(
      await harness.run("document.getElementById('appDialog').open === true"),
      true,
      'the refused dialog stays open',
    );
    const postsAfter = harness.network.find(entry => entry.method === 'POST' && entry.url.includes('/api/engine/memories')).length;
    assert.equal(postsAfter, postsBefore, 'the shell must not send a request for a blank body');

    // The backend refuses the same blank body on its own.
    const backendBlank = await harness.productApi('POST', '/api/engine/memories', { text: '   ', scopeType: 'global', scopeId: 'brain-default', brainId: 'brain-default' });
    assert.equal(backendBlank.status, 400, `the engine refuses a blank body: ${JSON.stringify(backendBlank.body)}`);
    assert.equal(backendBlank.body.error, 'INVALID_ARGUMENT', 'the engine reports an invalid argument');
    assert.match(String(backendBlank.body.message), /记忆内容必须为 1–8000 个字符。/, 'the engine names the length rule (MEMORY_TEXT_LIMIT is 8000 in the current engine)');
    const backendBlankEngine = await harness.engineApi('POST', '/api/memories', { text: '   ', scopeType: 'global', scopeId: 'brain-default', brainId: 'brain-default' });
    assert.equal(backendBlankEngine.status, 400, `the engine behind the proxy refuses it too: ${JSON.stringify(backendBlankEngine.body)}`);

    const afterBlank = await harness.productMemories();
    assert.deepEqual(afterBlank, [], 'a refused blank body creates no memory at all');
    if (harness.evidence) await harness.browser.screenshot(path.join(harness.evidence, 'mem002-blank-refused.png'));

    evidence.push({
      case: 'MEM-002',
      frontEnd: {
        nativeRequiredBlockedEmptyForm: true,
        feedback,
        requestsSent: postsAfter - postsBefore,
      },
      backEnd: { status: backendBlank.status, body: backendBlank.body },
      memoriesAfter: afterBlank.length,
    });

    // ---------------------------------------------------------------- MEM-001
    // The same dialog now carries a real body. The refused submit left the
    // focus on the submit button, so the real user clicks back into the field.
    await harness.nativeClick('#memoryForm textarea[name="text"]');
    await harness.pressBackspace(3);
    await harness.browser.send('Input.insertText', { text: MEMORY_TEXT });
    const body = await harness.run("document.getElementById('memoryForm').elements.text.value");
    assert.equal(body, MEMORY_TEXT, 'the real body reached the textarea');

    // The old UI defaulted a manual add to the active project's scope; the new
    // form defaults to a group memory, so the project-scope semantics are
    // chosen explicitly through the real selects.
    await harness.selectOption('#memoryForm select[name="scopeType"]', 'project');
    await harness.waitFor(
      () => harness.run("document.querySelector('#memoryForm [data-role=\"scope-target\"]').hidden === false"),
      'the project scope target select is shown',
      10000,
    );
    const targetOptions = await harness.run("Array.from(document.querySelector('#memoryForm [data-role=\"scope-target\"] select[name=\"scopeTarget\"]').options).map(o => o.value)");
    assert.ok(targetOptions.includes(projectId), `the project scope offers ${projectId}: ${JSON.stringify(targetOptions)}`);
    await harness.selectOption('#memoryForm [data-role="scope-target"] select[name="scopeTarget"]', projectId);

    const postsBeforeSave = harness.network.find(entry => entry.method === 'POST' && entry.url.includes('/api/engine/memories')).length;
    await harness.nativeClick('#appDialogActions button.primary');
    await harness.waitFor(
      () => harness.run("document.getElementById('appDialog').open === false"),
      'the dialog closes after a confirmed save',
      15000,
    );

    const post = harness.network.find(entry => entry.method === 'POST' && entry.url.includes('/api/engine/memories'))[postsBeforeSave];
    assert.ok(post, 'the shell really posted a memory');
    assert.equal(post.status, 200, `the real POST answers 200: ${JSON.stringify(post.body)}`);
    const postBody = await harness.network.body(post);
    assert.ok(postBody && postBody.memory, `the real POST answers with the memory: ${JSON.stringify(postBody)}`);
    const created = postBody.memory;
    assert.equal(created.status, 'confirmed', 'the memory is saved as confirmed');
    assert.equal(created.sourceType, 'manual', 'a manual memory has no model source');
    assert.equal(created.evidence, null, 'a manual memory invents no evidence');
    assert.equal(created.text, MEMORY_TEXT, 'the saved text is the text that was typed');
    assert.equal(created.title, MEMORY_TITLE, 'the saved title is the title that was typed');
    assert.equal(created.scopeType, 'project', 'the chosen scope of the manual memory is the project');
    assert.equal(created.scopeId, projectId, 'the scope target is the active project');
    assert.ok(created.id, 'the memory has an id');

    // The engine's own record confirms the stored scope pair.
    const engineRecord = (await harness.engineApi('GET', '/api/memories')).body.memories.find(memory => memory.id === created.id);
    assert.ok(engineRecord, 'the engine really stored the memory');
    assert.equal(engineRecord.scopeType, 'project', 'the engine stores the project scope type');
    assert.equal(engineRecord.scopeId, projectId, 'the engine stores the active project as the scope target');
    assert.equal(engineRecord.status, 'confirmed', 'the engine stores the memory as confirmed');

    // The memory is listed in the real UI (the 记忆库 tab lists confirmed
    // memories; the card shows the title and the clamped body).
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
    await openMemoryView(harness);
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
      engineRecord: { id: engineRecord.id, scopeType: engineRecord.scopeType, scopeId: engineRecord.scopeId, status: engineRecord.status },
      afterReload: kept,
      injected: injected.map(memory => memory.memoryId),
    });

    assert.equal(harness.browser.exceptions.length, 0, `no uncaught product JavaScript exceptions: ${JSON.stringify(harness.browser.exceptions)}`);

    if (harness.evidence) {
      fs.mkdirSync(harness.evidence, { recursive: true });
      fs.writeFileSync(path.join(harness.evidence, 'mem001-manual.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
    }

    console.log(`parallel-memory-manual-test PASS (MEM-001 confirmed with an explicit project scope + survives a real reload; MEM-002 refused by native required and by the shell without a request, and by the engine with 400)`);
  } finally {
    await harness.cleanup();
  }
}

main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
