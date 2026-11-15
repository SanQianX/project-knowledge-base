'use strict';
// 第五模块（独立工作流）接线合同（W1）：
// - /api/workflow/<rest> 改写到模块 /api/workflow/v1/<rest>；
// - 模块身份探测（MODULE_IDENTITY.workflow）按 name+apiVersion 判定，
//   外来服务占用端口时判 foreign，不误认、不抢端口；
// - 模块未安装（resolveModuleEntry null）时：不产生受管 spec、四模块
//   spec 不受影响，modulesHealth 如实报 installed:false；
// - /workflow-ui/ 页面代理仅 GET、拒绝编码分隔符与 api/internal 段；
// - 模块不可达时代理返回结构化 502，不影响其他模块路由。
// 真实 tarball 安装级验证（五模块同装）在 W8 前以隔离 prefix 单独执行，
// 不在本文件伪造。
const assert = require('node:assert/strict');
const http = require('node:http');
const { Readable } = require('node:stream');
const { EventEmitter } = require('node:events');
const { ModuleBridge } = require('../lib/module-bridge');

function workflowInstalled() {
  try { require.resolve('@sanqianx/ai-coding-workflow/src/bin.js'); return true; } catch { return false; }
}

(async () => {
  // 1) URL rewrite contract.
  const bridge = new ModuleBridge({ workflowUrl: 'http://127.0.0.1:5810' });
  assert.equal(bridge._workflowApi('/api/workflow/team'), 'http://127.0.0.1:5810/api/workflow/v1/team');
  assert.equal(bridge._workflowApi('/api/workflow'), 'http://127.0.0.1:5810/api/workflow/v1/');

  // 2) Identity classification against a REAL workflow-shaped health body and
  //    a foreign listener.
  const workflowBody = JSON.stringify({ ok: true, name: 'ai-coding-workflow', version: '0.1.0', apiVersion: 'v1', capabilities: {} });
  const foreignBody = JSON.stringify({ ok: true, name: 'something-else', apiVersion: 'v1' });
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(req.url === '/api/health?foreign=1' ? foreignBody : workflowBody);
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const port = upstream.address().port;
  try {
    assert.equal(await bridge._probeClass(`http://127.0.0.1:${port}`, 'workflow'), 'module', 'a real workflow health body classifies as our module');
    // A dedicated foreign listener: same shape, wrong identity.
    const foreignServer = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(foreignBody); });
    await new Promise(resolve => foreignServer.listen(0, '127.0.0.1', resolve));
    try {
      assert.equal(await bridge._probeClass(`http://127.0.0.1:${foreignServer.address().port}`, 'workflow'), 'foreign', 'an identity mismatch is foreign, never reused');
    } finally { foreignServer.closeAllConnections(); await new Promise(resolve => foreignServer.close(resolve)); }
  } finally { upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); }

  // 3) Optional-module degradation: without the package installed the
  //    supervisor builds no workflow spec and health reports not installed.
  const specs = bridge._supervisedSpecs();
  if (!workflowInstalled()) {
    assert.ok(!specs.some(spec => spec.name === 'workflow'), 'no workflow spec when the runtime is not installed');
  } else {
    assert.ok(specs.some(spec => spec.name === 'workflow'), 'an installed workflow runtime gets a supervised spec');
    assert.match(specs.find(spec => spec.name === 'workflow').command, /ai-coding-workflow.*serve/, 'the spec launches the workflow CLI');
  }
  for (const pinned of ['terminal', 'vector-hub', 'event-bridge', 'knowledge-engine']) {
    assert.ok(specs.some(spec => spec.name === pinned), `pinned module ${pinned} keeps its spec`);
  }
  const health = await bridge.modulesHealth();
  assert.ok(health.modules.workflow, 'health lists the workflow module');
  assert.equal(health.modules.workflow.installed, workflowInstalled(), 'installed reflects package presence');

  // 4) Workflow UI proxy: GET-only, rejects encoded separators and api/internal
  //    segments, accepts the bare entry.
  const uiUpstream = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<html>AI 团队</html>');
  });
  await new Promise(resolve => uiUpstream.listen(0, '127.0.0.1', resolve));
  const uiBridge = new ModuleBridge({ workflowUrl: `http://127.0.0.1:${uiUpstream.address().port}` });
  const shellUi = http.createServer((req, res) => {
    const match = req.url.match(/^\/workflow-ui\/?(.*)$/);
    if (!match || req.method !== 'GET') { res.statusCode = 404; res.end('Not found'); return; }
    return uiBridge.proxyModuleUi(req, res, 'workflow', match[1], '');
  });
  await new Promise(resolve => shellUi.listen(0, '127.0.0.1', resolve));
  try {
    const page = await fetch(`http://127.0.0.1:${shellUi.address().port}/workflow-ui/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /AI 团队/);
    for (const bad of ['/workflow-ui/app.js/../../package.json', '/workflow-ui/%2e%2e/secret', '/workflow-ui/api/health', '/workflow-ui/internal/x']) {
      const response = await fetch(`http://127.0.0.1:${shellUi.address().port}${bad}`);
      assert.notEqual(response.status, 200, `${bad} must not proxy`);
    }
    const post = await fetch(`http://127.0.0.1:${shellUi.address().port}/workflow-ui/`, { method: 'POST' });
    assert.equal(post.status, 404, 'the UI proxy is GET-only');
  } finally {
    shellUi.closeAllConnections(); await new Promise(resolve => shellUi.close(resolve));
    uiUpstream.closeAllConnections(); await new Promise(resolve => uiUpstream.close(resolve));
  }

  // 5) Unreachable module yields a structured 502 without breaking the bridge.
  const deadBridge = new ModuleBridge({ workflowUrl: 'http://127.0.0.1:1' });
  const req = Readable.from([]); req.method = 'GET'; req.headers = {};
  const res = new EventEmitter(); res.writeHead = () => {}; res.end = bytes => { res.writableEnded = true; res.body = JSON.parse(bytes); };
  await deadBridge.proxy(req, res, deadBridge._workflowApi('/api/workflow/team'));
  assert.equal(res.body.error, 'MODULE_UNREACHABLE');
  assert.equal(res.body.details.failureKind, 'NETWORK_ERROR');

  console.log('workflow-module-wiring-test PASS');
})().catch(error => { console.error(error); process.exitCode = 1; });
