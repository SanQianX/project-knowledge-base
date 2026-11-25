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

function prepareMaintenanceFixture({ sandbox, coreInstall, workflowData, projectId }) {
  const repo = path.join(sandbox, 'repos', projectId);
  const remote = path.join(sandbox, 'isolated upstream.git');
  const emptyHooks = path.join(sandbox, 'empty-hooks');
  for (const directory of [repo, remote, emptyHooks]) fs.mkdirSync(directory, { recursive: true });
  git(remote, 'init', '-q', '--bare', '-b', 'main');
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', '--local', 'core.hooksPath', emptyHooks);
  git(repo, 'config', '--local', 'user.name', 'Synthetic Maintenance QA');
  git(repo, 'config', '--local', 'user.email', 'maintenance-qa@example.invalid');
  git(repo, 'config', '--local', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(repo, 'policy.txt'), 'PASS\n');
  fs.writeFileSync(path.join(repo, 'README.md'), '# Isolated maintenance fixture\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'fixture baseline');
  const baseline = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'remote', 'add', 'origin', remote);
  git(repo, 'push', '-u', 'origin', 'main');
  git(repo, 'config', '--local', 'core.hooksPath', '.git/hooks');

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

  function installHook(dataDir, port) {
    const { installHook } = require(path.join(coreInstall, 'src', 'automation', 'hook-manager'));
    const { writeEndpoint } = require(path.join(coreInstall, 'src', 'common', 'runtime-endpoint'));
    writeEndpoint(dataDir, { host, port, pid: process.pid });
    return installHook({
      projectId, repoPath: repo, dataDir, bridgeHomeDir: bridgeHome, bridgeModulePath: bridgeModule,
      triggerScriptPath: path.join(coreInstall, 'src', 'scripts', 'hook-trigger.js'),
    });
  }
  async function appendBoundary(overrides = {}) {
    const { repoIdentity } = await resolveRepoContext(repo);
    return bridge.appendCommitBoundary({
      projectId, repoIdentity, commitSha: git(repo, 'rev-parse', 'HEAD'), branch: 'main', ...overrides,
    });
  }
  async function registerProject() {
    const project = await projectRegistry.addProject({ home: bridgeHome, path: repo, store: path.join(sandbox, 'bridge project store') });
    const old = await appendBoundary();
    await new Journal(projectJournalDir(project)).trimThrough(old.sequence);
    return project.id;
  }
  return { repo, remote, baseline, configPath, projectId, server, bridge, installHook, appendBoundary, registerProject, git, gitAsync };
}

module.exports = { prepareMaintenanceFixture };
