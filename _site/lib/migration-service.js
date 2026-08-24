const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { SCHEMAS, SCHEMA_VERSIONS, DomainError } = require('./contracts');
const AtomicFile = require('./atomic-file');
const { StorageLayout } = require('./storage-layout');
const { defaultSettings, validateSettings } = require('./settings-store');
const { emptyRegistry, validateRegistry } = require('./project-registry-store');
const { defaultProjectConfig, defaultProjectState, validateProjectConfig, validateProjectState } = require('./project-store');
const { LEGACY_ASSETS, getLegacyAsset, assetPath } = require('./legacy-data-manifest');
const { STATES, classifyDataState } = require('./data-state-classifier');

function hashBuffer(buffer) { return crypto.createHash('sha256').update(buffer).digest('hex'); }
function hashFile(filePath) { return hashBuffer(fs.readFileSync(filePath)); }

function copyRecursive(source, target) {
  const stat = fs.statSync(source);
  if (stat.isDirectory()) {
    fs.mkdirSync(target, { recursive: true });
    for (const entry of fs.readdirSync(source)) copyRecursive(path.join(source, entry), path.join(target, entry));
    return;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
}

function removeOwnedPath(target) {
  if (!fs.existsSync(target)) return;
  fs.rmSync(target, { recursive: true, force: true });
}

function pruneEmptyParents(target, boundary) {
  const root = path.resolve(boundary);
  let current = path.dirname(path.resolve(target));
  while (current !== root && current.startsWith(`${root}${path.sep}`)) {
    if (!fs.existsSync(current) || fs.readdirSync(current).length > 0) break;
    fs.rmdirSync(current);
    current = path.dirname(current);
  }
}

function deterministicProjectId(slug, config) {
  const identity = String(config && (config.projectId || config.gitPath || config.localPath || config.repoPath) || slug);
  const existing = String(config && config.projectId || '');
  if (/^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/.test(existing)) return existing;
  return `project-${crypto.createHash('sha256').update(`${slug}\0${identity}`).digest('hex').slice(0, 20)}`;
}

function safeReadJson(filePath, fallback = null) {
  if (!fs.existsSync(filePath)) return fallback;
  try {
    // Legacy files written via PowerShell/tooling often carry a UTF-8 BOM;
    // JSON.parse rejects it, and a BOM must never fail the whole migration.
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
  }
  catch (error) { throw new DomainError('DATA_CORRUPT', 'Legacy migration source JSON is corrupt.', { status: 500, cause: error, details: { category: path.basename(filePath) } }); }
}

function sourceSnapshot(paths) {
  const entries = [];
  for (const source of paths) {
    if (!fs.existsSync(source)) continue;
    const stat = fs.statSync(source);
    entries.push({
      path: source,
      kind: stat.isDirectory() ? 'directory' : 'file',
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      hash: stat.isFile() ? hashFile(source) : '',
    });
  }
  return entries;
}

function verifySourceSnapshot(entries) {
  for (const entry of entries) {
    if (!fs.existsSync(entry.path)) return false;
    const stat = fs.statSync(entry.path);
    if (entry.kind === 'file' && (stat.size !== entry.size || hashFile(entry.path) !== entry.hash)) return false;
  }
  return true;
}

function directoryDigest(root) {
  const hash = crypto.createHash('sha256');
  const walk = current => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const item = path.join(current, entry.name);
      hash.update(`${entry.isDirectory() ? 'd' : 'f'}:${path.relative(root, item).replace(/\\/g, '/')}\0`);
      if (entry.isDirectory()) walk(item); else if (entry.isFile()) hash.update(fs.readFileSync(item));
    }
  };
  walk(root);
  return hash.digest('hex');
}

class MigrationService {
  constructor(options = {}) {
    this.layout = options.layout || new StorageLayout(options);
    this.atomic = options.atomic || AtomicFile;
    this.legacyDataDir = path.resolve(options.legacyDataDir || this.layout.getDataDir());
    this.indexValidator = options.indexValidator || (async indexPath => ({ ok: fs.existsSync(indexPath) }));
    this.logger = options.logger || { info() {}, warn() {}, error() {} };
  }

  completion() {
    const completionPath = this.layout.getMigrationCompletionPath();
    if (!fs.existsSync(completionPath)) return null;
    const marker = this.atomic.readJsonStrict(completionPath, { category: 'layout-migration-completion' });
    return marker && ['layout-migration-completion/v1', 'layout-migration-completion/v2'].includes(marker.schema) && marker.migrationId === SCHEMA_VERSIONS.layoutMigration
      ? marker
      : null;
  }

  completionMarker({ runId = '', registry, settings, modelsMigrated = false } = {}) {
    const profiles = settings && settings.ai && Array.isArray(settings.ai.profiles) ? settings.ai.profiles : [];
    return {
      schema: 'layout-migration-completion/v2',
      migrationId: SCHEMA_VERSIONS.layoutMigration,
      runId,
      sourceRoot: this.legacyDataDir,
      sourceManifestHash: hashBuffer(Buffer.from(JSON.stringify(LEGACY_ASSETS.map(asset => [asset.source, asset.target, asset.kind])))),
      projectCount: registry.projectOrder.length,
      aiProfileCount: profiles.length,
      knowledgeRootConfigured: Boolean(settings.knowledge && settings.knowledge.rootPath),
      embeddingConfigured: Boolean(settings.embedding && Object.keys(settings.embedding).length),
      modelsMigrated,
      completedAt: new Date().toISOString(),
      verified: true,
    };
  }

  validateCompletedState(marker) {
    try {
      const registry = this.atomic.readJsonStrict(this.layout.getProjectRegistryPath(), { category: 'project-registry' });
      validateRegistry(registry);
      const settings = this.atomic.readJsonStrict(this.layout.getSettingsPath(), { category: 'settings' });
      validateSettings(settings);
      for (const projectId of registry.projectOrder) {
        validateProjectConfig(this.atomic.readJsonStrict(this.layout.getProjectConfigPath(projectId), { category: 'project-config' }), projectId);
        validateProjectState(this.atomic.readJsonStrict(this.layout.getProjectStatePath(projectId), { category: 'project-state' }));
      }
      if (Number.isInteger(marker.projectCount) && marker.projectCount !== registry.projectOrder.length) return { ok: false, reason: 'completion-project-count-mismatch' };
      return { ok: true, registry, settings };
    } catch (error) { return { ok: false, reason: 'completion-state-invalid', error }; }
  }

  discover() {
    const paths = LEGACY_ASSETS.map(asset => assetPath(this.legacyDataDir, asset)).filter(file => fs.existsSync(file));
    const knowledgeStore = safeReadJson(path.join(this.legacyDataDir, 'knowledge-store.json'), {});
    const indexCandidates = [
      path.join(this.legacyDataDir, 'knowledge.lancedb'),
      knowledgeStore && knowledgeStore.rootPath ? path.join(path.resolve(knowledgeStore.rootPath), '.project-knowledge', 'knowledge.lancedb') : '',
    ].filter(Boolean);
    const indexPath = indexCandidates.find(candidate => fs.existsSync(candidate)) || '';
    if (indexPath) paths.push(indexPath);
    return {
      legacyProjectsPath: path.join(this.legacyDataDir, 'projects.json'),
      knowledgeStore,
      indexPath,
      modelsPath: assetPath(this.legacyDataDir, getLegacyAsset('models')),
      sources: sourceSnapshot(paths),
    };
  }

  mergeLegacySettings(discovery) {
    const settings = defaultSettings();
    const read = name => safeReadJson(path.join(this.legacyDataDir, name), null);
    const knowledge = read('knowledge-store.json');
    const ai = read('ai-profiles.json');
    const embedding = read('embedding-config.json');
    const logging = read('logging.json');
    const prompts = read('claude-prompts.json');
    const github = read('github-team.json');
    const providers = read('team-git-providers.json');
    if (knowledge && typeof knowledge.rootPath === 'string') settings.knowledge.rootPath = knowledge.rootPath;
    if (ai && typeof ai === 'object') settings.ai = ai;
    if (embedding && typeof embedding === 'object') settings.embedding = embedding;
    if (logging && typeof logging === 'object') {
      if (Array.isArray(logging.levels)) settings.logging.levels = logging.levels;
      settings.legacyExtensions.logging = { ...logging };
    }
    if (prompts && typeof prompts === 'object') settings.promptOverrides = prompts;
    if (github || providers) settings.integrations = { ...(settings.integrations || {}), ...(github ? { githubTeam: github } : {}), ...(providers ? { teamGitProviders: providers } : {}) };
    settings.updatedAt = new Date().toISOString();
    return validateSettings(settings);
  }

  buildProjectRecords(legacyProjects, settings) {
    const registry = emptyRegistry();
    const records = [];
    for (const [slug, rawConfig] of Object.entries(legacyProjects || {})) {
      const legacy = rawConfig && rawConfig.config && typeof rawConfig.config === 'object' ? rawConfig.config : (rawConfig || {});
      const projectId = deterministicProjectId(slug, legacy);
      const knowledgePath = legacy.knowledgePath || legacy.kbPath || (settings.knowledge.rootPath ? path.join(path.resolve(settings.knowledge.rootPath), slug) : path.join(this.legacyDataDir, 'projects', slug));
      const config = defaultProjectConfig(projectId, {
        displayName: legacy.displayName || slug,
        storageName: legacy.storageName || `${slug}-${projectId.slice(-6)}`,
        repoPath: legacy.repoPath || legacy.gitPath || legacy.localPath || this.legacyDataDir,
        knowledgePath,
        enabled: legacy.enabled !== false,
        createdAt: legacy.createdAt || new Date(0).toISOString(),
        teamBinding: legacy.teamBinding || (legacy.teamKbId ? { teamKbId: legacy.teamKbId } : null),
        aiProfileId: legacy.aiProfileId || null,
        knowledgeLanguage: legacy.knowledgeLanguage || 'zh-CN',
        relatedProjectIds: legacy.relatedProjectIds || [],
        repoIdentity: legacy.repoIdentity || null,
        legacyExtensions: { slug, sourceSchema: legacy.schema || '' },
      });
      const hasTracking = Boolean(legacy.trackingStartCommit || legacy.lastAnalyzedCommit);
      const state = defaultProjectState({
        trackingStartCommit: legacy.trackingStartCommit || null,
        lastAnalyzedCommit: legacy.lastAnalyzedCommit || null,
        trackingMode: hasTracking ? 'normal' : (legacy.repoStatus === 'empty-repo' ? 'empty-repo' : 'normal'),
        hook: { managedVersion: 0, migrationVersion: 0, lastVerifiedAt: '' },
      });
      validateProjectConfig(config, projectId);
      validateProjectState(state);
      registry.projectOrder.push(projectId);
      registry.projects[projectId] = { createdAt: config.createdAt, displayNameSnapshot: config.displayName };
      records.push({ slug, projectId, config, state });
    }
    registry.updatedAt = new Date().toISOString();
    validateRegistry(registry);
    return { registry, records };
  }

  injectFault(options, stage) {
    if (options && options.faultAt === stage) throw new Error(`injected migration fault: ${stage}`);
  }

  async migrateIfNeeded(options = {}) {
    const existingCompletion = this.completion();
    if (existingCompletion) {
      const verified = this.validateCompletedState(existingCompletion);
      if (!verified.ok) return { ok: false, migrated: false, completed: false, requiresManualRecovery: true, reason: verified.reason, error: verified.error };
      if (existingCompletion.schema === 'layout-migration-completion/v2') return { ok: true, migrated: false, completed: true, marker: existingCompletion };
      const marker = this.completionMarker({ runId: existingCompletion.runId || 'v1-marker-upgrade', registry: verified.registry, settings: verified.settings, modelsMigrated: fs.existsSync(this.layout.getCachePath('models')) });
      this.atomic.writeJsonAtomic(this.layout.getMigrationCompletionPath(), marker);
      return { ok: true, migrated: false, completed: true, marker };
    }
    const state = classifyDataState(this.legacyDataDir);
    if (state.state === STATES.FRESH) return { ok: true, migrated: false, completed: false, reason: 'fresh-install' };
    if (state.state === STATES.CORRUPT || state.state === STATES.MIGRATION_INCOMPLETE) {
      return { ok: false, migrated: false, completed: false, requiresManualRecovery: true, reason: state.state.toLowerCase() };
    }
    const discovery = this.discover();
    this.injectFault(options, 'discovery');
    // A user may have configured only AI/embedding/knowledge settings before
    // ever importing a project. That is still legacy user data and must be
    // migrated into an explicitly empty v2 registry, never treated as Fresh.
    const legacyProjects = safeReadJson(discovery.legacyProjectsPath, {});
    if (legacyProjects && legacyProjects.schema === SCHEMAS.projectRegistry && legacyProjects.schemaVersion === 2 && fs.existsSync(this.layout.getSettingsPath())) {
      validateRegistry(legacyProjects);
      const settings = this.atomic.readJsonStrict(this.layout.getSettingsPath(), { category: 'settings' });
      validateSettings(settings);
      const marker = this.completionMarker({ runId: 'validated-existing-v2', registry: legacyProjects, settings, modelsMigrated: fs.existsSync(this.layout.getCachePath('models')) });
      this.atomic.writeJsonAtomic(this.layout.getMigrationCompletionPath(), marker);
      return { ok: true, migrated: false, completed: true, marker };
    }
    if (state.state !== STATES.LEGACY) return { ok: false, migrated: false, completed: false, requiresManualRecovery: true, reason: 'legacy-state-not-migratable' };

    const migrationId = options.migrationRunId || `layout-v2-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const recoveryDir = this.layout.getRecoveryPath(migrationId);
    const backupDir = path.join(recoveryDir, 'backup');
    const stagingDir = path.join(recoveryDir, 'staging');
    fs.mkdirSync(backupDir, { recursive: true });
    fs.mkdirSync(stagingDir, { recursive: true });
    const journalPath = path.join(recoveryDir, 'journal.json');
    const journal = {
      schema: SCHEMAS.migrationJournal,
      migrationId: SCHEMA_VERSIONS.layoutMigration,
      runId: migrationId,
      phase: 'discovered',
      startedAt: new Date().toISOString(),
      sources: discovery.sources,
      activated: [],
    };
    this.atomic.writeJsonAtomic(journalPath, journal);
    const legacyRegistryBackup = path.join(backupDir, 'projects.json');
    try {
      for (const entry of discovery.sources) {
        const relative = path.relative(this.legacyDataDir, entry.path);
        const safeRelative = relative.startsWith('..') || path.isAbsolute(relative)
          ? path.join('external', hashBuffer(Buffer.from(entry.path)).slice(0, 16), path.basename(entry.path))
          : relative;
        copyRecursive(entry.path, path.join(backupDir, safeRelative));
      }
      journal.phase = 'backed-up';
      this.atomic.writeJsonAtomic(journalPath, journal);
      this.injectFault(options, 'backup');

      const settings = this.mergeLegacySettings(discovery);
      const projectData = this.buildProjectRecords(legacyProjects, settings);
      const staged = [];
      const stageJson = (relative, value) => {
        const stagedPath = path.join(stagingDir, relative);
        this.atomic.writeJsonAtomic(stagedPath, value);
        staged.push({ relative, kind: 'file', hash: hashFile(stagedPath) });
      };
      stageJson('settings.json', settings);
      for (const record of projectData.records) {
        stageJson(path.join('projects', record.projectId, 'config.json'), record.config);
        stageJson(path.join('projects', record.projectId, 'state.json'), record.state);
      }
      stageJson('projects.json', projectData.registry);
      let modelsMigrated = false;
      if (fs.existsSync(discovery.modelsPath)) {
        const modelTarget = this.layout.getCachePath('models');
        if (fs.existsSync(modelTarget)) {
          if (directoryDigest(discovery.modelsPath) !== directoryDigest(modelTarget)) {
            throw new DomainError('MIGRATION_TARGET_CONFLICT', 'Legacy model cache conflicts with the current model cache.', { status: 409, details: { category: 'cache/models' } });
          }
        } else {
          const relative = path.join('cache', 'models');
          copyRecursive(discovery.modelsPath, path.join(stagingDir, relative));
          staged.push({ relative, kind: 'directory', hash: directoryDigest(path.join(stagingDir, relative)) });
          modelsMigrated = true;
        }
      }
      if (discovery.indexPath) {
        const relative = path.join('index', 'knowledge.lancedb');
        copyRecursive(discovery.indexPath, path.join(stagingDir, relative));
        staged.push({ relative, kind: 'directory', hash: '' });
      }
      journal.staged = staged;
      journal.projectMap = Object.fromEntries(projectData.records.map(record => [record.slug, record.projectId]));
      journal.phase = 'staged';
      this.atomic.writeJsonAtomic(journalPath, journal);
      this.injectFault(options, 'staging');

      if (!verifySourceSnapshot(discovery.sources)) throw new DomainError('MIGRATION_SOURCE_CHANGED', 'Migration source changed while staging.', { status: 409 });
      validateSettings(JSON.parse(fs.readFileSync(path.join(stagingDir, 'settings.json'), 'utf8')));
      validateRegistry(JSON.parse(fs.readFileSync(path.join(stagingDir, 'projects.json'), 'utf8')));
      for (const record of projectData.records) {
        validateProjectConfig(JSON.parse(fs.readFileSync(path.join(stagingDir, 'projects', record.projectId, 'config.json'), 'utf8')), record.projectId);
        validateProjectState(JSON.parse(fs.readFileSync(path.join(stagingDir, 'projects', record.projectId, 'state.json'), 'utf8')));
      }
      if (discovery.indexPath) {
        const indexResult = await this.indexValidator(path.join(stagingDir, 'index', 'knowledge.lancedb'));
        if (!indexResult || indexResult.ok !== true) throw new DomainError('MIGRATION_FAILED', 'Staged index validation failed.', { status: 500 });
      }
      journal.phase = 'validated';
      this.atomic.writeJsonAtomic(journalPath, journal);
      this.injectFault(options, 'validation');

      const activationOrder = staged.filter(item => item.relative !== 'projects.json');
      const activationBackupDir = path.join(backupDir, 'activation-targets');
      journal.activationTargets = activationOrder.map(item => {
        const target = path.join(this.layout.getDataDir(), item.relative);
        const existed = fs.existsSync(target);
        if (item.kind === 'directory' && existed) {
          throw new DomainError('MIGRATION_TARGET_CONFLICT', 'Migration target already exists.', { status: 409, details: { category: item.relative } });
        }
        if (existed) copyRecursive(target, path.join(activationBackupDir, item.relative));
        return { relative: item.relative, kind: item.kind, existed };
      });
      this.atomic.writeJsonAtomic(journalPath, journal);
      for (const item of activationOrder) {
        const source = path.join(stagingDir, item.relative);
        const target = path.join(this.layout.getDataDir(), item.relative);
        if (item.kind === 'directory') {
          copyRecursive(source, target);
        } else {
          this.atomic.writeFileAtomic(target, fs.readFileSync(source));
        }
        journal.activated.push(item.relative);
        this.atomic.writeJsonAtomic(journalPath, journal);
      }
      this.atomic.writeFileAtomic(this.layout.getProjectRegistryPath(), fs.readFileSync(path.join(stagingDir, 'projects.json')));
      journal.activated.push('projects.json');
      journal.phase = 'activated';
      this.atomic.writeJsonAtomic(journalPath, journal);
      this.injectFault(options, 'activation');

      validateSettings(this.atomic.readJsonStrict(this.layout.getSettingsPath(), { category: 'settings' }));
      const openedRegistry = this.atomic.readJsonStrict(this.layout.getProjectRegistryPath(), { category: 'project-registry' });
      validateRegistry(openedRegistry);
      for (const projectId of openedRegistry.projectOrder) {
        validateProjectConfig(this.atomic.readJsonStrict(this.layout.getProjectConfigPath(projectId), { category: 'project-config' }), projectId);
        validateProjectState(this.atomic.readJsonStrict(this.layout.getProjectStatePath(projectId), { category: 'project-state' }));
      }
      journal.phase = 'open-verified';
      this.atomic.writeJsonAtomic(journalPath, journal);
      this.injectFault(options, 'open-verification');

      const marker = this.completionMarker({ runId: migrationId, registry: openedRegistry, settings: this.atomic.readJsonStrict(this.layout.getSettingsPath(), { category: 'settings' }), modelsMigrated });
      this.atomic.writeJsonAtomic(this.layout.getMigrationCompletionPath(), marker);
      journal.phase = 'completed';
      journal.completedAt = marker.completedAt;
      this.atomic.writeJsonAtomic(journalPath, journal);
      return { ok: true, migrated: true, completed: true, marker, recoveryDir, projectMap: journal.projectMap };
    } catch (error) {
      const rollbackErrors = [];
      for (const targetInfo of [...(journal.activationTargets || [])].reverse()) {
        const target = path.join(this.layout.getDataDir(), targetInfo.relative);
        try {
          if (targetInfo.existed) {
            const backup = path.join(backupDir, 'activation-targets', targetInfo.relative);
            if (targetInfo.kind === 'directory') {
              removeOwnedPath(target);
              copyRecursive(backup, target);
            } else {
              this.atomic.writeFileAtomic(target, fs.readFileSync(backup));
            }
          } else {
            removeOwnedPath(target);
            pruneEmptyParents(target, this.layout.getDataDir());
          }
        } catch (rollbackError) {
          rollbackErrors.push({ target: targetInfo.relative, message: String(rollbackError.message || rollbackError) });
        }
      }
      try {
        if (fs.existsSync(legacyRegistryBackup)) {
          this.atomic.writeFileAtomic(this.layout.getProjectRegistryPath(), fs.readFileSync(legacyRegistryBackup));
        }
      } catch (rollbackError) {
        rollbackErrors.push({ target: 'projects.json', message: String(rollbackError.message || rollbackError) });
      }
      journal.phase = 'failed';
      journal.failedAt = new Date().toISOString();
      journal.error = { name: error.name || 'Error', code: error.code || '', message: String(error.message || error) };
      journal.rollback = { ok: rollbackErrors.length === 0, errors: rollbackErrors };
      this.atomic.writeJsonAtomic(journalPath, journal);
      this.logger.error('migration.failed', { error, recoveryDir, rollbackErrors });
      return { ok: false, migrated: false, completed: false, useLegacy: rollbackErrors.length === 0, recoveryDir, error, rollbackErrors };
    }
  }
}

module.exports = {
  MigrationService,
  deterministicProjectId,
  hashFile,
  sourceSnapshot,
  verifySourceSnapshot,
};
