'use strict';
// qa-autopilot/tools/product-probes/qa-r44-report-regression.js
//
// The EXPLICIT zero-model regression probe of the canonical qa-r44 tooling.
//
// It proves the negative cases of the report and of the guard rails:
//
//   * a result set that lacks a required case is never a PASS, and the two
//     bypass cases (R44.g and R44.j) are required;
//   * the report builder never narrates a past run: the historical facts of
//     the accepted R44 acceptance live in the frozen R44 report only;
//   * the report builder never manufactures a PASS from an incomplete summary;
//   * a recorded check whose bytes are stale is refused, not reported;
//   * the frozen evidence of another lane cannot be written to;
//   * the paid acceptance is refused without its explicit gate, and the
//     refusal starts nothing.
//
// It sends NO model request, starts NO service, opens NO browser and reads
// no credential. It is NOT wired into any CI: it is run explicitly, by path.
//
// Exit codes: 0 = every probe passed, 1 = a probe failed.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

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
const ENTRY = path.join(REPO_ROOT, 'qa-autopilot', 'tools', 'product-probes', 'qa-r44-permission-question.js');
const BUILDER_PATH = path.join(REPO_ROOT, '_site', '_test', 'helpers', 'qa-r44-report.js');
const SCENARIO_PATH = path.join(REPO_ROOT, '_site', '_test', 'qa-r44-permission-question.js');
const FROZEN_DIRS = [
  path.join(REPO_ROOT, 'qa-autopilot', 'artifacts', 'parallel-20261023', 'wb-permission-question-r44'),
  path.join(REPO_ROOT, 'qa-autopilot', 'artifacts', 'parallel-20261023', 'wb-qa-canonical-r44c'),
];

// The lane's own scratch space, outside the repository and outside the real
// home.
const TEMP_ROOT = path.resolve(
  String(process.env.QA_R44_TEMP_ROOT || '').trim()
  || path.join(path.dirname(REPO_ROOT), '.project-knowledge-test-temp', 'wb-qa-finalize-r44d'),
);
const WORK_DIR = path.join(TEMP_ROOT, 'regression');

const sha256File = file => {
  try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); } catch { return null; }
};
const isInside = (candidate, parent) => {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};
const digestTree = dir => {
  const out = {};
  const walk = current => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      out[path.relative(dir, full).split(path.sep).join('/')] = sha256File(full);
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out;
};

const probes = [];
function probe(id, ok, detail) {
  const entry = { id, ok: Boolean(ok), detail: detail === undefined ? null : detail };
  probes.push(entry);
  console.log(`PROBE ${entry.ok ? 'PASS' : 'FAIL'} ${id} ${JSON.stringify(entry.detail)}`);
  return entry.ok;
}

// Run the canonical entry point as a child process and return its real exit
// code and output. No model request is possible in the modes used here.
function runCli(args, env) {
  const result = spawnSync(process.execPath, [ENTRY, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 300000,
    env: { ...process.env, ...env },
  });
  return { status: result.status, stdout: String(result.stdout || ''), stderr: String(result.stderr || '') };
}

function main() {
  fs.rmSync(WORK_DIR, { recursive: true, force: true });
  fs.mkdirSync(WORK_DIR, { recursive: true });

  const builder = require(BUILDER_PATH);
  const scenario = require(SCENARIO_PATH);

  // --- 1. the required cases ------------------------------------------------
  const complete = scenario.ESSENTIAL_CASES.map(caseId => ({ caseId, status: 'PASS', detail: {} }));
  const withoutG = complete.filter(entry => entry.caseId !== 'R44.g-wb007-bypass-mode-does-not-release-the-question');
  const withoutJ = complete.filter(entry => entry.caseId !== 'R44.j-wb007-the-bypass-mode-still-asks-the-question');
  const jBlocked = complete.map(entry => (entry.caseId === 'R44.j-wb007-the-bypass-mode-still-asks-the-question' ? { ...entry, status: 'BLOCKED' } : entry));

  const evaluationComplete = scenario.evaluateCases(complete);
  const evaluationWithoutG = scenario.evaluateCases(withoutG);
  const evaluationWithoutJ = scenario.evaluateCases(withoutJ);
  const evaluationJBlocked = scenario.evaluateCases(jBlocked);

  probe('the complete result set is a PASS', evaluationComplete.proven === true && evaluationComplete.verdict === 'PASS', { verdict: evaluationComplete.verdict });
  probe('a result set without R44.g is not a PASS', evaluationWithoutG.proven === false && evaluationWithoutG.verdict === 'BLOCKED', {
    verdict: evaluationWithoutG.verdict, missing: evaluationWithoutG.missing, notPassed: evaluationWithoutG.notPassed,
  });
  probe('a result set without R44.j is not a PASS', evaluationWithoutJ.proven === false && evaluationWithoutJ.verdict === 'BLOCKED', {
    verdict: evaluationWithoutJ.verdict, missing: evaluationWithoutJ.missing, notPassed: evaluationWithoutJ.notPassed,
  });
  probe('a BLOCKED R44.j is not a PASS', evaluationJBlocked.proven === false && evaluationJBlocked.verdict === 'BLOCKED', {
    verdict: evaluationJBlocked.verdict, notPassed: evaluationJBlocked.notPassed,
  });
  probe('both bypass cases are required', scenario.ESSENTIAL_CASES.includes('R44.g-wb007-bypass-mode-does-not-release-the-question')
    && scenario.ESSENTIAL_CASES.includes('R44.j-wb007-the-bypass-mode-still-asks-the-question'), {
    essential: scenario.ESSENTIAL_CASES,
  });

  // --- 2. the report builder never narrates a past run ----------------------
  const builderSource = fs.readFileSync(BUILDER_PATH, 'utf8');
  const historicalMarkers = ['2026-10-27T02:01:20Z', 'six more minutes', 'the first three runs', 'run 1', 'run 2'];
  const markersInSource = historicalMarkers.filter(marker => builderSource.includes(marker));
  probe('the report builder carries no historical narrative', markersInSource.length === 0, { markersInSource });

  // --- 3. the report builder never manufactures a PASS ----------------------
  const incompleteSummary = {
    lane: 'P-WB-PERMISSION-QUESTION-R44',
    cases: ['WB-006', 'WB-007'],
    verdict: 'BLOCKED',
    paidTurnsSent: 0,
    networkUsed: false,
    cases_detail: [
      { caseId: 'R44.c-wb006-real-permission-card-raised', status: 'PASS', detail: {} },
      { caseId: 'R44.d-wb006-deny-executed-by-the-real-ui', status: 'PASS', detail: {} },
    ],
    caseEvaluation: scenario.evaluateCases([
      { caseId: 'R44.c-wb006-real-permission-card-raised', status: 'PASS', detail: {} },
      { caseId: 'R44.d-wb006-deny-executed-by-the-real-ui', status: 'PASS', detail: {} },
    ]),
  };
  const incompleteReport = builder.buildReport({
    repoRoot: REPO_ROOT,
    evidenceDir: WORK_DIR,
    summary: incompleteSummary,
    runHistory: null,
    proposalFiles: builder.LANE_FILES.map(entry => entry.path),
  });
  const incompleteJson = JSON.stringify(incompleteReport);
  probe('an incomplete summary does not produce a PASS report', incompleteReport.verdict !== 'PASS', { verdict: incompleteReport.verdict });
  probe('the report names the required cases it did not prove', Array.isArray(incompleteReport.runFacts.requiredCasesNotProven)
    && incompleteReport.runFacts.requiredCasesNotProven.length > 0, {
    requiredCasesNotProven: incompleteReport.runFacts.requiredCasesNotProven,
  });
  const markersInReport = historicalMarkers.filter(marker => incompleteJson.includes(marker));
  probe('the built report carries no historical narrative', markersInReport.length === 0, { markersInReport });

  // --- 4. a stale check is refused -----------------------------------------
  const proposalFiles = builder.LANE_FILES.map(entry => entry.path);
  const currentDigests = proposalFiles.map(relative => ({ path: relative, sha256: sha256File(path.join(REPO_ROOT, ...relative.split('/'))) }));
  const freshCheck = { results: [{ id: 'R44C.a-the-proposed-files-exist-and-parse', status: 'PASS', detail: { files: currentDigests } }] };
  const staleCheck = { results: [{ id: 'R44C.a-the-proposed-files-exist-and-parse', status: 'PASS', detail: { files: currentDigests.map(entry => ({ path: entry.path, sha256: '0'.repeat(64) })) } }] };
  const fresh = builder.checkFreshness(freshCheck, REPO_ROOT, proposalFiles);
  const stale = builder.checkFreshness(staleCheck, REPO_ROOT, proposalFiles);
  probe('a check over the current bytes is fresh', fresh.fresh === true, { fresh: fresh.fresh });
  probe('a check over other bytes is not fresh', stale.fresh === false && stale.mismatches.length === proposalFiles.length, {
    fresh: stale.fresh, mismatches: stale.mismatches.map(entry => entry.path),
  });

  // --- 5. the CLI: the paid run is refused without its gate -----------------
  const gateDir = path.join(WORK_DIR, 'gate');
  const gated = runCli(['--run'], { QA_R44_EVIDENCE_DIR: gateDir, PK_WB_ALLOW_PAID_TURNS: '' });
  probe('the paid acceptance is refused without its explicit gate', gated.status === 2 && /REFUSED/.test(gated.stderr), {
    exitCode: gated.status, stderr: gated.stderr.trim().split('\n').slice(0, 2),
  });
  probe('the refused run started nothing', !fs.existsSync(path.join(gateDir, 'runs')), { runsDirExists: fs.existsSync(path.join(gateDir, 'runs')) });

  // --- 6. the CLI: --report-only without any data is an honest BLOCKED ------
  const emptyDir = path.join(WORK_DIR, 'empty');
  const empty = runCli(['--report-only'], { QA_R44_EVIDENCE_DIR: emptyDir });
  const emptyReportFile = path.join(emptyDir, 'report.json');
  const emptyReport = fs.existsSync(emptyReportFile) ? JSON.parse(fs.readFileSync(emptyReportFile, 'utf8')) : null;
  probe('--report-only without a check result is an honest BLOCKED', empty.status === 3 && Boolean(emptyReport) && emptyReport.verdict === 'BLOCKED', {
    exitCode: empty.status, verdict: emptyReport ? emptyReport.verdict : null, missingEvidence: emptyReport ? (emptyReport.missingEvidence || null) : null,
  });

  // --- 7. the CLI: a stale check is refused, the old PASS is not reported --
  const staleDir = path.join(WORK_DIR, 'stale');
  fs.mkdirSync(staleDir, { recursive: true });
  fs.writeFileSync(path.join(staleDir, 'check.json'), `${JSON.stringify({ ...staleCheck, verdict: 'PASS' }, null, 2)}\n`, 'utf8');
  const staleRun = runCli(['--report-only'], { QA_R44_EVIDENCE_DIR: staleDir });
  const staleReportExists = fs.existsSync(path.join(staleDir, 'report.json'));
  probe('a stale check is refused instead of reported as a PASS', staleRun.status === 2 && !staleReportExists, {
    exitCode: staleRun.status, reportWritten: staleReportExists, stderr: staleRun.stderr.trim().split('\n').slice(0, 2),
  });

  // --- 8. the frozen evidence cannot be written to --------------------------
  const frozenDir = FROZEN_DIRS[0];
  const before = digestTree(frozenDir);
  const frozenRun = runCli(['--check'], { QA_R44_EVIDENCE_DIR: frozenDir });
  const after = digestTree(frozenDir);
  const changed = Object.keys(after).filter(name => before[name] !== after[name]).concat(Object.keys(before).filter(name => !(name in after)));
  probe('the frozen evidence of another lane is refused', frozenRun.status === 2, { exitCode: frozenRun.status, stderr: frozenRun.stderr.trim().split('\n').slice(0, 2) });
  probe('the frozen evidence is byte-identical after the refused run', changed.length === 0, { changedFiles: changed, files: Object.keys(before).length });

  // --- 9. the CLI: the check itself still passes ----------------------------
  const checkDir = path.join(WORK_DIR, 'check');
  const checked = runCli(['--check'], { QA_R44_EVIDENCE_DIR: checkDir });
  const checkFile = path.join(checkDir, 'check.json');
  const checkResult = fs.existsSync(checkFile) ? JSON.parse(fs.readFileSync(checkFile, 'utf8')) : null;
  probe('the zero-model check passes at the current bytes', checked.status === 0 && Boolean(checkResult) && checkResult.verdict === 'PASS', {
    exitCode: checked.status, verdict: checkResult ? checkResult.verdict : null,
  });
  if (checkResult) {
    const failures = (checkResult.results || []).filter(entry => entry.status !== 'PASS').map(entry => entry.id);
    probe('every check of the run passed', failures.length === 0, { failures });
  }

  // --- the result -----------------------------------------------------------
  const failed = probes.filter(entry => !entry.ok);
  const result = {
    schema: 'qa-autopilot/wb-qa-finalize-r44d/regression/v1',
    lane: 'P-WB-QA-FINALIZE-R44D',
    at: new Date().toISOString(),
    mode: 'zero-model: no model request, no service, no browser',
    modelRequestsSent: 0,
    paidTurnsSent: 0,
    workDir: WORK_DIR,
    probes,
    verdict: failed.length === 0 ? 'PASS' : 'FAIL',
  };
  const out = String(process.env.QA_R44_REGRESSION_OUT || '').trim();
  if (out && !FROZEN_DIRS.some(frozen => isInside(out, frozen))) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    console.log(`RESULT ${out}`);
  }
  console.log(`qa-r44-regression verdict=${result.verdict} probes=${probes.length} failed=${failed.length}`);
  return result.verdict === 'PASS' ? 0 : 1;
}

try {
  process.exitCode = main();
} catch (error) {
  console.error(error && error.stack || error);
  process.exit(1);
}
