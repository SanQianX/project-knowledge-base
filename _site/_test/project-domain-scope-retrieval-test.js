'use strict';
// PRJ-011: changing the domain of a project updates the retrieval scope.
//
// The steps of the case are "change the domain of the project, then run a
// project / domain retrieval". The expectations are:
//   1. the scope follows the registration update;
//   2. the absolute knowledge path does not move.
//
// The instance is an isolated product server with its own data directory and
// its own knowledge root. The knowledge engine is the real vendored module;
// the three other modules are local fixtures that answer 503, so only the
// engine participates.
//
// Boundary: the vector index is not part of this fixture, so the retrieval
// answers from the current knowledge files only. The scope expansion and the
// registration update are the behaviour under test; the ranking channel is
// explicitly the lexical one, which the answer reports itself.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { spawnServer } = require('./helpers/spawn-server');
const { createModuleFixture, createUpstreamProxy } = require('./helpers/module-fixture');
const freePort = require('./helpers/free-port');

const ROOT = path.resolve(__dirname, '../..');
const ENGINE_ENTRY = path.join(ROOT, '_modules', 'knowledge-engine', 'src', 'server.js');

function git(cwd, args) {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
  return String(result.stdout || '').trim();
}

function makeRepo(root, name) {
  const repo = path.join(root, name);
  fs.mkdirSync(repo, { recursive: true });
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.email', 'domain@local.invalid']);
  git(repo, ['config', 'user.name', 'Domain Regression']);
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
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-prj-domain-'));
  const dataDir = path.join(fixture, 'data');
  const knowledgeRoot = path.join(fixture, 'knowledge');
  const repoA = makeRepo(fixture, 'repo-domain-a');
  const repoB = makeRepo(fixture, 'repo-domain-b');
  const knowledgeA = path.join(knowledgeRoot, '领域项目');
  const knowledgeB = path.join(knowledgeRoot, '另一领域项目');
  fs.mkdirSync(knowledgeA, { recursive: true }); fs.mkdirSync(knowledgeB, { recursive: true });

  const engineToken = crypto.randomBytes(24).toString('hex');
  const { createEngineServer } = require(ENGINE_ENTRY);
  const engine = createEngineServer({ dataDir: path.join(fixture, 'engine'), runtimeToken: engineToken, debug: true, consume: false });
  await engine.ready;
  await new Promise(resolve => engine.server.listen(0, '127.0.0.1', resolve));
  const engineUrl = `http://127.0.0.1:${engine.server.address().port}`;
  const engineProxy = createUpstreamProxy({ target: engineUrl, token: engineToken, tag: 'engine' });
  await engineProxy.start();

  const terminal = createModuleFixture({ kind: 'terminal' });
  const vectorHub = createModuleFixture({ kind: 'vectorHub' });
  const eventBridge = createModuleFixture({ kind: 'eventBridge' });
  for (const fixtureService of [terminal, vectorHub, eventBridge]) {
    await fixtureService.start();
    fixtureService.setOnline(false);
  }

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const server = spawnServer({
    root: ROOT,
    port,
    dataDir,
    tag: 'project-domain',
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

  try {
    await waitForHealth(base);
    assert.equal((await api('PATCH', '/api/settings', { knowledge: { rootPath: knowledgeRoot } })).status, 200);

    // Two real domains. The product registers them as shared scopes with the
    // engine, so a domain retrieval has something to expand to.
    const first = await api('POST', '/api/domains', { name: '领域一' });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    const domainA = first.body.domain.id;
    const second = await api('POST', '/api/domains', { name: '领域二' });
    assert.equal(second.status, 201, JSON.stringify(second.body));
    const domainB = second.body.domain.id;
    assert.ok(domainA && domainB && domainA !== domainB);

    const scopesBefore = (await engineApi('GET', '/api/snapshot?summary=1&limit=1')).body.sharedScopes;
    assert.ok(scopesBefore.some(scope => scope.kind === 'domain' && scope.domainId === domainA), 'the engine knows the first domain scope');
    assert.ok(scopesBefore.some(scope => scope.kind === 'domain' && scope.domainId === domainB), 'the engine knows the second domain scope');
    const scopePathsBefore = Object.fromEntries(scopesBefore.map(scope => [scope.id, scope.knowledgePath]));

    const importedA = await api('POST', '/api/projects/import', { localPath: repoA, knowledgePath: knowledgeA, displayName: '领域项目', domainId: domainA });
    assert.equal(importedA.status, 201, JSON.stringify(importedA.body));
    const projectA = importedA.body.projectId;
    assert.equal(importedA.body.project.config.domainId, domainA, 'the first project starts in the first domain');
    const importedB = await api('POST', '/api/projects/import', { localPath: repoB, knowledgePath: knowledgeB, displayName: '另一领域项目', domainId: domainB });
    assert.equal(importedB.status, 201, JSON.stringify(importedB.body));
    const projectB = importedB.body.projectId;
    assert.equal(importedB.body.project.config.domainId, domainB, 'the second project starts in the second domain');

    // The knowledge file is written after the import: a new project's
    // knowledge directory has to be empty when the project is registered.
    const knowledgeFile = path.join(knowledgeA, 'note.md');
    fs.writeFileSync(knowledgeFile, '# 领域笔记\n\n这是一条属于项目的知识记录。\n');
    const knowledgeBytes = fs.readFileSync(knowledgeFile);

    // A real domain retrieval through the product, answered by the real engine.
    const before = await api('POST', '/api/knowledge/search', { projectId: projectA, query: '领域笔记', scope: 'domain' });
    assert.equal(before.status, 200, JSON.stringify(before.body));
    // The answer reports the scopes it scanned, one entry per scope.
    const scopeIds = result => (result.health?.scopes || []).map(scope => scope.projectId);
    assert.ok(scopeIds(before.body).includes(domainA), 'the retrieval runs in the domain of the project');
    assert.equal(scopeIds(before.body).includes(domainB), false, 'the retrieval does not reach the other domain');
    assert.equal(scopeIds(before.body).includes(projectB), false, 'the retrieval does not reach the project of the other domain');
    assert.ok(before.body.results.length >= 1, 'the retrieval answers from the current knowledge files');
    assert.ok(before.body.results.some(row => row.scope_project_id === projectA && String(row.snippet || '').includes('领域笔记')), 'the answer points at the knowledge file of the project');
    assert.deepEqual(before.body.retrievalModes, ['lexical'], 'the answer reports the lexical channel it used');

    // Change the domain of the first project.
    const changed = await api('PATCH', `/api/projects/${encodeURIComponent(projectA)}`, { domainId: domainB });
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    assert.equal(changed.body.config.domainId, domainB, 'the product records the new domain');

    // The registration in the real engine follows the change.
    const registration = (await engineApi('GET', '/api/projects')).body.projects.find(project => project.projectId === projectA);
    assert.ok(registration, 'the engine keeps the project registration');
    assert.equal(registration.domainId, domainB, 'the engine registration carries the new domain');

    // 1. The scope follows the registration update.
    const after = await api('POST', '/api/knowledge/search', { projectId: projectA, query: '领域笔记', scope: 'domain' });
    assert.equal(after.status, 200, JSON.stringify(after.body));
    assert.ok(scopeIds(after.body).includes(domainB), 'the retrieval now runs in the new domain');
    assert.equal(scopeIds(after.body).includes(domainA), false, 'the retrieval no longer reaches the old domain');
    assert.ok(scopeIds(after.body).includes(projectB), 'the retrieval now reaches the project of the new domain');
    assert.ok(after.body.results.some(row => row.scope_project_id === projectA && String(row.snippet || '').includes('领域笔记')), 'the project knowledge is still reachable');

    // 2. The absolute knowledge path does not move.
    const projected = (await api('GET', '/api/projects/projection')).body.projects.find(project => project.projectId === projectA);
    assert.equal(path.resolve(projected.knowledgePath), path.resolve(knowledgeA), 'the knowledge path stays the same absolute path');
    assert.deepEqual(fs.readFileSync(knowledgeFile), knowledgeBytes, 'the knowledge file bytes do not change');
    assert.ok(fs.existsSync(path.join(knowledgeA, 'note.md')), 'the knowledge file stays where it is');
    const scopesAfter = (await engineApi('GET', '/api/snapshot?summary=1&limit=1')).body.sharedScopes;
    for (const scope of scopesAfter) {
      assert.equal(scope.knowledgePath, scopePathsBefore[scope.id], `the shared scope path of ${scope.id} does not move`);
    }
    assert.ok(fs.existsSync(path.join(knowledgeRoot, '_shared')), 'the shared knowledge root stays where it is');

    console.log('project-domain-scope-retrieval-test PASS (the domain retrieval scope follows the registration update; the absolute knowledge path does not move)');
  } finally {
    await server.cleanup();
    await engine.close().catch(() => {});
    await engineProxy.close();
    for (const fixtureService of [terminal, vectorHub, eventBridge]) await fixtureService.close();
    fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
