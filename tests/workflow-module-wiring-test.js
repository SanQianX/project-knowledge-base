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
const { ModuleBridge } = require('../src/module_bridge/module-bridge');

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
    // M0-C: the managed workflow module receives the Bridge URL so its
    // independent consumer registers with a wake-up callback — exactly like
    // the terminal/workbench/engine specs already do.
    const workflowSpec = specs.find(spec => spec.name === 'workflow');
    assert.equal(workflowSpec.env.KB_EVENT_BRIDGE_URL, bridge.eventBridgeUrl, 'the workflow spec carries KB_EVENT_BRIDGE_URL');
    assert.equal(workflowSpec.env.KB_WORKFLOW_RUNTIME_TOKEN, bridge.runtimeToken, 'the workflow spec carries the runtime token');
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

  // 6) M0-C trusted review forward: the shell resolves the registered project
  //    through its own read-only resolver and attaches ITS runtime token plus
  //    the canonical Git root; the caller's own token header is never
  //    forwarded as module trust. Verified against a REAL workflow module
  //    (installed pinned package, or KB_WORKFLOW_TEST_SOURCE candidate).
  let upstreamWorkflow = null;
  const path = require('node:path');
  try {
    const source = process.env.KB_WORKFLOW_TEST_SOURCE
      ? path.resolve(process.env.KB_WORKFLOW_TEST_SOURCE)
      : require.resolve('@sanqianx/ai-coding-workflow/src/server', { paths: [path.resolve(__dirname, '..')] });
    upstreamWorkflow = require(source).createWorkflowServer;
  } catch {
    upstreamWorkflow = null;
  }
  if (!upstreamWorkflow) {
    console.log('workflow-module-wiring-test: trusted-forward section skipped (no workflow module available)');
  } else {
    const fs = require('node:fs');
    const os = require('node:os');
    const childPath = require('node:path');
    const { spawnSync } = require('node:child_process');
    const moduleToken = 'module-runtime-token';
    const upstream = upstreamWorkflow({ dataDir: fs.mkdtempSync(childPath.join(os.tmpdir(), 'wf-wiring-')), runtimeToken: moduleToken });
    const bound = await upstream.listen(0);
    await fetch(`${bound.host === '127.0.0.1' ? 'http://127.0.0.1' : `http://${bound.host}`}:${bound.port}/api/workflow/v1/team`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId: 'wiring-seed' }) });
    const repo = fs.mkdtempSync(childPath.join(os.tmpdir(), 'wf-wiring-repo-'));
    const git = args => { const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' }); if (r.status !== 0) throw new Error(r.stderr); };
    git(['init', '-q', '-b', 'main']); git(['config', 'user.email', 't@t']); git(['config', 'user.name', 't']);
    fs.writeFileSync(childPath.join(repo, 'a.js'), 'export const a = 1;\n');
    git(['add', '.']); git(['commit', '-qm', 'init']);
    const seen = { authorization: null, runtimeToken: null, body: null };
    const forwardingBridge = new ModuleBridge({
      workflowUrl: `http://127.0.0.1:${bound.port}`,
      runtimeToken: moduleToken,
      workflowProjectResolver: input => ({ projectId: input.projectId || 'proj-wired', repoPath: repo }),
    });
    const shellProxy = http.createServer((req2, res2) => forwardingBridge.proxyWorkflow(req2, res2, req2.url.replace(/\?.*$/, ''), (req2.url.match(/\?.*$/) || [''])[0]));
    await new Promise(resolve => shellProxy.listen(0, '127.0.0.1', resolve));
    try {
      // Create a task through the same proxy, then request its review.
      const createdResponse = await fetch(`http://127.0.0.1:${shellProxy.address().port}/api/workflow/workflow-tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-KB-Runtime-Token': 'client-token-must-not-forward' },
        body: JSON.stringify({ requestId: 'wiring-task', projectId: 'proj-wired', title: '受信转发' }),
      });
      const created = await createdResponse.json().catch(() => ({}));
      assert.equal(createdResponse.status, 201, JSON.stringify(created));
      // The creation itself carries no canonicalGitRoot (only reviews do), so
      // the task stays unbound unless the review forwards the trusted root.
      const reviewResponse = await fetch(`http://127.0.0.1:${shellProxy.address().port}/api/workflow/workflow-tasks/${created.task.taskId}/reviews`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-KB-Runtime-Token': 'client-token-must-not-forward' },
        body: JSON.stringify({ requestId: 'wiring-review', projectId: 'proj-wired', repoPath: repo, tools: ['eslint'] }),
      });
      const reviewBody = await reviewResponse.json().catch(() => ({}));
      assert.ok(reviewResponse.status === 202 || reviewResponse.status === 201, `review via the shell proxy answers ${reviewResponse.status}: ${JSON.stringify(reviewBody).slice(0, 200)}`);
      if (reviewBody.reviewJobId) {
        const job = await (await fetch(`http://127.0.0.1:${bound.port}/api/workflow/v1/review-jobs/${reviewBody.reviewJobId}`, { headers: { 'X-KB-Runtime-Token': moduleToken } })).json();
        assert.equal(job.job.repoPath, fs.realpathSync(repo), 'the trusted forward bound the canonical root');
        assert.equal(job.job.tools[0], 'eslint');
        assert.equal(job.job.executionToken, undefined, 'the execution token never leaves the module');
      } else {
        // Old installed module: the POST answered with legacy receipts — the
        // forward still resolved the project through the shell.
        assert.ok(Array.isArray(reviewBody.receipts), 'the old module answers with receipts');
      }
    } finally {
      shellProxy.closeAllConnections(); await new Promise(resolve => shellProxy.close(resolve));
      await upstream.close();
    }
  }

  // 7) P2b: team-mode creation is trusted-forwarded ONLY for registered projects.
  {
    const path = require('node:path');
    const source = process.env.KB_WORKFLOW_TEST_SOURCE
      ? path.resolve(process.env.KB_WORKFLOW_TEST_SOURCE)
      : require.resolve('@sanqianx/ai-coding-workflow/src/server', { paths: [path.resolve(__dirname, '..')] });
    let createServer = null;
    try { createServer = require(source).createWorkflowServer; } catch { createServer = null; }
    if (!createServer) {
      console.log('workflow-module-wiring-test: P2b team-forward section skipped (no module)');
    } else {
      const fsx = require('node:fs');
      const osx = require('node:os');
      const { spawnSync } = require('node:child_process');
      const moduleToken = 'p2b-module-token';
      const upstream = createServer({ dataDir: fsx.mkdtempSync(path.join(osx.tmpdir(), 'p2b-wire-')), runtimeToken: moduleToken });
      const bound = await upstream.listen(0);
      const base = 'http://127.0.0.1:' + bound.port;
      await fetch(base + '/api/workflow/v1/team', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId: 'seed' }) });
      const repo = fsx.mkdtempSync(path.join(osx.tmpdir(), 'p2b-wire-repo-'));
      const git = a => { const r = spawnSync('git', ['-C', repo, ...a], { encoding: 'utf8' }); if (r.status !== 0) throw new Error(r.stderr); };
      git(['init', '-q', '-b', 'main']); git(['config', 'user.email', 't@t']); git(['config', 'user.name', 't']);
      fsx.writeFileSync(path.join(repo, 'a.js'), 'export const a = 1;' + String.fromCharCode(10));
      git(['add', '.']); git(['commit', '-qm', 'i']);
      // 注册受信根 + 开启 autoDispatch 的项目（受信 settings 写入）
      const authHeaders = { 'Content-Type': 'application/json', 'X-KB-Runtime-Token': moduleToken };
      await fetch(base + '/api/internal/project-roots', { method: 'POST', headers: authHeaders, body: JSON.stringify({ requestId: 'reg', projectId: 'proj-p2b', canonicalGitRoot: repo }) });
      const members = (await (await fetch(base + '/api/workflow/v1/members')).json()).members;
      await fetch(base + '/api/workflow/v1/projects/proj-p2b/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId: 'cfg', enabled: true, autoDispatch: true, leaderMemberId: members[0].memberId, developerMemberIds: [members[0].memberId] }) });
      const seenToken = { value: null };
      const bridge = new ModuleBridge({
        workflowUrl: base, runtimeToken: moduleToken,
        workflowProjectResolver: input => ({ projectId: input.projectId === 'proj-p2b' ? 'proj-p2b' : null, repoPath: input.projectId === 'proj-p2b' ? repo : null }),
      });
      // 用最小 http 服务驱动 proxyWorkflow
      const http = require('node:http');
      const shell = http.createServer((rq, rs) => bridge.proxyWorkflow(rq, rs, rq.url.split('?')[0], ''));
      await new Promise(r => shell.listen(0, '127.0.0.1', r));
      try {
        // 注册项目 + team → 受信（壳解析成功才带 token）→ 模块生效
        const okRes = await fetch('http://127.0.0.1:' + shell.address().port + '/api/workflow/workflow-tasks', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ requestId: 'team-ok', projectId: 'proj-p2b', title: '团队任务', executionMode: 'team' }),
        });
        const okJson = await okRes.json();
        // Capability-branched: the installed pinned module predates team
        // execution (its tasks have no executionMode) — only a module that
        // UNDERSTANDS team mode may be asserted to arm it.
        if (okJson.task && okJson.task.executionMode === 'team') {
          assert.equal(okJson.task.planStatus, 'pending-plan', 'team armed with a pending plan');
        } else {
          const health = await (await fetch(base + '/api/health')).json();
          assert.notEqual(health.capabilities && health.capabilities.teamExecution, true, 'a team-capable module must arm team mode through the trusted forward');
          console.log('workflow-module-wiring-test: P2b team-arm skipped (legacy module without team execution)');
        }
        // 未注册项目 + team → 壳不带 token → 模块静默降级
        const degradeRes = await fetch('http://127.0.0.1:' + shell.address().port + '/api/workflow/workflow-tasks', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ requestId: 'team-no', projectId: 'unregistered', title: '伪造团队', executionMode: 'team' }),
        });
        const degradeJson = await degradeRes.json();
        assert.notEqual(degradeJson.task && degradeJson.task.executionMode, 'team', 'unregistered project degrades to a plain task');
        assert.notEqual(degradeJson.task && degradeJson.task.planStatus, 'pending-plan');
      } finally {
        shell.closeAllConnections(); await new Promise(r => shell.close(r));
        await upstream.close();
      }
      console.log('workflow-module-wiring-test PASS (P2b: trusted team forward / unregistered degrade)');
    }
  }

  // 8) Page-maintained maintenance registry and member models (module 0.3.0+,
  // several repositories since 0.4.0): the shell is the only source of the
  // repository path and of the runtime token, and a member's model is verified
  // against the Workbench before the module stores it. Branched on the module's
  // declared capability — a module that predates the registry prints a skip
  // line, and a skip is never a pass.
  {
    const fs = require('node:fs');
    const os = require('node:os');
    const { spawnSync } = require('node:child_process');
    const source = process.env.KB_WORKFLOW_TEST_SOURCE
      ? path.resolve(process.env.KB_WORKFLOW_TEST_SOURCE)
      : require.resolve('@sanqianx/ai-coding-workflow/src/server', { paths: [path.resolve(__dirname, '..')] });
    const createServer = require(source).createWorkflowServer;
    const moduleToken = 'registry-module-token';
    const upstream = createServer({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'wf-registry-')), runtimeToken: moduleToken, maintenanceTiming: { pollMs: 100 } });
    const bound = await upstream.listen(0);
    const base = 'http://127.0.0.1:' + bound.port;
    const health = await (await fetch(base + '/api/health')).json();
    if (!health.capabilities.maintenanceRegistry) {
      await upstream.close();
      console.log('workflow-module-wiring-test: registry-forward section SKIPPED (the module predates the page-maintained registry)');
    } else {
      // 仓库按多个登记（模块 0.4.0 起）：固定的模块版本必须支持，不支持就直接失败，不悄悄跳过
      // repositories are registered as many (module 0.4.0+): the pinned module must support it — fail loudly, never skip quietly
      assert.ok(health.capabilities.multiRepoMaintenance, 'the pinned workflow module must support several repositories');
      const makeRepo = name => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), name));
        const git = args => { const r = spawnSync('git', ['-C', directory, ...args], { encoding: 'utf8' }); if (r.status !== 0) throw new Error(r.stderr); };
        git(['init', '-q', '-b', 'main']); git(['config', 'user.email', 't@t']); git(['config', 'user.name', 't']);
        fs.writeFileSync(path.join(directory, 'a.js'), 'export const a = 1;' + String.fromCharCode(10));
        git(['add', '.']); git(['commit', '-qm', 'i']);
        return directory;
      };
      const repo = makeRepo('wf-registry-repo-');
      const secondRepo = makeRepo('wf-registry-repo-second-');
      // A stand-in Workbench: only the profile list the shell reads to verify a model.
      const profiles = [
        { id: 'profile-ok', name: '可用档案', enabled: true, credentialConfigured: true, models: { default: 'model-ok', list: [{ id: 'model-ok' }, { id: 'model-ok-pro' }] } },
        { id: 'profile-disabled', name: '已停用', enabled: false, credentialConfigured: true, models: { default: 'model-disabled' } },
        { id: 'profile-no-key', name: '缺凭据', enabled: true, credentialConfigured: false, models: { default: 'model-no-key' } },
      ];
      const isProfileList = req => req.method === 'GET' && req.url.startsWith('/api/claude-workbench/v1/profiles');
      const workbench = http.createServer((req, res) => {
        res.writeHead(isProfileList(req) ? 200 : 404, { 'Content-Type': 'application/json' });
        res.end(isProfileList(req) ? JSON.stringify(profiles) : '{}');
      });
      await new Promise(resolve => workbench.listen(0, '127.0.0.1', resolve));
      const directories = { 'proj-reg': repo, 'proj-reg-2': secondRepo };
      const options = {
        workflowUrl: base, runtimeToken: moduleToken,
        workflowProjectResolver: input => (directories[input.projectId] ? { projectId: input.projectId, repoPath: directories[input.projectId] } : null),
      };
      // Two shells over the same module: one reaches the Workbench, one does not.
      // Each answers a refused forward the way the product handler does.
      const bridges = [
        new ModuleBridge({ ...options, terminalUrl: `http://127.0.0.1:${workbench.address().port}` }),
        new ModuleBridge({ ...options, terminalUrl: 'http://127.0.0.1:1' }),
      ];
      const { DomainError, serializeErrorEnvelope } = require('../src/common/contracts');
      const shells = bridges.map(bridge => {
        const server = http.createServer((req, res) => Promise.resolve(bridge.proxyWorkflow(req, res, req.url.split('?')[0], '')).catch(error => {
          res.writeHead(error instanceof DomainError ? error.status : 500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(serializeErrorEnvelope(error)));
        }));
        server.listen(0, '127.0.0.1');
        return server;
      });
      await Promise.all(shells.map(server => new Promise(resolve => server.once('listening', resolve))));
      const call = async (shell, route, body, headers = {}, method = 'POST') => {
        const response = await fetch(`http://127.0.0.1:${shell.address().port}/api/workflow/${route}`, {
          method: body ? method : 'GET', headers: { 'Content-Type': 'application/json', ...headers },
          body: body ? JSON.stringify(body) : undefined,
        });
        return { status: response.status, body: await response.json().catch(() => ({})) };
      };
      const [liveShell, blindShell] = shells;
      // A browser's own token header must never become module trust.
      const clientToken = { 'X-KB-Runtime-Token': 'client-token-must-not-forward' };
      const json = value => JSON.stringify(value);
      try {
        // Repository registration: the path comes only from the shell's resolution.
        const unknown = await call(liveShell, 'maintenance/repos', { requestId: 'repo-unknown', projectId: 'proj-unknown', repoPath: 'C:\\Windows' }, clientToken);
        assert.equal(unknown.status, 404, 'an unregistered project is refused before the module is asked');
        assert.equal((await call(liveShell, 'maintenance')).body.configured, false);
        const registered = await call(liveShell, 'maintenance/repos', { requestId: 'repo-ok', projectId: 'proj-reg', repoPath: 'C:\\Windows', branch: 'main', remote: '', allowPush: false }, clientToken);
        assert.equal(registered.status, 201, json(registered.body));
        const repoId = registered.body.repo && registered.body.repo.repoId;
        const status = (await call(liveShell, 'maintenance')).body;
        assert.equal(status.configured, true);
        assert.equal(status.repos[0].repoPath, fs.realpathSync(repo), 'the page-supplied path is replaced by the shell resolution');
        const direct = await fetch(base + '/api/workflow/v1/maintenance/repos', {
          method: 'POST', headers: { 'Content-Type': 'application/json', ...clientToken },
          body: json({ requestId: 'direct', projectId: 'proj-reg', repoPath: repo, branch: 'main', remote: '', allowPush: false }),
        });
        assert.equal(direct.status, 403, 'the module itself trusts only the token the shell holds');
        const updated = await call(liveShell, 'maintenance/repos/update', { requestId: 'repo-update', repoId, branch: 'main', remote: 'origin', allowPush: true, repoPath: 'C:\\Windows' }, clientToken);
        assert.equal(updated.status, 200, json(updated.body));
        const after = (await call(liveShell, 'maintenance')).body;
        assert.deepEqual([after.repos[0].allowPush, after.repos[0].remote, after.repos[0].repoPath], [true, 'origin', fs.realpathSync(repo)], 'an update cannot move the repository');
        const malformed = await fetch(`http://127.0.0.1:${liveShell.address().port}/api/workflow/maintenance/repos`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{not json' });
        assert.equal(malformed.status, 400);
        // Several repositories: a second project registers through the same trusted forward and is listed next to the first.
        const second = await call(liveShell, 'maintenance/repos', { requestId: 'repo-second', projectId: 'proj-reg-2', repoPath: 'C:\\Windows', branch: '', remote: '', allowPush: false }, clientToken);
        assert.equal(second.status, 201, json(second.body));
        const listed = (await call(liveShell, 'maintenance')).body.repos;
        assert.deepEqual(listed.map(item => [item.projectId, item.repoPath]), [['proj-reg', fs.realpathSync(repo)], ['proj-reg-2', fs.realpathSync(secondRepo)]]);
        assert.notEqual(second.body.repo.repoId, repoId);
        // 删除不需要路径，所以不经受信转发；页面上自带的令牌头不会因此变成模块的信任
        // removal needs no path, so it is not trusted-forwarded; the token header a page sends never becomes module trust
        const removed = await call(liveShell, 'maintenance/repos/delete', { requestId: 'repo-delete', repoId: second.body.repo.repoId }, clientToken);
        assert.equal(removed.status, 200, json(removed.body));
        assert.deepEqual((await call(liveShell, 'maintenance')).body.repos.map(item => item.repoId), [repoId]);

        // Member models: the shell verifies the profile and one of its listed models; the page's own driver never counts.
        const drafts = await call(liveShell, 'team', { requestId: 'seed', name: '登记团队', members: [{ name: '草稿成员', role: 'reviewer', profileId: 'profile-ok', model: 'page-lie' }] });
        assert.equal(drafts.status, 201, json(drafts.body));
        assert.deepEqual([drafts.body.members[0].profileId, drafts.body.members[0].model], [null, null], 'only the member routes carry a verified model');
        const created = await call(liveShell, 'members', { requestId: 'member-ok', name: '模型成员', role: 'reviewer', profileId: 'profile-ok', model: 'model-ok', driverId: 'page-driver' }, clientToken);
        assert.equal(created.status, 201, json(created.body));
        assert.deepEqual([created.body.member.profileId, created.body.member.model, created.body.member.driverId], ['profile-ok', 'model-ok', null]);
        const memberId = created.body.member.memberId;
        const patchMember = (shell, body) => call(shell, 'members/' + memberId, body, {}, 'PATCH');
        for (const profileId of ['profile-disabled', 'profile-no-key', 'profile-missing']) {
          const refused = await patchMember(liveShell, { requestId: 'refuse-' + profileId, profileId });
          assert.equal(refused.status, 400, `${profileId} must be refused: ${json(refused.body)}`);
        }
        const blind = await patchMember(blindShell, { requestId: 'workbench-down', profileId: 'profile-ok' });
        assert.equal(blind.status, 503, 'an unreachable Workbench is reported, never treated as a valid model');
        assert.equal(blind.body.error.code, 'MODULE_UNREACHABLE');
        const current = (await call(liveShell, 'members/' + memberId)).body.member;
        assert.deepEqual([current.profileId, current.model], ['profile-ok', 'model-ok'], 'refusals leave the stored reference untouched');
        // 模型须是这个档案列出的一个：页面自己编的、别的档案的，都不采信；只给档案就用它的默认模型。
        // The model must be one this profile lists: one the page makes up, or another profile's, never counts; a profile alone means its default.
        const pro = await patchMember(liveShell, { requestId: 'member-pro', profileId: 'profile-ok', model: 'model-ok-pro' });
        assert.equal(pro.status, 200, json(pro.body));
        assert.deepEqual([pro.body.member.profileId, pro.body.member.model], ['profile-ok', 'model-ok-pro'], 'a listed model is stored as chosen');
        for (const model of ['page-lie', 'model-disabled']) {
          const refused = await patchMember(liveShell, { requestId: 'refuse-model-' + model, profileId: 'profile-ok', model });
          assert.equal(refused.status, 400, `${model} is not this profile's model and must be refused: ${json(refused.body)}`);
        }
        const defaulted = await patchMember(liveShell, { requestId: 'member-default', profileId: 'profile-ok' });
        assert.equal(defaulted.status, 200, json(defaulted.body));
        assert.deepEqual([defaulted.body.member.profileId, defaulted.body.member.model], ['profile-ok', 'model-ok'], 'a profile named without a model means its default');
        const cleared = await patchMember(liveShell, { requestId: 'member-clear', profileId: null });
        assert.equal(cleared.status, 200, json(cleared.body));
        assert.deepEqual([cleared.body.member.profileId, cleared.body.member.model], [null, null], 'choosing no model clears the reference');
        const unnamed = await call(liveShell, 'members', { requestId: 'member-unnamed', name: '未选模型', role: 'developer', model: 'page-lie' });
        assert.equal(unnamed.status, 201, json(unnamed.body));
        assert.equal(unnamed.body.member.model, null, 'a model the page names on its own is never stored');
      } finally {
        await Promise.all(shells.map(async server => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }));
        workbench.closeAllConnections(); await new Promise(resolve => workbench.close(resolve));
        await upstream.close();
      }
      console.log('workflow-module-wiring-test: registry forward and member model verification PASS');
    }
  }

  console.log('workflow-module-wiring-test PASS');
})().catch(error => { console.error(error); process.exitCode = 1; });
