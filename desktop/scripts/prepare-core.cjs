'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { verifyProductRuntime } = require('../../_site/scripts/verify-product-runtime');
const { safeRelative } = require('../../_site/scripts/pack-module-candidates');
const desktopRoot = path.resolve(__dirname, '..');
const projectRoot = path.resolve(desktopRoot, '..');
function installPreparedCore(stage, target, backup, root) {
  const modules = path.join(root, 'node_modules');
  if (path.resolve(target) !== path.join(modules, 'project-knowledge') || path.dirname(stage) !== modules || !path.basename(stage).startsWith('.pk-core-stage-') || !path.resolve(backup).startsWith(path.join(root, '.core-package') + path.sep)) throw new Error('Unsafe prepared core target');
  if (fs.realpathSync(modules) !== modules || fs.lstatSync(stage).isSymbolicLink()) throw new Error('Prepared core parent must not be redirected');
  let moved = false;
  if (fs.existsSync(target) || (() => { try { fs.lstatSync(target); return true; } catch { return false; } })()) { fs.renameSync(target, backup); moved = true; }
  try { fs.renameSync(stage, target); }
  catch (error) { if (moved) fs.renameSync(backup, target); throw error; }
}
function main() {
  const version = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'))).version;
  const desktop = JSON.parse(fs.readFileSync(path.join(desktopRoot, 'package.json')));
  if (desktop.version !== version) throw new Error('Desktop and core versions must match');
  // An old published module with the same version must not slip into the installer.
  verifyProductRuntime(projectRoot, path.join(desktopRoot, 'package.json'));
  const cacheRoot = path.join(desktopRoot, '.core-package'); fs.mkdirSync(cacheRoot, { recursive: true });
  if (fs.realpathSync(cacheRoot) !== cacheRoot) throw new Error('Unsafe package cache');
  const cache = fs.mkdtempSync(path.join(cacheRoot, 'candidate-'));
  const npmCli = process.env.npm_execpath || path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
  const packed = spawnSync(process.execPath, [npmCli, 'pack', projectRoot, '--ignore-scripts', '--json', '--pack-destination', cache], { cwd: desktopRoot, encoding: 'utf8', windowsHide: true });
  if (packed.status !== 0) throw new Error('Core npm pack failed; current runtime is unchanged');
  const info = JSON.parse(packed.stdout)[0];
  if (!safeRelative(info.filename) || info.files.some(file => !safeRelative(file.path))) throw new Error('Unsafe package contents');
  const modules = path.join(desktopRoot, 'node_modules'); fs.mkdirSync(modules, { recursive: true });
  if (fs.realpathSync(modules) !== modules) throw new Error('Redirected desktop node_modules');
  const stage = fs.mkdtempSync(path.join(modules, '.pk-core-stage-'));
  const tarball = path.join(cache, info.filename);
  const listing = spawnSync('tar', ['-tzf', tarball], { encoding: 'utf8', windowsHide: true });
  if (listing.status !== 0 || listing.stdout.trim().split(/\r?\n/).some(entry => !entry.startsWith('package/') || !safeRelative(entry.slice(8).replace(/\/$/, '')))) throw new Error('Unsafe tarball entries');
  const extracted = spawnSync('tar', ['-xzf', tarball, '-C', stage, '--strip-components=1'], { encoding: 'utf8', windowsHide: true });
  if (extracted.status !== 0) throw new Error('Core extraction failed; current runtime is unchanged');
  const verified = spawnSync(process.execPath, [path.join(stage, '_site/scripts/verify-module-runtime.js'), '--working-tree'], { encoding: 'utf8', windowsHide: true });
  if (verified.status !== 0) throw new Error('Prepared engine content failed verification');
  verifyProductRuntime(stage, path.join(desktopRoot, 'package.json'));
  const target = path.join(modules, 'project-knowledge');
  const backup = path.join(cache, 'previous-core');
  installPreparedCore(stage, target, backup, desktopRoot);
  fs.writeFileSync(path.join(cache, 'preparation.json'), JSON.stringify({ version, target, backup: fs.existsSync(backup) ? backup : null, preparedAt: new Date().toISOString() }, null, 2));
  console.log(`Prepared project-knowledge ${version}; prior runtime preserved at ${backup}.`);
}
if (require.main === module) { try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; } }
module.exports = { installPreparedCore };
