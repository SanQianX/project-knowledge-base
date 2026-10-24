'use strict';
// P-RELEASE-PREFLIGHT-5025 build entry for the Windows desktop installer,
// hardened in P-DESKTOP-CANDIDATE-HARDEN-R2.
//
// Why this wrapper exists: `electron-forge make` requires the electron
// version to be discoverable in devDependencies
// (@electron-forge/core-utils getElectronModuleName throws otherwise), but
// the published thin-shell manifest intentionally keeps electron in
// dependencies — the tgz distribution path installs the runtime from there,
// and desktop/test/thin-package-test.cjs asserts that exact trio. Instead of
// mutating the published manifest, this wrapper stages a build-only copy:
//
//   desktop/out/.release-preflight-5025-stage/app/
//     package.json        copy with electron moved to devDependencies
//     forge.config.cjs    staged copy with build-only corrections
//     main.cjs/preload.cjs/bin/lib/assets   unchanged copies
//     node_modules        junction -> desktop/node_modules, or in candidate
//                         mode -> the isolated candidate prefix
//
// electron-packager copies the staged tree (following the junction) into its
// own out/ directory and prunes devDependencies THERE, so the real
// desktop/node_modules is never modified. Squirrel make outputs are copied
// back to desktop/out/make/ so the release workflow's asset paths are
// unchanged from the direct `npm run make` era.
//
// R2 hardening: before anything runs, this process's own environment is
// rebuilt through release-preflight-5025-env.cjs (allow-list inheritance —
// ambient provider keys never reach forge/packager/npm children — with
// TEMP/HOME/USERPROFILE/APPDATA/LOCALAPPDATA/PS module cache and npm/electron
// caches redirected outside the repo under the OS temp dir).
//
// R3 candidate mode (--desktop-source <export> --core-tarball <tgz>
// --wb-tarball <tgz> --bridge-tarball <tgz>): builds the REAL 5.0.25
// candidate while core 5.0.25, Workbench 0.13.7 AND Bridge 0.7.3 are all
// still unpublished (the WB/Bridge npm publishes were rejected by
// OIDC/token permissions — an auth failure, not a product failure). All
// three tarballs are mandatory together: core declares the unpublished
// module versions, so a missing local tarball could only be satisfied by an
// OLD registry module, which this tool refuses (resolveCandidates also
// cross-checks core's declared deps against the provided tarball versions
// and rejects anything equal to the last published stable set).
//   - an isolated candidate prefix is installed from a scratch copy of the
//     export manifest whose three module specs are RELATIVE
//     `file:./{core,wb,bridge}.candidate.tgz` (registry resolution of the
//     unpublished versions is never attempted; a post-install scan proves
//     each module exists EXACTLY ONCE in the prefix at the candidate version
//     — no nested old copy);
//   - the staged build manifest likewise uses bare relative `file:` specs so
//     packager's `npm prune` re-resolution consumes the same local tarballs —
//     and an afterPrune hook removes all three from the packaged copy so they
//     never ship;
//   - the export's files are never modified; no absolute machine path enters
//     any manifest (specs are bare relative filenames); no local registry is
//     involved at any point; these builds are LOCAL pre-publish candidates,
//     clearly labeled, NOT official npm acceptance.
// The final official installer is still built from registry-published
// artifacts after the publish receipts and re-verified byte-for-byte against
// the registry artifacts; package-audit/packaged-verify --core-tarball
// --wb-tarball --bridge-tarball prove the candidate runtime is byte-identical
// to the provided tarballs (plus quota-17, Bridge fix markers, engine vendor
// and UI tooltip proofs — see release-preflight-5025-local-modules.cjs).

const fs = require('node:fs');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const envLib = require('./release-preflight-5025-env.cjs');
const asarLib = require('./release-preflight-5025-asar.cjs');
const localModules = require('./release-preflight-5025-local-modules.cjs');

const desktopRoot = path.resolve(__dirname, '..');
const outRoot = path.join(desktopRoot, 'out');
const stageRoot = path.join(outRoot, '.release-preflight-5025-stage');
const stageApp = path.join(stageRoot, 'app');
// R3: the build driver's writable roots (TEMP, npm/electron caches) live
// under the OS temp dir, OUTSIDE the repo.
const buildEnvRoot = path.join(os.tmpdir(), 'release-preflight-5025-make-env');
const CORE_NAME = '@sanqianx/project-knowledge';
const COPY_ENTRIES = ['main.cjs', 'preload.cjs', 'bin', 'lib', 'assets'];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// Windows has no npm.exe; spawn the CLI JS with the running Node.
function npmRun(args, options = {}) {
  const here = path.dirname(process.execPath);
  for (const cli of [path.join(here, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(here, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')]) {
    if (fs.existsSync(cli)) return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', windowsHide: true, timeout: 900000, maxBuffer: 32 * 1024 * 1024, ...options });
  }
  return spawnSync('npm', args, { encoding: 'utf8', windowsHide: true, timeout: 900000, maxBuffer: 32 * 1024 * 1024, ...options });
}

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 60000 });
  assert(r.status === 0, `git ${args.join(' ')} failed in ${cwd}: ${(r.stderr || '').slice(-500)}`);
  return (r.stdout || '').trim();
}

// R4 containment: every recursive delete/copy target must resolve inside the
// OWNED desktop/out tree. Evidence (qa-autopilot/**), external inputs (the
// Leader export, the owned dependency cache) and every real install live
// outside this root, so they can never be named as a removal/copy target.
function assertInsideOwnedTree(target, label) {
  const resolved = path.resolve(target);
  const rel = path.relative(outRoot, resolved);
  assert(rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel),
    `${label} must stay inside the owned desktop/out tree, got: ${target}`);
  return resolved;
}

// Recursive removal that can never traverse a reparse point: junctions and
// symlinks are unlinked where they stand (lstat per entry — readdir Dirent
// types under-report junctions on Windows), and only then is the real tree
// removed. The top target itself must be a real directory inside desktop/out.
function safeRmRecursive(target, label) {
  const resolved = assertInsideOwnedTree(target, label);
  if (!fs.existsSync(resolved)) return;
  const top = fs.lstatSync(resolved);
  if (top.isSymbolicLink()) {
    fs.unlinkSync(resolved);
    return;
  }
  const stripLinks = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const child = path.join(dir, name);
      const st = fs.lstatSync(child);
      if (st.isSymbolicLink()) fs.unlinkSync(child);
      else if (st.isDirectory()) stripLinks(child);
    }
  };
  if (top.isDirectory()) stripLinks(resolved);
  fs.rmSync(resolved, { recursive: true, force: true });
}

// R4: refuse a full build when free disk cannot hold prefix install + bundle
// + squirrel output with headroom — a half-full disk mid-build is how old
// evidence gets "cleaned up" by mistake. Nothing is deleted on refusal.
function assertFreeDisk(mountDir, minBytes, label) {
  const st = fs.statfsSync(mountDir);
  const free = st.bsize * st.bavail;
  assert(free >= minBytes,
    `free disk on ${mountDir} is ${(free / 2 ** 30).toFixed(1)} GiB, below the ${label} requirement of ${(minBytes / 2 ** 30).toFixed(1)} GiB — refusing to build`);
  console.log(`free disk ${label}: ${(free / 2 ** 30).toFixed(1)} GiB on ${mountDir}`);
}

const MIN_BUILD_FREE_BYTES = 6 * 2 ** 30;   // prefix install + bundle + squirrel + headroom
const MIN_TMP_FREE_BYTES = 2 * 2 ** 30;     // isolated npm/electron caches under os.tmpdir

// Install the candidate prefix: a scratch manifest (the three module specs
// rewritten to the local tarballs) + scratch lockfile; nothing outside
// stageRoot changes. Runs under the hardened env (no credential pass-through;
// npm cache isolated outside the repo; official registry only for deps that
// ARE published).
function installCandidatePrefix(sourceDesktop, mods) {
  const prefix = path.join(stageRoot, 'candidate-prefix');
  safeRmRecursive(prefix, 'candidate prefix reset');
  fs.mkdirSync(prefix, { recursive: true });
  const exportPkgPath = path.join(sourceDesktop, 'package.json');
  const scratchPkg = JSON.parse(fs.readFileSync(exportPkgPath, 'utf8'));
  scratchPkg.dependencies = {
    ...scratchPkg.dependencies,
    ...localModules.scratchDependencyOverrides(mods),
  };
  fs.writeFileSync(path.join(prefix, 'package.json'), `${JSON.stringify(scratchPkg, null, 2)}\n`);
  const exportLock = path.join(sourceDesktop, 'package-lock.json');
  if (fs.existsSync(exportLock)) fs.copyFileSync(exportLock, path.join(prefix, 'package-lock.json'));
  for (const mod of mods) fs.copyFileSync(mod.tgz, path.join(prefix, mod.candidateFile));

  const install = npmRun(['install', '--prefix', prefix, '--omit=dev', '--no-audit', '--no-fund'], { cwd: prefix });
  assert(install.status === 0,
    `candidate prefix install failed (exit ${install.status}):\n${(install.stderr || install.stdout || '').slice(-3000)}`);
  assertInstalledCandidates(prefix, mods);
  assert(fs.existsSync(path.join(prefix, 'node_modules', 'electron', 'package.json')),
    'candidate prefix is missing electron (it must stay a production dependency of the export)');
  return prefix;
}

// Each candidate module must be installed EXACTLY ONCE in the prefix, at the
// top of node_modules, at the candidate version. A nested copy (e.g. an old
// registry version under core/node_modules) means npm resolved a dep edge to
// an old module masquerading as the new feature — fail the build.
function assertInstalledCandidates(prefix, mods) {
  const top = path.join(prefix, 'node_modules');
  const nmDirs = [top];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === '.bin') continue;
      const child = path.join(dir, entry.name);
      if (entry.name === 'node_modules') nmDirs.push(child);
      walk(child);
    }
  };
  walk(top);
  for (const mod of mods) {
    const found = nmDirs
      .map((dir) => path.join(dir, mod.manifestKey))
      .filter((p) => fs.existsSync(p));
    const expectedAt = path.join(top, mod.manifestKey);
    if (found.length !== 1 || found[0] !== expectedAt) {
      throw new Error(`candidate module ${mod.id} (${mod.pkgName}@${mod.version}) must appear exactly once at node_modules/${mod.manifestKey}; found: ${found.map((p) => path.relative(prefix, p)).join(', ') || 'none'}`);
    }
    const installed = JSON.parse(fs.readFileSync(path.join(expectedAt, 'package.json'), 'utf8'));
    assert(installed.name === mod.pkgName && installed.version === mod.version,
      `candidate prefix installed ${mod.manifestKey} ${installed.name}@${installed.version}, expected ${mod.pkgName}@${mod.version}`);
  }
}

function prepareStage(sourceDesktop, mods) {
  const pkg = require(path.join(sourceDesktop, 'package.json'));
  assert(pkg.name === '@sanqianx/project-knowledge-desktop', 'unexpected desktop manifest');
  assert(pkg.dependencies && pkg.dependencies.electron, 'desktop manifest has no electron dependency');
  assert(pkg.dependencies[CORE_NAME] === pkg.version,
    'desktop must pin its matching core release before building');
  assert(/^\d+\.\d+\.\d+$/.test(pkg.dependencies.electron), 'electron pin must be an exact version');

  const candidate = mods.length > 0;
  safeRmRecursive(stageRoot, 'stage reset');
  fs.mkdirSync(stageRoot, { recursive: true });
  let modulesRoot = path.join(desktopRoot, 'node_modules');
  if (candidate) {
    const core = mods.find((m) => m.id === 'core');
    assert(core.version === pkg.dependencies[CORE_NAME],
      `core tarball ${core.version} != export pin ${pkg.dependencies[CORE_NAME]}`);
    const isGit = fs.existsSync(path.join(sourceDesktop, '.git')) || fs.existsSync(path.join(sourceDesktop, '..', '.git'));
    let exportHead = null;
    if (isGit) {
      exportHead = git(sourceDesktop, ['rev-parse', 'HEAD']);
      const porcelain = git(sourceDesktop, ['status', '--porcelain']);
      assert(porcelain === '', `--desktop-source must be a clean tracked export (git status not empty)`);
      console.log(`candidate source: ${sourceDesktop} @ ${exportHead.slice(0, 12)} (clean tracked export)`);
    } else {
      console.log(`candidate source: ${sourceDesktop} (NOT a git checkout — cleanliness could not be verified, proceeding with file bytes only)`);
    }
    modulesRoot = path.join(installCandidatePrefix(sourceDesktop, mods), 'node_modules');
    console.log(`candidate tarballs (LOCAL pre-publish source, NOT official npm acceptance): ${mods.map((m) => `${m.name}@${m.version} (${m.tgz})`).join(' ; ')}`);
  }

  fs.mkdirSync(stageApp, { recursive: true });
  for (const entry of COPY_ENTRIES) {
    fs.cpSync(path.join(sourceDesktop, entry), path.join(stageApp, entry), { recursive: true });
  }

  // Build-only manifest: identical to the published thin shell except for the
  // build-stage corrections:
  //   1. electron is announced in devDependencies, where forge looks for it.
  //   2. apache-arrow is pinned explicitly at the version the desktop
  //      package-lock already installs (it is only a peerDependency of
  //      @lancedb/lancedb, so packager's `npm prune` re-resolution — which
  //      does not auto-install peers — drops it otherwise, and the packaged
  //      core then fails `require('@lancedb/lancedb')` with
  //      "Cannot find module 'apache-arrow'").
  //   3. candidate mode only: the core dependency is the RELATIVE
  //      `file:core.candidate.tgz` spec (tarball copied beside the manifest)
  //      so prune resolves it from disk and never tries the registry for the
  //      unpublished 5.0.25. The afterPrune hook below removes the tarball
  //      from the packaged copy, so it never ships.
  const staged = JSON.parse(JSON.stringify(pkg));
  const electronVersion = staged.dependencies.electron;
  delete staged.dependencies.electron;
  staged.devDependencies = { ...(staged.devDependencies || {}), electron: electronVersion };
  const arrowPkg = require(path.join(modulesRoot, 'apache-arrow', 'package.json'));
  const lancedbPkg = require(path.join(modulesRoot, '@lancedb', 'lancedb', 'package.json'));
  const arrowRange = lancedbPkg.peerDependencies && lancedbPkg.peerDependencies['apache-arrow'];
  assert(arrowRange, 'installed @lancedb/lancedb no longer declares the apache-arrow peer');
  const satisfiesArrowRange = (() => {
    // lancedb pins a plain `>=X <=Y` range; parse it rather than pulling semver in.
    const bounds = arrowRange.match(/^>=(\d+\.\d+\.\d+) <=(\d+\.\d+\.\d+)$/);
    if (!bounds) return false;
    const toTuple = (v) => v.split('.').map(Number);
    const cmp = (a, b) => {
      const ta = toTuple(a);
      const tb = toTuple(b);
      return (ta[0] - tb[0]) || (ta[1] - tb[1]) || (ta[2] - tb[2]);
    };
    return cmp(arrowPkg.version, bounds[1]) >= 0 && cmp(arrowPkg.version, bounds[2]) <= 0;
  })();
  assert(satisfiesArrowRange, `installed apache-arrow ${arrowPkg.version} outside lancedb peer range ${arrowRange}`);
  staged.dependencies['apache-arrow'] = arrowPkg.version;
  if (candidate) {
    Object.assign(staged.dependencies, localModules.stagedDependencyOverrides(mods));
    for (const mod of mods) fs.copyFileSync(mod.tgz, path.join(stageApp, mod.candidateFile));
  }
  fs.writeFileSync(path.join(stageApp, 'package.json'), `${JSON.stringify(staged, null, 2)}\n`);

  // Staged forge config: re-export the real forge.config.cjs with build-stage-
  // only packagerConfig corrections:
  //   derefSymlinks: true — the stage announces node_modules as a junction;
  //     without this @electron/packager's copy step tries to recreate the
  //     link inside its temp dir, which is EPERM on non-privileged Windows.
  //   asar.unpack — the real forge.config.cjs pattern `**/*.{node,dll,ps1}`
  //     matches nothing on Windows: @electron/asar 3.4.1 globs against
  //     absolute backslash paths, where a `/`-separated `**/` never matches,
  //     so every native addon ends up INSIDE app.asar with no .unpacked
  //     counterpart. Electron 43.1.1 cannot dlopen those (its temp-file
  //     extraction yields "not a valid Win32 application" even though asar
  //     reads are byte-identical), so the packaged backend dies on
  //     require('@lancedb/lancedb'). `**.{node,dll,ps1}` is the empirically
  //     verified Windows form that unpacks root and nested natives.
  //   afterPrune (candidate only) — remove core.candidate.tgz from the
  //     PACKAGED copy after prune consumed it, so the tarball never ships.
  //   electronZipDir — only when KB_DESKTOP_ELECTRON_ZIP_DIR is set (offline
  //     builds where @electron/get hosts are unreachable): take the electron
  //     zip from that directory and skip all downloads.
  const zipDir = process.env.KB_DESKTOP_ELECTRON_ZIP_DIR;
  const stagedForgeConfig = `'use strict';
const base = require(${JSON.stringify(path.join(sourceDesktop, 'forge.config.cjs'))});
module.exports = {
  ...base,
  packagerConfig: {
    ...base.packagerConfig,
    derefSymlinks: true,
    asar: {
      ...(base.packagerConfig.asar || {}),
      unpack: '**.{node,dll,ps1}',
    },${candidate ? `
    afterPrune: [function (buildPath, electronVersion, platform, arch, done) {
      // R4: MUST be callback-style (done(err)). Forge's sequentialHooks and
      // packager's promisifyHooks both consume these hooks through
      // util.promisify; an async hook returns a promise the promisified
      // wrapper waits on forever (DEP0174) — api.make then hangs with an
      // EMPTY event loop and node exits 0 silently without building.
      // R5: the hook now also RESTORES the export's original package.json and
      // forge.config.cjs in the packaged copy and removes any scratch lock.
      try {
        require(${JSON.stringify(__filename)}).restorePackagedAppFiles(
          buildPath, ${JSON.stringify(sourceDesktop)},
          ${JSON.stringify(mods.map((m) => m.candidateFile))});
        done();
      } catch (err) { done(err); }
    }],` : ''}
    ...(process.env.KB_DESKTOP_ELECTRON_ZIP_DIR
      ? { electronZipDir: process.env.KB_DESKTOP_ELECTRON_ZIP_DIR }
      : {}),
  },
};
`;
  fs.writeFileSync(path.join(stageApp, 'forge.config.cjs'), stagedForgeConfig);
  if (zipDir) {
    assert(fs.existsSync(path.join(zipDir, `electron-v${electronVersion}-win32-x64.zip`)),
      `KB_DESKTOP_ELECTRON_ZIP_DIR does not contain electron-v${electronVersion}-win32-x64.zip`);
  }

  fs.symlinkSync(modulesRoot, path.join(stageApp, 'node_modules'), 'junction');

  assert(fs.existsSync(path.join(modulesRoot, 'electron', 'package.json')),
    `modules tree is not installed at ${modulesRoot} (candidate mode installs it automatically; otherwise run npm ci --prefix desktop first)`);
  return { pkg, candidate };
}

async function runForgeMake() {
  const { api } = require('@electron-forge/core/dist/api');
  await api.make({ dir: stageApp, interactive: false, arch: 'x64' });
}

function copyMakeOutputs(version) {
  const stageMake = path.join(stageApp, 'out', 'make');
  const targetMake = path.join(outRoot, 'make');
  assertInsideOwnedTree(targetMake, 'make output copy-back target');
  assert(fs.existsSync(stageMake), `forge produced no make output at ${stageMake}`);
  fs.cpSync(stageMake, targetMake, { recursive: true });
  const squirrelDir = path.join(targetMake, 'squirrel.windows', 'x64');
  const installer = path.join(squirrelDir, `Project-Knowledge-${version}-Setup.exe`);
  assert(fs.existsSync(installer), `installer missing after copy-back: ${installer}`);
  for (const required of [`project_knowledge-${version}-full.nupkg`, 'RELEASES']) {
    assert(fs.existsSync(path.join(squirrelDir, required)), `squirrel metadata missing: ${required}`);
  }
  return installer;
}

function assertCandidateBundleClean(bundleDir, mods, sourceDesktop) {
  const asarPath = path.join(bundleDir, 'resources', 'app.asar');
  const asar = asarLib.readHeader(asarPath);
  const all = asarLib.listAll(asar);
  for (const mod of mods) {
    assert(!all.includes(mod.candidateFile),
      `packaged app.asar still contains ${mod.candidateFile} (afterPrune removal failed)`);
    const packaged = JSON.parse(asarLib.extractFile(asarPath, asar,
      `node_modules/${mod.manifestKey}/package.json`).toString('utf8'));
    assert(packaged.name === mod.pkgName && packaged.version === mod.version,
      `packaged ${mod.id} ${packaged.name}@${packaged.version} != candidate ${mod.pkgName}@${mod.version}`);
  }
  // R5 manifest-restore audit: the packaged manifest and forge config must be
  // the export's ORIGINAL bytes — no build-only file:*.candidate.tgz specs,
  // no build-only dev edges, no absolute build paths, no scratch lock.
  assertPackagedAppFilesClean({
    manifestBytes: asarLib.extractFile(asarPath, asar, 'package.json'),
    configBytes: asarLib.extractFile(asarPath, asar, 'forge.config.cjs'),
    originalManifestBytes: fs.readFileSync(path.join(sourceDesktop, 'package.json')),
    originalConfigBytes: fs.readFileSync(path.join(sourceDesktop, 'forge.config.cjs')),
    asarFiles: all,
    candidateFiles: mods.map((m) => m.candidateFile),
  });
}

// R5 (Leader finding, merged from the queued parallel-desktop-manifest-restore
// task): after prune consumed the build-only manifest, the PACKAGED copy must
// carry the export's original bytes again — the exact registry module specs
// (the build-only file:*.candidate.tgz edges and the apache-arrow/devDeps
// corrections belong to the build stage only) and the product's own
// forge.config.cjs (the staged one embeds absolute build-machine paths). Any
// package-lock.json the prune wrote must not ship either.
function restorePackagedAppFiles(buildPath, sourceDesktop, candidateFiles) {
  const fs = require('node:fs');
  const path = require('node:path');
  for (const name of ['package.json', 'forge.config.cjs']) {
    fs.copyFileSync(path.join(sourceDesktop, name), path.join(buildPath, name));
  }
  for (const name of ['package-lock.json', ...candidateFiles]) {
    fs.rmSync(path.join(buildPath, name), { force: true });
  }
}

function assertPackagedAppFilesClean({ manifestBytes, configBytes, originalManifestBytes, originalConfigBytes, asarFiles, candidateFiles }) {
  const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
  assert(sha(manifestBytes) === sha(originalManifestBytes),
    'packaged package.json differs from the export manifest (build-only file:*.candidate.tgz specs / dev edges must be restored after prune)');
  assert(sha(configBytes) === sha(originalConfigBytes),
    'packaged forge.config.cjs differs from the export config (the staged build config must never ship)');
  for (const name of ['package-lock.json', ...candidateFiles]) {
    assert(!asarFiles.includes(name), `packaged app must not ship ${name}`);
  }
  assert(!/file:\S*\.candidate\.tgz/.test(manifestBytes.toString('utf8')),
    'packaged manifest still contains a file:*.candidate.tgz spec');
}

async function main() {
  const args = process.argv.slice(2);
  const flagValue = (flag) => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const sourceFlag = flagValue('--desktop-source');
  const coreTarball = flagValue('--core-tarball');
  const wbTarball = flagValue('--wb-tarball');
  const bridgeTarball = flagValue('--bridge-tarball');
  const anyTarball = Boolean(coreTarball || wbTarball || bridgeTarball);
  assert(!sourceFlag || anyTarball,
    '--desktop-source is the candidate interface and requires --core-tarball, --wb-tarball and --bridge-tarball (all three: none of core 5.0.25 / WB 0.13.7 / Bridge 0.7.3 is on the registry yet)');
  assert(!anyTarball || sourceFlag,
    'candidate tarballs require --desktop-source <clean tracked export> whose pins match the candidate versions');
  const sourceDesktop = sourceFlag ? path.resolve(sourceFlag) : desktopRoot;

  // R2: rebuild this process's env before forge/packager/npm children spawn.
  // KB_DESKTOP_ELECTRON_ZIP_DIR survives via the tool-control allow-list.
  envLib.hardenProcessEnv(buildEnvRoot);
  // R4: free-disk gates before any build work — the out drive must hold the
  // full candidate build, the temp drive the isolated caches.
  assertFreeDisk(outRoot, MIN_BUILD_FREE_BYTES, 'full build');
  assertFreeDisk(os.tmpdir(), MIN_TMP_FREE_BYTES, 'isolated caches');
  // R3: resolve + cross-validate the local module tarballs (name/version,
  // core's declared deps vs the provided WB/Bridge versions, nothing equal to
  // the last published stable set, all three present together).
  const { mods } = anyTarball
    ? localModules.resolveCandidates({ coreTarball, wbTarball, bridgeTarball })
    : { mods: [] };
  const { pkg } = prepareStage(sourceDesktop, mods);
  await runForgeMake();
  const installer = copyMakeOutputs(pkg.version);
  const bundle = path.join(stageApp, 'out', 'Project Knowledge-win32-x64');
  if (mods.length) assertCandidateBundleClean(bundle, mods, sourceDesktop);
  console.log(`release-preflight-5025 make PASS`);
  console.log(`installer: ${installer}`);
  console.log(`bundle: ${bundle}`);
  if (mods.length) {
    console.log(`candidate notes: staged specs are build-only (${mods.map((m) => `file:${m.candidateFile}`).join(', ')});`
      + ' LOCAL pre-publish candidates (unpublished on npm), NOT official npm acceptance;'
      + ' the official installer must be rebuilt from the registry-published core/modules'
      + ' and re-verified against the registry artifact bytes.');
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error(error && error.stack || error);
    process.exit(1);
  });
} else {
  module.exports = {
    assertInsideOwnedTree, safeRmRecursive, assertFreeDisk,
    MIN_BUILD_FREE_BYTES, MIN_TMP_FREE_BYTES,
    restorePackagedAppFiles, assertPackagedAppFilesClean,
  };
}
