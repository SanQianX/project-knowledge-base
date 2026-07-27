const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const crossSpawn = require('cross-spawn');
const { applyEdits, modify, parse } = require('jsonc-parser');
const packageInfo = require('../../package.json');

const INTEGRATION_NAME = 'project-knowledge';
const MARKETPLACE_NAME = 'project-knowledge';
const DEFAULT_MARKETPLACE_SOURCE = 'SanQianX/project-knowledge-base';
const SUPPORTED_CLIENTS = ['claude', 'opencode', 'codex'];
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
    this.planned = [];
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
    const command = this.executable(client);
    this.planned.push({ command: command || client, args: [...args] });
    if (this.dryRun) return { status: 0, stdout: '', stderr: '' };
    if (!command) throw new Error(`${CLIENT_LABELS[client]} CLI is not installed or not on PATH`);
    const result = this.runner(command, args, {
      env: this.env,
      cwd: this.rootDir,
      timeout: options.timeout,
    });
    if (result.error) throw result.error;
    if (result.status !== 0 && !options.allowFailure) {
      const detail = String(result.stderr || result.stdout || '').trim();
      throw new Error(detail || `${CLIENT_LABELS[client]} command failed with exit code ${result.status}`);
    }
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
