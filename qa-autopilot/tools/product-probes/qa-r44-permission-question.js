'use strict';
// qa-autopilot/tools/product-probes/qa-r44-permission-question.js
//
// The canonical entry point of the R44 permission / user-question lane.
//
// MODES (the default is the zero-model check):
//
//   (no argument) / --check
//       The portability check. It starts NO service, NO browser, NO profile
//       facade and NO model request. It proves that the five lane files
//       parse, that their whole require-closure resolves inside the tree,
//       that every file of that closure which is not one of the five proposed
//       files is TRACKED by git, and that the modules load and expose the
//       API the scenario uses.
//
//   --run
//       The real acceptance (WB-006 / WB-007). It sends REAL model turns, so
//       it is refused unless PK_WB_ALLOW_PAID_TURNS=1 is set explicitly. The
//       refusal happens before anything is started, so a default invocation
//       can never spend a turn.
//
//   --report-only
//       Rebuilds THIS lane's portability report from the recorded check
//       result and the FROZEN R44 acceptance report. It sends no model
//       request and re-runs nothing. The report keeps the digests of the
//       source that produced the R44 acceptance SEPARATE from the digests of
//       the packaging delivered here, and it never presents the old model
//       result as a model retest of the new harness.
//
// Environment (all optional, all backwards compatible with the R44 lane):
//   QA_R44_EVIDENCE_DIR     the evidence directory of this lane
//   QA_R44_TEMP_ROOT        the lane temp root (outside the repository)
//   QA_R44_WB_SOURCE_ROOT   the read-only Workbench source checkout
//   QA_R44_TRACKED_LIST     a file with the repo-relative tracked file list,
//                           used when the tree has no .git (a clean checkout)
//   PK_WB_ALLOW_PAID_TURNS  must be "1" for --run
//   PK_WB_MODEL_PROFILE     the model profile id (--run)
//   PK_WB_MODEL_ID          the model id (--run)
//   PK_WB_TURN_TIMEOUT_MS   the turn timeout (--run)
//
// Exit codes: 0 = the mode succeeded, 2 = a mode was refused (the paid
// acceptance without its explicit gate, a write into frozen evidence, a
// stale check), 3 = an honest BLOCKED (the mode ran but the evidence is
// insufficient), 1 = the tool itself failed.
//
// R44D: the frozen evidence is protected in CODE, not by convention:
//   * no mode may write into a frozen evidence directory;
//   * --run always writes into a NEW, unique run directory, so a new run can
//     never overwrite the first failure of an earlier run;
//   * --report-only reuses a recorded check ONLY when the bytes it ran
//     against are still the current bytes of the proposed files.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { execFileSync, spawnSync } = require('node:child_process');

const LANE = 'P-WB-QA-CANONICAL-R44C';
const R44_LANE = 'P-WB-PERMISSION-QUESTION-R44';

// The files this lane proposes. They are the ONLY untracked files the
// canonical lane may depend on; every other file of the closure must be
// tracked by git.
const PROPOSAL_FILES = [
  '_site/_test/helpers/qa-r44-env.js',
  '_site/_test/helpers/qa-r44-ui.js',
  '_site/_test/helpers/qa-r44-report.js',
  '_site/_test/qa-r44-permission-question.js',
  'qa-autopilot/tools/product-probes/qa-r44-permission-question.js',
  'qa-autopilot/tools/product-probes/qa-r44-report-regression.js',
];

// The harness the scenario used before R44C. It is an UNTRACKED historical
// tool; the canonical lane must not depend on it any more.
const RETIRED_HARNESS = '_site/_test/helpers/parallel-workbench-runtime-harness.js';

// The API the scenario uses from the shared helpers. The check proves that
// the tracked harness still provides it.
const HARNESS_API = [
  'API_BASE', 'wait', 'waitUntil', 'getJson', 'startHost', 'stopHost', 'openBrowser',
  'readState', 'waitForState', 'selectModel', 'ensureProject', 'typeText', 'clickSend',
  'clickNewSession', 'sessionEventsUrl', 'consumeSessionEvents', 'moduleIdentity',
];
const ENV_API = [
  'captureRealEnvironment', 'createLaneLayout', 'hardenDriverEnv', 'assertIsolatedEnv',
  'isolationContract', 'containedPath', 'digestDirectory', 'compareDigests', 'realProfileDir',
];
const UI_API = [
  'readToolPermissionCards', 'findToolCard', 'readPageStreams', 'readPageEvents',
  'readDomDiagnostics', 'clickDeny', 'clickAllow', 'readSettledCard', 'readQuestionCards',
  'selectRadioOption', 'selectCheckboxOptions', 'typeCustomAnswer', 'clickSubmitAnswer',
  'selectPermissionMode',
];

function findRepoRoot(start) {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, 'package.json')) && fs.existsSync(path.join(dir, 'qa-autopilot'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`no repository root above ${start}`);
    dir = parent;
  }
}

const REPO_ROOT = findRepoRoot(__dirname);
const EVIDENCE_DIR = path.resolve(
  process.env.QA_R44_EVIDENCE_DIR
  || path.join(REPO_ROOT, 'qa-autopilot', 'artifacts', 'parallel-20261023', 'wb-qa-finalize-r44d'),
);
const R44_EVIDENCE_DIR = path.join(REPO_ROOT, 'qa-autopilot', 'artifacts', 'parallel-20261023', 'wb-permission-question-r44');
const R44C_EVIDENCE_DIR = path.join(REPO_ROOT, 'qa-autopilot', 'artifacts', 'parallel-20261023', 'wb-qa-canonical-r44c');
// The evidence of the earlier lanes is frozen. No mode of this tool may
// write into it.
const FROZEN_EVIDENCE_DIRS = [R44_EVIDENCE_DIR, R44C_EVIDENCE_DIR];
const SCENARIO_PATH = path.join(REPO_ROOT, '_site', '_test', 'qa-r44-permission-question.js');
const REPORT_BUILDER_PATH = path.join(REPO_ROOT, '_site', '_test', 'helpers', 'qa-r44-report.js');

const sha256File = file => {
  try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); } catch { return null; }
};
const rel = (root, file) => path.relative(root, file).split(path.sep).join('/');

function parseArgs(argv) {
  const mode = { check: false, run: false, reportOnly: false };
  for (const arg of argv) {
    if (arg === '--check') mode.check = true;
    else if (arg === '--run') mode.run = true;
    else if (arg === '--report-only') mode.reportOnly = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (mode.run && mode.reportOnly) throw new Error('--run and --report-only are exclusive');
  if (mode.run && mode.check) throw new Error('--run and --check are exclusive');
  if (!mode.run && !mode.reportOnly) mode.check = true;
  return mode;
}

// --- the tracked file list -------------------------------------------------

// The repo-relative names git tracks. A clean checkout has no .git, so the
// list can be handed in explicitly (QA_R44_TRACKED_LIST).
function trackedFileList(repoRoot) {
  const explicit = String(process.env.QA_R44_TRACKED_LIST || '').trim();
  if (explicit) {
    const file = path.resolve(explicit);
    return {
      source: `the explicit list ${rel(repoRoot, file)}`,
      names: new Set(fs.readFileSync(file, 'utf8').split('\n').map(line => line.trim()).filter(Boolean)),
    };
  }
  const result = spawnSync('git', ['ls-files'], { cwd: repoRoot, encoding: 'utf8', windowsHide: true, timeout: 60000, maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) return { source: null, names: null };
  return {
    source: 'git ls-files',
    names: new Set(String(result.stdout || '').split('\n').map(line => line.trim()).filter(Boolean)),
  };
}

// --- the dependency closure ------------------------------------------------

// The relative require specifiers of a source text.
function requireSpecifiers(source) {
  const requireRe = /require\(\s*['"](\.[^'"]+)['"]\s*\)/g;
  const out = [];
  let match;
  requireRe.lastIndex = 0;
  while ((match = requireRe.exec(source)) !== null) out.push(match[1]);
  return out;
}

// The relative require-closure of the given roots. A require of a directory
// or of a file without an extension resolves like node resolves it.
function dependencyClosure(repoRoot, roots) {
  const seen = new Map();
  const unresolved = [];

  const walk = absolute => {
    const relative = rel(repoRoot, absolute);
    if (seen.has(relative)) return;
    if (!fs.existsSync(absolute)) { seen.set(relative, { exists: false, sha256: null, bytes: null }); return; }
    seen.set(relative, {
      exists: true,
      sha256: sha256File(absolute),
      bytes: fs.statSync(absolute).size,
    });
    const source = fs.readFileSync(absolute, 'utf8');
    for (const specifier of requireSpecifiers(source)) {
      const base = path.resolve(path.dirname(absolute), specifier);
      const candidates = [base, `${base}.js`, path.join(base, 'index.js')];
      const hit = candidates.find(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
      if (!hit) { unresolved.push(`${relative} -> ${specifier}`); continue; }
      walk(hit);
    }
  };

  for (const root of roots) walk(path.resolve(repoRoot, root));
  return { files: seen, unresolved };
}

// --- the check -------------------------------------------------------------

// Parse a file WITHOUT executing it. This is the check that the file is
// syntactically valid; it never runs a single line of the file.
function parseOnly(file) {
  const source = fs.readFileSync(file, 'utf8');
  vm.compileFunction(source, ['exports', 'require', 'module', '__filename', '__dirname'], { filename: file });
  return true;
}

// The resources the process holds. A check that started a service, a browser
// or a model request would show a socket, a server or a child process here.
function activeResources() {
  return typeof process.getActiveResourcesInfo === 'function' ? process.getActiveResourcesInfo() : ['unknown'];
}

function runCheck(repoRoot) {
  const started = new Date().toISOString();
  const results = [];
  const record = (id, status, detail) => {
    results.push({ id, status, detail });
    console.log(`CHECK ${id} ${status} ${JSON.stringify(detail)}`);
  };

  const tracked = trackedFileList(repoRoot);

  // 1. the five proposed files exist and parse.
  const parsed = [];
  for (const relative of PROPOSAL_FILES) {
    const file = path.join(repoRoot, ...relative.split('/'));
    const exists = fs.existsSync(file);
    let parses = false;
    let error = null;
    if (exists) {
      try { parseOnly(file); parses = true; } catch (failure) { error = String(failure && failure.message || failure); }
    }
    parsed.push({ path: relative, exists, parses, error, sha256: sha256File(file), bytes: exists ? fs.statSync(file).size : null });
  }
  const allParsed = parsed.every(entry => entry.exists && entry.parses);
  record('R44C.a-the-proposed-files-exist-and-parse', allParsed ? 'PASS' : 'FAIL', { files: parsed });

  // 2. the scenario no longer DEPENDS on the untracked historical harness.
  //    The dependency is a require() that resolves to it; a prose mention of
  //    its name (this report, for instance) is not a dependency.
  const retiredRefs = [];
  const proseMentions = [];
  for (const relative of PROPOSAL_FILES) {
    const file = path.join(repoRoot, ...relative.split('/'));
    if (!fs.existsSync(file)) continue;
    const source = fs.readFileSync(file, 'utf8');
    for (const specifier of requireSpecifiers(source)) {
      const base = path.resolve(path.dirname(file), specifier);
      const hit = [base, `${base}.js`, path.join(base, 'index.js')]
        .find(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
      const resolved = hit ? rel(repoRoot, hit) : null;
      if (resolved === RETIRED_HARNESS) retiredRefs.push({ file: relative, specifier, resolved });
    }
    if (source.includes('parallel-workbench-runtime-harness')) proseMentions.push(relative);
  }
  record('R44C.b-no-dependency-on-the-untracked-historical-harness', retiredRefs.length === 0 ? 'PASS' : 'FAIL', {
    retiredHarness: RETIRED_HARNESS,
    retiredHarnessTracked: tracked.names ? tracked.names.has(RETIRED_HARNESS) : null,
    dependenciesOnIt: retiredRefs,
    proseMentionsOnly: proseMentions,
    note: 'a prose mention of the retired name is not a dependency; only a require() that resolves to it would be',
  });

  // 3. the require-closure resolves, and every file of it is tracked.
  const closure = dependencyClosure(repoRoot, PROPOSAL_FILES);
  const proposalSet = new Set(PROPOSAL_FILES);
  const closureFiles = [...closure.files.entries()].map(([relative, info]) => ({
    path: relative,
    exists: info.exists,
    sha256: info.sha256,
    bytes: info.bytes,
    tracked: tracked.names ? tracked.names.has(relative) : null,
    isProposal: proposalSet.has(relative),
  }));
  const foreignUntracked = closureFiles.filter(entry => !entry.isProposal && entry.tracked === false);
  const missing = closureFiles.filter(entry => !entry.exists);
  const closureOk = missing.length === 0 && closure.unresolved.length === 0 && foreignUntracked.length === 0;
  record('R44C.c-the-require-closure-is-inside-the-tree-and-tracked', closureOk ? 'PASS' : 'FAIL', {
    trackedListSource: tracked.source,
    closureSize: closureFiles.length,
    proposalFiles: closureFiles.filter(entry => entry.isProposal).map(entry => entry.path),
    trackedSharedFiles: closureFiles.filter(entry => !entry.isProposal && entry.tracked === true).map(entry => entry.path),
    foreignUntracked,
    missing,
    unresolved: closure.unresolved,
  });

  // 4. the helper the harness spawns at runtime is tracked too.
  const runtimeSpawned = '_site/_test/helpers/parallel-workbench-host.js';
  const spawnedTracked = tracked.names ? tracked.names.has(runtimeSpawned) : null;
  record('R44C.d-the-runtime-spawned-host-helper-is-tracked', spawnedTracked === true ? 'PASS' : (spawnedTracked === null ? 'UNKNOWN' : 'FAIL'), {
    path: runtimeSpawned,
    exists: fs.existsSync(path.join(repoRoot, ...runtimeSpawned.split('/'))),
    tracked: spawnedTracked,
  });

  // 5. the modules load and expose the API the scenario uses. Loading a
  //    module runs no product code: the helpers only read files at load.
  const before = activeResources();
  let api = null;
  let loadError = null;
  try {
    const harness = require(path.join(repoRoot, '_site', '_test', 'helpers', 'parallel-workbench-integration-5025-runtime-harness'));
    const envLib = require(path.join(repoRoot, '_site', '_test', 'helpers', 'qa-r44-env'));
    const ui = require(path.join(repoRoot, '_site', '_test', 'helpers', 'qa-r44-ui'));
    const missingHarness = HARNESS_API.filter(name => typeof harness[name] === 'undefined');
    const missingEnv = ENV_API.filter(name => typeof envLib[name] === 'undefined');
    const missingUi = UI_API.filter(name => typeof ui[name] === 'undefined');
    api = {
      harness: { module: 'helpers/parallel-workbench-integration-5025-runtime-harness', missing: missingHarness },
      env: { module: 'helpers/qa-r44-env', missing: missingEnv },
      ui: { module: 'helpers/qa-r44-ui', missing: missingUi },
    };
    if (missingHarness.length || missingEnv.length || missingUi.length) throw new Error('the shared API is incomplete');
  } catch (error) {
    loadError = String(error && error.message || error);
  }
  const after = activeResources();
  const newResources = after.filter(kind => !before.includes(kind));
  const suspicious = newResources.filter(kind => /Socket|Server|ChildProcess|HandleWrap|TCP/i.test(kind));
  record('R44C.e-the-modules-load-and-expose-the-expected-api', loadError ? 'FAIL' : 'PASS', {
    api,
    error: loadError,
    resourcesBefore: before,
    resourcesAfter: after,
    newResources,
    startedSomething: suspicious,
  });

  // 6. the check itself started no service, no browser and no model request.
  record('R44C.f-the-check-started-no-service-no-browser-no-model', suspicious.length === 0 ? 'PASS' : 'FAIL', {
    note: 'the check only parses, hashes, resolves and loads; it never calls the scenario, never opens a port and never reaches a model endpoint',
    startedResources: suspicious,
    modelRequestsSent: 0,
    paidTurnsSent: 0,
  });

  const failed = results.filter(entry => entry.status === 'FAIL');
  return {
    schema: 'qa-autopilot/wb-qa-canonical-r44c/check/v1',
    lane: LANE,
    startedAt: started,
    finishedAt: new Date().toISOString(),
    repoRoot,
    evidenceDir: EVIDENCE_DIR,
    mode: 'check',
    results,
    verdict: failed.length === 0 ? 'PASS' : 'FAIL',
  };
}

// --- the portability report ------------------------------------------------

// The digests of the source that produced the FROZEN R44 acceptance, and the
// digests of the packaging delivered here. They are never merged.
function readFrozenR44() {
  const file = path.join(R44_EVIDENCE_DIR, 'report.json');
  if (!fs.existsSync(file)) return { available: false, file, reason: 'the frozen R44 report is not present' };
  const report = JSON.parse(fs.readFileSync(file, 'utf8'));
  return { available: true, file, report };
}

function readCheckResult() {
  const file = path.join(EVIDENCE_DIR, 'check.json');
  if (!fs.existsSync(file)) return { available: false, file, reason: 'the check result is not present' };
  return { available: true, file, check: JSON.parse(fs.readFileSync(file, 'utf8')) };
}

// --- the frozen evidence guard ----------------------------------------------

function isInside(candidate, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

// The evidence of the earlier lanes is frozen. No mode of this tool may write
// into it, and a report of a foreign lane is never overwritten.
function frozenTarget(target) {
  for (const frozen of FROZEN_EVIDENCE_DIRS) {
    if (isInside(target, frozen)) return frozen;
  }
  return null;
}

// A refusal is evidence too: it is recorded next to the evidence of the lane
// that made it - but never inside a frozen directory.
function refuse(reason, detail) {
  console.error(`REFUSED: ${reason}`);
  if (detail) console.error(detail);
  try {
    if (!frozenTarget(EVIDENCE_DIR)) {
      fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
      const file = path.join(EVIDENCE_DIR, 'refusal.json');
      const existing = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { schema: 'qa-autopilot/wb-qa-canonical-r44c/refusal/v1', lane: LANE, refusals: [] };
      existing.refusals = existing.refusals || [];
      existing.refusals.push({ at: new Date().toISOString(), reason, detail: detail || null, pid: process.pid });
      fs.writeFileSync(file, `${JSON.stringify(existing, null, 2)}\n`, 'utf8');
    }
  } catch { /* the refusal is on the console either way */ }
  return 2;
}

// A file of this lane may only be replaced by a file of the same schema. A
// report of another lane is never overwritten.
function assertReplaceable(file, expectedSchema) {
  if (!fs.existsSync(file)) return true;
  let existing = null;
  try { existing = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { existing = null; }
  if (!existing || existing.schema !== expectedSchema) {
    throw new Error(`refusing to overwrite ${file}: it does not carry the schema ${expectedSchema}`);
  }
  return true;
}

// --- the run directories ----------------------------------------------------

// Every --run writes into its own directory, so a new run can never
// overwrite the first failure of an earlier run.
function uniqueRunDir(evidenceDir) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const root = path.join(evidenceDir, 'runs');
  let dir = path.join(root, `${stamp}-${process.pid}`);
  let counter = 1;
  while (fs.existsSync(dir)) { dir = path.join(root, `${stamp}-${process.pid}-${counter}`); counter += 1; }
  return dir;
}

// The index of the runs of this lane. It is append-only and it is written
// atomically, so a crash cannot lose an earlier run.
function appendRunIndex(evidenceDir, entry) {
  const dir = path.join(evidenceDir, 'runs');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'index.json');
  const runs = fs.existsSync(file) ? ((JSON.parse(fs.readFileSync(file, 'utf8')).runs) || []) : [];
  runs.push(entry);
  const payload = { schema: 'qa-autopilot/wb-qa-canonical-r44c/runs-index/v1', lane: LANE, runs };
  const temp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  fs.renameSync(temp, file);
  return payload;
}

// The run history of the lane, built from the index. The first failure of
// the lane is carried forward; a later run never replaces it.
function buildRunHistory(index, thisRun) {
  const runs = index.runs.map(entry => ({
    run: entry.run,
    at: entry.at,
    command: entry.command,
    exitCode: entry.exitCode,
    verdict: entry.verdict,
    cases: entry.cases || null,
    outcome: entry.outcome || null,
    evidenceDir: entry.evidenceDir || null,
  }));
  const firstFailed = runs.find(entry => entry.verdict !== 'PASS') || null;
  const firstFailure = firstFailed ? {
    run: firstFailed.run,
    at: firstFailed.at,
    verdict: firstFailed.verdict,
    error: firstFailed.error || null,
    whoseDefect: firstFailed.whoseDefect || 'not recorded by the tool',
    note: 'the first failure of the lane; it is carried forward and is never replaced by a later run',
  } : null;
  const retest = firstFailed ? runs.slice(runs.indexOf(firstFailed) + 1) : null;
  return {
    schema: 'qa-autopilot/wb-qa-canonical-r44c/run-history/v1',
    lane: LANE,
    runs,
    firstFailure,
    retest,
    commands: index.runs.map(entry => ({ what: `the acceptance run ${entry.run}`, command: entry.command, exitCode: entry.exitCode })),
    sourceDigestsDuringRun: thisRun ? thisRun.sourceDigestsDuringRun : null,
  };
}

// The digests of the lane files, as they are right now. They are the digests
// of the source that produced a run.
function currentSourceDigests() {
  return PROPOSAL_FILES.map(relative => {
    const file = path.join(REPO_ROOT, ...relative.split('/'));
    return { path: relative, sha256: sha256File(file), bytes: fs.existsSync(file) ? fs.statSync(file).size : null };
  });
}

async function main() {
  const mode = parseArgs(process.argv.slice(2));
  const builder = require(REPORT_BUILDER_PATH);

  // The evidence directory of this lane must not be a frozen one.
  const frozen = frozenTarget(EVIDENCE_DIR);
  if (frozen) {
    console.error(`REFUSED: the evidence directory ${EVIDENCE_DIR} is inside the frozen evidence of another lane (${frozen}).`);
    console.error('Nothing was written. Set QA_R44_EVIDENCE_DIR to a directory of this lane.');
    return 2;
  }

  if (mode.run) {
    if (String(process.env.PK_WB_ALLOW_PAID_TURNS || '').trim() !== '1') {
      console.error('REFUSED: --run sends REAL model turns. Set PK_WB_ALLOW_PAID_TURNS=1 to allow them.');
      console.error('Nothing was started: no service, no browser, no profile, no model request.');
      return refuse('the paid acceptance was requested without PK_WB_ALLOW_PAID_TURNS=1', 'nothing was started: no service, no browser, no profile, no model request');
    }
    if (!fs.existsSync(SCENARIO_PATH)) throw new Error(`the R44 scenario module is missing: ${SCENARIO_PATH}`);
    const scenario = require(SCENARIO_PATH);
    const startedAt = new Date().toISOString();
    const summary = await scenario.main();
    // The result of this run goes into its own directory. Nothing of an
    // earlier run is overwritten.
    const runDir = uniqueRunDir(EVIDENCE_DIR);
    fs.mkdirSync(runDir, { recursive: true });
    const sourceDigests = currentSourceDigests();
    const exitCode = summary.verdict === 'PASS' ? 0 : 3;
    const index = appendRunIndex(EVIDENCE_DIR, {
      run: (fs.existsSync(path.join(EVIDENCE_DIR, 'runs', 'index.json'))
        ? (JSON.parse(fs.readFileSync(path.join(EVIDENCE_DIR, 'runs', 'index.json'), 'utf8')).runs || []).length
        : 0) + 1,
      at: startedAt,
      command: process.argv.slice(1).join(' '),
      exitCode,
      verdict: summary.verdict,
      cases: summary.cases,
      outcome: summary.caseEvaluation ? summary.caseEvaluation.notPassed : null,
      error: summary.caseEvaluation ? JSON.stringify(summary.caseEvaluation.notPassed) : null,
      evidenceDir: path.relative(REPO_ROOT, runDir).split(path.sep).join('/'),
      sourceDigestsDuringRun: sourceDigests,
    });
    const runHistory = buildRunHistory(index, { sourceDigestsDuringRun: sourceDigests });
    fs.writeFileSync(path.join(runDir, 'run-history.json'), `${JSON.stringify(runHistory, null, 2)}\n`, 'utf8');
    const { file: reportPath } = builder.writeReport({
      repoRoot: REPO_ROOT,
      evidenceDir: runDir,
      summary,
      runHistory,
      proposalFiles: PROPOSAL_FILES,
    });
    console.log(`REPORT ${reportPath}`);
    console.log(`qa-r44-permission-question verdict=${summary.verdict}`);
    return exitCode;
  }

  if (mode.check) {
    const result = runCheck(REPO_ROOT);
    fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
    const file = path.join(EVIDENCE_DIR, 'check.json');
    try { assertReplaceable(file, result.schema); } catch (error) { return refuse(String(error && error.message || error)); }
    fs.writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    console.log(`CHECK ${file}`);
    console.log(`qa-r44-canonical verdict=${result.verdict}`);
    return result.verdict === 'PASS' ? 0 : 1;
  }

  // --report-only: rebuild this lane's portability report. No model request,
  // nothing is re-run.
  const recorded = readCheckResult();
  const frozenR44 = readFrozenR44();

  // A recorded check is reused ONLY when the bytes it ran against are still
  // the current bytes. A stale PASS is refused, never reported.
  if (recorded.available) {
    const freshness = builder.checkFreshness(recorded.check, REPO_ROOT, PROPOSAL_FILES);
    if (!freshness.fresh) {
      return refuse(
        'the recorded check does not match the current bytes of the proposed files',
        JSON.stringify({ mismatches: freshness.mismatches, unrecorded: freshness.unrecorded }),
      );
    }
  }

  const report = builder.buildPortabilityReport({
    repoRoot: REPO_ROOT,
    evidenceDir: EVIDENCE_DIR,
    check: recorded.available ? recorded.check : null,
    frozenR44,
    proposalFiles: PROPOSAL_FILES,
  });
  if (!recorded.available) {
    report.missingEvidence = ['the check result is not present, so nothing can be reported as proven'];
  }
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  const file = path.join(EVIDENCE_DIR, 'report.json');
  try { assertReplaceable(file, report.schema); } catch (error) { return refuse(String(error && error.message || error)); }
  fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`REPORT ${file}`);
  console.log(`qa-r44-canonical verdict=${report.verdict}`);
  if (report.verdict === 'PASS') return 0;
  return report.verdict === 'BLOCKED' ? 3 : 1;
}

main().then(code => {
  process.exitCode = code;
  // The check and the report modes leave no timer and no socket behind, so
  // the event loop drains on its own. The paid acceptance is the only mode
  // that may still hold a handle; it closes the process explicitly.
  if (code === 0 || code === 1 || code === 2 || code === 3) {
    setImmediate(() => process.exit(code));
  }
}).catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
