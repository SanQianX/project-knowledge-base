'use strict';
// P-DESKTOP-CANDIDATE-HARDEN-R2 core-tarball comparison helper.
//
// For the 5.0.25 candidate: core 5.0.25 is built locally (Leader provides a
// clean tracked export + the core tarball) but NOT yet on the registry, so
// the build consumes the tarball and verification must prove the packaged
// runtime really IS that tarball — every file byte-identical, not just a
// matching version string in package.json.
//
// Extraction uses the Windows-bundled bsdtar (System32\tar.exe). The final
// official installer is still rebuilt from the registry-published core and
// re-verified against the registry artifact bytes; this helper only covers
// the pre-publish candidate.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const asarLib = require('./release-preflight-5025-asar.cjs');

const CORE_ASAR_PREFIX = 'node_modules/@sanqianx/project-knowledge/';

// Resolve tar.exe explicitly: a bare "tar" in PATH may be MSYS/GNU tar, which
// misreads "D:\..." arguments as host:path remotes. Windows ships bsdtar in
// System32 (10 1803+), which handles drive-colon paths and .tgz natively.
function bsdtar() {
  const root = process.env.SystemRoot || process.env.SYSTEMROOT || 'C:\\Windows';
  const exe = path.join(root, 'System32', 'tar.exe');
  if (!fs.existsSync(exe)) {
    throw new Error(`Windows bsdtar not found at ${exe}; tarball comparison needs it`);
  }
  return exe;
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// Extract <tgz> into destDir (contents land under destDir/package/).
// Returns { ok, status, stderr }.
function extractTarball(tgz, destDir, env) {
  fs.mkdirSync(destDir, { recursive: true });
  const r = spawnSync(bsdtar(), ['-xf', path.resolve(tgz), '-C', destDir], {
    env,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 300000,
  });
  return { ok: r.status === 0, status: r.status, stderr: (r.stderr || '').slice(-2000) };
}

// Walk the extracted package and list files relative to the package root.
// Symlinks are rejected explicitly: silent comparison of a link would prove
// nothing about bytes. Returns { files: [{ rel, abs }], failures }.
function listPackageFiles(extractDir) {
  const pkgRoot = path.join(extractDir, 'package');
  const files = [];
  const failures = [];
  if (!fs.existsSync(pkgRoot)) {
    return { files, failures: [`tarball has no package/ root under ${extractDir}`] };
  }
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        failures.push(`symlink inside core tarball not supported for byte comparison: ${path.relative(pkgRoot, abs)}`);
      } else if (entry.isDirectory()) {
        walk(abs);
      } else if (entry.isFile()) {
        files.push({ rel: path.relative(pkgRoot, abs).split(path.sep).join('/'), abs });
      }
    }
  };
  walk(pkgRoot);
  return { files, failures };
}

// Compare every file of the extracted core tarball against the packaged core
// inside app.asar. Fails on: missing asar counterpart, byte mismatch, any
// packaged file under the core prefix that the tarball does not contain
// (strict set equality — a core directory containing extra bytes is not the
// audited tarball). Returns { version, checked, failures }.
function compareCoreWithAsar({ asarPath, extractDir, corePrefix = CORE_ASAR_PREFIX }) {
  const failures = [];
  const { files, failures: walkFailures } = listPackageFiles(extractDir);
  failures.push(...walkFailures);
  const asar = asarLib.readHeader(asarPath);
  const asarAll = asarLib.listAll(asar);
  const corePkgRel = files.find((f) => f.rel === 'package.json');
  let version = null;
  if (corePkgRel) {
    version = JSON.parse(fs.readFileSync(corePkgRel.abs, 'utf8')).version;
  } else {
    failures.push('core tarball has no package.json');
  }
  const tarballRels = new Set(files.map((f) => f.rel));
  for (const { rel } of files) {
    const asarRel = corePrefix + rel;
    if (!asarAll.includes(asarRel)) {
      failures.push(`tarball file missing from asar: ${rel}`);
      continue;
    }
    const asarBytes = asarLib.extractFile(asarPath, asar, asarRel);
    if (sha256(asarBytes) !== sha256(fs.readFileSync(path.join(extractDir, 'package', rel)))) {
      failures.push(`byte mismatch: ${rel}`);
    }
  }
  for (const entry of asarAll) {
    if (!entry.startsWith(corePrefix)) continue;
    const rel = entry.slice(corePrefix.length);
    if (!tarballRels.has(rel)) failures.push(`packaged core file not present in the tarball: ${rel}`);
  }
  return { version, checked: files.length, failures };
}

// Extract + compare in one step for the tools. env is the hardened child env.
function verifyCoreTarball({ tgz, extractDir, asarPath, env, corePrefix }) {
  const extracted = extractTarball(tgz, extractDir, env);
  if (!extracted.ok) {
    return { version: null, checked: 0, failures: [`tar extraction failed (exit ${extracted.status}): ${extracted.stderr}`] };
  }
  return compareCoreWithAsar({ asarPath, extractDir, corePrefix });
}

module.exports = { CORE_ASAR_PREFIX, bsdtar, extractTarball, listPackageFiles, compareCoreWithAsar, verifyCoreTarball };
