'use strict';
// PRJ-007: 部分模块离线 —— 四模块均返回 503 时导入，再只恢复一个模块并修复接线。
//
// The steps of the case are "import while the four modules all answer 503,
// then bring one module back and repair the wiring". The expectations are:
//   1. the registration is kept and the real module status still fails;
//   2. the repair only fills in the failed module and registers nothing twice.
//
// The instance is an isolated product server with its own data directory and
// its own knowledge root. The four modules are real HTTP services: three
// local fixtures that keep the registration state the product writes into
// them (each can be switched offline with 503) and the real vendored
// knowledge-engine behind a pass-through proxy that can also be switched
// offline. The repair is the product's own action, driven from the browser:
// the "修复接线" button in the project detail.
//
// Boundary: the modules are not the vendored runtime, they are contract
// faithful fixtures — the evidence is the registration state each module
// keeps, not a claim about the real terminal or index service.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { spawnServer } = require('./helpers/spawn-server');
const { findChrome } = require('./helpers/find-chrome');
const { launchCdpBrowser, waitFor } = require('./helpers/cdp-browser');
const { attachNetworkCapture } = require('./helpers/cdp-network-capture');
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
  git(repo, ['config', 'user.email', 'module-recovery@local.invalid']);
  git(repo, ['config', 'user.name', 'Module Recovery Regression']);
  fs.writeFileSync(path.join(repo, 'README.md'), `# ${name}\n`);
  git(repo, ['add', '.']); git(repo, ['commit', '-qm', 'baseline']);
  return repo;
}

async function main() {
  // Driver isolation FIRST (Chrome captured before the wipe), before any
  // product module is required.
  const applied = applyDriverIsolation({ prefix: 'pk-qa-prj-partial-recovery', captureChrome: true });
  const fixture = fs.mkdtempSync(path.join(applied.layout.temp, 'pk-prj-modules-'));
  const dataDir = path.join(fixture, 'data');
  const knowledgeRoot = path.join(fixture, 'knowledge');
  const repo = makeRepo(fixture, '部分模块项目');
  const knowledge = path.join(knowledgeRoot, '部分模块项目');
  fs.mkdirSync(knowledgeRoot, { recursive: true });

  const engineToken = crypto.randomBytes(24).toString('hex');
  // OWN fixtures first, then the engine constructed against them: the
  // coordinator ignores env and would otherwise fall back to LIVE 8787/8790.
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
  engineProxy.setOnline(false);

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const server = spawnServer({
    root: ROOT,
    port,
    dataDir,
    tag: 'project-modules',
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

  let browser;
  const api = async (method, route, body) => {
    const response = await fetch(base + route, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
    return { status: response.status, body: await response.json() };
  };
  const engineApi = async route => {
    const response = await fetch(engineUrl + route, { signal: AbortSignal.timeout(10000) });
    return { status: response.status, body: await response.json() };
  };

  try {
    await waitFor(async () => {
      try { return (await api('GET', '/api/health')).status === 200; } catch { return false; }
    }, 'the isolated product instance', 20000);
    assert.equal((await api('PATCH', '/api/settings', { knowledge: { rootPath: knowledgeRoot } })).status, 200);

    browser = await launchCdpBrowser({ chrome: findChrome(), profileDir: path.join(fixture, 'browser'), url: base, width: 1440, height: 900 });
    await browser.setViewport(1440, 900);
    const capture = attachNetworkCapture(browser);
    await capture.enable();
    const run = expression => browser.evaluate(expression);
    const click = selector => run(`document.querySelector(${JSON.stringify(selector)}).click()`);

    // The import runs against the product with all four modules answering 503.
    const imported = await api('POST', '/api/projects/import', { localPath: repo, knowledgePath: knowledge, displayName: '部分模块项目' });
    assert.equal(imported.status, 201, JSON.stringify(imported.body));
    const projectId = imported.body.projectId;

    // 1. The registration is kept and every real module still fails.
    const registered = (await api('GET', '/api/projects/aggregated')).body.projects;
    assert.equal(registered.length, 1, 'the project registration survives the offline modules');
    assert.equal(registered[0].projectId, projectId);
    assert.deepEqual(Object.keys(imported.body.modules).sort(), ['engine', 'eventBridge', 'terminal', 'vectorHub'], 'the import reports each of the four modules separately');
    for (const [key, module] of Object.entries(imported.body.modules)) {
      assert.equal(module.ok, false, `${key} did not register while it answered 503`);
      assert.equal(typeof module.status, 'string', `${key} reports its own status`);
    }
    for (const [key, module] of Object.entries(registered[0].modules)) {
      assert.equal(module.registered, false, `${key} is not registered against the offline module`);
      assert.equal(typeof module.status, 'string', `${key} reports its own status`);
    }
    assert.equal(terminal.state.projects.length, 0, 'the terminal module holds no registration');
    assert.equal(vectorHub.state.projects.length, 0, 'the index module holds no registration');
    assert.equal(eventBridge.state.projects.length, 0, 'the event bridge holds no registration');
    assert.equal((await engineApi('/api/projects')).body.projects.length, 0, 'the knowledge engine holds no registration');

    // The browser picks the imported project up from the product registry.
    await click('[data-view="projects"]');
    await run("document.dispatchEvent(new Event('visibilitychange'))");
    await waitFor(() => run("document.getElementById('projectTree').textContent.includes('部分模块项目')"), 'the imported project in the tree', 20000);
    await click(`[data-select-project="${projectId}"]`);
    await waitFor(() => run("document.getElementById('projectDetail').textContent.includes('部分模块项目')"), 'the project detail', 10000);
    assert.ok(await run("document.getElementById('projectDetail').querySelector('[data-action=\"repair\"]') !== null"), 'the project offers the repair action');

    // Only the terminal comes back. The other three keep answering 503.
    terminal.setOnline(true);
    const repairCalls = () => capture.find(entry => entry.method === 'POST' && entry.url.includes('/module-register'));
    const beforeRepair = repairCalls().length;
    await click('[data-action="repair"]');
    await waitFor(() => repairCalls().length > beforeRepair, 'the repair request', 20000);
    await waitFor(() => run("document.getElementById('wiringFeedback').textContent.includes('待恢复')"), 'the repair feedback', 20000);
    const firstRepair = await capture.body(repairCalls()[beforeRepair]);
    assert.ok(firstRepair && firstRepair.modules, 'the repair answer carries the four module states');
    assert.equal(firstRepair.modules.terminal.ok, true, 'the recovered terminal registers');
    assert.equal(firstRepair.modules.terminal.status, 'registered');
    assert.equal(terminal.state.projects.length, 1, 'the terminal holds exactly one registration');
    assert.equal(path.resolve(terminal.state.projects[0].rootPath), path.resolve(repo), 'the terminal registration points at the imported workspace');
    for (const key of ['vectorHub', 'eventBridge', 'engine']) {
      assert.equal(firstRepair.modules[key].ok, false, `${key} still fails while it answers 503`);
    }
    assert.equal(vectorHub.state.projects.length, 0, 'the index module still holds no registration');
    assert.equal(eventBridge.state.projects.length, 0, 'the event bridge still holds no registration');
    assert.equal((await engineApi('/api/projects')).body.projects.length, 0, 'the knowledge engine still holds no registration');
    const feedback = await run("document.getElementById('wiringFeedback').textContent");
    assert.match(feedback, /待恢复/, 'the page reports the modules that are still pending');
    for (const name of ['知识索引', '开发事件', '知识引擎']) {
      assert.ok(feedback.includes(name), `the pending list names ${name}`);
    }
    assert.equal((await api('GET', '/api/projects/aggregated')).body.projects.length, 1, 'the repair does not create a second project');

    // The index module comes back as well; the terminal is already wired.
    vectorHub.setOnline(true);
    const beforeSecondRepair = repairCalls().length;
    await click('[data-action="repair"]');
    await waitFor(() => repairCalls().length > beforeSecondRepair, 'the second repair request', 20000);
    await waitFor(() => run("document.getElementById('wiringFeedback').textContent.includes('待恢复')"), 'the second repair feedback', 20000);
    const secondRepair = await capture.body(repairCalls()[beforeSecondRepair]);
    assert.ok(secondRepair && secondRepair.modules, 'the second repair answer carries the four module states');
    assert.equal(secondRepair.modules.vectorHub.ok, true, 'the recovered index module registers');
    assert.equal(secondRepair.modules.vectorHub.status, 'registered');
    assert.equal(vectorHub.state.projects.length, 1, 'the index module holds exactly one registration');
    // 2. The repair only fills in what is missing and registers nothing twice.
    assert.equal(secondRepair.modules.terminal.ok, true, 'the terminal is still wired after the second repair');
    assert.equal(secondRepair.modules.terminal.reused, true, 'the second repair reuses the terminal registration instead of creating a second one');
    assert.equal(terminal.state.projects.length, 1, 'the terminal still holds exactly one registration');
    assert.equal(eventBridge.state.projects.length, 0, 'the event bridge still holds no registration');
    assert.equal((await engineApi('/api/projects')).body.projects.length, 0, 'the knowledge engine still holds no registration');
    assert.equal((await api('GET', '/api/projects/aggregated')).body.projects.length, 1, 'the product still holds exactly one project');
    const afterRepair = (await api('GET', '/api/projects/aggregated')).body.projects[0];
    assert.equal(afterRepair.modules.terminal.registered, true, 'the product reports the terminal as wired');
    assert.equal(afterRepair.modules.vectorHub.registered, true, 'the product reports the index module as wired');
    assert.equal(afterRepair.modules.eventBridge.registered, false, 'the product reports the event bridge as not wired');
    assert.equal(afterRepair.modules.engine.registered, false, 'the product reports the knowledge engine as not wired');
    assert.equal(browser.exceptions.length, 0, 'no uncaught product JavaScript exceptions');

    console.log('project-module-partial-recovery-test PASS (the registration is kept while the four modules fail; recovering one module and repairing registers only the failed module and nothing twice)');
  } finally {
    await browser?.close();
    await server.cleanup();
    await engine.close().catch(() => {});
    await engineProxy.close();
    for (const fixtureService of [terminal, vectorHub, eventBridge]) await fixtureService.close();
    fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
