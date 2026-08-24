const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const crossSpawn = require('cross-spawn');
const { applyEdits, modify, parse } = require('jsonc-parser');
const packageInfo = require('../../package.json');

// Fail-open module resolution: a missing/unloadable Bridge package must
// degrade Development Capture status, never crash server startup.
let bridgeModule = null;
try {
  bridgeModule = require('@sanqianx/ai-coding-event-bridge');
} catch (_) {
  bridgeModule = null;
}

const INTEGRATION_NAME = 'project-knowledge';
const MARKETPLACE_NAME = 'project-knowledge';
const DEFAULT_MARKETPLACE_SOURCE = 'SanQianX/project-knowledge-base';
const SUPPORTED_CLIENTS = ['claude', 'opencode', 'codex'];
const DEFAULT_BRIDGE_CONSUMER = 'project-knowledge';
const CLIENT_LABELS = {
  claude: 'Claude Code',
  opencode: 'OpenCode',
  codex: 'Codex',
};
const CLIENT_METHOD_SUFFIX = {
  claude: 'Claude',
  opencode: 'OpenCode',
  codex: 'Codex',
};

function normalizeClient(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'claude-code' || normalized === 'claudecode') return 'claude';
  if (normalized === 'codex-cli') return 'codex';
  if (SUPPORTED_CLIENTS.includes(normalized)) return normalized;
  throw new Error(`unsupported client: ${value}`);
}

function defaultCommandResolver(name, env = process.env) {
  const lookup = process.platform === 'win32' ? 'where.exe' : 'which';
  const result = spawnSync(lookup, [name], {
    encoding: 'utf8',
    windowsHide: true,
    env,
  });
  if (result.status !== 0) return '';
  const candidates = String(result.stdout || '')
    .split(/\r?\n/)
    .map(item => item.trim())
    .filter(Boolean);
  if (process.platform === 'win32') {
    return candidates.find(item => /\.(cmd|exe)$/i.test(item)) || candidates[0] || '';
  }
  return candidates[0] || '';
}

function defaultRunner(command, args, options = {}) {
  return crossSpawn.sync(command, args, {
    encoding: 'utf8',
    windowsHide: true,
    env: options.env || process.env,
    cwd: options.cwd,
    timeout: options.timeout || 120_000,
  });
}

function parseJson(text, fallback) {
  try {
    return JSON.parse(String(text || ''));
  } catch {
    return fallback;
  }
}

function writeFileAtomic(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, content, 'utf8');
  fs.renameSync(temporary, filePath);
}

function codexNotifyLine(source) {
  const lines = String(source || '').split(/\r?\n/);
  const index = lines.findIndex(line => /^\s*notify\s*=/.test(line));
  if (index < 0) return null;
  const value = lines[index].replace(/^\s*notify\s*=\s*/, '');
  try {
    const args = JSON.parse(value);
    return Array.isArray(args) && args.every(item => typeof item === 'string') ? { lines, index, args } : null;
  } catch {
    return null;
  }
}

function isDevTaskRadarNotify(args) {
  return Array.isArray(args) && args.some(arg => /devtask-radar[\\/]connectors[\\/]codex[\\/]notify-hook\.js$/i.test(arg));
}

function bridgeNextNotifyArgs(bridgeHomeDir) {
  return ['node', path.join(bridgeHomeDir, 'bin', 'bridge-hook.cjs')];
}

function isBridgeNextNotify(args, bridgeHomeDir) {
  const marker = args.indexOf('--next-base64');
  if (marker < 0 || !args[marker + 1]) return false;
  try {
    const next = JSON.parse(Buffer.from(args[marker + 1], 'base64').toString('utf8'));
    return Array.isArray(next) && next.join('\n') === bridgeNextNotifyArgs(bridgeHomeDir).join('\n');
  } catch {
    return false;
  }
}

function chainBridgeAfterDevTaskRadar(configFile, bridgeHomeDir) {
  if (!configFile || !fs.existsSync(configFile)) return { chained: false, reason: 'config-not-found' };
  const source = fs.readFileSync(configFile, 'utf8');
  const parsed = codexNotifyLine(source);
  if (!parsed || !isDevTaskRadarNotify(parsed.args)) return { chained: false, reason: 'unsupported-third-party-notify' };
  if (isBridgeNextNotify(parsed.args, bridgeHomeDir)) return { chained: true, changed: false };
  if (parsed.args.includes('--next-base64')) return { chained: false, reason: 'third-party-next-notify-present' };
  const next = Buffer.from(JSON.stringify(bridgeNextNotifyArgs(bridgeHomeDir))).toString('base64');
  const args = [...parsed.args, '--next-base64', next];
  const indentation = (parsed.lines[parsed.index].match(/^\s*/) || [''])[0];
  parsed.lines[parsed.index] = `${indentation}notify = ${JSON.stringify(args)}`;
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  writeFileAtomic(configFile, parsed.lines.join(eol));
  return { chained: true, changed: true };
}

function updateJsoncValue(filePath, propertyPath, value) {
  let source = fs.existsSync(filePath)
    ? fs.readFileSync(filePath, 'utf8')
    : '{\n  "$schema": "https://opencode.ai/config.json"\n}\n';
  const formattingOptions = { insertSpaces: true, tabSize: 2, eol: source.includes('\r\n') ? '\r\n' : '\n' };
  const edits = modify(source, propertyPath, value, { formattingOptions });
  source = applyEdits(source, edits);
  writeFileAtomic(filePath, source);
}

function openCodeConfigDir(homeDir = os.homedir(), env = process.env) {
  if (env.OPENCODE_CONFIG_DIR) return path.resolve(env.OPENCODE_CONFIG_DIR);
  if (env.XDG_CONFIG_HOME) return path.join(path.resolve(env.XDG_CONFIG_HOME), 'opencode');
  return path.join(homeDir, '.config', 'opencode');
}

function findOpenCodeConfig(configDir) {
  const jsonc = path.join(configDir, 'opencode.jsonc');
  const json = path.join(configDir, 'opencode.json');
  if (fs.existsSync(jsonc)) return jsonc;
  if (fs.existsSync(json)) return json;
  return jsonc;
}

function readOpenCodeState(configDir) {
  const configPath = findOpenCodeConfig(configDir);
  let config = {};
  if (fs.existsSync(configPath)) {
    config = parse(fs.readFileSync(configPath, 'utf8')) || {};
  }
  const legacy = config?.mcp?.[INTEGRATION_NAME];
  const v2 = config?.mcp?.servers?.[INTEGRATION_NAME];
  const skillPath = path.join(configDir, 'skills', INTEGRATION_NAME, 'SKILL.md');
  const instructionPath = path.join(configDir, 'instructions', `${INTEGRATION_NAME}.md`);
  const configuredInstructions = Array.isArray(config?.instructions) ? config.instructions : [];
  return {
    configPath,
    mcpInstalled: Boolean(legacy || v2),
    skillInstalled: fs.existsSync(skillPath),
    instructionInstalled: fs.existsSync(instructionPath)
      && configuredInstructions.some(item => path.resolve(String(item)) === path.resolve(instructionPath)),
    skillPath,
    instructionPath,
  };
}

function ensureOpenCodeInstructionConfig(configDir, instructionPath) {
  const configPath = findOpenCodeConfig(configDir);
  const config = fs.existsSync(configPath) ? (parse(fs.readFileSync(configPath, 'utf8')) || {}) : {};
  const instructions = Array.isArray(config.instructions) ? [...config.instructions] : [];
  if (!instructions.some(item => path.resolve(String(item)) === path.resolve(instructionPath))) {
    instructions.push(instructionPath);
    updateJsoncValue(configPath, ['instructions'], instructions);
  }
  return configPath;
}

function removeOpenCodeInstructionConfig(configDir, instructionPath) {
  const configPath = findOpenCodeConfig(configDir);
  if (!fs.existsSync(configPath)) return false;
  const config = parse(fs.readFileSync(configPath, 'utf8')) || {};
  if (!Array.isArray(config.instructions)) return false;
  const instructions = config.instructions.filter(item => path.resolve(String(item)) !== path.resolve(instructionPath));
  if (instructions.length === config.instructions.length) return false;
  updateJsoncValue(configPath, ['instructions'], instructions.length ? instructions : undefined);
  return true;
}

function removeOpenCodeMcpConfig(configDir) {
  const configPath = findOpenCodeConfig(configDir);
  if (!fs.existsSync(configPath)) return false;
  let source = fs.readFileSync(configPath, 'utf8');
  const config = parse(source) || {};
  const paths = [];
  if (config?.mcp?.[INTEGRATION_NAME]) paths.push(['mcp', INTEGRATION_NAME]);
  if (config?.mcp?.servers?.[INTEGRATION_NAME]) paths.push(['mcp', 'servers', INTEGRATION_NAME]);
  if (!paths.length) return false;
  const formattingOptions = { insertSpaces: true, tabSize: 2, eol: source.includes('\r\n') ? '\r\n' : '\n' };
  for (const propertyPath of paths) {
    const edits = modify(source, propertyPath, undefined, { formattingOptions });
    source = applyEdits(source, edits);
  }
  writeFileAtomic(configPath, source);
  return true;
}

class IntegrationManager {
  constructor(options = {}) {
    this.rootDir = options.rootDir || path.resolve(__dirname, '..', '..');
    this.homeDir = options.homeDir || os.homedir();
    this.env = options.env || process.env;
    this.version = options.version || packageInfo.version;
    this.packageSpec = options.packageSpec || `project-knowledge@${this.version}`;
    this.marketplaceSource = options.marketplaceSource || DEFAULT_MARKETPLACE_SOURCE;
    this.runner = options.runner || defaultRunner;
    this.commandResolver = options.commandResolver || defaultCommandResolver;
    this.dryRun = Boolean(options.dryRun);
    this.logger = options.logger || null;
    this.planned = [];
    this.bridge = options.bridgeModule || bridgeModule;
    this.bridgeConsumerName = options.bridgeConsumerName || DEFAULT_BRIDGE_CONSUMER;
    this.bridgeHomeDir = options.bridgeHomeDir
      || this.env.AI_CODING_EVENT_BRIDGE_HOME
      || path.join(this.homeDir, '.ai-coding-event-bridge');
    this.claudeSettingsFile = options.claudeSettingsFile || '';
    this.codexConfigFile = options.codexConfigFile || '';
    this.openCodePluginsDir = options.openCodePluginsDir || '';
  }

  _bridgeFacade() {
    return this.bridge.createBridge({ homeDir: this.bridgeHomeDir });
  }

  _captureInstallerOptions() {
    return {
      homeDir: this.bridgeHomeDir,
      settingsFile: this.claudeSettingsFile || undefined,
      configFile: this.codexConfigFile || undefined,
      pluginsDir: this.openCodePluginsDir || undefined,
    };
  }

  // ---- Bridge host consumer (host-level, never owned by one connector) ----

  async registerBridgeConsumer(meta = {}) {
    if (this.dryRun) {
      this.planned.push({ command: 'bridge', args: ['registerConsumer', this.bridgeConsumerName] });
      return { state: 'planned', consumerName: this.bridgeConsumerName };
    }
    const facade = this._bridgeFacade();
    const consumer = await facade.registerConsumer(this.bridgeConsumerName, meta);
    return { state: 'registered', consumerName: this.bridgeConsumerName, consumer };
  }

  async unregisterBridgeConsumer() {
    if (this.dryRun) {
      this.planned.push({ command: 'bridge', args: ['unregisterConsumer', this.bridgeConsumerName] });
      return { state: 'planned', consumerName: this.bridgeConsumerName };
    }
    const facade = this._bridgeFacade();
    await facade.unregisterConsumer(this.bridgeConsumerName);
    return { state: 'unregistered', consumerName: this.bridgeConsumerName };
  }

  async bridgeStatus() {
    const facade = this._bridgeFacade();
    const [consumer, health] = await Promise.all([facade.getConsumer(this.bridgeConsumerName), facade.getHealth()]);
    return {
      consumerRegistered: Boolean(consumer),
      consumerName: this.bridgeConsumerName,
      bridgeHealthy: true,
      health,
    };
  }

  // ---- Development Capture connectors (Bridge hooks / notify / plugin) ----

  async installCaptureClaude() {
    if (this.dryRun) {
      this.planned.push({ command: 'bridge', args: ['installClaudeCodeHook', this.bridgeHomeDir] });
      return { state: 'planned', installed: false, conflict: false, detail: 'managed Bridge hooks (dry-run)' };
    }
    const result = await this.bridge.installers.claudeCode.installClaudeCodeHook(this._captureInstallerOptions());
    return { state: 'installed', installed: true, conflict: false, detail: `managed hooks: ${result.added.join(', ') || 'already present'}` };
  }

  async statusCaptureClaude() {
    const status = await this.bridge.installers.claudeCode.statusClaudeCodeHook(this._captureInstallerOptions());
    return {
      state: status.installed ? 'installed' : 'not-installed',
      installed: status.installed,
      conflict: false,
      detail: status.installed ? `managed events: ${status.managedEvents.join(', ')}` : 'managed hooks not installed',
    };
  }

  async uninstallCaptureClaude(options = {}) {
    await this.bridge.installers.claudeCode.uninstallClaudeCodeHook({
      ...this._captureInstallerOptions(),
      unregisterConsumer: options.unregisterConsumer === true,
      consumerName: this.bridgeConsumerName,
    });
    return { state: 'removed', detail: options.unregisterConsumer === true ? 'managed hooks removed; host consumer unregistered' : 'managed hooks removed; host consumer kept' };
  }

  async installCaptureCodex() {
    if (this.dryRun) {
      this.planned.push({ command: 'bridge', args: ['installCodexNotify', this.bridgeHomeDir] });
      return { state: 'planned', installed: false, conflict: false, detail: 'managed Codex notify (dry-run)' };
    }
    const result = await this.bridge.installers.codex.installCodexNotify(this._captureInstallerOptions());
    if (result.conflict) {
      const chained = chainBridgeAfterDevTaskRadar(this.codexConfigFile || path.join(this.homeDir, '.codex', 'config.toml'), this.bridgeHomeDir);
      if (chained.chained) {
        return { state: 'installed', installed: true, conflict: false, detail: 'Bridge notify chained after the compatible DevTask Radar notifier' };
      }
      return { state: 'conflict', installed: false, conflict: true, detail: 'third-party notify present; not overwritten' };
    }
    return { state: 'installed', installed: true, conflict: false, detail: 'managed notify installed' };
  }

  async statusCaptureCodex() {
    const status = await this.bridge.installers.codex.statusCodexNotify(this._captureInstallerOptions());
    if (status.thirdParty) {
      const configFile = this.codexConfigFile || path.join(this.homeDir, '.codex', 'config.toml');
      const source = fs.existsSync(configFile) ? fs.readFileSync(configFile, 'utf8') : '';
      const parsed = codexNotifyLine(source);
      if (parsed && isDevTaskRadarNotify(parsed.args) && isBridgeNextNotify(parsed.args, this.bridgeHomeDir)) {
        return { state: 'installed', installed: true, conflict: false, detail: 'Bridge notify chained after the compatible DevTask Radar notifier' };
      }
    }
    return {
      state: status.installed ? 'installed' : status.thirdParty ? 'conflict' : 'not-installed',
      installed: Boolean(status.installed),
      conflict: Boolean(status.thirdParty),
      detail: status.installed ? 'managed notify installed' : status.thirdParty ? 'third-party notify present' : 'notify not installed',
    };
  }

  async uninstallCaptureCodex(options = {}) {
    await this.bridge.installers.codex.uninstallCodexNotify({
      ...this._captureInstallerOptions(),
      unregisterConsumer: options.unregisterConsumer === true,
      consumerName: this.bridgeConsumerName,
    });
    return { state: 'removed', detail: 'managed notify removed' };
  }

  async installCaptureOpenCode() {
    if (this.dryRun) {
      this.planned.push({ command: 'bridge', args: ['installOpenCodePlugin', this.bridgeHomeDir] });
      return { state: 'planned', installed: false, conflict: false, detail: 'managed OpenCode plugin (dry-run)' };
    }
    await this.bridge.installers.openCode.installOpenCodePlugin(this._captureInstallerOptions());
    return { state: 'installed', installed: true, conflict: false, detail: 'managed plugin installed' };
  }

  async statusCaptureOpenCode() {
    const status = await this.bridge.installers.openCode.statusOpenCodePlugin(this._captureInstallerOptions());
    return {
      state: status.installed ? 'installed' : 'not-installed',
      installed: Boolean(status.installed),
      conflict: false,
      detail: status.installed ? 'managed plugin installed' : `plugin not installed (${status.thirdPartyFiles} third-party files preserved)`,
    };
  }

  async uninstallCaptureOpenCode(options = {}) {
    await this.bridge.installers.openCode.uninstallOpenCodePlugin({
      ...this._captureInstallerOptions(),
      unregisterConsumer: options.unregisterConsumer === true,
      consumerName: this.bridgeConsumerName,
    });
    return { state: 'removed', detail: 'managed plugin removed' };
  }

  log(level, event, message, input = {}) {
    if (!this.logger || typeof this.logger[level] !== 'function') return;
    Promise.resolve(this.logger[level](event, message, { component: 'integration-manager', ...input })).catch(() => {
      try { process.stderr.write(`[integration-manager logger fallback] ${event}\n`); } catch {
        // stderr is the final non-recursive observer fallback.
      }
    });
  }

  executable(client) {
    const name = client === 'claude' ? 'claude' : client;
    if (this.dryRun) return process.platform === 'win32' ? `${name}.cmd` : name;
    return this.commandResolver(name, this.env);
  }

  detectClients() {
    return SUPPORTED_CLIENTS.filter(client => Boolean(this.executable(client)));
  }

  execute(client, args, options = {}) {
    const startedAt = Date.now();
    const command = this.executable(client);
    this.planned.push({ command: command || client, args: [...args] });
    const argsHash = `sha256:${crypto.createHash('sha256').update(JSON.stringify(args), 'utf8').digest('hex')}`;
    this.log('info', 'integration.command_started', 'Integration CLI command started.', { context: { client, argumentCount: args.length, argsHash, dryRun: this.dryRun } });
    if (this.dryRun) {
      this.log('info', 'integration.command_completed', 'Integration CLI command completed.', { durationMs: Date.now() - startedAt, context: { client, status: 0, argsHash, dryRun: true } });
      return { status: 0, stdout: '', stderr: '' };
    }
    if (!command) {
      this.log('error', 'integration.command_failed', 'Integration CLI command failed.', { durationMs: Date.now() - startedAt, error: Object.assign(new Error('Integration CLI is unavailable.'), { code: 'INTEGRATION_CLI_UNAVAILABLE' }), context: { client, argsHash } });
      throw new Error(`${CLIENT_LABELS[client]} CLI is not installed or not on PATH`);
    }
    const result = this.runner(command, args, {
      env: this.env,
      cwd: this.rootDir,
      timeout: options.timeout,
    });
    if (result.error) {
      this.log('error', 'integration.command_failed', 'Integration CLI command failed.', { durationMs: Date.now() - startedAt, error: Object.assign(new Error('Integration CLI command failed.'), { code: result.error.code || 'INTEGRATION_COMMAND_FAILED' }), context: { client, argsHash } });
      throw result.error;
    }
    if (result.status !== 0 && !options.allowFailure) {
      const detail = String(result.stderr || result.stdout || '').trim();
      this.log('error', 'integration.command_failed', 'Integration CLI command failed.', { durationMs: Date.now() - startedAt, error: Object.assign(new Error('Integration CLI command failed.'), { code: 'INTEGRATION_COMMAND_FAILED' }), context: { client, status: result.status, argsHash, outputHash: `sha256:${crypto.createHash('sha256').update(detail, 'utf8').digest('hex')}` } });
      throw new Error(detail || `${CLIENT_LABELS[client]} command failed with exit code ${result.status}`);
    }
    this.log('info', 'integration.command_completed', 'Integration CLI command completed.', { durationMs: Date.now() - startedAt, context: { client, status: result.status, argsHash } });
    return result;
  }

  claudePlugin() {
    const result = this.execute('claude', ['plugin', 'list', '--json'], { allowFailure: true });
    const plugins = parseJson(result.stdout, []);
    return Array.isArray(plugins)
      ? plugins.find(item => item.id === `${INTEGRATION_NAME}@${MARKETPLACE_NAME}`)
      : undefined;
  }

  claudeMarketplaceExists() {
    const result = this.execute('claude', ['plugin', 'marketplace', 'list', '--json'], { allowFailure: true });
    const marketplaces = parseJson(result.stdout, []);
    return Array.isArray(marketplaces) && marketplaces.some(item => item.name === MARKETPLACE_NAME);
  }

  codexPlugin() {
    const result = this.execute('codex', ['plugin', 'list', '--json'], { allowFailure: true });
    const data = parseJson(result.stdout, {});
    return Array.isArray(data?.installed)
      ? data.installed.find(item => item.pluginId === `${INTEGRATION_NAME}@${MARKETPLACE_NAME}`)
      : undefined;
  }

  codexMarketplaceExists() {
    const result = this.execute('codex', ['plugin', 'marketplace', 'list'], { allowFailure: true });
    return String(result.stdout || '').split(/\r?\n/).some(line => line.trim().startsWith(`${MARKETPLACE_NAME} `));
  }

  ensureClaudeMarketplace() {
    if (!this.dryRun && this.claudeMarketplaceExists()) return;
    this.execute('claude', ['plugin', 'marketplace', 'add', this.marketplaceSource]);
  }

  ensureCodexMarketplace() {
    if (!this.dryRun && this.codexMarketplaceExists()) return;
    this.execute('codex', ['plugin', 'marketplace', 'add', this.marketplaceSource]);
  }

  installClaude(options = {}) {
    this.ensureClaudeMarketplace();
    if (!this.dryRun && this.claudePlugin()) {
      return { state: 'installed', detail: 'plugin already installed' };
    }
    this.execute('claude', [
      'plugin',
      'install',
      `${INTEGRATION_NAME}@${MARKETPLACE_NAME}`,
      '--scope',
      options.scope || 'user',
    ]);
    return { state: 'installed', detail: 'plugin, MCP, and Skill installed' };
  }

  updateClaude(options = {}) {
    this.ensureClaudeMarketplace();
    this.execute('claude', ['plugin', 'marketplace', 'update', MARKETPLACE_NAME]);
    if (!this.dryRun && !this.claudePlugin()) return this.installClaude(options);
    this.execute('claude', [
      'plugin',
      'update',
      `${INTEGRATION_NAME}@${MARKETPLACE_NAME}`,
      '--scope',
      options.scope || 'user',
    ]);
    return { state: 'updated', detail: 'plugin marketplace and installed plugin updated' };
  }

  uninstallClaude(options = {}) {
    if (this.dryRun || this.claudePlugin()) {
      this.execute('claude', [
        'plugin',
        'uninstall',
        `${INTEGRATION_NAME}@${MARKETPLACE_NAME}`,
        '--scope',
        options.scope || 'user',
      ]);
    }
    if (this.dryRun || this.claudeMarketplaceExists()) {
      this.execute('claude', ['plugin', 'marketplace', 'remove', MARKETPLACE_NAME]);
    }
    return { state: 'removed', detail: 'plugin and marketplace registration removed' };
  }

  statusClaude() {
    const command = this.executable('claude');
    if (!command) return { state: 'unavailable', installed: false, detail: 'Claude Code CLI not found' };
    const plugin = this.claudePlugin();
    return {
      state: plugin ? 'installed' : 'not-installed',
      installed: Boolean(plugin),
      version: plugin?.version,
      detail: plugin ? `plugin enabled: ${plugin.enabled !== false}` : 'plugin not installed',
    };
  }

  installCodex() {
    this.ensureCodexMarketplace();
    if (!this.dryRun && this.codexPlugin()) {
      return { state: 'installed', detail: 'plugin already installed' };
    }
    this.execute('codex', ['plugin', 'add', `${INTEGRATION_NAME}@${MARKETPLACE_NAME}`]);
    return { state: 'installed', detail: 'plugin, MCP, and Skill installed' };
  }

  updateCodex() {
    this.ensureCodexMarketplace();
    this.execute('codex', ['plugin', 'marketplace', 'upgrade', MARKETPLACE_NAME]);
    if (this.dryRun || this.codexPlugin()) {
      this.execute('codex', ['plugin', 'remove', `${INTEGRATION_NAME}@${MARKETPLACE_NAME}`]);
    }
    this.execute('codex', ['plugin', 'add', `${INTEGRATION_NAME}@${MARKETPLACE_NAME}`]);
    return { state: 'updated', detail: 'marketplace refreshed and plugin reinstalled' };
  }

  uninstallCodex() {
    if (this.dryRun || this.codexPlugin()) {
      this.execute('codex', ['plugin', 'remove', `${INTEGRATION_NAME}@${MARKETPLACE_NAME}`]);
    }
    if (this.dryRun || this.codexMarketplaceExists()) {
      this.execute('codex', ['plugin', 'marketplace', 'remove', MARKETPLACE_NAME]);
    }
    return { state: 'removed', detail: 'plugin and marketplace registration removed' };
  }

  statusCodex() {
    const command = this.executable('codex');
    if (!command) return { state: 'unavailable', installed: false, detail: 'Codex CLI not found' };
    const plugin = this.codexPlugin();
    return {
      state: plugin ? 'installed' : 'not-installed',
      installed: Boolean(plugin),
      version: plugin?.version,
      detail: plugin ? `plugin enabled: ${plugin.enabled !== false}` : 'plugin not installed',
    };
  }

  openCodeSkillSource() {
    return path.join(
      this.rootDir,
      'plugins',
      INTEGRATION_NAME,
      'skills',
      INTEGRATION_NAME,
    );
  }

  openCodeInstructionSource() {
    return path.join(this.rootDir, 'plugins', INTEGRATION_NAME, 'opencode', `${INTEGRATION_NAME}.md`);
  }

  openCodeConfigDir() {
    return openCodeConfigDir(this.homeDir, this.env);
  }

  installOpenCode() {
    const source = this.openCodeSkillSource();
    const instructionSource = this.openCodeInstructionSource();
    const configDir = this.openCodeConfigDir();
    const destination = path.join(this.openCodeConfigDir(), 'skills', INTEGRATION_NAME);
    const instructionDestination = path.join(configDir, 'instructions', `${INTEGRATION_NAME}.md`);
    if (!this.dryRun) {
      if (!fs.existsSync(path.join(source, 'SKILL.md'))) throw new Error(`bundled Skill not found: ${source}`);
      if (!fs.existsSync(instructionSource)) throw new Error(`bundled OpenCode instructions not found: ${instructionSource}`);
      fs.mkdirSync(destination, { recursive: true });
      fs.cpSync(source, destination, { recursive: true, force: true });
      fs.mkdirSync(path.dirname(instructionDestination), { recursive: true });
      fs.copyFileSync(instructionSource, instructionDestination);
    }
    this.planned.push({ copy: source, destination });
    this.planned.push({ copy: instructionSource, destination: instructionDestination });
    this.execute('opencode', [
      'mcp',
      'add',
      INTEGRATION_NAME,
      '--',
      'npx',
      '-y',
      '--package',
      this.packageSpec,
      'project-knowledge-mcp',
    ]);
    if (!this.dryRun) ensureOpenCodeInstructionConfig(configDir, instructionDestination);
    return { state: 'installed', detail: 'MCP, global Skill, and Instructions installed' };
  }

  updateOpenCode() {
    const result = this.installOpenCode();
    return { ...result, state: 'updated', detail: 'MCP configuration, global Skill, and Instructions updated' };
  }

  uninstallOpenCode() {
    const configDir = this.openCodeConfigDir();
    const skillDir = path.join(configDir, 'skills', INTEGRATION_NAME);
    const instructionPath = path.join(configDir, 'instructions', `${INTEGRATION_NAME}.md`);
    if (!this.dryRun) {
      removeOpenCodeMcpConfig(configDir);
      removeOpenCodeInstructionConfig(configDir, instructionPath);
      if (fs.existsSync(skillDir)) fs.rmSync(skillDir, { recursive: true, force: true });
      if (fs.existsSync(instructionPath)) fs.rmSync(instructionPath, { force: true });
    }
    this.planned.push({
      removeConfig: findOpenCodeConfig(configDir),
      removeDirectory: skillDir,
      removeFile: instructionPath,
    });
    return { state: 'removed', detail: 'MCP configuration, global Skill, and Instructions removed' };
  }

  statusOpenCode() {
    const available = Boolean(this.executable('opencode'));
    const state = readOpenCodeState(this.openCodeConfigDir());
    const installed = state.mcpInstalled && state.skillInstalled && state.instructionInstalled;
    let detail = 'MCP, Skill, and Instructions not installed';
    if (installed) detail = 'MCP, global Skill, and Instructions installed';
    else if (state.mcpInstalled && state.skillInstalled) detail = 'MCP and Skill installed; Instructions missing';
    else if (state.mcpInstalled) detail = 'MCP installed; Skill missing';
    else if (state.skillInstalled) detail = 'Skill installed; MCP missing';
    if (!available) detail = `OpenCode CLI not found; ${detail}`;
    return {
      state: installed ? 'installed' : available ? 'not-installed' : 'unavailable',
      installed,
      detail,
      configPath: state.configPath,
      skillPath: state.skillPath,
      instructionPath: state.instructionPath,
    };
  }

  async operate(operation, clients, options = {}) {
    const results = [];
    for (const rawClient of clients) {
      const client = normalizeClient(rawClient);
      try {
        const suffix = CLIENT_METHOD_SUFFIX[client];
        let result;
        if (operation === 'status') result = this[`status${suffix}`]();
        else if (operation === 'install') result = this[`install${suffix}`](options);
        else if (operation === 'update') result = this[`update${suffix}`](options);
        else if (operation === 'uninstall') result = this[`uninstall${suffix}`](options);
        else throw new Error(`unsupported operation: ${operation}`);
        if (this.dryRun && operation !== 'status') {
          result = { ...result, state: 'planned', detail: `${result.detail} (dry-run)` };
        }
        results.push({ client, label: CLIENT_LABELS[client], ok: true, ...result });
      } catch (error) {
        results.push({
          client,
          label: CLIENT_LABELS[client],
          ok: false,
          state: 'failed',
          detail: error.message,
        });
      }
    }
    return results;
  }

  async operateCapture(operation, clients, options = {}) {
    const results = [];
    for (const rawClient of clients) {
      const client = normalizeClient(rawClient);
      const suffix = CLIENT_METHOD_SUFFIX[client];
      try {
        const result = await this[`${operation}Capture${suffix}`](options);
        results.push({ client, label: CLIENT_LABELS[client], ok: true, ...result });
      } catch (error) {
        results.push({ client, label: CLIENT_LABELS[client], ok: false, state: 'failed', detail: error.message });
      }
    }
    return results;
  }

  // One-click Integration Setup: register the host Bridge consumer once,
  // then install BOTH capabilities per client. Knowledge Integration and
  // Development Capture are reported separately; one failing component never
  // rolls back or blocks the others.
  async installAll(options = {}) {
    const clients = options.clients && options.clients.length ? options.clients.map(normalizeClient) : this.detectClients();
    const summary = { clients: [], bridge: null };
    try {
      summary.bridge = { ok: true, ...(await this.registerBridgeConsumer(options.bridgeConsumerMeta || {})) };
    } catch (error) {
      summary.bridge = { ok: false, state: 'failed', detail: error.message };
    }
    for (const client of clients) {
      const suffix = CLIENT_METHOD_SUFFIX[client];
      const entry = { client, label: CLIENT_LABELS[client] };
      if (options.captureOnly !== true) {
        try {
          entry.knowledgeIntegration = { ok: true, ...(await this[`install${suffix}`](options)) };
        } catch (error) {
          entry.knowledgeIntegration = { ok: false, state: 'failed', detail: error.message };
        }
      }
      if (options.knowledgeOnly !== true) {
        try {
          entry.developmentCapture = { ok: true, ...(await this[`installCapture${suffix}`]()) };
        } catch (error) {
          entry.developmentCapture = { ok: false, state: 'failed', detail: error.message };
        }
      }
      summary.clients.push(entry);
    }
    return summary;
  }

  async statusAll(options = {}) {
    const clients = options.clients && options.clients.length ? options.clients.map(normalizeClient) : this.detectClients();
    const summary = { clients: [], bridge: null };
    try {
      summary.bridge = { ok: true, ...(await this.bridgeStatus()) };
    } catch (error) {
      summary.bridge = { ok: false, state: 'failed', bridgeHealthy: false, detail: error.message };
    }
    for (const client of clients) {
      const suffix = CLIENT_METHOD_SUFFIX[client];
      const entry = { client, label: CLIENT_LABELS[client], available: Boolean(this.executable(client)) };
      try {
        entry.knowledgeIntegration = { ok: true, ...(await this[`status${suffix}`]()) };
      } catch (error) {
        entry.knowledgeIntegration = { ok: false, state: 'failed', detail: error.message };
      }
      try {
        entry.developmentCapture = { ok: true, ...(await this[`statusCapture${suffix}`]()) };
      } catch (error) {
        entry.developmentCapture = { ok: false, state: 'failed', detail: error.message };
      }
      summary.clients.push(entry);
    }
    return summary;
  }

  // Global disable: remove every connector first, then (and only then)
  // unregister the host Bridge consumer (GATE INSTALL-003 semantics).
  async disableAllCapture(options = {}) {
    const clients = options.clients && options.clients.length ? options.clients.map(normalizeClient) : SUPPORTED_CLIENTS;
    const results = await this.operateCapture('uninstall', clients, { unregisterConsumer: false });
    let consumer = null;
    try {
      consumer = { ok: true, ...(await this.unregisterBridgeConsumer()) };
    } catch (error) {
      consumer = { ok: false, state: 'failed', detail: error.message };
    }
    return { clients: results, consumer };
  }
}

module.exports = {
  CLIENT_LABELS,
  DEFAULT_MARKETPLACE_SOURCE,
  INTEGRATION_NAME,
  IntegrationManager,
  MARKETPLACE_NAME,
  SUPPORTED_CLIENTS,
  findOpenCodeConfig,
  ensureOpenCodeInstructionConfig,
  normalizeClient,
  openCodeConfigDir,
  readOpenCodeState,
  removeOpenCodeMcpConfig,
  removeOpenCodeInstructionConfig,
};
