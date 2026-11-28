'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const vm = require('node:vm');
const { spawn, execFileSync } = require('node:child_process');
const { createRequire } = require('node:module');
const { corpus, setup, listen } = require('./helpers/agentic-context-fixture');
const { startRuntime } = require('./run-agentic-context-real');
const freePort = require('./helpers/free-port');
const hostRoot = process.env.PKB_CONTEXT_CANDIDATE_ROOT || path.resolve(__dirname, '..');
const hostRequire = createRequire(path.join(hostRoot, 'package.json'));
const { createRuntime, startServer } = hostRequire('./src/server/server-app');
const { ModuleBridge } = hostRequire('./src/module_bridge/module-bridge');
const wbRoot = process.env.PKB_CONTEXT_WORKBENCH_SOURCE || path.dirname(hostRequire.resolve('claude-ai-workbench/package.json'));
const wbRequire = createRequire(path.join(wbRoot, 'package.json'));
const createEngineServer = process.env.PKB_CONTEXT_ENGINE_SOURCE
  ? require(path.join(process.env.PKB_CONTEXT_ENGINE_SOURCE, 'src/server')).createEngineServer
  : hostRequire('@sanqianx/ai-coding-knowledge-engine').createEngineServer;

const closeServer = server => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); };
const promptFor = item => item.queries[1] + '\nImplement this in route.js only. Export a CommonJS function returning the required value. Preserve its public signature.';
const expectedFact = item => `The approved value for ${item.alias} is "${item.value}"`;

async function post(endpoint, route, body, timeoutMs = 70000) {
  const response = await fetch(new URL(route, endpoint), { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const result = await response.json();
  assert.ok(response.ok, `${route}: HTTP ${response.status} ${result.code || result.error?.code || ''}`);
  return result;
}

async function provider(key, item) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST' || !/^\/v1\/messages(?:\?|$)/.test(req.url)) { res.writeHead(404).end(); return; }
    const chunks = [];
    let count = 0;
    for await (const chunk of req) {
      count += chunk.length;
      if (count > 4 * 1024 * 1024) { res.writeHead(413).end(); return; }
      chunks.push(chunk);
    }
    const body = Buffer.concat(chunks);
    let parsed;
    try { parsed = JSON.parse(body); } catch { res.writeHead(400).end(); return; }
    const userMessages = JSON.stringify(parsed.messages || []);
    const complete = JSON.stringify([parsed.system || '', parsed.messages || []]);
    const seesOriginal = userMessages.includes(item.queries[1]);
    const meta = { model: parsed.model, seesOriginal, seenContext: complete.includes('<knowledge_context>'),
      sawContinuation: complete.includes('continuationId') && /continue-[a-f0-9-]{36}/.test(complete),
      containsKnowledgeFact: complete.replace(/\\+"/g, '"').includes(expectedFact(item)),
      containsTaskMemory: complete.includes(item.memory), exactFactOccurrences: complete.replace(/\\+"/g, '"').split(expectedFact(item)).length - 1,
      sourceRequestHash: crypto.createHash('sha256').update(body).digest('hex') };
    requests.push(meta);
    const headers = { ...req.headers, host: 'api.z.ai', authorization: `Bearer ${key}` };
    for (const header of ['connection', 'accept-encoding', 'x-api-key']) delete headers[header];
    const upstream = https.request(new URL('https://api.z.ai/api/anthropic' + req.url), { method: 'POST', headers }, response => {
      meta.providerStatus = response.statusCode;
      res.writeHead(response.statusCode, response.headers);
      response.pipe(res);
    });
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    res.on('close', () => upstream.destroy());
    upstream.end(body);
  });
  const url = await listen(server);
  return { url, requests, close: () => closeServer(server) };
}

async function startHost(fixture, runtime) {
  const dataDir = path.join(fixture.root, 'shell');
  const app = createRuntime({ dataDir, analysisOwner: 'engine' });
  app.moduleBridge = new ModuleBridge({ dataDir, engineUrl: fixture.endpoint, vectorHubUrl: runtime.vectorUrl,
    terminalUrl: runtime.workbenchUrl, eventBridgeUrl: fixture.offlineUrl, workflowUrl: fixture.offlineUrl,
    runtimeToken: runtime.token, registryStore: app.registryStore, projectStore: app.projectStore,
    settingsStore: app.settingsStore, logger: app.logger, workflowProjectResolver: input => app.knowledgeRuntime.resolveProject(input) });
  const host = await startServer({ runtime: app, port: await freePort(), host: '127.0.0.1', integrationOptions: { homeDir: path.join(fixture.root, 'home') } });
  const configuration = await app.moduleBridge.syncEngineConfiguration();
  assert.equal(configuration.embedding, true, 'the isolated application must keep its real embedding configured');
  fs.writeFileSync(path.join(dataDir, 'integration-runtime.json'), JSON.stringify({
    schema: 'project-knowledge/integration-runtime/v1', packageName: '@sanqianx/project-knowledge',
    packageRoot: hostRoot, version: require('../package.json').version,
  }));
  return { host, app, dataDir };
}

async function registerCase(fixture, host, group, item, withKnowledge) {
  const id = `project-context-${group.toLowerCase()}-${item.id}`;
  const repo = path.join(fixture.root, 'dev', id);
  fs.mkdirSync(repo, { recursive: true });
  const git = args => execFileSync('git', ['-C', repo, '-c', `core.hooksPath=${path.join(fixture.root, 'disabled-hooks')}`, ...args], { stdio: 'ignore', windowsHide: true });
  git(['init', '-b', 'main']);
  fs.writeFileSync(path.join(repo, 'route.js'), 'module.exports = () => null;\n');
  git(['add', 'route.js']);
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@local.invalid', 'commit', '-m', 'Initial source']);
  if (!withKnowledge) return { repo, projectId: id };
  const knowledgePath = path.join(fixture.root, 'dev-knowledge', id);
  fs.cpSync(fixture.knowledge, knowledgePath, { recursive: true });
  await fixture.request('/api/projects', { projectId: id, repoPath: repo, knowledgePath, vectorProjectId: fixture.projectId });
  await fixture.engine.coordinator.memoryGroups.setProjectBindings(fixture.groupId, { addProjectIds: [id] });
  await host.app.projectStore.create(id, { displayName: 'Maintenance workspace', repoPath: repo, knowledgePath },
    { modules: { engine: { ok: true, status: 'registered' } } });
  await host.app.registryStore.add(id, { displayName: 'Maintenance workspace' });
  return { repo, projectId: id };
}

function accepted(workspace, item) {
  try {
    const module = { exports: {} };
    const context = { module };
    const changed = fs.readFileSync(path.join(workspace, 'route.js'), 'utf8');
    vm.runInNewContext(changed + '\nreturnValue = module.exports();', context, { timeout: 300 });
    return Object.is(context.returnValue, item.expectedOutput);
  } catch { return false; }
}

function summarizeUsage(usage) {
  return { input: (usage?.input_tokens || 0) + (usage?.cache_creation_input_tokens || 0) + (usage?.cache_read_input_tokens || 0),
    output: usage?.output_tokens || 0 };
}

async function claude(item, group, caseInfo, host, runtime, key) {
  const started = Date.now();
  const trace = await provider(key, item);
  const executable = process.env.PKB_CONTEXT_CLAUDE_EXECUTABLE;
  const config = fs.mkdtempSync(path.join(host.host.runtime.dataPath, 'claude-'));
  const sessionId = crypto.randomUUID();
  const baselineRoot = group === 'B' && process.env.PKB_CONTEXT_BASELINE_HOST_SOURCE;
  const plugin = path.join(baselineRoot || hostRoot, 'plugins/project-knowledge');
  const mcpConfig = group === 'A' ? {} : { 'project-knowledge': { command: process.execPath,
    args: [baselineRoot ? path.join(baselineRoot, 'bin/project-knowledge-mcp.js') : path.join(plugin, 'scripts/mcp-launcher.cjs')],
    env: { KB_PLUGIN_VERSION: require('../package.json').version } } };
  const mcp = path.join(config, 'mcp.json');
  fs.writeFileSync(mcp, JSON.stringify({ mcpServers: mcpConfig }));
  const allowed = ['Read', 'Edit', 'Write', ...(group === 'A' ? [] :
    ['mcp__project-knowledge__project_knowledge_resolve', 'mcp__project-knowledge__project_knowledge_search', 'mcp__project-knowledge__project_knowledge_get',
      ...(group === 'B' ? [] : ['mcp__project-knowledge__project_knowledge_prepare_task_context', 'mcp__project-knowledge__project_knowledge_read_context_memory'])])];
  const args = [...(group === 'A' ? [] : ['--plugin-dir', plugin]), '--print', '--output-format', 'stream-json', '--verbose',
    '--setting-sources', 'user', '--model', runtime.model, '--max-turns', '10', '--session-id', sessionId, '--no-session-persistence',
    '--permission-mode', 'acceptEdits', '--tools', 'Read,Edit,Write', '--allowedTools', allowed.join(','), '--strict-mcp-config', '--mcp-config', mcp, '--', promptFor(item)];
  const env = { ...process.env, CLAUDE_CONFIG_DIR: config, KB_DATA_DIR: host.dataDir, ANTHROPIC_AUTH_TOKEN: 'isolated-loopback',
    ANTHROPIC_BASE_URL: trace.url, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1' };
  delete env.CLAUDECODE;
  delete env.ANTHROPIC_API_KEY;
  const child = spawn(executable, args, { cwd: caseInfo.repo, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '', timedOut = false;
  child.stdout.on('data', chunk => { out = (out + chunk).slice(-2 * 1024 * 1024); });
  child.stderr.on('data', chunk => { err = (err + chunk).slice(-8192); });
  const timeout = setTimeout(() => { timedOut = true; child.kill(); }, 125000);
  try {
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    const events = out.split(/\r?\n/).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
    const completion = events.find(event => event.type === 'result');
    const tools = events.filter(event => event.type === 'assistant').flatMap(event => event.message?.content || [])
      .filter(item => item.type === 'tool_use').map(item => String(item.name));
    return { client: 'claude', group, case: item.id, nativeSessionId: sessionId, code,
      status: timedOut ? 'timeout' : code === 0 && !completion?.is_error && completion ? 'completed' : 'client-error',
      errorCategory: /authentication|subscription|credit balance/i.test(err + JSON.stringify(completion?.errors)) ? 'provider-access' : undefined,
      accepted: accepted(caseInfo.repo, item), tools, developerUsage: summarizeUsage(completion?.usage), requests: trace.requests, durationMs: Date.now() - started };
  } finally { clearTimeout(timeout); await trace.close(); }
}

async function workbench(item, caseInfo, fixture, runtime, key) {
  const trace = await provider(key, item);
  const started = Date.now();
  const dataDir = path.join(fixture.root, 'development-workbench');
  const { ProfileStore } = wbRequire('./packages/server/lib/profile-store');
  const { createWorkbenchServer } = wbRequire('./packages/server');
  const profiles = new ProfileStore({ dataDir });
  const profileId = 'isolated-development';
  const saved = profiles.save({ id: profileId, name: 'Real development', protocol: 'anthropic-compatible', provider: 'zai',
    baseUrl: trace.url, models: { default: runtime.model, list: [{ id: runtime.model }] } });
  profiles._credentials = () => ({ credentials: { [saved.credentialRef]: 'isolated-loopback' } });
  const app = createWorkbenchServer({ dataDir, profiles, runtimeToken: runtime.token, serveHost: false, engineUrl: fixture.endpoint,
    workspaces: { 'adaptive-qa': caseInfo.repo } });
  const url = await listen(app.server);
  try {
    const created = await post(url, '/api/claude-workbench/v1/sessions', {
      context: { contextId: 'adaptive-qa', workspaceRef: 'adaptive-qa', aiProfileId: profileId },
      aiProfileId: profileId, agentId: 'claude-code', permissionMode: 'acceptEdits' });
    const sessionId = created.sessionId || created.session?.sessionId;
    assert.ok(sessionId, 'Workbench did not return a session ID');
    const sent = await post(url, `/api/claude-workbench/v1/sessions/${encodeURIComponent(sessionId)}/input`, { text: promptFor(item) });
    const deadline = Date.now() + 105000;
    while (Date.now() < deadline && !accepted(caseInfo.repo, item) && trace.requests.every(req => !req.providerStatus || req.providerStatus < 400)) {
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    const originalPreserved = app.service.runner.getSession(sessionId).outputBuffer.some(event => event.type === 'claude/user-prompt' && event.text === promptFor(item));
    return { client: 'workbench', case: item.id, accepted: accepted(caseInfo.repo, item), originalPreserved,
      delivery: sent.knowledge?.delivery, requestId: sent.knowledge?.requestId, taskContextId: sent.knowledge?.taskContextId,
      mode: sent.knowledge?.mode, packStatus: sent.knowledge?.packStatus, requests: trace.requests, durationMs: Date.now() - started };
  } finally {
    await app.service.destroy();
    await closeServer(app.server);
    await trace.close();
  }
}

async function zcode(item, caseInfo, fixture, host, runtime, key) {
  const executable = process.env.PKB_CONTEXT_ZCODE_EXECUTABLE;
  if (!executable || !path.isAbsolute(executable) || !fs.existsSync(executable)) {
    return { client: 'zcode', status: 'blocked', reason: 'provide the bundled native zcode.cjs executable' };
  }
  const home = path.join(fixture.root, 'zcode-home');
  const { IntegrationManager } = hostRequire('./src/integrations/integration-installer');
  const integration = new IntegrationManager({ rootDir: hostRoot, homeDir: home, bridgeHomeDir: path.join(home, 'events') });
  assert.equal(integration.installZCode().installed, true);
  const { createAppServerBridge } = wbRequire('./packages/server/lib/bridges/app-server-bridge');
  const { createZCodeProfileRuntime } = wbRequire('./packages/server/lib/drivers/zcode-profile-runtime');
  const { providerRuntimeEnvironment } = wbRequire('./packages/server/lib/drivers/zcode-driver');
  const trace = await provider(key, item);
  const started = Date.now();
  const events = [];
  const file = path.join(caseInfo.repo, 'route.js');
  let profile, bridge, sessionId;
  try {
    profile = await createZCodeProfileRuntime({ model: { providerId: 'isolated-zai', modelId: runtime.model },
      provider: { kind: 'anthropic', baseURL: trace.url, apiKey: { value: 'isolated-loopback' } } });
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => /^(path|pathext|systemroot|windir|comspec|systemdrive|os)$/i.test(name)));
    Object.assign(env, providerRuntimeEnvironment(executable, { env, homedir: home }), {
      USERPROFILE: home, HOME: home, APPDATA: home, LOCALAPPDATA: home, XDG_CONFIG_HOME: home, XDG_DATA_HOME: home,
      TEMP: home, TMP: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(home, 'gitconfig'),
      ZCODE_DATA_BASE_DIR: home, ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: profile.file,
      KB_DATA_DIR: host.dataDir, AI_CODING_EVENT_BRIDGE_CAPTURE: '0', AI_CODING_EVENT_BRIDGE_HOME: path.join(home, 'events'),
    });
    bridge = createAppServerBridge({ command: process.execPath, args: [executable, 'app-server', '--stdio'], cwd: caseInfo.repo,
      spawn: (command, args, options) => spawn(command, args, { ...options, env }),
      maxRestarts: 0, idleTimeoutMs: 0, requestTimeoutMs: 30000, label: 'isolated-zcode-context',
      onEvent: event => { if (event.method === 'session/event') events.push(event.params); },
      onServerRequest: (method, params) => {
        if (method === 'session/requestRuntimePreferences') return { nativeSearchEnhancementsEnabled: false,
          memoryEnabled: false, askUserQuestionAutoResolutionEnabled: false, modelContextBudgetStrategy: 'preflight-v1' };
        if (method === 'interaction/requestPermission') {
          const target = params.input?.file_path || params.input?.path;
          const allowed = typeof target === 'string' && path.resolve(caseInfo.repo, target) === file;
          return (params.options || []).find(option => option.kind === (allowed ? 'allow_once' : 'deny'))?.response;
        }
        throw new Error(`Unsupported isolated ZCode interaction: ${method}`);
      } });
    await bridge.start();
    await bridge.request('runtime/capabilities', {});
    const { session } = await bridge.request('session/create', { workspace: { workspacePath: caseInfo.repo, workspaceKey: caseInfo.repo },
      mode: 'edit', titleGenerationEnabled: false });
    sessionId = session.sessionId;
    await bridge.request('session/subscribe', { sessionId, deliveryKind: 'desktop-continuous' });
    const sent = await bridge.request('session/send', { sessionId, content: promptFor(item), modelSelection: profile.selection });
    assert.equal(sent.accepted, true);
    const deadline = Date.now() + 105000;
    let terminal;
    while (Date.now() < deadline) {
      terminal = events.find(event => ['turn.completed', 'turn.failed'].includes(event.type));
      if (terminal) break;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    const hook = logsAt(host.dataDir).find(event => event.projectId === caseInfo.projectId && event.event === 'agent.context.output');
    return { client: 'zcode', status: terminal?.type || 'timeout', result: terminal?.payload?.resultType,
      accepted: accepted(caseInfo.repo, item), requests: trace.requests, durationMs: Date.now() - started,
      hook: hook ? { requestId: hook.operationId, packId: hook.context.packId, taskContextId: hook.context.taskContextId } : null };
  } finally {
    if (sessionId) await bridge.request('session/stop', { sessionId }).catch(() => {});
    await bridge?.close();
    await profile?.close();
    await trace.close();
  }
}

async function codex(item, caseInfo, fixture, host) {
  const executable = process.env.PKB_CONTEXT_CODEX_EXECUTABLE;
  const config = process.env.CODEX_HOME;
  if (!executable || !config) return { client: 'codex', status: 'blocked', reason: 'isolated Codex executable or home not provided' };
  assert.ok(path.isAbsolute(config) && fs.existsSync(config), 'provide an existing absolute CODEX_HOME');
  const tempRelative = path.relative(fs.realpathSync(os.tmpdir()), fs.realpathSync(config));
  assert.ok(tempRelative && !tempRelative.startsWith('..') && !path.isAbsolute(tempRelative), 'CODEX_HOME must be inside the isolated test temporary directory');
  const { createAppServerBridge } = wbRequire('./packages/server/lib/bridges/app-server-bridge');
  const { resolveCliInvocation } = wbRequire('./packages/server/lib/drivers/cli-json-runner');
  const pluginRoot = path.join(hostRoot, 'plugins/project-knowledge');
  const hookScript = path.join(pluginRoot, 'scripts/context-hook.cjs').replaceAll('\\', '/');
  const hookPath = path.join(config, 'hooks.json');
  if (!fs.existsSync(hookPath)) {
    const template = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'hooks/codex.json'), 'utf8'));
    template.hooks.UserPromptSubmit[0].hooks[0].command = `"${process.execPath.replaceAll('\\', '/')}" "${hookScript}" --client codex`;
    fs.writeFileSync(hookPath, JSON.stringify(template, null, 2), { flag: 'wx' });
  }
  const settings = { 'mcp_servers.project-knowledge.command': process.execPath,
    'mcp_servers.project-knowledge.args': [path.join(pluginRoot, 'scripts/mcp-launcher.cjs')], 'mcp_servers.project-knowledge.tool_timeout_sec': 70 };
  const args = [executable, 'app-server'];
  for (const [name, value] of Object.entries(settings)) args.push('-c', `${name}=${JSON.stringify(value)}`);
  const env = { ...process.env, KB_DATA_DIR: host.dataDir, KB_PLUGIN_VERSION: require('../package.json').version };
  const events = [];
  const bridge = createAppServerBridge({ command: process.execPath, args, env, cwd: caseInfo.repo, resolveInvocation: resolveCliInvocation,
    maxRestarts: 0, idleTimeoutMs: 0, requestTimeoutMs: 30000, label: 'isolated-codex-context',
    onEvent: event => events.push(event), onServerRequest: () => ({ decision: 'decline' }) });
  try {
    await bridge.start();
    await bridge.request('initialize', { clientInfo: { name: 'adaptive-context-acceptance', version: '1' }, capabilities: { experimentalApi: true } });
    await bridge.notify('initialized');
    const [snapshot, account] = await Promise.all([
      bridge.request('hooks/list', { cwds: [caseInfo.repo] }),
      bridge.request('account/read', { refreshToken: false }).catch(() => null),
    ]);
    const hooks = (snapshot.data || []).flatMap(scope => scope.hooks || [])
      .filter(hook => hook.eventName === 'userPromptSubmit' && hook.command?.replaceAll('\\', '/').includes(hookScript));
    const trustStatus = hooks[0]?.trustStatus || 'not-listed';
    const metadata = { client: 'codex', hooks: hooks.length, trustStatus, authenticated: !!account?.account };
    if (hooks.length !== 1 || hooks[0].enabled !== true || !['trusted', 'managed'].includes(trustStatus)) {
      return { ...metadata, status: 'blocked', reason: 'the isolated native hook requires review in Codex /hooks' };
    }
    if (!account?.account) return { ...metadata, status: 'blocked', reason: 'the isolated Codex model account is not authenticated' };
    const { thread } = await bridge.request('thread/start', { cwd: caseInfo.repo, sandbox: 'workspace-write', approvalPolicy: 'never' });
    const { turn } = await bridge.request('turn/start', { threadId: thread.id, input: [{ type: 'text', text: promptFor(item) }] });
    const deadline = Date.now() + 180000;
    let completed;
    while (Date.now() < deadline) {
      completed = events.find(event => event.method === 'turn/completed' && event.params?.turn?.id === turn.id);
      if (completed) break;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    const hook = logsAt(host.dataDir).filter(event => event.projectId === caseInfo.projectId && event.event === 'agent.context.output').at(-1);
    const deep = logsAt(path.join(fixture.root, 'engine')).find(event => event.projectId === caseInfo.projectId
      && event.event === 'knowledge.context.agentic_prepared' && event.context.taskContextId === hook?.context.taskContextId
      && event.context.mode === 'agentic' && event.context.factCount > 0);
    const used = accepted(caseInfo.repo, item);
    return { ...metadata, status: completed?.params.turn.status || 'timeout', accepted: used, hook: hook ? { requestId: hook.operationId,
      packId: hook.context.packId, taskContextId: hook.context.taskContextId } : null, deepPackId: deep?.context.delivery?.packId };
  } finally { await bridge.close(); }
}

const detectionQuestion = '当前项目有哪些检测算法？请列出各算法的关键参数和默认值。';
const detectionSources = [
  { file: 'arc-detect.md', title: '圆弧检测算法参数', parameter: 'arcPeakThreshold', value: 47, unit: '灰度级' },
  { file: 'stripe-detect.md', title: '条纹检测算法参数', parameter: 'stripeWindowWidth', value: 29, unit: '像素' },
];

function writeDetectionKnowledge(knowledge) {
  const modules = path.join(knowledge, 'modules');
  const catalog = detectionSources.map(source => `- [${source.title}](${source.file})`).join('\n');
  fs.writeFileSync(path.join(modules, 'detection-catalog.md'), `# 当前检测算法参数目录\n\n当前项目启用的检测算法及参数定义如下。\n${catalog}\n`);
  for (const source of detectionSources) {
    fs.writeFileSync(path.join(modules, source.file),
      `# ${path.basename(source.file, '.md')}\n\n下表为实现中的缺省值，配方可以覆盖。\n\n` +
      `| 字段 | 缺省 | 单位 |\n| --- | --- | --- |\n| \`${source.parameter}\` | ${source.value} | ${source.unit} |\n\n` +
      `## 原文校验\n\n打开当前知识文件时可核对：fixture-original-${source.file}\n`);
  }
}

async function browserSmoke(item, caseInfo, host, vector) {
  const { launchCdpBrowser, waitFor } = require('./helpers/cdp-browser');
  const base = `http://127.0.0.1:${host.host.port}`;
  const profileDir = fs.mkdtempSync(path.join(host.dataDir, 'chrome-'));
  const browser = await launchCdpBrowser({ profileDir, url: base, chrome: process.env.PKB_CONTEXT_CHROME_EXECUTABLE });
  try {
    await waitFor(() => browser.evaluate("document.querySelector('#openSystem') !== null"), 'host UI loaded');
    await browser.evaluate("document.querySelector('#openSystem').click()");
    await waitFor(() => browser.evaluate("document.querySelector('#agenticContextModel')?.options.length > 1"), 'saved profile offered');
    const chooseModel = async modelConfigured => {
      await browser.evaluate(`(() => {
        document.querySelector('#agenticContextEnabled').checked = true;
        const select = document.querySelector('#agenticContextModel');
        select.value = select.options[${modelConfigured ? 1 : 0}].value;
        document.querySelector('#saveAgenticContext').click();
      })()`);
      await waitFor(async () => {
        const response = await fetch(base + '/api/engine/context/capabilities');
        const state = await response.json();
        return state.enabled && state.modelConfigured === modelConfigured;
      }, 'smart setting persisted and delivered');
      await browser.evaluate("document.querySelector('#closeSystem').click()");
    };
    await chooseModel(true);
    await browser.evaluate("document.querySelector('[data-view=search]').click()");
    await waitFor(() => browser.evaluate("document.querySelector('#searchForm select[name=project]')?.options.length > 1"), 'search form and project loaded');
    // A submitted search renders its loading state before it awaits anything.
    // Waiting for that state keeps a finished page from reading as the result
    // of the search that was just requested.
    const search = async (mode, query = item.queries[0], type = 'all') => {
      await browser.evaluate(`(() => {
        const form = document.querySelector('#searchForm');
        form.elements.project.value = ${JSON.stringify(caseInfo.projectId)};
        form.elements.scope.value = 'project';
        form.elements.mode.value = ${JSON.stringify(mode)};
        form.elements.type.value = ${JSON.stringify(type)};
        form.elements.query.value = ${JSON.stringify(query)};
        form.requestSubmit();
        return true;
      })()`);
      if (mode === 'deep') await waitFor(() => browser.evaluate("!!document.querySelector('#searchContent .small-empty')?.textContent.includes('正在检索')"),
        'search started: ' + query.slice(0, 40), 10000);
    };
    await search('fast');
    await waitFor(() => browser.evaluate("document.querySelector('#searchContent article.result-row') !== null"), 'fast result rendered');
    await search('deep');
    const deepFinished = () => browser.evaluate("!document.querySelector('#searchContent .small-empty')?.textContent.includes('正在检索')");
    await waitFor(deepFinished, 'smart result finished', 67000);
    const body = await browser.evaluate("document.querySelector('#searchContent').textContent");
    assert.ok(body.includes('智能检索') && body.includes(item.value) && body.includes(item.memory) && body.includes(item.alias.toLowerCase() + '.md'), body);

    await search('deep', detectionQuestion, 'knowledge');
    await waitFor(deepFinished, 'parameter question finished', 67000);
    const answer = await browser.evaluate(`(() => ({
      points: [...document.querySelectorAll('.search-answer li')].map(li => ({
        text: li.querySelector('span').textContent,
        sources: [...li.querySelectorAll('button.search-citation')].map(button => button.dataset.index),
      })),
      sources: [...document.querySelectorAll('.search-sources .reference')].map(button => ({
        index: button.dataset.index, text: button.textContent,
      })),
      trace: [...document.querySelectorAll('.search-trace li')].map(li => ({
        queries: [...li.querySelectorAll('.search-query:not(.is-question)')].map(span => span.textContent),
        note: li.querySelector('small')?.textContent || '',
      })),
      head: document.querySelector('#searchContent').innerText.slice(0, 300),
      status: document.querySelector('#searchContent').innerText.slice(-1500),
    }))()`);
    // The plan step must split the question: besides the question itself, the
    // first round searches at least two distinct keywords.
    const firstRound = answer.trace[0];
    assert.ok(firstRound && new Set(firstRound.queries).size >= 2, 'no keyword plan on the page:\n' + answer.status);
    assert.match(answer.head, /向量\+词法|仅词法|文件检索/, 'recall backend is not named:\n' + answer.head);
    if (vector) assert.match(answer.head, /向量\+词法/, 'vector recall did not take part:\n' + answer.head);
    // A document is listed once, however many parts of it were read.
    const listed = answer.sources.map(source => source.text);
    assert.equal(new Set(listed).size, listed.length, 'a source is listed twice:\n' + answer.status);
    for (const source of detectionSources) {
      const link = answer.sources.find(candidate => candidate.text.includes('modules/' + source.file));
      assert.ok(link && answer.points.some(point => point.text.includes(source.parameter)
        && point.text.includes(String(source.value)) && point.sources.includes(link.index)), answer.status);
      await browser.evaluate(`document.querySelector('.search-citation[data-index="${link.index}"]').click()`);
      await waitFor(() => browser.evaluate(`document.querySelector('#referenceDialog').open &&
        document.querySelector('#referenceMeta').textContent.includes(${JSON.stringify('modules/' + source.file)}) &&
        document.querySelector('#referenceContent').textContent.includes(${JSON.stringify('fixture-original-' + source.file)})`),
        'inline citation opens ' + source.file);
      await browser.evaluate("document.querySelector('[data-close=referenceDialog]').click()");
    }

    await browser.evaluate("document.querySelector('#openSystem').click()");
    await chooseModel(false);
    await search('deep', detectionQuestion, 'knowledge');
    await waitFor(deepFinished, 'deterministic fallback finished', 67000);
    assert.ok(await browser.evaluate(`(() => {
      const content = document.querySelector('#searchContent');
      return content.innerText.includes('检索模型不可用') && !content.querySelector('.search-answer') &&
        !!content.querySelector('.search-sources button.reference') &&
        ${JSON.stringify(detectionSources.map(source => source.parameter))}.every(parameter => !content.innerText.includes(parameter));
    })()`), 'fallback must explain the missing model and keep sources available even when it missed the parameter documents');
    await browser.evaluate("document.querySelector('.search-sources button.reference').click()");
    await waitFor(() => browser.evaluate(`document.querySelector('#referenceDialog').open &&
      document.querySelector('#referenceMeta').textContent.includes('modules/') &&
      document.querySelector('#referenceContent').textContent.startsWith('# ')`), 'fallback reference opens the original');
    return { browser: 'Chromium', fast: true, agentic: true, citedAlgorithms: detectionSources.length, fallbackReference: true,
      relevantMemory: true, configuredViaUi: true, vector, trace: answer.trace,
      statusLine: (answer.head.match(/[^\n]*检索 · [^\n]*/) || [''])[0].trim() };
  } catch (error) {
    // A step that did nothing is explained by what the page itself reported.
    const pageErrors = [...browser.exceptions.map(entry => entry.exceptionDetails?.exception?.description),
      ...browser.consoleErrors.map(entry => entry.text)].filter(Boolean).slice(0, 6);
    throw new Error(pageErrors.length ? `${error.message}\npage errors:\n${pageErrors.join('\n')}` : error.message, { cause: error });
  } finally { await browser.close(); }
}

function logsAt(root) {
  const output = [];
  function add(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) add(full);
      else if (entry.name.endsWith('.jsonl')) {
        for (const line of fs.readFileSync(full, 'utf8').split(/\r?\n/)) { try { output.push(JSON.parse(line)); } catch {} }
      }
    }
  }
  add(path.join(root, 'logs'));
  return output;
}

async function main() {
  const mode = process.argv[2] || 'smoke';
  const comparison = ['compare', 'baseline-client', 'compare-vector'].includes(mode);
  if (!comparison && !['smoke', 'mcp', 'workbench', 'codex', 'zcode', 'browser'].includes(mode)) {
    throw new Error(`Unknown native-client test mode: ${mode}`);
  }
  if (comparison && !process.env.PKB_CONTEXT_BASELINE_HOST_SOURCE) {
    throw new Error('Set PKB_CONTEXT_BASELINE_HOST_SOURCE to the isolated M0 host for group B.');
  }
  const key = process.env.ZAI_API_KEY;
  if (!key) throw new Error('BLOCKED: ZAI_API_KEY is required for the isolated native-client comparison.');
  if (!['browser', 'codex', 'zcode'].includes(mode) && !process.env.PKB_CONTEXT_CLAUDE_EXECUTABLE) {
    throw new Error('BLOCKED: set PKB_CONTEXT_CLAUDE_EXECUTABLE to the actual Claude Code executable.');
  }
  delete process.env.ZAI_API_KEY;
  Object.assign(process.env, { KB_MODULES_AUTOSTART: '0', KB_MODULES_REGISTER: '0', AI_CODING_EVENT_BRIDGE_CAPTURE: '0' });
  for (const name of ['KB_KNOWLEDGE_CONTEXT', 'KB_KNOWLEDGE_ENGINE_URL', 'KB_SITE_AUTH_TOKEN', 'KB_ALLOWED_ORIGINS', 'AI_CODING_EVENT_BRIDGE_HOME']) delete process.env[name];
  const runtime = await startRuntime(key, { deferFirstContext: mode === 'mcp' });
  let fixture, host;
  try {
    fixture = await setup({ createEngineServer, vectorUrl: runtime.vectorUrl, runtimeToken: runtime.token,
      engineOptions: { workbenchUrl: runtime.workbenchUrl } });
    host = await startHost(fixture, runtime);
    if (mode !== 'browser' && process.env.PKB_CONTEXT_FILE_FALLBACK !== '1') await runtime.manager.import(fixture.knowledge, fixture.projectId, false);
    if (mode === 'browser') {
      const item = corpus.cases[0];
      writeDetectionKnowledge(fixture.knowledge);
      const native = await registerCase(fixture, host, 'UI', item, true);
      // Opt-in (PKB_CONTEXT_BROWSER_VECTOR=1): index what the page's project
      // actually reads. The engine verifies every vector row against its own
      // knowledge directory, so an index of the fixture directory is rejected.
      if (process.env.PKB_CONTEXT_BROWSER_VECTOR === '1') {
        await runtime.manager.import(path.join(fixture.root, 'dev-knowledge', native.projectId), fixture.projectId, false);
      }
      const acceptance = await browserSmoke(item, native, host, process.env.PKB_CONTEXT_BROWSER_VECTOR === '1');
      const runs = logsAt(path.join(fixture.root, 'engine')).filter(event => event.projectId === native.projectId
        && event.event === 'knowledge.context.agentic_prepared');
      const parameterAnswer = runs.at(-2)?.context;
      assert.ok(parameterAnswer?.mode === 'agentic' && parameterAnswer.budget.usage.calls > 0);
      console.log(JSON.stringify({ ...acceptance, model: runtime.model,
        embedding: !acceptance.vector ? null : process.env.PKB_CONTEXT_EMBEDDING === 'simulated' ? 'simulated' : 'real', answerRounds: parameterAnswer.budget.rounds,
        sourceReads: parameterAnswer.budget.reads, modelCalls: parameterAnswer.budget.usage.calls,
        modelInputTokens: parameterAnswer.budget.usage.input, answerMs: parameterAnswer.durationMs }));
      return;
    }
    if (['workbench', 'codex', 'zcode'].includes(mode)) {
      await fixture.request('/api/runtime-context-config', { enabled: true, profileId: runtime.profileId, model: runtime.model });
      const item = corpus.cases[0];
      const native = await registerCase(fixture, host, mode, item, true);
      if (mode === 'codex') {
        const row = await codex(item, native, fixture, host);
        console.log(JSON.stringify({ mode, rows: [row] }, null, 2));
        if (row.status === 'blocked') { process.exitCode = 2; return; }
        assert.ok(row.status === 'completed' && row.accepted && row.hook?.packId && row.hook.taskContextId && row.deepPackId);
        return;
      }
      if (mode === 'zcode') {
        const row = await zcode(item, native, fixture, host, runtime, key);
        console.log(JSON.stringify({ mode, rows: [row] }, null, 2));
        if (row.status === 'blocked') { process.exitCode = 2; return; }
        assert.ok(row.status === 'turn.completed' && row.result === 'success' && row.accepted && row.hook?.packId && row.hook.taskContextId);
        const first = row.requests.find(request => request.seesOriginal && request.providerStatus === 200);
        assert.ok(first?.containsTaskMemory && first.exactFactOccurrences === 1);
        return;
      }
      const row = await workbench(item, native, fixture, runtime, key);
      console.log(JSON.stringify({ mode, rows: [row] }, null, 2));
      assert.equal(row.accepted, true);
      assert.equal(row.originalPreserved, true);
      assert.equal(row.delivery?.status, 'acknowledged');
      const first = row.requests.find(request => request.seesOriginal && request.providerStatus === 200);
      assert.ok(first?.containsTaskMemory && first.exactFactOccurrences === 1);
      return;
    }
    const rows = [];
    const single = ['smoke', 'mcp'].includes(mode);
    const groups = single ? ['C'] : mode === 'baseline-client' ? ['B'] : mode === 'compare-vector' ? ['B', 'C'] : ['A', 'B', 'C'];
    const cases = single ? [corpus.cases[0]] : corpus.cases;
    for (const group of groups) {
      await fixture.request('/api/runtime-context-config', { enabled: group === 'C', profileId: runtime.profileId, model: runtime.model });
      for (let offset = 0; offset < cases.length; offset += 2) {
        const batch = await Promise.allSettled(cases.slice(offset, offset + 2).map(async item => {
          const native = await registerCase(fixture, host, group, item, group !== 'A');
          const row = await claude(item, group, native, host, runtime, key);
          const hooks = logsAt(host.dataDir).filter(log => log.projectId === native.projectId && log.event === 'agent.context.output');
          const engine = logsAt(path.join(fixture.root, 'engine')).filter(log => log.projectId === native.projectId && /knowledge.context.(?:agentic_prepared|delivery)$/.test(log.event));
          return { ...row, hook: hooks.map(log => ({ requestId: log.operationId, ...log.context })).slice(-3),
            retrieval: engine.map(log => ({ requestId: log.operationId, event: log.event, ...log.context })).slice(-8) };
        }));
        for (const item of batch) {
          if (item.status === 'rejected') throw item.reason;
          rows.push(item.value);
          if (process.env.PKB_CONTEXT_CLIENT_REPORT) fs.writeFileSync(process.env.PKB_CONTEXT_CLIENT_REPORT, JSON.stringify({ mode, rows }, null, 2));
        }
      }
    }
    console.log(JSON.stringify({ mode, rows }, null, 2));
    if (single) {
      assert.equal(rows[0].status, 'completed');
      assert.equal(rows[0].accepted, true);
      assert.ok(rows[0].requests.some(request => request.seesOriginal && request.containsKnowledgeFact && request.containsTaskMemory && request.providerStatus === 200));
      assert.ok(rows[0].hook.some(hook => hook.packId && hook.taskContextId));
      if (mode === 'mcp') {
        assert.equal(rows[0].requests.find(request => request.seesOriginal).containsKnowledgeFact, false);
        assert.ok(rows[0].tools.includes('mcp__project-knowledge__project_knowledge_prepare_task_context'));
        const [{ taskContextId }] = rows[0].hook;
        assert.ok(rows[0].retrieval.some(entry => entry.taskContextId === taskContextId && entry.delivery?.kind === 'explicit'));
      }
    }
  } finally {
    if (host) await host.host.stop('isolated-context-client-check');
    if (fixture) await fixture.close();
    await runtime.close();
  }
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { accepted, post, promptFor, provider, registerCase, startHost };
