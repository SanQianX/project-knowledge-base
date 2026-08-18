const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const dataDir = require('./data-dir');
const runtimeEndpoint = require('./runtime-endpoint');
const hookManager = require('./hook-manager');
const claudeCliRunner = require('./claude-cli-runner');
const { StorageLayout } = require('./storage-layout');
const { SettingsStore } = require('./settings-store');
const { ProjectRegistryStore } = require('./project-registry-store');
const { ProjectStore } = require('./project-store');
const { MigrationService } = require('./migration-service');
const { ProjectLifecycleService } = require('./project-lifecycle-service');
const { RequirementRecorder } = require('./requirement-recorder');
const { recordEmbeddedClaudeInput } = require('./requirement-adapters');
const { Logger, LogRepository } = require('./structured-logger');
const { CommitReconciler, reconcileProjectCommits } = require('./commit-reconciler');
const { handlePostCommitEvent } = require('./post-commit-automation');
const { KnowledgePromotionService, hashBuffer } = require('./knowledge-promotion');
const { IndexService } = require('./index-service');
const { KnowledgeDatabase } = require('./knowledge-db');
const { LocalEmbeddingService } = require('./embedding-service');
const { MarkdownKnowledgeIndexer } = require('./markdown-knowledge-indexer');
const { KnowledgeToolRuntime } = require('./knowledge-tool-runtime');
const { buildContextPack } = require('./context-pack-builder');
const { execGit } = require('./git-runner');
const {
  SCHEMAS,
  DomainError,
  createId,
  serializeErrorEnvelope,
  publicAiProfilesConfig,
  validateProjectId,
  LOG_LEVELS,
  REDACTION_KEY_PATTERN,
} = require('./contracts');

const DEFAULT_PORT = 5757;
const UI_ROOT = path.resolve(__dirname, '..', '..', 'ui');
const TRIGGER_SCRIPT_PATH = path.resolve(__dirname, '..', 'scripts', 'hook-trigger.js');
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const CONTENT_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
});

function isLoopback(host) {
  return LOOPBACK_HOSTS.has(String(host || '').trim().toLowerCase());
}

function parsePort(value) {
  const port = Number(value || DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new DomainError('INVALID_ARGUMENT', 'KB_SITE_PORT is invalid.', { status: 500 });
  return port;
}

function parseAllowedOrigins(value) {
  return new Set(String(value || '').split(',').map(item => item.trim()).filter(Boolean));
}

function configuredSecrets(settingsStore, extras = []) {
  const secrets = [...extras];
  try {
    const settings = settingsStore.read({ allowMissing: true });
    for (const profile of settings.ai && Array.isArray(settings.ai.profiles) ? settings.ai.profiles : []) {
      for (const [key, value] of Object.entries(profile || {})) {
        if (REDACTION_KEY_PATTERN.test(key) && typeof value === 'string') secrets.push(value);
      }
    }
  } catch {
    // Logger construction must survive missing/corrupt pre-initialization settings without exposing secrets.
  }
  return [...new Set(secrets.filter(secret => typeof secret === 'string' && secret.length >= 4))];
}

function normalizeLoggingPatch(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new DomainError('INVALID_ARGUMENT', 'Logging settings must be an object.');
  }
  const allowed = new Set(['levels', 'retentionDays', 'maxTotalSizeMB']);
  const unknown = Object.keys(input).find(key => !allowed.has(key));
  if (unknown) throw new DomainError('INVALID_ARGUMENT', `Unknown logging setting: ${unknown}.`, { details: { field: unknown } });
  const patch = {};
  if (Object.prototype.hasOwnProperty.call(input, 'levels')) {
    if (!Array.isArray(input.levels) || !input.levels.length || input.levels.some(level => !LOG_LEVELS.includes(level))) {
      throw new DomainError('INVALID_ARGUMENT', 'Logging levels must contain one or more supported levels.');
    }
    patch.levels = [...new Set(input.levels)];
  }
  if (Object.prototype.hasOwnProperty.call(input, 'retentionDays')) {
    if (!Number.isInteger(input.retentionDays) || input.retentionDays < 0 || input.retentionDays > 3650) {
      throw new DomainError('INVALID_ARGUMENT', 'Logging retentionDays must be an integer from 0 to 3650.');
    }
    patch.retentionDays = input.retentionDays;
  }
  if (Object.prototype.hasOwnProperty.call(input, 'maxTotalSizeMB')) {
    if (!Number.isFinite(input.maxTotalSizeMB) || input.maxTotalSizeMB <= 0 || input.maxTotalSizeMB > 1048576) {
      throw new DomainError('INVALID_ARGUMENT', 'Logging maxTotalSizeMB must be between 1 and 1048576.');
    }
    patch.maxTotalSizeMB = Number(input.maxTotalSizeMB);
  }
  if (!Object.keys(patch).length) throw new DomainError('INVALID_ARGUMENT', 'No mutable logging settings were provided.');
  return patch;
}

function requestOriginAllowed(req, origin, options) {
  if (!origin) return true;
  if (origin === 'null') return false;
  let parsed;
  try { parsed = new URL(origin); } catch { return false; }
  if (!['http:', 'https:'].includes(parsed.protocol)) return false;
  const hostHeader = String(req.headers.host || '').toLowerCase();
  if (hostHeader && parsed.host.toLowerCase() === hostHeader) return true;
  if (options.allowedOrigins.has(origin)) return true;
  if (!options.loopbackBind) return false;
  return isLoopback(parsed.hostname) && Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80)) === options.port;
}

function authorizationValid(req, token) {
  if (!token) return false;
  const bearer = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
  const supplied = bearer ? bearer[1] : String(req.headers['x-project-knowledge-token'] || '');
  if (!supplied) return false;
  const expectedBuffer = Buffer.from(token);
  const suppliedBuffer = Buffer.from(supplied);
  return expectedBuffer.length === suppliedBuffer.length && crypto.timingSafeEqual(expectedBuffer, suppliedBuffer);
}

function applyCors(req, res, security) {
  const origin = String(req.headers.origin || '');
  res.setHeader('Vary', 'Origin');
  if (origin && requestOriginAllowed(req, origin, security)) res.setHeader('Access-Control-Allow-Origin', origin);
}

function enforceSecurity(req, security) {
  const origin = String(req.headers.origin || '');
  if (origin && !requestOriginAllowed(req, origin, security)) {
    throw new DomainError('ORIGIN_FORBIDDEN', 'Request Origin is not allowed.', { status: 403 });
  }
  if (!security.loopbackBind && !authorizationValid(req, security.authToken)) {
    throw new DomainError('AUTH_REQUIRED', 'Authentication is required for a non-loopback server.', { status: 401 });
  }
}

function send(res, status, body, contentType = '') {
  if (res.writableEnded) return;
  const isBuffer = Buffer.isBuffer(body);
  const isText = typeof body === 'string' || isBuffer;
  const payload = isText ? body : JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('Content-Type', contentType || (isText ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8'));
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.end(payload);
}

async function readJsonBody(req, maxBytes = 2 * 1024 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) throw new DomainError('INVALID_ARGUMENT', 'Request body is too large.', { status: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch (error) { throw new DomainError('INVALID_ARGUMENT', 'Request body must be valid JSON.', { status: 400, cause: error }); }
}

function profileById(settings, profileId) {
  return (settings.ai && Array.isArray(settings.ai.profiles) ? settings.ai.profiles : []).find(profile => profile.id === profileId) || null;
}

function mergeAiProfiles(current, input) {
  if (!input || typeof input !== 'object' || !Array.isArray(input.profiles)) {
    throw new DomainError('INVALID_ARGUMENT', 'AI profiles must contain a profiles array.');
  }
  const existing = new Map((current && Array.isArray(current.profiles) ? current.profiles : []).map(profile => [profile.id, profile]));
  const ids = new Set();
  const profiles = input.profiles.map(raw => {
    if (!raw || typeof raw !== 'object') throw new DomainError('INVALID_ARGUMENT', 'AI profile is invalid.');
    const id = String(raw.id || '').trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{1,127}$/.test(id) || ids.has(id)) throw new DomainError('INVALID_ARGUMENT', 'AI profile id is invalid or duplicated.');
    ids.add(id);
    const prior = existing.get(id) || {};
    const update = raw.apiKeyUpdate && typeof raw.apiKeyUpdate === 'object' ? raw.apiKeyUpdate : {};
    const mode = String(update.mode || raw.apiKeyMode || (Object.prototype.hasOwnProperty.call(raw, 'apiKey') ? 'replace' : 'preserve'));
    if (!['preserve', 'replace', 'clear'].includes(mode)) throw new DomainError('INVALID_ARGUMENT', 'apiKeyUpdate.mode must be preserve, replace, or clear.');
    const next = { ...raw, id };
    delete next.apiKeyUpdate;
    delete next.apiKeyMode;
    delete next.hasApiKey;
    delete next.apiKeyMasked;
    delete next.authToken;
    if (mode === 'preserve') {
      if (prior.apiKey) next.apiKey = prior.apiKey;
      else delete next.apiKey;
    } else if (mode === 'clear') {
      delete next.apiKey;
    } else {
      const replacement = String(update.value || raw.apiKey || '');
      if (!replacement) throw new DomainError('INVALID_ARGUMENT', 'A replacement API key is required.');
      next.apiKey = replacement;
    }
    return next;
  });
  const defaultProfileId = input.defaultProfileId == null ? current && current.defaultProfileId || null : input.defaultProfileId;
  if (defaultProfileId && !ids.has(defaultProfileId)) throw new DomainError('INVALID_ARGUMENT', 'defaultProfileId must reference a configured profile.');
  return { ...current, ...input, schema: input.schema || current && current.schema || 'ai-profiles/v1', profiles, defaultProfileId };
}

function projectPublicView(projectId, projectStore) {
  const config = projectStore.readConfig(projectId);
  const state = projectStore.readState(projectId);
  return { projectId, config, state };
}

function listProjectViews(registryStore, projectStore) {
  return registryStore.listIds().map(projectId => projectPublicView(projectId, projectStore));
}

async function inspectGitRepository(repoPath) {
  const root = path.resolve(String(repoPath || ''));
  if (!repoPath || !fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    return { repoStatus: 'missing', repoPath: root, headCommit: null, branch: '', dirty: false, error: { code: 'PROJECT_NOT_FOUND', message: 'Repository path is missing.' } };
  }
  const inside = await execGit(root, ['rev-parse', '--is-inside-work-tree']);
  if (!inside.ok) return { repoStatus: 'not-git', repoPath: root, headCommit: null, branch: '', dirty: false, error: { code: 'INVALID_ARGUMENT', message: 'Path is not a Git work tree.' } };
  const [top, head, branch, status, commonDir] = await Promise.all([
    execGit(root, ['rev-parse', '--show-toplevel']),
    execGit(root, ['rev-parse', '--verify', 'HEAD']),
    execGit(root, ['branch', '--show-current']),
    execGit(root, ['status', '--porcelain=v1', '--untracked-files=normal']),
    execGit(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
  ]);
  return {
    repoStatus: head.ok ? 'ok' : 'empty',
    repoPath: top.ok ? path.resolve(top.stdout.trim()) : root,
    commonDir: commonDir.ok ? path.resolve(commonDir.stdout.trim()) : '',
    headCommit: head.ok ? head.stdout.trim() : null,
    branch: branch.ok ? branch.stdout.trim() : '',
    dirty: status.ok && Boolean(status.stdout.trim()),
    changes: status.ok ? status.stdout.split(/\r?\n/).filter(Boolean).slice(0, 200) : [],
    error: status.ok ? null : { code: 'INVALID_ARGUMENT', message: 'Git status could not be read.' },
  };
}

function listClaudeSessions(runtime, projectId = '') {
  const projectIds = projectId ? [projectId] : runtime.registryStore.listIds();
  const sessions = new Map();
  for (const id of projectIds) {
    for (const session of claudeCliRunner.listSessions({ projectSlug: id })) sessions.set(session.sessionId, session);
  }
  return [...sessions.values()].sort((left, right) => String(right.startedAt || '').localeCompare(String(left.startedAt || '')));
}

function isProjectBusy(projectId, projectStore, activeTasks) {
  if ((activeTasks.get(projectId)?.size || 0) > 0) return true;
  const state = projectStore.readState(projectId);
  if (state.analysis.activeClaim) return true;
  return claudeCliRunner.listSessions({ projectSlug: projectId }).some(session => ['spawning', 'running', 'pending-permission'].includes(session.state));
}

class RuntimeIndexAdapter {
  constructor(options) {
    this.layout = options.layout;
    this.settingsStore = options.settingsStore;
    this.runtime = null;
  }

  getRuntime() {
    if (this.runtime) return this.runtime;
    const settings = this.settingsStore.read();
    const database = new KnowledgeDatabase({
      dbPath: this.layout.getIndexPath(),
      maintenancePath: this.layout.getRuntimePath('index-maintenance.json'),
    });
    const embedding = settings.embedding || {};
    const embedder = this.createEmbedder(embedding);
    this.runtime = { database, indexer: new MarkdownKnowledgeIndexer({ database, embedder }) };
    return this.runtime;
  }

  createEmbedder(embedding) {
    if (process.env.KB_EMBEDDING_FAKE === '1') {
      const embed = async text => {
        const vector = new Array(require('./knowledge-schema').EMBEDDING_DIMENSIONS).fill(0);
        for (let index = 0; index < String(text).length; index += 1) vector[String(text).charCodeAt(index) % vector.length] += 1;
        const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
        return vector.map(value => value / norm);
      };
      return { embedPassage: embed, embedQuery: embed };
    }
    return new LocalEmbeddingService({
      modelId: embedding.modelId,
      cacheDir: this.layout.getCachePath('models'),
      remoteHost: embedding.remoteHost,
      localModelPath: embedding.localModelPath,
      localFilesOnly: embedding.localFilesOnly === true,
    });
  }

  async indexProject(input) {
    const { indexer } = this.getRuntime();
    return indexer.indexDirectory({
      kbPath: input.knowledgePath,
      spaceId: `project:${input.projectId}`,
      sourceProjectId: input.projectId,
      sourceCommit: input.sinceCommit || '',
    });
  }

  createIndexer(targetPath) {
    const settings = this.settingsStore.read();
    const embedding = settings.embedding || {};
    const database = new KnowledgeDatabase({
      dbPath: targetPath,
      maintenancePath: `${targetPath}.maintenance.json`,
    });
    const embedder = this.createEmbedder(embedding);
    return { database, indexer: new MarkdownKnowledgeIndexer({ database, embedder }) };
  }

  async buildFull({ targetPath, projects }) {
    const built = this.createIndexer(targetPath);
    try {
      for (const { projectId, config } of projects) {
        await built.indexer.indexDirectory({
          kbPath: config.knowledgePath,
          spaceId: `project:${projectId}`,
          sourceProjectId: projectId,
          deferMaintenance: true,
        });
      }
      return { ok: true, projects: projects.length, rows: await built.database.count() };
    } finally {
      await built.database.close();
      try { fs.rmSync(`${targetPath}.maintenance.json`, { force: true }); } catch {
        // Maintenance metadata is non-authoritative and is replaced on the next rebuild.
      }
    }
  }

  async validateIndex(targetPath) {
    const database = new KnowledgeDatabase({ dbPath: targetPath, maintenancePath: `${targetPath}.maintenance.json` });
    try {
      await database.open();
      return { ok: true, rows: await database.count() };
    } catch (error) {
      return { ok: false, error: { code: error.code || 'DATA_CORRUPT', message: error.message } };
    } finally {
      await database.close();
    }
  }

  async close() {
    if (this.runtime) await this.runtime.database.close();
    this.runtime = null;
  }
}

class RuntimeKnowledgeAnalyzer {
  constructor(options) {
    this.settingsStore = options.settingsStore;
    this.logger = options.logger;
  }

  fakeResult(input) {
    const relativePath = `changes/${input.claim.commitSha.slice(0, 12)}.md`;
    const outputPath = path.join(input.stagingPath, 'files', ...relativePath.split('/'));
    const content = `# Commit ${input.claim.commitSha.slice(0, 12)}\n\nThis knowledge entry was generated by the isolated automation test adapter from commit evidence ${input.claim.commitSha}.\n`;
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, content, 'utf8');
    fs.writeFileSync(input.manifestPath, `${JSON.stringify({
      schema: 'knowledge-staging-manifest/v1',
      projectId: input.projectId,
      runId: input.claim.runId,
      commitSha: input.claim.commitSha,
      operations: [{
        path: relativePath,
        operation: 'create',
        sha256: hashBuffer(Buffer.from(content)),
        reason: 'Commit evidence was accepted by the isolated test analyzer.',
        evidenceReferences: [`commit:${input.claim.commitSha}`, `patch:${input.claim.patchHash}`],
      }],
    }, null, 2)}\n`, 'utf8');
    return { ok: true, fake: true };
  }

  async runClaim(input) {
    if (process.env.KB_AUTOMATION_FAKE_CLAUDE === '1') return this.fakeResult(input);
    const settings = this.settingsStore.read();
    const profile = profileById(settings, input.config.aiProfileId);
    if (!profile || profile.enabled === false) throw new DomainError('INVALID_ARGUMENT', 'The configured AI profile is unavailable.', { status: 409 });
    const contract = `\n\nOUTPUT CONTRACT\nWrite only beneath ${input.stagingPath}. Put Markdown under files/<allowed-path> and write ${input.manifestPath} with schema knowledge-staging-manifest/v1, projectId ${input.projectId}, runId ${input.claim.runId}, commitSha ${input.claim.commitSha}, and non-empty operations. Each operation needs path, operation, sha256, reason, and evidenceReferences. Do not modify source files, final knowledge, or indexes.`;
    const started = claudeCliRunner.startAutomationSession({
      slug: input.projectId,
      projectPath: input.config.repoPath,
      kbPath: input.stagingPath,
      userPrompt: `${input.prompt}${contract}`,
      aiProfile: profile,
      permissionMode: 'acceptEdits',
      allowedTools: input.safetyPolicy.allowedTools,
      safetyPolicy: input.safetyPolicy,
      metadata: { source: 'git-hook', automationRunId: input.claim.runId, commitHash: input.claim.commitSha, projectId: input.projectId },
    });
    const current = claudeCliRunner.getSession(started.sessionId);
    if (current && claudeCliRunner.TERMINAL_STATES.has(current.state)) {
      if (current.state !== 'idle') throw new DomainError('INVALID_ARGUMENT', 'Knowledge analyzer did not complete successfully.', { status: 500, retryable: true });
      return { ok: true, sessionId: started.sessionId };
    }
    const timeoutMs = Math.max(10_000, Number(process.env.KB_AUTOMATION_TIMEOUT_MS || 15 * 60 * 1000));
    return new Promise((resolve, reject) => {
      let timer;
      const unsubscribe = claudeCliRunner.onSessionEnded(session => {
        if (session.sessionId !== started.sessionId) return;
        clearTimeout(timer);
        unsubscribe();
        if (session.state === 'idle') resolve({ ok: true, sessionId: session.sessionId });
        else reject(new DomainError('INVALID_ARGUMENT', 'Knowledge analyzer did not complete successfully.', { status: 500, retryable: true }));
      });
      timer = setTimeout(() => {
        unsubscribe();
        try { claudeCliRunner.abort(started.sessionId); } catch {
          // Timeout remains the public failure when the child already exited.
        }
        reject(new DomainError('INVALID_ARGUMENT', 'Knowledge analyzer timed out.', { status: 504, retryable: true }));
      }, timeoutMs);
      timer.unref?.();
    });
  }
}

function createRuntime(options = {}) {
  const rootDir = path.resolve(options.rootDir || path.resolve(__dirname, '..', '..'));
  const dataPath = path.resolve(options.dataDir || dataDir.getDataDir());
  const layout = options.layout || new StorageLayout({ dataDir: dataPath });
  const settingsStore = options.settingsStore || new SettingsStore({ layout });
  const registryStore = options.registryStore || new ProjectRegistryStore({ layout });
  const projectStore = options.projectStore || new ProjectStore({ layout });
  const secretsProvider = () => configuredSecrets(settingsStore, [
    String(options.authToken || process.env.KB_SITE_AUTH_TOKEN || ''),
    String(process.env.ANTHROPIC_API_KEY || ''),
    String(process.env.ANTHROPIC_AUTH_TOKEN || ''),
  ]);
  const logger = options.logger || new Logger({
    layout,
    settingsProvider: () => {
      try { return settingsStore.read({ allowMissing: true }).logging; }
      catch { return {}; }
    },
    secretsProvider,
  });
  const logRepository = options.logRepository || new LogRepository({
    layout,
    settingsProvider: () => settingsStore.read({ allowMissing: true }).logging,
    secretsProvider,
  });
  const activeTasks = new Map();
  const indexAdapter = options.indexAdapter || new RuntimeIndexAdapter({ layout, settingsStore });
  const indexService = options.indexService || new IndexService({ layout, registryStore, projectStore, adapter: indexAdapter, logger });
  const analyzer = options.analyzer || new RuntimeKnowledgeAnalyzer({ settingsStore, logger });
  const promotionService = options.promotionService || new KnowledgePromotionService({ layout, projectStore, analyzer, indexService, logger });
  const reconciler = options.reconciler || new CommitReconciler({ layout, registryStore, projectStore, claimProcessor: promotionService, logger });
  const lifecycleService = options.lifecycleService || new ProjectLifecycleService({
    layout,
    settingsStore,
    registryStore,
    projectStore,
    hookManager,
    triggerScriptPath: TRIGGER_SCRIPT_PATH,
    logger,
    isProjectBusy: projectId => isProjectBusy(projectId, projectStore, activeTasks),
  });
  const requirementRecorder = options.requirementRecorder || new RequirementRecorder({ layout, registryStore, projectStore, logger });
  const knowledgeRuntime = options.knowledgeRuntime || new KnowledgeToolRuntime({ layout, settingsStore, registryStore, projectStore, requirementRecorder, logger });
  const migrationService = options.migrationService || new MigrationService({ layout, legacyDataDir: dataPath, logger });
  return {
    rootDir, dataPath, layout, settingsStore, registryStore, projectStore, logger, logRepository,
    activeTasks, indexAdapter, indexService, promotionService, reconciler, lifecycleService, requirementRecorder, knowledgeRuntime, migrationService,
  };
}

async function migrateManagedHooks(runtime) {
  const results = [];
  for (const projectId of runtime.registryStore.listIds()) {
    const config = runtime.projectStore.readConfig(projectId);
    const state = runtime.projectStore.readState(projectId);
    if (state.hook.migrationVersion >= 2 || !fs.existsSync(config.repoPath)) continue;
    try {
      const result = hookManager.migrateManagedHook({ repoPath: config.repoPath, projectId, triggerScriptPath: TRIGGER_SCRIPT_PATH });
      await runtime.projectStore.updateState(projectId, draft => {
        draft.hook.migrationVersion = 2;
        draft.hook.managedVersion = Number(result.managedVersion || 2);
        draft.hook.lastVerifiedAt = new Date().toISOString();
      });
      results.push({ projectId, ok: true, ...result });
    } catch (error) {
      await runtime.logger.warn('hook.migration_failed', 'Managed Hook migration could not be completed.', { projectId, error });
      results.push({ projectId, ok: false, error: { code: error.code || 'HOOK_INVALID', message: error.message } });
    }
  }
  return results;
}

async function initializeRuntime(runtime) {
  const legacyMove = dataDir.migrateFromLegacy({ legacyRoot: runtime.rootDir });
  if (!legacyMove.ok) throw new DomainError('MIGRATION_FAILED', 'Legacy runtime relocation failed.', { status: 500, details: { reason: legacyMove.error || '' } });
  await runtime.logger.info('server.startup_started', 'Server startup began.', { phase: 'migration' });
  const migration = await runtime.migrationService.migrateIfNeeded();
  await runtime.settingsStore.initialize();
  await runtime.registryStore.initialize();
  const recoveredPromotions = await runtime.promotionService.recoverAll();
  const recoveredIndexes = runtime.registryStore.listIds().filter(projectId => runtime.projectStore.readState(projectId).index.dirty);
  const orphanedOperations = runtime.logRepository.findOrphanedOperations();
  if (orphanedOperations.length) {
    await runtime.logger.warn('server.orphaned_operations_detected', 'Incomplete operations from a previous process were detected.', {
      phase: 'recovery',
      context: { operationIds: orphanedOperations.map(entry => entry.operationId), count: orphanedOperations.length },
    });
  }
  const hooks = await migrateManagedHooks(runtime);
  await runtime.logger.info('server.startup_ready', 'Server stores and recovery services are ready.', {
    phase: 'listen',
    context: { migration, recoveredPromotions: recoveredPromotions.length, recoveredIndexes: recoveredIndexes.length, orphanedOperations: orphanedOperations.length, hooks: hooks.length },
  });
  return { migration, recoveredPromotions, recoveredIndexes, orphanedOperations, hooks };
}

function safeStaticFile(pathname) {
  const decoded = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
  const candidate = path.resolve(UI_ROOT, `.${decoded}`);
  const relative = path.relative(UI_ROOT, candidate);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return candidate;
}

function streamSse(res, subscribe) {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
  res.write(': connected\n\n');
  const write = event => {
    if (!res.writableEnded) {
      const eventName = String(event && event.type || 'message').replace(/[^A-Za-z0-9._/-]/g, '') || 'message';
      res.write(`event: ${eventName}\ndata: ${JSON.stringify(event)}\n\n`);
    }
  };
  const unsubscribe = subscribe(write);
  setImmediate(() => { if (!res.writableEnded) res.write(': ready\n\n'); });
  const heartbeat = setInterval(() => { if (!res.writableEnded) res.write(': heartbeat\n\n'); }, 20_000);
  heartbeat.unref?.();
  res.on('close', () => { clearInterval(heartbeat); unsubscribe?.(); });
}

function taskForProject(runtime, projectId, operationId, task, kind = 'background') {
  let projectTasks = runtime.activeTasks.get(projectId);
  if (!projectTasks) {
    projectTasks = new Map();
    runtime.activeTasks.set(projectId, projectTasks);
  }
  if (projectTasks.has(operationId)) throw new DomainError('INVALID_ARGUMENT', 'Background operationId is already registered.');
  const startedAt = new Date().toISOString();
  const work = Promise.resolve().then(task);
  const promise = (async () => {
    await runtime.logger.debug('background.operation_registered', 'Background operation registered.', {
      projectId,
      operationId,
      phase: 'registered',
      context: { kind, startedAt },
    });
    try {
      const result = await work;
      await runtime.logger.debug('background.operation_completed', 'Background operation completed.', {
        projectId,
        operationId,
        phase: 'completed',
        durationMs: Date.now() - Date.parse(startedAt),
        context: { kind },
      });
      return result;
    } catch (error) {
      await runtime.logger.error('background.operation_failed', 'A background operation failed.', {
        projectId,
        operationId,
        phase: 'failed',
        durationMs: Date.now() - Date.parse(startedAt),
        error,
        context: { kind },
      });
      throw error;
    } finally {
      const current = runtime.activeTasks.get(projectId);
      current?.delete(operationId);
      if (current && current.size === 0) runtime.activeTasks.delete(projectId);
    }
  })();
  projectTasks.set(operationId, { operationId, kind, startedAt, promise });
  return promise;
}

function activeTaskPromises(activeTasks) {
  const promises = [];
  for (const projectTasks of activeTasks.values()) {
    for (const entry of projectTasks.values()) promises.push(entry.promise);
  }
  return promises;
}

function createRequestHandler(runtime, options = {}) {
  const port = parsePort(options.port || process.env.KB_SITE_PORT);
  const host = String(options.host || process.env.KB_SITE_HOST || '127.0.0.1');
  const security = {
    port,
    loopbackBind: isLoopback(host),
    authToken: String(options.authToken || process.env.KB_SITE_AUTH_TOKEN || ''),
    allowedOrigins: parseAllowedOrigins(options.allowedOrigins || process.env.KB_ALLOWED_ORIGINS),
  };
  if (!security.loopbackBind && !security.authToken) {
    throw new DomainError('AUTH_REQUIRED', 'KB_SITE_AUTH_TOKEN is required for a non-loopback bind.', { status: 500 });
  }

  return async function handle(req, res) {
    const requestOperationId = createId('op');
    const requestStartedAt = Date.now();
    const requestPathname = String(req.url || '').split('?')[0];
    let requestFailed = false;
    res.setHeader('X-Operation-Id', requestOperationId);
    res.once('finish', () => {
      if (requestFailed || res.statusCode >= 400) return;
      Promise.resolve(runtime.logger.info('http.request_completed', 'HTTP request completed.', {
        operationId: requestOperationId,
        phase: 'completed',
        durationMs: Date.now() - requestStartedAt,
        context: { method: req.method, pathname: requestPathname, status: res.statusCode },
      })).catch(() => {});
    });
    applyCors(req, res, security);
    try {
      await runtime.logger.debug('http.request_started', 'HTTP request started.', {
        operationId: requestOperationId,
        phase: 'started',
        context: { method: req.method, pathname: requestPathname },
      });
      enforceSecurity(req, security);
      if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Project-Knowledge-Token');
        return send(res, 204, '');
      }
      const url = new URL(req.url, `http://${req.headers.host || `${host}:${port}`}`);
      const method = req.method || 'GET';
      const pathname = url.pathname;

      if (method === 'GET' && pathname === '/api/health') {
        return send(res, 200, { ok: true, schema: 'server-health/v2', logger: runtime.logger.getHealth(), projects: runtime.registryStore.listIds().length });
      }
      if (method === 'GET' && pathname === '/api/state') {
        const settings = runtime.settingsStore.readPublicView();
        return send(res, 200, { ok: true, schema: 'server-state/v2', settings, projects: listProjectViews(runtime.registryStore, runtime.projectStore), logger: runtime.logger.getHealth() });
      }
      if (method === 'GET' && pathname === '/api/settings') return send(res, 200, { ok: true, settings: runtime.settingsStore.readPublicView() });
      if (method === 'PATCH' && pathname === '/api/settings') {
        const body = await readJsonBody(req);
        const patch = {};
        if (body.knowledge) patch.knowledge = { rootPath: String(body.knowledge.rootPath || '') };
        if (body.logging) throw new DomainError('IMMUTABLE_FIELD', 'Logging storage and capture policy are not user settings.', { status: 409 });
        if (!Object.keys(patch).length) throw new DomainError('INVALID_ARGUMENT', 'Only the knowledge root is mutable on this route.');
        const settings = await runtime.settingsStore.updatePatch(patch);
        return send(res, 200, { ok: true, settings: { ...settings, ai: publicAiProfilesConfig(settings.ai) } });
      }

      if (method === 'GET' && pathname === '/api/projects') return send(res, 200, { ok: true, projects: listProjectViews(runtime.registryStore, runtime.projectStore) });
      if (method === 'POST' && pathname === '/api/projects/import') {
        const body = await readJsonBody(req);
        const result = await runtime.lifecycleService.importProject(body);
        await runtime.projectStore.updateState(result.projectId, state => {
          state.hook.managedVersion = Number(result.hook.managedVersion || 2);
          state.hook.migrationVersion = 2;
          state.hook.lastVerifiedAt = new Date().toISOString();
        });
        return send(res, 201, { ...result, project: projectPublicView(result.projectId, runtime.projectStore) });
      }
      const projectMatch = pathname.match(/^\/api\/projects\/([^/]+)$/);
      if (projectMatch && method === 'GET') {
        const projectId = validateProjectId(decodeURIComponent(projectMatch[1]));
        if (!runtime.registryStore.readDisplaySnapshot(projectId)) throw new DomainError('PROJECT_NOT_FOUND', 'Project was not found.', { status: 404 });
        return send(res, 200, { ok: true, project: projectPublicView(projectId, runtime.projectStore) });
      }
      if (projectMatch && method === 'PATCH') {
        const projectId = validateProjectId(decodeURIComponent(projectMatch[1]));
        if (!runtime.registryStore.readDisplaySnapshot(projectId)) throw new DomainError('PROJECT_NOT_FOUND', 'Project was not found.', { status: 404 });
        const patch = await readJsonBody(req);
        if (Object.prototype.hasOwnProperty.call(patch, 'displayName') && (typeof patch.displayName !== 'string' || !patch.displayName.trim() || patch.displayName.length > 200)) {
          throw new DomainError('INVALID_ARGUMENT', 'displayName must be a non-empty string of at most 200 characters.');
        }
        if (Object.prototype.hasOwnProperty.call(patch, 'enabled') && typeof patch.enabled !== 'boolean') {
          throw new DomainError('INVALID_ARGUMENT', 'enabled must be a boolean.');
        }
        if (Object.prototype.hasOwnProperty.call(patch, 'knowledgeLanguage') && !['zh-CN', 'en-US'].includes(patch.knowledgeLanguage)) {
          throw new DomainError('INVALID_ARGUMENT', 'knowledgeLanguage must be zh-CN or en-US.');
        }
        if (Object.prototype.hasOwnProperty.call(patch, 'relatedProjectIds')) {
          if (!Array.isArray(patch.relatedProjectIds)) throw new DomainError('INVALID_ARGUMENT', 'relatedProjectIds must be an array.');
          patch.relatedProjectIds = [...new Set(patch.relatedProjectIds.map(validateProjectId))];
          if (patch.relatedProjectIds.includes(projectId)) throw new DomainError('INVALID_ARGUMENT', 'A project cannot relate to itself.');
          for (const relatedId of patch.relatedProjectIds) {
            if (!runtime.registryStore.readDisplaySnapshot(relatedId)) throw new DomainError('PROJECT_NOT_FOUND', 'A related project was not found.', { status: 404, details: { projectId: relatedId } });
          }
        }
        if (patch.aiProfileId) {
          const profile = profileById(runtime.settingsStore.read(), patch.aiProfileId);
          if (!profile || profile.enabled === false) throw new DomainError('INVALID_ARGUMENT', 'aiProfileId must reference an enabled profile.');
        }
        const config = await runtime.projectStore.updateConfig(projectId, patch);
        return send(res, 200, { ok: true, projectId, config });
      }
      if (projectMatch && method === 'DELETE') {
        const projectId = validateProjectId(decodeURIComponent(projectMatch[1]));
        if (!runtime.registryStore.readDisplaySnapshot(projectId)) throw new DomainError('PROJECT_NOT_FOUND', 'Project was not found.', { status: 404 });
        const body = await readJsonBody(req);
        const result = await runtime.lifecycleService.deleteProject(projectId, {
          deleteKnowledge: body.deleteKnowledge === true,
          confirmationToken: body.confirmationToken || '',
        });
        return send(res, 200, result);
      }
      const gitStatusMatch = pathname.match(/^\/api\/projects\/([^/]+)\/git-status$/);
      if (gitStatusMatch && method === 'GET') {
        const projectId = validateProjectId(decodeURIComponent(gitStatusMatch[1]));
        if (!runtime.registryStore.readDisplaySnapshot(projectId)) throw new DomainError('PROJECT_NOT_FOUND', 'Project was not found.', { status: 404 });
        const config = runtime.projectStore.readConfig(projectId);
        return send(res, 200, { ok: true, projectId, ...(await inspectGitRepository(config.repoPath)) });
      }
      const contextPackMatch = pathname.match(/^\/api\/projects\/([^/]+)\/context-pack$/);
      if (contextPackMatch && method === 'POST') {
        const projectId = validateProjectId(decodeURIComponent(contextPackMatch[1]));
        if (!runtime.registryStore.readDisplaySnapshot(projectId)) throw new DomainError('PROJECT_NOT_FOUND', 'Project was not found.', { status: 404 });
        const body = await readJsonBody(req);
        const config = runtime.projectStore.readConfig(projectId);
        const trigger = body.trigger === 'commits' ? 'commits' : 'initial';
        const commits = Array.isArray(body.commits) ? body.commits.slice(0, 200).map(commit => ({
          hash: String(commit.hash || ''), short: String(commit.short || ''), subject: String(commit.subject || ''),
          date: String(commit.date || ''), author: String(commit.author || ''),
        })).filter(commit => /^[a-f0-9]{7,64}$/i.test(commit.hash)) : [];
        const pack = await buildContextPack({
          project: {
            slug: projectId, gitPath: config.repoPath, kbPath: config.knowledgePath,
            currentBranch: body.currentBranch || '', defaultBranch: body.defaultBranch || '', remoteUrl: body.remoteUrl || '',
          },
          runId: body.runId,
          trigger,
          commits,
          options: { maxFiles: body.maxFiles, outputDir: runtime.layout.getCachePath('context-packs', projectId) },
        });
        return send(res, 200, { ok: true, projectId, runId: pack.runId, entryCount: pack.entries.length, contextPack: pack });
      }

      if (method === 'POST' && (pathname === '/api/knowledge/search' || pathname === '/api/knowledge/ask')) {
        const body = await readJsonBody(req);
        const input = { projectId: body.projectId, projectSlug: body.projectSlug, repoPath: body.repoPath, query: body.query, limit: body.limit };
        const result = pathname.endsWith('/ask') ? await runtime.knowledgeRuntime.ask(input) : await runtime.knowledgeRuntime.search(input);
        return send(res, 200, result);
      }
      if (method === 'GET' && pathname === '/api/knowledge/entry') {
        const result = await runtime.knowledgeRuntime.get({
          projectId: url.searchParams.get('projectId') || '',
          projectSlug: url.searchParams.get('projectSlug') || '',
          repoPath: url.searchParams.get('repoPath') || '',
          entryId: url.searchParams.get('entryId') || '',
        });
        return send(res, 200, result);
      }
      if (method === 'GET' && pathname === '/api/knowledge/history') {
        const result = await runtime.knowledgeRuntime.history({
          projectId: url.searchParams.get('projectId') || '',
          projectSlug: url.searchParams.get('projectSlug') || '',
          repoPath: url.searchParams.get('repoPath') || '',
          limit: url.searchParams.get('limit') || undefined,
        });
        return send(res, 200, result);
      }
      if (method === 'GET' && pathname === '/api/knowledge/maintenance') {
        const projects = runtime.registryStore.listIds().map(projectId => ({ projectId, index: runtime.projectStore.readState(projectId).index }));
        return send(res, 200, { ok: true, schema: 'index-maintenance/v2', indexPath: runtime.layout.getIndexPath(), projects, active: runtime.indexService.pending.size > 0 });
      }
      if (method === 'POST' && pathname === '/api/knowledge/maintenance/rebuild') {
        const operationId = createId('op');
        await runtime.knowledgeRuntime.close();
        await runtime.indexAdapter.close();
        const result = await runtime.indexService.fullRebuild({ operationId });
        for (const projectId of runtime.registryStore.listIds()) {
          await runtime.projectStore.updateState(projectId, state => {
            state.index.dirty = false;
            state.index.sinceCommit = null;
            state.index.lastError = null;
            state.index.lastIndexedAt = new Date().toISOString();
          });
        }
        await runtime.logger.info('index.full_rebuild_completed', 'Derived knowledge index was rebuilt.', { operationId, phase: 'index.applied', context: { validation: result.validation } });
        return send(res, 200, result);
      }

      if (method === 'POST' && pathname === '/api/hooks/post-commit') {
        const event = await readJsonBody(req, 256 * 1024);
        if (event.schema !== SCHEMAS.hookEvent) throw new DomainError('SCHEMA_UNSUPPORTED', 'Hook event must use hook-event/v2.', { status: 409 });
        const projectId = validateProjectId(event.projectId);
        if (!runtime.registryStore.readDisplaySnapshot(projectId)) throw new DomainError('PROJECT_NOT_FOUND', 'Hook project was not found.', { status: 404 });
        if (typeof event.repoRoot !== 'string' || !event.repoRoot.trim()) throw new DomainError('INVALID_ARGUMENT', 'Hook event repoRoot is required.');
        const operationId = /^op-[A-Za-z0-9-]{8,120}$/.test(String(event.operationId || ''))
          ? event.operationId
          : requestOperationId;
        taskForProject(runtime, projectId, operationId, () => handlePostCommitEvent(event, {
          layout: runtime.layout,
          registryStore: runtime.registryStore,
          projectStore: runtime.projectStore,
          reconciler: runtime.reconciler,
          claimProcessor: runtime.promotionService,
          logger: runtime.logger,
        }), 'git-hook');
        await runtime.logger.info('hook.event_accepted', 'Hook event accepted for background reconciliation.', { projectId, operationId, phase: 'accepted' });
        return send(res, 202, { ok: true, accepted: true, projectId, operationId });
      }

      if (method === 'GET' && pathname === '/api/ai-profiles') {
        const settings = runtime.settingsStore.read();
        return send(res, 200, { ok: true, config: publicAiProfilesConfig(settings.ai) });
      }
      if (method === 'PUT' && pathname === '/api/ai-profiles') {
        const body = await readJsonBody(req);
        const current = runtime.settingsStore.read();
        const ai = mergeAiProfiles(current.ai, body);
        await runtime.settingsStore.updatePatch({ ai });
        return send(res, 200, { ok: true, config: publicAiProfilesConfig(ai) });
      }

      if (method === 'GET' && pathname === '/api/logs') {
        const result = runtime.logRepository.query({
          from: url.searchParams.get('from') || '',
          to: url.searchParams.get('to') || '',
          levels: url.searchParams.get('levels') || '',
          projectId: url.searchParams.get('projectId') || '',
          component: url.searchParams.get('component') || '',
          event: url.searchParams.get('event') || '',
          commitSha: url.searchParams.get('commitSha') || '',
          operationId: url.searchParams.get('operationId') || '',
          q: url.searchParams.get('q') || '',
          cursor: url.searchParams.get('cursor') || '',
          pageSize: Number(url.searchParams.get('pageSize') || 100),
        });
        return send(res, 200, { ok: true, ...result, health: runtime.logger.getHealth() });
      }
      if (method === 'GET' && pathname === '/api/logs/export') {
        const output = runtime.layout.getCachePath('exports', `${requestOperationId}.jsonl`);
        const result = runtime.logRepository.exportToFile(output, {
          from: url.searchParams.get('from') || '', to: url.searchParams.get('to') || '',
          levels: url.searchParams.get('levels') || '', projectId: url.searchParams.get('projectId') || '',
          component: url.searchParams.get('component') || '', event: url.searchParams.get('event') || '',
          commitSha: url.searchParams.get('commitSha') || '', operationId: url.searchParams.get('operationId') || '',
          q: url.searchParams.get('q') || '',
        });
        const payload = fs.readFileSync(result.filePath);
        fs.rmSync(result.filePath, { force: true });
        res.setHeader('Content-Disposition', `attachment; filename="project-knowledge-logs-${new Date().toISOString().slice(0, 10)}.jsonl"`);
        return send(res, 200, payload, 'application/x-ndjson; charset=utf-8');
      }

      if (method === 'POST' && pathname === '/api/claude/sessions') {
        const body = await readJsonBody(req);
        const projectId = validateProjectId(body.projectId);
        if (!runtime.registryStore.readDisplaySnapshot(projectId)) throw new DomainError('PROJECT_NOT_FOUND', 'Project was not found.', { status: 404 });
        const config = runtime.projectStore.readConfig(projectId);
        const settings = runtime.settingsStore.read();
        const profileId = config.aiProfileId || settings.ai.defaultProfileId;
        const profile = profileById(settings, profileId);
        if (!profile || profile.enabled === false) throw new DomainError('INVALID_ARGUMENT', 'A usable AI profile is required.', { status: 409 });
        const result = claudeCliRunner.startChatSession({ slug: projectId, projectPath: config.repoPath, kbPath: config.knowledgePath, aiProfile: profile, permissionMode: body.permissionMode });
        return send(res, 201, { ok: true, projectId, ...result });
      }
      if (method === 'GET' && pathname === '/api/claude/sessions') {
        const projectId = url.searchParams.get('projectId') || '';
        if (projectId) validateProjectId(projectId);
        return send(res, 200, { ok: true, sessions: listClaudeSessions(runtime, projectId) });
      }
      if (method === 'GET' && pathname === '/api/claude/sessions-stream') {
        return streamSse(res, write => {
          write({ type: 'claude/snapshot', sessions: listClaudeSessions(runtime) });
          return claudeCliRunner.subscribeList(event => write({ type: 'claude/sessions-changed', ...event }));
        });
      }
      const sessionMatch = pathname.match(/^\/api\/claude\/sessions\/([^/]+)(?:\/(events|input|permission|abort))?$/);
      if (sessionMatch) {
        const sessionId = decodeURIComponent(sessionMatch[1]);
        const action = sessionMatch[2] || '';
        const session = claudeCliRunner.getSession(sessionId);
        if (!session) throw new DomainError('PROJECT_NOT_FOUND', 'Claude session was not found.', { status: 404 });
        if (method === 'GET' && !action) return send(res, 200, { ok: true, session: claudeCliRunner.getState(sessionId) });
        if (method === 'GET' && action === 'events') return streamSse(res, write => claudeCliRunner.subscribe(sessionId, write));
        if (method === 'POST' && action === 'input') {
          const body = await readJsonBody(req);
          if (typeof body.text !== 'string' || !body.text.trim()) throw new DomainError('INVALID_ARGUMENT', 'text must be a non-empty string.');
          const config = runtime.projectStore.readConfig(session.projectSlug);
          const settings = runtime.settingsStore.read();
          const profile = profileById(settings, config.aiProfileId || settings.ai.defaultProfileId);
          const recorded = await recordEmbeddedClaudeInput({
            recorder: runtime.requirementRecorder,
            projectId: session.projectSlug,
            session,
            sessionId,
            text: body.text,
            explicitCommit: body.explicitCommit || null,
            operationId: requestOperationId,
            sendInput: text => claudeCliRunner.sendInput(sessionId, text, profile, { permissionMode: body.permissionMode }),
          });
          return send(res, 200, { ok: true, sessionId, requirementId: recorded.requirementId, requirementHash: recorded.requirementHash, ...recorded.result });
        }
        if (method === 'POST' && action === 'permission') {
          const body = await readJsonBody(req);
          const result = claudeCliRunner.resolvePermission(sessionId, body.requestId, body.decision);
          return send(res, 200, { ok: true, sessionId, ...result });
        }
        if (method === 'POST' && action === 'abort') {
          claudeCliRunner.abort(sessionId);
          return send(res, 200, { ok: true, sessionId });
        }
      }

      if (!pathname.startsWith('/api/') && method === 'GET') {
        const filePath = safeStaticFile(pathname);
        if (filePath && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
          return send(res, 200, fs.readFileSync(filePath), CONTENT_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream');
        }
      }
      return send(res, 404, { ok: false, error: { code: 'PROJECT_NOT_FOUND', message: 'Route not found.', operationId: requestOperationId, retryable: false, details: {} } });
    } catch (error) {
      requestFailed = true;
      const status = error instanceof DomainError ? error.status : 500;
      if (!error.operationId) error.operationId = requestOperationId;
      await runtime.logger.error('http.request_failed', 'HTTP request failed.', {
        operationId: requestOperationId,
        phase: 'request',
        error,
        context: { method: req.method, pathname: String(req.url || '').split('?')[0], status },
      });
      if (res.headersSent) {
        res.destroy(error);
        return;
      }
      return send(res, status, serializeErrorEnvelope(error, requestOperationId));
    }
  };
}

async function startServer(options = {}) {
  const runtime = options.runtime || createRuntime(options);
  const port = parsePort(options.port || process.env.KB_SITE_PORT);
  const host = String(options.host || process.env.KB_SITE_HOST || '127.0.0.1');
  let endpointClaimed = false;
  if (isLoopback(host)) {
    const claim = runtimeEndpoint.claimEndpoint(runtime.dataPath, { pid: process.pid, host, port, mode: process.env.KB_RUNTIME_MODE || 'cli' });
    const alreadyOwned = !claim.claimed && claim.endpoint && claim.endpoint.pid === process.pid
      && claim.endpoint.host === host && claim.endpoint.port === port;
    if (!claim.claimed && !alreadyOwned) throw new DomainError('PROJECT_BUSY', 'Another Project Knowledge server owns this data directory.', { status: 409, retryable: true });
    endpointClaimed = claim.claimed;
  }
  let startup;
  let server;
  try {
    startup = await initializeRuntime(runtime);
    const handler = createRequestHandler(runtime, { ...options, port, host });
    server = http.createServer(handler);
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, resolve);
    });
  } catch (error) {
    if (endpointClaimed) runtimeEndpoint.clearEndpoint(runtime.dataPath, { pid: process.pid });
    throw error;
  }
  await runtime.logger.info('server.listening', 'Project Knowledge server is listening.', { phase: 'running', context: { host, port } });

  const startupPromise = Promise.all([
    runtime.indexService.retryDirtyProjects(),
    ...runtime.registryStore.listIds().map(projectId => {
    const operationId = createId('op');
    return taskForProject(runtime, projectId, operationId, () => reconcileProjectCommits(projectId, 'startup', { reconciler: runtime.reconciler, operationId }), 'startup');
    }),
  ]).catch(error => runtime.logger.error('reconcile.startup_failed', 'Startup recovery failed.', { error }));

  const maintenanceTimer = setInterval(() => {
    runtime.indexService.retryDirtyProjects().catch(error => runtime.logger.error('index.retry_failed', 'Index retry failed.', { error }));
  }, Number(process.env.KB_MAINTENANCE_INTERVAL_MS || 60 * 60 * 1000));
  maintenanceTimer.unref?.();

  let stopping = null;
  const stop = async reason => {
    if (stopping) return stopping;
    stopping = (async () => {
      clearInterval(maintenanceTimer);
      await runtime.logger.info('server.shutdown_started', 'Server shutdown started.', { phase: 'shutdown', context: { reason } });
      const forceConnections = setTimeout(() => server.closeAllConnections?.(), Number(process.env.KB_SERVER_CLOSE_GRACE_MS || 2000));
      await new Promise(resolve => server.close(resolve));
      clearTimeout(forceConnections);
      const drainTimeoutMs = Number(process.env.KB_SHUTDOWN_DRAIN_TIMEOUT_MS || 30000);
      let drainTimer;
      const drained = await Promise.race([
        Promise.allSettled(activeTaskPromises(runtime.activeTasks).concat(IndexService.flush())).then(() => true),
        new Promise(resolve => { drainTimer = setTimeout(() => resolve(false), drainTimeoutMs); }),
      ]);
      clearTimeout(drainTimer);
      if (!drained) await runtime.logger.warn('server.shutdown_drain_timeout', 'Server shutdown timed out waiting for background work.', { phase: 'shutdown', context: { drainTimeoutMs } });
      await runtime.knowledgeRuntime.close();
      await runtime.indexAdapter.close();
      await runtime.logger.close();
      runtimeEndpoint.clearEndpoint(runtime.dataPath, { pid: process.pid });
    })();
    return stopping;
  };
  return { server, runtime, startup, startupPromise, stop, host, port };
}

function installProcessHandlers(instancePromise) {
  let terminating = false;
  const terminate = async (reason, error, exitCode) => {
    if (terminating) return;
    terminating = true;
    try {
      const instance = await instancePromise;
      if (error) await instance.runtime.logger.fatal('server.process_failure', 'A process-level failure stopped the server.', { phase: 'shutdown', error });
      await instance.stop(reason);
    } catch (shutdownError) {
      try { process.stderr.write(`[project-knowledge] shutdown failed: ${String(shutdownError && shutdownError.message || shutdownError)}\n`); } catch {
        // stderr is the final fallback after the structured logger could not shut down.
      }
    }
    process.exitCode = exitCode;
  };
  process.once('SIGINT', () => terminate('SIGINT', null, 0));
  process.once('SIGTERM', () => terminate('SIGTERM', null, 0));
  process.once('uncaughtException', error => terminate('uncaughtException', error, 1));
  process.once('unhandledRejection', error => terminate('unhandledRejection', error instanceof Error ? error : new Error(String(error)), 1));
}

module.exports = {
  RuntimeIndexAdapter,
  RuntimeKnowledgeAnalyzer,
  createRuntime,
  initializeRuntime,
  createRequestHandler,
  startServer,
  installProcessHandlers,
  mergeAiProfiles,
  requestOriginAllowed,
  isLoopback,
  isProjectBusy,
  taskForProject,
  activeTaskPromises,
};
