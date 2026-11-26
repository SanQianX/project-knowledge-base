'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { execFileSync, execFile } = require('node:child_process');
const { promisify } = require('node:util');

const command = promisify(execFile);
const host = '127.0.0.1';
const BRIDGE_PACKAGE = '@sanqianx/ai-coding-event-bridge-console';

function git(repo, ...args) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true, timeout: 30_000 }).trim();
}

async function gitAsync(repo, ...args) {
  const { stdout } = await command('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  return stdout.trim();
}

// 一个带独立远端的仓库。推送基线时钩子目录指向空目录，所以这次推送不产生提交事件。
// A repository with its own remote. The baseline push goes out with the hooks directory pointing at an empty
// folder, so that push produces no commit event.
function makeRepository({ repo, remote, emptyHooks, readme }) {
  for (const directory of [repo, remote, emptyHooks]) fs.mkdirSync(directory, { recursive: true });
  git(remote, 'init', '-q', '--bare', '-b', 'main');
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', '--local', 'core.hooksPath', emptyHooks);
  git(repo, 'config', '--local', 'user.name', 'Synthetic Maintenance QA');
  git(repo, 'config', '--local', 'user.email', 'maintenance-qa@example.invalid');
  git(repo, 'config', '--local', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(repo, 'policy.txt'), 'PASS\n');
  fs.writeFileSync(path.join(repo, 'README.md'), readme);
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'fixture baseline');
  const baseline = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'remote', 'add', 'origin', remote);
  git(repo, 'push', '-u', 'origin', 'main');
  git(repo, 'config', '--local', 'core.hooksPath', '.git/hooks');
  return baseline;
}

function prepareMaintenanceFixture({ sandbox, coreInstall, workflowData, projectId, secondProjectId }) {
  const repo = path.join(sandbox, 'repos', projectId);
  const baseline = makeRepository({
    repo, remote: path.join(sandbox, 'isolated upstream.git'), emptyHooks: path.join(sandbox, 'empty-hooks'),
    readme: '# Isolated maintenance fixture\n',
  });
  // 第二个仓库：测试进行中再登记，用来核对提交只触发提交所在的那个仓库
  // The second repository: registered while the test runs, to check that a commit triggers only the repository it was made in
  const second = { projectId: secondProjectId, repo: secondProjectId ? path.join(sandbox, 'repos', secondProjectId) : null };
  if (secondProjectId) {
    second.remote = path.join(sandbox, 'isolated upstream-second.git');
    second.baseline = makeRepository({
      repo: second.repo, remote: second.remote, emptyHooks: path.join(sandbox, 'empty-hooks-second'),
      readme: '# Isolated maintenance fixture (second repository)\n',
    });
  }

  const tool = path.join(sandbox, 'install', 'tool.js');
  fs.copyFileSync(path.join(__dirname, 'single-repo-maintenance-tool.js'), tool);
  const cli = mode => [process.execPath, tool, mode];
  const configPath = path.join(workflowData, 'workflow', 'maintenance.json');
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify({
    version: 1, projectId, repoPath: repo, branch: 'main', remote: 'origin', allowPush: true,
    tools: [
      { id: 'review', name: '示例代码规则', kind: 'review', check: cli('check'), repair: cli('repair') },
      { id: 'format', name: '示例格式整理器', kind: 'apply', apply: cli('format') },
      { id: 'docs', name: '示例文档工具', kind: 'apply', apply: cli('docs') },
      { id: 'reject', name: '示例未通过规则', kind: 'review', check: cli('reject'), repair: cli('stubborn'), maxRepairs: 1 },
      { id: 'timeout', name: '示例超时命令', kind: 'apply', apply: cli('timeout'), timeoutSeconds: 1 },
      { id: 'probe', name: '示例推送授权检查', kind: 'apply', apply: cli('record') },
    ],
  }, null, 2));

  const bridgeInstall = path.join(sandbox, 'install', 'bridge');
  const bridgeSource = path.dirname(require.resolve(BRIDGE_PACKAGE + '/package.json'));
  fs.mkdirSync(bridgeInstall);
  for (const item of ['package.json', 'src']) fs.cpSync(path.join(bridgeSource, item), path.join(bridgeInstall, item), { recursive: true });
  const bridgeHome = process.env.AI_CODING_EVENT_BRIDGE_HOME;
  const bridgeModule = path.join(bridgeInstall, 'src', 'bridge', 'index.js');
  const { createBridge, resolveRepoContext, projectRegistry, projectJournalDir, Journal } = require(bridgeModule);
  const { createConsoleServer } = require(path.join(bridgeInstall, 'src', 'server'));
  const bridge = createBridge({ homeDir: bridgeHome });
  const server = http.createServer(createConsoleServer({ home: bridgeHome }));

  function installHookFor(dataDir, port, id, repoPath) {
    const { installHook } = require(path.join(coreInstall, 'src', 'automation', 'hook-manager'));
    const { writeEndpoint } = require(path.join(coreInstall, 'src', 'common', 'runtime-endpoint'));
    writeEndpoint(dataDir, { host, port, pid: process.pid });
    return installHook({
      projectId: id, repoPath, dataDir, bridgeHomeDir: bridgeHome, bridgeModulePath: bridgeModule,
      triggerScriptPath: path.join(coreInstall, 'src', 'scripts', 'hook-trigger.js'),
    });
  }
  // 追加一条提交事件。默认是第一个仓库的当前提交；可以指定别的项目和提交，用来核对事件不会触发到别的仓库
  // Append one commit event: by default the first repository's current commit. Another project or commit may be
  // named, to check that an event never triggers the wrong repository.
  async function appendBoundary(overrides = {}) {
    const { repoIdentity } = await resolveRepoContext(repo);
    return bridge.appendCommitBoundary({
      projectId, repoIdentity, commitSha: git(repo, 'rev-parse', 'HEAD'), branch: 'main', ...overrides,
    });
  }
  // 在事件桥接里登记一个项目：它的日志以一段已压缩的前缀开始，和用了很久的日志一样。
  // 一个日志存储位置只能属于一个项目，所以第一个项目用夹具自己的位置，第二个用桥接的默认位置。
  // Register a project with the Bridge: its journal starts with a compacted prefix, like a journal that has been in
  // use for a while. A journal store belongs to one project, so the first uses the fixture's own location and the
  // second the Bridge's default one.
  async function register(target, id) {
    const project = await projectRegistry.addProject({ home: bridgeHome, path: target, ...(target === repo ? { store: path.join(sandbox, 'bridge project store') } : {}) });
    const { repoIdentity } = await resolveRepoContext(target);
    const old = await bridge.appendCommitBoundary({ projectId: id, repoIdentity, commitSha: git(target, 'rev-parse', 'HEAD'), branch: 'main' });
    await new Journal(projectJournalDir(project)).trimThrough(old.sequence);
    return project.id;
  }
  async function appendSecondBoundary(overrides = {}) {
    const { repoIdentity } = await resolveRepoContext(second.repo);
    return bridge.appendCommitBoundary({
      projectId: second.projectId, repoIdentity, commitSha: git(second.repo, 'rev-parse', 'HEAD'), branch: 'main', ...overrides,
    });
  }
  const first = {
    repo, remote: path.join(sandbox, 'isolated upstream.git'), baseline, configPath, projectId, server, bridge, git, gitAsync,
    installHook: (dataDir, port) => installHookFor(dataDir, port, projectId, repo),
    appendBoundary,
    registerProject: () => register(repo, projectId),
  };
  Object.assign(first, secondProjectId ? {
    second: {
      ...second, git, gitAsync,
      registerProject: async () => { second.journalId = await register(second.repo, second.projectId); return second.journalId; },
      installHook: (dataDir, port) => installHookFor(dataDir, port, second.projectId, second.repo),
      appendBoundary: appendSecondBoundary,
    },
  } : {});
  return first;
}

module.exports = { prepareMaintenanceFixture };
