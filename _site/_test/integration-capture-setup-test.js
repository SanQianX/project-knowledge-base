// Run: node _site/_test/integration-capture-setup-test.js
//
// T18 gates (INSTALL-001/002/003): one Project-Knowledge setup installs
// Knowledge Integration + Development Capture without opening any client UI;
// per-client status reports the two capabilities separately; third-party
// config is preserved; Codex notify conflicts are reported, not overwritten;
// connector uninstall keeps the host Bridge consumer until a global disable.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { IntegrationManager } = require('../lib/integration-installer');
const { createBridge } = require('@sanqianx/ai-coding-event-bridge');

const ROOT = path.resolve(__dirname, '..', '..');
const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), `pk-integration-capture-${process.pid}-`));
const homeDir = path.join(TEMP, 'home');
const bridgeHome = path.join(TEMP, 'bridge-home');
const claudeSettings = path.join(TEMP, 'claude-settings.json');
const codexConfig = path.join(TEMP, 'codex-config.toml');
const openCodePlugins = path.join(TEMP, 'opencode-plugins');

function makeManager() {
  return new IntegrationManager({
    rootDir: ROOT,
    homeDir,
    env: {},
    commandResolver: name => name,
    runner: (command, args) => ({ status: 0, stdout: '', stderr: '' }),
    bridgeHomeDir: bridgeHome,
    claudeSettingsFile: claudeSettings,
    codexConfigFile: codexConfig,
    openCodePluginsDir: openCodePlugins,
  });
}

async function main() {
  const manager = makeManager();

  // Third-party entries pre-exist; they must survive every operation.
  fs.mkdirSync(path.dirname(claudeSettings), { recursive: true });
  fs.writeFileSync(claudeSettings, JSON.stringify({
    model: 'sonnet',
    hooks: { Stop: [{ matcher: '*', hooks: [{ type: 'command', command: 'node /somewhere/notify-user.js' }] }] },
  }));
  fs.mkdirSync(path.dirname(codexConfig), { recursive: true });
  fs.writeFileSync(codexConfig, 'model = "gpt-5"\nnotify = ["python", "C:/tools/my-notify.py"]\n');
  fs.mkdirSync(openCodePlugins, { recursive: true });
  fs.writeFileSync(path.join(openCodePlugins, 'my-own-plugin.js'), '// third party\n');

  // GATE INSTALL-001: one setup action, both capabilities, no client UI.
  const installed = await manager.installAll({ clients: ['claude', 'codex', 'opencode'] });
  assert.strictEqual(installed.bridge.ok, true, 'host Bridge consumer registered once');
  assert.strictEqual(installed.bridge.consumerName, 'project-knowledge');
  for (const entry of installed.clients) {
    assert.strictEqual(entry.knowledgeIntegration.ok, true, `${entry.client} knowledge integration installs`);
    const expectedCapture = entry.client === 'codex' ? 'conflict' : 'installed';
    assert.strictEqual(entry.developmentCapture.state, expectedCapture, `${entry.client} development capture state`);
  }

  // Claude managed hooks written programmatically into the user config.
  const settings = JSON.parse(fs.readFileSync(claudeSettings, 'utf8'));
  const managedClaude = settings.hooks.UserPromptSubmit.some(group => group.hooks.some(hook => String(hook.command).includes('bridge-hook.cjs')));
  assert.strictEqual(managedClaude, true, 'managed Bridge hooks written to Claude user config without any interactive Claude step');
  assert.strictEqual(settings.hooks.Stop.some(group => group.hooks.some(hook => hook.command === 'node /somewhere/notify-user.js')), true, 'Claude third-party hook preserved');

  // GATE INSTALL-002: Codex third-party notify conflict reported, not overwritten.
  const codexEntry = installed.clients.find(entry => entry.client === 'codex');
  assert.strictEqual(codexEntry.developmentCapture.state, 'conflict', 'Codex reports the third-party notify conflict');
  assert.strictEqual(codexEntry.knowledgeIntegration.ok, true, 'Knowledge Integration stays independent of the Codex capture conflict');
  assert(fs.readFileSync(codexConfig, 'utf8').includes('my-notify.py'), 'third-party notifier never overwritten');

  // OpenCode managed plugin installed alongside third-party files.
  assert(fs.existsSync(path.join(openCodePlugins, 'ai-coding-event-bridge.js')), 'managed OpenCode plugin written');
  assert(fs.existsSync(path.join(openCodePlugins, 'my-own-plugin.js')), 'third-party plugin preserved');

  // Status reports the two capabilities separately.
  const status = await manager.statusAll({ clients: ['claude', 'codex', 'opencode'] });
  assert.strictEqual(status.bridge.consumerRegistered, true);
  assert.strictEqual(status.bridge.bridgeHealthy, true);
  const claudeStatus = status.clients.find(entry => entry.client === 'claude');
  assert.strictEqual(claudeStatus.developmentCapture.installed, true);
  const codexStatus = status.clients.find(entry => entry.client === 'codex');
  assert.strictEqual(codexStatus.developmentCapture.conflict, true, 'conflict surfaces in status');
  assert.ok(Number.isInteger(status.bridge.health.lastSequence), 'bridge health fields available for the UI');

  // GATE INSTALL-003: removing one connector keeps the host consumer.
  await manager.uninstallCaptureClaude({});
  const facade = createBridge({ homeDir: bridgeHome });
  assert.strictEqual(Boolean(await facade.getConsumer('project-knowledge')), true, 'consumer survives a single connector uninstall');
  const settingsAfterClaude = JSON.parse(fs.readFileSync(claudeSettings, 'utf8'));
  assert.strictEqual(settingsAfterClaude.hooks.UserPromptSubmit, undefined, 'managed Claude hook removed');
  assert.strictEqual(settingsAfterClaude.hooks.Stop[0].hooks[0].command, 'node /somewhere/notify-user.js', 'third-party hook still intact');

  // Another registered consumer stays untouched by a global disable.
  await facade.registerConsumer('devtask-radar');
  const disabled = await manager.disableAllCapture({ clients: ['claude', 'codex', 'opencode'] });
  assert.strictEqual(disabled.consumer.ok, true, 'global disable unregisters the project-knowledge consumer');
  const consumers = await facade.listConsumers();
  assert.deepStrictEqual(consumers.map(consumer => consumer.name), ['devtask-radar'], 'other consumers remain');
  assert(!fs.existsSync(path.join(openCodePlugins, 'ai-coding-event-bridge.js')), 'managed plugin removed');
  assert(fs.existsSync(path.join(openCodePlugins, 'my-own-plugin.js')), 'third-party plugin survives global disable');

  console.log('integration-capture-setup-test PASS');
}

module.exports = main();
