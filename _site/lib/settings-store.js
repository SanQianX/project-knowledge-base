const { SCHEMAS, DomainError, publicAiProfilesConfig } = require('./contracts');
const AtomicFile = require('./atomic-file');
const { StorageLayout } = require('./storage-layout');

function defaultSettings() {
  return {
    schema: SCHEMAS.settings,
    schemaVersion: 2,
    knowledge: { rootPath: '' },
    ai: { schema: 'ai-profiles/v1', profiles: [] },
    embedding: {},
    logging: {
      levels: ['info', 'warn', 'error', 'fatal'],
      retentionDays: 365,
      maxTotalSizeMB: 2048,
    },
    promptOverrides: {},
    integrations: {},
    legacyExtensions: {},
    updatedAt: '',
  };
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
  const logging = settings.logging || {};
  if (!Array.isArray(logging.levels) || !Number.isInteger(logging.retentionDays) || logging.retentionDays < 0) {
    throw new DomainError('DATA_CORRUPT', 'Settings logging configuration is invalid.', { status: 500 });
  }
  if (!Number.isFinite(logging.maxTotalSizeMB) || logging.maxTotalSizeMB <= 0) {
    throw new DomainError('DATA_CORRUPT', 'Settings logging maxTotalSizeMB is invalid.', { status: 500 });
  }
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

  readPublicView(options = {}) {
    const settings = this.read(options);
    return {
      ...settings,
      ai: publicAiProfilesConfig(settings.ai),
    };
  }
}

module.exports = { SettingsStore, defaultSettings, validateSettings, mergeObjects };
