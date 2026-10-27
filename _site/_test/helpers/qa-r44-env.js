'use strict';
// _site/_test/helpers/qa-r44-env.js
//
// The R44 lane isolation helper (WB-006 / WB-007).
//
// Contract (from the lane dispatch):
//   * the driver's FIRST action is to capture the real environment and the
//     real tool paths, and then to harden the driver's OWN process.env, so
//     that every child process it spawns inherits the isolation. The product
//     is never bootstrapped under the real environment first;
//   * HOME / USERPROFILE / HOMEDRIVE / HOMEPATH / APPDATA / LOCALAPPDATA /
//     CODEX_HOME / CLAUDE_CONFIG_DIR / TEMP / TMP / TMPDIR are redirected;
//   * KB_DATA_DIR and KB_KNOWLEDGE_DATA_DIR are redirected;
//   * the Workbench data dir and the Bridge home are redirected;
//   * the temp root lives OUTSIDE the repository;
//   * the ambient module addresses and every ambient model credential are
//     dropped, so a call can only reach the profile the product resolves
//     itself, in memory;
//   * the live product ports are refused.
//
// The real Chrome executable and the real Claude Code executable are captured
// BEFORE the environment is hardened (the R33 lesson: Chrome and the CLI are
// resolved from LOCALAPPDATA / APPDATA, and those are exactly the variables
// this lane isolates). They are re-published to the isolated environment as
// KB_CHROME_PATH and CLAUDE_CODE_EXECPATH, so the isolation never turns into
// a "tool not found" failure.
//
// Credential contract: no credential value is read, copied, logged, written
// to a fixture or reported. Only variable NAMES are ever recorded.
//
// R44C: the lane no longer depends on the older batch fixture. It uses the
// CANONICAL tracked fixture (helpers/parallel-workbench-integration-5025-
// fixture.js) — the same one the tracked runtime harness uses — so the lane's
// layout and the harness' child environment are built by one contract. The two
// directory-digest helpers the lane needs are implemented here, in the lane's
// own file, so the old fixture leaves the dependency closure entirely.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const fixture = require('./parallel-workbench-integration-5025-fixture');
const { findChromeDetailed } = require('./find-chrome');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const LANE_NAME = 'wb-permission-question-r44';

// Ambient module addresses that would point a lane at a live instance.
const AMBIENT_MODULE_URLS = [
  'KB_KNOWLEDGE_ENGINE_URL',
  'KB_VECTORHUB_URL',
  'KB_TERMINAL_URL',
  'KB_EVENTBRIDGE_URL',
  'KB_EVENT_BRIDGE_URL',
  'KB_WORKBENCH_RUNTIME_TOKEN',
  'KB_MODULES_AUTOSTART',
];

// Ambient model credentials. A lane may only use the credential the product
// resolves from its own read-only profile store, in memory.
const AMBIENT_MODEL_ENV = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_THINKING_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'API_TIMEOUT_MS',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
];

// The variables this lane redirects. Every one of them must point inside the
// lane's own run root once the driver is hardened.
const REDIRECTED_VARS = [
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'CODEX_HOME',
  'CLAUDE_CONFIG_DIR',
  'TEMP',
  'TMP',
  'TMPDIR',
  'KB_DATA_DIR',
  'KB_KNOWLEDGE_DATA_DIR',
  'AGENT_TERMINAL_DATA_DIR',
  'CLAUDE_AI_WORKBENCH_DATA_DIR',
  'AI_CODING_EVENT_BRIDGE_HOME',
];

function isInside(candidate, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

// The real profile store of the product. It is resolved while the REAL
// environment is still in place: this module is loaded before the driver
// hardens its own environment, and os.homedir() reads the REDIRECTED
// USERPROFILE once the isolation is applied. The value is therefore captured
// at load time and refreshed by the capture, never re-derived later.
let REAL_PROFILE_DIR = path.join(os.homedir(), '.project-knowledge-v5', 'workbench');
function realProfileDir() { return REAL_PROFILE_DIR; }

// The lane's own temp root, outside the repository and outside the real
// home. Portable: it follows the repository location, never a fixed drive.
function resolveLaneTempRoot() {
  const override = String(process.env.QA_R44_TEMP_ROOT || '').trim();
  const base = override
    ? path.resolve(override)
    : path.join(path.dirname(REPO_ROOT), '.project-knowledge-test-temp');
  const root = path.join(base, LANE_NAME);
  if (isInside(root, REPO_ROOT)) throw new Error(`refusing a lane temp root inside the repository: ${root}`);
  fs.mkdirSync(root, { recursive: true });
  return root;
}

// The real Claude Code executable, resolved the way the product resolves it
// but WITHOUT loading the product module (loading it would boot its own
// session housekeeping inside the driver).
function findClaudeExecutable() {
  const rejected = [];
  const push = (file, source) => {
    if (!file) return;
    try {
      if (!fs.statSync(file).isFile()) { rejected.push({ path: file, reason: 'not a file' }); return; }
    } catch { rejected.push({ path: file, reason: 'missing' }); return; }
    return { path: path.resolve(file), source };
  };
  const override = String(process.env.CLAUDE_CODE_EXECPATH || '').trim();
  if (override) {
    const found = push(override, 'environment');
    if (found) return found;
  }
  const packageDirs = [];
  if (process.env.APPDATA) packageDirs.push(path.join(process.env.APPDATA, 'npm', 'node_modules', '@anthropic-ai', 'claude-code'));
  for (const dir of packageDirs) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
      const bin = typeof pkg.bin === 'string' ? pkg.bin : (pkg.bin && pkg.bin.claude) || null;
      if (bin) {
        const entry = path.join(dir, ...String(bin).split(/[\\/]+/).filter(Boolean));
        const found = push(entry, 'npm-global-package');
        if (found) return found;
      }
    } catch { /* the package is simply not there */ }
    const found = push(path.join(dir, 'bin', 'claude.exe'), 'npm-global-package');
    if (found) return found;
  }
  const userProfile = process.env.USERPROFILE || '';
  if (userProfile) {
    const found = push(path.join(userProfile, '.local', 'bin', 'claude.exe'), 'user-local-bin');
    if (found) return found;
  }
  if (process.env.LOCALAPPDATA) {
    for (const candidate of [
      path.join(process.env.LOCALAPPDATA, 'Programs', 'claude-code', 'claude.exe'),
      path.join(process.env.LOCALAPPDATA, 'claude-code', 'claude.exe'),
    ]) {
      const found = push(candidate, 'localappdata');
      if (found) return found;
    }
  }
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const found = push(path.join(dir, 'claude.exe'), 'path');
    if (found) return found;
  }
  const whereExe = process.env.WINDIR ? path.join(process.env.WINDIR, 'System32', 'where.exe') : 'where.exe';
  try {
    const stdout = execFileSync(whereExe, ['claude'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: 5000 });
    for (const hit of String(stdout).split(/\r?\n/).map(entry => entry.trim()).filter(Boolean)) {
      const found = push(hit, 'where');
      if (found) return found;
    }
  } catch { /* where.exe found nothing */ }
  throw new Error(`Claude Code executable not found for the ${LANE_NAME} lane; rejected: ${JSON.stringify(rejected)}`);
}

// The real environment, captured BEFORE anything is hardened.
function captureRealEnvironment() {
  const realHome = os.homedir();
  const realUserProfile = process.env.USERPROFILE || realHome;
  const chrome = findChromeDetailed();
  const claude = findClaudeExecutable();
  const present = (name) => Object.keys(process.env).some(key => key.toUpperCase() === name && String(process.env[key] || '').trim() !== '');
  REAL_PROFILE_DIR = path.join(realHome, '.project-knowledge-v5', 'workbench');
  return {
    realHome,
    realUserProfile,
    realProfileDir: REAL_PROFILE_DIR,
    chrome: { path: chrome.path, source: chrome.source },
    claude: { path: claude.path, source: claude.source },
    ambientModuleUrlsPresent: AMBIENT_MODULE_URLS.filter(present),
    ambientCredentialsPresent: AMBIENT_MODEL_ENV.filter(present),
  };
}

// The lane's own isolation layout. It reuses the canonical fixture layout so
// the frozen host helper can host it unchanged, and adds the directories this
// lane has to isolate on its own.
function createLaneLayout() {
  const laneTempRoot = resolveLaneTempRoot();
  // The canonical fixture resolves its temp root from this variable, so the
  // lane root is published BEFORE the layout is created: the whole run then
  // lives under one lane-owned directory outside the repository.
  process.env.PK_TEST_TEMP_ROOT = laneTempRoot;
  const layout = fixture.createIsolationLayout('qa-r44');
  layout.laneTempRoot = laneTempRoot;
  layout.logs = path.join(laneTempRoot, 'logs');
  fs.mkdirSync(layout.logs, { recursive: true });
  // Chrome refuses remote debugging when the profile root it resolves is
  // missing, so the empty scaffold is created (the R33 lesson). The canonical
  // fixture already creates the home-shaped one; the LOCALAPPDATA-shaped one
  // is kept because the lane redirects LOCALAPPDATA as well.
  for (const scaffold of [
    path.join(layout.localAppData, 'Google', 'Chrome', 'User Data'),
    path.join(layout.home, 'AppData', 'Local', 'Google', 'Chrome', 'User Data'),
  ]) {
    fs.mkdirSync(scaffold, { recursive: true });
  }
  return layout;
}

// Harden the DRIVER's own environment. Every child process this driver
// spawns afterwards inherits it; nothing is bootstrapped under the real
// environment first.
function hardenDriverEnv(layout, captured) {
  const parsed = path.parse(layout.home);
  const redirected = {
    HOME: layout.home,
    USERPROFILE: layout.home,
    HOMEDRIVE: parsed.root,
    HOMEPATH: parsed.root === path.sep ? layout.home.slice(1) : layout.home.slice(parsed.root.length),
    APPDATA: layout.appData,
    LOCALAPPDATA: layout.localAppData,
    CODEX_HOME: layout.codexHome,
    CLAUDE_CONFIG_DIR: layout.claudeConfigDir,
    TEMP: layout.temp,
    TMP: layout.temp,
    TMPDIR: layout.temp,
    KB_DATA_DIR: layout.knowledgeDataDir,
    KB_KNOWLEDGE_DATA_DIR: layout.knowledgeDataDir,
    AGENT_TERMINAL_DATA_DIR: layout.dataDir,
    CLAUDE_AI_WORKBENCH_DATA_DIR: layout.dataDir,
    AI_CODING_EVENT_BRIDGE_HOME: layout.bridgeHome,
  };
  const droppedModuleUrls = [];
  const droppedCredentials = [];
  for (const name of AMBIENT_MODULE_URLS) {
    if (process.env[name] !== undefined) { delete process.env[name]; droppedModuleUrls.push(name); }
  }
  for (const name of AMBIENT_MODEL_ENV) {
    if (process.env[name] !== undefined) { delete process.env[name]; droppedCredentials.push(name); }
  }
  for (const [name, value] of Object.entries(redirected)) process.env[name] = value;
  // The isolated fixture layout is the temp root of the frozen helper too.
  process.env.PK_TEST_TEMP_ROOT = layout.laneTempRoot;
  process.env.KB_MODULES_AUTOSTART = '0';
  // The real tools are captured before the isolation and re-published as
  // absolute paths, so isolating APPDATA / LOCALAPPDATA never hides them.
  process.env.KB_CHROME_PATH = captured.chrome.path;
  process.env.CLAUDE_CODE_EXECPATH = captured.claude.path;
  // The canonical harness refuses to discover a browser from an isolated
  // environment: it wants the path that was captured BEFORE the isolation.
  // It is published under both names its callers accept.
  process.env.PK_WB_CHROME = captured.chrome.path;
  // The product resolves the ORIGINAL profile store from the real home; the
  // isolated HOME would otherwise hide it. The path is a location, not a
  // credential: the store itself is opened read-only by the product.
  process.env.PK_WB_REAL_PROFILE_DIR = captured.realProfileDir;
  return {
    redirected: Object.keys(redirected),
    redirectedValues: redirected,
    droppedModuleUrls,
    droppedCredentials,
    republishedTools: { KB_CHROME_PATH: captured.chrome.path, PK_WB_CHROME: captured.chrome.path, CLAUDE_CODE_EXECPATH: captured.claude.path },
    preservedRealProfileDir: captured.realProfileDir,
  };
}

// Fail-closed check of the hardened environment.
function assertIsolatedEnv(env, layout, captured) {
  const problems = [];
  for (const name of REDIRECTED_VARS) {
    const value = env[name];
    if (!value) { problems.push(`${name} is not set`); continue; }
    // HOMEDRIVE and HOMEPATH are one Windows pair: they are checked as a
    // whole below, not as two independent directories.
    if (name === 'HOMEDRIVE' || name === 'HOMEPATH') continue;
    if (!isInside(value, layout.root)) problems.push(`${name} points outside the lane run root: ${value}`);
  }
  if (env.HOMEDRIVE && env.HOMEPATH) {
    const combined = path.resolve(`${env.HOMEDRIVE}${env.HOMEPATH}`);
    if (!isInside(combined, layout.root)) problems.push(`HOMEDRIVE+HOMEPATH points outside the lane run root: ${combined}`);
    else if (env.HOME && path.resolve(combined).toLowerCase() !== path.resolve(env.HOME).toLowerCase()) {
      problems.push(`HOMEDRIVE+HOMEPATH and HOME disagree: ${combined} vs ${env.HOME}`);
    }
  } else {
    problems.push('HOMEDRIVE and HOMEPATH are not both set');
  }
  if (env.USERPROFILE && captured.realUserProfile && path.resolve(env.USERPROFILE).toLowerCase() === path.resolve(captured.realUserProfile).toLowerCase()) {
    problems.push('USERPROFILE still points at the real user profile');
  }
  if (env.HOME && captured.realHome && path.resolve(env.HOME).toLowerCase() === path.resolve(captured.realHome).toLowerCase()) {
    problems.push('HOME still points at the real home');
  }
  for (const name of AMBIENT_MODEL_ENV) {
    if (env[name] !== undefined && String(env[name] || '').trim() !== '') problems.push(`credential variable survived: ${name}`);
  }
  for (const name of AMBIENT_MODULE_URLS) {
    if (name === 'KB_MODULES_AUTOSTART') continue;
    if (env[name] !== undefined && String(env[name] || '').trim() !== '') problems.push(`ambient module address survived: ${name}`);
  }
  if (path.resolve(env.PK_TEST_TEMP_ROOT || '') === path.resolve(REPO_ROOT)) problems.push('the lane temp root is the repository root');
  if (isInside(env.PK_TEST_TEMP_ROOT || '', REPO_ROOT)) problems.push('the lane temp root is inside the repository');
  if (problems.length) throw new Error(`the lane environment is not isolated:\n  - ${problems.join('\n  - ')}`);
  return true;
}

// A report-friendly summary. It carries paths and variable NAMES only; no
// credential value is ever read, copied or printed.
function isolationContract(layout, captured, hardened) {
  return {
    lane: LANE_NAME,
    repoRoot: REPO_ROOT,
    runRoot: layout.root,
    laneTempRoot: layout.laneTempRoot,
    tempRootOutsideRepository: !isInside(layout.laneTempRoot, REPO_ROOT),
    redirectedVariables: hardened.redirected,
    redirectedValues: hardened.redirectedValues,
    droppedAmbientModuleUrls: hardened.droppedModuleUrls,
    droppedAmbientCredentials: hardened.droppedCredentials,
    ambientModuleUrlsPresentBefore: captured.ambientModuleUrlsPresent,
    ambientCredentialsPresentBefore: captured.ambientCredentialsPresent,
    republishedTools: hardened.republishedTools,
    realProfileDirectory: captured.realProfileDir,
    realProfileOpened: 'read-only by the product; the credential stays in the host process memory',
    forbiddenPorts: Array.from(fixture.FORBIDDEN_PORTS),
    realHomeUsed: false,
  };
}

// Explicit containment: every path a lane tool touches must live under
// `root`. No globbing, no traversal, no absolute path outside the root.
function containedPath(root, rel) {
  const target = path.resolve(root, ...String(rel).split(/[\\/]+/).filter(Boolean));
  const relative = path.relative(path.resolve(root), target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`path escapes its root: ${rel}`);
  }
  return target;
}

// The byte-level digest of every file of a directory. Only the NAMES and the
// digests are kept; the content is never copied anywhere. The comparison is
// done in memory and the digests of a real profile store are never printed.
function digestDirectory(dir) {
  if (!dir || !fs.existsSync(dir)) return null;
  const entries = {};
  for (const name of fs.readdirSync(dir)) {
    try {
      const file = path.join(dir, name);
      if (!fs.statSync(file).isFile()) continue;
      entries[name] = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    } catch { entries[name] = null; }
  }
  return entries;
}

function compareDigests(before, after) {
  const names = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  const changed = [];
  const added = [];
  const removed = [];
  const unreadable = [];
  for (const name of names) {
    const a = before ? before[name] : undefined;
    const b = after ? after[name] : undefined;
    if (a === undefined && b !== undefined) added.push(name);
    else if (a !== undefined && b === undefined) removed.push(name);
    else if (a === null || b === null) unreadable.push(name);
    else if (a !== b) changed.push(name);
  }
  return {
    count: names.size,
    byteIdentical: changed.length === 0 && added.length === 0 && removed.length === 0 && unreadable.length === 0,
    changedFiles: changed,
    addedFiles: added,
    removedFiles: removed,
    unreadableFiles: unreadable,
  };
}

module.exports = {
  LANE_NAME,
  REPO_ROOT,
  REDIRECTED_VARS,
  AMBIENT_MODULE_URLS,
  AMBIENT_MODEL_ENV,
  isInside,
  realProfileDir,
  resolveLaneTempRoot,
  captureRealEnvironment,
  createLaneLayout,
  hardenDriverEnv,
  assertIsolatedEnv,
  isolationContract,
  containedPath,
  digestDirectory,
  compareDigests,
};
