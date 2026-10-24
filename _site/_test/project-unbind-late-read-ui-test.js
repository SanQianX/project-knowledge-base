'use strict';
// PRJ-010: a late registry read must not resurrect an unbound project.
//
// The steps of the case are "hold the registry read, complete the unbind, then
// let the held read answer". The expectations are:
//   1. the old answer must not bring the unbound project back;
//   2. a later refresh still shows the project as unbound;
//   3. the other project is untouched.
//
// The instance is an isolated product server with its own data directory, its
// own knowledge root and its own module URLs. The browser runs in a new
// Chrome profile. The product is reached through a pass-through proxy that
// can hold exactly one response, so the late read is a real HTTP answer that
// arrives after the unbind — the proxy forwards bodies and responses verbatim
// and only decides when the answer is delivered.
//
// The knowledge engine is the real vendored module; the three other modules
// are local fixtures that answer 503, so only the engine participates.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { spawnServer } = require('./helpers/spawn-server');
const { findChrome } = require('./helpers/find-chrome');
const { launchCdpBrowser, waitFor } = require('./helpers/cdp-browser');
const { attachNetworkCapture } = require('./helpers/cdp-network-capture');
const { createModuleFixture, createUpstreamProxy, createProductProxy } = require('./helpers/module-fixture');
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
  git(repo, ['config', 'user.email', 'late-read@local.invalid']);
  git(repo, ['config', 'user.name', 'Late Read Regression']);
  fs.writeFileSync(path.join(repo, 'README.md'), `# ${name}\n`);
  git(repo, ['add', '.']); git(repo, ['commit', '-qm', 'baseline']);
  return repo;
}

async function main() {
  // Driver isolation FIRST (Chrome captured before the wipe), before any
  // product module is required.
  const applied = applyDriverIsolation({ prefix: 'pk-qa-prj-late-read', captureChrome: true });
  const fixture = fs.mkdtempSync(path.join(applied.layout.temp, 'pk-prj-late-read-'));
  const dataDir = path.join(fixture, 'data');
  const knowledgeRoot = path.join(fixture, 'knowledge');
  const repoA = makeRepo(fixture, 'repo-unbound');
  const repoB = makeRepo(fixture, 'repo-untouched');
  const knowledgeA = path.join(knowledgeRoot, '迟到读项目');
  const knowledgeB = path.join(knowledgeRoot, '无关项目');
  fs.mkdirSync(knowledgeA, { recursive: true }); fs.mkdirSync(knowledgeB, { recursive: true });

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

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const server = spawnServer({
    root: ROOT,
    port,
    dataDir,
    tag: 'project-late-read',
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

  // The browser talks to the product through this proxy: it can hold one
  // answer and release it later, which is the late read of the case.
  const productProxy = createProductProxy({ target: base, tag: 'product' });
  await productProxy.start();

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
    await waitFor(async () => {
      try { return (await api('GET', '/api/health')).status === 200; } catch { return false; }
    }, 'the isolated product instance', 20000);
    assert.equal((await api('PATCH', '/api/settings', { knowledge: { rootPath: knowledgeRoot } })).status, 200);

    const importedA = await api('POST', '/api/projects/import', { localPath: repoA, knowledgePath: knowledgeA, displayName: '迟到读项目' });
    assert.equal(importedA.status, 201, JSON.stringify(importedA.body));
    const projectA = importedA.body.projectId;
    const importedB = await api('POST', '/api/projects/import', { localPath: repoB, knowledgePath: knowledgeB, displayName: '无关项目' });
    assert.equal(importedB.status, 201, JSON.stringify(importedB.body));
    const projectB = importedB.body.projectId;
    assert.ok(projectA && projectB && projectA !== projectB);

    browser = await launchCdpBrowser({ chrome: findChrome(), profileDir: path.join(fixture, 'browser'), url: productProxy.url, width: 1440, height: 900 });
    await browser.setViewport(1440, 900);
    const capture = attachNetworkCapture(browser);
    await capture.enable();
    const run = expression => browser.evaluate(expression);
    const click = selector => run(`document.querySelector(${JSON.stringify(selector)}).click()`);
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

    await waitFor(() => run("document.getElementById('homeContent').textContent.includes('迟到读项目') && document.getElementById('homeContent').textContent.includes('无关项目')"), 'both projects in the browser');
    await click('[data-view="projects"]');
    await waitFor(() => run(`document.getElementById('projectTree').textContent.includes('迟到读项目')`), 'the project tree');
    await click(`[data-select-project="${projectA}"]`);
    await waitFor(() => run("document.getElementById('projectDetail').textContent.includes('迟到读项目')"), 'the project detail');
    assert.ok(await run("document.getElementById('projectDetail').querySelector('[data-action=\"unbind\"]') !== null"), 'the unbound project offers the unbind action');

    // Open the unbind dialog, then hold the next registry read. The held
    // answer is the one the browser started before the DELETE.
    await click('[data-action="unbind"]');
    await waitFor(() => run("document.getElementById('unbindDialog').open === true"), 'the unbind dialog');
    const projectionReads = () => capture.find(entry => entry.method === 'GET' && entry.url.includes('/api/projects/projection'));
    const readsBefore = projectionReads().length;
    productProxy.hold(entry => entry.method === 'GET' && entry.path.startsWith('/api/projects/projection'), { once: true });
    // The registry read that follows the unbind fails on purpose: then the
    // late answer is the only successful read after the unbind, and the UI
    // state cannot be silently cleaned up by a later read.
    productProxy.fail(entry => entry.method === 'GET' && entry.path.startsWith('/api/projects/projection'), 503, '注入的注册读取故障', { once: true });

    const heldDeadline = Date.now() + 8000;
    while (productProxy.heldCount() === 0 && Date.now() < heldDeadline) {
      await run("document.dispatchEvent(new Event('visibilitychange'))");
      await wait(100);
    }
    assert.equal(productProxy.heldCount(), 1, 'exactly one registry read must be held');
    const heldRequest = productProxy.state.requests.find(entry => entry.method === 'GET' && entry.path.startsWith('/api/projects/projection'));
    assert.ok(heldRequest, 'the held registry read is recorded by the proxy');
    const heldAt = heldRequest.at;

    // The unbind itself runs in the browser, against the real product.
    await click('#confirmUnbind');
    const deleteRequest = await waitFor(() => productProxy.state.requests.find(entry => entry.method === 'DELETE' && entry.path.includes(`/api/projects/${encodeURIComponent(projectA)}`)) || null, 'the unbind request', 15000);
    // The unbind ends with a forced registry refresh. That refresh opens a
    // new read epoch, so once it is under way the held read is old. The
    // browser queues that read behind the held connection, so the epoch
    // change is observed through the sibling read of the same refresh.
    const laterRefresh = await waitFor(() => productProxy.state.requests.find(entry => entry.method === 'GET' && entry.path === '/api/brain' && entry.at > deleteRequest.at) || null, 'the registry refresh after the unbind', 15000);
    assert.ok(heldAt < deleteRequest.at, 'the held read started before the unbind');
    assert.ok(deleteRequest.at < laterRefresh.at, 'the unbind precedes the registry refresh that follows it');

    // Now the old answer is delivered: it still lists the unbound project.
    const heldPayload = JSON.parse(productProxy.state.held[0].payload.toString('utf8'));
    assert.equal(heldPayload.projects.some(project => project.projectId === projectA), true, 'the held answer is the old list, it still contains the unbound project');
    const released = productProxy.releaseHeld();
    const releasedAt = Date.now();
    assert.equal(released, 1, 'the held answer is delivered after the unbind');
    assert.ok(releasedAt - heldAt < 3000, `the late answer must arrive inside the browser read timeout (gap ${releasedAt - heldAt}ms), otherwise the case proves nothing`);

    await waitFor(() => run("document.getElementById('toast').textContent.includes('项目已从列表移除')"), 'the unbind to finish', 20000);

    const heldCaptureEntry = await waitFor(() => projectionReads().length > readsBefore ? projectionReads()[readsBefore] : null, 'the held registry read in the browser', 5000);
    await waitFor(() => heldCaptureEntry.status !== null, 'the late answer to reach the browser', 5000);
    assert.equal(heldCaptureEntry.status, 200, 'the late answer is a real successful registry read');
    await wait(500);

    // 1. The old answer must not bring the unbound project back. Switching the
    //    view re-renders the project list from the UI state, so a resurrected
    //    entry would show up in the tree and in the home list.
    await click('[data-view="home"]');
    await waitFor(() => run("document.getElementById('homeContent').textContent.includes('无关项目')"), 'the home list');
    assert.equal(await run("document.getElementById('homeContent').textContent.includes('迟到读项目')"), false, 'the old answer must not resurrect the unbound project');
    assert.equal(await run("document.getElementById('homeContent').textContent.includes('无关项目')"), true, 'the other project stays listed');
    await click('[data-view="projects"]');
    await waitFor(() => run("document.getElementById('projectTree').textContent.includes('无关项目')"), 'the project tree after the late answer');
    assert.equal(await run("document.getElementById('projectTree').textContent.includes('迟到读项目')"), false, 'the unbound project must not reappear in the tree');

    // The product itself dropped the project, and the engine dropped it too.
    const aggregated = (await api('GET', '/api/projects/aggregated')).body.projects;
    assert.equal(aggregated.some(project => project.projectId === projectA), false, 'the product must not register the unbound project');
    assert.equal(aggregated.some(project => project.projectId === projectB), true, 'the other project stays registered');

    // 2. A later refresh still shows the project as unbound.
    const before = capture.find(entry => entry.method === 'GET' && entry.url.includes('/api/projects/projection')).length;
    await run("document.dispatchEvent(new Event('visibilitychange'))");
    await waitFor(() => capture.find(entry => entry.method === 'GET' && entry.url.includes('/api/projects/projection')).length > before, 'the later refresh read', 10000);
    await wait(600);
    await click('[data-view="home"]');
    await waitFor(() => run("document.getElementById('homeContent').textContent.includes('无关项目')"), 'the home list after the later refresh');
    assert.equal(await run("document.getElementById('homeContent').textContent.includes('迟到读项目')"), false, 'the project stays unbound after a later refresh');

    // 3. The other project is untouched: it is still registered in the product
    //    and in the real engine, and its files stayed on disk.
    const engineProjects = (await engineApi('GET', '/api/projects')).body.projects;
    assert.equal(engineProjects.some(project => project.projectId === projectA), false, 'the engine drops the unbound project');
    assert.equal(engineProjects.some(project => project.projectId === projectB), true, 'the engine keeps the other project');
    assert.ok(fs.existsSync(path.join(repoA, 'README.md')), 'the unbound project keeps its code');
    assert.ok(fs.existsSync(knowledgeA), 'the unbound project keeps its knowledge directory');
    assert.ok(fs.existsSync(path.join(repoB, 'README.md')), 'the other project keeps its code');
    assert.equal(browser.exceptions.length, 0, 'no uncaught product JavaScript exceptions');

    console.log('project-unbind-late-read-ui-test PASS (the held registry read arrives after the unbind and does not resurrect the project; the other project is untouched)');
  } finally {
    await browser?.close();
    await server.cleanup();
    await productProxy.close();
    await engine.close().catch(() => {});
    await engineProxy.close();
    for (const fixtureService of [terminal, vectorHub, eventBridge]) await fixtureService.close();
    fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
