'use strict';
// Lane-owned helpers for the Workbench provenance batch (WB001).
//
// They answer one question with bytes, never with version strings:
//   module-runtime-manifest.json  <->  the currently installed package
//   module-runtime-manifest.json  <->  the Workbench source checkout
//
// A file is compared three ways, in this order:
//   identical   the raw sha256 equals the manifest hash
//   eolOnly     the sha256 differs but the CRLF-normalised content matches
//               (npm tarballs ship LF, a Windows checkout carries CRLF)
//   different   the content really differs
//
// Every path is resolved from the repository location or from an explicit
// environment override, so nothing here depends on a developer directory.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const MANIFEST_FILE = path.join(REPO_ROOT, 'module-runtime-manifest.json');

function sha256Buffer(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

// The same content with the line endings normalised to LF.
function normalizedSha256(value) {
  return sha256Buffer(Buffer.from(value.toString('utf8').replace(/\r\n/g, '\n'), 'utf8'));
}

function sha256File(filePath) {
  return fs.existsSync(filePath) ? sha256Buffer(fs.readFileSync(filePath)) : null;
}

function loadManifest() {
  if (!fs.existsSync(MANIFEST_FILE)) throw new Error(`module manifest is missing: ${MANIFEST_FILE}`);
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf8'));
  const terminal = manifest.modules && manifest.modules.terminal;
  if (!terminal || !terminal.files || typeof terminal.files !== 'object') {
    throw new Error('module manifest has no modules.terminal.files');
  }
  return {
    file: MANIFEST_FILE,
    schema: manifest.schema,
    terminal,
    files: terminal.files,
    count: Object.keys(terminal.files).length,
  };
}

function packageIdentity(root) {
  const packageFile = path.join(root, 'package.json');
  if (!fs.existsSync(packageFile)) return null;
  const pkg = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
  return { root, packageFile, name: pkg.name, version: pkg.version };
}

// Classify every manifest file against a candidate tree.
function compareTree(manifestFiles, root) {
  const identical = [];
  const eolOnly = [];
  const different = [];
  const missing = [];
  for (const [relative, expected] of Object.entries(manifestFiles)) {
    const target = path.join(root, relative);
    if (!fs.existsSync(target)) { missing.push(relative); continue; }
    const content = fs.readFileSync(target);
    if (sha256Buffer(content) === expected) { identical.push(relative); continue; }
    if (normalizedSha256(content) === expected) { eolOnly.push(relative); continue; }
    different.push(relative);
  }
  return {
    root,
    total: Object.keys(manifestFiles).length,
    identical,
    eolOnly,
    different,
    missing,
    identicalCount: identical.length,
    eolOnlyCount: eolOnly.length,
    differentCount: different.length,
    missingCount: missing.length,
  };
}

// The package the repository pins: node_modules/claude-ai-workbench.
function resolveRepoTargetPackage() {
  return path.join(REPO_ROOT, 'node_modules', 'claude-ai-workbench');
}

// The package the installed product (5.0.24) actually ships.
function resolveInstalledProductPackage() {
  const override = String(process.env.PK_WB_INSTALLED_PRODUCT_MODULE || '').trim();
  if (override) return fs.existsSync(override) ? override : null;
  const appData = String(process.env.APPDATA || '').trim();
  if (!appData) return null;
  const candidate = path.join(appData, 'npm', 'node_modules', '@sanqianx', 'project-knowledge', 'node_modules', 'claude-ai-workbench');
  return fs.existsSync(candidate) ? candidate : null;
}

function resolveInstalledProductRoot() {
  const override = String(process.env.PK_WB_INSTALLED_PRODUCT_ROOT || '').trim();
  if (override) return fs.existsSync(override) ? override : null;
  const appData = String(process.env.APPDATA || '').trim();
  if (!appData) return null;
  const candidate = path.join(appData, 'npm', 'node_modules', '@sanqianx', 'project-knowledge');
  return fs.existsSync(path.join(candidate, 'package.json')) ? candidate : null;
}

// The Workbench source checkout: an explicit override, or a sibling of this
// repository.
function resolveSourceCheckout() {
  const override = String(process.env.PK_WB_SOURCE_DIR || '').trim();
  const candidates = override ? [override] : [path.join(path.dirname(REPO_ROOT), 'claude-ai-workbench')];
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'packages', 'server', 'package.json'))) return path.resolve(candidate);
  }
  return null;
}

// The commit the checkout currently stands on. This reads the working state
// of the checkout, never a historical object.
function sourceCommitId(root) {
  if (!root) return null;
  try {
    const out = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, windowsHide: true, encoding: 'utf8' });
    return out.trim();
  } catch {
    return null;
  }
}

function sourceWorkingTreeClean(root) {
  if (!root) return null;
  try {
    const out = execFileSync('git', ['status', '--porcelain'], { cwd: root, windowsHide: true, encoding: 'utf8' });
    return out.trim().length === 0;
  } catch {
    return null;
  }
}

// Provenance trace against a historical commit of the source checkout.
// This reads Git objects and is therefore NOT part of the canonical test:
// it is evidence for the report, and it fails loudly when the commit or the
// Git history is unavailable.
function traceAgainstCommit(sourceRoot, commit, manifestFiles, packageRoot) {
  if (!sourceRoot) throw new Error('source checkout is required to trace a commit');
  const identical = [];
  const different = [];
  const absent = [];
  for (const relative of Object.keys(manifestFiles)) {
    let committed;
    try {
      committed = execFileSync('git', ['show', `${commit}:${relative}`], { cwd: sourceRoot, windowsHide: true, maxBuffer: 1 << 26 });
    } catch {
      absent.push(relative);
      continue;
    }
    const shipped = fs.readFileSync(path.join(packageRoot, relative));
    if (normalizedSha256(committed) === normalizedSha256(shipped)) identical.push(relative);
    else different.push(relative);
  }
  return { commit, identical, different, absent, identicalCount: identical.length, differentCount: different.length, absentCount: absent.length };
}

// Which commits of the source checkout touch a given file, newest first.
function commitsTouchingFile(sourceRoot, relative, limit = 8) {
  try {
    const out = execFileSync('git', ['log', `--format=%h %s`, `-${limit}`, '--', relative], { cwd: sourceRoot, windowsHide: true, encoding: 'utf8' });
    return out.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

module.exports = {
  REPO_ROOT,
  MANIFEST_FILE,
  sha256Buffer,
  normalizedSha256,
  sha256File,
  loadManifest,
  packageIdentity,
  compareTree,
  resolveRepoTargetPackage,
  resolveInstalledProductPackage,
  resolveInstalledProductRoot,
  resolveSourceCheckout,
  sourceCommitId,
  sourceWorkingTreeClean,
  traceAgainstCommit,
  commitsTouchingFile,
};
