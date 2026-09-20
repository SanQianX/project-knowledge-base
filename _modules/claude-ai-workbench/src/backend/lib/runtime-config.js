const path = require('path');
const os = require('os');

const PRESETS = {
  workbench: {
    appName: 'claude-ai-workbench',
    defaultDataDirName: '.claude-ai-workbench',
    dataDirEnvVars: ['CLAUDE_AI_WORKBENCH_DATA_DIR', 'KB_DATA_DIR', 'DEV_TASK_RADAR_CLAUDE_DATA_DIR'],
    sessionDirName: 'claude-workbench',
    sessionSchema: 'claude-workbench-session/v1',
    legacySessionDirNames: ['claude-terminal'],
    legacySessionSchemas: ['devtask-radar-claude-session/v1'],
    suppressHooksEnv: '',
    fakeClaudeEnvVar: 'KB_AUTOMATION_FAKE_CLAUDE',
    staleActiveEnvVar: 'KB_STALE_ACTIVE_MS',
  },
  projectKnowledge: {
    appName: 'project-knowledge',
    defaultDataDirName: '.project-knowledge',
    dataDirEnvVars: ['KB_DATA_DIR'],
    sessionDirName: 'claude-workbench',
    sessionSchema: 'claude-workbench-session/v1',
    legacySessionDirNames: [],
    legacySessionSchemas: [],
    suppressHooksEnv: '',
    fakeClaudeEnvVar: 'KB_AUTOMATION_FAKE_CLAUDE',
    staleActiveEnvVar: 'KB_STALE_ACTIVE_MS',
  },
  devTaskRadar: {
    appName: 'devtask-radar',
    defaultDataDirName: '.devtask-radar',
    dataDirEnvVars: ['DEV_TASK_RADAR_CLAUDE_DATA_DIR', 'DEV_TASK_RADAR_ANALYSIS_DATA_DIR', 'KB_DATA_DIR'],
    sessionDirName: 'claude-terminal',
    sessionSchema: 'devtask-radar-claude-session/v1',
    legacySessionDirNames: ['claude-workbench'],
    legacySessionSchemas: ['claude-workbench-session/v1'],
    suppressHooksEnv: 'DEV_TASK_RADAR_SUPPRESS_HOOKS',
    fakeClaudeEnvVar: 'KB_AUTOMATION_FAKE_CLAUDE',
    staleActiveEnvVar: 'KB_STALE_ACTIVE_MS',
  },
};

const DEFAULTS = {
  ...PRESETS.workbench,
  aiRootDirName: '_ai',
  projectsFileName: 'projects.json',
  promptsFileName: 'claude-prompts.json',
  bundledPromptsPath: path.resolve(__dirname, '..', '..', 'assets', 'claude-prompts.json'),
  standardSubdirs: ['drafts', 'runs', 'context-packs', 'backups'],
  suppressHooksValue: '1',
};

let runtimeConfig = { ...DEFAULTS };

function normalizeArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value.filter(Boolean).map(String) : [String(value)];
}

function mergeConfig(base, override = {}) {
  const next = { ...base, ...(override || {}) };
  next.dataDirEnvVars = normalizeArray(next.dataDirEnvVars);
  next.legacySessionDirNames = normalizeArray(next.legacySessionDirNames);
  next.legacySessionSchemas = normalizeArray(next.legacySessionSchemas);
  next.standardSubdirs = normalizeArray(next.standardSubdirs);
  return next;
}

function configureWorkbench(options = {}) {
  runtimeConfig = mergeConfig(runtimeConfig, options);
  return getWorkbenchConfig();
}

function configurePreset(name, options = {}) {
  const preset = PRESETS[name];
  if (!preset) throw new Error(`unknown Claude AI workbench preset: ${name}`);
  runtimeConfig = mergeConfig({ ...DEFAULTS, ...preset }, options);
  return getWorkbenchConfig();
}

function getWorkbenchConfig() {
  return mergeConfig({}, runtimeConfig);
}

function firstEnv(names) {
  for (const name of normalizeArray(names)) {
    const value = process.env[name];
    if (value) return value;
  }
  return '';
}

function resolveDataDir() {
  const cfg = getWorkbenchConfig();
  const explicit = cfg.dataDir || firstEnv(cfg.dataDirEnvVars);
  return explicit
    ? path.resolve(explicit)
    : path.join(os.homedir(), cfg.defaultDataDirName || '.claude-ai-workbench');
}

function sessionDirNames() {
  const cfg = getWorkbenchConfig();
  return [cfg.sessionDirName || 'claude-workbench', ...normalizeArray(cfg.legacySessionDirNames)]
    .filter((value, index, arr) => value && arr.indexOf(value) === index);
}

function sessionSchemas() {
  const cfg = getWorkbenchConfig();
  return [cfg.sessionSchema || 'claude-workbench-session/v1', ...normalizeArray(cfg.legacySessionSchemas)]
    .filter((value, index, arr) => value && arr.indexOf(value) === index);
}

module.exports = {
  PRESETS,
  configureWorkbench,
  configurePreset,
  getWorkbenchConfig,
  resolveDataDir,
  sessionDirNames,
  sessionSchemas,
};
