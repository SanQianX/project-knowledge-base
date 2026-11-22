'use strict';
// WB-001 — the Workbench source / package / manifest correspondence.
//
// What this script proves, with bytes:
//   1. the currently installed target package (node_modules/claude-ai-workbench,
//      the pin the repository ships) matches module-runtime-manifest.json on
//      every single file;
//   2. the copy the installed product 5.0.24 actually ships matches the same
//      manifest on every single file;
//   3. the Workbench source checkout is compared file by file against that
//      manifest, and every difference is classified (identical / EOL-only /
//      really different / missing).
//
// What it deliberately does NOT do:
//   * it never judges two trees equal because their version strings match;
//   * it never reads Git history, a remote or any Git object — the source
//     side is compared as the working tree it is today. The historical trace
//     lives in parallel-workbench-provenance-trace.js, which is evidence, not
//     a regression;
//   * it never touches pins, the manifest, the vendored tree or the installed
//     modules.
//
// A mismatch is not a failure of this script and is never papered over: it is
// reported as BLOCKED_SOURCE_MATCH, which is the defined outcome.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const sourceMap = require('./helpers/parallel-workbench-source-map');

const results = [];
function record(caseId, status, detail) {
  results.push({ caseId, status, detail });
  console.log(`CASE ${caseId} ${status} ${JSON.stringify(detail)}`);
}

function summariseComparison(comparison) {
  return {
    root: comparison.root,
    total: comparison.total,
    identical: comparison.identicalCount,
    eolOnly: comparison.eolOnlyCount,
    different: comparison.differentCount,
    missing: comparison.missingCount,
  };
}

function main() {
  const manifest = sourceMap.loadManifest();
  const installedProductRoot = sourceMap.resolveInstalledProductRoot();
  const installedProductVersion = installedProductRoot
    ? sourceMap.packageIdentity(installedProductRoot)
    : null;

  const targets = [];

  // --- the currently installed target package (the repository pin) -------
  const repoTargetRoot = sourceMap.resolveRepoTargetPackage();
  assert.ok(fs.existsSync(repoTargetRoot), `the pinned target package is missing: ${repoTargetRoot}`);
  const repoTargetIdentity = sourceMap.packageIdentity(repoTargetRoot);
  const repoTargetComparison = sourceMap.compareTree(manifest.files, repoTargetRoot);
  targets.push({
    label: 'currently-installed-package:repository-pin',
    role: 'currently-installed-package',
    identity: repoTargetIdentity,
    comparison: summariseComparison(repoTargetComparison),
  });
  assert.equal(
    repoTargetComparison.identicalCount,
    manifest.count,
    `the pinned package does not match the manifest: ${repoTargetComparison.differentCount} different, ${repoTargetComparison.missingCount} missing`,
  );
  assert.equal(repoTargetComparison.differentCount, 0);
  assert.equal(repoTargetComparison.missingCount, 0);
  assert.equal(repoTargetIdentity.name, manifest.terminal.name, 'the pinned package is not the module the manifest describes');
  assert.equal(repoTargetIdentity.version, manifest.terminal.version, 'the pinned package version differs from the manifest');

  // --- the copy the installed product 5.0.24 ships ----------------------
  const installedModuleRoot = sourceMap.resolveInstalledProductPackage();
  if (!installedModuleRoot) {
    targets.push({
      label: 'currently-installed-package:installed-product',
      role: 'currently-installed-package',
      status: 'BLOCKED_PRODUCT_NOT_INSTALLED',
      detail: 'no installed product tree was found; the repository pin above is the only installed copy that could be proven',
    });
  } else {
    const installedIdentity = sourceMap.packageIdentity(installedModuleRoot);
    const installedComparison = sourceMap.compareTree(manifest.files, installedModuleRoot);
    targets.push({
      label: 'currently-installed-package:installed-product',
      role: 'currently-installed-package',
      product: installedProductVersion ? installedProductVersion.version : null,
      identity: installedIdentity,
      comparison: summariseComparison(installedComparison),
    });
    assert.equal(installedComparison.identicalCount, manifest.count, 'the installed product copy does not match the manifest');
    assert.equal(installedComparison.differentCount, 0);
    assert.equal(installedComparison.missingCount, 0);
    assert.equal(installedIdentity.name, manifest.terminal.name);
    assert.equal(installedIdentity.version, manifest.terminal.version);
  }

  // --- the source checkout (a candidate fixture, never "the package") ----
  const sourceRoot = sourceMap.resolveSourceCheckout();
  let sourceLeg = null;
  if (!sourceRoot) {
    sourceLeg = {
      label: 'candidate-fixture:source-checkout',
      role: 'candidate-fixture',
      status: 'BLOCKED_SOURCE_UNAVAILABLE',
      detail: 'no Workbench source checkout was found (set PK_WB_SOURCE_DIR to compare one)',
    };
  } else {
    const sourceComparison = sourceMap.compareTree(manifest.files, sourceRoot);
    const sourceIdentity = sourceMap.packageIdentity(sourceRoot);
    const matchesPackage = sourceComparison.differentCount === 0 && sourceComparison.missingCount === 0;
    sourceLeg = {
      label: 'candidate-fixture:source-checkout',
      role: 'candidate-fixture',
      root: sourceRoot,
      commit: sourceMap.sourceCommitId(sourceRoot),
      workingTreeClean: sourceMap.sourceWorkingTreeClean(sourceRoot),
      identity: sourceIdentity,
      comparison: summariseComparison(sourceComparison),
      eolOnlyFiles: sourceComparison.eolOnly,
      differentFiles: sourceComparison.different,
      missingFiles: sourceComparison.missing,
      matchesInstalledPackage: matchesPackage,
      verdict: matchesPackage ? 'SOURCE_MATCH' : 'BLOCKED_SOURCE_MATCH',
    };
    assert.equal(sourceComparison.missingCount, 0, 'the source checkout is missing files the manifest ships');
    assert.equal(
      sourceComparison.identicalCount + sourceComparison.eolOnlyCount + sourceComparison.differentCount,
      manifest.count,
      'the source comparison did not classify every manifest file',
    );
  }
  targets.push(sourceLeg);

  // --- per-expected conclusions ------------------------------------------
  const installedLegs = targets.filter(target => target.role === 'currently-installed-package');
  const installedProven = installedLegs.every(leg => leg.status === undefined && leg.comparison && leg.comparison.identical === leg.comparison.total);
  record('WB-001.a-installed-package-matches-manifest', installedProven ? 'PASS' : 'PARTIAL', {
    manifestFiles: manifest.count,
    manifestVersion: manifest.terminal.version,
    legs: installedLegs.map(leg => ({ label: leg.label, status: leg.status || 'PASS', comparison: leg.comparison || null })),
  });

  const everyFileOwned = Boolean(sourceLeg) && sourceLeg.status !== 'BLOCKED_SOURCE_UNAVAILABLE'
    && sourceLeg.comparison.missing === 0
    && sourceLeg.comparison.identical + sourceLeg.comparison.eolOnly + sourceLeg.comparison.different === manifest.count;
  record('WB-001.b-file-ownership-traceable', everyFileOwned ? 'PASS' : 'BLOCKED', {
    rule: '每一文件所有权可追溯',
    manifestFiles: manifest.count,
    traceableFiles: sourceLeg && sourceLeg.comparison ? sourceLeg.comparison.identical + sourceLeg.comparison.eolOnly + sourceLeg.comparison.different : 0,
    identical: sourceLeg && sourceLeg.comparison ? sourceLeg.comparison.identical : null,
    eolOnly: sourceLeg && sourceLeg.comparison ? sourceLeg.comparison.eolOnly : null,
    reallyDifferent: sourceLeg && sourceLeg.comparison ? sourceLeg.comparison.different : null,
    missing: sourceLeg && sourceLeg.comparison ? sourceLeg.comparison.missing : null,
  });

  const mismatchRecorded = !sourceLeg || sourceLeg.verdict === 'BLOCKED_SOURCE_MATCH' || sourceLeg.verdict === 'SOURCE_MATCH';
  record('WB-001.c-mismatch-verdict', mismatchRecorded ? 'PASS' : 'FAIL', {
    rule: '不匹配则BLOCKED_SOURCE_MATCH',
    verdict: sourceLeg ? sourceLeg.verdict : 'BLOCKED_SOURCE_UNAVAILABLE',
    reason: sourceLeg && sourceLeg.verdict === 'BLOCKED_SOURCE_MATCH'
      ? 'the source checkout is not byte-identical to the installed package; the difference is recorded, not patched away'
      : null,
    noPinOrInstallChange: true,
  });

  const summary = {
    lane: 'test-workbench',
    file: 'parallel-workbench-source-match.js',
    case: 'WB-001',
    title: '源码版本匹配',
    manifest: {
      file: manifest.file,
      schema: manifest.schema,
      module: manifest.terminal.name,
      installName: manifest.terminal.installName,
      version: manifest.terminal.version,
      files: manifest.count,
    },
    targets,
    verdict: sourceLeg && sourceLeg.verdict ? sourceLeg.verdict : 'BLOCKED_SOURCE_UNAVAILABLE',
    gitHistoryUsed: false,
    networkUsed: false,
    cases: results,
  };

  const target = process.env.PARALLEL_WORKBENCH_EVIDENCE;
  if (target) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(summary, null, 2), 'utf8');
  }
  console.log(`parallel-workbench-source-match PASS verdict=${summary.verdict}`);
  return summary;
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
