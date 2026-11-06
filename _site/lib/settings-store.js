const { SCHEMAS, DomainError, publicAiProfilesConfig } = require('./contracts');
const AtomicFile = require('./atomic-file');
const { StorageLayout } = require('./storage-layout');
const path = require('node:path');

function defaultSettings() {
  return {
    schema: SCHEMAS.settings,
    schemaVersion: 2,
    knowledge: { rootPath: '' },
    brain: { id: 'brain-default', name: '我的智脑', domains: [] },
    appearance: defaultAppearance(),
    ai: { schema: 'ai-profiles/v1', profiles: [] },
    embedding: {},
    logging: {
      levels: ['trace', 'debug', 'info', 'warn', 'error', 'fatal'],
    },
    promptOverrides: {},
    integrations: {},
    legacyExtensions: {},
    updatedAt: '',
  };
}

const APPEARANCE_PRESETS = ['pure', 'oled', 'steel'];
const APPEARANCE_TOKENS = ['page', 'surface', 'surface2', 'surface3', 'line', 'text', 'muted', 'faint', 'nav', 'accent', 'accent-soft', 'good', 'bad', 'bad-soft'];
const APPEARANCE_HEX = /^#[0-9a-fA-F]{6}$/;

function defaultAppearance() {
  return { preset: 'pure', overrides: { light: {}, dark: {} } };
}

function validateAppearance(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new DomainError('INVALID_ARGUMENT', '皮肤配置无效。', { status: 400 });
  const allowed = new Set(['preset', 'overrides']);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new DomainError('INVALID_ARGUMENT', `皮肤配置不支持字段：${key}。`, { status: 400, details: { field: key } });
  const preset = value.preset === undefined ? 'pure' : value.preset;
  if (!APPEARANCE_PRESETS.includes(preset)) throw new DomainError('INVALID_ARGUMENT', '未知的配色预设。', { status: 400 });
  const overrides = value.overrides === undefined ? { light: {}, dark: {} } : value.overrides;
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) throw new DomainError('INVALID_ARGUMENT', '皮肤颜色覆盖无效。', { status: 400 });
  for (const key of Object.keys(overrides)) if (!['light', 'dark'].includes(key)) throw new DomainError('INVALID_ARGUMENT', `皮肤颜色覆盖不支持主题：${key}。`, { status: 400, details: { field: key } });
  for (const theme of ['light', 'dark']) {
    const entries = overrides[theme] === undefined ? {} : overrides[theme];
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)) throw new DomainError('INVALID_ARGUMENT', `皮肤 ${theme} 主题颜色无效。`, { status: 400 });
    for (const token of Object.keys(entries)) {
      if (!APPEARANCE_TOKENS.includes(token)) throw new DomainError('INVALID_ARGUMENT', `不支持的皮肤颜色项：${token}。`, { status: 400, details: { field: token } });
      if (!APPEARANCE_HEX.test(String(entries[token]))) throw new DomainError('INVALID_ARGUMENT', `皮肤颜色 ${token} 必须是 #RRGGBB 格式。`, { status: 400, details: { field: token } });
    }
  }
  return { preset, overrides: { light: { ...overrides.light }, dark: { ...overrides.dark } } };
}

function mergeObjects(base, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return patch;
  const output = { ...(base && typeof base === 'object' && !Array.isArray(base) ? base : {}) };
  for (const [key, value] of Object.entries(patch)) {
    output[key] = value && typeof value === 'object' && !Array.isArray(value)
      ? mergeObjects(output[key], value)
      : value;
  }
  return output;
}

function validateSettings(settings) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    throw new DomainError('DATA_CORRUPT', 'Settings must be an object.', { status: 500 });
  }
  if (settings.schema !== SCHEMAS.settings || settings.schemaVersion !== 2) {
    throw new DomainError('SCHEMA_UNSUPPORTED', 'Unsupported settings schema.', { status: 409 });
  }
  if (!settings.knowledge || typeof settings.knowledge.rootPath !== 'string') {
    throw new DomainError('DATA_CORRUPT', 'Settings knowledge.rootPath is invalid.', { status: 500 });
  }
  settings.brain = settings.brain || { id: 'brain-default', name: '我的智脑', domains: [] };
  if (settings.brain.id !== 'brain-default' || typeof settings.brain.name !== 'string' || !settings.brain.name.trim() || settings.brain.name.length > 100 || !Array.isArray(settings.brain.domains)) throw new DomainError('DATA_CORRUPT', 'Brain metadata is invalid.', { status: 500 });
  const validBinding = value => value === undefined || typeof value === 'string' && path.isAbsolute(value);
  if (!validBinding(settings.brain.knowledgePath)) throw new DomainError('DATA_CORRUPT', 'Brain knowledge binding is invalid.', { status: 500 });
  const ids = new Set();
  for (const domain of settings.brain.domains) {
    if (!domain || !/^domain-[a-z0-9-]+$/.test(domain.id) || ids.has(domain.id) || typeof domain.name !== 'string' || !domain.name.trim() || domain.name.length > 100) throw new DomainError('DATA_CORRUPT', 'Domain metadata is invalid.', { status: 500 });
    if (!validBinding(domain.knowledgePath)) throw new DomainError('DATA_CORRUPT', 'Domain knowledge binding is invalid.', { status: 500 });
    ids.add(domain.id);
  }
  const logging = settings.logging || {};
  if (!Array.isArray(logging.levels) || !logging.levels.length || logging.levels.some(level => !['trace', 'debug', 'info', 'warn', 'error', 'fatal'].includes(level))) {
    throw new DomainError('DATA_CORRUPT', 'Settings logging configuration is invalid.', { status: 500 });
  }
  settings.appearance = settings.appearance || defaultAppearance();
  settings.appearance = validateAppearance(settings.appearance);
  return settings;
}

class SettingsStore {
  constructor(options = {}) {
    this.layout = options.layout || new StorageLayout(options);
    this.atomic = options.atomic || AtomicFile;
    this.filePath = options.filePath || this.layout.getSettingsPath();
    this.lockPath = options.lockPath || this.layout.getRuntimePath('locks', 'settings.lock');
  }

  read(options = {}) {
    if (options.allowMissing) {
      return this.atomic.readJsonStrict(this.filePath, {
        allowMissing: true,
        defaultValue: defaultSettings(),
        category: 'settings',
        validate: validateSettings,
      });
    }
    return this.atomic.readJsonStrict(this.filePath, { category: 'settings', validate: validateSettings });
  }

  async initialize(initial = {}) {
    return this.atomic.withFileLock(this.lockPath, async () => {
      let current;
      try { current = this.read(); }
      catch (error) {
        if (!error || error.code !== 'ENOENT') throw error;
      }
      if (current) return current;
      const next = validateSettings(mergeObjects(defaultSettings(), initial));
      next.updatedAt = new Date().toISOString();
      this.atomic.writeJsonAtomic(this.filePath, next);
      return next;
    });
  }

  async updatePatch(patch) {
    return this.atomic.withFileLock(this.lockPath, async () => {
      if (patch?.brain && (Object.prototype.hasOwnProperty.call(patch.brain, 'knowledgePath') || patch.brain.domains?.some?.(domain => Object.prototype.hasOwnProperty.call(domain, 'knowledgePath')))) throw new DomainError('INVALID_ARGUMENT', '共享知识目录绑定只允许受控接线写入。');
      if (patch && patch.logging && typeof patch.logging === 'object') {
        const unknown = Object.keys(patch.logging).find(key => key !== 'levels');
        if (unknown) throw new DomainError('INVALID_ARGUMENT', `Logging setting is read-only or unsupported: ${unknown}.`, { details: { field: unknown } });
      }
      const current = this.read({ allowMissing: true });
      const next = mergeObjects(current, patch || {});
      next.schema = SCHEMAS.settings;
      next.schemaVersion = 2;
      next.updatedAt = new Date().toISOString();
      validateSettings(next);
      if (next.knowledge.rootPath) this.layout.validateKnowledgeRoot(next.knowledge.rootPath);
      this.atomic.writeJsonAtomic(this.filePath, next);
      return next;
    });
  }

  async replaceAppearance(appearance) {
    return this.atomic.withFileLock(this.lockPath, async () => {
      const settings = this.read();
      settings.appearance = validateAppearance(appearance);
      settings.updatedAt = new Date().toISOString();
      validateSettings(settings);
      this.atomic.writeJsonAtomic(this.filePath, settings);
      return settings.appearance;
    });
  }

  async addDomain(domain) {
    return this.atomic.withFileLock(this.lockPath, async () => {
      const settings = this.read();
      if (settings.brain.domains.some(d => d.name === domain.name || d.id === domain.id)) throw new DomainError('INVALID_ARGUMENT', '领域已存在。', { status: 409 });
      settings.brain.domains.push(domain);
      settings.updatedAt = new Date().toISOString();
      validateSettings(settings);
      this.atomic.writeJsonAtomic(this.filePath, settings);
      return domain;
    });
  }

  async bindSharedKnowledgePaths(scopes) {
    return this.atomic.withFileLock(this.lockPath, async () => {
      const settings = this.read();
      let changed = false;
      for (const scope of scopes) {
        const target = scope.kind === 'brain' && scope.id === settings.brain.id ? settings.brain : settings.brain.domains.find(domain => domain.id === scope.id);
        if (!target || !path.isAbsolute(scope.knowledgePath || '')) throw new DomainError('INVALID_ARGUMENT', '共享知识绑定无效。');
        if (target.knowledgePath && !this.layout.pathsEqual(target.knowledgePath, scope.knowledgePath)) throw new DomainError('IMMUTABLE_FIELD', '共享知识目录不能隐式移动。', { status: 409 });
        if (!target.knowledgePath) { target.knowledgePath = path.resolve(scope.knowledgePath); changed = true; }
      }
      if (changed) { settings.updatedAt = new Date().toISOString(); validateSettings(settings); this.atomic.writeJsonAtomic(this.filePath, settings); }
      return settings;
    });
  }

  readPublicView(options = {}) {
    const settings = this.read(options);
    return {
      ...settings,
      ai: publicAiProfilesConfig(settings.ai),
      logging: { levels: [...settings.logging.levels] },
    };
  }
}

module.exports = { SettingsStore, defaultSettings, defaultAppearance, validateAppearance, validateSettings, mergeObjects };
