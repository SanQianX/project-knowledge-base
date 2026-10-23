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

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const { startHarness, makeRepo } = require('./helpers/parallel-memory-shell');

const EVIDENCE = process.env.PK_TEST_EVIDENCE_DIR ? path.resolve(process.env.PK_TEST_EVIDENCE_DIR) : null;
const GLOBAL_TEXT = '全局约定：所有对外错误信息使用中文表述。';
const DOMAIN_TEXT = '平台领域约定：发布流程必须先跑完整回归。';
const PROJECT_TEXT = '项目约定：数据库迁移脚本一律放在 db/migrations。';

async function openMemoryView(harness) {
  await harness.nativeClick('nav [data-view="memory"]');
  await harness.waitFor(
    () => harness.run("document.getElementById('view-memory').classList.contains('active')"),
    'the memory view is open',
    10000,
  );
}

/** Add one memory through the real UI and return what the engine answered. */
async function addMemoryViaUi(harness, { text, scopeType, scopeId }) {
  await harness.nativeClick('#addMemory');
  await harness.waitFor(
    () => harness.run("document.getElementById('memoryDialog').open === true"),
    'the add dialog is open',
    10000,
  );
  await harness.typeText(text);
  await harness.selectOption('#memoryScope', scopeType);
  if (scopeType !== 'global') {
    const options = await harness.run("Array.from(document.getElementById('memoryTarget').options).map(o => o.value)");
    assert.ok(options.includes(scopeId), `the ${scopeType} scope offers ${scopeId}: ${JSON.stringify(options)}`);
    await harness.selectOption('#memoryTarget', scopeId);
  }
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
  const body = await harness.network.body(post);
  assert.ok(body && body.memory, `the real POST answers with the memory: ${JSON.stringify(body)}`);
  assert.equal(body.memory.text, text, 'the saved text is the text that was typed');
  assert.equal(body.memory.scopeType, scopeType, 'the saved scope type is the chosen one');
  assert.equal(body.memory.scopeId, scopeId || body.memory.brainId, 'the saved scope id belongs to the scope type');
  assert.equal(body.memory.status, 'confirmed', 'the memory is saved as confirmed');
  return { memory: body.memory, request: post.body, url: post.url.replace(harness.base, '') };
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
    await harness.waitFor(
      () => harness.run("document.getElementById('homeContent').textContent.includes('范围丙')"),
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
      () => harness.run("!document.getElementById('addMemory').disabled"),
      'the engine is reachable and the add button is live',
      20000,
    );

    // ---------------------------------------------------------------- MEM-004
    const globalMemory = await addMemoryViaUi(harness, { text: GLOBAL_TEXT, scopeType: 'global' });
    const domainMemory = await addMemoryViaUi(harness, { text: DOMAIN_TEXT, scopeType: 'domain', scopeId: domain.id });
    const projectMemory = await addMemoryViaUi(harness, { text: PROJECT_TEXT, scopeType: 'project', scopeId: a.projectId });

    assert.equal(globalMemory.memory.scopeId, globalMemory.memory.brainId, 'a global memory targets the brain itself');
    assert.equal(domainMemory.memory.scopeId, domain.id, 'a domain memory targets the domain');
    assert.equal(projectMemory.memory.scopeId, a.projectId, 'a project memory targets the project');

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

    // The real UI names the scope of every memory.
    await harness.reload();
    await openMemoryView(harness);
    await harness.nativeClick('[data-memory-tab="confirmed"]');
    await harness.waitFor(
      () => harness.run(`document.getElementById('memoryContent').textContent.includes(${JSON.stringify(GLOBAL_TEXT)})`),
      'the confirmed memories are listed',
      15000,
    );
    const scopeLabels = await harness.run("Array.from(document.querySelectorAll('[data-memory-card]')).map(el => el.textContent)");
    const globalCard = scopeLabels.find(text => text.includes(GLOBAL_TEXT));
    const domainCard = scopeLabels.find(text => text.includes(DOMAIN_TEXT));
    const projectCard = scopeLabels.find(text => text.includes(PROJECT_TEXT));
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
