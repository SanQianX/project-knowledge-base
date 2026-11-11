'use strict';
// _site/_test/parallel-memory-scope-test.js
//
// MEM-004 确认目标（适用范围）.
//
// Real isolated product instance, real browser, real HTTP and real disk. Three
// real projects are imported into one real brain: two of them belong to a real
// domain, the third belongs to none. Three real memories are added through the
// real UI: one global, one bound to the domain, one bound to a single project.
//
// MEM-004 expected:
//   * scopeId与scopeType匹配。 -> the stored memory carries the scope id that
//                                 belongs to its scope type, the UI only offers
//                                 targets of that type, and the engine refuses
//                                 a scope id that does not belong to the
//                                 declared scope type;
//   * 只影响指定范围。           -> a global memory reaches every project, a
//                                 domain memory only reaches the projects of
//                                 that domain, a project memory only reaches
//                                 that project.
//
// 迁移说明（五页简化 UI，见 patches/ui-test-mapping-spec.md）：
//   * 添加记忆：#addMemory/#memoryDialog → #memoryContent
//     [data-action="new-memory"] → #appDialog 内 #memoryForm。新契约要求标题
//     （input[name="title"]，本测试以记忆正文为标题）与正文
//     （textarea[name="text"]），均用 CDP Input.insertText（真实粘贴路径）
//     录入；提交 = #appDialogActions button.primary。
//   * 适用范围：#memoryScope → #memoryForm select[name="scopeType"]（新表单
//     默认 group，global/domain/project 需显式选择，选择后 change 触发
//     fillTargets）；适用目标：#memoryTarget →
//     #memoryForm [data-role="scope-target"] select[name="scopeTarget"]
//     （仅 domain/project 显示；「UI 只提供该类型的目标」断言保持为读取
//     该 select 的 options）。
//   * scope 存储语义断言保持：POST 响应 scopeType/scopeId + 新增 engineApi
//     GET /api/memories 复核引擎存储的 scopeType/scopeId。
//   * 引擎侧断言全部不变：错配 scope 的 400 INVALID_ARGUMENT
//     （所选记忆目标不存在或不属于当前智脑。）、注入矩阵
//     （/api/context）、磁盘文件布局（brain 共享目录下 memories/
//     confirmed.md、domains/<domainId>.md、projects/<projectId>.md，领域目录
//     自身无记忆文件）。
//   * 「导入项目已列出」等待：旧首页项目面板已删除 → 顶栏 #projectSelect。
//   * 作用域标签断言：旧 confirmed tab 的 [data-memory-card] → library tab
//     （[data-memory-tab="library"]）的 .memory-item（卡片第三行仍标注
//     全局记忆/领域记忆/项目记忆 与目标名称）。

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const { startHarness, makeRepo } = require('./helpers/parallel-memory-shell');

const EVIDENCE = process.env.PK_TEST_EVIDENCE_DIR ? path.resolve(process.env.PK_TEST_EVIDENCE_DIR) : null;
const GLOBAL_TEXT = '全局约定：所有对外错误信息使用中文表述。';
const DOMAIN_TEXT = '平台领域约定：发布流程必须先跑完整回归。';
const PROJECT_TEXT = '项目约定：数据库迁移脚本一律放在 db/migrations。';

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

/**
 * Add one memory through the real UI (new-memory dialog: title + body +
 * explicit scope) and return what the engine answered, cross-checked against
 * the engine's own stored record.
 */
async function addMemoryViaUi(harness, { text, scopeType, scopeId }) {
  await harness.nativeClick('#memoryContent [data-action="new-memory"]');
  await harness.waitFor(
    () => harness.run("document.getElementById('appDialog').open === true && document.getElementById('memoryForm') !== null"),
    'the add dialog with the memory form is open',
    10000,
  );
  // The new contract requires a title; the memory text doubles as its title.
  await harness.nativeClick('#memoryForm input[name="title"]');
  await harness.browser.send('Input.insertText', { text });
  await harness.nativeClick('#memoryForm textarea[name="text"]');
  await harness.browser.send('Input.insertText', { text });
  await harness.selectOption('#memoryForm select[name="scopeType"]', scopeType);
  if (scopeType !== 'global') {
    await harness.waitFor(
      () => harness.run("document.querySelector('#memoryForm [data-role=\"scope-target\"]').hidden === false"),
      `the ${scopeType} scope target select is shown`,
      10000,
    );
    const options = await harness.run("Array.from(document.querySelector('#memoryForm [data-role=\"scope-target\"] select[name=\"scopeTarget\"]').options).map(o => o.value)");
    assert.ok(options.includes(scopeId), `the ${scopeType} scope offers ${scopeId}: ${JSON.stringify(options)}`);
    await harness.selectOption('#memoryForm [data-role="scope-target"] select[name="scopeTarget"]', scopeId);
  }
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
  assert.equal(post.body && post.body.scopeType, scopeType, 'the chosen scope type really travelled with the request');
  if (scopeId) assert.equal(post.body.scopeId, scopeId, 'the chosen scope target really travelled with the request');
  const body = await harness.network.body(post);
  assert.ok(body && body.memory, `the real POST answers with the memory: ${JSON.stringify(body)}`);
  assert.equal(body.memory.text, text, 'the saved text is the text that was typed');
  assert.equal(body.memory.scopeType, scopeType, 'the saved scope type is the chosen one');
  assert.equal(body.memory.scopeId, scopeId || body.memory.brainId, 'the saved scope id belongs to the scope type');
  assert.equal(body.memory.status, 'confirmed', 'the memory is saved as confirmed');
  // The engine's own stored record confirms the scope pair.
  const engineRecord = (await harness.engineApi('GET', '/api/memories')).body.memories.find(memory => memory.id === body.memory.id);
  assert.ok(engineRecord, 'the engine really stored the memory');
  assert.equal(engineRecord.scopeType, scopeType, `the engine stores the ${scopeType} scope type`);
  assert.equal(engineRecord.scopeId, scopeId || engineRecord.brainId, `the engine stores the ${scopeType} scope id`);
  assert.equal(engineRecord.status, 'confirmed', 'the engine stores the memory as confirmed');
  return { memory: body.memory, engineRecord, request: post.body, url: post.url.replace(harness.base, '') };
}

async function main() {
  const harness = await startHarness({ tag: 'memscope', evidenceDir: EVIDENCE || undefined });
  const evidence = [];
  try {
    const domain = await harness.addDomain('平台领域');
    assert.ok(domain.id, 'the real domain has an id');

    const repoA = makeRepo(harness.fixture, 'memscope-a', { 'README.md': '# 甲\n' });
    const repoB = makeRepo(harness.fixture, 'memscope-b', { 'README.md': '# 乙\n' });
    const repoC = makeRepo(harness.fixture, 'memscope-c', { 'README.md': '# 丙\n' });
    const a = await harness.importProject(repoA, '范围甲', { domainId: domain.id });
    const b = await harness.importProject(repoB, '范围乙', { domainId: domain.id });
    const c = await harness.importProject(repoC, '范围丙');

    await harness.requestRegistryRefresh();
    // The new home page no longer lists projects; the registry projection is
    // surfaced by the topbar project selector instead.
    await harness.waitFor(
      () => harness.run("document.getElementById('projectSelect').textContent.includes('范围丙')"),
      'the imported projects are listed',
      20000,
    );

    // The engine really knows the domain binding of every project.
    const engineProjects = (await harness.engineApi('GET', '/api/projects')).body.projects;
    assert.equal(engineProjects.find(p => p.projectId === a.projectId).domainId, domain.id, 'the engine knows the domain of 甲');
    assert.equal(engineProjects.find(p => p.projectId === b.projectId).domainId, domain.id, 'the engine knows the domain of 乙');
    assert.equal(engineProjects.find(p => p.projectId === c.projectId).domainId || null, null, 'the engine knows 丙 has no domain');

    // The UI works on project 甲, the one inside the domain.
    await harness.selectOption('#projectSelect', a.projectId);
    await harness.waitFor(
      () => harness.run("document.getElementById('projectSelect').value === " + JSON.stringify(a.projectId)),
      'the active project is 甲',
      10000,
    );
    await openMemoryView(harness);
    await harness.waitFor(
      () => harness.run("document.querySelector('#memoryContent [data-action=\"new-memory\"]') !== null"),
      'the engine is reachable and the add action is live',
      20000,
    );

    // ---------------------------------------------------------------- MEM-004
    const globalMemory = await addMemoryViaUi(harness, { text: GLOBAL_TEXT, scopeType: 'global' });
    const domainMemory = await addMemoryViaUi(harness, { text: DOMAIN_TEXT, scopeType: 'domain', scopeId: domain.id });
    const projectMemory = await addMemoryViaUi(harness, { text: PROJECT_TEXT, scopeType: 'project', scopeId: a.projectId });

    assert.equal(globalMemory.memory.scopeId, globalMemory.memory.brainId, 'a global memory targets the brain itself');
    assert.equal(domainMemory.memory.scopeId, domain.id, 'a domain memory targets the domain');
    assert.equal(projectMemory.memory.scopeId, a.projectId, 'a project memory targets the project');
    assert.equal(globalMemory.engineRecord.scopeId, globalMemory.engineRecord.brainId, 'the engine stores the global scope against the brain');
    assert.equal(domainMemory.engineRecord.scopeId, domain.id, 'the engine stores the domain scope');
    assert.equal(projectMemory.engineRecord.scopeId, a.projectId, 'the engine stores the project scope');

    // The scope id has to belong to the scope type: the engine refuses the
    // mismatched combinations instead of silently storing them.
    const mismatches = [
      { scopeType: 'domain', scopeId: a.projectId, why: 'a project id is not a domain' },
      { scopeType: 'project', scopeId: domain.id, why: 'a domain id is not a project' },
      { scopeType: 'global', scopeId: a.projectId, why: 'a global memory always targets the brain' },
    ];
    for (const mismatch of mismatches) {
      const refused = await harness.productApi('POST', '/api/engine/memories', { text: `范围不匹配的记忆：${mismatch.why}`, scopeType: mismatch.scopeType, scopeId: mismatch.scopeId });
      assert.equal(refused.status, 400, `the engine refuses ${mismatch.why}: ${JSON.stringify(refused.body)}`);
      assert.equal(refused.body.error, 'INVALID_ARGUMENT', 'the engine reports an invalid argument');
      assert.match(String(refused.body.message), /所选记忆目标不存在或不属于当前智脑。/, 'the engine names the missing target');
    }
    const noMismatch = await harness.productMemories();
    assert.ok(!noMismatch.some(memory => memory.text.startsWith('范围不匹配的记忆')), 'no mismatched memory was stored');

    // 只影响指定范围: the injection matrix.
    const injectedA = await harness.injectedMemories(a.projectId);
    const injectedB = await harness.injectedMemories(b.projectId);
    const injectedC = await harness.injectedMemories(c.projectId);
    const ids = injected => injected.map(entry => entry.memoryId);
    assert.ok(ids(injectedA).includes(globalMemory.memory.id), 'the global memory reaches 甲');
    assert.ok(ids(injectedB).includes(globalMemory.memory.id), 'the global memory reaches 乙');
    assert.ok(ids(injectedC).includes(globalMemory.memory.id), 'the global memory reaches 丙');
    assert.ok(ids(injectedA).includes(domainMemory.memory.id), 'the domain memory reaches 甲');
    assert.ok(ids(injectedB).includes(domainMemory.memory.id), 'the domain memory reaches 乙');
    assert.ok(!ids(injectedC).includes(domainMemory.memory.id), `the domain memory does not reach 丙: ${JSON.stringify(injectedC)}`);
    assert.ok(ids(injectedA).includes(projectMemory.memory.id), 'the project memory reaches 甲');
    assert.ok(!ids(injectedB).includes(projectMemory.memory.id), `the project memory does not reach 乙: ${JSON.stringify(injectedB)}`);
    assert.ok(!ids(injectedC).includes(projectMemory.memory.id), `the project memory does not reach 丙: ${JSON.stringify(injectedC)}`);

    // The real UI names the scope of every memory (the library tab lists the
    // confirmed memories; each .memory-item card names the scope and target).
    await harness.reload();
    await openMemoryView(harness);
    await harness.waitFor(
      () => harness.run("document.querySelector('#memoryContent [data-memory-tab=\"library\"]') !== null"),
      'the memory tab bar is rendered from real data',
      20000,
    );
    await harness.nativeClick('#memoryContent [data-memory-tab="library"]');
    await harness.waitFor(
      () => harness.run(`document.getElementById('memoryContent').textContent.includes(${JSON.stringify(GLOBAL_TEXT)})`),
      'the confirmed memories are listed',
      15000,
    );
    const scopeLabels = await harness.run("Array.from(document.querySelectorAll('#memoryContent .memory-item')).map(el => el.textContent)");
    const globalCard = scopeLabels.find(text => text.includes(GLOBAL_TEXT));
    const domainCard = scopeLabels.find(text => text.includes(DOMAIN_TEXT));
    const projectCard = scopeLabels.find(text => text.includes(PROJECT_TEXT));
    assert.ok(globalCard && domainCard && projectCard, `all three memories have cards: ${JSON.stringify(scopeLabels)}`);
    assert.match(globalCard, /全局/, 'the UI names the global scope');
    assert.match(domainCard, /领域/, 'the UI names the domain scope');
    assert.match(domainCard, new RegExp(domain.name), 'the UI names the domain');
    assert.match(projectCard, /项目/, 'the UI names the project scope');
    assert.match(projectCard, new RegExp('范围甲'), 'the UI names the project');
    if (harness.evidence) await harness.browser.screenshot(path.join(harness.evidence, 'mem004-scopes.png'));

    // The memory files really live in the scope they claim. The engine
    // materializes every scope's memory file in the brain's shared directory:
    // the domain scope directory itself holds no memory file.
    const brainScope = harness.brainScopePath();
    const domainScope = harness.domainScopePath(domain.id);
    assert.ok(fs.existsSync(path.join(brainScope, 'memories', 'confirmed.md')), 'the global memory file exists');
    assert.ok(fs.existsSync(path.join(brainScope, 'memories', 'domains', `${domain.id}.md`)), 'the domain memory file exists');
    assert.ok(fs.existsSync(path.join(brainScope, 'memories', 'projects', `${a.projectId}.md`)), 'the project memory file exists');
    assert.ok(!fs.existsSync(path.join(domainScope, 'memories')), 'the domain scope directory holds no memory file of its own');
    const globalFile = fs.readFileSync(path.join(brainScope, 'memories', 'confirmed.md'), 'utf8');
    assert.ok(globalFile.includes(globalMemory.memory.id), 'the global file holds the global memory');
    assert.ok(!globalFile.includes(domainMemory.memory.id), 'the global file does not hold the domain memory');
    const domainFile = fs.readFileSync(path.join(brainScope, 'memories', 'domains', `${domain.id}.md`), 'utf8');
    assert.ok(domainFile.includes(domainMemory.memory.id), 'the domain file holds the domain memory');
    const projectFile = fs.readFileSync(path.join(brainScope, 'memories', 'projects', `${a.projectId}.md`), 'utf8');
    assert.ok(projectFile.includes(projectMemory.memory.id), 'the project file holds the project memory');
    assert.ok(!projectFile.includes(globalMemory.memory.id), 'the project file does not hold the global memory');

    evidence.push({
      case: 'MEM-004',
      domain: { id: domain.id, name: domain.name },
      projects: { a: a.projectId, b: b.projectId, c: c.projectId },
      memories: {
        global: { id: globalMemory.memory.id, scopeType: globalMemory.memory.scopeType, scopeId: globalMemory.memory.scopeId },
        domain: { id: domainMemory.memory.id, scopeType: domainMemory.memory.scopeType, scopeId: domainMemory.memory.scopeId },
        project: { id: projectMemory.memory.id, scopeType: projectMemory.memory.scopeType, scopeId: projectMemory.memory.scopeId },
      },
      mismatchedScopes: mismatches.map(mismatch => mismatch.scopeType),
      injected: { a: ids(injectedA), b: ids(injectedB), c: ids(injectedC) },
      files: {
        brainScope,
        domainScope,
        global: path.join(brainScope, 'memories', 'confirmed.md'),
        domain: path.join(brainScope, 'memories', 'domains', `${domain.id}.md`),
        project: path.join(brainScope, 'memories', 'projects', `${a.projectId}.md`),
      },
    });

    assert.equal(harness.browser.exceptions.length, 0, `no uncaught product JavaScript exceptions: ${JSON.stringify(harness.browser.exceptions)}`);

    if (harness.evidence) {
      fs.mkdirSync(harness.evidence, { recursive: true });
      fs.writeFileSync(path.join(harness.evidence, 'mem004-scope.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
    }

    console.log('parallel-memory-scope-test PASS (MEM-004 scope id matches scope type; global, domain and project scopes only reach their own range)');
  } finally {
    await harness.cleanup();
  }
}

main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
