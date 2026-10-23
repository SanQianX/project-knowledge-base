'use strict';
// P-QA-LOG-INTEGRATION-5025 portability gate (canonical tracked regression
// entry for the logging acceptance / logging-safety lane).
//
// This entry does NOT re-run the acceptance drivers. It proves the
// PORTABILITY contract that lets those drivers enter the canonical
// cross-platform `npm test`:
//
//   1. No machine-specific absolute path survives in any lane file
//      (comments excluded; string literals are executable and are scanned).
//   2. The isolation helper installs a complete, own environment before any
//      product module loads: temp root OUTSIDE the source repository, own
//      HOME/USERPROFILE/CODEX_HOME/CLAUDE_CONFIG_DIR/APPDATA/LOCALAPPDATA/
//      TEMP/TMP/TMPDIR, own dual KB data roots, own Bridge / agent-terminal /
//      workbench roots. The developer's real configuration is never used.
//   3. Every require() target of every lane entry resolves to a file that is
//      either git-tracked or explicitly declared in this lane's manifest, so
//      a clean checkout of tracked source can execute the entries (no
//      dependency on untracked fixtures or local drive letters).
//   4. The run-all / manual-QA classification matches the runner's own rule
//      (read from run-all-tests.js), and the frozen R1 exploration probes are
//      not submitted as canonical entries.
//   5. No lane entry performs a real model/provider call; the entries that
//      need an analyzer use the labelled offline stand-in.
//   6. The default evidence directories are inside a gitignored tree.
//   7. (P-LOGGING-ISOLATION-R2) The driver environment itself is sanitized:
//      a poisoned environment proves that ambient provider keys, proxies,
//      NODE_OPTIONS, module endpoints and CLI-injected configuration do not
//      survive the install, that the entry's explicit lane values do, that a
//      grandchild process inherits the same clean base, and that the real
//      browser executable is still resolvable after HOME/LOCALAPPDATA moved.
//   8. (P-LOGGING-PS-BROWSER-R3) The remaining isolation details are proven
//      as well: PSModuleAnalysisCachePath is a FILE path whose parent
//      directory exists and that a normal own PowerShell child can use; the
//      browser default profile Chrome derives from USERPROFILE is scaffolded
//      inside the owned home (never the developer's real profile); and the
//      lane tree is really removed when the entry releases it.
//
// Strict mode: set PK_LOGGING_GATE_STRICT_TRACKED=1 to additionally require
// every manifest file to be committed to Git (the commit step belongs to the
// Leader, not to this lane).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  installLoggingTestEnv, resolveEvidenceDir, isInsideRepo,
  DEAD_MODULE_URL, MODULE_URL_KEYS, MODULE_FLAG_KEYS, MODULE_COMMAND_KEYS,
} = require('./helpers/parallel-logging-integration-5025-env');

const ROOT = path.resolve(__dirname, '../..');
const ARTIFACTS = resolveEvidenceDir(path.resolve(ROOT, 'qa-autopilot/artifacts/parallel-20261023/logging-integration-5025/evidence/portability'));

// Every file this lane owns and hands to the Leader for the canonical commit.
const LANE_MANIFEST = [
  '_site/_test/parallel-logging-acceptance-log003-test.js',
  '_site/_test/parallel-logging-acceptance-log004-test.js',
  '_site/_test/parallel-logging-acceptance-log005-test.js',
  '_site/_test/parallel-logging-acceptance-log006-test.js',
  '_site/_test/parallel-logging-acceptance-log007-test.js',
  '_site/_test/parallel-logging-acceptance-log008-test.js',
  '_site/_test/parallel-logging-fix-r2-normalhook-test.js',
  '_site/_test/parallel-logging-fix-r2-gap-test.js',
  '_site/_test/helpers/parallel-logging-acceptance-fixture.js',
  '_site/_test/helpers/parallel-logging-acceptance-proxy.js',
  '_site/_test/helpers/parallel-logging-fix-r2-proxy.js',
  '_site/_test/helpers/parallel-logging-integration-5025-env.js',
  '_site/_test/parallel-logging-integration-5025-portability-test.js',
];

// The R1 exploration probes: frozen history, never canonical entries.
const FROZEN_EXPLORATION = [
  '_site/_test/parallel-logging-acceptance-log003-probe.js',
  '_site/_test/parallel-logging-acceptance-log004-probe.js',
];

// Manual-QA-only entry (not matched by the runner glob; needs --expect).
const MANUAL_ONLY = '_site/_test/parallel-logging-fix-r2-crash-probe.js';
LANE_MANIFEST.push(MANUAL_ONLY);

const SCAN_FILES = Array.from(new Set(LANE_MANIFEST));

const AUTOMATIC_ENTRIES = LANE_MANIFEST.filter(file => file.endsWith('-test.js') && file.includes('/parallel-logging-'));

const REQUIRED_ENV_KEYS = [
  'HOME',
  'USERPROFILE',
  'CODEX_HOME',
  'CLAUDE_CONFIG_DIR',
  'APPDATA',
  'LOCALAPPDATA',
  'TEMP',
  'TMP',
  'TMPDIR',
  'PSModuleAnalysisCachePath',
  'KB_DATA_DIR',
  'KB_KNOWLEDGE_DATA_DIR',
  'AI_CODING_EVENT_BRIDGE_HOME',
  'AGENT_TERMINAL_DATA_DIR',
  'CLAUDE_AI_WORKBENCH_DATA_DIR',
];

// P-LOGGING-ISOLATION-R2: the poisoned environment. Every value here is
// fabricated - the sentinel never reads a real key and never contacts a real
// host. The point is to prove what the install REMOVES and what it KEEPS.
const POISON_ENV = {
  MINIMAX_API_KEY: 'poison-fabricated-key',
  ANTHROPIC_API_KEY: 'poison-fabricated-key',
  OPENAI_API_KEY: 'poison-fabricated-key',
  KB_SITE_AUTH_TOKEN: 'poison-fabricated-token',
  KB_WORKBENCH_RUNTIME_TOKEN: 'poison-fabricated-token',
  HTTP_PROXY: 'http://poison-user:poison-password@proxy.invalid:1',
  HTTPS_PROXY: 'http://poison-user:poison-password@proxy.invalid:1',
  ALL_PROXY: 'http://poison-user:poison-password@proxy.invalid:1',
  NODE_OPTIONS: '--require poison-never-loaded.js',
  ANTHROPIC_BASE_URL: 'http://poison.invalid:1/',
  KB_TERMINAL_URL: 'http://poison.invalid:1/',
  KB_VECTORHUB_URL: 'http://poison.invalid:1/',
  KB_KNOWLEDGE_ENGINE_URL: 'http://poison.invalid:1/',
  KB_EVENTBRIDGE_URL: 'http://poison.invalid:1/',
  KB_MODULES_AUTOSTART: '1',
  KB_MODULES_REGISTER: '1',
  KB_TERMINAL_COMMAND: 'poison-never-executed',
  GIT_CONFIG_GLOBAL: 'poison-git-config',
  GIT_DIR: 'poison-git-dir',
  KB_AUTOMATION_FAKE_CLAUDE: 'ambient-fake-marker',
};

// The lane paths that must be redirected away from any ambient value.
// LOCALAPPDATA is deliberately NOT poisoned: the helper resolves the real
// browser executable from it BEFORE any path moves, so poisoning it here
// would hide the per-user Chrome install. Its redirection is proven by the
// lane-root containment check below.
const POISON_PATH_KEYS = [
  'HOME', 'USERPROFILE', 'APPDATA', 'TEMP', 'TMP', 'TMPDIR',
  'PSModuleAnalysisCachePath', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR',
  'KB_DATA_DIR', 'KB_KNOWLEDGE_DATA_DIR', 'AI_CODING_EVENT_BRIDGE_HOME',
  'AGENT_TERMINAL_DATA_DIR', 'CLAUDE_AI_WORKBENCH_DATA_DIR',
];

// The explicit lane values the entry owns. They are applied AFTER the
// sanitization and must survive it.
const LANE_OVERRIDES = {
  KB_AUTOMATION_FAKE_CLAUDE: '1',
  KB_EMBEDDING_FAKE: '1',
};

const stripComments = source => source
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

const git = args => {
  const res = spawnSync('git', ['-C', ROOT, ...args], { encoding: 'utf8' });
  if (res.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr || res.stdout}`);
  return res.stdout.trim();
};

const isTracked = file => {
  const res = spawnSync('git', ['-C', ROOT, 'ls-files', '--error-unmatch', '--', file], { encoding: 'utf8' });
  return res.status === 0;
};

const isIgnored = file => {
  const res = spawnSync('git', ['-C', ROOT, 'check-ignore', '-q', '--', file]);
  return res.status === 0;
};

function requiresOf(file) {
  const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const targets = [];
  const pattern = /require\(\s*'([^']+)'\s*\)/g;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    const target = match[1];
    if (target.startsWith('node:')) continue;
    targets.push(target);
  }
  return targets;
}

function main() {
  fs.mkdirSync(ARTIFACTS, { recursive: true });
  const evidence = { caseId: 'P-QA-LOG-INTEGRATION-5025-portability', startedAt: new Date().toISOString(), checks: {} };
  const failures = [];

  git(['rev-parse', '--is-inside-work-tree']);

  // 1. No machine-specific absolute path in any lane file.
  const absolutePathHits = [];
  // Built from parts so this gate's own source does not contain the needle.
  const OLD_TEMP_BASE_NAME = ['.project-knowledge', 'test-temp'].join('-');
  for (const file of SCAN_FILES) {
    const code = stripComments(fs.readFileSync(path.join(ROOT, file), 'utf8'));
    // A drive letter only counts when it starts a path, not inside a URL
    // scheme such as "http://".
    const matches = code.match(/(?<![A-Za-z0-9_])[A-Za-z]:[\\/][^\s'"`)]*/g) || [];
    const oldTempBase = code.includes(OLD_TEMP_BASE_NAME) ? [OLD_TEMP_BASE_NAME] : [];
    if (matches.length || oldTempBase.length) absolutePathHits.push({ file, matches, oldTempBase });
  }
  evidence.checks.noMachineSpecificPath = { scannedFiles: SCAN_FILES.length, hits: absolutePathHits };
  if (absolutePathHits.length) failures.push(`machine-specific absolute path in: ${absolutePathHits.map(hit => hit.file).join(', ')}`);

  // 1b. Every manifest file exists.
  const missingManifest = SCAN_FILES.filter(file => !fs.existsSync(path.join(ROOT, file)));
  evidence.checks.manifestExists = { missing: missingManifest };
  if (missingManifest.length) failures.push(`manifest files missing: ${missingManifest.join(', ')}`);

  // 2. Isolation contract of the helper, proven against a POISONED ambient
  //    environment (P-LOGGING-ISOLATION-R2). Redirecting a few directories is
  //    not isolation: the driver's own environment still reached every child
  //    process. The poison below is fabricated - no real key is read.
  const realHome = process.env.USERPROFILE || process.env.HOME;
  const ambientLocalAppData = process.env.LOCALAPPDATA;
  const ambientTmp = os.tmpdir();
  const poisonPaths = {};
  for (const key of POISON_PATH_KEYS) {
    poisonPaths[key] = path.join(ambientTmp, `poison-${key.toLowerCase()}`);
    process.env[key] = poisonPaths[key];
  }
  for (const [key, value] of Object.entries(POISON_ENV)) process.env[key] = value;
  // A tool-controlled knob: it must survive the sanitization and be honored.
  const toolTempRoot = path.join(ambientTmp, 'pk-logging-gate-poison-temp');
  process.env.PK_TEST_TEMP_ROOT = toolTempRoot;

  // The browser that is resolvable BEFORE the install: after HOME/LOCALAPPDATA
  // move it must still be reachable, otherwise the entries would fall back to
  // the developer's real browser profile.
  let preInstallChrome = null;
  try { preInstallChrome = require('./helpers/find-chrome').findChromeDetailed(); } catch {}

  const lane = installLoggingTestEnv({
    caseId: 'P-QA-LOG-INTEGRATION-5025-portability',
    prefix: 'logport',
    extraEnv: LANE_OVERRIDES,
  });
  const installed = {};
  for (const key of REQUIRED_ENV_KEYS) installed[key] = process.env[key];
  const envProblems = [];
  for (const key of REQUIRED_ENV_KEYS) {
    const value = installed[key];
    if (!value || !path.isAbsolute(value)) envProblems.push(`${key} is not an absolute path: ${value}`);
    else if (!value.startsWith(lane.laneTmp)) envProblems.push(`${key} escapes the lane temp root: ${value}`);
  }
  if (isInsideRepo(lane.tempRoot)) envProblems.push(`temp root is inside the repository: ${lane.tempRoot}`);
  if (installed.HOME === realHome) envProblems.push('HOME still points at the developer profile');
  const evidenceDir = resolveEvidenceDir(path.join(ROOT, 'qa-autopilot/artifacts/parallel-20261023/logging-integration-5025/evidence/portability'), { PK_TEST_EVIDENCE_ROOT: path.join(lane.laneTmp, 'evidence-root') });
  if (evidenceDir !== path.join(lane.laneTmp, 'evidence-root', 'portability')) envProblems.push(`PK_TEST_EVIDENCE_ROOT override not honoured: ${evidenceDir}`);
  evidence.checks.isolation = {
    tempRoot: lane.tempRoot,
    tempRootOutsideRepo: !isInsideRepo(lane.tempRoot),
    laneTmp: lane.laneTmp,
    installedEnvKeys: installed,
    isolatedEnvKeys: lane.isolatedEnvKeys,
    evidenceOverride: evidenceDir,
    problems: envProblems,
  };
  if (envProblems.length) failures.push(`isolation contract violated: ${envProblems.join('; ')}`);

  // 2b. Poisoned-environment sentinel: what the install removes, what it
  //     keeps, what a grandchild inherits, and what the browser resolves to.
  const sentinelProblems = [];
  const sentinel = { poison: {}, removed: [], overrides: {}, child: null, chrome: {} };
  const laneOwnedKeys = new Set([...MODULE_URL_KEYS, ...MODULE_FLAG_KEYS, ...MODULE_COMMAND_KEYS]);

  for (const [key, value] of Object.entries(POISON_ENV)) {
    sentinel.poison[key] = value;
    const current = process.env[key];
    if (laneOwnedKeys.has(key)) {
      // Module endpoints / switches are reset to the lane's own values.
      if (current === value) sentinelProblems.push(`${key} kept the poisoned ambient value`);
      sentinel.overrides[key] = current;
      continue;
    }
    if (LANE_OVERRIDES[key]) continue;
    if (current !== undefined) sentinelProblems.push(`${key} survived the sanitization: ${current}`);
    else sentinel.removed.push(key);
  }
  for (const [key, value] of Object.entries(LANE_OVERRIDES)) {
    if (process.env[key] !== value) sentinelProblems.push(`${key} did not keep the explicit lane value ${value}: ${process.env[key]}`);
    else sentinel.overrides[key] = value;
  }
  for (const key of POISON_PATH_KEYS) {
    const value = process.env[key];
    if (value === poisonPaths[key]) sentinelProblems.push(`${key} kept the poisoned path`);
    if (!value || !path.isAbsolute(value)) sentinelProblems.push(`${key} is not an absolute path after the install: ${value}`);
    else if (!value.startsWith(lane.laneTmp)) sentinelProblems.push(`${key} escapes the lane temp root: ${value}`);
  }
  if (process.env.PK_TEST_TEMP_ROOT !== toolTempRoot) sentinelProblems.push('PK_TEST_TEMP_ROOT did not survive the sanitization');
  if (path.resolve(lane.tempRoot) !== path.resolve(toolTempRoot)) sentinelProblems.push(`the tool-controlled temp root was not honored: ${lane.tempRoot}`);

  // A grandchild process must inherit the same clean base.
  const childKeys = ['PATH', 'HOME', 'KB_DATA_DIR', 'KB_MODULES_AUTOSTART', 'KB_TERMINAL_URL', ...Object.keys(POISON_ENV)];
  const probe = spawnSync(process.execPath, ['-e', `const keys=${JSON.stringify(childKeys)};const out={};for(const k of keys)out[k]=process.env[k]===undefined?null:process.env[k];process.stdout.write(JSON.stringify(out));`], { env: process.env, encoding: 'utf8' });
  if (probe.status !== 0) {
    sentinelProblems.push(`the grandchild environment probe failed: ${probe.stderr}`);
  } else {
    const childEnv = JSON.parse(probe.stdout);
    for (const [key, value] of Object.entries(POISON_ENV)) {
      if (laneOwnedKeys.has(key) || LANE_OVERRIDES[key]) continue;
      if (childEnv[key] !== null) sentinelProblems.push(`the grandchild inherited ${key}`);
    }
    if (!childEnv.PATH) sentinelProblems.push('the grandchild lost PATH');
    else if (childEnv.PATH !== process.env.PATH) sentinelProblems.push('the grandchild PATH differs from the sanitized base');
    if (childEnv.HOME !== lane.dirs.home) sentinelProblems.push(`the grandchild HOME is not the lane home: ${childEnv.HOME}`);
    if (childEnv.KB_MODULES_AUTOSTART !== '0') sentinelProblems.push('the grandchild did not inherit the lane module switch');
    if (childEnv.KB_TERMINAL_URL !== DEAD_MODULE_URL) sentinelProblems.push(`the grandchild module endpoint is not the lane dead address: ${childEnv.KB_TERMINAL_URL}`);
    sentinel.child = {
      status: probe.status,
      // Only key names and verdicts - the machine's own environment values are
      // never written into the evidence.
      inheritedNullKeys: Object.entries(childEnv).filter(([, value]) => value === null).map(([key]) => key),
      pathPresent: Boolean(childEnv.PATH),
      pathMatchesSanitizedBase: childEnv.PATH === process.env.PATH,
      homeIsLaneHome: childEnv.HOME === lane.dirs.home,
      moduleSwitch: childEnv.KB_MODULES_AUTOSTART,
      moduleUrlIsLaneDeadAddress: childEnv.KB_TERMINAL_URL === DEAD_MODULE_URL,
    };
  }

  // The real browser must still be resolvable after HOME/LOCALAPPDATA moved,
  // and it must not be the developer's real profile.
  const chromeProblems = [];
  let resolvedChrome = null;
  try {
    resolvedChrome = require('./helpers/find-chrome').findChromeDetailed();
  } catch (error) {
    chromeProblems.push(`find-chrome failed after the install: ${error.code || error.message}`);
  }
  if (lane.chromePath) {
    if (!resolvedChrome || resolvedChrome.path !== lane.chromePath) chromeProblems.push('the captured browser executable differs from the resolved one');
    if (process.env.KB_CHROME_PATH !== lane.chromePath) chromeProblems.push('KB_CHROME_PATH does not carry the captured browser executable');
    if (!resolvedChrome || resolvedChrome.source !== 'env') chromeProblems.push(`the browser was not resolved through the captured KB_CHROME_PATH: ${resolvedChrome && resolvedChrome.source}`);
    if (!fs.existsSync(lane.chromePath)) chromeProblems.push('the captured browser executable does not exist');
  }
  if (preInstallChrome) {
    if (!lane.chromePath) chromeProblems.push('the browser executable that was resolvable before the install was lost');
    else if (lane.chromePath !== preInstallChrome.path) chromeProblems.push('the captured browser executable differs from the pre-install resolution');
  }
  for (const dir of lane.chromeProfileDirs) {
    if (!dir.startsWith(lane.laneTmp)) chromeProblems.push(`the browser profile directory is outside the lane tree: ${dir}`);
  }
  // Chrome >= 136 also derives its default profile from
  // <USERPROFILE>\AppData\Local\Google\Chrome\User Data, independently of
  // LOCALAPPDATA. That derived directory must exist inside the owned home -
  // and the developer's real default profile must never be part of it.
  if (process.platform === 'win32') {
    const ownedDerivedProfile = path.join(lane.dirs.home, 'AppData', 'Local', 'Google', 'Chrome', 'User Data');
    if (!fs.existsSync(ownedDerivedProfile)) chromeProblems.push('the USERPROFILE-derived browser default profile directory is missing under the owned home');
    if (!lane.chromeProfileDirs.includes(ownedDerivedProfile)) chromeProblems.push('the USERPROFILE-derived browser default profile directory is not scaffolded');
    if (!ownedDerivedProfile.startsWith(lane.laneTmp)) chromeProblems.push('the USERPROFILE-derived browser default profile directory escapes the lane tree');
    const realProfiles = [
      ambientLocalAppData && path.join(ambientLocalAppData, 'Google', 'Chrome', 'User Data'),
      realHome && path.join(realHome, 'AppData', 'Local', 'Google', 'Chrome', 'User Data'),
    ].filter(Boolean);
    for (const realProfile of realProfiles) {
      if (lane.chromeProfileDirs.includes(realProfile)) chromeProblems.push('the developer default browser profile is part of the scaffold');
    }
  }
  if (process.env.LOCALAPPDATA === ambientLocalAppData) chromeProblems.push('LOCALAPPDATA still points at the ambient directory');

  // The PowerShell module analysis cache must be a FILE path whose parent
  // directory exists; a directory target is wrong. A normal own PowerShell
  // child must be able to use it.
  const psProblems = [];
  const psCache = installed.PSModuleAnalysisCachePath;
  const psCacheParent = path.dirname(psCache);
  let psProbe = null;
  if (process.platform !== 'win32') {
    psProblems.push('PSModuleAnalysisCachePath is only meaningful on Windows');
  } else {
    if (!fs.existsSync(psCacheParent) || !fs.statSync(psCacheParent).isDirectory()) {
      psProblems.push(`the PowerShell cache parent directory is missing: ${psCacheParent}`);
    }
    if (fs.existsSync(psCache) && fs.statSync(psCache).isDirectory()) {
      psProblems.push('the PowerShell cache path is a directory, not a file path');
    }
    if (!psCache.startsWith(lane.laneTmp)) psProblems.push('the PowerShell cache path is outside the lane tree');
    // The child prints one status word only - no environment values.
    psProbe = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      "$ErrorActionPreference='Stop'; Get-Module -ListAvailable | Out-Null; Write-Output 'PS-CACHE-OK'"], {
      env: { ...process.env, PSModuleAnalysisCachePath: psCache },
      encoding: 'utf8',
      timeout: 120000,
      windowsHide: true,
    });
    if (psProbe.error) psProblems.push(`the PowerShell child could not be started: ${psProbe.error.code || psProbe.error.message}`);
    else if (psProbe.status !== 0) psProblems.push(`the PowerShell child failed with the lane cache path (exit ${psProbe.status})`);
    else if (!String(psProbe.stdout || '').includes('PS-CACHE-OK')) psProblems.push('the PowerShell child did not complete with the lane cache path');
    if (psProbe.status === 0 && fs.existsSync(psCache) && fs.statSync(psCache).isDirectory()) {
      psProblems.push('PowerShell created a directory at the cache file path');
    }
  }
  sentinel.powerShell = {
    parentExists: fs.existsSync(psCacheParent),
    cachePathIsFile: !fs.existsSync(psCache) || !fs.statSync(psCache).isDirectory(),
    childExitCode: psProbe ? psProbe.status : null,
    childCompleted: psProbe ? String(psProbe.stdout || '').includes('PS-CACHE-OK') : null,
    problems: psProblems,
  };
  sentinelProblems.push(...psProblems);
  sentinel.chrome = {
    captured: lane.chromePath,
    resolved: resolvedChrome,
    preInstall: preInstallChrome,
    profileDirs: lane.chromeProfileDirs,
    problems: chromeProblems,
    skipped: !lane.chromePath && !preInstallChrome,
  };
  sentinelProblems.push(...chromeProblems);

  // Own-process cleanup: the lane tree must be gone once the entry releases
  // it, and the probe child must have exited.
  lane.cleanup();
  const laneTreeRemoved = !fs.existsSync(lane.laneTmp);
  if (!laneTreeRemoved) sentinelProblems.push('the lane temp tree survived the cleanup');
  sentinel.cleanup = {
    laneTreeRemoved,
    probeChildExited: probe.status !== null || Boolean(probe.error),
    powerShellChildExited: psProbe ? (psProbe.status !== null || Boolean(psProbe.error)) : null,
  };
  if (!sentinel.cleanup.probeChildExited) sentinelProblems.push('the grandchild probe process did not exit');
  if (psProbe && !sentinel.cleanup.powerShellChildExited) sentinelProblems.push('the PowerShell probe process did not exit');

  evidence.checks.poisonedEnvSentinel = { ...sentinel, problems: sentinelProblems };
  if (sentinelProblems.length) failures.push(`poisoned environment sentinel failed: ${sentinelProblems.join('; ')}`);

  try { fs.rmdirSync(toolTempRoot); } catch {}

  // 3. Dependency contract: every require target is tracked or declared.
  const dependencyProblems = [];
  const dependencyRows = [];
  for (const file of SCAN_FILES) {
    for (const target of requiresOf(file)) {
      const base = path.resolve(path.dirname(path.join(ROOT, file)), target);
      const candidates = [base, `${base}.js`, `${base}.json`, path.join(base, 'index.js')];
      const hit = candidates.find(candidate => fs.existsSync(candidate));
      const relative = path.relative(ROOT, hit || base).split(path.sep).join('/');
      const exists = Boolean(hit);
      const tracked = exists && isTracked(relative);
      const declared = LANE_MANIFEST.includes(relative);
      dependencyRows.push({ file, target, resolved: relative, exists, tracked, declared });
      if (!exists) dependencyProblems.push(`${file} requires missing ${relative}`);
      else if (!tracked && !declared) dependencyProblems.push(`${file} requires untracked, undeclared ${relative}`);
    }
  }
  evidence.checks.dependencies = { rows: dependencyRows, problems: dependencyProblems };
  if (dependencyProblems.length) failures.push(`dependency contract violated: ${dependencyProblems.join('; ')}`);

  // 4. Classification: automatic vs manual-QA-only, per the runner's own rule.
  const runnerSource = fs.readFileSync(path.join(ROOT, '_site', '_test', 'run-all-tests.js'), 'utf8');
  const runnerUsesTestSuffix = runnerSource.includes("endsWith('-test.js')");
  const classificationProblems = [];
  if (!runnerUsesTestSuffix) classificationProblems.push('run-all-tests.js no longer selects *-test.js; classification must be re-derived');
  for (const file of AUTOMATIC_ENTRIES) {
    if (!file.endsWith('-test.js')) classificationProblems.push(`${file} is declared automatic but is not selected by the runner`);
  }
  if (MANUAL_ONLY.endsWith('-test.js')) classificationProblems.push(`${MANUAL_ONLY} must not match the automatic runner glob`);
  const manualSource = fs.readFileSync(path.join(ROOT, MANUAL_ONLY), 'utf8');
  const manualNeedsExpect = manualSource.includes('--expect');
  if (!manualNeedsExpect) classificationProblems.push(`${MANUAL_ONLY} no longer requires an explicit --expect argument`);
  for (const file of FROZEN_EXPLORATION) {
    if (LANE_MANIFEST.includes(file)) classificationProblems.push(`${file} is frozen exploration history and must not be canonical`);
    if (file.endsWith('-test.js')) classificationProblems.push(`${file} would be picked up by the automatic runner`);
  }
  evidence.checks.classification = {
    runnerUsesTestSuffix,
    automaticEntries: AUTOMATIC_ENTRIES,
    manualOnly: MANUAL_ONLY,
    manualRequiresExpectArgument: manualNeedsExpect,
    frozenExploration: FROZEN_EXPLORATION,
    problems: classificationProblems,
  };
  if (classificationProblems.length) failures.push(`classification contract violated: ${classificationProblems.join('; ')}`);

  // 5. No real model/provider call in the lane entries.
  const providerProblems = [];
  const providerPattern = /api\.anthropic\.com|api\.openai\.com|api\.minimax|generativelanguage\.googleapis|sk-[A-Za-z0-9]{16,}/;
  for (const file of SCAN_FILES) {
    const code = stripComments(fs.readFileSync(path.join(ROOT, file), 'utf8'));
    if (providerPattern.test(code)) providerProblems.push(`${file} references a provider endpoint or key`);
  }
  const standInUsers = AUTOMATIC_ENTRIES.concat([MANUAL_ONLY]).filter(file => fs.readFileSync(path.join(ROOT, file), 'utf8').includes('KB_AUTOMATION_FAKE_CLAUDE=1'));
  evidence.checks.noRealModelCall = { providerProblems, standInUsers, standInCount: standInUsers.length };
  if (providerProblems.length) failures.push(`provider reference found: ${providerProblems.join('; ')}`);
  if (standInUsers.length === 0) failures.push('no entry declares the labelled offline analyzer stand-in');

  // 6. Default evidence roots live inside the gitignored artifact tree.
  const evidenceProblems = [];
  const defaultEvidenceDirs = AUTOMATIC_ENTRIES.map(file => {
    const code = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const match = /qa-autopilot\/artifacts\/[^'"]+/.exec(code);
    return match ? match[0] : null;
  }).filter(Boolean);
  for (const dir of defaultEvidenceDirs) {
    if (!isIgnored(dir)) evidenceProblems.push(`${dir} is not gitignored`);
  }
  evidence.checks.evidenceRoots = { defaultEvidenceDirs, problems: evidenceProblems };
  if (evidenceProblems.length) failures.push(`evidence root not ignored: ${evidenceProblems.join('; ')}`);

  // Manifest state for the Leader's commit step.
  const manifestState = LANE_MANIFEST.map(file => ({ file, tracked: isTracked(file) }));
  const pendingCommit = manifestState.filter(row => !row.tracked).map(row => row.file);
  const strict = process.env.PK_LOGGING_GATE_STRICT_TRACKED === '1';
  evidence.manifest = { files: manifestState, pendingCommit, strictMode: strict };
  if (strict && pendingCommit.length) failures.push(`strict mode: manifest files not committed yet: ${pendingCommit.join(', ')}`);

  evidence.verdict = failures.length
    ? { status: 'FAIL', failures }
    : { status: 'PASS', pendingCommit };
  evidence.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(ARTIFACTS, 'portability-evidence.json'), JSON.stringify(evidence, null, 2) + '\n');

  if (failures.length) {
    console.error(`P-QA-LOG-INTEGRATION-5025 portability FAIL: ${failures.join(' | ')}`);
    process.exitCode = 1;
    return;
  }
  console.log(`P-QA-LOG-INTEGRATION-5025 portability PASS${pendingCommit.length ? ` (pending commit: ${pendingCommit.length} lane files)` : ''}`);
  process.exitCode = 0;
}

try {
  main();
} catch (error) {
  // Fail closed: an unusable environment must never degrade into a PASS.
  fs.mkdirSync(ARTIFACTS, { recursive: true });
  fs.writeFileSync(path.join(ARTIFACTS, 'portability-evidence.json'), JSON.stringify({
    caseId: 'P-QA-LOG-INTEGRATION-5025-portability',
    verdict: { status: 'FAIL', failures: [String((error && error.stack) || error)] },
  }, null, 2) + '\n');
  console.error(`P-QA-LOG-INTEGRATION-5025 portability FAIL: ${error && error.message}`);
  process.exitCode = 1;
}
