'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { Module } = require('node:module');
const { prepareMaintenanceFixture } = require('./single-repo-maintenance-fixture');

const root = path.resolve(__dirname, '..', '..');
const host = '127.0.0.1';
const offline = 'http://127.0.0.1:0';
const projects = [
  { id: 'project-ai-team-ui-1', name: '示例代码仓库' },
  { id: 'project-ai-team-ui-2', name: '示例文档仓库' },
];

function json(res, response, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(response));
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, resolve);
  });
  return 'http://' + host + ':' + server.address().port;
}

function stop(server) {
  server.closeAllConnections?.();
  return new Promise(resolve => server.close(resolve));
}

function copyInstall(from, to, files) {
  fs.mkdirSync(to, { recursive: true });
  for (const file of files) fs.cpSync(path.join(from, file), path.join(to, file), { recursive: true });
}

function prepareIsolatedEnvironment(sandbox, moduleUrls) {
  const paths = {
    KB_DATA_DIR: path.join(sandbox, 'kb-data'),
    KB_KNOWLEDGE_DATA_DIR: path.join(sandbox, 'knowledge'),
    KB_CLAUDE_RULES_DIR: path.join(sandbox, 'config'),
    AI_CODING_EVENT_BRIDGE_HOME: path.join(sandbox, 'bridge-home'),
    HOME: path.join(sandbox, 'git-home'),
  };
  if (process.platform === 'win32') paths.USERPROFILE = path.join(sandbox, 'home');
  for (const directory of Object.values(paths)) fs.mkdirSync(directory);
  Object.assign(process.env, paths, {
    KB_TERMINAL_URL: offline,
    KB_VECTORHUB_URL: offline,
    KB_EVENTBRIDGE_URL: offline,
    KB_EVENT_BRIDGE_URL: offline,
    KB_KNOWLEDGE_ENGINE_URL: moduleUrls.engine,
    KB_WORKFLOW_URL: moduleUrls.workflow,
    KB_MODULES_AUTOSTART: '0',
    KB_MODULES_REGISTER: '0',
    NODE_PATH: path.join(root, 'node_modules'),
  });
  Module._initPaths();
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options, headers: { 'Content-Type': 'application/json' },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(`${response.status} ${url} ${payload.message || ''}`);
  return payload;
}

async function seedSyntheticState(runtime, sandbox, call, emptyTeam) {
  for (const project of projects) {
    const repoPath = path.join(sandbox, 'repos', project.id);
    const knowledgePath = path.join(sandbox, 'knowledge', project.id);
    fs.mkdirSync(repoPath, { recursive: true });
    fs.mkdirSync(knowledgePath, { recursive: true });
    await runtime.projectStore.create(project.id, { displayName: project.name, repoPath, knowledgePath });
    await runtime.registryStore.add(project.id, { displayName: project.name });
  }
  if (emptyTeam) return { members: [], task: null };
  const { members } = await call('team', {
    method: 'POST', body: {
      requestId: 'seed-team', name: '维护团队',
      members: [
        { name: '维护 Agent', role: 'developer', instructions: '检查和维护示例仓库。', memoryGroupIds: ['group-code'] },
        { name: '独立 Reviewer', role: 'reviewer', instructions: '审阅改动说明。' },
      ],
    },
  });
  await call('projects/' + projects[0].id + '/settings', {
    method: 'PUT', body: {
      requestId: 'seed-settings', enabled: true, autoDispatch: true, substantiveCodeReview: false,
      leaderMemberId: members[0].memberId, developerMemberIds: [members[0].memberId], reviewerMemberId: members[1].memberId,
    },
  });
  const { task } = await call('workflow-tasks', {
    method: 'POST', body: {
      requestId: 'seed-task', projectId: projects[0].id, title: '维护示例仓库的接口文档',
      goal: '核对接口文档的用法与实现。',
      ownerMemberId: members[0].memberId,
      acceptance: [{ kind: 'manual', title: '示例文档与接口一致' }],
    },
  });
  return { members, task };
}

function attachDesignPreview(install, designFile) {
  const asset = path.join(install, 'core', 'resources', 'ui', 'product.js');
  const source = fs.readFileSync(asset, 'utf8');
  const route = '/workflow-ui/?embed=1&apiBase=/api/workflow';
  if (!source.includes(route)) throw new Error('Workflow iframe route has changed.');
  fs.writeFileSync(asset, source.replace("'" + route + "'", `(new URLSearchParams(location.search).has('maintenance-preview') ? '/workflow-ui/maintenance-preview.html?embed=1' : '${route}')`));
  return fs.readFileSync(designFile);
}

function fixtureRequestAllowed(method, pathname, maintenance) {
  if (pathname.startsWith('/api/integrations')) return false;
  if (method === 'GET' || method === 'HEAD') return true;
  if (method === 'POST') {
    if (maintenance && /^\/api\/workflow\/maintenance\/(jobs|runs|control)$/.test(pathname)) return true;
    return ['/api/workflow/team', '/api/workflow/members', '/api/workflow/workflow-tasks'].includes(pathname);
  }
  if (method === 'PATCH') return /^\/api\/workflow\/members\/[^/]+$/.test(pathname);
  if (method === 'PUT') return projects.some(project => pathname === `/api/workflow/projects/${project.id}/settings`);
  return false;
}

async function createAiTeamUiFixture({ dataDir, workflowRoot, designFile, emptyTeam = false, maintenance = false, maintenanceTiming }) {
  // A fresh, explicitly named directory cannot alias an existing installation.
  const sandbox = path.resolve(dataDir);
  fs.mkdirSync(sandbox);
  const install = path.join(sandbox, 'install');
  const workflowInstall = path.join(install, 'workflow');
  const coreInstall = path.join(install, 'core');
  copyInstall(workflowRoot, workflowInstall, ['src', 'ui', 'package.json']);
  copyInstall(root, coreInstall, ['src', 'resources', 'package.json', 'module-runtime-manifest.json']);
  const design = designFile ? attachDesignPreview(install, designFile) : null;
  const workflowData = path.join(sandbox, 'workflow-data');
  fs.mkdirSync(workflowData);
  prepareIsolatedEnvironment(sandbox, { engine: offline, workflow: offline });
  const maintenanceFixture = maintenance && prepareMaintenanceFixture({ sandbox, coreInstall, workflowData, projectId: projects[0].id });
  if (maintenanceFixture) maintenanceFixture.journalId = await maintenanceFixture.registerProject();
  const bridgeUrl = maintenanceFixture ? await listen(maintenanceFixture.server) : offline;
  const { createWorkflowServer } = require(path.join(workflowInstall, 'src', 'server'));
  const workflowOptions = {
    dataDir: workflowData, bridgeUrl, maintenanceTiming,
    projectRoots: maintenanceFixture ? { [projects[0].id]: maintenanceFixture.repo } : undefined,
  };
  let workflow = createWorkflowServer(workflowOptions);
  const memoryDirectory = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url.startsWith('/api/memory-groups?')) {
      json(res, { ok: true, groups: [{ id: 'group-code', name: '代码规范' }, { id: 'group-docs', name: '文档约定' }], total: 2 });
    } else json(res, { ok: false, error: 'FIXTURE_ROUTE' }, 404);
  });
  const shell = http.createServer();
  const close = () => Promise.allSettled([
    stop(shell), stop(memoryDirectory), workflow.close(), ...(maintenanceFixture ? [stop(maintenanceFixture.server)] : []),
  ]);
  try {
    const [wf, engine] = await Promise.all([workflow.listen(0, host), listen(memoryDirectory)]);
    const workflowUrl = 'http://' + host + ':' + wf.port;
    Object.assign(process.env, {
      KB_KNOWLEDGE_ENGINE_URL: engine, KB_WORKFLOW_URL: workflowUrl,
      KB_EVENTBRIDGE_URL: bridgeUrl, KB_EVENT_BRIDGE_URL: bridgeUrl,
    });
    const { createRuntime, initializeRuntime, createRequestHandler } = require(path.join(coreInstall, 'src', 'server', 'server-app'));
    const runtime = createRuntime({ rootDir: coreInstall, dataDir: process.env.KB_DATA_DIR, analysisOwner: 'legacy' });
    await initializeRuntime(runtime);
    const address = await listen(shell);
    const handler = createRequestHandler(runtime, { host, port: shell.address().port });
    shell.on('request', (req, res) => {
      const pathname = new URL(req.url, address).pathname;
      if (!fixtureRequestAllowed(req.method, pathname, maintenance)) {
        json(res, { ok: false, error: 'FIXTURE_READ_ONLY', message: '此操作超出隔离 AI 团队预览范围。' }, 403);
        return;
      }
      if (design && req.method === 'GET' && req.url.startsWith('/workflow-ui/maintenance-preview.html?')) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(design);
        return;
      }
      handler(req, res);
    });
    const call = (route, options) => fetchJson(address + '/api/workflow/' + route, options);
    const seeded = await seedSyntheticState(runtime, sandbox, call, emptyTeam);
    if (maintenanceFixture) {
      maintenanceFixture.installHook(process.env.KB_DATA_DIR, shell.address().port);
      await workflow.consumer.drain({ notifyUrl: workflowUrl + '/api/internal/bridge-notify' });
    }
    async function restartWorkflow() {
      await workflow.close();
      workflow = createWorkflowServer(workflowOptions);
      await workflow.listen(wf.port, host);
      if (maintenanceFixture) await workflow.consumer.drain({ notifyUrl: workflowUrl + '/api/internal/bridge-notify' });
    }
    return {
      address, call, projects, browserProfile: path.join(sandbox, 'browser-profile'), ...seeded,
      maintenance: maintenanceFixture, workflowUrl, restartWorkflow, close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

function argument(name) {
  const index = process.argv.indexOf('--' + name);
  return index < 0 ? '' : process.argv[index + 1] || '';
}

function cliOptions() {
  const dataDir = argument('data');
  const workflowRoot = argument('workflow-root');
  if (!dataDir || !workflowRoot) throw new Error('Supply --data <new test directory> and --workflow-root <Workflow checkout>.');
  return {
    dataDir, workflowRoot, designFile: argument('design') || undefined,
    emptyTeam: process.argv.includes('--empty-team'), maintenance: process.argv.includes('--maintenance'),
  };
}

if (require.main === module) {
  createAiTeamUiFixture(cliOptions()).then(fixture => {
    const close = () => fixture.close().then(() => { process.exitCode = 0; });
    process.once('SIGINT', close);
    process.once('SIGTERM', close);
    console.log(JSON.stringify({ address: fixture.address, pid: process.pid, data: path.resolve(argument('data')) }));
  }).catch(error => { console.error(error.stack); process.exitCode = 1; });
}

module.exports = { createAiTeamUiFixture, cliOptions };
