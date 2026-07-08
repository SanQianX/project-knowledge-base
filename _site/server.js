// KB management site server — zero npm deps (Node built-ins only).
// Run: node "D:\SanQian.Xu\project-knowledge-base\_site\server.js"
// Listens on http://localhost:5757  (override with KB_SITE_PORT env)

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, exec } = require('child_process');
const { getAdapter, listAdapters, validateCommitBatchOutput } = require('./lib/ai-adapter');
const { execGit } = require('./lib/git-runner');
const { buildContextPack } = require('./lib/context-pack-builder');
const { scanProject, applyScanResult } = require('./lib/scanner');
const { runCommitAnalysis, readRun, listRuns, listDrafts } = require('./lib/analysis-orchestrator');
const { applyDrafts, rejectDrafts, readDraftContent } = require('./lib/draft-apply');
const { runJob, makeJob, readJobLog, KNOWN_MODES } = require('./lib/job-orchestrator');
const { validateKb, buildPrContextPack } = require('./lib/kb-validator');
const { installHook, uninstallHook, readHookStatus } = require('./lib/hook-manager');
const { completeText, readConfig: readLlmConfig } = require('./lib/llm-client');
const claudeCliRunner = require('./lib/claude-cli-runner');
const promptRegistry = require('./lib/prompt-registry');
const knowledgeStore = require('./lib/knowledge-store');
const structuredLogger = require('./lib/structured-logger');
const supervision = require('./lib/supervision');
const aiWorkspace = require('./lib/ai-workspace');
const githubTeamStore = require('./lib/github-team-store');
const { AI_VENDOR_PRESETS, listVendorPresetNames } = require('./lib/ai-vendor-presets');
const kbFramework = require('./lib/kb-framework');
const {
  normalizeAutomationConfig,
  normalizeClaudeWorkbenchConfig,
  pathsReferToSameLocation,
} = require('./lib/automation-config');
const postCommitAutomation = require('./lib/post-commit-automation');

const KB_ROOT = path.resolve(__dirname, '..');
const SITE_ROOT = __dirname;
const dataDir = require('./lib/data-dir');
const PORT = parseInt(process.env.KB_SITE_PORT || '5757', 10);
const HOST = process.env.KB_SITE_HOST || '127.0.0.1';
const TASK_NAME = 'KB-GitCommits-Daily';
const SAFE_RUNNER = path.join(SITE_ROOT, 'scripts', 'safe-runner.js');
const PROJECT_SCHEMA_VERSION = kbFramework.PROJECT_SCHEMA_VERSION;
const DEFAULT_KNOWLEDGE_LANGUAGE = 'zh-CN';

// One-time migration from the legacy 1.x location (the npm package root)
// into the new version-independent data dir (~/.project-knowledge/). Runs
// silently before any user data file is read or written.
dataDir.migrateFromLegacy({
  legacyRoot: KB_ROOT,
  logger: (msg) => console.log(`[data-dir] ${msg}`),
});
const DATA_DIR = dataDir.getDataDir();
const PROJECTS_PATH = path.join(DATA_DIR, 'projects.json');
const REMOVED_PROJECTS_PATH = path.join(DATA_DIR, 'removed-projects.json');
const AI_PROFILES_PATH = path.join(DATA_DIR, 'ai-profiles.json');
const JOBS_LOG_PATH = path.join(DATA_DIR, '.jobs-log.json');
const KNOWLEDGE_STORE_PATH = path.join(DATA_DIR, 'knowledge-store.json');
const LOGGING_CONFIG_PATH = path.join(DATA_DIR, 'logging.json');
const CLAUDE_PROMPTS_PATH = path.join(DATA_DIR, 'claude-prompts.json');
const HOOK_ERROR_LOG_PATH = path.join(DATA_DIR, '.hook-trigger-errors.log');
const GITHUB_TEAM_PATH = path.join(DATA_DIR, 'github-team.json');
const TEAM_GIT_PROVIDERS_PATH = path.join(DATA_DIR, 'team-git-providers.json');
const TEAM_STORES_CACHE_PATH = path.join(DATA_DIR, 'team-stores-cache.json');

// ---- state ----
let lastRun = { time: null, status: null, slug: null, output: '' };
const runningJobs = new Map();
const giteaOAuthStates = new Map();

// Read a fresh copy of projects.json (re-loaded on every dispatch so that
// background jobs see the latest registry state).
function readProjectsForJob() {
  return readProjects({ persistMigrations: true });
}

function readTeamGitProvidersConfig() {
  return githubTeamStore.readProviderFileConfig(TEAM_GIT_PROVIDERS_PATH);
}

function defaultTeamStoresCache() {
  return {
    schema: 'project-knowledge/team-stores-cache/v1',
    provider: '',
    apiBaseUrl: '',
    login: '',
    updatedAt: '',
    scannedRepoCount: 0,
    stores: [],
  };
}

function readTeamStoresCache() {
  return readJsonOrDefault(TEAM_STORES_CACHE_PATH, defaultTeamStoresCache(), { persistDefault: false, backupInvalid: false });
}

function writeTeamStoresCache(cfg, result) {
  const cache = {
    schema: 'project-knowledge/team-stores-cache/v1',
    provider: githubTeamStore.normalizeProvider(cfg.provider),
    apiBaseUrl: String(cfg.apiBaseUrl || ''),
    login: String(cfg.login || ''),
    updatedAt: new Date().toISOString(),
    scannedRepoCount: Number(result && result.scannedRepoCount || 0),
    stores: Array.isArray(result && result.stores) ? result.stores : [],
  };
  writeJson(TEAM_STORES_CACHE_PATH, cache);
  return cache;
}

function clearTeamStoresCache() {
  try { fs.rmSync(TEAM_STORES_CACHE_PATH, { force: true }); } catch {}
}

function teamStoresCacheMatches(cfg, cache) {
  if (!cache || typeof cache !== 'object') return false;
  if (!Array.isArray(cache.stores)) return false;
  return githubTeamStore.normalizeProvider(cache.provider) === githubTeamStore.normalizeProvider(cfg.provider)
    && String(cache.apiBaseUrl || '') === String(cfg.apiBaseUrl || '')
    && String(cache.login || '') === String(cfg.login || '');
}

function publicTeamStoresCache(cfg) {
  const cache = readTeamStoresCache();
  if (!teamStoresCacheMatches(cfg, cache)) return null;
  return {
    updatedAt: cache.updatedAt || '',
    scannedRepoCount: Number(cache.scannedRepoCount || 0),
    stores: Array.isArray(cache.stores) ? cache.stores : [],
  };
}

function buildGiteaOAuthRedirectUri() {
  const explicit = String(process.env.KB_GITEA_OAUTH_REDIRECT_URI || process.env.GITEA_OAUTH_REDIRECT_URI || '').trim();
  if (explicit) return explicit;
  const callbackHost = String(process.env.KB_GITEA_OAUTH_CALLBACK_HOST || HOST || '127.0.0.1').trim();
  const safeHost = (!callbackHost || callbackHost === '0.0.0.0' || callbackHost === '::') ? '127.0.0.1' : callbackHost;
  const bracketedHost = safeHost.includes(':') && !safeHost.startsWith('[') ? `[${safeHost}]` : safeHost;
  return `http://${bracketedHost}:${PORT}/api/team/gitea/oauth/callback`;
}

// ---- helpers ----
function send(res, status, body, type) {
  type = type || 'application/json';
  const text = typeof body === 'string' ? body : JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'Content-Type': type + '; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', 'utf-8');
}

function backupInvalidJson(filePath, raw) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = `${filePath}.invalid-${stamp}.bak`;
  try {
    fs.writeFileSync(backupPath, raw, 'utf-8');
  } catch {}
  return backupPath;
}

function readJsonOrDefault(filePath, defaultValue, options = {}) {
  const { persistDefault = true, backupInvalid = true } = options;
  let raw = '';
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch (error) {
    if (error && error.code !== 'ENOENT') throw error;
    if (persistDefault) writeJson(filePath, defaultValue);
    return defaultValue;
  }
  if (!raw.trim()) {
    if (persistDefault) writeJson(filePath, defaultValue);
    return defaultValue;
  }
  try {
    return JSON.parse(raw);
  } catch {
    const backupPath = backupInvalid ? backupInvalidJson(filePath, raw) : '';
    if (persistDefault) writeJson(filePath, defaultValue);
    console.warn(`[project-knowledge] Recovered invalid JSON at ${filePath}${backupPath ? `; backup: ${backupPath}` : ''}`);
    return defaultValue;
  }
}

function isSafeSlug(s) { return typeof s === 'string' && /^[a-z0-9][a-z0-9-]{0,40}$/.test(s); }

function normalizeKnowledgeLanguage(value) {
  return value === 'en-US' ? 'en-US' : DEFAULT_KNOWLEDGE_LANGUAGE;
}

function defaultProjectKbPath(slug) {
  return knowledgeStore.defaultProjectKbPath(slug, KNOWLEDGE_STORE_PATH, DATA_DIR);
}

function readKnowledgeStore() {
  return knowledgeStore.readConfig(KNOWLEDGE_STORE_PATH, DATA_DIR);
}

function readGithubTeamConfig() {
  return githubTeamStore.readConfig(GITHUB_TEAM_PATH);
}

function writeGithubTeamConfig(config) {
  return githubTeamStore.writeConfig(GITHUB_TEAM_PATH, config);
}

function readLoggingConfig() {
  return structuredLogger.readConfig(LOGGING_CONFIG_PATH, DATA_DIR);
}

function logEvent(level, event, message, meta = {}) {
  try {
    structuredLogger.appendLog(LOGGING_CONFIG_PATH, DATA_DIR, {
      level,
      event,
      message,
      projectSlug: meta.projectSlug || meta.slug || '',
      source: meta.source || 'server',
      jobId: meta.jobId || '',
      runId: meta.runId || '',
      meta,
    });
  } catch {}
}

function isLegacyKbPath(value) {
  return typeof value === 'string' && /[\\/]SanQian\.Xu[\\/]kb[\\/]projects[\\/]/i.test(value);
}

// ---- AI profiles (TASK-005) ----
function defaultAiProfilesConfig() {
  return { schema: 'ai-profiles/v1', profiles: [] };
}

function readAiProfiles() {
  return readJsonOrDefault(AI_PROFILES_PATH, defaultAiProfilesConfig(), {
    persistDefault: true,
    backupInvalid: true,
  });
}

function writeAiProfiles(cfg) {
  writeJson(AI_PROFILES_PATH, cfg);
}

function findAiProfile(profileId, cfg = readAiProfiles()) {
  return (cfg.profiles || []).find(item => item && item.id === profileId) || null;
}

function profileImplementation(profile) {
  return profile && (profile.implementation || profile.id);
}

function profileModel(profile) {
  return profile && String(profile.mainModel || profile.model || '').trim();
}

function hasUsableAiProfile(cfg = readAiProfiles()) {
  return (cfg.profiles || []).some(profile => {
    if (!profile || profile.enabled === false) return false;
    const implementation = profileImplementation(profile);
    if (!implementation || !getAdapter(implementation)) return false;
    return !!(profile.apiKey || profile.authToken || profile.anthropicAuthToken)
      && !!(profile.baseUrl || profile.apiBaseUrl || profile.anthropicBaseUrl)
      && !!profileModel(profile);
  });
}

function aiSetupState(cfg = readAiProfiles()) {
  const profiles = Array.isArray(cfg.profiles) ? cfg.profiles : [];
  const configured = hasUsableAiProfile(cfg);
  return {
    aiRequired: true,
    required: !configured,
    configured,
    profileCount: profiles.length,
    configPath: AI_PROFILES_PATH,
  };
}

function firstUsableAiProfileId(cfg = readAiProfiles()) {
  const profile = (cfg.profiles || []).find(item => hasUsableAiProfile({ schema: 'ai-profiles/v1', profiles: [item] }));
  return profile && profile.id || null;
}

function validateUsableAiProfile(profileId) {
  if (!profileId) return { ok: false, status: 400, error: 'aiProfileId required' };
  const profile = findAiProfile(profileId);
  if (!profile) return { ok: false, status: 400, error: `AI profile not configured: ${profileId}` };
  const implementation = profileImplementation(profile);
  const adapter = getAdapter(implementation);
  if (!adapter) return { ok: false, status: 400, error: `unknown adapter: ${implementation}` };
  if (profile.enabled === false) return { ok: false, status: 400, error: `AI profile disabled: ${profileId}` };
  return { ok: true, profile, implementation, adapter };
}

async function testClaudeCodeAgentProfile(profile, profileId, prompt = 'what model are you?') {
  const env = claudeCliRunner.buildClaudeEnvFromProfile(profile);
  const apiKey = env.ANTHROPIC_AUTH_TOKEN || '';
  const model = env.ANTHROPIC_MODEL || '';
  if (!apiKey) {
    return { ok: false, status: 400, error: `API key not set for profile ${profileId}` };
  }
  if (!model) {
    return { ok: false, status: 400, error: `main model not set for profile ${profileId}` };
  }
  const result = await completeText({
    profile,
    profileId,
    user: prompt,
    maxTokens: 64,
  });
  return {
    ok: true,
    status: 200,
    profileId,
    implementation: 'claude-code-agent',
    mode: 'live-model-call',
    model: result.model || model,
    baseUrl: env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
    text: result.text,
    usage: result.usage || null,
  };
}

function validateProfileConfig(cfg) {
  const errors = [];
  if (!cfg || typeof cfg !== 'object') return ['not an object'];
  if (cfg.schema !== 'ai-profiles/v1') errors.push('schema must be ai-profiles/v1');
  if (!Array.isArray(cfg.profiles)) { errors.push('profiles must be an array'); return errors; }
  const ids = new Set();
  for (let i = 0; i < cfg.profiles.length; i++) {
    const p = cfg.profiles[i];
    if (!p.id) { errors.push(`profiles[${i}] missing id`); continue; }
    if (ids.has(p.id)) errors.push(`duplicate id: ${p.id}`);
    ids.add(p.id);
    const implementation = profileImplementation(p);
    if (!implementation || typeof implementation !== 'string') errors.push(`profiles[${i}].implementation must be a string`);
    else if (!getAdapter(implementation)) errors.push(`unknown adapter implementation: ${implementation}`);
    if (p.baseUrl && typeof p.baseUrl !== 'string') errors.push(`profiles[${i}].baseUrl must be a string`);
    if (p.apiKey && typeof p.apiKey !== 'string') errors.push(`profiles[${i}].apiKey must be a string`);
    // CC-Switch-style per-tier model fields. Each is an optional string;
    // the runner falls back to mainModel (or profile.model for legacy
    // entries) when a slot is empty.
    for (const slot of ['mainModel', 'model', 'thinkingModel', 'haikuModel', 'sonnetModel', 'opusModel']) {
      if (p[slot] != null && typeof p[slot] !== 'string') errors.push(`profiles[${i}].${slot} must be a string`);
    }
    if (p.provider && typeof p.provider !== 'string') errors.push(`profiles[${i}].provider must be a string`);
    if (p.notes && typeof p.notes !== 'string') errors.push(`profiles[${i}].notes must be a string`);
    if (p.website && typeof p.website !== 'string') errors.push(`profiles[${i}].website must be a string`);
    if (p.timeoutMs != null && (!Number.isInteger(p.timeoutMs) || p.timeoutMs < 1000)) errors.push(`profiles[${i}].timeoutMs must be an integer >= 1000`);
  }
  return errors;
}

function normalizeProjectConfig(slug, input, options = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const before = JSON.stringify(source);
  const cfg = { ...source };
  const defaultAiProfileId = options.defaultAiProfileId || null;

  cfg.displayName = cfg.displayName || slug;
  cfg.localPath = cfg.localPath || '';
  cfg.gitPath = cfg.gitPath || cfg.localPath;
  cfg.isReference = !!cfg.isReference;
  cfg.primaryLanguage = cfg.primaryLanguage || '';
  cfg.docConvention = cfg.docConvention || 'frontmatter-relations';

  if (!Array.isArray(cfg.tags)) {
    cfg.tags = typeof cfg.tags === 'string'
      ? cfg.tags.split(',').map(s => s.trim()).filter(Boolean)
      : [];
  }

  if (!cfg.kbPath || isLegacyKbPath(cfg.kbPath)) {
    cfg.kbPath = defaultProjectKbPath(slug);
  }

  if (cfg.enabled == null) cfg.enabled = true;
  if (!cfg.repoStatus) cfg.repoStatus = 'unknown';
  if (!Object.prototype.hasOwnProperty.call(cfg, 'headCommit')) cfg.headCommit = null;
  if (!Object.prototype.hasOwnProperty.call(cfg, 'lastSeenCommit')) cfg.lastSeenCommit = null;
  if (!Object.prototype.hasOwnProperty.call(cfg, 'lastAnalyzedCommit')) cfg.lastAnalyzedCommit = null;
  if (!Object.prototype.hasOwnProperty.call(cfg, 'trackingStartCommit')) cfg.trackingStartCommit = null;
  if (!Object.prototype.hasOwnProperty.call(cfg, 'trackingStartedAt')) cfg.trackingStartedAt = null;
  if (!cfg.aiProfileId) cfg.aiProfileId = defaultAiProfileId;
  cfg.knowledgeLanguage = normalizeKnowledgeLanguage(cfg.knowledgeLanguage);
  if (cfg.kbSchemaVersion !== PROJECT_SCHEMA_VERSION) cfg.kbSchemaVersion = PROJECT_SCHEMA_VERSION;
  if (!cfg.goalStatus) cfg.goalStatus = 'not-created';
  cfg.automation = normalizeAutomationConfig(cfg.automation);
  cfg.claudeWorkbench = normalizeClaudeWorkbenchConfig(cfg.claudeWorkbench);

  return { config: cfg, changed: JSON.stringify(cfg) !== before };
}

function normalizeProjects(rawProjects) {
  const out = {};
  let changed = false;
  const defaultAiProfileId = firstUsableAiProfileId();
  for (const slug of Object.keys(rawProjects || {})) {
    const result = normalizeProjectConfig(slug, rawProjects[slug], { defaultAiProfileId });
    out[slug] = result.config;
    changed = changed || result.changed;
  }
  return { projects: out, changed };
}

function normalizeSlugValue(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/['"]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 41)
    .replace(/-+$/g, '');
}

function uniqueProjectSlug(base, projects) {
  const fallback = `project-${Date.now().toString(36)}`;
  const root = normalizeSlugValue(base) || fallback;
  let candidate = root;
  let index = 2;
  while (projects && projects[candidate]) {
    const suffix = `-${index++}`;
    candidate = `${root.slice(0, Math.max(1, 41 - suffix.length))}${suffix}`;
  }
  return candidate;
}

function basenameFromPath(value) {
  return path.basename(path.resolve(String(value || '.'))) || '';
}

function normalizeTeamKnowledgeBinding(input) {
  if (!input || typeof input !== 'object') return null;
  const storeLocalPath = String(input.storeLocalPath || input.kbStorePath || '').trim();
  const kbSubdir = githubTeamStore.normalizeKbPath(input.kbSubdir || input.path || input.kbPath);
  if (!storeLocalPath || !kbSubdir) return { ok: false, error: 'teamKnowledgeBase.storeLocalPath and kbSubdir are required' };
  const resolvedStorePath = path.resolve(storeLocalPath);
  const resolvedKbPath = path.resolve(resolvedStorePath, kbSubdir);
  if (!knowledgeStore.isInside(resolvedKbPath, resolvedStorePath)) {
    return { ok: false, error: 'team knowledge base path must stay inside the selected store path' };
  }
  const kbSlug = String(input.kbSlug || input.slug || path.basename(kbSubdir)).trim() || path.basename(kbSubdir);
  const teamProvider = githubTeamStore.normalizeProvider(input.provider || input.teamProvider || 'github');
  return {
    ok: true,
    binding: {
      knowledgeMode: 'team',
      teamProvider,
      kbPath: resolvedKbPath,
      kbId: String(input.kbId || kbSlug),
      kbSlug,
      kbSubdir,
      kbDisplayName: String(input.displayName || input.kbDisplayName || kbSlug),
      kbStoreId: String(input.storeId || input.kbStoreId || ''),
      kbStoreFullName: String(input.storeFullName || input.fullName || ''),
      kbStoreRemoteUrl: String(input.storeRemoteUrl || input.kbStoreRemoteUrl || input.cloneUrl || ''),
      kbStoreBranch: String(input.branch || input.defaultBranch || 'main'),
      kbStorePath: resolvedStorePath,
      sourceProjectRemoteUrl: String(input.sourceProjectRemoteUrl || ''),
    },
  };
}

async function syncTeamKnowledgeStoreForImport(teamBinding) {
  if (!teamBinding) return { ok: true, skipped: true };
  const storePath = teamBinding.kbStorePath;
  const remoteUrl = String(teamBinding.kbStoreRemoteUrl || '').trim();
  const storeExists = fs.existsSync(storePath);

  if (!remoteUrl) {
    if (!storeExists) return { ok: false, status: 400, error: `team knowledge store path not found: ${storePath}` };
  } else if (storeExists) {
    if (!fs.statSync(storePath).isDirectory()) {
      return { ok: false, status: 400, error: `team knowledge store path is not a directory: ${storePath}` };
    }
    const storeInspection = await inspectGit(storePath);
    if (storeInspection.repoStatus === 'not-git') {
      if (!fs.existsSync(teamBinding.kbPath)) {
        return { ok: false, status: 400, error: `team knowledge store path exists but is not a git repository: ${storePath}` };
      }
      return { ok: true, skipped: true, reason: 'existing non-git team knowledge store' };
    }
    const cfg = readGithubTeamConfig();
    const checkout = await githubTeamStore.checkoutStore({
      cloneUrl: remoteUrl,
      branch: teamBinding.kbStoreBranch || 'main',
      localPath: storePath,
      token: cfg.token || '',
      provider: teamBinding.teamProvider || cfg.provider || 'github',
      username: cfg.login || '',
    });
    if (!checkout.ok) return { ok: false, status: checkout.status || 500, error: `failed to sync team knowledge store: ${checkout.error}` };
  } else {
    const cfg = readGithubTeamConfig();
    const checkout = await githubTeamStore.checkoutStore({
      cloneUrl: remoteUrl,
      branch: teamBinding.kbStoreBranch || 'main',
      localPath: storePath,
      token: cfg.token || '',
      provider: teamBinding.teamProvider || cfg.provider || 'github',
      username: cfg.login || '',
    });
    if (!checkout.ok) return { ok: false, status: checkout.status || 500, error: `failed to clone team knowledge store: ${checkout.error}` };
  }

  if (!fs.existsSync(teamBinding.kbPath) || !fs.statSync(teamBinding.kbPath).isDirectory()) {
    return { ok: false, status: 400, error: `selected team knowledge base path not found after sync: ${teamBinding.kbPath}` };
  }
  return { ok: true };
}

function defaultProjectAutomationConfig(input = {}) {
  return normalizeAutomationConfig({
    enabled: true,
    postCommitEnabled: true,
    knowledgeMode: 'autoApply',
    allowReadOnlyBash: true,
    ...(input || {}),
  });
}

function defaultClaudeWorkbenchConfig(input = {}) {
  return normalizeClaudeWorkbenchConfig({
    permissionMode: 'acceptEdits',
    ...(input || {}),
  });
}

function readProjects(options = {}) {
  const rawProjects = readJsonOrDefault(PROJECTS_PATH, {}, {
    persistDefault: true,
    backupInvalid: true,
  });
  const result = normalizeProjects(rawProjects);
  if (options.persistMigrations && result.changed) {
    writeJson(PROJECTS_PATH, result.projects);
  }
  return result.projects;
}

function readRemovedProjects() {
  const raw = readJsonOrDefault(REMOVED_PROJECTS_PATH, { schema: 'removed-projects/v1', projects: {} }, {
    persistDefault: false,
    backupInvalid: true,
  });
  if (raw && raw.projects && typeof raw.projects === 'object') return raw.projects;
  if (raw && typeof raw === 'object') return raw;
  return {};
}

function writeRemovedProjects(projects) {
  writeJson(REMOVED_PROJECTS_PATH, { schema: 'removed-projects/v1', projects: projects || {} });
}

function projectRepoPath(cfg) {
  return cfg && (cfg.gitPath || cfg.localPath || '');
}

function findRemovedProject({ slug = '', repoPath = '' } = {}) {
  const removed = readRemovedProjects();
  if (slug && removed[slug]) {
    const cfg = removed[slug] && (removed[slug].config || removed[slug]);
    const candidate = removed[slug].repoPath || projectRepoPath(cfg);
    if (!repoPath || !candidate || pathsReferToSameLocation(candidate, repoPath)) {
      return { slug, entry: removed[slug], removed };
    }
  }
  for (const [entrySlug, entry] of Object.entries(removed)) {
    const cfg = entry && (entry.config || entry);
    const candidate = entry.repoPath || projectRepoPath(cfg);
    if (candidate && repoPath && pathsReferToSameLocation(candidate, repoPath)) {
      return { slug: entrySlug, entry, removed };
    }
  }
  return null;
}

function rememberRemovedProject(slug, cfg, reason = '') {
  const removed = readRemovedProjects();
  const config = { ...(cfg || {}) };
  removed[slug] = {
    slug,
    repoPath: projectRepoPath(config),
    kbPath: config.kbPath || defaultProjectKbPath(slug),
    removedAt: new Date().toISOString(),
    reason,
    config,
  };
  writeRemovedProjects(removed);
  return removed[slug];
}

function forgetRemovedProject(slug) {
  const removed = readRemovedProjects();
  if (!removed[slug]) return false;
  delete removed[slug];
  writeRemovedProjects(removed);
  return true;
}

function mergeRecoveredProjectConfig(recoveredCfg, nextCfg = {}) {
  const recovered = recoveredCfg && typeof recoveredCfg === 'object' ? recoveredCfg : {};
  const next = nextCfg && typeof nextCfg === 'object' ? nextCfg : {};
  const merged = { ...recovered, ...next };
  for (const key of ['trackingStartCommit', 'trackingStartedAt', 'lastAnalyzedCommit', 'lastSeenCommit']) {
    if (next[key] == null && recovered[key] != null) merged[key] = recovered[key];
  }
  return merged;
}

function listSubTree(root, prefix, depth, max) {
  if (depth > max) return [];
  const out = [];
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith('.')) continue;
    if (entry.name === 'node_modules') continue;
    const rel = prefix + entry.name;
    if (entry.isDirectory()) {
      const children = listSubTree(path.join(root, entry.name), rel + '/', depth + 1, max);
      out.push({ type: 'dir', name: entry.name, path: rel, children });
    } else {
      let size = 0;
      try { size = fs.statSync(path.join(root, entry.name)).size; } catch {}
      out.push({ type: 'file', name: entry.name, path: rel, size });
    }
  }
  return out;
}

function dirStats(root) {
  const result = { fileCount: 0, kbSizeBytes: 0 };
  if (!root || !fs.existsSync(root)) return result;
  const walk = (dir) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        result.fileCount += 1;
        try { result.kbSizeBytes += fs.statSync(full).size; } catch {}
      }
    }
  };
  walk(root);
  return result;
}

function hasRunningProjectJob(slug) {
  for (const job of runningJobs.values()) {
    if (!job || job.status !== 'running') continue;
    if (job.slug === slug || job.slug === 'ALL') return true;
  }
  return false;
}

function allowedKbDeletionRootPaths() {
  const cfg = readKnowledgeStore();
  return [
    path.join(DATA_DIR, 'projects'),
    cfg.rootPath,
  ].filter(Boolean).map(p => path.resolve(p));
}

function validateKbDeletionPath(kbPath) {
  if (!kbPath || typeof kbPath !== 'string') return { ok: false, error: 'kbPath is required' };
  if (!path.isAbsolute(kbPath)) return { ok: false, error: 'kbPath must be absolute' };
  const resolved = path.resolve(kbPath);
  const roots = allowedKbDeletionRootPaths();
  for (const root of roots) {
    if (resolved !== root && knowledgeStore.isInside(resolved, root)) {
      return { ok: true, path: resolved, root };
    }
  }
  return { ok: false, path: resolved, error: 'kbPath is outside configured knowledge roots' };
}

function removeKnowledgeStoreProjectOverride(slug) {
  if (!fs.existsSync(KNOWLEDGE_STORE_PATH)) return;
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(KNOWLEDGE_STORE_PATH, 'utf-8')); } catch { return; }
  if (cfg && cfg.projectOverrides && Object.prototype.hasOwnProperty.call(cfg.projectOverrides, slug)) {
    delete cfg.projectOverrides[slug];
    writeJson(KNOWLEDGE_STORE_PATH, cfg);
  }
}

function projectRemovePreview(slug, cfg) {
  const kbPath = path.resolve(cfg.kbPath || defaultProjectKbPath(slug));
  const stats = dirStats(kbPath);
  const hook = readHookStatus({ repoPath: cfg.gitPath || cfg.localPath || '' });
  return {
    slug,
    displayName: cfg.displayName || slug,
    kbPath,
    kbExists: fs.existsSync(kbPath),
    kbSizeBytes: stats.kbSizeBytes,
    fileCount: stats.fileCount,
    hasRunningJobs: hasRunningProjectJob(slug),
    hookInstalled: hook.installed === true,
    kbManagedHook: hook.kbManaged === true,
    isReference: cfg.isReference === true,
  };
}

function shellEscape(s) {
  return '"' + String(s).replace(/"/g, '""').replace(/`/g, '``') + '"';
}

// ---- scanner (TASK-004): read-only commit range + state without invoking AI ----
// (scanProject and applyScanResult now live in ./lib/scanner.js so the analysis
// orchestrator can share the same code path.)

async function scanAndPersistProject(slug, projects, options = {}) {
  if (!projects[slug]) return { ok: false, status: 404, error: 'Slug not in projects.json' };
  const scan = await scanProject({ slug, ...projects[slug] }, options);
  applyScanResult(projects[slug], scan);
  writeJson(PROJECTS_PATH, projects);
  return { ok: true, slug, scan };
}

// ---- schedule (uses schtasks.exe directly to avoid PowerShell module load issues) ----
function schtasksQuery() {
  return new Promise((resolve) => {
    // Force UTF-8 console output by setting code page 65001 first.
    // The chcp message goes to stderr; the >nul redirects chcp's "Active code page" stdout message.
    const cmd = `chcp 65001 >nul 2>&1 & schtasks /query /tn "${TASK_NAME}" /v /fo list`;
    exec(cmd, { encoding: 'utf8', windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const msg = (stderr || '').toString().trim();
        if (/the system cannot find/i.test(msg) || /cannot find the specified file/i.test(msg) || /指定的文件|找不到/i.test(msg)) {
          return resolve({ registered: false, error: 'task not registered' });
        }
        return resolve({ registered: false, error: msg || err.message });
      }
      // Strip leading chcp echo line if present
      let text = stdout;
      const lines = text.split(/\r?\n/);
      if (lines.length && !/^\s*\S+:.+/.test(lines[0])) {
        lines.shift();
        text = lines.join('\n');
      }
      // Parse "Key: Value" lines
      const map = {};
      text.split(/\r?\n/).forEach(line => {
        const m = line.match(/^([^:]+):\s*(.*)$/);
        if (m) {
          const k = m[1].trim();
          const v = m[2].trim();
          if (k && v) map[k] = v;
        }
      });
      if (Object.keys(map).length === 0) return resolve({ registered: false, error: 'empty output', raw: stdout.slice(0, 500) });
      resolve({ registered: true, raw: map });
    });
  });
}

function getScheduleInfo() {
  return schtasksQuery().then(r => {
    if (!r.registered) return r;
    const m = r.raw;
    return {
      registered: true,
      hostName: m['HostName'] || m['主机名'] || '',
      taskName: m['TaskName'] || m['任务名称'] || TASK_NAME,
      nextRun: m['Next Run Time'] || m['下次运行时间'] || '',
      lastRun: m['Last Run Time'] || m['上次运行时间'] || '',
      lastResult: m['Last Result'] || m['上次结果'] || '',
      status: m['Status'] || m['状态'] || '',
      scheduleType: m['Schedule Type'] || m['计划类型'] || '',
      startTime: m['Start Time'] || m['开始时间'] || '',
      runAsUser: m['Run As User'] || m['以用户身份运行'] || '',
      raw: m,
    };
  });
}

function buildScheduleArgs(frequency, time, options = {}) {
  // Default to the safe-runner (scan + analyze-commits; never apply).
  const tr = `node "${SAFE_RUNNER}" --slug ALL`;
  switch (frequency) {
    case 'off':      return null;
    case 'hourly':   return ['/create', '/tn', TASK_NAME, '/tr', tr, '/sc', 'hourly', '/f'];
    case 'every6h':  return ['/create', '/tn', TASK_NAME, '/tr', tr, '/sc', 'hourly', '/mo', '6', '/f'];
    case 'every12h': return ['/create', '/tn', TASK_NAME, '/tr', tr, '/sc', 'hourly', '/mo', '12', '/f'];
    case 'daily':    return ['/create', '/tn', TASK_NAME, '/tr', tr, '/sc', 'daily', '/st', time || '08:00', '/f'];
    case 'weekly':   return ['/create', '/tn', TASK_NAME, '/tr', tr, '/sc', 'weekly', '/d', 'MON', '/st', time || '08:00', '/f'];
    default: throw new Error('Unknown frequency: ' + frequency);
  }
}

function updateSchedule(frequency, time, options = {}) {
  return new Promise((resolve) => {
    // Always delete first
    const del = spawn('schtasks', ['/delete', '/tn', TASK_NAME, '/f'], { windowsHide: true });
    del.on('close', () => {
      if (frequency === 'off') return resolve({ ok: true, mode: 'off' });
      const args = buildScheduleArgs(frequency, time, options);
      const p = spawn('schtasks', args, { windowsHide: true });
      let out = '', err = '';
      p.stdout.on('data', d => out += d);
      p.stderr.on('data', d => err += d);
      p.on('close', code => {
        if (code !== 0) return resolve({ ok: false, error: (err || out).trim(), code });
        resolve({ ok: true, mode: frequency, time: time || '08:00', runner: options.runner || 'safe' });
      });
      p.on('error', e => resolve({ ok: false, error: e.message }));
    });
    del.on('error', e => resolve({ ok: false, error: e.message }));
  });
}

function startJob({ mode, slug }) {
  if (!KNOWN_MODES.has(mode)) return { ok: false, status: 400, error: `unknown mode: ${mode}` };
  const job = makeJob({ mode, slug: slug || 'ALL' });
  runningJobs.set(job.jobId, job);
  logEvent('info', 'job_started', `${job.mode} job started`, { source: 'job-orchestrator', jobId: job.jobId, projectSlug: job.slug, mode: job.mode });
  // Run the job in the background so the HTTP request returns immediately.
  // The job orchestrator updates `job` in place; the route handler returns
  // just the jobId so the UI can poll.
  (async () => {
    try {
      const projects = readProjectsForJob();
      await runJob({
        job,
        projects,
        projectsPath: PROJECTS_PATH,
        jobsLogPath: JOBS_LOG_PATH,
        writeProjects: () => writeJson(PROJECTS_PATH, projects),
        defaultProjectKbPath,
        log: (level, event, message, meta = {}) => logEvent(level, event, message, { ...meta, source: meta.source || 'job-orchestrator', jobId: job.jobId, projectSlug: meta.projectSlug || job.slug }),
      });
    } catch (e) {
      job.status = 'failed';
      job.endTime = new Date().toISOString();
      job.exitCode = 1;
      job.output += `\n[dispatch error] ${e.message}\n${e.stack || ''}`;
      logEvent('error', 'job_dispatch_failed', e.message, { source: 'job-orchestrator', jobId: job.jobId, projectSlug: job.slug });
    } finally {
      lastRun = { time: job.endTime, status: job.status, slug: job.slug, mode: job.mode, output: (job.output || '').slice(-6000) };
      logEvent(job.status === 'success' ? 'info' : 'warn', 'job_finished', `${job.mode} job ${job.status}`, { source: 'job-orchestrator', jobId: job.jobId, projectSlug: job.slug, mode: job.mode, status: job.status });
      // Keep the live record for 10 minutes so the UI can poll completion.
      setTimeout(() => runningJobs.delete(job.jobId), 10 * 60 * 1000);
    }
  })();
  return { ok: true, jobId: job.jobId, mode: job.mode, slug: job.slug };
}

function automationDeps(projects) {
  return {
    projects,
    defaultProjectKbPath,
    validateUsableAiProfile,
    startAutomationSession: (opts) => claudeCliRunner.startAutomationSession(opts),
    // Pass the stable function reference directly (not a lambda) so that
    // post-commit-automation can de-dupe registrations across dispatches.
    onSessionEnded: claudeCliRunner.onSessionEnded,
    readProjects: () => readProjects({ persistMigrations: false }),
    writeProjects: (nextProjects) => writeJson(PROJECTS_PATH, nextProjects || projects),
  };
}

function projectConfigWithAutomationDraft(projectCfg, draft) {
  if (!draft || typeof draft !== 'object' || Array.isArray(draft)) return projectCfg;
  return {
    ...projectCfg,
    automation: normalizeAutomationConfig({
      ...(projectCfg.automation || {}),
      ...draft,
    }),
  };
}

function goalRelForProject(projectCfg, kbPath) {
  return 'GOAL.md';
}

// ---- git inspector (TASK-002) ----
// (execGit is now imported from ./lib/git-runner so the context-pack-builder can share it.)

async function inspectGit(gitPath) {
  const result = {
    gitPath: gitPath || '',
    repoStatus: 'unknown',
    defaultBranch: null,
    currentBranch: null,
    headCommit: null,
    remoteUrl: null,
    error: null,
  };
  if (!gitPath) {
    result.repoStatus = 'missing-path';
    result.error = 'no git path configured';
    return result;
  }
  if (!fs.existsSync(gitPath)) {
    result.repoStatus = 'missing-path';
    result.error = `path not found: ${gitPath}`;
    return result;
  }

  const inside = await execGit(gitPath, ['rev-parse', '--is-inside-work-tree']);
  if (!inside.ok || inside.stdout.trim() !== 'true') {
    result.repoStatus = 'not-git';
    result.error = 'not inside a git work tree';
    return result;
  }

  const toplevel = await execGit(gitPath, ['rev-parse', '--show-toplevel']);
  if (toplevel.ok) result.gitPath = toplevel.stdout.trim();

  const head = await execGit(gitPath, ['rev-parse', 'HEAD']);
  if (!head.ok) {
    // Empty repo: rev-parse HEAD fails with "unknown revision"
    const empty = await execGit(gitPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
    if (empty.ok) {
      result.currentBranch = (empty.stdout || '').trim() || null;
    }
    result.repoStatus = 'empty';
    result.error = 'repository has no commits';
    return result;
  }
  result.headCommit = head.stdout.trim() || null;

  const branch = await execGit(gitPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch.ok) result.currentBranch = (branch.stdout || '').trim() || null;

  const defaultRef = await execGit(gitPath, ['symbolic-ref', 'refs/remotes/origin/HEAD']);
  if (defaultRef.ok) {
    const ref = (defaultRef.stdout || '').trim();
    const m = ref.match(/refs\/remotes\/origin\/(.+)$/);
    if (m) result.defaultBranch = m[1];
  }
  if (!result.defaultBranch) {
    // Fallback: detect by checking local branches that match origin/<name>
    const branches = await execGit(gitPath, ['branch', '--list']);
    if (branches.ok) {
      const lines = (branches.stdout || '').split(/\r?\n/);
      const mainLine = lines.find(l => /\bmain\b/.test(l)) || lines.find(l => /\bmaster\b/.test(l));
      if (mainLine) {
        result.defaultBranch = mainLine.replace(/^\*\s*/, '').trim();
      }
    }
  }

  const remote = await execGit(gitPath, ['remote', 'get-url', 'origin']);
  if (remote.ok) result.remoteUrl = (remote.stdout || '').trim() || null;
  else result.remoteUrl = null;

  result.repoStatus = 'ok';
  return result;
}

function applyGitInspection(project, inspection) {
  project.repoStatus = inspection.repoStatus;
  project.headCommit = inspection.headCommit;
  project.currentBranch = inspection.currentBranch;
  project.defaultBranch = inspection.defaultBranch;
  project.remoteUrl = inspection.remoteUrl;
  project.gitPath = inspection.gitPath || project.gitPath;
  if (!project.trackingStartCommit && !project.lastAnalyzedCommit && inspection.headCommit) {
    project.trackingStartCommit = inspection.headCommit;
    project.trackingStartedAt = project.trackingStartedAt || new Date().toISOString();
  }
  return project;
}

async function validateAndPersistProject(slug, projects) {
  if (!projects[slug]) return { ok: false, status: 404, error: 'Slug not in projects.json' };
  const cfg = projects[slug];
  const targetPath = cfg.gitPath || cfg.localPath;
  const inspection = await inspectGit(targetPath);
  applyGitInspection(cfg, inspection);
  writeJson(PROJECTS_PATH, projects);
  return { ok: true, slug, inspection };
}

async function projectImportPreflight({ localPath, gitPath }) {
  const targetPath = gitPath || localPath;
  const result = {
    ok: false,
    localPath: localPath || '',
    gitPath: targetPath || '',
    exists: false,
    canImport: false,
    needsGitInit: false,
    canInitGit: false,
    inspection: null,
    error: null,
  };
  if (!targetPath) {
    result.error = 'localPath or gitPath is required';
    return result;
  }
  result.exists = fs.existsSync(targetPath);
  if (!result.exists) {
    result.error = `path not found: ${targetPath}`;
    return result;
  }
  const stat = fs.statSync(targetPath);
  if (!stat.isDirectory()) {
    result.error = `path is not a directory: ${targetPath}`;
    return result;
  }
  const inspection = await inspectGit(targetPath);
  result.inspection = inspection;
  result.canImport = ['ok', 'empty'].includes(inspection.repoStatus);
  result.needsGitInit = inspection.repoStatus === 'not-git';
  result.canInitGit = result.needsGitInit;
  result.ok = result.canImport || result.canInitGit;
  if (!result.ok) result.error = inspection.error || 'project cannot be imported';
  return result;
}

async function initializeLocalGit({ repoPath, createInitialCommit = false, remoteUrl = '' }) {
  const result = {
    ok: false,
    repoPath: repoPath || '',
    initialized: false,
    initialCommit: false,
    remoteConfigured: false,
    inspection: null,
    steps: [],
    error: null,
  };
  if (!repoPath || !fs.existsSync(repoPath) || !fs.statSync(repoPath).isDirectory()) {
    result.error = 'repoPath must be an existing directory';
    return result;
  }
  let inspection = await inspectGit(repoPath);
  if (inspection.repoStatus === 'not-git') {
    const init = await execGit(repoPath, ['init']);
    result.steps.push({ step: 'git init', ok: init.ok, stderr: init.stderr });
    if (!init.ok) {
      result.error = init.stderr || init.error || 'git init failed';
      return result;
    }
    result.initialized = true;
  }
  await execGit(repoPath, ['config', 'user.name', 'Project Knowledge Base']);
  await execGit(repoPath, ['config', 'user.email', 'project-knowledge-base@example.local']);
  await execGit(repoPath, ['config', 'commit.gpgsign', 'false']);

  inspection = await inspectGit(repoPath);
  if (createInitialCommit && inspection.repoStatus === 'empty') {
    const add = await execGit(repoPath, ['add', '-A'], 30000);
    result.steps.push({ step: 'git add -A', ok: add.ok, stderr: add.stderr });
    if (!add.ok) {
      result.error = add.stderr || add.error || 'git add failed';
      return result;
    }
    const commit = await execGit(repoPath, ['commit', '-m', 'chore: initial import'], 30000);
    result.steps.push({ step: 'git commit', ok: commit.ok, stderr: commit.stderr });
    if (!commit.ok) {
      result.error = commit.stderr || commit.error || 'git commit failed';
      return result;
    }
    result.initialCommit = true;
  }

  if (remoteUrl && String(remoteUrl).trim()) {
    const remote = await execGit(repoPath, ['remote', 'get-url', 'origin']);
    const args = remote.ok ? ['remote', 'set-url', 'origin', remoteUrl.trim()] : ['remote', 'add', 'origin', remoteUrl.trim()];
    const setRemote = await execGit(repoPath, args);
    result.steps.push({ step: args.join(' '), ok: setRemote.ok, stderr: setRemote.stderr });
    if (!setRemote.ok) {
      result.error = setRemote.stderr || setRemote.error || 'git remote setup failed';
      return result;
    }
    result.remoteConfigured = true;
  }

  result.inspection = await inspectGit(repoPath);
  result.ok = ['ok', 'empty'].includes(result.inspection.repoStatus);
  if (!result.ok) result.error = result.inspection.error || 'git initialization did not produce a usable repository';
  return result;
}

function runPickerCommand(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => stdout += d.toString('utf-8'));
    child.stderr.on('data', d => stderr += d.toString('utf-8'));
    child.on('error', e => resolve({ ok: false, error: e.message, stdout, stderr }));
    child.on('close', code => resolve({ ok: code === 0, code, stdout, stderr, error: code === 0 ? null : (stderr || stdout || `exit ${code}`) }));
  });
}

async function pickLocalFolder() {
  if (process.platform === 'win32') {
    // Modern Vista+ IFileOpenDialog folder picker (the same dialog VS Code
    // shows). Default initial folder is "This PC". Returns the selected
    // folder path on stdout; nothing on cancel.
    const pickerScript = path.join(__dirname, 'scripts', 'folder-picker.ps1');
    const result = await runPickerCommand('powershell.exe', [
      '-NoProfile', '-STA', '-WindowStyle', 'Hidden',
      '-ExecutionPolicy', 'Bypass',
      '-File', pickerScript,
      '选择要导入的本地项目目录',
    ]);
    const folder = (result.stdout || '').trim().split(/\r?\n/).filter(Boolean).pop() || '';
    return folder ? { ok: true, path: folder } : { ok: false, cancelled: true, error: result.error || 'folder selection cancelled' };
  }
  if (process.platform === 'darwin') {
    const result = await runPickerCommand('osascript', ['-e', 'POSIX path of (choose folder with prompt "Select project folder")']);
    const folder = (result.stdout || '').trim();
    return folder ? { ok: true, path: folder } : { ok: false, cancelled: true, error: result.error || 'folder selection cancelled' };
  }
  const zenity = await runPickerCommand('sh', ['-lc', 'command -v zenity >/dev/null 2>&1 && zenity --file-selection --directory || true']);
  const folder = (zenity.stdout || '').trim();
  return folder ? { ok: true, path: folder } : { ok: false, error: 'No native folder picker available. Enter the path manually.' };
}

async function importProjectFromLocalPath({ localPath, knowledgeLanguage = DEFAULT_KNOWLEDGE_LANGUAGE, teamKnowledgeBase = null }) {
  const projects = readProjects({ persistMigrations: true });
  const resolvedLocalPath = path.resolve(String(localPath || '').trim());
  if (!localPath || !fs.existsSync(resolvedLocalPath) || !fs.statSync(resolvedLocalPath).isDirectory()) {
    return { ok: false, status: 400, error: 'localPath must be an existing directory' };
  }
  const teamBindingResult = normalizeTeamKnowledgeBinding(teamKnowledgeBase);
  if (teamBindingResult && !teamBindingResult.ok) {
    return { ok: false, status: 400, error: teamBindingResult.error };
  }
  const teamBinding = teamBindingResult && teamBindingResult.binding || null;
  if (teamBinding) {
    const syncResult = await syncTeamKnowledgeStoreForImport(teamBinding);
    if (!syncResult.ok) return syncResult;
  }
  const selectedProfileId = firstUsableAiProfileId();
  if (!selectedProfileId) return { ok: false, status: 400, error: 'No usable AI profile configured' };
  const profileCheck = validateUsableAiProfile(selectedProfileId);
  if (!profileCheck.ok) return { ok: false, status: profileCheck.status || 400, error: profileCheck.error };

  let inspection = await inspectGit(resolvedLocalPath);
  let gitInit = null;
  if (inspection.repoStatus === 'not-git') {
    gitInit = await initializeLocalGit({ repoPath: resolvedLocalPath });
    if (!gitInit.ok) return { ok: false, status: 400, error: gitInit.error, gitInit };
    inspection = gitInit.inspection || await inspectGit(resolvedLocalPath);
  }
  const repoPath = inspection.gitPath || resolvedLocalPath;
  const displayName = basenameFromPath(resolvedLocalPath);
  const recovered = findRemovedProject({ repoPath });
  const recoveredCfg = recovered && recovered.entry && (recovered.entry.config || recovered.entry);
  const recoveredSlug = recovered && isSafeSlug(recovered.slug) && !projects[recovered.slug] ? recovered.slug : '';
  const slug = recoveredSlug || uniqueProjectSlug(displayName, projects);
  const kbPath = teamBinding
    ? teamBinding.kbPath
    : (recoveredCfg && recoveredCfg.kbPath ? recoveredCfg.kbPath : defaultProjectKbPath(slug));
  const kbAlreadyInitialized = fs.existsSync(path.join(kbPath, 'README.md')) || kbFramework.isCurrentKb(kbPath);
  if (teamBinding && !kbAlreadyInitialized) {
    return { ok: false, status: 400, error: `selected team knowledge base is not initialized: ${kbPath}` };
  }
  const initResult = teamBinding
    ? { created: [], basePath: path.resolve(kbPath), reusedExisting: true, teamBinding: true, kbSchemaVersion: PROJECT_SCHEMA_VERSION }
    : kbAlreadyInitialized
    ? { created: [], basePath: path.resolve(kbPath), reusedExisting: true, kbSchemaVersion: PROJECT_SCHEMA_VERSION }
    : initProjectDirs(slug, kbPath);
  const config = normalizeProjectConfig(slug, {
    ...(recoveredCfg || {}),
    displayName,
    localPath: resolvedLocalPath,
    gitPath: repoPath,
    primaryLanguage: '',
    tags: [],
    isReference: false,
    docConvention: 'frontmatter-relations',
    kbPath,
    enabled: true,
    aiProfileId: recoveredCfg && recoveredCfg.aiProfileId || selectedProfileId,
    knowledgeLanguage: recoveredCfg && recoveredCfg.knowledgeLanguage || knowledgeLanguage,
    kbSchemaVersion: PROJECT_SCHEMA_VERSION,
    goalStatus: recoveredCfg && recoveredCfg.goalStatus || 'not-created',
    automation: recoveredCfg && recoveredCfg.automation || defaultProjectAutomationConfig(),
    claudeWorkbench: recoveredCfg && recoveredCfg.claudeWorkbench || defaultClaudeWorkbenchConfig(),
    ...(teamBinding || {}),
  }).config;
  applyGitInspection(config, inspection);
  projects[slug] = config;
  writeJson(PROJECTS_PATH, projects);
  if (recovered) forgetRemovedProject(recovered.slug);

  let hookResult = null;
  try {
    hookResult = installHook({
      repoPath,
      siteRoot: SITE_ROOT,
      host: HOST,
      port: PORT,
      overwrite: false,
      kbPath: config.kbPath,
      projectsPath: PROJECTS_PATH,
      projectSlug: slug,
    });
  } catch (e) {
    hookResult = { ok: false, error: e.message };
  }

  let initAutomation = null;
  if (teamBinding) {
    initAutomation = { ok: true, skipped: true, reason: 'team KB binding uses existing remote knowledge base' };
  } else if (kbAlreadyInitialized) {
    initAutomation = { ok: true, skipped: true, reason: 'existing KB reconnected' };
  } else {
    try {
      initAutomation = await postCommitAutomation.dispatchProjectInit({ slug, cfg: config }, automationDeps(projects));
    } catch (e) {
      initAutomation = { ok: false, error: e.message };
    }
  }

  logEvent('info', 'project_imported', `Project imported: ${slug}`, {
    source: 'project-import',
    projectSlug: slug,
    repoPath,
    kbPath,
    hookInstalled: hookResult && hookResult.ok === true,
    initAutomationRunId: initAutomation && initAutomation.runId || null,
  });

  return {
    ok: true,
    slug,
    config,
    repoStatus: config.repoStatus,
    gitInit,
    initResult,
    hookResult,
    initAutomation,
    reconnected: !!recovered,
  };
}

async function runKnowledgeUpdate(slug) {
  const projects = readProjects({ persistMigrations: true });
  if (!projects[slug]) return { ok: false, status: 404, error: 'Slug not in projects.json' };
  const project = projects[slug];
  const kbPath = project.kbPath || defaultProjectKbPath(slug);
  if (!fs.existsSync(kbPath) || !fs.existsSync(path.join(kbPath, 'README.md'))) {
    const init = initProjectDirs(slug, kbPath);
    project.kbSchemaVersion = init.kbSchemaVersion || PROJECT_SCHEMA_VERSION;
    logEvent('info', 'kb_initialized', 'Knowledge base initialized before update.', { source: 'knowledge-update', projectSlug: slug, kbPath });
    init.created = init.created || [];
  }

  const scanResult = await scanAndPersistProject(slug, projects, { maxCommits: 200 });
  if (!scanResult.ok) return scanResult;
  const scan = scanResult.scan;
  if (scan.repoStatus !== 'ok') {
    writeJson(PROJECTS_PATH, projects);
    logEvent('error', 'knowledge_update_blocked', `Knowledge update blocked: git status ${scan.repoStatus}`, { source: 'knowledge-update', projectSlug: slug, repoStatus: scan.repoStatus, error: scan.error });
    return { ok: false, status: 400, slug, stage: 'scan', scan, error: scan.error || `git status ${scan.repoStatus}` };
  }

  let analysis = null;
  let applyResult = null;
  let validation = null;
  let reviewRequired = false;
  let reviewReason = '';

  if ((scan.pendingCount || 0) > 0) {
    analysis = await runCommitAnalysis({ slug, ...project, kbPath });
    if (analysis.ok && !analysis.noop && analysis.runId) {
      const drafts = listDrafts(kbPath, analysis.runId);
      const safeDrafts = [];
      const blocked = [];
      for (const draft of drafts) {
        if (draft.path === 'GOAL.md' || draft.path === 'ARCHITECTURE.md') {
          blocked.push(draft.path);
          continue;
        }
        const content = readDraftContent(kbPath, analysis.runId, draft.path);
        if (content != null) safeDrafts.push({ path: draft.path, content });
      }
      if (safeDrafts.length) {
        applyResult = applyDrafts({
          kbPath,
          slug,
          runId: analysis.runId,
          drafts: safeDrafts,
          allowGoalEdit: false,
          headCommitAtRun: analysis.runRecord && analysis.runRecord.headCommitAtRun,
        });
        if (applyResult.ok && analysis.runRecord && analysis.runRecord.headCommitAtRun) {
          projects[slug].lastAnalyzedCommit = analysis.runRecord.headCommitAtRun;
        } else if (!applyResult.ok) {
          reviewRequired = true;
          reviewReason = applyResult.error || 'auto apply failed';
        }
      }
      if (blocked.length) {
        reviewRequired = true;
        reviewReason = `blocked goal-related drafts: ${blocked.join(', ')}`;
      }
      logEvent(applyResult && applyResult.ok ? 'info' : 'warn', 'commit_analysis_auto_apply', applyResult && applyResult.ok ? 'Commit analysis drafts auto-applied.' : 'Commit analysis requires review.', { source: 'knowledge-update', projectSlug: slug, runId: analysis.runId, applied: applyResult && applyResult.applied || [], reviewRequired });
    } else if (analysis.ok && analysis.noop) {
      logEvent('info', 'knowledge_update_noop', 'No pending commits to analyze.', { source: 'knowledge-update', projectSlug: slug });
    } else if (!analysis.ok) {
      logEvent('error', 'commit_analysis_failed', analysis.error, { source: 'knowledge-update', projectSlug: slug, runId: analysis.runId || '' });
    }
  } else {
    analysis = { ok: true, noop: true, message: 'no pending commits' };
    logEvent('info', 'knowledge_update_noop', 'No knowledge update needed.', { source: 'knowledge-update', projectSlug: slug });
  }

  validation = validateKb(kbPath);
  writeJson(PROJECTS_PATH, projects);
  return {
    ok: !!(analysis && analysis.ok) && validation.ok !== false,
    status: validation.ok === false ? validation.status || 422 : 200,
    slug,
    kbPath,
    scan,
    analysis,
    applyResult,
    validation,
    reviewRequired,
    reviewReason,
  };
}

// ---- project init (create dir structure) ----
function readTemplate(name) {
  const p = path.join(KB_ROOT, 'templates', name);
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, 'utf-8');
}

function renderTemplate(content, vars) {
  return content.replace(/__([A-Z_][A-Z0-9_]*)__/g, (_, key) => (key in vars ? String(vars[key]) : `__${key}__`));
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function initProjectDirs(slug, kbPath = null) {
  return kbFramework.initProjectDirs(slug, kbPath || defaultProjectKbPath(slug));
}

function migrateLegacyProjectDirs(slug, kbPath = null) {
  return kbFramework.migrateToFramework({
    slug,
    kbPath: kbPath || defaultProjectKbPath(slug),
    preserveLegacyAI: false,
  });
}

// ---- routing ----
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    const m = req.method;

    if (m === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      return res.end();
    }

    // Static
    if (m === 'GET' && (p === '/' || p === '/index.html')) {
      const html = fs.readFileSync(path.join(SITE_ROOT, 'index.html'), 'utf-8');
      return send(res, 200, html, 'text/html');
    }

    if (m === 'GET' && (p === '/favicon.svg' || p === '/favicon.ico')) {
      const svg = fs.readFileSync(path.join(SITE_ROOT, 'favicon.svg'), 'utf-8');
      return send(res, 200, svg, 'image/svg+xml');
    }
    // GET /api/state — aggregate (enriches projects with kbInitialized flag)
    if (m === 'GET' && p === '/api/state') {
      const projects = readProjects({ persistMigrations: true });
      for (const slug of Object.keys(projects)) {
        const kbPath = projects[slug].kbPath || defaultProjectKbPath(slug);
        // Project is "KB-initialized" if the dir exists AND README.md is present
        try {
          const stat = fs.statSync(kbPath);
          if (stat.isDirectory() && fs.existsSync(path.join(kbPath, 'README.md'))) {
            projects[slug].kbInitialized = true;
            // Count accepted change docs and module docs in the minimal framework.
            const changesDir = path.join(kbPath, 'changes');
            const modulesDir = path.join(kbPath, 'modules');
            try { projects[slug].commitCount = fs.readdirSync(changesDir).filter(f => f.endsWith('.md') && f !== '00-index.md').length; } catch {}
            try { projects[slug].moduleCount = fs.readdirSync(modulesDir).filter(f => f.endsWith('.md') && f !== '00-index.md').length; } catch {}
          } else {
            projects[slug].kbInitialized = false;
          }
        } catch {
          projects[slug].kbInitialized = false;
        }
        projects[slug].automationQueueCount = postCommitAutomation.getQueueSize(slug);
      }
      const schedule = await getScheduleInfo();
      return send(res, 200, {
        projects,
        schedule,
        lastRun,
        kbRoot: DATA_DIR,
        setup: aiSetupState(),
        knowledgeStore: readKnowledgeStore(),
        logging: readLoggingConfig(),
        projectSchemaVersion: PROJECT_SCHEMA_VERSION,
      });
    }

    // GET /api/knowledge-store/config
    if (m === 'GET' && p === '/api/knowledge-store/config') {
      const cfg = readKnowledgeStore();
      const validation = knowledgeStore.validateRoot(cfg.rootPath);
      return send(res, 200, { ok: validation.ok, config: cfg, validation });
    }

    // PUT /api/knowledge-store/config
    if (m === 'PUT' && p === '/api/knowledge-store/config') {
      const body = JSON.parse(await readBody(req));
      const validation = knowledgeStore.validateRoot(body.rootPath);
      if (!validation.ok) return send(res, 400, { ok: false, error: validation.error, validation });
      const cfg = knowledgeStore.writeConfig(KNOWLEDGE_STORE_PATH, DATA_DIR, body);
      logEvent('info', 'knowledge_store_config_updated', 'Knowledge store configuration updated.', { source: 'knowledge-store', rootPath: cfg.rootPath });
      return send(res, 200, { ok: true, config: cfg, validation });
    }

    // POST /api/knowledge-store/migrate { execute?, overwrite?, move? }
    if (m === 'POST' && p === '/api/knowledge-store/migrate') {
      const body = await readBody(req).catch(() => '{}');
      const parsed = (() => { try { return JSON.parse(body); } catch { return {}; } })();
      const projects = readProjects({ persistMigrations: true });
      const storeConfig = readKnowledgeStore();
      if (!parsed.execute) {
        const plan = knowledgeStore.buildMigrationPlan({ projects, appRoot: DATA_DIR, storeConfig });
        return send(res, 200, { ok: true, execute: false, plan });
      }
      const result = knowledgeStore.migrateProjects({
        projects,
        appRoot: DATA_DIR,
        storeConfig,
        overwrite: parsed.overwrite === true,
        move: parsed.move === true,
      });
      writeJson(PROJECTS_PATH, projects);
      logEvent('info', 'knowledge_store_migrated', 'Knowledge store migration executed.', { source: 'knowledge-store', count: result.migrated.length });
      return send(res, 200, { ok: true, execute: true, ...result });
    }

    // GET /api/logging/config
    if (m === 'GET' && p === '/api/logging/config') {
      const cfg = readLoggingConfig();
      return send(res, 200, { ok: true, config: cfg });
    }

    // PUT /api/logging/config
    if (m === 'PUT' && p === '/api/logging/config') {
      const body = JSON.parse(await readBody(req));
      const cfg = structuredLogger.writeConfig(LOGGING_CONFIG_PATH, DATA_DIR, body);
      logEvent('info', 'logging_config_updated', 'Logging configuration updated.', { source: 'logging', rootPath: cfg.rootPath });
      return send(res, 200, { ok: true, config: cfg });
    }

    // GET /api/logs
    if (m === 'GET' && p === '/api/logs') {
      const logs = structuredLogger.readLogs(LOGGING_CONFIG_PATH, DATA_DIR, {
        dateFrom: url.searchParams.get('dateFrom') || '',
        dateTo: url.searchParams.get('dateTo') || '',
        level: url.searchParams.get('level') || '',
        projectSlug: url.searchParams.get('projectSlug') || '',
        source: url.searchParams.get('source') || '',
        q: url.searchParams.get('q') || '',
        limit: Number(url.searchParams.get('limit') || 500),
      });
      return send(res, 200, { ok: true, logs, config: readLoggingConfig() });
    }

    // GET /api/supervision/issues
    if (m === 'GET' && p === '/api/supervision/issues') {
      const projects = readProjects({ persistMigrations: false });
      const history = readJobLog(JOBS_LOG_PATH);
      const issues = [];
      for (const [slug, cfg] of Object.entries(projects)) {
        issues.push(...supervision.projectIssues(slug, cfg, cfg.kbPath || defaultProjectKbPath(slug)));
      }
      issues.push(...supervision.jobIssues(history));
      return send(res, 200, { ok: true, issues });
    }

    // GET /api/supervision/pending-commits
    if (m === 'GET' && p === '/api/supervision/pending-commits') {
      const projects = readProjects({ persistMigrations: false });
      const items = await supervision.pendingCommits(projects, (slug, cfg) => cfg.kbPath || defaultProjectKbPath(slug));
      return send(res, 200, { ok: true, items });
    }

    // GET /api/supervision/summary
    if (m === 'GET' && p === '/api/supervision/summary') {
      const projects = readProjects({ persistMigrations: false });
      const history = readJobLog(JOBS_LOG_PATH);
      const issues = [
        ...Object.entries(projects).flatMap(([slug, cfg]) => supervision.projectIssues(slug, cfg, cfg.kbPath || defaultProjectKbPath(slug))),
        ...supervision.jobIssues(history),
      ];
      return send(res, 200, { ok: true, summary: supervision.summary(projects, [...runningJobs.values()], issues), issues });
    }

    // POST /api/system/pick-folder — open a native local folder picker when available.
    if (m === 'POST' && p === '/api/system/pick-folder') {
      const result = await pickLocalFolder();
      return send(res, result.ok ? 200 : (result.cancelled ? 200 : 400), result);
    }

    // POST /api/projects/import { localPath, knowledgeLanguage? }
    if (m === 'POST' && p === '/api/projects/import') {
      const body = await readBody(req).catch(() => '{}');
      const parsed = (() => { try { return JSON.parse(body); } catch { return {}; } })();
      const result = await importProjectFromLocalPath({
        localPath: parsed.localPath,
        knowledgeLanguage: parsed.knowledgeLanguage || DEFAULT_KNOWLEDGE_LANGUAGE,
        teamKnowledgeBase: parsed.teamKnowledgeBase || null,
      });
      return send(res, result.ok ? 200 : (result.status || 400), result);
    }

    // GET /api/team/github/status
    if (m === 'GET' && p === '/api/team/github/status') {
      const cfg = readGithubTeamConfig();
      const providerConfig = readTeamGitProvidersConfig();
      const providers = githubTeamStore.providerPublicConfig(cfg, process.env, providerConfig);
      providers.gitea.oauthRedirectUri = buildGiteaOAuthRedirectUri();
      return send(res, 200, {
        ok: true,
        config: githubTeamStore.publicConfig(cfg),
        oauth: githubTeamStore.oauthPublicConfig(cfg, process.env),
        providers,
        storesCache: publicTeamStoresCache(cfg),
      });
    }

    // PUT /api/team/github/provider { provider?, oauthWebBaseUrl?, apiBaseUrl?, oauthClientId? }
    if (m === 'PUT' && p === '/api/team/github/provider') {
      const body = await readBody(req).catch(() => '{}');
      const parsed = (() => { try { return JSON.parse(body); } catch { return {}; } })();
      const current = readGithubTeamConfig();
      const provider = githubTeamStore.normalizeProvider(parsed.provider || current.provider);
      const webBaseUrl = String(parsed.oauthWebBaseUrl || parsed.webBaseUrl || '').trim();
      const apiBaseUrl = String(parsed.apiBaseUrl || (webBaseUrl ? githubTeamStore.inferApiBaseUrlFromWebBaseUrl(webBaseUrl, provider) : current.apiBaseUrl)).trim();
      const next = githubTeamStore.normalizeConfig({
        ...current,
        provider,
        apiBaseUrl,
        oauthWebBaseUrl: webBaseUrl || githubTeamStore.inferWebBaseUrlFromApiBaseUrl(apiBaseUrl, provider),
        oauthClientId: String(parsed.oauthClientId || '').trim(),
      });
      const apiChanged = next.apiBaseUrl !== current.apiBaseUrl || next.provider !== current.provider;
      const cfg = writeGithubTeamConfig({
        ...next,
        token: apiChanged ? '' : current.token,
        login: apiChanged ? '' : current.login,
      });
      if (apiChanged) clearTeamStoresCache();
      logEvent('info', 'github_team_provider_saved', 'GitHub team knowledge provider settings saved.', {
        source: 'github-team',
        provider: cfg.provider,
        apiBaseUrl: cfg.apiBaseUrl,
        oauthWebBaseUrl: cfg.oauthWebBaseUrl,
        authCleared: apiChanged,
      });
      return send(res, 200, { ok: true, config: githubTeamStore.publicConfig(cfg), oauth: githubTeamStore.oauthPublicConfig(cfg, process.env), authCleared: apiChanged });
    }

    // POST /api/team/gitea/oauth/start { oauthWebBaseUrl?, oauthClientId? }
    if (m === 'POST' && p === '/api/team/gitea/oauth/start') {
      const body = await readBody(req).catch(() => '{}');
      const parsed = (() => { try { return JSON.parse(body); } catch { return {}; } })();
      const current = readGithubTeamConfig();
      const preset = githubTeamStore.giteaPresetFromEnv(process.env, readTeamGitProvidersConfig());
      const webBaseUrl = String(parsed.oauthWebBaseUrl || (current.provider === 'gitea' ? current.oauthWebBaseUrl : '') || preset.webBaseUrl || '').trim();
      const oauthClientId = String(parsed.oauthClientId || (current.provider === 'gitea' ? current.oauthClientId : '') || preset.oauthClientId || '').trim();
      const oauthClientSecret = String(parsed.oauthClientSecret || (current.provider === 'gitea' ? current.oauthClientSecret : '') || preset.oauthClientSecret || '').trim();
      const cfg = githubTeamStore.normalizeConfig({
        ...current,
        provider: 'gitea',
        oauthWebBaseUrl: webBaseUrl,
        apiBaseUrl: parsed.apiBaseUrl || (webBaseUrl ? githubTeamStore.inferApiBaseUrlFromWebBaseUrl(webBaseUrl, 'gitea') : current.apiBaseUrl),
        oauthClientId,
        oauthClientSecret,
      });
      const redirectUri = buildGiteaOAuthRedirectUri();
      const started = githubTeamStore.startGiteaOAuth({ config: cfg, redirectUri, env: process.env });
      if (!started.ok) return send(res, started.status || 400, started);
      writeGithubTeamConfig({ ...cfg, token: '', login: '' });
      giteaOAuthStates.set(started.state, {
        codeVerifier: started.codeVerifier,
        redirectUri: started.redirectUri,
        config: cfg,
        createdAt: Date.now(),
      });
      return send(res, 200, {
        ok: true,
        provider: 'gitea',
        authorizationUrl: started.authorizationUrl,
        redirectUri: started.redirectUri,
        expiresIn: 900,
        config: githubTeamStore.publicConfig(cfg),
      });
    }

    // GET /api/team/gitea/oauth/callback?code=...&state=...
    if (m === 'GET' && p === '/api/team/gitea/oauth/callback') {
      const state = String(url.searchParams.get('state') || '');
      const code = String(url.searchParams.get('code') || '');
      const oauthError = String(url.searchParams.get('error') || '');
      const finishHtml = (title, message, ok) => `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font-family:system-ui;padding:24px;background:#111827;color:#e5e7eb"><h2>${title}</h2><p>${message}</p><script>try{window.opener&&window.opener.postMessage({type:'project-knowledge:gitea-oauth-complete',ok:${ok ? 'true' : 'false'},message:${JSON.stringify(message)}},'*')}catch(e){};setTimeout(()=>window.close(),900)</script></body>`;
      if (oauthError) return send(res, 400, finishHtml('Gitea login failed', oauthError, false), 'text/html');
      const entry = state && giteaOAuthStates.get(state);
      if (!entry || !code) return send(res, 400, finishHtml('Gitea login failed', 'OAuth state expired or code is missing.', false), 'text/html');
      giteaOAuthStates.delete(state);
      if (Date.now() - entry.createdAt > 15 * 60 * 1000) {
        return send(res, 410, finishHtml('Gitea login expired', 'Please start Gitea login again.', false), 'text/html');
      }
      const exchanged = await githubTeamStore.exchangeGiteaOAuthCode({
        config: entry.config,
        code,
        codeVerifier: entry.codeVerifier,
        redirectUri: entry.redirectUri,
        env: process.env,
      });
      if (!exchanged.ok) return send(res, exchanged.status || 400, finishHtml('Gitea login failed', exchanged.error || 'Token exchange failed.', false), 'text/html');
      const validation = await githubTeamStore.validateToken({
        token: exchanged.token,
        apiBaseUrl: entry.config.apiBaseUrl,
        provider: 'gitea',
      });
      if (!validation.ok) return send(res, validation.status || 400, finishHtml('Gitea login failed', validation.error || 'Token validation failed.', false), 'text/html');
      const cfg = writeGithubTeamConfig({
        ...entry.config,
        provider: 'gitea',
        token: exchanged.token,
        login: validation.login,
      });
      clearTeamStoresCache();
      logEvent('info', 'gitea_team_oauth_saved', 'Gitea team knowledge OAuth login saved.', {
        source: 'github-team',
        provider: 'gitea',
        login: cfg.login,
        apiBaseUrl: cfg.apiBaseUrl,
      });
      return send(res, 200, finishHtml('Gitea login completed', 'You can return to Project Knowledge.', true), 'text/html');
    }

    // POST /api/team/github/oauth/device/start
    if (m === 'POST' && p === '/api/team/github/oauth/device/start') {
      const cfg = readGithubTeamConfig();
      const body = await readBody(req).catch(() => '{}');
      const parsed = (() => { try { return JSON.parse(body); } catch { return {}; } })();
      const result = await githubTeamStore.startDeviceFlow({
        clientId: githubTeamStore.oauthClientIdForConfig(cfg, process.env),
        webBaseUrl: cfg.oauthWebBaseUrl || githubTeamStore.oauthWebBaseUrlFromEnv(process.env),
        scope: parsed.scope || 'repo read:org',
      });
      return send(res, result.ok ? 200 : (result.status || 400), result);
    }

    // POST /api/team/github/oauth/device/poll { deviceCode }
    if (m === 'POST' && p === '/api/team/github/oauth/device/poll') {
      const cfgBefore = readGithubTeamConfig();
      const body = await readBody(req).catch(() => '{}');
      const parsed = (() => { try { return JSON.parse(body); } catch { return {}; } })();
      const result = await githubTeamStore.pollDeviceFlow({
        clientId: githubTeamStore.oauthClientIdForConfig(cfgBefore, process.env),
        webBaseUrl: cfgBefore.oauthWebBaseUrl || githubTeamStore.oauthWebBaseUrlFromEnv(process.env),
        deviceCode: parsed.deviceCode,
      });
      if (!result.ok) return send(res, result.status || 400, result);
      if (result.pending) return send(res, 202, result);
      const validation = await githubTeamStore.validateToken({ token: result.token, apiBaseUrl: cfgBefore.apiBaseUrl || githubTeamStore.DEFAULT_API_BASE_URL, provider: cfgBefore.provider });
      if (!validation.ok) return send(res, validation.status || 400, validation);
      const cfg = writeGithubTeamConfig({
        ...cfgBefore,
        token: result.token,
        apiBaseUrl: cfgBefore.apiBaseUrl || githubTeamStore.DEFAULT_API_BASE_URL,
        login: validation.login,
      });
      clearTeamStoresCache();
      logEvent('info', 'github_team_oauth_saved', 'GitHub team knowledge OAuth login saved.', {
        source: 'github-team',
        login: cfg.login,
        scope: result.scope,
      });
      return send(res, 200, { ok: true, config: githubTeamStore.publicConfig(cfg), user: validation.user, scope: result.scope });
    }

    // PUT /api/team/github/auth { token, apiBaseUrl? }
    if (m === 'PUT' && p === '/api/team/github/auth') {
      const current = readGithubTeamConfig();
      const body = await readBody(req).catch(() => '{}');
      const parsed = (() => { try { return JSON.parse(body); } catch { return {}; } })();
      const token = String(parsed.token || '').trim();
      const provider = githubTeamStore.normalizeProvider(parsed.provider || current.provider);
      const apiBaseUrl = String(parsed.apiBaseUrl || current.apiBaseUrl || githubTeamStore.DEFAULT_API_BASE_URL).trim();
      const validation = await githubTeamStore.validateToken({ token, apiBaseUrl, provider });
      if (!validation.ok) return send(res, validation.status || 400, validation);
      const oauthWebBaseUrl = String(parsed.oauthWebBaseUrl || current.oauthWebBaseUrl || githubTeamStore.inferWebBaseUrlFromApiBaseUrl(apiBaseUrl, provider)).trim();
      const cfg = writeGithubTeamConfig({ ...current, provider, token, apiBaseUrl, oauthWebBaseUrl, login: validation.login });
      clearTeamStoresCache();
      logEvent('info', 'github_team_auth_saved', 'GitHub team knowledge auth saved.', {
        source: 'github-team',
        login: cfg.login,
        apiBaseUrl: cfg.apiBaseUrl,
      });
      return send(res, 200, { ok: true, config: githubTeamStore.publicConfig(cfg), user: validation.user });
    }

    // DELETE /api/team/github/auth
    if (m === 'DELETE' && p === '/api/team/github/auth') {
      const cfg = writeGithubTeamConfig(githubTeamStore.defaultConfig());
      clearTeamStoresCache();
      logEvent('info', 'github_team_auth_removed', 'GitHub team knowledge auth removed.', { source: 'github-team' });
      return send(res, 200, { ok: true, config: githubTeamStore.publicConfig(cfg) });
    }

    // GET /api/team/github/stores
    if (m === 'GET' && p === '/api/team/github/stores') {
      const cfg = readGithubTeamConfig();
      if (!cfg.token) {
        const label = cfg.provider === 'gitea' ? 'Gitea' : 'GitHub';
        return send(res, 401, { ok: false, code: 'auth_required', error: `${label} auth is not configured` });
      }
      const forceRefresh = ['1', 'true', 'yes'].includes(String(url.searchParams.get('refresh') || '').toLowerCase());
      const cache = readTeamStoresCache();
      if (!forceRefresh && teamStoresCacheMatches(cfg, cache)) {
        return send(res, 200, {
          ok: true,
          cached: true,
          updatedAt: cache.updatedAt || '',
          scannedRepoCount: Number(cache.scannedRepoCount || 0),
          stores: Array.isArray(cache.stores) ? cache.stores : [],
        });
      }
      const result = await githubTeamStore.discoverStores({
        token: cfg.token,
        apiBaseUrl: cfg.apiBaseUrl,
        provider: cfg.provider,
        dataDir: DATA_DIR,
      });
      if (!result.ok) {
        if (teamStoresCacheMatches(cfg, cache)) {
          return send(res, 200, {
            ok: true,
            cached: true,
            stale: true,
            warning: result.error || 'Failed to refresh team knowledge repositories; using cached results.',
            updatedAt: cache.updatedAt || '',
            scannedRepoCount: Number(cache.scannedRepoCount || 0),
            stores: Array.isArray(cache.stores) ? cache.stores : [],
          });
        }
        return send(res, result.status || 500, result);
      }
      const nextCache = writeTeamStoresCache(cfg, result);
      logEvent('info', 'github_team_store_discovery_cached', 'Team knowledge store discovery cache updated.', {
        source: 'github-team',
        provider: cfg.provider,
        apiBaseUrl: cfg.apiBaseUrl,
        storeCount: result.stores.length,
        scannedRepoCount: result.scannedRepoCount || 0,
      });
      result.cached = false;
      result.updatedAt = nextCache.updatedAt;
      return send(res, result.ok ? 200 : (result.status || 500), result);
    }

    // POST /api/team/github/stores/checkout { cloneUrl, branch?, localPath? }
    if (m === 'POST' && p === '/api/team/github/stores/checkout') {
      const cfg = readGithubTeamConfig();
      if (!cfg.token) return send(res, 401, { ok: false, error: 'GitHub auth is not configured' });
      const body = await readBody(req).catch(() => '{}');
      const parsed = (() => { try { return JSON.parse(body); } catch { return {}; } })();
      const result = await githubTeamStore.checkoutStore({
        cloneUrl: parsed.cloneUrl,
        branch: parsed.branch || parsed.defaultBranch || 'main',
        localPath: parsed.localPath,
        token: cfg.token,
        provider: cfg.provider,
        username: cfg.login,
      });
      if (result.ok) {
        logEvent('info', 'github_team_store_checkout', `GitHub team knowledge store ${result.action}.`, {
          source: 'github-team',
          localPath: result.localPath,
          cloneUrl: parsed.cloneUrl,
        });
      }
      return send(res, result.ok ? 200 : (result.status || 500), result);
    }

    // POST /api/team/github/local-store/scan { localPath }
    if (m === 'POST' && p === '/api/team/github/local-store/scan') {
      const body = await readBody(req).catch(() => '{}');
      const parsed = (() => { try { return JSON.parse(body); } catch { return {}; } })();
      const current = readGithubTeamConfig();
      const result = await githubTeamStore.scanLocalStore({ localPath: parsed.localPath, provider: current.provider });
      return send(res, result.ok ? 200 : (result.status || 400), result);
    }

    // POST /api/team/github/local-store/configure { localPath, displayName?, knowledgeBases?, commit?, push? }
    if (m === 'POST' && p === '/api/team/github/local-store/configure') {
      const body = await readBody(req).catch(() => '{}');
      const parsed = (() => { try { return JSON.parse(body); } catch { return {}; } })();
      const current = readGithubTeamConfig();
      const result = await githubTeamStore.configureLocalStore({
        localPath: parsed.localPath,
        displayName: parsed.displayName,
        knowledgeBases: parsed.knowledgeBases,
        commit: parsed.commit !== false,
        push: parsed.push !== false,
        provider: current.provider,
      });
      if (result.ok) {
        clearTeamStoresCache();
        logEvent('info', 'github_team_local_store_configured', 'Local knowledge repository configured as a GitHub team store.', {
          source: 'github-team',
          localPath: parsed.localPath,
          manifestPath: result.manifestPath,
          committed: result.committed,
          pushed: result.pushed,
          knowledgeBaseCount: result.manifest && result.manifest.knowledgeBases && result.manifest.knowledgeBases.length || 0,
        });
      }
      return send(res, result.ok ? 200 : (result.status || 500), result);
    }

    // POST /api/projects/import-preflight { localPath, gitPath? }
    if (m === 'POST' && p === '/api/projects/import-preflight') {
      const body = await readBody(req).catch(() => '{}');
      const parsed = (() => { try { return JSON.parse(body); } catch { return {}; } })();
      const result = await projectImportPreflight({ localPath: parsed.localPath, gitPath: parsed.gitPath });
      return send(res, result.ok ? 200 : 400, result);
    }

    // POST /api/git/init { path, createInitialCommit?, remoteUrl? }
    if (m === 'POST' && p === '/api/git/init') {
      const body = await readBody(req).catch(() => '{}');
      const parsed = (() => { try { return JSON.parse(body); } catch { return {}; } })();
      const result = await initializeLocalGit({
        repoPath: parsed.path || parsed.repoPath,
        createInitialCommit: parsed.createInitialCommit === true,
        remoteUrl: parsed.remoteUrl || '',
      });
      logEvent(result.ok ? 'info' : 'error', result.ok ? 'git_initialized' : 'git_init_failed', result.ok ? 'Local Git repository is ready.' : result.error, { source: 'git-import', repoPath: result.repoPath });
      return send(res, result.ok ? 200 : 400, result);
    }

    // GET /api/projects
    if (m === 'GET' && p === '/api/projects') {
      return send(res, 200, readProjects({ persistMigrations: true }));
    }

    // PUT /api/projects — replace or upsert one
    if (m === 'PUT' && p === '/api/projects') {
      const body = JSON.parse(await readBody(req));
      const projects = readProjects({ persistMigrations: true });
      if (body.slug && body.config) {
        if (!isSafeSlug(body.slug)) return send(res, 400, { error: 'Invalid slug' });
        if (typeof body.config !== 'object' || body.config === null) {
          return send(res, 400, { error: 'Invalid config' });
        }
        const importOptions = body.importOptions && typeof body.importOptions === 'object' ? body.importOptions : {};
        const targetPathBeforeImport = body.config.gitPath || body.config.localPath;
        if (importOptions.initGit === true) {
          const gitInit = await initializeLocalGit({
            repoPath: targetPathBeforeImport,
            createInitialCommit: importOptions.createInitialCommit === true,
            remoteUrl: importOptions.remoteUrl || '',
          });
          if (!gitInit.ok) return send(res, 400, { ok: false, error: gitInit.error, gitInit });
        }
        const recovered = findRemovedProject({ slug: body.slug, repoPath: body.config.gitPath || body.config.localPath || '' });
        const recoveredCfg = recovered && recovered.entry && (recovered.entry.config || recovered.entry);
        const nextConfig = recoveredCfg
          ? mergeRecoveredProjectConfig(recoveredCfg, body.config)
          : body.config;
        projects[body.slug] = normalizeProjectConfig(body.slug, nextConfig).config;
        // Auto-validate git on add/update — populates repoStatus, headCommit, etc.
        const targetPath = projects[body.slug].gitPath || projects[body.slug].localPath;
        const inspection = await inspectGit(targetPath);
        applyGitInspection(projects[body.slug], inspection);
        writeJson(PROJECTS_PATH, projects);
        if (recovered) forgetRemovedProject(recovered.slug);
        return send(res, 200, { ok: true, slug: body.slug, repoStatus: inspection.repoStatus });
      }
      if (body.projects && typeof body.projects === 'object') {
        const normalized = normalizeProjects(body.projects).projects;
        writeJson(PROJECTS_PATH, normalized);
        return send(res, 200, { ok: true });
      }
      return send(res, 400, { error: 'Need { slug, config } or { projects }' });
    }

    // GET /api/projects/:slug/remove-preview
    if (m === 'GET' && p.startsWith('/api/projects/') && p.endsWith('/remove-preview')) {
      const slug = p.split('/')[3];
      if (!isSafeSlug(slug)) return send(res, 400, { error: 'Invalid slug' });
      const projects = readProjects({ persistMigrations: false });
      if (!projects[slug]) return send(res, 404, { error: 'Slug not in projects.json' });
      return send(res, 200, { ok: true, preview: projectRemovePreview(slug, projects[slug]) });
    }

    // POST /api/projects/:slug/remove { deleteKb?, reason? }
    if (m === 'POST' && p.startsWith('/api/projects/') && p.endsWith('/remove')) {
      const slug = p.split('/')[3];
      if (!isSafeSlug(slug)) return send(res, 400, { error: 'Invalid slug' });
      const body = await readBody(req).catch(() => '{}');
      const parsed = (() => { try { return JSON.parse(body); } catch { return {}; } })();
      const projects = readProjects({ persistMigrations: false });
      if (!projects[slug]) return send(res, 404, { error: 'Slug not in projects.json' });
      if (hasRunningProjectJob(slug)) return send(res, 409, { ok: false, error: 'project has a running job' });
      const cfg = projects[slug];
      const kbPath = path.resolve(cfg.kbPath || defaultProjectKbPath(slug));
      const deleteKb = parsed.deleteKb === true;
      let removedKb = false;
      let hookResult = null;
      if (deleteKb) {
        const safe = validateKbDeletionPath(kbPath);
        if (!safe.ok) return send(res, 400, { ok: false, error: safe.error, kbPath: safe.path || kbPath });
      }
      try {
        hookResult = uninstallHook({ repoPath: cfg.gitPath || cfg.localPath || '' });
      } catch (e) {
        hookResult = { ok: false, warning: e.message };
      }
      if (deleteKb) forgetRemovedProject(slug);
      else rememberRemovedProject(slug, cfg, parsed.reason || '');
      delete projects[slug];
      writeJson(PROJECTS_PATH, projects);
      removeKnowledgeStoreProjectOverride(slug);
      if (deleteKb && fs.existsSync(kbPath)) {
        fs.rmSync(kbPath, { recursive: true, force: true });
        removedKb = true;
      }
      logEvent('info', 'project_removed', `Project removed: ${slug}`, {
        source: 'project-remove',
        projectSlug: slug,
        kbPath,
        deleteKb,
        removedKb,
        reason: parsed.reason || '',
        hookResult,
      });
      return send(res, 200, { ok: true, slug, kbPath, removedKb, hookResult });
    }

    // POST /api/projects/:slug/init
    if (m === 'POST' && p.startsWith('/api/projects/') && p.endsWith('/init')) {
      const slug = p.split('/')[3];
      if (!isSafeSlug(slug)) return send(res, 400, { error: 'Invalid slug' });
      const projects = readProjects({ persistMigrations: true });
      if (!projects[slug]) return send(res, 404, { error: 'Slug not in projects.json' });
      const result = initProjectDirs(slug, projects[slug].kbPath || defaultProjectKbPath(slug));
      projects[slug].kbSchemaVersion = PROJECT_SCHEMA_VERSION;
      writeJson(PROJECTS_PATH, projects);
      return send(res, 200, { ok: true, ...result, kbSchemaVersion: PROJECT_SCHEMA_VERSION });
    }

    // POST /api/projects/:slug/migrate-framework
    if (m === 'POST' && p.startsWith('/api/projects/') && p.endsWith('/migrate-framework')) {
      const slug = p.split('/')[3];
      if (!isSafeSlug(slug)) return send(res, 400, { error: 'Invalid slug' });
      const projects = readProjects({ persistMigrations: true });
      if (!projects[slug]) return send(res, 404, { error: 'Slug not in projects.json' });
      const result = kbFramework.migrateToFramework({ slug, kbPath: projects[slug].kbPath || defaultProjectKbPath(slug), preserveLegacyAI: false });
      projects[slug].kbSchemaVersion = PROJECT_SCHEMA_VERSION;
      writeJson(PROJECTS_PATH, projects);
      logEvent('info', 'kb_framework_migrated', 'Knowledge base migrated to the current framework.', { source: 'kb-framework', projectSlug: slug, kbPath: result.kbPath });
      return send(res, 200, { ok: true, ...result });
    }

    if (m === 'GET' && p.startsWith('/api/projects/') && p.endsWith('/goal')) {
      const slug = p.split('/')[3];
      if (!isSafeSlug(slug)) return send(res, 400, { error: 'Invalid slug' });
      const projects = readProjects({ persistMigrations: true });
      const project = projects[slug];
      if (!project) return send(res, 404, { error: 'Slug not in projects.json' });
      const kbPath = path.resolve(project.kbPath || defaultProjectKbPath(slug));
      const rel = goalRelForProject(project, kbPath);
      const abs = path.join(kbPath, rel);
      const exists = fs.existsSync(abs);
      return send(res, 200, {
        ok: true,
        slug,
        kbPath,
        path: rel,
        exists,
        goalStatus: project.goalStatus || 'not-created',
        content: exists ? fs.readFileSync(abs, 'utf-8') : '',
      });
    }

    if (m === 'PUT' && p.startsWith('/api/projects/') && p.endsWith('/goal')) {
      const slug = p.split('/')[3];
      if (!isSafeSlug(slug)) return send(res, 400, { error: 'Invalid slug' });
      const projects = readProjects({ persistMigrations: true });
      const project = projects[slug];
      if (!project) return send(res, 404, { error: 'Slug not in projects.json' });
      const body = JSON.parse(await readBody(req).catch(() => '{}'));
      if (typeof body.content !== 'string') return send(res, 400, { error: 'content must be a string' });
      if (Buffer.byteLength(body.content, 'utf-8') > 512 * 1024) return send(res, 413, { error: 'goal content is too large' });
      const kbPath = path.resolve(project.kbPath || defaultProjectKbPath(slug));
      const rel = goalRelForProject(project, kbPath);
      const abs = path.join(kbPath, rel);
      fs.mkdirSync(kbPath, { recursive: true });
      fs.writeFileSync(abs, body.content.replace(/\r\n/g, '\n'), 'utf-8');
      projects[slug].goalStatus = 'accepted';
      writeJson(PROJECTS_PATH, projects);
      logEvent('info', 'project_goal_saved', 'Project goal saved from settings UI.', { source: 'settings', projectSlug: slug, kbPath, path: rel });
      return send(res, 200, {
        ok: true,
        slug,
        kbPath,
        path: rel,
        exists: true,
        goalStatus: projects[slug].goalStatus,
        content: fs.readFileSync(abs, 'utf-8'),
      });
    }

    // POST /api/projects/:slug/validate-git
    if (m === 'POST' && p.startsWith('/api/projects/') && p.endsWith('/validate-git')) {
      const slug = p.split('/')[3];
      if (!isSafeSlug(slug)) return send(res, 400, { error: 'Invalid slug' });
      const projects = readProjects({ persistMigrations: false });
      const result = await validateAndPersistProject(slug, projects);
      if (!result.ok) return send(res, result.status, { error: result.error });
      return send(res, 200, { ok: true, slug, ...result.inspection });
    }

    // GET /api/projects/:slug/git-status (read-only inspection without writing)
    if (m === 'GET' && p.startsWith('/api/projects/') && p.endsWith('/git-status')) {
      const slug = p.split('/')[3];
      if (!isSafeSlug(slug)) return send(res, 400, { error: 'Invalid slug' });
      const projects = readProjects({ persistMigrations: false });
      if (!projects[slug]) return send(res, 404, { error: 'Slug not in projects.json' });
      const cfg = projects[slug];
      const targetPath = cfg.gitPath || cfg.localPath;
      const inspection = await inspectGit(targetPath);
      return send(res, 200, { ok: true, slug, ...inspection });
    }

    // GET /api/projects/:slug/hook-status — read whether the post-commit hook is installed
    if (m === 'POST' && p === '/api/hooks/post-commit') {
      let body;
      try { body = JSON.parse(await readBody(req)); } catch { return send(res, 400, { ok: false, error: 'invalid JSON body' }); }
      const projects = readProjects({ persistMigrations: true });
      const repoPath = body.repoPath || body.repo || '';
      const result = await postCommitAutomation.handlePostCommitEvent({
        repoPath,
        commitHash: body.commitHash || body.commit || '',
        branch: body.branch || '',
        source: 'git-hook',
      }, automationDeps(projects));
      logEvent(result.ok ? 'info' : 'error', result.ok ? 'post_commit_automation' : 'post_commit_automation_failed', result.reason || result.error || 'post-commit automation dispatched', {
        source: 'git-hook',
        projectSlug: result.slug || '',
        runId: result.runId || '',
        repoPath,
      });
      return send(res, result.ok ? 200 : result.status || 500, result);
    }

    if (m === 'POST' && p.startsWith('/api/projects/') && p.endsWith('/automation/preview')) {
      const slug = p.split('/')[3];
      if (!isSafeSlug(slug)) return send(res, 400, { ok: false, error: 'Invalid slug' });
      const projects = readProjects({ persistMigrations: true });
      if (!projects[slug]) return send(res, 404, { ok: false, error: 'Slug not in projects.json' });
      let body = {};
      try { body = JSON.parse(await readBody(req).catch(() => '{}')); } catch {}
      const cfg = projectConfigWithAutomationDraft(projects[slug], body.automation);
      try {
        const rendered = await postCommitAutomation.renderAutomationPrompt({
          slug,
          cfg,
          event: { commitHash: body.commitHash || 'HEAD', branch: body.branch || '' },
          defaultProjectKbPath,
        });
        return send(res, 200, { ok: true, slug, prompt: rendered.prompt, vars: rendered.vars, metadata: rendered.metadata });
      } catch (e) {
        return send(res, 500, { ok: false, error: e.message });
      }
    }

    if (m === 'POST' && p.startsWith('/api/projects/') && p.endsWith('/automation/simulate')) {
      const slug = p.split('/')[3];
      if (!isSafeSlug(slug)) return send(res, 400, { ok: false, error: 'Invalid slug' });
      const projects = readProjects({ persistMigrations: true });
      if (!projects[slug]) return send(res, 404, { ok: false, error: 'Slug not in projects.json' });
      let body = {};
      try { body = JSON.parse(await readBody(req).catch(() => '{}')); } catch {}
      const cfg = projectConfigWithAutomationDraft(projects[slug], body.automation);
      const result = await postCommitAutomation.dispatchAutomation({
        slug,
        cfg,
        event: {
          repoPath: cfg.gitPath || cfg.localPath || '',
          commitHash: body.commitHash || 'HEAD',
          branch: body.branch || '',
        },
        source: 'simulate',
      }, automationDeps(projects));
      return send(res, result.ok ? 200 : result.status || 500, result);
    }

    if (m === 'POST' && p.startsWith('/api/projects/') && p.endsWith('/automation/init')) {
      const slug = p.split('/')[3];
      if (!isSafeSlug(slug)) return send(res, 400, { ok: false, error: 'Invalid slug' });
      const projects = readProjects({ persistMigrations: true });
      if (!projects[slug]) return send(res, 404, { ok: false, error: 'Slug not in projects.json' });
      let body = {};
      try { body = JSON.parse(await readBody(req).catch(() => '{}')); } catch {}
      const cfg = projectConfigWithAutomationDraft(projects[slug], body.automation);
      const result = await postCommitAutomation.dispatchProjectInit({
        slug,
        cfg,
        source: 'project-init',
      }, automationDeps(projects));
      return send(res, result.ok ? 200 : result.status || 500, result);
    }

    if (m === 'GET' && p.startsWith('/api/projects/') && p.endsWith('/automation/runs')) {
      const slug = p.split('/')[3];
      if (!isSafeSlug(slug)) return send(res, 400, { ok: false, error: 'Invalid slug' });
      const projects = readProjects({ persistMigrations: false });
      if (!projects[slug]) return send(res, 404, { ok: false, error: 'Slug not in projects.json' });
      return send(res, 200, { ok: true, slug, runs: postCommitAutomation.listAutomationRuns(slug, 20) });
    }

    if (m === 'GET' && p.startsWith('/api/projects/') && p.endsWith('/hook-status')) {
      const slug = p.split('/')[3];
      if (!isSafeSlug(slug)) return send(res, 400, { error: 'Invalid slug' });
      const projects = readProjects({ persistMigrations: false });
      if (!projects[slug]) return send(res, 404, { error: 'Slug not in projects.json' });
      const cfg = projects[slug];
      const repoPath = cfg.gitPath || cfg.localPath;
      const status = readHookStatus({ repoPath });
      return send(res, status.ok ? 200 : status.status || 500, { ok: true, slug, ...status });
    }

    // POST /api/projects/:slug/hook-install { overwrite?: boolean }
    if (m === 'POST' && p.startsWith('/api/projects/') && p.endsWith('/hook-install')) {
      const slug = p.split('/')[3];
      if (!isSafeSlug(slug)) return send(res, 400, { error: 'Invalid slug' });
      const projects = readProjects({ persistMigrations: false });
      if (!projects[slug]) return send(res, 404, { error: 'Slug not in projects.json' });
      const cfg = projects[slug];
      const repoPath = cfg.gitPath || cfg.localPath;
      const body = JSON.parse(await readBody(req).catch(() => '{}'));
      const overwrite = !!(body && body.overwrite);
      // Default v2.4.2+ behavior: emit the portable CLAUDE.md block (slug
      // + discovery chain), no absolute path embedded. Callers that need
      // the legacy explicit form can opt in by passing `projectsPath` /
      // `kbPath` from a future API extension.
      const result = installHook({
        repoPath,
        siteRoot: SITE_ROOT,
        host: HOST,
        port: PORT,
        overwrite,
        projectSlug: slug,
      });
      return send(res, result.ok ? 200 : result.status || 500, { ok: !!result.ok, slug, ...result, installed: result.ok === true });
    }

    // POST /api/projects/:slug/hook-uninstall
    if (m === 'POST' && p.startsWith('/api/projects/') && p.endsWith('/hook-uninstall')) {
      const slug = p.split('/')[3];
      if (!isSafeSlug(slug)) return send(res, 400, { error: 'Invalid slug' });
      const projects = readProjects({ persistMigrations: false });
      if (!projects[slug]) return send(res, 404, { error: 'Slug not in projects.json' });
      const cfg = projects[slug];
      const repoPath = cfg.gitPath || cfg.localPath;
      const result = uninstallHook({ repoPath });
      return send(res, result.ok ? 200 : result.status || 500, { ok: !!result.ok, slug, ...result, installed: false });
    }

    // POST /api/projects/:slug/scan — read-only scanner; updates headCommit + lastSeenCommit only
    if (m === 'POST' && p.startsWith('/api/projects/') && p.endsWith('/scan')) {
      const slug = p.split('/')[3];
      if (!isSafeSlug(slug)) return send(res, 400, { error: 'Invalid slug' });
      const body = await readBody(req).catch(() => '{}');
      const parsed = (() => { try { return JSON.parse(body); } catch { return {}; } })();
      const projects = readProjects({ persistMigrations: false });
      const result = await scanAndPersistProject(slug, projects, { maxCommits: parsed.maxCommits || 200 });
      if (!result.ok) return send(res, result.status, { error: result.error });
      return send(res, 200, { ok: true, slug, ...result.scan });
    }

    // GET /api/projects/:slug/scan — read-only scan preview
    if (m === 'GET' && p.startsWith('/api/projects/') && p.endsWith('/scan')) {
      const slug = p.split('/')[3];
      if (!isSafeSlug(slug)) return send(res, 400, { error: 'Invalid slug' });
      const projects = readProjects({ persistMigrations: false });
      if (!projects[slug]) return send(res, 404, { error: 'Slug not in projects.json' });
      const scan = await scanProject({ slug, ...projects[slug] });
      return send(res, 200, { ok: true, slug, ...scan });
    }

    // POST /api/scan-all — scan every enabled project
    if (m === 'POST' && p.startsWith('/api/projects/') && p.endsWith('/knowledge-update')) {
      const slug = p.split('/')[3];
      if (!isSafeSlug(slug)) return send(res, 400, { error: 'Invalid slug' });
      const result = await runKnowledgeUpdate(slug);
      return send(res, result.status || (result.ok ? 200 : 500), result);
    }

    if (m === 'POST' && p === '/api/scan-all') {
      const projects = readProjects({ persistMigrations: false });
      const results = [];
      for (const slug of Object.keys(projects)) {
        if (projects[slug].enabled === false) continue;
        const r = await scanAndPersistProject(slug, projects);
        results.push({ slug, ok: r.ok, ...(r.ok ? r.scan : { error: r.error }) });
      }
      return send(res, 200, { ok: true, results });
    }

    // GET /api/ai-profiles — list configured profiles and available adapters
    if (m === 'GET' && p === '/api/ai-profiles') {
      const cfg = readAiProfiles();
      return send(res, 200, { ok: true, config: cfg, adapters: listAdapters(), setup: aiSetupState(cfg) });
    }

    // GET /api/ai-vendor-presets — built-in vendor presets for the profile form datalist
    if (m === 'GET' && p === '/api/ai-vendor-presets') {
      return send(res, 200, { ok: true, presets: AI_VENDOR_PRESETS, names: listVendorPresetNames() });
    }

    // PUT /api/ai-profiles — replace the whole ai-profiles.json
    if (m === 'PUT' && p === '/api/ai-profiles') {
      const body = JSON.parse(await readBody(req));
      const errors = validateProfileConfig(body);
      if (errors.length) return send(res, 400, { ok: false, errors });
      writeAiProfiles(body);
      return send(res, 200, { ok: true });
    }

    // POST /api/ai-profiles/test { profileId, prompt? }
    if (m === 'POST' && p === '/api/ai-profiles/test') {
      const body = await readBody(req).catch(() => '{}');
      const parsed = (() => { try { return JSON.parse(body); } catch { return {}; } })();
      const cfg = readAiProfiles();
      const inlineProfile = parsed.profile && typeof parsed.profile === 'object' ? parsed.profile : null;
      const profileId = parsed.profileId || (inlineProfile && inlineProfile.id);
      if (!profileId) return send(res, 400, { ok: false, error: 'profileId required' });
      const profile = inlineProfile || (cfg.profiles || []).find(item => item && item.id === profileId);
      if (!profile) return send(res, 404, { ok: false, error: `profile not found: ${profileId}` });
      const profileErrors = validateProfileConfig({ schema: 'ai-profiles/v1', profiles: [profile] });
      if (profileErrors.length) return send(res, 400, { ok: false, errors: profileErrors });
      const implementation = profileImplementation(profile);
      if (!getAdapter(implementation)) return send(res, 400, { ok: false, error: `unknown adapter: ${implementation}` });

      const prompt = parsed.prompt || 'what model are you?';
      if (implementation === 'claude-code-agent') {
        try {
          const result = await testClaudeCodeAgentProfile(profile, profileId, prompt);
          return send(res, result.status, result);
        } catch (e) {
          return send(res, 400, { ok: false, profileId, error: e.message });
        }
      }

      try {
        const llmCfg = readLlmConfig({ profileId });
        const result = await completeText({
          profile: inlineProfile || undefined,
          profileId,
          user: prompt,
          maxTokens: 128,
        });
        return send(res, 200, {
          ok: true,
          profileId,
          model: result.model || llmCfg.model,
          baseUrl: llmCfg.baseUrl,
          text: result.text,
          usage: result.usage,
        });
      } catch (e) {
        return send(res, 400, { ok: false, profileId, error: e.message });
      }
    }

    // PUT /api/projects/:slug/ai-profile — set a project's AI profile.
    // Pass aiProfileId: null to restore the first usable default profile.
    if (m === 'PUT' && p.startsWith('/api/projects/') && p.endsWith('/ai-profile')) {
      const slug = p.split('/')[3];
      if (!isSafeSlug(slug)) return send(res, 400, { error: 'Invalid slug' });
      const body = JSON.parse(await readBody(req));
      const nextAiProfileId = body.aiProfileId == null ? firstUsableAiProfileId() : body.aiProfileId;
      if (nextAiProfileId != null) {
        const profileCheck = validateUsableAiProfile(nextAiProfileId);
        if (!profileCheck.ok) return send(res, profileCheck.status, { error: profileCheck.error });
      }
      const projects = readProjects({ persistMigrations: true });
      if (!projects[slug]) return send(res, 404, { error: 'Slug not in projects.json' });
      projects[slug].aiProfileId = nextAiProfileId;
      writeJson(PROJECTS_PATH, projects);
      return send(res, 200, { ok: true, slug, aiProfileId: projects[slug].aiProfileId });
    }

    // PUT /api/projects/:slug/settings - set project-level AI and KB generation settings
    if (m === 'PUT' && p.startsWith('/api/projects/') && p.endsWith('/settings')) {
      const slug = p.split('/')[3];
      if (!isSafeSlug(slug)) return send(res, 400, { error: 'Invalid slug' });
      const body = JSON.parse(await readBody(req));
      const projects = readProjects({ persistMigrations: true });
      if (!projects[slug]) return send(res, 404, { error: 'Slug not in projects.json' });

      if (body.aiProfileId != null) {
        const profileCheck = validateUsableAiProfile(body.aiProfileId);
        if (!profileCheck.ok) return send(res, profileCheck.status, { error: profileCheck.error });
        projects[slug].aiProfileId = body.aiProfileId;
      }

      if (body.knowledgeLanguage != null) {
        if (!['zh-CN', 'en-US'].includes(body.knowledgeLanguage)) {
          return send(res, 400, { error: 'knowledgeLanguage must be zh-CN or en-US' });
        }
        projects[slug].knowledgeLanguage = body.knowledgeLanguage;
      }

      if (body.automation != null) {
        if (typeof body.automation !== 'object' || Array.isArray(body.automation)) {
          return send(res, 400, { error: 'automation must be an object' });
        }
        const prevAutomation = normalizeAutomationConfig(projects[slug].automation || {});
        const nextAutomation = normalizeAutomationConfig({
          ...(projects[slug].automation || {}),
          ...body.automation,
        });
        const disabledNow = (prevAutomation.enabled && !nextAutomation.enabled)
          || (prevAutomation.postCommitEnabled && !nextAutomation.postCommitEnabled);
        projects[slug].automation = nextAutomation;
        if (disabledNow) {
          const dropped = postCommitAutomation.drainQueue(slug);
          if (dropped.length > 0) {
            logEvent('info', 'automation_queue_drained', 'automation disabled while runs were queued', { slug, dropped });
          }
        }
      }

      if (body.claudeWorkbench != null) {
        if (typeof body.claudeWorkbench !== 'object' || Array.isArray(body.claudeWorkbench)) {
          return send(res, 400, { error: 'claudeWorkbench must be an object' });
        }
        projects[slug].claudeWorkbench = normalizeClaudeWorkbenchConfig({
          ...(projects[slug].claudeWorkbench || {}),
          ...body.claudeWorkbench,
        });
      }

      writeJson(PROJECTS_PATH, projects);
      return send(res, 200, {
        ok: true,
        slug,
        aiProfileId: projects[slug].aiProfileId,
        knowledgeLanguage: projects[slug].knowledgeLanguage,
        automation: projects[slug].automation,
        claudeWorkbench: projects[slug].claudeWorkbench,
      });
    }

    // POST /api/projects/:slug/context-pack — build a context pack (TASK-006)
    if (m === 'POST' && p.startsWith('/api/projects/') && p.endsWith('/context-pack')) {
      const slug = p.split('/')[3];
      if (!isSafeSlug(slug)) return send(res, 400, { error: 'Invalid slug' });
      const body = await readBody(req).catch(() => '{}');
      const parsed = (() => { try { return JSON.parse(body); } catch { return {}; } })();
      const projects = readProjects({ persistMigrations: false });
      if (!projects[slug]) return send(res, 404, { error: 'Slug not in projects.json' });
      const trigger = parsed.trigger === 'commits' ? 'commits' : 'initial';
      let commits = [];
      if (trigger === 'commits') {
        const scan = await scanProject({ slug, ...projects[slug] }, { maxCommits: parsed.maxCommits || 200 });
        commits = scan.commits;
      }
      const kbPath = projects[slug].kbPath || defaultProjectKbPath(slug);
      const pack = await buildContextPack({
        project: { slug, ...projects[slug], kbPath },
        runId: parsed.runId,
        trigger,
        commits,
      });
      return send(res, 200, { ok: true, slug, runId: pack.runId, entryCount: pack.entries.length, contextPack: pack });
    }

    // POST /api/projects/:slug/analyze/initial — run initial analysis (TASK-007)
    // ?mode=cli → spawn Claude Code subprocess and return sessionId for SSE streaming
    if (m === 'POST' && p.startsWith('/api/projects/') && p.endsWith('/analyze/initial')) {
      const slug = p.split('/')[3];
      if (!isSafeSlug(slug)) return send(res, 400, { error: 'Invalid slug' });
      const projects = readProjects({ persistMigrations: false });
      if (!projects[slug]) return send(res, 404, { error: 'Slug not in projects.json' });
      const kbPath = projects[slug].kbPath || defaultProjectKbPath(slug);

      // Embedded Claude Code terminal: kick off the Claude Agent SDK session
      // and return sessionId immediately so the UI can subscribe via SSE.
      // The legacy `claude -p` subprocess path was removed in the
      // CC-Switch migration — SDK is the only supported mode.
      if (url.searchParams.get('mode') === 'cli') {
        const projectPath = projects[slug].gitPath || projects[slug].localPath;
        if (!projectPath) return send(res, 400, { error: 'Project has no gitPath/localPath' });
        const aiProfileId = projects[slug].aiProfileId;
        const profileCheck = validateUsableAiProfile(aiProfileId);
        if (!profileCheck.ok) return send(res, profileCheck.status, { ok: false, error: profileCheck.error });
        if (profileCheck.implementation !== 'claude-code-agent') {
          return send(res, 400, { ok: false, error: `Claude terminal requires claude-code-agent implementation, got ${profileCheck.implementation}` });
        }
        try {
          const permissionMode = projects[slug].claudeWorkbench && projects[slug].claudeWorkbench.permissionMode || 'default';
          const { sessionId } = claudeCliRunner.startChatSession({
            slug,
            projectPath,
            kbPath,
            aiProfile: profileCheck.profile,
            permissionMode,
          });
          return send(res, 200, { ok: true, slug, sessionId, mode: 'cli', runner: 'sdk', aiProfileId, pendingPermission: claudeCliRunner.getState(sessionId)?.pendingPermission || null });
        } catch (e) {
          return send(res, 500, { ok: false, error: e.message });
        }
      }

      // Initial analysis orchestration was removed. The endpoint now only
      // serves the embedded Claude terminal kickoff (?mode=cli).
      return send(res, 400, { ok: false, error: 'initial analysis removed; use ?mode=cli for terminal session' });
    }

    // GET /api/claude/sessions — list active sessions
    if (m === 'GET' && p === '/api/claude/sessions') {
      const slug = url.searchParams.get('slug');
      if (slug && !isSafeSlug(slug)) return send(res, 400, { error: 'Invalid slug' });
      return send(res, 200, { sessions: claudeCliRunner.listSessions({ projectSlug: slug || null }) });
    }

    // GET /api/claude/sessions/:id — session state
    if (m === 'GET' && p.startsWith('/api/claude/sessions/') && !p.includes('/')) {
      // skipped — path has slashes; handled by next branch
    }
    if (m === 'GET' && p.startsWith('/api/claude/sessions/') && p.split('/').length === 5) {
      // /api/claude/sessions/:id  →  parts = ['', 'api', 'claude', 'sessions', '<id>']
      const sessionId = p.split('/')[4];
      const st = claudeCliRunner.getState(sessionId);
      if (!st) return send(res, 404, { error: 'session not found' });
      return send(res, 200, st);
    }

    // GET /api/claude/sessions/:id/token-usage — accumulated input/output tokens
    if (m === 'GET' && p.startsWith('/api/claude/sessions/') && p.endsWith('/token-usage')) {
      const sessionId = p.split('/')[4];
      if (!claudeCliRunner.getSession(sessionId)) return send(res, 404, { error: 'session not found' });
      const usage = claudeCliRunner.getSessionTokenUsage(sessionId);
      return send(res, 200, { ok: true, sessionId, ...usage });
    }

    // GET /api/claude/sessions/:id/stream — SSE stream of events
    if (m === 'GET' && p.startsWith('/api/claude/sessions/') && p.endsWith('/stream')) {
      const sessionId = p.split('/')[4];
      if (!claudeCliRunner.getSession(sessionId)) return send(res, 404, { error: 'session not found' });
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-store, no-transform',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
        'X-Accel-Buffering': 'no',
      });
      res.write(`event: claude/hello\ndata: ${JSON.stringify({ sessionId, time: new Date().toISOString() })}\n\n`);
      const unsubscribe = claudeCliRunner.subscribe(sessionId, (event) => {
        try {
          res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        } catch (e) {
          // client gone
        }
      });
      const heartbeat = setInterval(() => {
        try { res.write(`: keepalive ${Date.now()}\n\n`); } catch {}
      }, 15000);
      const cleanup = () => {
        clearInterval(heartbeat);
        try { unsubscribe(); } catch {}
      };
      req.on('close', cleanup);
      req.on('error', cleanup);
      return;  // do NOT call send() — connection stays open
    }

    // GET /api/claude/sessions-stream — global SSE channel for session lifecycle
    if (m === 'GET' && p === '/api/claude/sessions-stream') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-store, no-transform',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
        'X-Accel-Buffering': 'no',
      });
      // First frame: snapshot so the client can sync without a separate REST poll
      const snapshot = claudeCliRunner.listSessions({});
      res.write(`event: claude/snapshot\ndata: ${JSON.stringify({ sessions: snapshot })}\n\n`);
      const unsubscribe = claudeCliRunner.subscribeList((event) => {
        try {
          res.write(`event: claude/sessions-changed\ndata: ${JSON.stringify(event)}\n\n`);
        } catch { /* client gone */ }
      });
      const heartbeat = setInterval(() => {
        try { res.write(`: keepalive ${Date.now()}\n\n`); } catch {}
      }, 15000);
      const cleanup = () => {
        clearInterval(heartbeat);
        try { unsubscribe(); } catch {}
      };
      req.on('close', cleanup);
      req.on('error', cleanup);
      return; // do NOT call send() — connection stays open
    }

    // POST /api/claude/sessions/:id/input — send follow-up prompt (uses --resume)
    if (m === 'POST' && p.startsWith('/api/claude/sessions/') && p.endsWith('/input')) {
      const sessionId = p.split('/')[4];
      if (!claudeCliRunner.getSession(sessionId)) return send(res, 404, { error: 'session not found' });
      let body;
      try { body = JSON.parse(await readBody(req)); } catch { return send(res, 400, { error: 'invalid JSON body' }); }
      if (!body || typeof body.text !== 'string' || !body.text.trim()) {
        return send(res, 400, { error: 'body.text (non-empty string) required' });
      }
      try {
        const st = claudeCliRunner.getState(sessionId);
        const projects = readProjects({ persistMigrations: false });
        const project = st && st.projectSlug && projects[st.projectSlug] ? projects[st.projectSlug] : null;
        let profile = null;
        if (project) {
          const aiProfileId = project.aiProfileId;
          const profileCheck = validateUsableAiProfile(aiProfileId);
          if (!profileCheck.ok) return send(res, profileCheck.status, { ok: false, error: profileCheck.error });
          if (profileCheck.implementation !== 'claude-code-agent') {
            return send(res, 400, { ok: false, error: `Claude workbench requires claude-code-agent implementation, got ${profileCheck.implementation}` });
          }
          profile = profileCheck.profile;
        }
        const result = await claudeCliRunner.sendInput(sessionId, body.text, profile, {
          permissionMode: typeof body.permissionMode === 'string' ? body.permissionMode : undefined,
          allowedTools: Array.isArray(body.allowedTools) ? body.allowedTools : undefined,
        });
        return send(res, 200, { ok: true, sessionId, pendingPermission: result && result.pendingPermission || null });
      } catch (e) {
        return send(res, 400, { ok: false, error: e.message });
      }
    }

    // POST /api/claude/sessions/:id/permission
    if (m === 'POST' && p.startsWith('/api/claude/sessions/') && p.endsWith('/permission')) {
      const sessionId = p.split('/')[4];
      if (!claudeCliRunner.getSession(sessionId)) return send(res, 404, { error: 'session not found' });
      let body;
      try { body = JSON.parse(await readBody(req)); } catch { return send(res, 400, { error: 'invalid JSON body' }); }
      if (!body || typeof body.requestId !== 'string') {
        return send(res, 400, { error: 'body.requestId required' });
      }
      try {
        const result = claudeCliRunner.resolvePermission(sessionId, body.requestId, {
          allow: body.allow === true,
          message: typeof body.message === 'string' ? body.message : '',
        });
        return send(res, 200, { ok: true, sessionId, ...result });
      } catch (e) {
        return send(res, 400, { ok: false, error: e.message });
      }
    }

    // POST /api/claude/sessions/:id/abort — terminate current subprocess
    if (m === 'POST' && p.startsWith('/api/claude/sessions/') && p.endsWith('/abort')) {
      const sessionId = p.split('/')[4];
      if (!claudeCliRunner.getSession(sessionId)) return send(res, 404, { error: 'session not found' });
      try {
        claudeCliRunner.abort(sessionId);
        return send(res, 200, { ok: true, sessionId });
      } catch (e) {
        return send(res, 400, { ok: false, error: e.message });
      }
    }

    // GET /api/prompts — read prompt registry
    if (m === 'GET' && p === '/api/prompts') {
      return send(res, 200, promptRegistry.readPrompts());
    }

    // PUT /api/prompts — write prompt registry
    if (m === 'PUT' && p === '/api/prompts') {
      let body;
      try { body = JSON.parse(await readBody(req)); } catch { return send(res, 400, { error: 'invalid JSON body' }); }
      try {
        const written = promptRegistry.writePrompts(body);
        return send(res, 200, { ok: true, prompts: written });
      } catch (e) {
        return send(res, 400, { ok: false, error: e.message });
      }
    }

    // POST /api/projects/:slug/analyze/commits — run incremental commit analysis (TASK-008)
    if (m === 'POST' && p.startsWith('/api/projects/') && p.endsWith('/analyze/commits')) {
      const slug = p.split('/')[3];
      if (!isSafeSlug(slug)) return send(res, 400, { error: 'Invalid slug' });
      const projects = readProjects({ persistMigrations: false });
      if (!projects[slug]) return send(res, 404, { error: 'Slug not in projects.json' });
      const kbPath = projects[slug].kbPath || defaultProjectKbPath(slug);
      const result = await runCommitAnalysis({ slug, ...projects[slug], kbPath });
      if (!result.ok) {
        return send(res, result.status, { ok: false, error: result.error, runId: result.runId, run: result.runRecord });
      }
      return send(res, 200, { ok: true, slug, runId: result.runId, noop: !!result.noop, run: result.runRecord });
    }

    // GET /api/projects/:slug/runs — list run records
    if (m === 'GET' && p.startsWith('/api/projects/') && p.endsWith('/runs')) {
      const slug = p.split('/')[3];
      if (!isSafeSlug(slug)) return send(res, 400, { error: 'Invalid slug' });
      const projects = readProjects({ persistMigrations: false });
      if (!projects[slug]) return send(res, 404, { error: 'Slug not in projects.json' });
      const kbPath = projects[slug].kbPath || defaultProjectKbPath(slug);
      return send(res, 200, { ok: true, slug, runs: listRuns(kbPath) });
    }

    // GET /api/projects/:slug/runs/:runId — read a single run
    if (m === 'GET' && p.match(/^\/api\/projects\/[a-z0-9-]+\/runs\/[A-Za-z0-9_-]+$/)) {
      const parts = p.split('/');
      const slug = parts[3];
      const runId = parts[5];
      if (!isSafeSlug(slug)) return send(res, 400, { error: 'Invalid slug' });
      const projects = readProjects({ persistMigrations: false });
      if (!projects[slug]) return send(res, 404, { error: 'Slug not in projects.json' });
      const kbPath = projects[slug].kbPath || defaultProjectKbPath(slug);
      const run = readRun(kbPath, runId);
      if (!run) return send(res, 404, { error: 'run not found' });
      return send(res, 200, { ok: true, slug, run, drafts: listDrafts(kbPath, runId) });
    }

    // GET /api/projects/:slug/drafts/:runId — list drafts in a run
    if (m === 'GET' && p.match(/^\/api\/projects\/[a-z0-9-]+\/drafts\/[A-Za-z0-9_-]+$/)) {
      const parts = p.split('/');
      const slug = parts[3];
      const runId = parts[5];
      if (!isSafeSlug(slug)) return send(res, 400, { error: 'Invalid slug' });
      const projects = readProjects({ persistMigrations: false });
      if (!projects[slug]) return send(res, 404, { error: 'Slug not in projects.json' });
      const kbPath = projects[slug].kbPath || defaultProjectKbPath(slug);
      return send(res, 200, { ok: true, slug, runId, drafts: listDrafts(kbPath, runId) });
    }

    // GET /api/projects/:slug/drafts/:runId/raw?path=... — read a single draft's text
    if (m === 'GET' && p.match(/^\/api\/projects\/[a-z0-9-]+\/drafts-by-branch$/)) {
      const slug = p.split('/')[3];
      if (!isSafeSlug(slug)) return send(res, 400, { error: 'Invalid slug' });
      const branch = url.searchParams.get('branch') || '';
      const status = url.searchParams.get('status') || 'pending';
      const projects = readProjects({ persistMigrations: false });
      if (!projects[slug]) return send(res, 404, { error: 'Slug not in projects.json' });
      const kbPath = projects[slug].kbPath || defaultProjectKbPath(slug);
      const runs = listRuns(kbPath);
      const drafts = [];
      for (const run of runs) {
        if (status === 'pending' && (run.applyStatus === 'applied' || run.applyStatus === 'rejected')) continue;
        const sourceBranch = run.sourceBranch ?? 'unknown (pre-TASK-016)';
        if (branch && sourceBranch !== branch) continue;
        for (const draft of listDrafts(kbPath, run.runId)) {
          drafts.push({ ...draft, runId: run.runId, runStatus: run.status, applyStatus: run.applyStatus || 'pending', sourceBranch });
        }
      }
      return send(res, 200, { ok: true, slug, branch: branch || null, status, drafts });
    }

    if (m === 'GET' && p.match(/^\/api\/projects\/[a-z0-9-]+\/drafts\/[A-Za-z0-9_-]+\/raw$/)) {
      const parts = p.split('/');
      const slug = parts[3];
      const runId = parts[5];
      const rel = url.searchParams.get('path') || '';
      if (!isSafeSlug(slug)) return send(res, 400, { error: 'Invalid slug' });
      const projects = readProjects({ persistMigrations: false });
      if (!projects[slug]) return send(res, 404, { error: 'Slug not in projects.json' });
      const kbPath = projects[slug].kbPath || defaultProjectKbPath(slug);
      const text = readDraftContent(kbPath, runId, rel);
      if (text == null) return send(res, 404, { error: 'draft not found' });
      return send(res, 200, { ok: true, slug, runId, path: rel, content: text }, 'text/plain');
    }

    // POST /api/projects/:slug/drafts/:runId/apply — apply selected drafts to the KB (TASK-009)
    if (m === 'POST' && p.match(/^\/api\/projects\/[a-z0-9-]+\/drafts\/[A-Za-z0-9_-]+\/apply$/)) {
      const parts = p.split('/');
      const slug = parts[3];
      const runId = parts[5];
      if (!isSafeSlug(slug)) return send(res, 400, { error: 'Invalid slug' });
      const projects = readProjects({ persistMigrations: false });
      if (!projects[slug]) return send(res, 404, { error: 'Slug not in projects.json' });
      const kbPath = projects[slug].kbPath || defaultProjectKbPath(slug);
      const body = await readBody(req).catch(() => '{}');
      const parsed = (() => { try { return JSON.parse(body); } catch { return {}; } })();
      if (!Array.isArray(parsed.drafts)) return send(res, 400, { error: 'drafts array required' });
      // Default headCommitAtRun to the value recorded in the run record so callers
      // can just POST {drafts, allowGoalEdit} and have lastAnalyzedCommit advance correctly.
      const runRecord = readRun(kbPath, runId);
      const headCommitAtRun = parsed.headCommitAtRun || (runRecord && runRecord.headCommitAtRun) || null;
      const result = applyDrafts({
        kbPath,
        slug,
        runId,
        drafts: parsed.drafts,
        allowGoalEdit: !!parsed.allowGoalEdit,
        headCommitAtRun,
      });
      if (!result.ok) return send(res, result.status, { ok: false, error: result.error, ...result });
      // On successful apply, advance the project's lastAnalyzedCommit to the run's head commit
      if (headCommitAtRun) {
        projects[slug].lastAnalyzedCommit = headCommitAtRun;
        writeJson(PROJECTS_PATH, projects);
      }
      return send(res, 200, { ok: true, ...result });
    }

    // POST /api/projects/:slug/validate-kb — validate KB contract (TASK-011)
    if (m === 'POST' && p.startsWith('/api/projects/') && p.endsWith('/validate-kb')) {
      const slug = p.split('/')[3];
      if (!isSafeSlug(slug)) return send(res, 400, { error: 'Invalid slug' });
      const projects = readProjects({ persistMigrations: false });
      if (!projects[slug]) return send(res, 404, { error: 'Slug not in projects.json' });
      const kbPath = projects[slug].kbPath || defaultProjectKbPath(slug);
      const result = validateKb(kbPath);
      return send(res, result.status, { ok: result.ok, ...result });
    }

    // GET /api/projects/:slug/pr-context — build a PR consumer context pack (TASK-011)
    if (m === 'GET' && p.startsWith('/api/projects/') && p.endsWith('/pr-context')) {
      const slug = p.split('/')[3];
      if (!isSafeSlug(slug)) return send(res, 400, { error: 'Invalid slug' });
      const projects = readProjects({ persistMigrations: false });
      if (!projects[slug]) return send(res, 404, { error: 'Slug not in projects.json' });
      const kbPath = projects[slug].kbPath || defaultProjectKbPath(slug);
      const result = buildPrContextPack(kbPath);
      return send(res, result.status || (result.ok ? 200 : 422), { ok: result.ok, ...result });
    }

    // POST /api/projects/:slug/drafts/:runId/reject — reject all drafts in a run (TASK-009)
    if (m === 'POST' && p.match(/^\/api\/projects\/[a-z0-9-]+\/drafts\/[A-Za-z0-9_-]+\/reject$/)) {
      const parts = p.split('/');
      const slug = parts[3];
      const runId = parts[5];
      if (!isSafeSlug(slug)) return send(res, 400, { error: 'Invalid slug' });
      const projects = readProjects({ persistMigrations: false });
      if (!projects[slug]) return send(res, 404, { error: 'Slug not in projects.json' });
      const kbPath = projects[slug].kbPath || defaultProjectKbPath(slug);
      const body = await readBody(req).catch(() => '{}');
      const parsed = (() => { try { return JSON.parse(body); } catch { return {}; } })();
      const result = rejectDrafts({ kbPath, runId, reason: parsed.reason });
      if (!result.ok) return send(res, result.status, result);
      return send(res, 200, { ok: true, ...result });
    }

    // GET /api/schedule
    if (m === 'GET' && p === '/api/schedule') {
      return send(res, 200, await getScheduleInfo());
    }

    // PUT /api/schedule  { frequency, time?, runner? }
    if (m === 'PUT' && p === '/api/schedule') {
      const body = JSON.parse(await readBody(req));
      if (!body.frequency) return send(res, 400, { error: 'frequency required' });
      const result = await updateSchedule(body.frequency, body.time, { runner: body.runner });
      return send(res, 200, result);
    }

    // POST /api/jobs/run — run a job in one of the supported modes (TASK-010)
    if (m === 'POST' && p === '/api/jobs/run') {
      const body = await readBody(req).catch(() => '{}');
      const parsed = (() => { try { return JSON.parse(body); } catch { return {}; } })();
      const mode = parsed.mode || 'safe';
      const slug = parsed.slug || 'ALL';
      const result = startJob({ mode, slug });
      if (!result.ok) return send(res, result.status, result);
      return send(res, 200, result);
    }

    // GET /api/jobs — recent job history (persisted to .jobs-log.json)
    if (m === 'GET' && p === '/api/jobs') {
      const history = readJobLog(JOBS_LOG_PATH);
      return send(res, 200, {
        ok: true,
        history,
        running: [...runningJobs.values()].map(j => ({
          jobId: j.jobId, mode: j.mode, slug: j.slug, status: j.status,
          startTime: j.startTime, endTime: j.endTime,
        })),
        knownModes: [...KNOWN_MODES],
        lastRun,
      });
    }

    // GET /api/jobs/:jobId — read a single job (live or persisted)
    if (m === 'GET' && p.match(/^\/api\/jobs\/job-[0-9]+-[0-9]+$/)) {
      const jobId = p.split('/')[3];
      const live = runningJobs.get(jobId);
      if (live) {
        return send(res, 200, {
          ok: true, job: {
            jobId: live.jobId, mode: live.mode, slug: live.slug,
            status: live.status, startTime: live.startTime, endTime: live.endTime,
            exitCode: live.exitCode, summary: live.summary,
            output: (live.output || '').slice(-6000),
          }
        });
      }
      const history = readJobLog(JOBS_LOG_PATH);
      const persisted = history.find(j => j.jobId === jobId);
      if (!persisted) return send(res, 404, { error: 'job not found' });
      return send(res, 200, { ok: true, job: persisted });
    }

    // POST /api/script/run — backward-compat alias for /api/jobs/run with mode=safe
    if (m === 'POST' && p === '/api/script/run') {
      const body = await readBody(req).catch(() => '{}');
      const parsed = (() => { try { return JSON.parse(body); } catch { return {}; } })();
      const mode = parsed.mode || 'safe';
      const slug = parsed.slug || 'ALL';
      const result = startJob({ mode, slug });
      if (!result.ok) return send(res, result.status, result);
      return send(res, 200, result);
    }

    // GET /api/script/status — backward-compat alias
    if (m === 'GET' && p === '/api/script/status') {
      return send(res, 200, { lastRun, running: [...runningJobs.values()] });
    }

    // GET /api/dirs/:slug
    if (m === 'GET' && p.startsWith('/api/dirs/')) {
      const slug = p.split('/')[3];
      if (!isSafeSlug(slug)) return send(res, 400, { error: 'Invalid slug' });
      const projects = readProjects({ persistMigrations: false });
      if (!projects[slug]) return send(res, 404, { error: 'Slug not in projects.json' });
      const kbPath = projects[slug].kbPath || defaultProjectKbPath(slug);
      if (!fs.existsSync(kbPath)) return send(res, 404, { error: 'Project KB not initialized' });
      return send(res, 200, listSubTree(kbPath, '', 0, 3));
    }

    // GET /api/raw?path=relative  (read a markdown file under projects/)
    if (m === 'GET' && p === '/api/raw') {
      const rel = url.searchParams.get('path');
      if (!rel) return send(res, 400, { error: 'path required' });
      const abs = path.resolve(KB_ROOT, rel);
      if (!abs.startsWith(KB_ROOT)) return send(res, 403, { error: 'outside kb root' });
      if (!fs.existsSync(abs)) return send(res, 404, { error: 'not found' });
      const stat = fs.statSync(abs);
      if (stat.isDirectory()) {
        const tree = listSubTree(abs, rel.replace(/\\/g, '/') + '/', 0, 4);
        return send(res, 200, { type: 'dir', tree });
      }
      const buf = fs.readFileSync(abs);
      return send(res, 200, { type: 'file', content: buf.toString('utf-8'), size: stat.size }, 'text/plain');
    }

    // Static vendor assets (Vue / Tailwind browser bundles)
    if (m === 'GET' && p.startsWith('/vendor/')) {
      const rel = decodeURIComponent(p.slice('/vendor/'.length));
      if (rel.includes('..') || path.isAbsolute(rel)) return send(res, 400, { error: 'bad path' });
      const vendorRoot = path.join(SITE_ROOT, 'vendor');
      const abs = path.resolve(vendorRoot, rel);
      if (!abs.startsWith(vendorRoot + path.sep)) return send(res, 403, { error: 'outside vendor' });
      if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return send(res, 404, { error: 'not found' });
      const text = fs.readFileSync(abs, 'utf-8');
      const ct = abs.endsWith('.js') ? 'application/javascript'
        : abs.endsWith('.css') ? 'text/css'
        : 'application/octet-stream';
      return send(res, 200, text, ct);
    }

    send(res, 404, { error: 'Not found', path: p });
  } catch (e) {
    console.error('[server error]', e);
    send(res, 500, { error: e.message, stack: e.stack });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[kb-site] listening on http://${HOST}:${PORT}`);
  console.log(`[kb-site] KB root: ${KB_ROOT}`);
  console.log(`[kb-site] data dir: ${DATA_DIR}`);
  console.log(`[kb-site] task:    ${TASK_NAME}`);
  try {
    const orphanSummary = postCommitAutomation.cleanupOrphanedRuns(readProjects({ persistMigrations: false }));
    const orphanTotal = (orphanSummary.queued || 0) + (orphanSummary.dispatched || 0) + (orphanSummary.dispatching || 0);
    if (orphanTotal > 0) {
      console.log(`[kb-site] automation cleanup: ${orphanTotal} orphaned run(s) marked abandoned`, orphanSummary);
      logEvent('info', 'automation_cleanup', 'orphaned automation runs marked abandoned on server start', orphanSummary);
    }
  } catch (e) {
    console.error('[kb-site] automation cleanup failed:', e.message);
  }
});
