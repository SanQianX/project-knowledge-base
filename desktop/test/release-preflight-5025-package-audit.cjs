'use strict';
// P-RELEASE-PREFLIGHT-5025 packaged-content audit (successor of the deleted
// test/audit-package.cjs, which referenced the also-deleted npm scripts).
//
// Audits the REAL app.asar produced by release-preflight-5025-make.cjs using
// the dependency-free reader in release-preflight-5025-asar.cjs (no
// @electron/asar at packaged-verify time). Fails (exit 1) on:
//   - core package inside the asar whose version differs from the desktop pin
//   - a required native/embedding entry that is missing
//   - any *.node/*.dll/*.ps1 entry that is NOT unpacked to app.asar.unpacked
//     (Electron 43.1.1 cannot dlopen natives from inside an asar; see the
//     evidence under qa-autopilot/artifacts/parallel-20261023/
//     release-preflight-5025/evidence/build/)
//   - forbidden content: the electron runtime, forge/winstaller dev tooling,
//     cross-platform optional bindings, or a leaked candidate core tarball
//     (make's candidate mode must strip core.candidate.tgz via afterPrune)
//   - size budget regressions (app dir 750 MiB, app.asar 320 MiB)
//
// R2 candidate additions: --expect-core-version overrides the pin the repo's
// desktop/package.json still carries (candidate builds happen before the repo
// bump), and --core-tarball <tgz> byte-compares the packaged core against the
// Leader-provided tarball (every file, strict set equality — a version string
// alone proves nothing).
//
// R3 additions (--core-tarball --wb-tarball --bridge-tarball, all three
// together, plus optional --expect-engine-version): the pre-publish candidate
// audit while core 5.0.25 / WB 0.13.7 / Bridge 0.7.3 are ALL unpublished.
// release-preflight-5025-local-modules.cjs adds: per-module byte equality and
// exactly-one-copy (a nested old-version module copy is a masquerade
// failure), the WB quota-17 audited-source contract (version docs exempt),
// the Bridge Windows path fix markers, the NEW engine vendoring
// (vendor-manifest version + per-file sha256 self-consistency), and the UI
// version tooltip markers. These builds are LOCAL pre-publish candidates, NOT
// official npm acceptance; the final official installer is rebuilt from
// registry artifacts and re-verified.
//
// --self-test-negative builds synthetic archives that must FAIL the same
// checks (missing binding; binding packed inside the asar; tarball byte
// mismatch; leaked candidate tarball), so a green run cannot come from a
// rubber-stamped checker. The full R3 module matrix (quota mutation, stale
// engine, missing markers, nested old copy) lives in
// release-preflight-5025-local-modules-test.cjs.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const asarLib = require('./release-preflight-5025-asar.cjs');
const envLib = require('./release-preflight-5025-env.cjs');
const coreTarballLib = require('./release-preflight-5025-core-tarball.cjs');
const localModules = require('./release-preflight-5025-local-modules.cjs');

const desktopRoot = path.resolve(__dirname, '..');
// Size budgets are regression guards recalibrated to the thin-shell era: the
// old audit's 750/320 MiB figures belonged to the pre-thin-shell packaging
// and are unattainable now that app.asar bundles the whole core (5.0.24
// measured 950901144 asar / 1667760497 app dir). +10% headroom absorbs JS
// growth; a native/core bump that outgrows this needs a deliberate change.
const APP_DIR_BUDGET = 1_835_000_000;
const ASAR_BUDGET = 1_046_000_000;

const REQUIRED_ENTRIES = [
  'node_modules/@sanqianx/project-knowledge/package.json',
  'node_modules/@lancedb/lancedb/package.json',
  'node_modules/@lancedb/lancedb-win32-x64-msvc/lancedb.win32-x64-msvc.node',
  'node_modules/@lancedb/lancedb/node_modules/onnxruntime-node/bin/napi-v3/win32/x64/onnxruntime_binding.node',
  'node_modules/@lancedb/lancedb/node_modules/onnxruntime-node/bin/napi-v3/win32/x64/onnxruntime.dll',
  'node_modules/@lancedb/lancedb/node_modules/onnxruntime-node/bin/napi-v3/win32/x64/DirectML.dll',
  'node_modules/apache-arrow/package.json',
  'node_modules/@huggingface/transformers/dist/transformers.node.mjs',
];

const FORBIDDEN_EXACT = [
  'node_modules/electron/package.json',
  'node_modules/electron-winstaller/package.json',
  'node_modules/@electron/packager/package.json',
  'node_modules/@electron/asar/package.json',
  'core.candidate.tgz',
  'wb.candidate.tgz',
  'bridge.candidate.tgz',
];

const FORBIDDEN_PREFIXES = [
  'node_modules/@electron-forge/',
  'node_modules/@lancedb/lancedb-darwin-',
  'node_modules/@lancedb/lancedb-linux-',
  'node_modules/@img/sharp-darwin-',
  'node_modules/@img/sharp-linux-',
  'node_modules/@img/sharp-win32-arm64',
  'node_modules/@img/sharp-win32-ia32',
  'node_modules/@anthropic-ai/claude-agent-sdk-darwin-',
  'node_modules/@anthropic-ai/claude-agent-sdk-linux-',
];

function directorySize(dir) {
  let total = 0;
  const walk = (p) => {
    for (const entry of fs.readdirSync(p, { withFileTypes: true })) {
      const child = path.join(p, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile()) total += fs.statSync(child).size;
    }
  };
  walk(dir);
  return total;
}

function auditBundle(bundleDir, {
  expectCoreVersion, coreTarball, wbTarball, bridgeTarball, expectEngineVersion, quotaAudited,
} = {}) {
  const failures = [];
  const asarPath = path.join(bundleDir, 'resources', 'app.asar');
  const unpackedRoot = `${asarPath}.unpacked`;
  if (!fs.existsSync(asarPath)) {
    return { failures: [`app.asar not found at ${asarPath}`], report: null };
  }

  const asar = asarLib.readHeader(asarPath);
  const all = asarLib.listAll(asar);

  const desktopPkg = require(path.join(desktopRoot, 'package.json'));
  const pinnedCore = expectCoreVersion || desktopPkg.dependencies['@sanqianx/project-knowledge'];
  const corePkgEntry = asarLib.findEntry(asar, 'node_modules/@sanqianx/project-knowledge/package.json');
  const corePkg = JSON.parse(asarLib.extractFile(asarPath, asar, 'node_modules/@sanqianx/project-knowledge/package.json').toString('utf8'));
  if (corePkg.version !== pinnedCore) {
    failures.push(`packaged core ${corePkg.version} != desktop pin ${pinnedCore}`);
  }

  for (const required of REQUIRED_ENTRIES) {
    if (!all.includes(required)) failures.push(`required entry missing: ${required}`);
  }
  for (const forbidden of FORBIDDEN_EXACT) {
    if (all.includes(forbidden)) failures.push(`forbidden entry present: ${forbidden}`);
  }
  for (const entry of all) {
    if (FORBIDDEN_PREFIXES.some((prefix) => entry.startsWith(prefix))) {
      failures.push(`forbidden cross-platform/dev entry: ${entry}`);
    }
    // Natives must live in app.asar.unpacked: Electron 43.1.1 dlopen from
    // inside an asar fails ("not a valid Win32 application" on the extracted
    // temp file), so a packed native is a packaged-runtime defect.
    if (/\.(node|dll|ps1)$/.test(entry)) {
      const meta = asarLib.findEntry(asar, entry);
      const mirrored = path.join(unpackedRoot, entry);
      if (!meta.unpacked) failures.push(`native entry not unpacked: ${entry}`);
      else if (!fs.existsSync(mirrored)) failures.push(`unpacked mirror missing on disk: ${entry}`);
    }
  }

  const servedProduct = 'node_modules/@sanqianx/project-knowledge/ui/product.js';
  if (!all.includes(servedProduct)) failures.push(`served UI missing: ${servedProduct}`);

  const appDirSize = directorySize(bundleDir);
  const asarSize = fs.statSync(asarPath).size;
  if (appDirSize > APP_DIR_BUDGET) failures.push(`app dir ${appDirSize} exceeds budget ${APP_DIR_BUDGET}`);
  if (asarSize > ASAR_BUDGET) failures.push(`app.asar ${asarSize} exceeds budget ${ASAR_BUDGET}`);

  // R3 candidate: local module tarballs (core + WB + Bridge, all three
  // together — none of the three is on the registry yet). Byte equality per
  // module with strict set equality, exactly-one-copy, WB quota-17 audited
  // sources, Bridge Windows path fix markers, NEW engine vendoring and UI
  // tooltip proofs. Extraction scratch + child env live under the OS temp
  // dir, OUTSIDE the repo. These are LOCAL pre-publish candidates, not
  // official npm acceptance.
  let modulesResult = null;
  if (coreTarball || wbTarball || bridgeTarball) {
    try {
      const { mods } = localModules.resolveCandidates({ coreTarball, wbTarball, bridgeTarball });
      const moduleEnvRoot = path.join(os.tmpdir(), 'release-preflight-5025-module-audit-env');
      const moduleEnv = envLib.buildIsolatedEnv({ sourceEnv: process.env, runDir: moduleEnvRoot, gui: false });
      modulesResult = localModules.auditLocalModules({
        asarPath,
        env: moduleEnv,
        extractRoot: path.join(os.tmpdir(), 'release-preflight-5025-module-audit'),
        mods,
        expectEngineVersion,
        quotaAudited,
      });
      failures.push(...modulesResult.failures);
      const coreDetail = modulesResult.details.core;
      if (coreDetail && coreDetail.version && coreDetail.version !== pinnedCore) {
        failures.push(`core tarball ${coreDetail.version} != expected pin ${pinnedCore}`);
      }
    } catch (error) {
      failures.push(`local module candidates invalid: ${error.message}`);
    }
  }

  const report = {
    schema: 'release-preflight-5025-package-audit/v1',
    bundle: path.resolve(bundleDir),
    coreVersion: corePkg.version,
    desktopPin: pinnedCore,
    entryCount: all.length,
    unpackedNativeCount: all.filter((e) => /\.(node|dll|ps1)$/.test(e) && asarLib.findEntry(asar, e).unpacked).length,
    appDirBytes: appDirSize,
    asarBytes: asarSize,
    localModules: modulesResult
      ? {
        source: 'LOCAL pre-publish tarballs (unpublished on npm) — NOT official npm acceptance',
        modules: modulesResult.details,
      }
      : null,
    passed: failures.length === 0,
    failures,
    corePkgEntryIntegrity: Boolean(corePkgEntry && corePkgEntry.integrity),
  };
  return { failures, report };
}

function writeReport(reportPath, report) {
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
}

function defaultBundleDir() {
  return path.join(
    desktopRoot, 'out', '.release-preflight-5025-stage', 'app', 'out', 'Project Knowledge-win32-x64',
  );
}

function selfTestNegative() {
  const tempRoot = path.join(desktopRoot, 'out', '.release-preflight-5025-selftest');
  fs.rmSync(tempRoot, { recursive: true, force: true });
  const results = [];
  const selfTestEnv = envLib.buildIsolatedEnv({ sourceEnv: process.env, runDir: tempRoot, gui: false });
  const buildSyntheticBundle = (name, { includeBinding, unpackNatives, leakCandidateTgz, includeModules }) => {
    const bundle = path.join(tempRoot, name, 'Project Knowledge-win32-x64');
    const resources = path.join(bundle, 'resources');
    fs.mkdirSync(resources, { recursive: true });
    const files = [
      includeModules
        ? null
        : { path: 'node_modules/@sanqianx/project-knowledge/package.json', content: Buffer.from(`${JSON.stringify({ name: '@sanqianx/project-knowledge', version: '0.0.0-selftest' })}\n`) },
      { path: 'node_modules/@lancedb/lancedb/package.json', content: Buffer.from(`${JSON.stringify({ name: '@lancedb/lancedb' })}\n`) },
      { path: 'node_modules/@lancedb/lancedb/node_modules/onnxruntime-node/bin/napi-v3/win32/x64/onnxruntime_binding.node', content: Buffer.from('SYNTHETIC-NODE'), native: true },
      { path: 'node_modules/@lancedb/lancedb/node_modules/onnxruntime-node/bin/napi-v3/win32/x64/onnxruntime.dll', content: Buffer.from('SYNTHETIC-DLL'), native: true },
      { path: 'node_modules/@lancedb/lancedb/node_modules/onnxruntime-node/bin/napi-v3/win32/x64/DirectML.dll', content: Buffer.from('SYNTHETIC-DIRECTML'), native: true },
      { path: 'node_modules/apache-arrow/package.json', content: Buffer.from(`${JSON.stringify({ name: 'apache-arrow' })}\n`) },
      { path: 'node_modules/@huggingface/transformers/dist/transformers.node.mjs', content: Buffer.from('export default {};\n') },
      includeModules
        ? null
        : { path: 'node_modules/@sanqianx/project-knowledge/ui/product.js', content: Buffer.from('// synthetic\n') },
    ].filter(Boolean);
    if (includeModules) {
      for (const [prefix, modFiles] of [
        ['node_modules/@sanqianx/project-knowledge/', coreSelfFiles(false)],
        ['node_modules/claude-ai-workbench/', wbSelfFiles],
        ['node_modules/@sanqianx/ai-coding-event-bridge-console/', bridgeSelfFiles],
      ]) {
        for (const [rel, content] of Object.entries(modFiles)) {
          files.push({ path: prefix + rel, content });
        }
      }
    }
    if (includeBinding) {
      files.push({ path: 'node_modules/@lancedb/lancedb-win32-x64-msvc/lancedb.win32-x64-msvc.node', content: Buffer.from('SYNTHETIC-LANCEDB'), native: true });
    }
    if (leakCandidateTgz) {
      files.push({ path: 'wb.candidate.tgz', content: Buffer.from('SYNTHETIC-LEAKED-CANDIDATE') });
    }
    if (unpackNatives) {
      for (const f of files.filter((x) => x.native)) f.unpacked = true;
    }
    asarLib.writeArchive(path.join(resources, 'app.asar'), files);
    if (unpackNatives) {
      for (const f of files.filter((x) => x.unpacked)) {
        const mirror = path.join(`${path.join(resources, 'app.asar')}.unpacked`, f.path);
        fs.mkdirSync(path.dirname(mirror), { recursive: true });
        fs.writeFileSync(mirror, f.content);
      }
    }
    return bundle;
  };

  // Synthetic module TRIO for the candidate comparator: since R3 the local-
  // module contract is all-three-together (core's manifest declares WB and
  // Bridge versions that are not on the registry), so the tarball scenarios
  // pack a minimal contract-satisfying trio — core (vendor-manifest + engine
  // files + UI tooltip markers), WB (quota feature file), Bridge (path-fix
  // markers) — optionally with one byte-level core mutation that must be
  // caught. The quota map is overridden to {} here; the full 17-hash quota
  // matrix lives in release-preflight-5025-local-modules-test.cjs.
  const WB_SELF = '0.0.0-wbself';
  const BRIDGE_SELF = '0.0.0-bridgeself';
  const ENGINE_SELF = '0.0.0-engineself';
  const wbQuotaBody = 'module.exports = { ProfileQuotaService: class ProfileQuotaService {} };\n';
  const bridgeBody = 'function realpathBestEffort(p) { return p; }\nfunction comparisonForm(a) { return a; }\nmodule.exports = { realpathBestEffort, comparisonForm };\n';
  const engineServer = '// selftest engine server\n';
  const enginePkg = `${JSON.stringify({ name: '@sanqianx/ai-coding-knowledge-engine', version: ENGINE_SELF })}\n`;
  const sha256hex = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
  const coreSelfFiles = (mutateProductJs) => ({
    'package.json': Buffer.from(`${JSON.stringify({
      name: '@sanqianx/project-knowledge',
      version: '0.0.0-selftest',
      dependencies: {
        'claude-ai-workbench': `npm:@sanqianx/claude-ai-workbench@${WB_SELF}`,
        '@sanqianx/ai-coding-event-bridge-console': BRIDGE_SELF,
      },
    })}\n`),
    'vendor-manifest.json': Buffer.from(`${JSON.stringify({
      schema: 'project-knowledge/vendor-runtime/v1',
      modules: {
        'knowledge-engine': {
          name: '@sanqianx/ai-coding-knowledge-engine',
          version: ENGINE_SELF,
          root: '_modules/knowledge-engine',
          files: {
            'src/server.js': sha256hex(Buffer.from(engineServer)),
            'package.json': sha256hex(Buffer.from(enginePkg)),
          },
          sourceCommit: 'selftest000',
        },
      },
    })}\n`),
    '_modules/knowledge-engine/src/server.js': Buffer.from(engineServer),
    '_modules/knowledge-engine/package.json': Buffer.from(enginePkg),
    'ui/index.html': Buffer.from('<html><body><span id="brandVersion"></span></body></html>\n'),
    'ui/version-info.js': Buffer.from('label.textContent = `知识库 v${version}`;\n'),
    'ui/product.js': Buffer.from(mutateProductJs ? '// synthetic MUTATED\n' : '// synthetic\n'),
  });
  const wbSelfFiles = {
    'package.json': Buffer.from(`${JSON.stringify({ name: '@sanqianx/claude-ai-workbench', version: WB_SELF })}\n`),
    'packages/server/lib/profile-quota.js': Buffer.from(wbQuotaBody),
  };
  const bridgeSelfFiles = {
    'package.json': Buffer.from(`${JSON.stringify({ name: '@sanqianx/ai-coding-event-bridge-console', version: BRIDGE_SELF })}\n`),
    'src/bridge/core/bridge.js': Buffer.from(bridgeBody),
  };
  const packSelfTgz = (name, files) => {
    const stage = path.join(tempRoot, `tarball-${name}`);
    const pkgDir = path.join(stage, 'package');
    fs.mkdirSync(pkgDir, { recursive: true });
    for (const [rel, content] of Object.entries(files)) {
      const abs = path.join(pkgDir, ...rel.split('/'));
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
    }
    const tgz = path.join(tempRoot, `${name}.candidate.tgz`);
    const packed = spawnSync(coreTarballLib.bsdtar(), ['-czf', tgz, '-C', stage, 'package'], { env: selfTestEnv, encoding: 'utf8', windowsHide: true, timeout: 60000 });
    if (packed.status !== 0) throw new Error(`synthetic tarball creation failed: ${(packed.stderr || '').slice(-500)}`);
    return tgz;
  };
  const buildSyntheticTrio = (name, { mutateProductJs }) => ({
    coreTarball: packSelfTgz(`core-${name}`, coreSelfFiles(mutateProductJs)),
    wbTarball: packSelfTgz(`wb-${name}`, wbSelfFiles),
    bridgeTarball: packSelfTgz(`bridge-${name}`, bridgeSelfFiles),
  });

  for (const scenario of [
    { name: 'missing-binding', opts: { includeBinding: false, unpackNatives: true }, expectMention: 'lancedb-win32-x64-msvc' },
    { name: 'packed-binding', opts: { includeBinding: true, unpackNatives: false }, expectMention: 'not unpacked' },
    { name: 'unpacked-binding', opts: { includeBinding: true, unpackNatives: true }, expectMention: null },
    { name: 'candidate-tgz-leak', opts: { includeBinding: true, unpackNatives: true, leakCandidateTgz: true }, expectMention: 'forbidden entry present' },
    {
      name: 'tarball-byte-mismatch',
      opts: { includeBinding: true, unpackNatives: true, includeModules: true },
      expectMention: 'byte mismatch',
      tarball: { mutateProductJs: true },
      expectCoreVersion: '0.0.0-selftest',
    },
    {
      name: 'tarball-equal',
      opts: { includeBinding: true, unpackNatives: true, includeModules: true },
      expectMention: null,
      tarball: { mutateProductJs: false },
      expectCoreVersion: '0.0.0-selftest',
    },
  ]) {
    const bundle = buildSyntheticBundle(scenario.name, scenario.opts);
    const trio = scenario.tarball ? buildSyntheticTrio(scenario.name, scenario.tarball) : {};
    const { failures, report } = auditBundle(bundle, {
      expectCoreVersion: scenario.expectCoreVersion,
      ...trio,
      quotaAudited: scenario.tarball ? {} : undefined,
    });
    const shouldFail = scenario.expectMention !== null;
    const failedAsExpected = shouldFail
      ? failures.some((f) => f.includes(scenario.expectMention))
      : (scenario.tarball && !scenario.tarball.mutateProductJs)
        ? failures.length === 0
        : failures.every((f) => !f.includes('lancedb-win32-x64-msvc') && !f.includes('not unpacked'));
    // The version comparison must be live: without a pin override the synthetic
    // 0.0.0-selftest core is flagged against the repo pin; with an override the
    // override is what gets compared (so no 'desktop pin' failure may appear).
    const versionCheckLive = scenario.expectCoreVersion
      ? !failures.some((f) => f.includes('!= desktop pin'))
      : failures.some((f) => f.includes('0.0.0-selftest'));
    results.push({ scenario: scenario.name, shouldFail, failedAsExpected, versionCheckLive, failures });
  }
  fs.rmSync(tempRoot, { recursive: true, force: true });
  const allOk = results.every((r) => r.failedAsExpected && r.versionCheckLive);
  for (const r of results) {
    console.log(`self-test ${r.scenario}: expectFail=${r.shouldFail} failedAsExpected=${r.failedAsExpected} versionCheckLive=${r.versionCheckLive}`);
  }
  return allOk;
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--self-test-negative')) {
    const ok = selfTestNegative();
    console.log(ok ? 'self-test-negative PASS' : 'self-test-negative FAIL');
    process.exit(ok ? 0 : 1);
  }
  const flagValue = (flag) => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const bundleDir = flagValue('--bundle') || process.env.KB_DESKTOP_BUNDLE || defaultBundleDir();
  const reportPath = flagValue('--report')
    || path.join(desktopRoot, 'out', 'package-size-report.json');
  const expectCoreVersion = flagValue('--expect-core-version');
  const coreTarball = flagValue('--core-tarball');
  const wbTarball = flagValue('--wb-tarball');
  const bridgeTarball = flagValue('--bridge-tarball');
  const expectEngineVersion = flagValue('--expect-engine-version');
  const { failures, report } = auditBundle(bundleDir, {
    expectCoreVersion, coreTarball, wbTarball, bridgeTarball, expectEngineVersion,
  });
  writeReport(reportPath, report);
  console.log(JSON.stringify({ ...report, reportPath: path.resolve(reportPath) }, null, 2));
  if (failures.length) {
    console.error(`package audit FAIL (${failures.length})`);
    process.exit(1);
  }
  console.log('package audit PASS');
}

if (require.main === module) {
  main();
} else {
  module.exports = { auditBundle };
}
