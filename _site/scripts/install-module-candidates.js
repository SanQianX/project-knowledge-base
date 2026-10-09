'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const { spawnSync } = require('node:child_process');
const AtomicFile = require('../lib/atomic-file');
const { verifyInstalled, safeRelative } = require('./pack-module-candidates');
const root = path.resolve(__dirname, '../..');
const npmCli = process.env.npm_execpath || path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
function run(args, cwd) {
  const result = spawnSync(process.execPath, [npmCli, ...args], { cwd, windowsHide: true, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`npm ${args[0]} failed (${result.status})`);
  return result.stdout;
}
function contentAddressedArtifact(packedCore) {
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(packedCore)).digest('hex');
  const file = packedCore.replace(/\.tgz$/, `-${sha256}.tgz`);
  if (file === packedCore) throw new Error('Candidate must be a tarball');
  fs.copyFileSync(packedCore, file);
  return { file, sha256 };
}
function main() {
  const manifestFile = path.resolve(process.argv[2]);
  const manifest = JSON.parse(fs.readFileSync(manifestFile));
  if (manifest.schema !== 'project-knowledge/module-candidates/v1') throw new Error('Invalid candidate manifest');
  const artifactRoot = path.dirname(manifestFile);
  const dependencies = {};
  for (const module of Object.values(manifest.modules)) {
    if (!safeRelative(module.tarball) || !module.tarball.endsWith('.tgz')) throw new Error('Unsafe artifact path');
    const file = path.join(artifactRoot, module.tarball);
    if (fs.lstatSync(file).isSymbolicLink() || crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') !== module.sha256) throw new Error('Module artifact drift');
    dependencies[module.installName] = `file:${file}`;
  }
  const candidate = JSON.parse(run(['pack', '--ignore-scripts', '--json', '--pack-destination', artifactRoot], root))[0];
  const packedCore = path.join(artifactRoot, candidate.filename);
  // Same-version local tarballs are cached by npm. Address each candidate by
  // content so an update cannot silently keep an older runtime or UI.
  const { sha256: shellSha256, file: shellArtifact } = contentAddressedArtifact(packedCore);
  dependencies['@sanqianx/project-knowledge'] = `file:${shellArtifact}`;
  const updateAt = process.argv.indexOf('--update');
  const installedRoot = updateAt < 0 ? fs.mkdtempSync(path.join(os.tmpdir(), 'kb-installed-product-')) : path.resolve(process.argv[updateAt + 1]);
  if (path.dirname(installedRoot) !== path.resolve(os.tmpdir()) || !path.basename(installedRoot).startsWith('kb-installed-product-') || fs.lstatSync(installedRoot).isSymbolicLink()) throw new Error('Only this task’s isolated installation can be updated');
  if (updateAt >= 0 && JSON.parse(fs.readFileSync(path.join(installedRoot, 'installation-acceptance.json'))).installedRoot !== installedRoot) throw new Error('Installed fixture identity mismatch');
  AtomicFile.writeJsonAtomic(path.join(installedRoot, 'package.json'), { name: 'kb-local-acceptance', version: '0.0.0', private: true, dependencies });
  process.stdout.write(`Installing isolated product at ${installedRoot}\n`);
  run(['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], installedRoot);
  verifyInstalled(manifest, installedRoot);
  const core = path.join(installedRoot, 'node_modules/@sanqianx/project-knowledge');
  const resolver = createRequire(path.join(core, 'package.json'));
  for (const module of Object.values(manifest.modules)) {
    const actual = resolver.resolve(`${module.installName}/package.json`);
    if (actual !== path.join(installedRoot, 'node_modules', module.installName, 'package.json')) throw new Error(`A nested stale module shadows the tested candidate: ${module.installName}`);
  }
  const verify = spawnSync(process.execPath, [path.join(core, '_site/scripts/verify-module-runtime.js'), '--working-tree'], { cwd: installedRoot, windowsHide: true, encoding: 'utf8' });
  if (verify.status !== 0) throw new Error('Packaged engine integrity failed');
  require('./verify-product-runtime').verifyProductRuntime(core);
  for (const relative of ['vendor-manifest.json', 'module-runtime-manifest.json']) {
    if (!fs.readFileSync(path.join(core, relative)).equals(fs.readFileSync(path.join(root, relative)))) throw new Error(`Installed candidate is stale: ${relative}`);
  }
  const report = { schema: 'project-knowledge/installed-candidates/v1', mode: 'local npm candidate installation, not remote release', installedRoot, core, artifactManifest: manifestFile, shellVersion: candidate.version, shellSha256, shellArtifact, modules: Object.fromEntries(Object.entries(manifest.modules).map(([key, module]) => [key, { version: module.version, sha256: module.sha256 }])), integrityPassed: true, testedAt: new Date().toISOString() };
  AtomicFile.writeJsonAtomic(path.join(installedRoot, 'installation-acceptance.json'), report);
  process.stdout.write(`INSTALLED_PRODUCT ${path.join(installedRoot, 'installation-acceptance.json')}\n`);
}
if (require.main === module) {
  try { main(); } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
module.exports = { contentAddressedArtifact };
