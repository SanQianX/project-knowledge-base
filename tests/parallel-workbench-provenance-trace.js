'use strict';
// WB-001 provenance trace — evidence only, never a regression.
//
// The canonical source-match script compares trees that exist today. This
// script answers the other half of the question: which commit of the
// Workbench source checkout is the installed package actually built from,
// and which later commit moved the source away from it.
//
// It reads Git objects of the source checkout (that is the point of the
// trace), it never writes to that checkout, and it never changes a pin, the
// manifest or the vendored tree. It fails loudly when the checkout or the
// history is unavailable.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const sourceMap = require('./helpers/parallel-workbench-source-map');

// The Git blob id of a buffer: sha1("blob <length>\0<content>").
function gitBlobId(buffer) {
  const hash = crypto.createHash('sha1');
  hash.update(`blob ${buffer.length}\0`);
  hash.update(buffer);
  return hash.digest('hex');
}

function git(sourceRoot, args) {
  return execFileSync('git', args, { cwd: sourceRoot, windowsHide: true, encoding: 'utf8', maxBuffer: 1 << 26 });
}

// Blob ids of every manifest file at one commit.
function treeBlobs(sourceRoot, commit) {
  const out = git(sourceRoot, ['ls-tree', '-r', commit]);
  const blobs = new Map();
  for (const line of out.split(/\r?\n/)) {
    const match = /^(\d{6})\s+blob\s+([0-9a-f]{40})\t(.+)$/.exec(line.trim());
    if (match) blobs.set(match[3].replace(/\\/g, '/'), match[2]);
  }
  return blobs;
}

function main() {
  const manifest = sourceMap.loadManifest();
  const sourceRoot = sourceMap.resolveSourceCheckout();
  if (!sourceRoot) throw new Error('no Workbench source checkout was found (set PK_WB_SOURCE_DIR)');
  const packageRoot = sourceMap.resolveRepoTargetPackage();
  if (!fs.existsSync(packageRoot)) throw new Error(`the pinned target package is missing: ${packageRoot}`);

  const head = sourceMap.sourceCommitId(sourceRoot);
  const commits = git(sourceRoot, ['rev-list', `--max-count=40`, 'HEAD']).split(/\r?\n/).map(line => line.trim()).filter(Boolean);

  // The local blob id of each shipped file: the raw bytes and the
  // CRLF-normalised bytes, so a Windows checkout still matches an LF blob.
  const localBlobs = new Map();
  for (const relative of Object.keys(manifest.files)) {
    const content = fs.readFileSync(path.join(packageRoot, relative));
    const normalized = Buffer.from(content.toString('utf8').replace(/\r\n/g, '\n'), 'utf8');
    localBlobs.set(relative, new Set([gitBlobId(content), gitBlobId(normalized)]));
  }

  const matches = [];
  const examined = [];
  for (const commit of commits) {
    const blobs = treeBlobs(sourceRoot, commit);
    let matched = 0;
    let absent = 0;
    const differing = [];
    for (const [relative, ids] of localBlobs) {
      const blob = blobs.get(relative);
      if (!blob) { absent += 1; continue; }
      if (ids.has(blob)) matched += 1;
      else differing.push(relative);
    }
    examined.push({ commit, subject: git(sourceRoot, ['log', '-1', '--format=%s', commit]).trim(), matched, absent, differing: differing.length });
    if (matched === localBlobs.size && absent === 0) matches.push({ commit, subject: git(sourceRoot, ['log', '-1', '--format=%s', commit]).trim() });
  }

  const sourceComparison = sourceMap.compareTree(manifest.files, sourceRoot);
  const differingFiles = sourceComparison.different;
  const provenance = differingFiles.map(relative => ({
    file: relative,
    commitsTouching: sourceMap.commitsTouchingFile(sourceRoot, relative),
  }));

  // The newest examined commit whose shipped files still match the package.
  const newestMatch = matches.length ? matches[0] : null;
  const newestMatchIndex = newestMatch ? examined.findIndex(entry => entry.commit === newestMatch.commit) : -1;
  const newerThanPackage = newestMatchIndex > 0 ? examined.slice(0, newestMatchIndex) : [];

  const summary = {
    lane: 'test-workbench',
    file: 'parallel-workbench-provenance-trace.js',
    role: 'evidence-only (reads Git objects of the source checkout; not a regression)',
    manifest: { file: manifest.file, module: manifest.terminal.name, version: manifest.terminal.version, files: manifest.count },
    packageRoot,
    sourceRoot,
    sourceHead: head,
    sourceWorkingTreeClean: sourceMap.sourceWorkingTreeClean(sourceRoot),
    packageEqualsCommit: matches.length ? matches : null,
    newestMatchingCommit: newestMatch,
    commitsNewerThanPackage: newerThanPackage,
    commitsExamined: examined.length,
    examined: examined.slice(0, 12),
    sourceWorkingTreeVsPackage: {
      identical: sourceComparison.identicalCount,
      eolOnly: sourceComparison.eolOnlyCount,
      different: sourceComparison.differentCount,
      missing: sourceComparison.missingCount,
      eolOnlyFiles: sourceComparison.eolOnly,
      differentFiles: sourceComparison.different,
    },
    provenanceOfDifferences: provenance,
    gitHistoryUsed: true,
    networkUsed: false,
    conclusion: newestMatch
      ? `the installed package is byte-identical (CRLF-normalised) to the source checkout at ${newestMatch.commit} (${newestMatch.subject}); the checkout head ${head} is ${newerThanPackage.length} commit(s) newer and already differs in ${sourceComparison.differentCount} shipped file(s)`
      : 'no examined commit matches the installed package byte for byte',
  };

  const target = process.env.PARALLEL_WORKBENCH_EVIDENCE;
  if (target) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(summary, null, 2), 'utf8');
  }
  console.log(JSON.stringify({ conclusion: summary.conclusion, packageEqualsCommit: summary.packageEqualsCommit, sourceHead: head }, null, 2));
  return summary;
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
