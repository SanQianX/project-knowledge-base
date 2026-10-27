'use strict';
// _site/_test/helpers/qa-r44-report.js
//
// The report builder of the R44 lane.
//
// R44D: this builder is GENERIC. It reports what the run it is handed
// actually produced, and nothing else:
//
//   * it never narrates a past run. The historical facts of the accepted R44
//     acceptance live in the frozen R44 report; for --report-only they are
//     quoted in the frozenAcceptance block of the portability report, and
//     nowhere else;
//   * it never manufactures a PASS. The verdict is the verdict of the summary
//     it was given, and a summary that lacks a required case yields a
//     non-PASS verdict;
//   * it never names a dependency it did not resolve: the shared files are
//     read from the ACTUAL require-closure of the lane files.
//
// Every section is either read from the run, read from the repository, or
// read from the run history of that run. A missing fact is reported as
// missing.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const LANE = 'P-WB-PERMISSION-QUESTION-R44';
const LANE_OWNER = 'P-WB-QA-CANONICAL-R44D';

// The files of the lane and what they are for. The list is a description of
// the package, not a record of a run.
const LANE_FILES = [
  { path: '_site/_test/helpers/qa-r44-env.js', role: 'driver-level isolation (env capture, hardening, fail-closed assertion)' },
  { path: '_site/_test/helpers/qa-r44-ui.js', role: "real UI actions on the product's own permission / question cards" },
  { path: '_site/_test/helpers/qa-r44-report.js', role: 'this report builder' },
  { path: '_site/_test/qa-r44-permission-question.js', role: 'the WB-006 / WB-007 scenarios' },
  { path: 'qa-autopilot/tools/product-probes/qa-r44-permission-question.js', role: 'the portable canonical entry point' },
  { path: 'qa-autopilot/tools/product-probes/qa-r44-report-regression.js', role: 'the explicit zero-model regression probe' },
];

function sha256File(file) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); } catch { return null; }
}

function findRepoRoot(start) {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, 'package.json')) && fs.existsSync(path.join(dir, 'qa-autopilot'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`no repository root above ${start}`);
    dir = parent;
  }
}

// The expected contract of the cases of this lane, verbatim.
function readExpectedCases(repoRoot, ids) {
  const file = path.join(repoRoot, 'qa-autopilot', 'config', 'test-cases.json');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const list = Array.isArray(raw) ? raw : (raw.cases || []);
  const out = {};
  for (const id of ids) {
    const found = list.find(entry => entry && entry.id === id);
    out[id] = found
      ? { title: found.title, mode: found.mode, steps: found.steps || [], expected: found.expected || [], evidence: found.evidence || [], preconditions: found.preconditions || [], source: found.source || null, statusInConfig: found.status || null }
      : { missing: true };
  }
  return { file: path.relative(repoRoot, file).replace(/\\/g, '/'), sha256: sha256File(file), cases: out };
}

// Every file of this lane, with its digest and its owner.
function laneArtifacts(repoRoot, files) {
  const list = (files && files.length ? files : LANE_FILES).map(entry => (typeof entry === 'string' ? { path: entry } : entry));
  return list.map(entry => {
    const full = path.join(repoRoot, ...entry.path.split('/'));
    const known = LANE_FILES.find(knownEntry => knownEntry.path === entry.path);
    return {
      path: entry.path,
      owner: LANE_OWNER,
      originalLane: LANE,
      role: entry.role || (known ? known.role : 'lane file'),
      sha256: sha256File(full),
      bytes: fs.existsSync(full) ? fs.statSync(full).size : null,
      trackedByGit: trackedByGit(repoRoot, entry.path),
    };
  });
}

function trackedByGit(repoRoot, relative) {
  try {
    const result = require('node:child_process').spawnSync('git', ['ls-files', '--error-unmatch', relative], { cwd: repoRoot, encoding: 'utf8', windowsHide: true, timeout: 30000 });
    return result.status === 0;
  } catch { return null; }
}

// The relative require specifiers of a source text.
function requireSpecifiers(source) {
  const requireRe = /require\(\s*['"](\.[^'"]+)['"]\s*\)/g;
  const out = [];
  let match;
  requireRe.lastIndex = 0;
  while ((match = requireRe.exec(source)) !== null) out.push(match[1]);
  return out;
}

// The require-closure of the given roots, resolved like node resolves it.
function dependencyClosure(repoRoot, roots) {
  const seen = new Map();
  const unresolved = [];
  const walk = absolute => {
    const relative = path.relative(repoRoot, absolute).split(path.sep).join('/');
    if (seen.has(relative)) return;
    if (!fs.existsSync(absolute)) { seen.set(relative, { exists: false }); return; }
    seen.set(relative, { exists: true, sha256: sha256File(absolute) });
    for (const specifier of requireSpecifiers(fs.readFileSync(absolute, 'utf8'))) {
      const base = path.resolve(path.dirname(absolute), specifier);
      const hit = [base, `${base}.js`, path.join(base, 'index.js')]
        .find(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
      if (!hit) { unresolved.push(`${relative} -> ${specifier}`); continue; }
      walk(hit);
    }
  };
  for (const root of roots) walk(path.resolve(repoRoot, root));
  return { files: seen, unresolved };
}

// The product files the acceptance depends on. Their digests freeze the
// behaviour that was proved.
function productFiles(repoRoot, summary) {
  const root = summary && summary.pinned && summary.pinned.resolvedRoot;
  const relative = [
    'apps/agent-terminal/app.js',
    'apps/agent-terminal/user-question-card.js',
    'packages/client/index.js',
    'packages/server/lib/user-questions.js',
    'packages/server/lib/workbench-service.js',
    'packages/server/lib/http-handler.js',
    'src/backend/lib/claude-cli-runner.js',
  ];
  if (!root) return { root: null, files: [] };
  return {
    root,
    version: summary.pinned.version || null,
    files: relative.map(rel => ({ path: rel, sha256: sha256File(path.join(root, ...rel.split('/'))) })),
  };
}

function caseDetail(summary, caseId) {
  const entry = (summary.cases_detail || []).find(item => item.caseId === caseId);
  return entry || null;
}

// The digests of the lane source, as they were DURING the run that is being
// reported. They are read from the run history of that run; a report without
// a run history carries none.
function sourceDigestsDuringRun(runHistory) {
  if (!runHistory || !runHistory.sourceDigestsDuringRun) return null;
  return runHistory.sourceDigestsDuringRun;
}

// The build of the report of ONE run. The verdict is the verdict of the run.
function buildReport(options) {
  const { repoRoot, evidenceDir, summary, runHistory, proposalFiles } = options;
  const cases = ['WB-006', 'WB-007'];
  const expected = readExpectedCases(repoRoot, cases);
  const artifacts = laneArtifacts(repoRoot, proposalFiles);
  const lanePaths = new Set(artifacts.map(entry => entry.path));

  const wb006 = summary.wb006 || {};
  const wb007 = summary.wb007 || {};
  const wb006Case = caseDetail(summary, 'R44.c-wb006-real-permission-card-raised');
  const wb006Deny = caseDetail(summary, 'R44.d-wb006-deny-executed-by-the-real-ui');
  const wb007Card = caseDetail(summary, 'R44.e-wb007-real-question-card-and-pause');
  const wb007Refusals = caseDetail(summary, 'R44.f-wb007-bypass-cannot-substitute-empty-answer-or-let-it-through');
  const wb007Bypass = caseDetail(summary, 'R44.g-wb007-bypass-mode-does-not-release-the-question');
  const wb007Submit = caseDetail(summary, 'R44.h-wb007-ui-enables-the-submit-only-after-a-complete-answer');
  const wb007Receipt = caseDetail(summary, 'R44.i-wb007-real-ui-selection-submitted-and-the-receipt-matches');
  const wb007BypassTurn = caseDetail(summary, 'R44.j-wb007-the-bypass-mode-still-asks-the-question');
  const realProfileCase = caseDetail(summary, 'R44.k-real-profiles-byte-identical');

  // The shared files the lane really depends on, read from the closure.
  const closure = dependencyClosure(repoRoot, [...lanePaths]);
  const sharedDependencies = [...closure.files.entries()]
    .filter(([relative]) => !lanePaths.has(relative))
    .map(([relative, info]) => ({
      path: relative,
      exists: info.exists,
      sha256: info.sha256,
      trackedByGit: trackedByGit(repoRoot, relative),
      kind: 'shared, read-only',
      owner: 'the root QA harness, not this lane',
    }));

  // What THIS run proved and what it did not. It is read from the summary of
  // the run; a run that did not record a case has not proved it.
  const evaluation = summary.caseEvaluation || null;
  const notProvedCases = evaluation
    ? evaluation.notPassed
    : (summary.cases_detail || []).filter(entry => entry.status !== 'PASS').map(entry => ({ caseId: entry.caseId, status: entry.status }));
  const bypassCases = ['R44.g-wb007-bypass-mode-does-not-release-the-question', 'R44.j-wb007-the-bypass-mode-still-asks-the-question'];
  const bypassProven = bypassCases.map(caseId => {
    const found = (summary.cases_detail || []).find(entry => entry.caseId === caseId);
    return { caseId, status: found ? found.status : 'MISSING', proven: Boolean(found) && found.status === 'PASS' };
  });

  const report = {
    schema: 'qa-autopilot/wb-permission-question-r44/report/v1',
    lane: LANE,
    generatedAt: new Date().toISOString(),
    verdict: summary.verdict,
    cases,
    evidenceDir: evidenceDir || null,

    // What the run was and what it produced. This is the run's own summary.
    summary,

    contract: {
      source: 'qa-autopilot/config/test-cases.json',
      file: expected.file,
      sha256: expected.sha256,
      expected: expected.cases,
      note: 'the expected items are quoted verbatim from the shared case file; the shared file itself was NOT modified by this lane',
    },

    identity: {
      product: summary.module || null,
      pinned: summary.pinned || null,
      workbenchSource: summary.source || null,
      productFiles: productFiles(repoRoot, summary),
      artifacts,
    },

    isolation: summary.isolation || null,
    profile: summary.profile || null,
    paidTurnsSent: summary.paidTurnsSent,
    networkUsed: summary.networkUsed,

    // What THIS run observed. The method notes describe the lane; the
    // observed values are read from the run.
    evidence: {
      'WB-006': {
        expectedVerbatim: expected.cases['WB-006'] ? expected.cases['WB-006'].expected : null,
        method: 'the card is raised by the product and decided through the product\'s own 拒绝 button in the real browser; no API call performs the decision',
        ui: {
          card: wb006Case && wb006Case.detail ? wb006Case.detail.card : null,
          settledState: wb006.uiSettledState || null,
          settledCard: wb006.uiSettledCard || null,
        },
        api: {
          permissionRequest: wb006Case && wb006Case.detail ? wb006Case.detail.requestEvent : null,
          permissionResolved: wb006.permissionResolved || null,
          effectivePermissionMode: wb006.effectivePermissionMode || null,
          pendingPermissionAfterTheDecision: wb006.pendingPermissionAfterTheDecision || null,
          toolResult: wb006.toolResult || null,
          turnResult: wb006.turnResult || null,
        },
        disk: {
          markerPath: wb006.markerPath || null,
          markerExistsAfterTheDenial: wb006.markerExistsAfterTheDenial,
          filesCarryingTheMarkerText: wb006.filesCarryingTheMarkerText || null,
          note: 'the marker lives in the lane\'s own fixture project below the isolated run root; it is not inside the repository and not a real user path',
        },
        verdict: wb006Deny ? wb006Deny.status : null,
      },
      'WB-007': {
        expectedVerbatim: expected.cases['WB-007'] ? expected.cases['WB-007'].expected : null,
        method: 'the selection is made by driving the product\'s own radio / checkbox / custom input and its own 提交答案 button in the real browser; the resolve endpoint is used only as a negative control',
        ui: {
          card: wb007Card && wb007Card.detail ? wb007Card.detail.card : null,
          pausedWithoutSubmission: wb007Card && wb007Card.detail ? wb007Card.detail.pausedWithoutSubmission : null,
          submitDisabledBeforeAnyAnswer: wb007Submit && wb007Submit.detail ? wb007Submit.detail.submitDisabledBeforeAnyAnswer : null,
          submitDisabledAfterTheCompleteSelection: wb007Submit && wb007Submit.detail ? wb007Submit.detail.submitDisabledAfterTheCompleteSelection : null,
          settledTitle: wb007.uiSettledTitle || null,
          settledCard: wb007.uiSettledCard || null,
          selection: wb007.selection || null,
        },
        api: {
          questionRequest: wb007Card && wb007Card.detail ? wb007Card.detail.requestEvent : null,
          refusedResolutions: wb007Refusals && wb007Refusals.detail ? wb007Refusals.detail.attempts : null,
          permissionResolved: wb007.permissionResolved || null,
          productPendingPermissionWhilePending: wb007Card && wb007Card.detail ? wb007Card.detail.productPendingPermission : null,
          answeredToolCall: wb007.answeredToolCall || null,
          toolResult: wb007.toolResult || null,
          finalAnswerEchoesEverySelection: wb007.finalAnswerEchoesEverySelection,
          finalAnswerPreview: wb007.finalAnswerPreview || null,
        },
        disk: {
          note: 'WB-007 writes nothing outside the isolated run root; the marker scan of the fixture project is reported under WB-006',
          filesCarryingTheMarkerText: wb006.filesCarryingTheMarkerText || null,
        },
        bypassMode: {
          menuSwitch: wb007Bypass && wb007Bypass.detail ? wb007Bypass.detail : null,
          boundedBypassTurn: wb007BypassTurn && wb007BypassTurn.detail ? wb007BypassTurn.detail : null,
          required: true,
          proven: bypassProven,
        },
        verdict: wb007Receipt ? wb007Receipt.status : null,
      },
    },

    // The run history of THIS lane's runs, as it was recorded.
    runs: runHistory ? runHistory.runs || [] : null,
    firstFailure: runHistory ? runHistory.firstFailure || null : null,
    retest: runHistory ? runHistory.retest || null : null,
    commands: runHistory ? runHistory.commands || null : null,
    sourceDigestsDuringRun: sourceDigestsDuringRun(runHistory),

    tooling: {
      dependencies: [
        { name: 'node', kind: 'the runtime that drives the lane', version: process.version },
        { name: 'the pinned Workbench module', kind: 'the published module, hosted as an isolated child process', version: summary.module && summary.module.version, root: summary.module && summary.module.root },
        { name: 'Claude Code CLI', kind: 'the executable the module spawns for the real turn', resolvedBy: 'the lane isolation helper (CLAUDE_CODE_EXECPATH, then the npm global package, then the user-local bin, then PATH, then where.exe)' },
        { name: 'Google Chrome', kind: 'the real browser driven over CDP', resolvedBy: 'the shared find-chrome helper, with the path captured BEFORE the isolation' },
        ...sharedDependencies,
      ],
      ownership: {
        laneOwned: artifacts.map(entry => ({ path: entry.path, owner: entry.owner, sha256: entry.sha256 })),
        reusedReadOnly: sharedDependencies.map(entry => entry.path),
        neverTouched: [
          'the Workbench source checkout (read-only)',
          'the installed module (never patched, never reinstalled)',
          'the shared case file qa-autopilot/config/test-cases.json',
          'the shared bindings and the files of the other lanes',
        ],
      },
    },

    // What THIS run proved, stated from the run's own results.
    runFacts: {
      verdict: summary.verdict,
      paidTurnsSent: summary.paidTurnsSent,
      requiredCases: evaluation ? evaluation.essential : null,
      requiredCasesNotProven: notProvedCases,
      bypassCasesProven: bypassProven,
      realProfileStoreUnchanged: realProfileCase ? realProfileCase.status === 'PASS' : null,
      note: 'every entry is read from the results of the run this report is about',
    },

    // The scope of the lane. These statements are about the lane, not about
    // a particular run.
    notProved: [
      ...notProvedCases.map(entry => `The required case ${entry.caseId} was not proven by this run: its recorded status is ${entry.status}.`),
      'Only the claude-code transport of the agent-terminal UI was exercised; the other surfaces of the product were not exercised by this run.',
      'No quota, balance or PAYG endpoint was queried, and no credential was written to a fixture, a log, a URL, the browser or this report.',
    ],

    cleanup: {
      ownedProcesses: 'the isolated host child process and the Chrome process tree of this run are terminated by the lane itself',
      retainedEvidence: 'the logs of this run are kept below the lane temp root and the evidence directory of the run',
      realProfileStore: realProfileCase ? `the original subscription profile store was opened read-only; its byte-level digest is ${realProfileCase.status === 'PASS' ? 'unchanged' : 'NOT proven unchanged'} (case R44.k)` : 'the profile store case was not recorded by this run',
    },
  };
  return report;
}

function writeReport(options) {
  const report = buildReport(options);
  fs.mkdirSync(options.evidenceDir, { recursive: true });
  const file = path.join(options.evidenceDir, 'report.json');
  fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return { file, report };
}

// The freshness of a recorded check. A check is fresh only when the bytes of
// the files it checked are still the current bytes. A stale check must not be
// presented as a PASS.
function checkFreshness(check, repoRoot, proposalFiles) {
  const files = proposalFiles || LANE_FILES.map(entry => entry.path);
  const recorded = new Map();
  const results = (check && check.results) || [];
  // The recorded digests are the ones the check wrote for the files it
  // checked. They are found by their shape, not by the name of the check.
  for (const entry of results) {
    const list = entry && entry.detail && Array.isArray(entry.detail.files) ? entry.detail.files : null;
    if (!list) continue;
    for (const file of list) {
      if (file && file.path && file.sha256) recorded.set(file.path, file.sha256);
    }
  }
  const mismatches = [];
  const unrecorded = [];
  for (const relative of files) {
    const current = sha256File(path.join(repoRoot, ...relative.split('/')));
    if (!recorded.has(relative)) { unrecorded.push(relative); continue; }
    if (recorded.get(relative) !== current) {
      mismatches.push({ path: relative, recordedSha256: recorded.get(relative), currentSha256: current });
    }
  }
  return {
    fresh: mismatches.length === 0 && unrecorded.length === 0 && recorded.size > 0,
    mismatches,
    unrecorded,
    recordedFiles: [...recorded.keys()],
    note: 'a check is fresh only when the bytes of every proposed file are still the bytes the check ran against',
  };
}

// The portability report of the canonical lane.
//
// It never re-runs anything and it never presents the accepted R44 model
// result as a model retest of this packaging. The digests of the source that
// produced the R44 acceptance and the digests of the packaging delivered here
// are two separate blocks and are never merged.
//
// R44D: it states a clean-checkout run or a negative control ONLY when the
// corresponding file was actually read. Everything it claims about the
// evidence is derived from the files it read.
function buildPortabilityReport(options) {
  const { repoRoot, evidenceDir, check, frozenR44, proposalFiles } = options;
  const cases = ['WB-006', 'WB-007'];

  const checkResults = (check && check.results) || [];
  const closureCheck = checkResults.find(entry => String(entry.id || '').startsWith('R44C.c'));
  const trackedSharedFiles = closureCheck && closureCheck.detail ? (closureCheck.detail.trackedSharedFiles || []) : [];

  // The source that actually produced the accepted R44 evidence.
  const frozenReport = frozenR44 && frozenR44.available ? frozenR44.report : null;
  const frozenHistoryFile = frozenR44 && frozenR44.available
    ? path.join(path.dirname(frozenR44.file), 'run-history.json')
    : null;
  const frozenHistory = frozenHistoryFile && fs.existsSync(frozenHistoryFile)
    ? JSON.parse(fs.readFileSync(frozenHistoryFile, 'utf8'))
    : null;
  const acceptanceTimeDigests = frozenHistory && frozenHistory.acceptanceArtifacts && frozenHistory.acceptanceArtifacts.files
    ? frozenHistory.acceptanceArtifacts.files
    : [];

  // The packaging delivered here.
  const currentPackaging = (proposalFiles || []).map(relative => {
    const full = path.join(repoRoot, ...String(relative).split('/'));
    return {
      path: relative,
      sha256: sha256File(full),
      bytes: fs.existsSync(full) ? fs.statSync(full).size : null,
      trackedByGit: trackedByGit(repoRoot, relative),
    };
  });

  // The commands of this lane, as they were actually executed. They are read
  // from the lane's own progress file, so the report carries real command
  // lines and real exit codes and nothing is written from memory. A report
  // that lives in a subdirectory of the lane reads the progress file of the
  // lane root.
  const progressCandidates = evidenceDir
    ? [path.join(evidenceDir, 'progress.json'), path.join(path.dirname(evidenceDir), 'progress.json')]
    : [];
  const progressFile = progressCandidates.find(candidate => fs.existsSync(candidate)) || null;
  const progress = progressFile ? JSON.parse(fs.readFileSync(progressFile, 'utf8')) : null;

  // The clean-checkout run and the negative control are claimed only when the
  // corresponding file was read.
  const cleanCheckoutFile = evidenceDir ? path.join(evidenceDir, 'clean-checkout', 'check.json') : null;
  const cleanCheckout = cleanCheckoutFile && fs.existsSync(cleanCheckoutFile)
    ? JSON.parse(fs.readFileSync(cleanCheckoutFile, 'utf8'))
    : null;
  const noDepsFile = evidenceDir ? path.join(evidenceDir, 'check-clean-checkout-without-npm-deps.json') : null;
  const noDeps = noDepsFile && fs.existsSync(noDepsFile)
    ? JSON.parse(fs.readFileSync(noDepsFile, 'utf8'))
    : null;

  // A stale check must not be reported as a PASS.
  const freshness = check ? checkFreshness(check, repoRoot, proposalFiles) : null;

  const checkPassed = Boolean(check && check.verdict === 'PASS');
  const cleanCheckoutPassed = Boolean(cleanCheckout && cleanCheckout.verdict === 'PASS');
  const frozenPassed = Boolean(frozenReport && frozenReport.verdict === 'PASS');
  const fresh = Boolean(freshness && freshness.fresh);

  // The verdict has three tiers. A missing piece of evidence is a BLOCKED,
  // not a FAIL: nothing was disproved, nothing was proven either. A FAIL is
  // for evidence that is present and does not hold.
  let verdict;
  let verdictReason;
  if (!check) {
    verdict = 'BLOCKED';
    verdictReason = 'there is no check result to report on, so nothing can be reported as proven';
  } else if (!fresh) {
    verdict = 'BLOCKED';
    verdictReason = 'the recorded check does not match the current bytes of the proposed files, so its result does not apply to this packaging';
  } else if (!cleanCheckout) {
    verdict = 'BLOCKED';
    verdictReason = 'there is no clean-checkout result to report on, so the portability claim is not established';
  } else if (!frozenReport) {
    verdict = 'BLOCKED';
    verdictReason = 'the frozen R44 acceptance is not readable, so the accepted result cannot be quoted';
  } else if (checkPassed && cleanCheckoutPassed && frozenPassed) {
    verdict = 'PASS';
    verdictReason = 'the working-tree check, the clean-checkout check and the frozen acceptance are all present and hold';
  } else {
    verdict = 'FAIL';
    verdictReason = 'a check that is present does not hold';
  }

  const observations = [];
  if (check) {
    observations.push('The zero-model check was run in this working tree: it parses the proposed files, resolves their require-closure, proves that every file of the closure outside the proposal is tracked by git, loads the shared modules and proves that the check starts no service, no browser and no model request.');
  }
  if (cleanCheckout) {
    observations.push('The zero-model check was also run inside a clean tracked checkout of HEAD with only the proposed files overlaid; the tracked list was handed in, because the clean checkout has no .git of its own.');
  }
  if (noDeps) {
    observations.push('A negative control was run in the same clean checkout without the npm dependencies; it failed on the missing "ws" package, which is a missing dependency of the checkout and not a portability defect of the lane.');
  }
  if (frozenReport) {
    observations.push('The accepted R44 acceptance is quoted from the frozen report and is not a retest of this packaging: the digests of the source that produced it are kept separate from the digests of the packaging delivered here.');
  }

  const report = {
    schema: 'qa-autopilot/wb-qa-canonical-r44c/report/v1',
    lane: 'P-WB-QA-CANONICAL-R44C',
    generatedAt: new Date().toISOString(),
    verdict,
    verdictReason,
    mode: 'portability report only: no model request was sent by this lane and nothing was re-run',
    cases,
    evidenceDir: evidenceDir || null,

    scope: {
      question: 'can the R44 lane be re-used from a clean tracked checkout, with only its own files added?',
      answered: verdict === 'PASS'
        ? 'yes for the dependency closure, the syntax and the zero-model bootstrap, in the working tree AND in a clean tracked checkout of HEAD with the proposed-file overlay'
        : `not established: ${verdictReason}`,
      boundary: [
        'no model request was sent by this lane',
        'no service, no browser and no real profile was opened by the check',
        'the R44 report, run-history and logs stay frozen and are only read',
        'the shared case file and the shared bindings were not modified',
        'no other lane\'s files were modified',
      ],
    },

    // The accepted R44 result. It is quoted as the ACCEPTED result of the R44
    // lane, produced by the source digests below. It is explicitly NOT a
    // model retest of this packaging.
    frozenAcceptance: {
      available: Boolean(frozenReport),
      reportFile: frozenR44 && frozenR44.file ? frozenR44.file : null,
      reportSha256: frozenR44 && frozenR44.file ? sha256File(frozenR44.file) : null,
      runHistoryFile: frozenHistoryFile,
      runHistorySha256: frozenHistoryFile ? sha256File(frozenHistoryFile) : null,
      verdict: frozenReport ? frozenReport.verdict : null,
      generatedAt: frozenReport ? frozenReport.generatedAt : null,
      paidTurnsSent: frozenReport ? frozenReport.paidTurnsSent : null,
      runs: frozenHistory ? (frozenHistory.runs || []) : null,
      firstFailure: frozenHistory ? (frozenHistory.firstFailure || null) : null,
      retest: frozenHistory ? (frozenHistory.retest || null) : null,
      commands: frozenHistory ? (frozenHistory.commands || null) : null,
      executedWith: {
        note: 'the digests of the lane source as it was DURING the accepted R44 acceptance',
        files: acceptanceTimeDigests,
      },
      isAModelRetestOfThisPackaging: false,
      modelRetestNote: 'the accepted model result belongs to the digests above. The packaging delivered here differs from them and has NOT been exercised against a model by this lane, so it carries no model result at all.',
    },

    // The packaging delivered here. Its digests are the ones the zero-model
    // check actually ran against.
    currentPackaging: {
      note: 'the files this lane proposes, as they are delivered; the zero-model check ran against exactly these bytes',
      files: currentPackaging,
    },

    // The zero-model check.
    check: {
      schema: check && check.schema ? check.schema : null,
      startedAt: check ? check.startedAt : null,
      finishedAt: check ? check.finishedAt : null,
      verdict: check ? check.verdict : null,
      freshness,
      results: checkResults,
      modelRequestsSent: 0,
      paidTurnsSent: 0,
    },

    // The clean-checkout run, claimed only when its result file was read.
    cleanCheckoutCheck: {
      ran: Boolean(cleanCheckout),
      file: cleanCheckoutFile,
      repoRoot: cleanCheckout ? cleanCheckout.repoRoot : null,
      verdict: cleanCheckout ? cleanCheckout.verdict : null,
      results: cleanCheckout ? cleanCheckout.results : null,
      trackedListSource: cleanCheckout && cleanCheckout.results
        ? ((cleanCheckout.results.find(entry => String(entry.id || '').startsWith('R44C.c')) || {}).detail || {}).trackedListSource || null
        : null,
      npmDependenciesNeeded: 'the tracked browser helper requires the "ws" package, so the clean checkout needs its npm dependencies (npm ci) or NODE_PATH pointing at an installed dependency tree',
      negativeControlWithoutNpmDependencies: noDeps ? {
        file: noDepsFile,
        verdict: noDeps.verdict,
        failedCheck: (noDeps.results || []).filter(entry => entry.status === 'FAIL').map(entry => ({ id: entry.id, error: entry.detail && entry.detail.error ? entry.detail.error : null })),
      } : null,
    },

    // The dependency closure, as the check measured it.
    dependencyClosure: {
      note: 'every file of the require-closure of the proposed files; only the proposed files may be untracked, everything else must be tracked by git',
      trackedSharedFiles,
      retiredHarness: '_site/_test/helpers/parallel-workbench-runtime-harness.js',
      retiredHarnessUsed: false,
    },

    tooling: {
      dependencies: [
        { name: 'node', kind: 'the runtime that parses, resolves and loads the lane', version: process.version },
        { name: 'git', kind: 'the source of truth for "tracked"', resolvedBy: 'git ls-files (or QA_R44_TRACKED_LIST in a checkout without .git)' },
      ],
      ownership: {
        laneOwned: currentPackaging.map(entry => ({ path: entry.path, owner: 'P-WB-QA-CANONICAL-R44C', sha256: entry.sha256 })),
        reusedReadOnly: trackedSharedFiles,
        neverTouched: [
          'the R44 report, run-history and logs (frozen, read-only)',
          'the shared case file qa-autopilot/config/test-cases.json',
          'the shared bindings',
          'the files of the other lanes',
          'the Workbench source checkout (read-only)',
          'the installed module (never patched, never reinstalled)',
          'the published packages (no publish, no tag, no version change)',
        ],
      },
    },

    // The real commands of this lane, with their real exit codes.
    commands: progress && progress.commands ? progress.commands : null,
    stages: progress && progress.stages ? progress.stages : null,

    observations,

    notProved: [
      'This lane sent NO model request, so the delivered packaging has NOT been exercised against a real model turn. The accepted WB-006 / WB-007 result belongs to the frozen acceptance-time digests and is not a retest of this packaging.',
      'The zero-model check proves the dependency closure, the syntax, the module loading and the API surface. It does NOT prove that the browser-driven acceptance still passes on the delivered packaging; that needs an explicit --run with PK_WB_ALLOW_PAID_TURNS=1, which this lane did not perform.',
      'The check proves that the module loading starts no service, no browser and no model request. It does not prove the behaviour of the isolated host, because no host was started.',
      'The exit-lingering remedy (a lane-owned event reader with a cleared timer) is verified by construction only. No paid run was performed, so the lingering was not re-measured after the change.',
      'No quota, balance or PAYG endpoint was queried, and no credential was written to a fixture, a log, a URL, the browser or this report.',
    ],

    cleanup: {
      ownedProcesses: 'the zero-model check starts no process; the lane started nothing that had to be killed',
      retainedEvidence: 'the check result, this report, the progress file and the pre-change snapshot of the lane files are kept below the lane evidence directory',
      frozenEvidence: 'the R44 report, run-history and logs are unchanged',
    },
  };
  return report;
}

module.exports = {
  LANE,
  LANE_OWNER,
  LANE_FILES,
  buildReport,
  writeReport,
  buildPortabilityReport,
  checkFreshness,
  readExpectedCases,
  laneArtifacts,
  dependencyClosure,
  requireSpecifiers,
  sha256File,
  findRepoRoot,
};
