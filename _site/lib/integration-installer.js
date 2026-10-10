const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const crossSpawn = require('cross-spawn');
const { applyEdits, modify, parse } = require('jsonc-parser');
const packageInfo = require('../../package.json');
const { resolveDataDirPath } = require('./data-dir');
const { planNotify, writeNotify } = require('./codex-notify-config');

// Fail-open module resolution: a missing/unloadable Bridge package must
// degrade Development Capture status, never crash server startup.
let bridgeModule = null;
try {
  bridgeModule = require('@sanqianx/ai-coding-event-bridge-console/src/bridge');
} catch (_) {
  bridgeModule = null;
}

const INTEGRATION_NAME = 'project-knowledge';
const MARKETPLACE_NAME = 'project-knowledge';
const DEFAULT_MARKETPLACE_SOURCE = 'SanQianX/project-knowledge-base';
const SUPPORTED_CLIENTS = ['claude', 'opencode', 'codex', 'zcode'];
const DEFAULT_BRIDGE_CONSUMER = 'project-knowledge';
const CLIENT_LABELS = {
  claude: 'Claude Code',
  opencode: 'OpenCode',
  codex: 'Codex',
  zcode: 'ZCode',
};
const CLIENT_METHOD_SUFFIX = {
  claude: 'Claude',
  opencode: 'OpenCode',
  codex: 'Codex',
  zcode: 'ZCode',
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
    this.packageSpec = options.packageSpec || `${packageInfo.name}@${this.version}`;
    this.marketplaceSource = options.marketplaceSource || DEFAULT_MARKETPLACE_SOURCE;
    this.runner = options.runner || defaultRunner;
    this.commandResolver = options.commandResolver || defaultCommandResolver;
    this.dryRun = Boolean(options.dryRun);
    this.logger = options.logger || null;
    this.operationId = options.operationId || '';
    this.planned = [];
    this.bridge = options.bridgeModule || bridgeModule;
    this.bridgeConsumerName = options.bridgeConsumerName || DEFAULT_BRIDGE_CONSUMER;
    this.bridgeHomeDir = options.bridgeHomeDir
      || this.env.AI_CODING_EVENT_BRIDGE_HOME
      || path.join(resolveDataDirPath({ dataDir: this.env.KB_DATA_DIR || '', homeDir: this.homeDir }), 'events');
    this.claudeSettingsFile = options.claudeSettingsFile || path.join(this.homeDir, '.claude', 'settings.json');
    this.codexConfigFile = options.codexConfigFile || path.join(this.homeDir, '.codex', 'config.toml');
    this.openCodePluginsDir = options.openCodePluginsDir || path.join(openCodeConfigDir(this.homeDir, this.env), 'plugin');
    this.zcodeConfigFile = options.zcodeConfigFile || path.join(this.homeDir, '.zcode', 'cli', 'config.json');
  }

  _bridgeFacade() {
    return this.bridge.createBridge({ homeDir: this.bridgeHomeDir });
  }

  _captureInstallerOptions(client) {
    return {
      homeDir: this.bridgeHomeDir,
      settingsFile: this.claudeSettingsFile || undefined,
      configFile: client === 'zcode' ? this.zcodeConfigFile : this.codexConfigFile,
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

  async captureOperation(operation, client, options = {}) {
    const startedAt = Date.now();
    const context = { client, operation };
    try {
      const result = await this[`${operation}Capture${CLIENT_METHOD_SUFFIX[client]}`](options);
      const ok = !result.conflict && result.state !== 'failed';
      if (operation !== 'status' || !ok) this.log(ok ? 'info' : 'error', `integration.capture.${ok ? 'completed' : 'failed'}`, ok ? 'Agent 采集接线操作完成。' : 'Agent 采集接线未完成。', { operationId: this.operationId, durationMs: Date.now() - startedAt, error: ok ? undefined : Object.assign(new Error(result.detail), { code: 'CAPTURE_CONFLICT' }), context });
      return { ok, ...result, ...(!ok ? { error: { code: 'CAPTURE_CONFLICT', message: result.detail } } : {}) };
    } catch (error) {
      this.log('error', 'integration.capture.failed', 'Agent 采集接线操作失败。', { operationId: this.operationId, durationMs: Date.now() - startedAt, error, context });
      return { ok: false, state: 'failed', installed: false, detail: error.message, error: { code: error.code || 'CAPTURE_FAILED', message: error.message } };
    }
  }

  async installCaptureZCode() {
    if (this.dryRun) {
      this.planned.push({ command: 'bridge', args: ['installZcodeHook', this.bridgeHomeDir] });
      return { state: 'planned', installed: false, detail: '计划接入 ZCode 会话采集，未修改配置。' };
    }
    await this.bridge.installers.zcode.installZcodeHook(this._captureInstallerOptions('zcode'));
    const status = await this.statusCaptureZCode();
    if (!status.installed) throw new Error('ZCode Hook 写入后校验失败，请检查 hooks.enabled 与事件配置。');
    return status;
  }

  async statusCaptureZCode() {
    const status = await this.bridge.installers.zcode.statusZcodeHook(this._captureInstallerOptions('zcode'));
    return { state: status.installed ? 'installed' : 'not-installed', installed: status.installed, conflict: false, detail: status.installed ? '已配置用户输入与回答采集；请重新打开 ZCode 会话。' : 'ZCode 会话采集尚未接入。' };
  }

  async uninstallCaptureZCode() {
    if (this.dryRun) return { state: 'planned', detail: '计划移除 ZCode 采集，未修改配置。' };
    await this.bridge.installers.zcode.uninstallZcodeHook(this._captureInstallerOptions('zcode'));
    return { state: 'removed', installed: false, detail: '已移除 ZCode 托管采集，保留第三方配置与已有记录。' };
  }

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
      detail: status.installed ? '已配置用户输入与回答采集。' : '会话采集 Hook 尚未配置。',
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
    const plan = planNotify(this.codexConfigFile, this);
    if (plan.conflict) return { state: 'conflict', installed: false, conflict: true, detail: plan.detail };
    // The host owns composition and root-level TOML placement; Bridge only
    // materializes its independent runtime, never rewrites the notify setting.
    await this.bridge.ensureRuntimeHome({ homeDir: this.bridgeHomeDir });
    const written = writeNotify(this.codexConfigFile, plan);
    return { state: 'installed', installed: true, conflict: false, detail: written.changed ? '已接入 Codex 会话采集，保留有效的原通知；请重新打开 Codex 会话。' : 'Codex 会话采集已接入，通知链无需重复修改。', ...written };
  }

  async statusCaptureCodex() {
    const plan = planNotify(this.codexConfigFile, this);
    const runtimeReady = fs.existsSync(path.join(this.rootDir, '_site', 'scripts', 'codex-notify-fanout.cjs'))
      && fs.existsSync(path.join(this.bridgeHomeDir, 'bin', 'bridge-hook.cjs'));
    const installed = !plan.conflict && !plan.changed && runtimeReady;
    return {
      state: installed ? 'installed' : plan.conflict ? 'conflict' : 'not-installed',
      installed,
      conflict: Boolean(plan.conflict),
      detail: installed ? '已配置 Codex 会话采集，原通知保持有效。' : plan.conflict ? plan.detail : !runtimeReady && !plan.changed ? 'Codex 采集运行文件缺失，请执行接入/修复。' : 'Codex 会话采集尚未接入或旧接线需要修复。',
    };
  }

  async uninstallCaptureCodex(options = {}) {
    if (this.dryRun) return { state: 'planned', installed: false, detail: '计划移除 Codex 托管采集，保留原通知。' };
    const plan = planNotify(this.codexConfigFile, this, false);
    if (plan.conflict) return { state: 'conflict', installed: false, conflict: true, detail: plan.detail };
    const written = writeNotify(this.codexConfigFile, plan);
    if (options.unregisterConsumer === true) await this.unregisterBridgeConsumer();
    return { state: 'removed', installed: false, conflict: false, detail: '已移除 Codex 托管采集，保留有效的原通知和已有记录。', ...written };
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
      detail: status.installed ? '已配置会话采集插件。' : '会话采集插件尚未配置，保留其他插件。',
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
    return SUPPORTED_CLIENTS.filter(client => Boolean(this.executable(client)) || client === 'zcode' && this.captureConfigFound(client));
  }

  captureConfigFound(client) {
    const target = { claude: this.claudeSettingsFile, codex: this.codexConfigFile, opencode: path.dirname(this.openCodePluginsDir), zcode: this.zcodeConfigFile }[client];
    try { const stat = fs.statSync(target); return client === 'opencode' ? stat.isDirectory() : stat.isFile(); } catch { return false; }
  }

  // Capture support does not imply a verified MCP/plugin installer. Never
  // present ZCode knowledge retrieval as installed merely because hooks exist.
  statusZCode() { return { state: 'not-supported', supported: false, installed: false, detail: 'ZCode 当前支持会话采集；知识检索插件未接入，不会自动安装。' }; }
  installZCode() { return this.statusZCode(); }
  updateZCode() { return this.statusZCode(); }
  uninstallZCode() { return this.statusZCode(); }

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
      results.push({ client, label: CLIENT_LABELS[client], ...(await this.captureOperation(operation, client, options)) });
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
        entry.developmentCapture = await this.captureOperation('install', client);
      }
      summary.clients.push(entry);
    }
    return summary;
  }

  async statusAll(options = {}) {
    const clients = options.clients && options.clients.length ? options.clients.map(normalizeClient) : SUPPORTED_CLIENTS;
    const summary = { clients: [], bridge: null };
    try {
      summary.bridge = { ok: true, ...(await this.bridgeStatus()) };
    } catch (error) {
      summary.bridge = { ok: false, state: 'failed', bridgeHealthy: false, detail: error.message };
    }
    for (const client of clients) {
      const suffix = CLIENT_METHOD_SUFFIX[client];
      const entry = { client, label: CLIENT_LABELS[client], available: Boolean(this.executable(client)), configFound: this.captureConfigFound(client) };
      if (!options.captureOnly) {
        try {
          entry.knowledgeIntegration = { ok: true, ...(await this[`status${suffix}`]()) };
        } catch (error) {
          entry.knowledgeIntegration = { ok: false, state: 'failed', detail: error.message };
        }
      }
      entry.developmentCapture = await this.captureOperation('status', client);
      summary.clients.push(entry);
    }
    return summary;
  }

  // Global disable: remove every connector first, then (and only then)
  // unregister the host Bridge consumer (GATE INSTALL-003 semantics).
  async disableAllCapture(options = {}) {
    const clients = options.clients && options.clients.length ? options.clients.map(normalizeClient) : SUPPORTED_CLIENTS;
    const results = await this.operateCapture('uninstall', clients, { unregisterConsumer: false });
    if (results.some(result => !result.ok)) return { clients: results, consumer: { ok: false, state: 'kept', detail: '部分采集未能移除，保留宿主消费者，请修复失败项后重试。' } };
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
