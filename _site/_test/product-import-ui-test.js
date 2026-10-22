'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawnSync } = require('node:child_process');
const { spawnServer } = require('./helpers/spawn-server');
const { findChrome } = require('./helpers/find-chrome');
const { launchCdpBrowser, waitFor } = require('./helpers/cdp-browser');
const { attachNetworkCapture } = require('./helpers/cdp-network-capture');

const ROOT = path.resolve(__dirname, '../..');
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-product-import-ui-'));
const dataDir = path.join(fixture, 'data');
const repo = path.join(fixture, '中文 空格项目');
const knowledgeRoot = path.join(fixture, '知识目录');
const knowledge = path.join(knowledgeRoot, '项目知识');
const git = args => {
  const result = spawnSync('git', args, { cwd: repo, windowsHide: true, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
};
const gitIn = (dir, args) => {
  const result = spawnSync('git', args, { cwd: dir, windowsHide: true, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
};
async function main() {
  fs.mkdirSync(repo); fs.mkdirSync(knowledgeRoot);
  git(['init', '-q']); git(['config', 'user.email', 'ui-regression@local.invalid']); git(['config', 'user.name', 'UI Regression']);
  fs.writeFileSync(path.join(repo, 'README.md'), '# UI regression baseline\n'); git(['add', '.']); git(['commit', '-qm', 'baseline']);
  const baseline = git(['rev-parse', 'HEAD']);
  // Offline modules are intentional: retain registration and report partial
  // wiring, rather than fabricate successful links.
  const offline = http.createServer((req, res) => { res.writeHead(503, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: { code: 'MODULE_OFFLINE', message: '验收中的离线模块' } })); });
  await new Promise(resolve => offline.listen(0, '127.0.0.1', resolve));
  const offlineUrl = `http://127.0.0.1:${offline.address().port}`;
  const port = 7960 + process.pid % 200;
  const base = `http://127.0.0.1:${port}`;
  const server = spawnServer({ root: ROOT, port, dataDir, tag: 'product-import-ui', analysisOwner: 'engine', extraEnv: {
    KB_MODULES_REGISTER: '1', KB_TERMINAL_URL: offlineUrl, KB_VECTORHUB_URL: offlineUrl,
    KB_EVENTBRIDGE_URL: offlineUrl, KB_KNOWLEDGE_ENGINE_URL: offlineUrl,
  } });
  let browser;
  const api = async route => { const response = await fetch(base + route, { signal: AbortSignal.timeout(10000) }); assert.ok(response.ok, route); return response.json(); };
  try {
    await waitFor(async () => { try { return (await api('/api/health')).ok; } catch { return false; } }, 'isolated shell', 20000);
    browser = await launchCdpBrowser({ chrome: findChrome(), profileDir: path.join(fixture, 'browser'), url: base, width: 1920, height: 1080 });
    await browser.setViewport(1920, 1080);
    const capture = attachNetworkCapture(browser);
    await capture.enable();
    const run = expression => browser.evaluate(expression);
    const click = selector => run(`document.querySelector(${JSON.stringify(selector)}).click()`);
    const fill = (selector, value) => run(`(() => { const field=document.querySelector(${JSON.stringify(selector)}); field.value=${JSON.stringify(value)}; field.dispatchEvent(new Event('input',{bubbles:true})); })()`);
    await waitFor(() => run("document.getElementById('homeContent').textContent.includes('第一个项目')"), 'real empty state');
    for (const view of ['work', 'search', 'memory', 'projects', 'activity', 'home']) {
      await click(`[data-view="${view}"]`);
      assert.equal(await run(`document.getElementById('view-${view}').classList.contains('active')`), true);
      assert.equal(await run('document.documentElement.scrollWidth > innerWidth'), false, `desktop overflow in ${view}`);
    }
    await click('#themeToggle'); assert.equal(await run('document.documentElement.dataset.theme'), 'dark');
    await click('[data-view="projects"]'); await click('#createDomain');
    // PRJ-001: an empty name is refused in the browser itself, so no request
    // ever reaches the product and no domain is persisted.
    await fill('#domainForm input[name="name"]', '');
    await click('#domainForm button[type="submit"]');
    await new Promise(resolve => setTimeout(resolve, 400));
    assert.equal(await run("document.getElementById('domainDialog').open"), true, 'an empty domain name must not close the dialog');
    assert.equal(await run("document.getElementById('domainForm').checkValidity()"), false, 'the domain form reports an empty name as invalid');
    assert.equal(capture.find(entry => entry.method === 'POST' && entry.url.endsWith('/api/domains')).length, 0, 'an empty domain name must not reach the product');
    assert.equal(((await api('/api/settings')).settings.brain.domains || []).length, 0, 'an empty domain name must not persist a domain');
    await fill('#domainForm input[name="name"]', '回归领域'); await click('#domainForm button[type="submit"]');
    await waitFor(() => run("!document.getElementById('domainDialog').open && document.getElementById('projectTree').textContent.includes('回归领域')"), 'domain persisted from UI');
    const domainsOnDisk = JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8')).brain.domains || [];
    assert.ok(domainsOnDisk.some(domain => domain.name === '回归领域'), 'the domain is persisted on disk');
    assert.equal(capture.find(entry => entry.method === 'POST' && entry.url.endsWith('/api/domains')).length, 1, 'only the named domain reached the product');
    assert.equal((await api('/api/projects/aggregated')).projects.length, 0, 'creating a domain must not create a Git project');
    assert.ok(!fs.existsSync(path.join(dataDir, 'projects.json')) || Object.keys(JSON.parse(fs.readFileSync(path.join(dataDir, 'projects.json'), 'utf8')).projects || {}).length === 0, 'the project registry stays empty after a domain is created');
    await click('.view.active [data-action="import"]');
    assert.equal(await run("document.getElementById('confirmImport').disabled"), true, 'the import stays disabled before a preflight is ready');
    assert.equal(await run("document.getElementById('pickCode').hidden || document.getElementById('pickKnowledge').hidden"), false);
    await fill('#importCode', repo); await fill('#importName', '回归项目'); await fill('#importKnowledge', knowledge);
    const domainId = await run("[...document.getElementById('importDomain').options].find(o=>o.textContent==='回归领域').value");
    await run(`document.getElementById('importDomain').value=${JSON.stringify(domainId)}`);
    await waitFor(() => run("!document.getElementById('setupImportRoot').hidden"), 'root missing action');
    assert.equal(await run("document.getElementById('confirmImport').disabled"), true, 'the import stays disabled while the knowledge root is missing');
    await click('#setupImportRoot'); await fill('#knowledgeRoot', knowledgeRoot); await click('#saveBrainSettings');
    await waitFor(() => run("document.getElementById('importDialog').open && !document.getElementById('confirmImport').disabled"), 'setup returns to ready import');
    const values = await run("Object.fromEntries(['importCode','importKnowledge','importName','importDomain'].map(id=>[id,document.getElementById(id).value]))");
    assert.deepEqual(values, { importCode: repo, importKnowledge: knowledge, importName: '回归项目', importDomain: domainId }, 'the original import inputs survive the knowledge-root round trip');
    // PRJ-002/PRJ-003: the import id travels with the preflight and must
    // survive the knowledge-root round trip unchanged.
    const preflightRequest = capture.lastApi('POST', '/api/projects/preflight-import');
    assert.ok(preflightRequest && preflightRequest.body && typeof preflightRequest.body.projectId === 'string' && preflightRequest.body.projectId, 'the preflight request carries the import id');
    const preflightResponse = await capture.body(preflightRequest);
    assert.ok(preflightResponse && preflightResponse.ready === true, 'the preflight that enables the import reports ready');
    const racedHook = path.join(repo, '.git', 'hooks', 'post-commit');
    fs.writeFileSync(racedHook, '#!/bin/sh\necho third-party fixture\n');
    await click('#confirmImport');
    await waitFor(() => run("document.getElementById('preflightStatus').textContent.includes('HOOK_CONFLICT') && document.getElementById('preflightStatus').textContent.includes('操作 ID：op-')"), 'durable import failure feedback');
    await new Promise(resolve => setTimeout(resolve, 750));
    assert.ok(await run("document.getElementById('preflightStatus').textContent.includes('HOOK_CONFLICT')"), 'failed import must not turn back into a passed preflight');
    assert.equal((await api('/api/projects/aggregated')).projects.length, 0, 'the refused import registers no project');
    assert.equal(fs.readFileSync(racedHook, 'utf8'), '#!/bin/sh\necho third-party fixture\n', 'the third-party Hook bytes are preserved');
    const failureLogs = (await api('/api/logs?event=project.import.failed')).entries;
    assert.equal(failureLogs.length, 1, 'the failed import is persisted as one failure record'); assert.equal(failureLogs[0].error.code, 'HOOK_CONFLICT');
    assert.ok(await run(`document.getElementById('preflightStatus').textContent.includes(${JSON.stringify(failureLogs[0].operationId)})`), 'UI operation ID resolves to the persisted failure');
    fs.unlinkSync(racedHook);
    await click('#confirmImport');
    await waitFor(() => run("!document.getElementById('importDialog').open && document.getElementById('projectDetail').textContent.includes('回归项目')"), 'import feedback', 30000);
    const selected = await run("document.getElementById('projectSelect').value");
    const project = (await api('/api/projects/aggregated')).projects.find(p => p.projectId === selected);
    assert.ok(project && Object.values(project.modules).every(module => !module.registered));
    assert.equal((await api('/api/projects/aggregated')).projects.length, 1, 'the knowledge-root round trip must not create a second project');
    assert.equal(path.resolve(project.workspacePath), path.resolve(repo)); assert.equal(path.resolve(project.knowledgePath), path.resolve(knowledge));
    assert.equal(project.domainId, domainId);
    // PRJ-002: the four modules are reported one by one, each with its own
    // status, both in the import result and in the registered project view.
    const importRequest = capture.lastApi('POST', '/api/projects/import');
    assert.ok(importRequest && importRequest.body && importRequest.body.projectId, 'the import request carries the import id');
    assert.equal(importRequest.body.projectId, preflightRequest.body.projectId, 'the import id survives the knowledge-root round trip');
    assert.equal(selected, importRequest.body.projectId, 'the registered project keeps the import id');
    const importResponse = await capture.body(importRequest);
    assert.ok(importResponse, 'the import response is readable');
    assert.deepEqual(Object.keys(importResponse.modules).sort(), ['engine', 'eventBridge', 'terminal', 'vectorHub'], 'the import reports each of the four modules separately');
    for (const moduleKey of ['engine', 'eventBridge', 'terminal', 'vectorHub']) {
      assert.equal(typeof importResponse.modules[moduleKey].status, 'string', `${moduleKey} reports its own status`);
    }
    assert.deepEqual(Object.keys(project.modules).sort(), ['engine', 'eventBridge', 'terminal', 'vectorHub'], 'the project view reports each of the four modules separately');
    for (const [moduleKey, module] of Object.entries(project.modules)) {
      assert.equal(module.registered, false, `${moduleKey} is not registered against the offline module`);
      assert.equal(typeof module.status, 'string', `${moduleKey} reports its own status`);
    }
    assert.ok(fs.existsSync(path.join(repo, '.git/hooks/post-commit')));
    assert.ok(fs.existsSync(knowledge)); assert.equal(git(['rev-parse', 'HEAD']), baseline, 'import must not commit or analyze history');
    // PRJ-002: the source history is left alone, and analysis starts from the
    // imported HEAD instead of walking older commits.
    assert.deepEqual(git(['log', '--format=%H']).split('\n').filter(Boolean), [baseline], 'import must not create or rewrite commits');
    const importedProject = (await api(`/api/projects/${selected}`)).project;
    assert.equal(importedProject.state.trackingStartCommit, baseline, 'analysis starts from the imported HEAD');
    assert.ok(!fs.existsSync(path.join(dataDir, 'runtime', 'processed-commits', selected)), 'import must not analyze the existing history');
    assert.match(await run("document.getElementById('toast').textContent"), /部分接线待恢复/);
    await click('.view.active [data-action="import"]'); await fill('#importCode', repo); await fill('#importKnowledge', knowledge);
    await waitFor(() => run("document.getElementById('preflightStatus').textContent.includes('此项目已导入')"), 'duplicate rejected');
    assert.equal(await run("document.getElementById('confirmImport').disabled"), true);
    assert.equal((await api('/api/projects/aggregated')).projects.length, 1);
    // PRJ-012: the other half of the case — the import itself succeeds, and
    // the registry read that follows it fails. The failure is injected at the
    // transport level in the browser (the answer is really lost), so the
    // product never sees a broken request and the page has to cope with a
    // read it never got.
    const repo2 = path.join(fixture, '第二个项目');
    const knowledge2 = path.join(knowledgeRoot, '第二个项目知识');
    fs.mkdirSync(repo2);
    gitIn(repo2, ['init', '-q']); gitIn(repo2, ['config', 'user.email', 'ui-regression@local.invalid']); gitIn(repo2, ['config', 'user.name', 'UI Regression']);
    fs.writeFileSync(path.join(repo2, 'README.md'), '# second project baseline\n'); gitIn(repo2, ['add', '.']); gitIn(repo2, ['commit', '-qm', 'baseline']);
    const fetchFaults = { armed: false, failed: [] };
    const onFetchMessage = raw => {
      let message; try { message = JSON.parse(String(raw)); } catch { return; }
      if (message.method !== 'Fetch.requestPaused') return;
      const { requestId, request } = message.params;
      if (fetchFaults.armed) {
        fetchFaults.failed.push({ url: request.url, at: Date.now() });
        browser.send('Fetch.failRequest', { requestId, errorReason: 'ConnectionFailed' }).catch(() => {});
        return;
      }
      browser.send('Fetch.continueRequest', { requestId }).catch(() => {});
    };
    browser.socket.on('message', onFetchMessage);
    await browser.send('Fetch.enable', { patterns: [{ urlPattern: '*projects/projection*' }] });
    await run(`(() => { window.__toasts = []; const el = document.getElementById('toast'); new MutationObserver(() => { const text = (el.textContent || '').trim(); if (text && window.__toasts[window.__toasts.length - 1] !== text) window.__toasts.push(text); }).observe(el, { childList: true, characterData: true, subtree: true }); })()`);
    await click('.view.active [data-action="import"]');
    await fill('#importCode', repo2); await fill('#importName', '第二个项目'); await fill('#importKnowledge', knowledge2);
    await waitFor(() => run("!document.getElementById('confirmImport').disabled"), 'the second preflight is ready', 20000);
    assert.equal((await api('/api/projects/aggregated')).projects.length, 1, 'the second import has not registered anything yet');
    const beforeSecondImport = capture.requests.length;
    fetchFaults.armed = true;
    await click('#confirmImport');
    await waitFor(() => fetchFaults.failed.length >= 1, 'the registry read that follows the import fails', 20000);
    await waitFor(() => run("!document.getElementById('importDialog').open"), 'the successful import closes the dialog', 20000);
    await waitFor(async () => (await run('window.__toasts || []')).some(text => text.includes('部分状态暂未刷新')), 'the failed registry read is reported', 20000);
    const requests = capture.requests;
    const importIndex = requests.findIndex((entry, index) => index >= beforeSecondImport && entry.method === 'POST' && entry.url.endsWith('/api/projects/import'));
    assert.ok(importIndex >= 0, 'the second import request is recorded');
    assert.equal(requests[importIndex].status, 201, 'the import itself succeeded');
    const readsAfterImport = requests.slice(importIndex + 1).filter(entry => entry.method === 'GET' && entry.url.includes('/api/projects/projection'));
    assert.ok(readsAfterImport.length >= 1, 'the import is followed by a registry read');
    assert.ok(readsAfterImport.every(entry => entry.status === null), 'every registry read after the import really failed at the transport level');
    assert.ok(fetchFaults.failed.length >= 1, 'the browser really lost the registry read');
    // The import created exactly one project; the failed read created nothing.
    const registered = (await api('/api/projects/aggregated')).projects;
    assert.equal(registered.length, 2, 'the successful import registers exactly one more project');
    assert.ok(registered.some(project => project.name === '第二个项目'), 'the second project is registered');
    // The page does not present the failed read as fresh state.
    assert.equal(await run("document.querySelectorAll('#projectTree [data-select-project]').length"), 1, 'the failed read leaves the project tree on the previous state');
    assert.equal(await run("document.getElementById('projectTree').textContent.includes('第二个项目')"), false, 'the failed read is not shown as a refreshed list');
    // A later read succeeds: the same import is not registered a second time.
    fetchFaults.armed = false;
    const laterRead = () => capture.find(entry => entry.method === 'GET' && entry.url.includes('/api/projects/projection') && entry.status === 200 && requests.indexOf(entry) > importIndex).length > 0;
    const readDeadline = Date.now() + 20000;
    while (!laterRead() && Date.now() < readDeadline) {
      await run("document.dispatchEvent(new Event('visibilitychange'))");
      await new Promise(resolve => setTimeout(resolve, 300));
    }
    assert.ok(laterRead(), 'the later registry read succeeds');
    await waitFor(() => run("document.getElementById('projectTree').textContent.includes('第二个项目')"), 'the refreshed project tree', 20000);
    assert.equal(await run("document.querySelectorAll('#projectTree [data-select-project]').length"), 2, 'the retry reads the same two projects and creates no third');
    assert.equal((await api('/api/projects/aggregated')).projects.length, 2, 'the product registry still holds exactly two projects');
    assert.ok(fs.existsSync(knowledge2), 'the second project keeps its knowledge directory');
    await browser.send('Fetch.disable');
    assert.equal(browser.exceptions.length, 0, 'no uncaught product JavaScript exceptions');
    console.log('product-import-ui-test PASS (1920×1080; real UI → registry/Hook/directories; offline module wiring remains partial)');
  } finally {
    await browser?.close(); await server.cleanup();
    offline.closeAllConnections(); await new Promise(resolve => offline.close(resolve));
    assert.equal(path.dirname(fixture), path.resolve(os.tmpdir())); assert.ok(path.basename(fixture).startsWith('pk-product-import-ui-'));
    fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}
main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
