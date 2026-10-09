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
    await fill('#domainForm input[name="name"]', '回归领域'); await click('#domainForm button[type="submit"]');
    await waitFor(() => run("!document.getElementById('domainDialog').open && document.getElementById('projectTree').textContent.includes('回归领域')"), 'domain persisted from UI');
    await click('.view.active [data-action="import"]');
    assert.equal(await run("document.getElementById('confirmImport').disabled"), true);
    assert.equal(await run("document.getElementById('pickCode').hidden || document.getElementById('pickKnowledge').hidden"), false);
    await fill('#importCode', repo); await fill('#importName', '回归项目'); await fill('#importKnowledge', knowledge);
    const domainId = await run("[...document.getElementById('importDomain').options].find(o=>o.textContent==='回归领域').value");
    await run(`document.getElementById('importDomain').value=${JSON.stringify(domainId)}`);
    await waitFor(() => run("!document.getElementById('setupImportRoot').hidden"), 'root missing action');
    assert.equal(await run("document.getElementById('confirmImport').disabled"), true);
    await click('#setupImportRoot'); await fill('#knowledgeRoot', knowledgeRoot); await click('#saveBrainSettings');
    await waitFor(() => run("document.getElementById('importDialog').open && !document.getElementById('confirmImport').disabled"), 'setup returns to ready import');
    const values = await run("Object.fromEntries(['importCode','importKnowledge','importName','importDomain'].map(id=>[id,document.getElementById(id).value]))");
    assert.deepEqual(values, { importCode: repo, importKnowledge: knowledge, importName: '回归项目', importDomain: domainId });
    await click('#confirmImport');
    await waitFor(() => run("!document.getElementById('importDialog').open && document.getElementById('projectDetail').textContent.includes('回归项目')"), 'import feedback', 30000);
    const selected = await run("document.getElementById('projectSelect').value");
    const project = (await api('/api/projects/aggregated')).projects.find(p => p.projectId === selected);
    assert.ok(project && Object.values(project.modules).every(module => !module.registered));
    assert.equal(path.resolve(project.workspacePath), path.resolve(repo)); assert.equal(path.resolve(project.knowledgePath), path.resolve(knowledge));
    assert.equal(project.domainId, domainId);
    assert.ok(fs.existsSync(path.join(repo, '.git/hooks/post-commit')));
    assert.ok(fs.existsSync(knowledge)); assert.equal(git(['rev-parse', 'HEAD']), baseline, 'import must not commit or analyze history');
    assert.match(await run("document.getElementById('toast').textContent"), /部分接线待恢复/);
    await click('.view.active [data-action="import"]'); await fill('#importCode', repo); await fill('#importKnowledge', knowledge);
    await waitFor(() => run("document.getElementById('preflightStatus').textContent.includes('此项目已导入')"), 'duplicate rejected');
    assert.equal(await run("document.getElementById('confirmImport').disabled"), true);
    assert.equal((await api('/api/projects/aggregated')).projects.length, 1);
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
