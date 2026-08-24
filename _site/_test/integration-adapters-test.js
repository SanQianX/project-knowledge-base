// Run: node _site/_test/integration-adapters-test.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  IntegrationManager,
  removeOpenCodeMcpConfig,
  removeOpenCodeInstructionConfig,
} = require('../lib/integration-installer');

const ROOT = path.resolve(__dirname, '..', '..');
const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), `project-knowledge-integrations-${process.pid}-`));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

async function main() {
  const packageInfo = readJson(path.join(ROOT, 'package.json'));
  const pluginRoot = path.join(ROOT, 'plugins', 'project-knowledge');
  const claudeManifest = readJson(path.join(pluginRoot, '.claude-plugin', 'plugin.json'));
  const codexManifest = readJson(path.join(pluginRoot, '.codex-plugin', 'plugin.json'));
  const mcpManifest = readJson(path.join(pluginRoot, '.mcp.json'));
  const claudeMarketplace = readJson(path.join(ROOT, '.claude-plugin', 'marketplace.json'));
  const codexMarketplace = readJson(path.join(ROOT, '.agents', 'plugins', 'marketplace.json'));
  const skillPath = path.join(pluginRoot, 'skills', 'project-knowledge', 'SKILL.md');
  const skill = fs.readFileSync(skillPath, 'utf8');

  assert(claudeManifest.version === packageInfo.version, 'Claude plugin version should match the npm package');
  assert(codexManifest.version === packageInfo.version, 'Codex plugin version should match the npm package');
  assert(claudeMarketplace.plugins[0].version === packageInfo.version, 'Claude marketplace version should match the npm package');
  assert(codexMarketplace.name === 'project-knowledge', 'Codex marketplace should have a stable public name');
  assert(codexMarketplace.plugins[0].source.path === './plugins/project-knowledge', 'Codex marketplace should point at the shared plugin');
  assert(mcpManifest.mcpServers['project-knowledge'].args.includes(`project-knowledge@${packageInfo.version}`), 'plugin MCP should pin the matching package version');
  assert(!skill.includes('[TODO:'), 'bundled Skill should not contain scaffold placeholders');
  assert(skill.includes('project_knowledge_resolve'), 'bundled Skill should teach the resolve-first workflow');
  assert(skill.includes('project_knowledge_record_requirement'), 'bundled Skill should document the explicit supplemental adapter');
  assert(skill.includes('only when the user explicitly requests supplemental capture'), 'bundled Skill must not make cooperative requirement recording mandatory');
  assert(!/Before implementing a user request, call `project_knowledge_record_requirement`/.test(skill), 'automatic capture must remain primary');

  const calls = [];
  const homeDir = path.join(TEMP, 'home');
  const manager = new IntegrationManager({
    rootDir: ROOT,
    homeDir,
    env: {},
    commandResolver: name => name,
    runner: (command, args) => {
      calls.push({ command, args });
      return { status: 0, stdout: '', stderr: '' };
    },
  });
  const openCodeResult = await manager.operate('install', ['opencode']);
  assert(openCodeResult[0].ok, 'OpenCode installation should complete');
  assert(fs.existsSync(path.join(homeDir, '.config', 'opencode', 'skills', 'project-knowledge', 'SKILL.md')), 'OpenCode should receive the global Skill');
  const installedInstruction = path.join(homeDir, '.config', 'opencode', 'instructions', 'project-knowledge.md');
  assert(fs.existsSync(installedInstruction), 'OpenCode should receive the global Instructions file');
  const installedConfig = fs.readFileSync(path.join(homeDir, '.config', 'opencode', 'opencode.jsonc'), 'utf8');
  assert(installedConfig.includes(installedInstruction.replace(/\\/g, '\\\\')), 'OpenCode config should reference the installed Instructions file');
  const openCodeCall = calls.find(call => call.command === 'opencode');
  assert(openCodeCall?.args.join(' ') === `mcp add project-knowledge -- npx -y --package project-knowledge@${packageInfo.version} project-knowledge-mcp`, 'OpenCode should receive the versioned MCP command');

  const configDir = path.join(TEMP, 'opencode-config');
  fs.mkdirSync(configDir, { recursive: true });
  const configPath = path.join(configDir, 'opencode.jsonc');
  fs.writeFileSync(configPath, `{
  // Keep this user comment.
  "instructions": [
    "C:\\\\keep\\\\team-rules.md",
    "${path.join(configDir, 'instructions', 'project-knowledge.md').replace(/\\/g, '\\\\')}"
  ],
  "mcp": {
    "project-knowledge": { "type": "local", "command": ["npx"] },
    "other": { "type": "remote", "url": "https://example.test/mcp" }
  }
}
`, 'utf8');
  assert(removeOpenCodeMcpConfig(configDir), 'OpenCode uninstall should remove its MCP entry');
  const updatedConfig = fs.readFileSync(configPath, 'utf8');
  assert(updatedConfig.includes('Keep this user comment'), 'OpenCode config comments should be preserved');
  assert(updatedConfig.includes('"other"'), 'uninstall should preserve unrelated MCP servers');
  assert(!updatedConfig.includes('"project-knowledge"'), 'uninstall should remove only the Project Knowledge MCP');
  const instructionPath = path.join(configDir, 'instructions', 'project-knowledge.md');
  assert(removeOpenCodeInstructionConfig(configDir, instructionPath), 'OpenCode uninstall should remove its Instructions reference');
  const instructionUpdated = fs.readFileSync(configPath, 'utf8');
  assert(instructionUpdated.includes('team-rules.md'), 'uninstall should preserve unrelated OpenCode instructions');
  assert(!instructionUpdated.includes(instructionPath.replace(/\\/g, '\\\\')), 'uninstall should remove only its Instructions reference');

  const claudeCalls = [];
  const claudeManager = new IntegrationManager({
    rootDir: ROOT,
    commandResolver: name => name,
    runner: (command, args) => {
      claudeCalls.push({ command, args });
      if (args.join(' ') === 'plugin marketplace list --json') return { status: 0, stdout: '[]', stderr: '' };
      if (args.join(' ') === 'plugin list --json') return { status: 0, stdout: '[]', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    },
  });
  const claudeResult = await claudeManager.operate('install', ['claude'], { scope: 'user' });
  assert(claudeResult[0].ok, 'Claude Code installation should complete');
  assert(claudeCalls.some(call => call.args.join(' ') === 'plugin marketplace add SanQianX/project-knowledge-base'), 'Claude Code should register the GitHub marketplace');
  assert(claudeCalls.some(call => call.args.join(' ') === 'plugin install project-knowledge@project-knowledge --scope user'), 'Claude Code should install the native plugin');

  const codexCalls = [];
  const codexManager = new IntegrationManager({
    rootDir: ROOT,
    commandResolver: name => name,
    runner: (command, args) => {
      codexCalls.push({ command, args });
      if (args.join(' ') === 'plugin marketplace list') {
        return { status: 0, stdout: `MARKETPLACE ROOT\nproject-knowledge ${ROOT}\n`, stderr: '' };
      }
      if (args.join(' ') === 'plugin list --json') {
        return {
          status: 0,
          stdout: JSON.stringify({ installed: [{ pluginId: 'project-knowledge@project-knowledge' }] }),
          stderr: '',
        };
      }
      return { status: 0, stdout: '', stderr: '' };
    },
  });
  const codexResult = await codexManager.operate('update', ['codex']);
  assert(codexResult[0].ok, 'Codex update should complete');
  assert(codexCalls.some(call => call.args.join(' ') === 'plugin marketplace upgrade project-knowledge'), 'Codex should refresh its marketplace');
  assert(codexCalls.some(call => call.args.join(' ') === 'plugin remove project-knowledge@project-knowledge'), 'Codex should remove the cached plugin during update');
  assert(codexCalls.some(call => call.args.join(' ') === 'plugin add project-knowledge@project-knowledge'), 'Codex should install the refreshed plugin');

  const chainedCodexConfig = path.join(TEMP, 'codex-config.toml');
  const oldNotifier = Buffer.from(JSON.stringify(['node', 'C:/existing-notify.js'])).toString('base64');
  fs.writeFileSync(chainedCodexConfig, `notify = ["node", "C:/tools/devtask-radar/connectors/codex/notify-hook.js", "--previous-notify", "${oldNotifier}"]\n`, 'utf8');
  const chainedManager = new IntegrationManager({
    rootDir: ROOT,
    homeDir: path.join(TEMP, 'codex-home'),
    bridgeHomeDir: path.join(TEMP, 'bridge-home'),
    codexConfigFile: chainedCodexConfig,
  });
  const chained = await chainedManager.installCaptureCodex();
  assert(chained.installed && !chained.conflict, 'a compatible DevTask Radar notifier should chain Bridge instead of blocking capture');
  const chainedConfig = JSON.parse(fs.readFileSync(chainedCodexConfig, 'utf8').replace(/^\s*notify\s*=\s*/, '').trim());
  const nextIndex = chainedConfig.indexOf('--next-base64');
  assert(nextIndex >= 0, 'compatible notifier chain should append a downstream Bridge notifier');
  const nextNotify = JSON.parse(Buffer.from(chainedConfig[nextIndex + 1], 'base64').toString('utf8'));
  assert(nextNotify.join(' ').includes('bridge-hook.cjs'), 'downstream notifier must be the Bridge shim');
  const chainedStatus = await chainedManager.statusCaptureCodex();
  assert(chainedStatus.installed && !chainedStatus.conflict, 'status should recognize the compatible chained notifier');

  const nestedCodexConfig = path.join(TEMP, 'nested-codex-config.toml');
  const nestedDevTask = ['node', 'C:/tools/devtask-radar/connectors/codex/notify-hook.js', '--next-base64', oldNotifier];
  fs.writeFileSync(nestedCodexConfig, `notify = ["C:/runtime/codex-computer-use.exe", "turn-ended", "--previous-notify", ${JSON.stringify(JSON.stringify(nestedDevTask))}]\n`, 'utf8');
  const nestedManager = new IntegrationManager({
    rootDir: ROOT,
    homeDir: path.join(TEMP, 'nested-codex-home'),
    bridgeHomeDir: path.join(TEMP, 'nested-bridge-home'),
    codexConfigFile: nestedCodexConfig,
  });
  const nested = await nestedManager.installCaptureCodex();
  assert(nested.installed && !nested.conflict, 'a nested DevTask Radar notifier should be preserved through the fan-out wrapper');
  const nestedConfig = JSON.parse(fs.readFileSync(nestedCodexConfig, 'utf8').replace(/^\s*notify\s*=\s*/, '').trim());
  assert(nestedConfig.join(' ').includes('codex-notify-fanout.cjs'), 'nested notifier chain should use the Project Knowledge fan-out wrapper');
  const nestedStatus = await nestedManager.statusCaptureCodex();
  assert(nestedStatus.installed && !nestedStatus.conflict, 'status should recognize the managed nested fan-out wrapper');

  // Codex Desktop computer-use wraps the existing notifier as a JSON array in
  // --previous-notify. The managed fan-out is still installed and must not be
  // misreported as a third-party conflict or wrapped a second time.
  const desktopWrappedConfig = path.join(TEMP, 'desktop-wrapped-codex-config.toml');
  const desktopWrappedArgs = ['C:/runtime/codex-computer-use.exe', 'turn-ended', '--previous-notify', JSON.stringify(nestedConfig)];
  fs.writeFileSync(desktopWrappedConfig, `notify = ${JSON.stringify(desktopWrappedArgs)}\n`, 'utf8');
  const desktopWrappedManager = new IntegrationManager({
    rootDir: ROOT,
    homeDir: path.join(TEMP, 'desktop-wrapped-codex-home'),
    bridgeHomeDir: path.join(TEMP, 'nested-bridge-home'),
    codexConfigFile: desktopWrappedConfig,
  });
  const desktopWrappedStatus = await desktopWrappedManager.statusCaptureCodex();
  assert(desktopWrappedStatus.installed && !desktopWrappedStatus.conflict,
    'Codex Desktop outer wrapper should preserve managed capture health');
  const beforeDesktopInstall = fs.readFileSync(desktopWrappedConfig, 'utf8');
  const desktopWrappedInstall = await desktopWrappedManager.installCaptureCodex();
  assert(desktopWrappedInstall.installed && !desktopWrappedInstall.conflict,
    'one-click repair should recognize the nested managed fan-out');
  assert(fs.readFileSync(desktopWrappedConfig, 'utf8') === beforeDesktopInstall,
    'healthy Codex Desktop wrapper must remain byte-for-byte unchanged');

  const bridgeOnlyConfig = path.join(TEMP, 'bridge-only-codex-config.toml');
  const bridgeOnlyManager = new IntegrationManager({
    rootDir: ROOT,
    homeDir: path.join(TEMP, 'bridge-only-codex-home'),
    bridgeHomeDir: path.join(TEMP, 'bridge-only-bridge-home'),
    codexConfigFile: bridgeOnlyConfig,
  });
  const bridgeOnly = await bridgeOnlyManager.installCaptureCodex();
  assert(bridgeOnly.installed && !bridgeOnly.conflict, 'a fresh Codex install should use the payload-preserving fan-out wrapper');
  const bridgeOnlyArgs = JSON.parse(fs.readFileSync(bridgeOnlyConfig, 'utf8').replace(/^\s*notify\s*=\s*/, '').trim());
  assert(bridgeOnlyArgs.join(' ').includes('codex-notify-fanout.cjs'), 'fresh Codex install should use the Project Knowledge fan-out wrapper');

  const integrationLogs = [];
  const failingManager = new IntegrationManager({
    rootDir: ROOT,
    commandResolver: name => name,
    runner: () => ({ status: 9, stdout: '', stderr: 'failure includes sk-do-not-log' }),
    logger: {
      info: async (event, message, payload) => integrationLogs.push({ event, message, payload }),
      error: async (event, message, payload) => integrationLogs.push({ event, message, payload }),
    },
  });
  const failedIntegration = await failingManager.operate('install', ['claude']);
  assert(!failedIntegration[0].ok, 'integration command failure should remain visible to the caller');
  assert(integrationLogs.some(entry => entry.event === 'integration.command_started'));
  assert(integrationLogs.some(entry => entry.event === 'integration.command_failed' && entry.payload.error.code === 'INTEGRATION_COMMAND_FAILED'));
  assert(!JSON.stringify(integrationLogs).includes('sk-do-not-log'), 'integration logs must hash command output instead of recording it');

  const routed = spawnSync(process.execPath, [
    path.join(ROOT, 'bin', 'project-knowledge.js'),
    'install',
    '--ide',
    'opencode',
    '--dry-run',
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    windowsHide: true,
  });
  assert(routed.status === 0, `main CLI should route integration commands: ${routed.stderr}`);
  assert(routed.stdout.includes('project-knowledge-mcp'), 'routed dry-run should show the MCP installation');

  console.log('integration-adapters-test PASS');
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}).finally(() => {
  fs.rmSync(TEMP, { recursive: true, force: true });
});
