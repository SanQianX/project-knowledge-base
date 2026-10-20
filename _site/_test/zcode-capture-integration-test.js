const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');
const { IntegrationManager, normalizeClient, SUPPORTED_CLIENTS } = require('../lib/integration-installer');
const { createRuntime, createRequestHandler } = require('../lib/server-app');
const { BridgeAdapter } = require('../lib/bridge-adapter');
const { Logger, LogRepository } = require('../lib/structured-logger');
const { StorageLayout } = require('../lib/storage-layout');
const { runCli } = require('../../bin/project-knowledge-integrations');

(async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-zcode-capture-'));
  const homeDir = path.join(temp, '用户 空格');
  const bridgeHomeDir = path.join(temp, 'events');
  const configFile = path.join(homeDir, '.zcode', 'cli', 'config.json');
  const layout = new StorageLayout({ dataDir: path.join(temp, 'data') });
  const logger = new Logger({ layout });
  const options = { homeDir, env: {}, bridgeHomeDir, zcodeConfigFile: configFile, commandResolver: () => '', logger };
  const manager = new IntegrationManager(options);
  let server;
  try {
    assert(SUPPORTED_CLIENTS.includes('zcode'));
    assert.equal(normalizeClient(' ZCode '), 'zcode');
    assert.deepEqual(manager.detectClients(), []);
    const before = await manager.statusAll();
    assert.equal(before.clients.length, 4, 'status includes tools not found without installing them');
    assert.equal(before.clients.find(a => a.client === 'zcode').developmentCapture.installed, false);
    assert(!fs.existsSync(configFile), 'status and uninstall must not manufacture user config');
    await manager.operateCapture('uninstall', ['zcode']);
    assert(!fs.existsSync(configFile));

    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    const thirdParty = { type: 'process', command: 'other', args: ['third-party'] };
    fs.writeFileSync(configFile, JSON.stringify({ provider: { name: '保留' }, hooks: { enabled: false, events: { Stop: [{ hooks: [thirdParty] }] } } }));
    assert.deepEqual(manager.detectClients(), ['zcode'], 'desktop ZCode config is discoverable without a PATH CLI');
    const installed = await manager.installAll({ clients: ['zcode'], captureOnly: true });
    assert(installed.bridge.ok && installed.clients[0].developmentCapture.ok);
    assert.equal(installed.clients[0].knowledgeIntegration, undefined);
    const config = JSON.parse(fs.readFileSync(configFile));
    assert.equal(config.hooks.enabled, true);
    assert.equal(config.provider.name, '保留');
    assert(config.hooks.events.Stop[0].hooks.some(h => h.command === 'other'));
    await manager.installAll({ clients: ['zcode'], captureOnly: true });
    const twice = JSON.parse(fs.readFileSync(configFile));
    assert.equal(twice.hooks.events.UserPromptSubmit.length, 1);
    assert.equal(twice.hooks.events.Stop.length, 2);
    const status = await manager.statusAll({ clients: ['zcode'] });
    assert(status.clients[0].configFound && status.clients[0].developmentCapture.installed);
    assert.equal(status.clients[0].knowledgeIntegration.installed, false);
    assert.equal(status.clients[0].knowledgeIntegration.supported, true, 'native context is supported but capture alone does not install it');
    assert.equal(status.clients[0].automaticContext.configured, false, 'capture alone never implies automatic knowledge readiness');
    assert.equal(await runCli(['update', '--ide', 'zcode', '--capture-only', '--json'], { manager }), 0);
    const dry = new IntegrationManager({ ...options, dryRun: true });
    const untouched = fs.readFileSync(configFile, 'utf8');
    await runCli(['uninstall', '--ide', 'zcode', '--capture-only', '--dry-run'], { manager: dry });
    assert.equal(fs.readFileSync(configFile, 'utf8'), untouched);

    const runtime = createRuntime({ dataDir: layout.getDataDir(), logger, analysisOwner: 'engine', bridgeAdapter: new BridgeAdapter({ dataDir: layout.getDataDir(), bridgeHomeDir }) });
    let startupRepairStops = 0;
    runtime.integrationAutoRepair = { close: async () => { startupRepairStops++; }, status: () => ({}) };
    server = http.createServer(createRequestHandler(runtime, { integrationOptions: options }));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const request = async (route, body) => {
      const response = await fetch(base + route, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
      assert.equal(response.status, 200);
      return response.json();
    };
    const apiInstall = await request('/api/integrations/install', { clients: ['zcode'], captureOnly: true });
    assert.equal(startupRepairStops, 1, 'manual install cancels concurrent startup repair');
    assert.equal(apiInstall.complete, true);
    assert(apiInstall.operationId);
    const apiStatus = await request('/api/integrations/status');
    assert(apiStatus.clients.find(a => a.client === 'zcode').developmentCapture.installed);
    fs.writeFileSync(configFile, '{invalid JSON');
    const failed = await request('/api/integrations/install', { clients: ['zcode'], captureOnly: true });
    assert.equal(failed.complete, false, 'HTTP 200 does not imply capture succeeded');
    assert.equal(failed.clients[0].developmentCapture.ok, false);
    assert(failed.clients[0].developmentCapture.error.code);
    await logger.flush();
    const errors = new LogRepository({ layout }).query({ event: 'integration.capture.failed' }).entries;
    assert(errors.some(entry => entry.operationId === failed.operationId && entry.context.client === 'zcode' && entry.error.message.includes('JSON')), 'actual failed phase and operation ID are persisted');
    fs.writeFileSync(configFile, JSON.stringify(twice));
    const removed = await request('/api/integrations/uninstall', { clients: ['zcode'], captureOnly: true });
    assert.equal(startupRepairStops, 3, 'manual uninstall cancels startup repair before removing client hooks');
    assert.equal(removed.complete, true);
    assert.deepEqual(removed.clients, [], 'capture-only removal does not invoke knowledge plugin operations');
    assert.equal(removed.capture[0].state, 'removed');
    const after = JSON.parse(fs.readFileSync(configFile));
    assert.equal(after.provider.name, '保留');
    assert.deepEqual(after.hooks.events.Stop[0].hooks, [thirdParty]);
    assert.equal((await manager.statusAll({ clients: ['zcode'] })).clients[0].developmentCapture.installed, false);
    const facade = manager._bridgeFacade();
    assert(await facade.getConsumer('project-knowledge'), 'removing one connector retains the host consumer');

    const cliEnv = { ...process.env, USERPROFILE: homeDir, HOME: homeDir, KB_DATA_DIR: layout.getDataDir(), AI_CODING_EVENT_BRIDGE_HOME: bridgeHomeDir };
    const cli = spawnSync(process.execPath, [path.resolve(__dirname, '../../bin/project-knowledge-integrations.js'), 'install', '--ide', 'zcode', '--capture-only', '--json'], { env: cliEnv, encoding: 'utf8', timeout: 15000 });
    assert.equal(cli.status, 0, cli.stderr);
    assert(JSON.parse(cli.stdout).clients[0].developmentCapture.installed);
    await logger.flush();
    assert(new LogRepository({ layout }).query({ event: 'integration.capture.completed' }).entries.length > 0, 'CLI operations also write durable logs');
    console.log('zcode-capture-integration-test PASS');
  } finally {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await logger.close();
    // This test owns a single mkdtemp sandbox, never real Agent configs.
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
