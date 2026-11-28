'use strict';
// tests/parallel-memory-scope-test.js

// MEM-004。组合选择、生效矩阵和磁盘投影。 / Verify combination selection, visibility and Markdown projection.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { startHarness, makeRepo } = require('./helpers/parallel-memory-shell');

async function addMemoryViaUi(harness, text, groupId) {
  await harness.nativeClick('#memoryContent [data-action="new-memory"]');
  await harness.waitFor(() => harness.run("Boolean(document.getElementById('memoryForm') && document.getElementById('appDialog').open)"), 'the editor opens');
  assert.equal(await harness.run("Boolean(document.querySelector('#memoryForm [name=scopeType], #memoryForm [name=scopeTarget]'))"), false);
  await harness.nativeClick('#memoryForm input[name="title"]');
  await harness.browser.send('Input.insertText', { text });
  await harness.nativeClick('#memoryForm textarea[name="text"]');
  await harness.browser.send('Input.insertText', { text });
  const choices = await harness.run("[...document.querySelector('#memoryForm select[name=groupId]').options].map(o => o.value)");
  assert.ok(choices.includes(groupId), 'group selector options: ' + JSON.stringify(choices));
  await harness.selectOption('#memoryForm select[name="groupId"]', groupId);
  await harness.nativeClick('#appDialogActions button.primary');
  await harness.waitFor(() => harness.run("!document.getElementById('appDialog').open"), 'the memory saves');

  const post = harness.network.find(entry => entry.method === 'POST' && entry.url.includes('/api/engine/memories')).at(-1);
  assert.equal(post.status, 200);
  assert.deepEqual(post.body, { title: text, text, injectionPolicy: 'auto', brainId: 'brain-default', groupId });
  const { memory } = await harness.network.body(post);
  assert.equal(memory.status, 'confirmed');
  assert.equal(memory.injectionPolicy, 'auto');
  assert.deepEqual(memory.groups.map(item => item.id), [groupId]);
  return memory;
}

async function main() {
  const evidenceDir = process.env.PK_TEST_EVIDENCE_DIR && path.resolve(process.env.PK_TEST_EVIDENCE_DIR);
  const harness = await startHarness({ tag: 'memscope', evidenceDir: evidenceDir || undefined });
  try {
    const domain = await harness.addDomain('平台领域');
    const projects = [];
    for (const label of ['甲', '乙', '丙']) {
      const repo = makeRepo(harness.fixture, 'memscope-' + projects.length);
      const { projectId } = await harness.importProject(repo, '范围' + label, label === '丙' ? {} : { domainId: domain.id });
      projects.push(projectId);
    }
    const groups = [
      await harness.addGroup('错误文案', projects),
      await harness.addGroup('发布回归', [projects[0], projects[2]]),
      await harness.addGroup('数据库迁移', [projects[1]]),
    ];
    await harness.requestRegistryRefresh();
    await harness.nativeClick('nav [data-view="memory"]');
    await harness.waitFor(() => harness.run("Boolean(document.querySelector('#memoryContent [data-action=new-memory]'))"), 'the memory library is ready');

    const memories = [
      await addMemoryViaUi(harness, '所有对外错误信息使用中文。', groups[0].id),
      await addMemoryViaUi(harness, '发布前必须运行完整回归。', groups[1].id),
      await addMemoryViaUi(harness, '数据库迁移脚本放在指定目录。', groups[2].id),
    ];
    const rejected = [];
    for (const [scopeType, scopeId] of [['global', 'brain-default'], ['domain', domain.id], ['project', projects[0]]]) {
      const response = await harness.productApi('POST', '/api/engine/memories', { text: '旧作用域写入', scopeType, scopeId });
      assert.equal(response.status, 400);
      assert.equal(response.body.error, 'INVALID_ARGUMENT');
      rejected.push(scopeType);
    }

    const expected = [[memories[0].id, memories[1].id], [memories[0].id, memories[2].id], [memories[0].id, memories[1].id]];
    const injected = [];
    for (const [index, id] of projects.entries()) {
      const memoryIds = (await harness.injectedMemories(id)).map(memory => memory.memoryId).sort();
      assert.deepEqual(memoryIds, [...expected[index]].sort());
      injected.push(memoryIds);
    }
    const root = path.join(harness.brainScopePath(), 'memories');
    for (const relative of ['confirmed.md', 'domains', 'projects']) assert.equal(fs.existsSync(path.join(root, relative)), false);
    for (const [index, group] of groups.entries()) {
      const content = fs.readFileSync(path.join(root, 'groups', group.id + '.md'), 'utf8');
      assert.ok(content.includes(memories[index].id));
      assert.ok(memories.every((item, offset) => offset === index || !content.includes(item.id)));
    }

    await harness.reload();
    await harness.nativeClick('nav [data-view="memory"]');
    await harness.waitFor(() => harness.run("document.querySelectorAll('#memoryContent .memory-item').length === 3"), 'the saved records reload');
    const cards = await harness.run("[...document.querySelectorAll('#memoryContent .memory-item')].map(el => el.textContent)");
    for (const [index, memory] of memories.entries()) {
      const card = cards.find(text => text.includes(memory.title));
      assert.ok(card?.includes(groups[index].name));
      assert.doesNotMatch(card, /全局记忆|领域记忆|项目记忆/);
    }
    assert.deepEqual(harness.browser.exceptions, []);
    await harness.browser.screenshot(path.join(harness.evidence, 'mem004-combinations.png'));
    fs.writeFileSync(path.join(harness.evidence, 'mem004-scope.json'), JSON.stringify([{ case: 'MEM-004', projects, groups, injected, rejected }], null, 2));
    console.log('parallel-memory-scope-test PASS (MEM-004 combination boundaries)');
  } finally {
    await harness.cleanup();
  }
}

main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
