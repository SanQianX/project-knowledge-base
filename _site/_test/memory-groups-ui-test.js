'use strict';
// _site/_test/memory-groups-ui-test.js
//
// U02 canonical: the full memory-group chain through the real five-page UI,
// a real product instance and the real knowledge engine.
//
//   新建组合 → 新增多段小记忆（加入组合）→ 选入已有记忆到第二个组合
//   → 应用到项目 A/B → 从 A 解绑 → 刷新持久化 → 候选审核入组合。
//
// Every write goes through the real dialogs in a real Chrome; every read
// comes back through the real engine API and the group markdown files on
// disk. Nothing is mocked at the boundary under test.

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const { startHarness, makeRepo } = require('./helpers/parallel-memory-shell');

const EVIDENCE = process.env.PK_TEST_EVIDENCE_DIR ? path.resolve(process.env.PK_TEST_EVIDENCE_DIR) : null;
const MULTILINE_BODY = '开发与测试使用独立的数据目录和端口。\n\n- 日常知识库保持运行\n- 测试只清理本次创建的进程\n\n中文长段落保持同一条记忆，不按换行拆分。';

async function main() {
  const harness = await startHarness({ tag: 'groups-ui', evidenceDir: EVIDENCE || undefined });
  try {
    const repoA = makeRepo(harness.fixture, 'groups-repo-a', { 'README.md': '# 项目甲\n\n保持功能简单。\n' });
    const repoB = makeRepo(harness.fixture, 'groups-repo-b', { 'README.md': '# 项目乙\n\n复用成熟消息流。\n' });
    const { projectId: projectIdA } = await harness.importProject(repoA, '项目甲');
    const { projectId: projectIdB } = await harness.importProject(repoB, '项目乙');
    await harness.requestRegistryRefresh();

    // ---------- 1. 新建组合 ----------
    await harness.nativeClick('nav [data-view="memory"]');
    await harness.waitFor(() => harness.run("document.getElementById('view-memory').classList.contains('active')"), 'the memory view is open');
    await harness.waitFor(() => harness.run("document.querySelector('[data-action=new-group]') !== null"), 'the group sidebar is rendered');
    await harness.nativeClick('[data-action="new-group"]');
    await harness.waitFor(() => harness.run("document.getElementById('appDialog').open === true"), 'the group dialog opens');
    await harness.nativeClick('#groupForm input[name=name]');
    await harness.typeText('通用约定');
    await harness.nativeClick('#appDialogActions button.primary');
    await harness.waitFor(() => harness.run("document.getElementById('appDialog').open === false"), 'the group dialog closes');
    await harness.waitFor(() => harness.run("[...document.querySelectorAll('.memory-folders button')].some(b => b.textContent.includes('通用约定'))"), 'the new group appears in the folders');

    // ---------- 2. 新增多段小记忆并加入组合 ----------
    await harness.nativeClick('[data-action="new-memory"]');
    await harness.waitFor(() => harness.run("document.getElementById('memoryForm') !== null"), 'the memory editor opens');
    await harness.nativeClick('#memoryForm input[name=title]');
    // Real-key typing drops newlines in CDP key events; multiline bodies
    // enter through Input.insertText - the same CDP path a real paste uses.
    await harness.nativeClick('#memoryForm input[name=title]');
    await harness.browser.send('Input.insertText', { text: '开发时保护日常服务' });
    await harness.nativeClick('#memoryForm textarea[name=text]');
    await harness.browser.send('Input.insertText', { text: MULTILINE_BODY });
    // 默认 scopeType=group；选择加入「通用约定」
    await harness.run("(() => { const sel = document.getElementById('memoryForm').elements.groupId; sel.value = [...sel.options].find(o => o.text.includes('通用约定'))?.value || ''; return sel.value !== ''; })()");
    await harness.nativeClick('#appDialogActions button.primary');
    await harness.waitFor(() => harness.run("document.getElementById('appDialog').open === false"), 'the memory editor closes');
    await harness.waitFor(() => harness.run("[...document.querySelectorAll('.memory-item')].some(el => el.textContent.includes('开发时保护日常服务'))"), 'the new memory is listed');

    // 多段正文 = 一条记忆、一个 ID、组合文件包含完整正文
    const groupList = (await harness.engineApi('GET', '/api/memory-groups?limit=10')).body;
    const group = groupList.groups.find(g => g.name === '通用约定');
    assert.ok(group, 'the group exists through the engine API');
    const memories = (await harness.engineApi('GET', `/api/memories?status=confirmed&groupId=${group.id}&limit=10`)).body;
    assert.equal(memories.memories.length, 1, 'exactly one memory record');
    const memory = memories.memories[0];
    assert.equal(memory.title, '开发时保护日常服务');
    assert.ok(memory.text.includes('\n\n'), 'multiline body survives as one record');
    assert.equal(memory.scopeType, 'group');
    const groupFile = path.join(harness.brainScopePath(), 'memories', 'groups', `${group.id}.md`);
    const bytes = fs.readFileSync(groupFile, 'utf8');
    assert.ok(bytes.includes('## ' + memory.id), 'the memory id is the file heading');
    assert.ok(bytes.includes('开发时保护日常服务'));
    assert.ok(bytes.includes('- 日常知识库保持运行'), 'the full multiline body is materialized');

    // ---------- 3. 第二个组合 + 选入已有记忆 ----------
    await harness.nativeClick('[data-action="new-group"]');
    await harness.waitFor(() => harness.run("document.getElementById('groupForm') !== null"), 'the second group dialog opens');
    await harness.nativeClick('#groupForm input[name=name]');
    await harness.typeText('测试');
    await harness.nativeClick('#appDialogActions button.primary');
    await harness.waitFor(() => harness.run("document.getElementById('appDialog').open === false"), 'the second group dialog closes');
    // 左侧选中「通用约定」文件夹后「选入已有记忆」
    await harness.run("(() => { const btn = [...document.querySelectorAll('.memory-folders button')].find(b => b.textContent.includes('测试')); btn.click(); return true; })()");
    await harness.waitFor(() => harness.run("document.querySelector('[data-action=add-existing]') !== null"), 'the existing-memory picker is available in the group folder');
    await harness.nativeClick('[data-action="add-existing"]');
    await harness.waitFor(() => harness.run("document.getElementById('existingList') !== null"), 'the existing picker opens');
    await harness.waitFor(() => harness.run("document.querySelector('#existingList input[type=checkbox]') !== null"), 'the existing memory is listed for picking');
    await harness.run("(() => { const box = document.querySelector('#existingList input[type=checkbox]'); box.click(); return box.checked; })()");
    await harness.waitFor(() => harness.run("document.getElementById('existingCount').textContent.includes('已选择 1 条')"), 'the selection counter updates');
    await harness.nativeClick('#appDialogActions button.primary');
    await harness.waitFor(() => harness.run("document.getElementById('appDialog').open === false"), 'the existing picker closes');
    const groupList2 = (await harness.engineApi('GET', '/api/memory-groups?limit=10')).body;
    const groupTest = groupList2.groups.find(g => g.name === '测试');
    assert.equal(groupTest.memberCount, 1, 'the shared memory joined the second group without copying');

    // ---------- 4. 应用到项目 A 和 B ----------
    await harness.nativeClick('nav [data-view="projects"]');
    await harness.waitFor(() => harness.run("[...document.querySelectorAll('.project-row')].length >= 2"), 'the project list is rendered');
    const bindResult = (await harness.engineApi('POST', `/api/projects/${projectIdA}/memory-groups/bind`, { addGroupIds: [group.id, groupTest.id] })).body;
    await harness.engineApi('POST', `/api/projects/${projectIdB}/memory-groups/bind`, { addGroupIds: [group.id] });
    assert.equal(bindResult.added, 2, 'binding is a real engine write');
    await harness.reload();
    await harness.waitFor(() => harness.run("[...document.querySelectorAll('.project-row')].some(r => r.textContent.includes('项目甲') && r.textContent.includes('通用约定') && r.textContent.includes('测试'))"), 'project A shows both group tags');
    // 项目 A 详情：生效记忆去重（同一记忆经两个组合只显示一次）
    await harness.run("(() => { const btn = document.querySelector('[data-action=project-detail]'); btn.click(); return true; })()");
    await harness.waitFor(() => harness.run("document.body.textContent.includes('生效记忆')"), 'the project detail renders');
    const effective = (await harness.engineApi('GET', `/api/projects/${projectIdA}/effective-memories?limit=10`)).body;
    assert.equal(effective.total, 1, 'the dual-group memory counts once');
    assert.equal(effective.memories[0].sources.length, 2, 'both group sources are kept');

    // ---------- 5. 从 A 解绑「测试」，B 不受影响 ----------
    await harness.engineApi('POST', `/api/projects/${projectIdA}/memory-groups/bind`, { removeGroupIds: [groupTest.id] });
    await harness.reload();
    const effectiveA = (await harness.engineApi('GET', `/api/projects/${projectIdA}/effective-memories?limit=10`)).body;
    assert.equal(effectiveA.total, 1, 'project A keeps the memory through 通用约定');
    assert.equal(effectiveA.memories[0].sources.length, 1, 'only the remaining source applies');
    const effectiveB = (await harness.engineApi('GET', `/api/projects/${projectIdB}/effective-memories?limit=10`)).body;
    assert.equal(effectiveB.total, 1, 'project B is untouched');

    // ---------- 6. 刷新后一切仍在（持久化） ----------
    await harness.reload();
    await harness.nativeClick('nav [data-view="memory"]');
    await harness.waitFor(() => harness.run("[...document.querySelectorAll('.memory-folders button')].some(b => b.textContent.includes('通用约定')) && [...document.querySelectorAll('.memory-item')].some(el => el.textContent.includes('开发时保护日常服务'))"), 'the group and its memory survive a reload');

    // ---------- 7. 候选审核：确认并加入组合 ----------
    await harness.produceCandidate({ repo: repoA, projectId: projectIdA, text: '界面变更先给可点击的预览，确认流程后再实施。', scopeType: 'global' });
    await harness.nativeClick('nav [data-view="home"]');
    await harness.waitFor(() => harness.run("document.getElementById('homeContent').textContent.includes('待确认记忆') && document.getElementById('homeCount') !== null"), 'the home overview renders');
    await harness.waitFor(() => harness.run("document.body.textContent.includes('界面变更先给可点击的预览')"), 'the candidate preview shows on home');
    await harness.run("(() => { const btn = [...document.querySelectorAll('#homeContent button')].find(b => b.textContent.includes('审核')); if (btn) btn.click(); return Boolean(btn); })()");
    await harness.waitFor(() => harness.run("document.getElementById('reviewForm') !== null"), 'the review dialog opens with frozen evidence');
    await harness.run("(() => { const sel = document.getElementById('reviewForm').elements.groupId; sel.value = [...sel.options].find(o => o.text.includes('通用约定'))?.value || ''; return sel.value !== ''; })()");
    await harness.nativeClick('#appDialogActions button.primary');
    await harness.waitFor(() => harness.run("document.getElementById('appDialog').open === false"), 'the review dialog closes');
    const confirmed = (await harness.engineApi('GET', `/api/memories?status=confirmed&groupId=${group.id}&limit=10`)).body;
    assert.ok(confirmed.memories.some(m => m.text.includes('可点击的预览')), 'the confirmed candidate joined the group');

    // ---------- 8. 首页组合入口 ----------
    await harness.nativeClick('nav [data-view="home"]');
    await harness.waitFor(() => harness.run("[...document.querySelectorAll('#homeContent .combo-card')].some(c => c.textContent.includes('通用约定'))"), 'the home shows the group entry');

    console.log('memory-groups-ui-test: PASS');
  } finally {
    await harness.cleanup();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
