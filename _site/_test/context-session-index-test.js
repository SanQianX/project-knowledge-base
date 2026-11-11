'use strict';
// CTX-SI: the knowledge context injection follows the ZCode-memory session
// model instead of re-sending a full pack on every user message.
//
// The case drives the real engine through the product shell route that the
// UserPromptSubmit hook itself uses (/api/engine/context), with the vector hub
// fixture answering 503 so the lexical channel is the one under test.
//
// Expectations:
//   1. the first turn of a session injects the statement block, applicable
//      memories and a TITLE-ONLY index once - never body text;
//   2. later turns stay silent unless something changed;
//   3. boundary-bigram collisions from same-domain neighbour projects (the
//      "外推算法/RpcTransportSDK inside a memory-system question" class of
//      false positives) never produce a breadcrumb, while a real word match
//      earns a one-line pointer that then cools down;
//   4. a memory added mid-session is re-sent in full exactly once, and a
//      deletion is announced exactly once;
//   5. across a simulated 30-turn session the cumulative injection stays an
//      order of magnitude below the previous per-turn 8000-char design.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { spawnServer } = require('./helpers/spawn-server');
const { createModuleFixture, createUpstreamProxy } = require('./helpers/module-fixture');
const freePort = require('./helpers/free-port');
const { applyDriverIsolation } = require('./helpers/parallel-qa-engine-endpoint-isolate');
const { guardedCreateEngineServer } = require('./helpers/parallel-qa-engine-endpoint-guard');

const ROOT = path.resolve(__dirname, '../..');

function git(cwd, args) {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
  return String(result.stdout || '').trim();
}

function makeRepo(root, name) {
  const repo = path.join(root, name);
  fs.mkdirSync(repo, { recursive: true });
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.email', 'session-index@local.invalid']);
  git(repo, ['config', 'user.name', 'Session Index Regression']);
  fs.writeFileSync(path.join(repo, 'README.md'), `# ${name}\n`);
  git(repo, ['add', '.']); git(repo, ['commit', '-qm', 'baseline']);
  return repo;
}

async function waitForHealth(base, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(2000) });
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for the isolated server on ' + base);
}

async function main() {
  // Driver isolation FIRST: the environment is rebuilt from a system whitelist
  // with every product surface pointed at a per-run layout, before any product
  // module is required.
  const applied = applyDriverIsolation({ prefix: 'pk-qa-ctx-session' });
  const fixture = fs.mkdtempSync(path.join(applied.layout.temp, 'pk-ctx-session-'));
  const dataDir = path.join(fixture, 'data');
  const knowledgeRoot = path.join(fixture, 'knowledge');
  const repoA = makeRepo(fixture, 'repo-memory-system');
  const repoC = makeRepo(fixture, 'repo-rpc-transport');
  const knowledgeA = path.join(knowledgeRoot, '记忆系统项目');
  const knowledgeC = path.join(knowledgeRoot, '轮转调度项目');
  fs.mkdirSync(knowledgeA, { recursive: true }); fs.mkdirSync(knowledgeC, { recursive: true });

  const engineToken = crypto.randomBytes(24).toString('hex');
  const terminal = createModuleFixture({ kind: 'terminal' });
  const vectorHub = createModuleFixture({ kind: 'vectorHub' });
  const eventBridge = createModuleFixture({ kind: 'eventBridge' });
  for (const fixtureService of [terminal, vectorHub, eventBridge]) {
    await fixtureService.start();
    fixtureService.setOnline(false);
  }
  const engine = guardedCreateEngineServer({ dataDir: path.join(fixture, 'engine'), runtimeToken: engineToken, debug: true, consume: false, vectorUrl: vectorHub.url, bridgeUrl: eventBridge.url });
  await engine.ready;
  await new Promise(resolve => engine.server.listen(0, '127.0.0.1', resolve));
  const engineUrl = `http://127.0.0.1:${engine.server.address().port}`;
  const engineProxy = createUpstreamProxy({ target: engineUrl, token: engineToken, tag: 'engine' });
  await engineProxy.start();

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const server = spawnServer({
    root: ROOT,
    port,
    dataDir,
    tag: 'context-session-index',
    analysisOwner: 'engine',
    extraEnv: {
      KB_MODULES_REGISTER: '1',
      KB_MODULES_AUTOSTART: '0',
      KB_KNOWLEDGE_ENGINE_URL: engineProxy.url,
      KB_TERMINAL_URL: terminal.url,
      KB_VECTORHUB_URL: vectorHub.url,
      KB_EVENTBRIDGE_URL: eventBridge.url,
    },
  });
  const api = async (method, route, body) => {
    const response = await fetch(base + route, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
    return { status: response.status, body: await response.json() };
  };
  const engineApi = async (method, route, body) => {
    const response = await fetch(engineUrl + route, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
    return { status: response.status, body: await response.json() };
  };
  let turnSeq = 0;
  const context = async (query, sessionId, repoPath = repoA) => {
    turnSeq += 1;
    const result = await api('POST', '/api/engine/context', { repoPath, query, client: 'zcode', sessionId, requestId: `ctx-e2e-${turnSeq}` });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    return result.body;
  };

  try {
    await waitForHealth(base);
    assert.equal((await api('PATCH', '/api/settings', { knowledge: { rootPath: knowledgeRoot } })).status, 200);
    const domain = (await api('POST', '/api/domains', { name: '会话领域' })).body.domain;
    assert.ok(domain && domain.id, 'the domain exists for both projects');

    const importedA = await api('POST', '/api/projects/import', { localPath: repoA, knowledgePath: knowledgeA, displayName: '记忆系统项目', domainId: domain.id });
    assert.equal(importedA.status, 201, JSON.stringify(importedA.body));
    const projectA = importedA.body.projectId;
    const importedC = await api('POST', '/api/projects/import', { localPath: repoC, knowledgePath: knowledgeC, displayName: '轮转调度项目', domainId: domain.id });
    assert.equal(importedC.status, 201, JSON.stringify(importedC.body));
    const projectC = importedC.body.projectId;
    assert.notEqual(projectA, projectC, 'the decoy lives in a different project of the same domain');

    // The current project owns memory-system knowledge; the neighbour owns the
    // two decoys from the original complaint plus a boundary-bigram trap.
    fs.mkdirSync(path.join(knowledgeA, 'modules'), { recursive: true });
    fs.mkdirSync(path.join(knowledgeA, 'changes'), { recursive: true });
    fs.writeFileSync(path.join(knowledgeA, 'README.md'), '# 记忆系统项目说明\n\n导出需要 schemaRevision 37。KB-INDEX-SECRET-A 导出契约正文。\n');
    fs.writeFileSync(path.join(knowledgeA, 'modules', 'context.md'), '# 记忆注入机制\n\n会话首条消息注入一次索引，正文经 MCP 按需读取。KB-INDEX-SECRET-B 记忆注入机制正文。\n');
    fs.writeFileSync(path.join(knowledgeA, 'changes', 'change.md'), '# 最近一次注入改造\n\n已完成会话索引改造。KB-INDEX-SECRET-C\n');
    fs.mkdirSync(path.join(knowledgeC, 'modules'), { recursive: true });
    fs.mkdirSync(path.join(knowledgeC, 'changes'), { recursive: true });
    fs.writeFileSync(path.join(knowledgeC, 'modules', 'rpc.md'), '# RpcTransportSDK lane 轮转规则\n\n恢复导出配置的九步流程与并发调度。KB-INDEX-SECRET-D\n');
    fs.writeFileSync(path.join(knowledgeC, 'changes', 'extrapolation.md'), '# 外推算法九步流程\n\n外推算法按九步执行并记录证据。KB-INDEX-SECRET-E\n');

    // 1. The first turn injects the index once: statement block, no body text.
    const first = await context('开始设计记忆系统的注入机制', 'sess-main');
    assert.equal(first.status, 'ready'); assert.equal(first.injectionKind, 'index');
    assert.equal(first.rankingVersion, 'project-knowledge/ranking-v3');
    assert.ok(first.facts.some(item => item.entryId === 'modules/context.md' && item.role === '本项目事实'), 'the index lists the memory-system module');
    assert.ok(first.facts.every(item => !('text' in item)), 'index facts never carry body text');
    assert.ok(first.prompt.includes('modules/context.md'));
    assert.equal((first.prompt.match(/当前生效的已确认记忆只来自 memories/g) || []).length, 1);
    assert.ok(first.prompt.length <= 3000, `index stays compact, got ${first.prompt.length}`);
    assert.ok(first.sessionIndexedCount >= 2, 'the session registry counts its titles');
    for (const secret of ['KB-INDEX-SECRET-A', 'KB-INDEX-SECRET-B', 'KB-INDEX-SECRET-C', 'KB-INDEX-SECRET-D', 'KB-INDEX-SECRET-E']) {
      assert.ok(!first.prompt.includes(secret), 'no knowledge body ever enters the injection layer');
    }

    // 2. A later turn without changes or strong matches is fully silent. With
    //    the vector fixture offline the turn reports file-fallback (a
    //    user-facing notice), which must still inject nothing.
    const quiet = await context('顺便聊聊天气', 'sess-main');
    assert.ok(quiet.status !== 'ready', 'nothing was injected');
    assert.equal(quiet.prompt, '');
    assert.equal(quiet.injectionKind, undefined); assert.equal(quiet.facts.length, 0);

    // 3. Boundary-bigram decoys stay silent even though search admits them.
    const decoyQuery = '修复导入功能的报错';
    const admitted = await api('POST', '/api/knowledge/search', { projectId: projectA, query: decoyQuery, scope: 'domain' });
    assert.equal(admitted.status, 200, JSON.stringify(admitted.body));
    assert.ok((admitted.body.results || []).some(row => row.path === 'modules/rpc.md'), 'the lexical channel still admits the decoy entry');
    const decoyTurn = await context(decoyQuery, 'sess-main');
    assert.equal(decoyTurn.prompt, '', 'a boundary-bigram collision never becomes a breadcrumb');

    // 4. A real word match earns a one-line breadcrumb, then cools down.
    const strongQuery = '记忆注入机制是怎么设计的';
    const crumb = await context(strongQuery, 'sess-main');
    assert.equal(crumb.injectionKind, 'breadcrumb');
    assert.ok(crumb.facts.some(item => item.entryId === 'modules/context.md'), 'the breadcrumb points at the matching entry');
    assert.ok(!crumb.facts.some(item => String(item.entryId).includes('rpc') || String(item.entryId).includes('extrapolation')), 'the decoys never appear');
    assert.ok(crumb.prompt.includes('modules/context.md')); assert.ok(!crumb.prompt.includes('KB-INDEX-SECRET-B'));
    assert.ok(!crumb.prompt.includes('当前生效的已确认记忆只来自'), 'deltas never repeat the statement block');
    assert.equal((await context(strongQuery, 'sess-main')).prompt, '', 'the same entry is on cooldown');

    // 5. A memory added mid-session is re-sent in full exactly once.
    const brainScope = (await engineApi('GET', '/api/snapshot?summary=1&limit=1')).body.sharedScopes.find(scope => scope.kind === 'brain');
    assert.ok(brainScope, 'the brain scope exists');
    const created = await engineApi('POST', '/api/memories', { text: '本仓库必须保持中文提交信息', scopeType: 'project', scopeId: projectA, brainId: brainScope.brainId });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const memoryId = created.body.memory.id;
    const memoryTurn = await context('继续做别的', 'sess-main');
    assert.equal(memoryTurn.injectionKind, 'memory-delta'); assert.equal(memoryTurn.memories.length, 1);
    assert.equal(memoryTurn.memories[0].memoryId, memoryId);
    assert.ok(memoryTurn.prompt.includes('本仓库必须保持中文提交信息'));
    assert.equal((await context('继续做别的', 'sess-main')).prompt, '', 'an unchanged memory never repeats');
    const deleted = await engineApi('DELETE', `/api/memories/${encodeURIComponent(memoryId)}`);
    assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
    const removalTurn = await context('继续做别的', 'sess-main');
    assert.ok(removalTurn.prompt.includes('记忆已移除'), 'a deletion is announced instead of silently vanishing');
    assert.equal((await context('继续做别的', 'sess-main')).prompt, '', 'the removal notice fires once');

    // 6. Thirty simulated turns stay an order of magnitude below the old
    //    per-turn 8000-char design (which accumulated ~90KB+ over 30 turns).
    let cumulative = 0;
    for (let turn = 1; turn <= 30; turn++) {
      const query = turn === 1 ? '开始设计记忆系统的注入机制'
        : turn % 5 === 0 ? '记忆注入机制还有哪些细节'
        : turn % 7 === 0 ? '修复导入功能的报错'
        : `随便记录一下第${turn}轮的进展`;
      const result = await context(query, 'sess-30');
      cumulative += (result.prompt || '').length;
      assert.ok((result.prompt || '').length <= 8000, 'the hard contract never breaks');
      assert.ok(!(result.prompt || '').includes('KB-INDEX-SECRET-'), 'no turn ever leaks a body');
    }
    assert.ok(cumulative <= 10240, `30 turns inject at most 10KB in total, got ${cumulative}`);

    console.log('context-session-index-test PASS (one index per session, silent turns, gated breadcrumbs, once-only memory deltas, 30-turn cumulative injection bounded)');
  } finally {
    await server.cleanup();
    await engine.close().catch(() => {});
    await engineProxy.close();
    for (const fixtureService of [terminal, vectorHub, eventBridge]) await fixtureService.close();
    fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
