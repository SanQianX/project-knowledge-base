'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { IntegrationManager } = require('../lib/integration-installer');
const { IntegrationStatusScan } = require('../lib/integration-status-scan');
const { summarizeClient } = require('../lib/integration-intent');

async function testClaudeInventory() {
  const rootDir = path.resolve(__dirname, '../..');
  const { version } = require('../../package.json');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-claude-status-'));
  const configDir = path.join(temp, 'Claude config');
  const commandDir = path.join(temp, 'test bin');
  const userInstall = path.join(temp, 'installed-user');
  const projectInstall = path.join(temp, 'installed-project');
  const project = path.join(temp, 'project');
  const registry = path.join(configDir, 'plugins', 'installed_plugins.json');
  const settings = path.join(configDir, 'settings.json');
  const pluginId = 'project-knowledge@project-knowledge';
  const windows = process.platform === 'win32';
  const command = path.join(commandDir, windows ? 'claude.cmd' : 'claude');
  const cliMarker = path.join(commandDir, 'cli-invoked.txt');
  const env = {
    CLAUDE_CONFIG_DIR: configDir,
    KB_DATA_DIR: path.join(temp, 'data'),
    ...(windows ? { Path: '"' + commandDir + '"', PATHEXT: '.CMD' } : { PATH: commandDir }),
  };
  const write = (file, json) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(json));
  };
  try {
    fs.mkdirSync(commandDir, { recursive: true });
    const fakeCli = windows ? '@echo attempted>"%~dp0cli-invoked.txt"\r\n@exit /b 1\r\n'
      : '#!/bin/sh\nprintf attempted > ' + "'" + cliMarker.replace(/'/g, "'\\''") + "'\nexit 1\n";
    fs.writeFileSync(command, fakeCli, { mode: 0o755 });
    for (const installDir of [userInstall, projectInstall]) {
      for (const file of ['hooks/claude.json', 'scripts/context-hook.cjs', 'scripts/mcp-launcher.cjs', '.mcp.json', '.claude-plugin/plugin.json']) {
        const target = path.join(installDir, file);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(path.join(rootDir, 'plugins', 'project-knowledge', file), target);
      }
    }
    write(registry, { version: 2, plugins: { [pluginId]: [
      { scope: 'user', version, installPath: userInstall },
      { scope: 'project', projectPath: project, version, installPath: projectInstall },
    ] } });
    write(settings, { enabledPlugins: { [pluginId]: true } });
    const launchers = [];
    let nativeCalls = 0;
    const manager = new IntegrationManager({
      rootDir, homeDir: temp, localStatus: true,
      env,
      runner: () => { nativeCalls++; throw new Error('Native CLI must be idle during this status check.'); },
      bridgeModule: { installers: { claudeCode: { statusClaudeCodeHook: async () => ({ installed: false }) } } },
      mcpProbe: async info => { launchers.push(info.launcherPath); return { state: 'ready' }; },
    });
    const status = async cwd => (await manager.statusAll({ clients: ['claude'], cwd, includeShared: false })).clients[0];
    const user = await status();
    assert.equal(user.available, true, 'the background check locates the executable on PATH');
    assert.equal(user.configFound, true, 'the configured Claude home supplies both the inventory and settings');
    assert.equal(user.knowledgeIntegration.state, 'installed');
    assert.equal(user.automaticContext.configured, true, 'local inventory still verifies the actual installed context files');
    assert.equal(user.mcpStartup.state, 'ready');
    assert.equal(launchers.at(-1), path.join(userInstall, 'scripts', 'mcp-launcher.cjs'));

    const productionWorker = new IntegrationStatusScan();
    try {
      const summary = await productionWorker.read({ rootDir, homeDir: temp, env, bridgeHomeDir: path.join(temp, 'events') }, { clients: ['claude'] }, { waitMs: 5000 });
      assert.equal(summary.clients[0].scan.state, 'ready', 'the production worker must return the installed plugin');
      assert.equal(summary.clients[0].knowledgeIntegration.state, 'installed');
      assert.equal(summary.clients[0].automaticContext.configured, true);
      assert.equal(fs.existsSync(cliMarker), false, 'even the production worker never starts the native Claude CLI');
    } finally { productionWorker.close(); }

    await status(project);
    assert.equal(launchers.at(-1), path.join(projectInstall, 'scripts', 'mcp-launcher.cjs'), 'the current project registration takes precedence');
    write(path.join(project, '.claude', 'settings.local.json'), { enabledPlugins: { [pluginId]: false } });
    const disabled = await status(project);
    assert.equal(disabled.knowledgeIntegration.state, 'disabled');
    assert.equal(disabled.automaticContext.configured, false);
    assert.equal(launchers.length, 2, 'disabled plugins are not launched');
    write(registry, { version: 999, plugins: {} });
    const unknown = await status(project);
    assert.equal(unknown.knowledgeIntegration.state, 'check-failed');
    assert.equal(unknown.knowledgeIntegration.error.code, 'CLAUDE_PLUGIN_INDEX_UNSUPPORTED');
    assert.equal(nativeCalls, 0, 'healthy and unreadable inventories never cold-start Claude for web status');
  } finally {
    const resolved = fs.realpathSync(temp);
    assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('kb-claude-status-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}

async function main() {
  await testClaudeInventory();
  const workerFile = path.join(__dirname, 'fixtures/integration-busy-worker.cjs');
  const managerOptions = { rootDir: path.resolve(__dirname, '../..') };
  const scan = new IntegrationStatusScan({ workerFile, timeoutMs: 5000 });
  try {
    const before = Date.now();
    const first = await scan.read({ rootDir: path.resolve(__dirname, '../..') }, { clients: ['claude'] }, { waitMs: 50 });
    assert.equal(first.scan.state, 'checking'); assert.ok(Date.now() - before < 500);
    const again = await scan.read({ rootDir: path.resolve(__dirname, '../..') }, { clients: ['claude'] }, { waitMs: 10 });
    assert.equal(first.scan.generation, again.scan.generation);
    assert.equal(scan.entries.size, 2, 'client and shared status have separate cached jobs');
    let ticked = false; await new Promise(resolve => setTimeout(() => { ticked = true; resolve(); }, 20));
    assert.equal(ticked, true, 'a blocked probe cannot freeze the HTTP event loop');
    const ready = await scan.read(managerOptions, { clients: ['claude'] }, { waitMs: 4500 });
    assert.equal(ready.scan.state, 'ready'); assert.equal(ready.clients[0].available, true);
    const stale = await scan.read(managerOptions, { clients: ['claude'], fixtureError: true }, { force: true, waitMs: 2000 });
    assert.equal(stale.clients[0].scan.error.code, 'INTEGRATION_STATUS_EXITED');
    assert.equal(stale.clients[0].scan.stale, true);
    assert.equal(stale.clients[0].scan.checkedAt, ready.clients[0].scan.checkedAt);
    assert.equal(summarizeClient(stale.clients[0]), 'connected');
    scan.invalidate(['claude']);
    const invalidated = await scan.read(managerOptions, { clients: ['claude'], fixtureError: true }, { waitMs: 2000 });
    assert.equal(summarizeClient(invalidated.clients[0]), 'check-failed', 'a superseded configuration cannot pass a later status check');
    console.log('Isolated status scan, coalescing and nonblocking snapshot passed.');
  } finally { scan.close(); }
  const logs = [], timed = new IntegrationStatusScan({ workerFile, timeoutMs: 100 });
  try {
    const result = await timed.read({ rootDir: path.resolve(__dirname, '../..'), operationId: 'status-timeout-test', logger: { warn: (...args) => logs.push(args) } }, { clients: ['claude'] }, { waitMs: 500 });
    assert.equal(result.error.code, 'INTEGRATION_STATUS_TIMEOUT');
    assert.equal(result.clients[0].automaticContext.state, 'check-failed');
    assert.equal(summarizeClient(result.clients[0]), 'check-failed');
    const timeout = logs.find(event => event[2].context.clients.includes('claude'));
    assert.equal(timeout[0], 'integration.status.timeout');
    assert.equal(timeout[2].operationId, 'status-timeout-test');
  } finally { timed.close(); }

  const independent = new IntegrationStatusScan({ workerFile, timeoutMs: 2500 });
  try {
    const options = { fixtureDelay: 5000, fixturePartial: true };
    let partial;
    for (let attempt = 0; attempt < 4; attempt++) {
      partial = await independent.read(managerOptions, options, { waitMs: 500 });
      if (partial.clients.filter(row => row.client !== 'claude' && row.scan.state === 'ready').length === 3
          && partial.clients.find(row => row.client === 'claude').developmentCapture.installed === true) break;
    }
    assert.equal(partial.scan.state, 'refreshing');
    assert.equal(partial.clients.find(row => row.client === 'claude').scan.state, 'refreshing');
    assert.equal(partial.clients.filter(row => row.client !== 'claude' && row.scan.state === 'ready').length, 3);
    const done = await independent.read(managerOptions, options, { waitMs: 3000 });
    const claude = done.clients.find(row => row.client === 'claude');
    assert.equal(claude.scan.error.code, 'INTEGRATION_STATUS_TIMEOUT');
    assert.equal(claude.developmentCapture.installed, true, 'the verified capture result survives a detailed probe timing out');
    assert.equal(claude.knowledgeIntegration.state, 'check-failed');
    assert.ok(done.clients.filter(row => row.client !== 'claude').every(row => row.scan.state === 'ready' && !row.scan.error));
    const sharedGeneration = done.scan.generation;
    const recheck = await independent.read(managerOptions, { clients: ['claude'], fixtureDelay: 0 }, { force: true, waitMs: 2000 });
    assert.ok(recheck.scan.generation > sharedGeneration);
    assert.equal(recheck.clients[0].knowledgeIntegration.state, 'installed');
    console.log('Isolated client timeout, preserved partial capture and single-client refresh passed.');
  } finally { independent.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
