'use strict';
// PRJ-009: unbinding is write-protected.
//
// The steps of the case are "prepare a queued task and a running write, then
// request the unbind for each". The expectations are:
//   1. a queued task is cancelled by the contract;
//   2. an active writer blocks the unbind;
//   3. the code, the knowledge files and the session history stay on disk.
//
// The knowledge engine is the real vendored module
// (_modules/knowledge-engine), started by this test on its own port with its
// own data directory. The product under test is an isolated instance that
// registers the fixture project into that engine; the three other modules are
// local fixtures that answer 503, so only the engine participates.
//
// Boundary: the engine runs without a model, so no analysis can be executed
// here. The "running writer" precondition is therefore written through the
// engine's own run store (the same field the engine itself checks before it
// removes a project). Everything else is the product's own behaviour.

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
  git(repo, ['config', 'user.email', 'unbind@local.invalid']);
  git(repo, ['config', 'user.name', 'Unbind Regression']);
  fs.writeFileSync(path.join(repo, 'README.md'), `# ${name}\n`);
  fs.writeFileSync(path.join(repo, 'code.js'), `export const value = '${name}';\n`);
  git(repo, ['add', '.']); git(repo, ['commit', '-qm', 'baseline']);
  return { repo, head: git(repo, ['rev-parse', 'HEAD']) };
}

function hashTree(root) {
  const out = {};
  const walk = dir => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.git') continue; // the Git directory is not project data
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(absolute); continue; }
      out[path.relative(root, absolute).replace(/\\/g, '/')] = crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex');
    }
  };
  walk(root);
  return out;
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
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-prj-unbind-'));
  const dataDir = path.join(fixture, 'data');
  const knowledgeRoot = path.join(fixture, 'knowledge');
  const first = makeRepo(fixture, 'repo-queued');
  const second = makeRepo(fixture, 'repo-writing');
  const firstKnowledge = path.join(knowledgeRoot, 'queued');
  const secondKnowledge = path.join(knowledgeRoot, 'writing');
  fs.mkdirSync(firstKnowledge, { recursive: true }); fs.mkdirSync(secondKnowledge, { recursive: true });

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
    tag: 'project-unbind',
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

    // ---- Case A: a queued maintenance task -------------------------------
    const importedFirst = await api('POST', '/api/projects/import', { localPath: first.repo, knowledgePath: firstKnowledge, displayName: '排队任务项目' });
    assert.equal(importedFirst.status, 201, JSON.stringify(importedFirst.body));
    const firstProjectId = importedFirst.body.projectId;
    const engineProjects = (await engineApi('GET', '/api/projects')).body.projects;
    assert.ok(engineProjects.some(project => project.projectId === firstProjectId), 'the product must register the fixture project in the real engine');

    const queued = await engineApi('POST', '/api/runs', { projectId: firstProjectId, commitSha: first.head });
    assert.equal(queued.status, 200, JSON.stringify(queued.body));
    const queuedRunId = queued.body.run.runId;
    assert.equal(queued.body.run.state, 'queued', 'the prepared maintenance task must stay queued (not started)');

    // The event-bridge keeps the session journal inside the knowledge
    // directory. A controlled session record stands in for it here, because
    // the journal consumer of the real event-bridge module is not part of this
    // fixture.
    fs.mkdirSync(path.join(firstKnowledge, 'dev-conversations'), { recursive: true });
    fs.writeFileSync(path.join(firstKnowledge, 'dev-conversations', 'session-1.jsonl'), '{"role":"user","content":"会话记录"}\n');
    const repoBefore = hashTree(first.repo);
    const knowledgeBefore = hashTree(firstKnowledge);
    const unbind = await api('DELETE', `/api/projects/${encodeURIComponent(firstProjectId)}`, { deleteKnowledge: false });
    assert.equal(unbind.status, 200, JSON.stringify(unbind.body));

    const runsAfter = (await engineApi('GET', `/api/runs?projectId=${encodeURIComponent(firstProjectId)}`)).body.runs;
    const cancelled = runsAfter.find(run => run.runId === queuedRunId);
    assert.ok(cancelled, 'the queued task must still be visible in the engine run history');
    assert.equal(cancelled.state, 'cancelled', 'the queued task must be cancelled by the unbind');
    assert.equal(cancelled.cancellationReason, 'project-unbound', 'the cancellation must record the contract reason');
    assert.equal((await engineApi('GET', '/api/projects')).body.projects.some(project => project.projectId === firstProjectId), false, 'the engine must drop the unregistered project');
    assert.equal((await api('GET', '/api/projects/aggregated')).body.projects.some(project => project.projectId === firstProjectId), false, 'the product must drop the unbound project');

    // The disk keeps the code, the knowledge files and the session record.
    const repoAfter = hashTree(first.repo);
    const knowledgeAfter = hashTree(firstKnowledge);
    assert.deepEqual(Object.keys(repoAfter), Object.keys(repoBefore), 'the code files must stay on disk');
    assert.equal(repoAfter['README.md'], repoBefore['README.md'], 'the code file bytes must not change');
    assert.equal(fs.existsSync(path.join(first.repo, '.git', 'hooks', 'post-commit')), false, 'the managed Hook is uninstalled by the unbind');
    assert.equal(knowledgeAfter['dev-conversations/session-1.jsonl'], knowledgeBefore['dev-conversations/session-1.jsonl'], 'the session record must stay on disk');
    assert.ok(fs.existsSync(firstKnowledge), 'the knowledge directory must survive the unbind');

    // ---- Case B: an active writer blocks the unbind ----------------------
    const importedSecond = await api('POST', '/api/projects/import', { localPath: second.repo, knowledgePath: secondKnowledge, displayName: '写入中项目' });
    assert.equal(importedSecond.status, 201, JSON.stringify(importedSecond.body));
    const secondProjectId = importedSecond.body.projectId;
    const writing = await engineApi('POST', '/api/runs', { projectId: secondProjectId, commitSha: second.head });
    assert.equal(writing.status, 200, JSON.stringify(writing.body));
    const writingRunId = writing.body.run.runId;
    // The engine cannot run a model-backed analysis in this fixture, so the
    // running-writer precondition is written through the engine's own run
    // store — the very state the engine checks before removing a project.
    engine.store.updateRun(writingRunId, { state: 'running', phase: 'analyzing' });
    assert.equal(engine.store.getRun(writingRunId).state, 'running');

    const secondRepoBefore = hashTree(second.repo);
    const secondKnowledgeBefore = hashTree(secondKnowledge);
    const blocked = await api('DELETE', `/api/projects/${encodeURIComponent(secondProjectId)}`, { deleteKnowledge: false });
    assert.equal(blocked.status, 409, JSON.stringify(blocked.body));
    assert.equal(blocked.body.error.code, 'PROJECT_BUSY');
    assert.equal(blocked.body.error.retryable, true, 'a blocked unbind must be reported as retryable');
    assert.match(blocked.body.error.message, /写入结束/, 'the refusal must name the active write');
    assert.ok((await api('GET', '/api/projects/aggregated')).body.projects.some(project => project.projectId === secondProjectId), 'a blocked unbind must keep the project registered');
    assert.ok((await engineApi('GET', '/api/projects')).body.projects.some(project => project.projectId === secondProjectId), 'a blocked unbind must keep the engine registration');
    assert.deepEqual(hashTree(second.repo), secondRepoBefore, 'a blocked unbind must not touch the code');
    assert.deepEqual(hashTree(secondKnowledge), secondKnowledgeBefore, 'a blocked unbind must not touch the knowledge files');

    // Once the write is over the same unbind succeeds.
    engine.store.updateRun(writingRunId, { state: 'failed', phase: 'failed', finishedAt: new Date().toISOString() });
    const retried = await api('DELETE', `/api/projects/${encodeURIComponent(secondProjectId)}`, { deleteKnowledge: false });
    assert.equal(retried.status, 200, JSON.stringify(retried.body));
    assert.equal((await api('GET', '/api/projects/aggregated')).body.projects.some(project => project.projectId === secondProjectId), false, 'the retried unbind removes the project');
    assert.deepEqual(hashTree(second.repo), secondRepoBefore, 'the retried unbind must not touch the code');
    assert.deepEqual(hashTree(secondKnowledge), secondKnowledgeBefore, 'the retried unbind must not touch the knowledge files');

    console.log('project-unbind-writer-guard-test PASS (queued task cancelled, active writer blocks with a retryable 409, code/knowledge/session bytes preserved)');
  } finally {
    await server.cleanup();
    await engine.close().catch(() => {});
    await engineProxy.close();
    for (const fixtureService of [terminal, vectorHub, eventBridge]) await fixtureService.close();
    fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
