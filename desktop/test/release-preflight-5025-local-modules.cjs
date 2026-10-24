'use strict';
// P-DESKTOP-LOCAL-MODULES-R3 helper: pre-publish candidate with THREE
// unpublished local tarballs — core 5.0.25 + Workbench 0.13.7 + Bridge 0.7.3
// — none of which exist on the npm registry yet (WB/Bridge publish was
// rejected by OIDC/token permissions; that is an auth failure, NOT a product
// failure, and old modules must never stand in for the new features).
//
// What this module owns:
//   1. Candidate resolution + cross-manifest consistency:
//      - every tarball's package/package.json is read (bsdtar -xOf) and its
//        name/version validated;
//      - the CORE tarball's own dependencies are checked against the provided
//        WB/Bridge tarballs (alias spec `claude-ai-workbench:
//        npm:@sanqianx/claude-ai-workbench@X` must match the WB tarball
//        version; `@sanqianx/ai-coding-event-bridge-console: Y` must match the
//        Bridge tarball) so the tree is coherent and no stale module can
//        masquerade as the new one;
//      - every candidate version must differ from the last published stable
//        set (5.0.24 / 0.13.6 / 0.7.2 / engine 0.2.7-rc.10).
//   2. npm dependency overrides for the candidate prefix and the staged build
//      manifest: RELATIVE `file:` specs only (file:./core.candidate.tgz etc.)
//      — install, prune and the packaged tree all consume the same local
//      tarballs; no machine path, no local registry, no file:/registry spec
//      ever reaches a published manifest (final official builds keep exact
//      registry versions and are rebuilt + re-verified after publish).
//   3. Packaged-content proofs (audit + packaged-verify both call these):
//      - every module byte-identical to its tarball (strict set equality via
//        release-preflight-5025-core-tarball.cjs, which is prefix-generic);
//      - exactly ONE copy of each module anywhere in app.asar (a nested
//        old-version copy under core/node_modules is a masquerade failure);
//      - WB quota feature: all 17 audited sources (r1 ∪ r2 union from the
//        model-quota-feature lane) must be present in the tarball and
//        byte-equal to the audited sha256, EXCEPT the declared version docs
//        (docs/sdk/openapi.yaml: hash-exempt, must exist, and its info.version
//        must equal the WB version) and the four audited files the WB package
//        intentionally does not ship (3 tests + docs/profile-quota.md are
//        outside the manifest files whitelist);
//      - Bridge Windows path fix: src/bridge/core/bridge.js must contain the
//        audited fix symbols realpathBestEffort + comparisonForm;
//      - engine vendoring inside core: vendor-manifest.json must declare a NEW
//        engine version (≠ the 5.0.24 vendored 0.2.7-rc.10) and every vendored
//        file's sha256 in the packaged asar must match that manifest;
//      - UI version tooltip: packaged core ui/index.html contains brandVersion
//        and ui/version-info.js contains the 「知识库 v」label.
//
// Scratch/extraction roots must live OUTSIDE the repo (TEMP isolation); every
// bsdtar child runs under the hardened env built by release-preflight-5025-env.cjs.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const asarLib = require('./release-preflight-5025-asar.cjs');
const coreTarballLib = require('./release-preflight-5025-core-tarball.cjs');

const CORE_ASAR_PREFIX = 'node_modules/@sanqianx/project-knowledge/';

const CANDIDATE_MODULES = [
  {
    id: 'core', optionName: 'coreTarball', flagName: '--core-tarball',
    pkgName: '@sanqianx/project-knowledge', manifestKey: '@sanqianx/project-knowledge',
    candidateFile: 'core.candidate.tgz',
  },
  {
    id: 'wb', optionName: 'wbTarball', flagName: '--wb-tarball',
    pkgName: '@sanqianx/claude-ai-workbench', manifestKey: 'claude-ai-workbench',
    candidateFile: 'wb.candidate.tgz',
  },
  {
    id: 'bridge', optionName: 'bridgeTarball', flagName: '--bridge-tarball',
    pkgName: '@sanqianx/ai-coding-event-bridge-console', manifestKey: '@sanqianx/ai-coding-event-bridge-console',
    candidateFile: 'bridge.candidate.tgz',
  },
];

// Last registry-published set (5.0.24 era). A candidate identical to these is
// an old module masquerading as the new release.
const PREVIOUS_STABLE = {
  core: '5.0.24', wb: '0.13.6', bridge: '0.7.2', engine: '0.2.7-rc.10',
};

// 17 audited quota sources = model-quota-feature r1 ∪ r2 final review
// (qa-autopilot/artifacts/parallel-20261023/model-quota-feature/). r2 entries
// are authoritative where both rounds touched a file. Verified against the
// real 0.13.7 tarball on 2026-10-24: 12/17 byte-match, openapi.yaml differs
// only as a version doc, 4 do not ship with the package.
const WB_QUOTA_AUDITED = {
  'packages/server/lib/profile-quota.js': { sha256: 'e953f91c6b52253657f84b34a003ea3692bf6e03c3f28efb305056c56169ff3d', source: 'r2' },
  'packages/server/lib/workbench-service.js': { sha256: 'a1414a462f50d9a2135aad1d04364a8b57d8fed0dbb1147726ba7d678795ee98', source: 'r2' },
  'packages/server/lib/http-handler.js': { sha256: 'db5c964e6ff9fc3f6082d458d8662f917d2de088a782c628002b1b608a873723', source: 'r2' },
  'packages/server/index.js': { sha256: '39de0bb5af12ac27ed2a419498e71b598b9dd4d165c264f3f935b80e5c0f99e6', source: 'r2' },
  'packages/ui/ai-profile-settings.js': { sha256: '923a1e56614e5b15dd302a1179bf93c2ee56947ece5deb0a07a4c270215c9277', source: 'r2' },
  'packages/ui/ai-profile-settings.d.ts': { sha256: '10cdc96fb20c1f47a18a984638a26bd69972fc0cacf7bd56f4f64ead593e7a36', source: 'r2' },
  'apps/ai-profile-settings-host/page.js': { sha256: '8ab508cb50f9765d148cd93f4d4f4f440f94731dbf43850cfb51cca1c869b070', source: 'r2' },
  'apps/minimal-test-host/host.js': { sha256: 'c316871e616afe66898eb22a9fa71d8ed530886cdad1b1eb6ae870373994962a', source: 'r2' },
  'packages/client/index.js': { sha256: '714f8b302a069ef0a299b95c1344ebee1294c1eb77d3fbde347b658f8c51cbb0', source: 'r2' },
  'packages/client/index.d.ts': { sha256: '0366cc96ff2e83814d0dcad34899a26068f7ab5d0b15f9f1c02a7e976db28215', source: 'r2' },
  'packages/contracts/index.d.ts': { sha256: '6cdfadc74582b6cc84412e4bea6e0d0e65101c2b087d38580fbb1a384e21dca3', source: 'r2' },
  'docs/sdk/openapi.yaml': { sha256: 'a1f5155e3431966ed14a26a6fb36c1da474c49c9892f62aeac365764e4fb8f50', source: 'r2', versionDoc: true },
  'docs/profile-quota.md': { sha256: '6646152a46c97c809c0d8cdfeac2697a0c03f88b1cdecb3a52f0584a7106628f', source: 'r2', notShipped: true },
  'tests/integration/profile-quota-api.test.js': { sha256: '22ae77b9ad51c8f6b3e453f716092161e247889bf7dca889710f8c32247342f2', source: 'r2', notShipped: true },
  'tests/unit/ai-profile-quota-ui.test.js': { sha256: '2c7c22869582333f337424894f46ae9a84df2a38c93b70ef1d1781bd80eb73f5', source: 'r2', notShipped: true },
  'tests/unit/runtime-loader.test.js': { sha256: '40dfbbe89e1909fcaf7b8eb16a745866e89d629e66738b974711a15cee4b43f0', source: 'r1', notShipped: true },
  'packages/client/README.md': { sha256: 'e0962d561dad6b50837b0f8099f6931aad14d2dabb683556b88aae0ff485b675', source: 'r1' },
};

// Bridge 0.7.3 Windows path fix (audited symbols in src/bridge/core/bridge.js;
// absent from the published 0.7.2 — see release-preflight-5025 report).
const BRIDGE_FIX_MARKERS = {
  file: 'src/bridge/core/bridge.js',
  substrings: ['realpathBestEffort', 'comparisonForm'],
};

// UI version tooltip shipped inside core (version-visibility lane).
const UI_TOOLTIP_MARKERS = [
  { file: 'ui/index.html', substring: 'brandVersion' },
  { file: 'ui/version-info.js', substring: '知识库 v' },
];

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function asarPrefixFor(mod) {
  return `node_modules/${mod.manifestKey}/`;
}

// package/package.json straight out of the tarball, no extraction.
function readTarballManifest(tgz, env) {
  const r = spawnSync(coreTarballLib.bsdtar(), ['-xOf', path.resolve(tgz), 'package/package.json'], {
    env: env || process.env, encoding: 'utf8', windowsHide: true, timeout: 60000,
  });
  if (r.status !== 0) {
    throw new Error(`cannot read package/package.json from ${tgz}: ${(r.stderr || '').slice(-500)}`);
  }
  return JSON.parse(r.stdout);
}

// 'npm:@sanqianx/claude-ai-workbench@0.13.7' -> { name, version }; else null.
function parseNpmAliasSpec(spec) {
  const m = typeof spec === 'string' ? spec.match(/^npm:(@[^@]+|[^@]+)@(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)$/) : null;
  return m ? { name: m[1], version: m[2] } : null;
}

// Resolve + validate the provided candidate tarballs. Full candidate mode is
// all-or-nothing: core declares unpublished WB/Bridge versions, so a core
// candidate without matching local WB/Bridge tarballs could only be satisfied
// by OLD registry modules (or fail) — refuse it up front instead.
function resolveCandidates({ coreTarball, wbTarball, bridgeTarball, env } = {}) {
  const byId = {};
  for (const def of CANDIDATE_MODULES) {
    const flag = { coreTarball, wbTarball, bridgeTarball }[def.optionName];
    if (!flag) continue;
    const tgz = path.resolve(flag);
    if (!fs.existsSync(tgz)) throw new Error(`${def.flagName} not found: ${tgz}`);
    const manifest = readTarballManifest(tgz, env);
    if (manifest.name !== def.pkgName) {
      throw new Error(`${def.flagName} packages ${manifest.name}, expected ${def.pkgName}`);
    }
    if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(manifest.version || '')) {
      throw new Error(`${def.flagName} has non-exact version ${manifest.version}`);
    }
    if (manifest.version === PREVIOUS_STABLE[def.id]) {
      throw new Error(`${def.id} candidate ${manifest.version} equals the last published stable — an old module cannot stand in for the new release`);
    }
    byId[def.id] = { ...def, tgz, name: manifest.name, version: manifest.version, manifest };
  }
  const have = ['core', 'wb', 'bridge'].filter((id) => byId[id]);
  if (have.length && have.length < 3) {
    throw new Error(`pre-publish candidate mode needs all three tarballs together (--core-tarball, --wb-tarball, --bridge-tarball); got only: ${have.join(', ')}`
      + ' — core declares WB/Bridge versions that are not on the registry yet');
  }
  if (byId.core) {
    const coreDeps = byId.core.manifest.dependencies || {};
    const wbSpec = coreDeps[byId.wb.manifestKey];
    const wbAlias = parseNpmAliasSpec(wbSpec);
    if (!wbAlias || wbAlias.name !== byId.wb.pkgName) {
      throw new Error(`core candidate dependency ${byId.wb.manifestKey}=${wbSpec} is not the expected npm: alias of ${byId.wb.pkgName}`);
    }
    if (wbAlias.version !== byId.wb.version) {
      throw new Error(`core candidate depends on ${byId.wb.pkgName}@${wbAlias.version} but --wb-tarball provides ${byId.wb.version}`);
    }
    const bridgeSpec = coreDeps[byId.bridge.manifestKey];
    if (bridgeSpec !== byId.bridge.version) {
      throw new Error(`core candidate depends on ${byId.bridge.pkgName}@${bridgeSpec} but --bridge-tarball provides ${byId.bridge.version}`);
    }
  }
  return { mods: have.map((id) => byId[id]), byId };
}

// Relative file: overrides — candidate prefix manifests (npm install) and the
// staged build manifest (packager prune) consume the same local tarballs.
function scratchDependencyOverrides(mods) {
  const overrides = {};
  for (const mod of mods) overrides[mod.manifestKey] = `file:./${mod.candidateFile}`;
  return overrides;
}

function stagedDependencyOverrides(mods) {
  const overrides = {};
  for (const mod of mods) overrides[mod.manifestKey] = `file:${mod.candidateFile}`;
  return overrides;
}

function parseAsarJson(asarPath, asar, entry) {
  return JSON.parse(asarLib.extractFile(asarPath, asar, entry).toString('utf8'));
}

// Exactly one copy of each candidate module anywhere in app.asar, at the top
// prefix, at the candidate version. A second (nested) copy — e.g. an old
// registry version under core/node_modules — is a masquerade failure.
function assertNoDuplicateModulesInAsar(asarPath, asar, mods) {
  const failures = [];
  const all = asarLib.listAll(asar);
  for (const mod of mods) {
    const re = new RegExp(`(^|/)node_modules/${mod.manifestKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/package\\.json$`);
    const found = all.filter((e) => re.test(e));
    if (found.length === 0) {
      failures.push(`module ${mod.id} missing from app.asar entirely (${mod.manifestKey})`);
      continue;
    }
    for (const entry of found) {
      const pkg = parseAsarJson(asarPath, asar, entry);
      if (pkg.name !== mod.pkgName || pkg.version !== mod.version) {
        failures.push(`duplicate/stale module copy: ${entry} is ${pkg.name}@${pkg.version}, expected ${mod.pkgName}@${mod.version}`);
      } else if (entry !== `node_modules/${mod.manifestKey}/package.json`) {
        failures.push(`module ${mod.id} appears at a nested path as well: ${entry}`);
      }
    }
  }
  return failures;
}

// WB quota-17 contract, evaluated against the EXTRACTED WB tarball (the asar
// is proven byte-identical to that tarball separately, so this fixes the
// tarball to the audited sources). `quotaAudited` overrides the embedded
// audited map (same shape) for synthetic offline negatives.
function auditWbQuota(wb, wbExtractDir, quotaAudited) {
  const failures = [];
  const auditedMap = quotaAudited || WB_QUOTA_AUDITED;
  const pkgRoot = path.join(wbExtractDir, 'package');
  let matched = 0;
  let versionDocs = 0;
  const notShipped = [];
  for (const [rel, audited] of Object.entries(auditedMap)) {
    const abs = path.join(pkgRoot, ...rel.split('/'));
    if (!fs.existsSync(abs)) {
      if (audited.notShipped) notShipped.push(rel);
      else failures.push(`audited quota source dropped from the WB candidate tarball: ${rel}`);
      continue;
    }
    if (sha256(fs.readFileSync(abs)) === audited.sha256) {
      matched += 1;
      continue;
    }
    if (audited.versionDoc) {
      // Real 0.13.7 openapi.yaml carries the version INDENTED under info:
      // ("info:\n  title: ...\n  version: 0.13.7"), so anchor on the info
      // block's indented version line — not a column-0 "version:".
      const text = fs.readFileSync(abs, 'utf8');
      const infoBlock = text.match(/^info:\s*\r?\n((?:[ \t]+[^\r\n]*\r?\n?)*)/m);
      const versionLine = infoBlock ? infoBlock[1].match(/^[ \t]+version:[ \t]*(\S+)[ \t]*$/m) : null;
      if (!versionLine || versionLine[1] !== wb.version) {
        failures.push(`audited version doc ${rel} changed beyond its version field (info.version ${versionLine ? versionLine[1] : 'absent'} != ${wb.version})`);
      } else {
        versionDocs += 1;
      }
      continue;
    }
    failures.push(`audited quota source changed: ${rel}`);
  }
  return {
    failures,
    detail: { audited: Object.keys(auditedMap).length, matched, versionDocs, notShipped },
  };
}

function auditBridgeFixMarkers(asarPath, asar, bridge) {
  const entry = asarPrefixFor(bridge) + BRIDGE_FIX_MARKERS.file;
  if (!asarLib.listAll(asar).includes(entry)) {
    return [`bridge fix marker file missing from app.asar: ${BRIDGE_FIX_MARKERS.file}`];
  }
  const text = asarLib.extractFile(asarPath, asar, entry).toString('utf8');
  return BRIDGE_FIX_MARKERS.substrings
    .filter((s) => !text.includes(s))
    .map((s) => `bridge Windows path fix symbol ${s} missing from ${BRIDGE_FIX_MARKERS.file}`);
}

function auditEngineVendor(asarPath, asar, core, { expectEngineVersion } = {}) {
  const failures = [];
  const entry = `${CORE_ASAR_PREFIX}vendor-manifest.json`;
  const list = asarLib.listAll(asar);
  if (!list.includes(entry)) return { failures: [`core vendor-manifest.json missing from app.asar`], detail: null };
  const vendor = parseAsarJson(asarPath, asar, entry);
  const engine = vendor.modules && vendor.modules['knowledge-engine'];
  if (!engine) return { failures: ['vendor-manifest has no knowledge-engine module'], detail: null };
  if (engine.version === PREVIOUS_STABLE.engine) {
    failures.push(`vendored engine is still the 5.0.24 ${PREVIOUS_STABLE.engine} — new engine vendoring missing`);
  }
  if (expectEngineVersion && engine.version !== expectEngineVersion) {
    failures.push(`vendored engine ${engine.version} != expected ${expectEngineVersion}`);
  }
  const root = `${CORE_ASAR_PREFIX}${engine.root.replace(/\/$/, '')}/`;
  for (const [rel, hash] of Object.entries(engine.files || {})) {
    const fileEntry = root + rel;
    if (!list.includes(fileEntry)) {
      failures.push(`vendored engine file missing: ${rel}`);
      continue;
    }
    if (sha256(asarLib.extractFile(asarPath, asar, fileEntry)) !== hash) {
      failures.push(`vendored engine file byte mismatch: ${rel}`);
    }
  }
  return { failures, detail: { version: engine.version, files: Object.keys(engine.files || {}).length, sourceCommit: engine.sourceCommit || null } };
}

function auditUiTooltip(asarPath, asar) {
  const list = asarLib.listAll(asar);
  const failures = [];
  for (const marker of UI_TOOLTIP_MARKERS) {
    const entry = `${CORE_ASAR_PREFIX}${marker.file}`;
    if (!list.includes(entry)) {
      failures.push(`UI tooltip carrier missing from packaged core: ${marker.file}`);
      continue;
    }
    if (!asarLib.extractFile(asarPath, asar, entry).toString('utf8').includes(marker.substring)) {
      failures.push(`UI tooltip marker "${marker.substring}" missing from ${marker.file}`);
    }
  }
  return failures;
}

// Full offline module audit against a real app.asar. extractRoot must be
// outside the repo (TEMP isolation); env is the hardened child env.
// quotaAudited overrides the embedded WB audited map for synthetic tests.
function auditLocalModules({ asarPath, env, extractRoot, mods, expectEngineVersion, quotaAudited }) {
  const failures = [];
  const asar = asarLib.readHeader(asarPath);
  const details = {};
  failures.push(...assertNoDuplicateModulesInAsar(asarPath, asar, mods));
  for (const mod of mods) {
    const extractDir = path.join(extractRoot, mod.id);
    const result = coreTarballLib.verifyCoreTarball({
      tgz: mod.tgz, extractDir, asarPath, env, corePrefix: asarPrefixFor(mod),
    });
    const modFailures = result.failures.map((f) => `module ${mod.id}: ${f}`);
    failures.push(...modFailures);
    details[mod.id] = {
      version: result.version, checked: result.checked,
      byteIdentical: modFailures.length === 0,
    };
    if (mod.id === 'wb') {
      const quota = auditWbQuota(mod, extractDir, quotaAudited);
      failures.push(...quota.failures.map((f) => `wb quota: ${f}`));
      details.wb.quota = quota.detail;
      details.wb.quotaFailures = quota.failures;
    }
  }
  if (mods.some((m) => m.id === 'bridge')) {
    const bridge = mods.find((m) => m.id === 'bridge');
    const marker = auditBridgeFixMarkers(asarPath, asar, bridge);
    failures.push(...marker);
    details.bridge.fixMarkersOk = marker.length === 0;
  }
  if (mods.some((m) => m.id === 'core')) {
    const core = mods.find((m) => m.id === 'core');
    const engine = auditEngineVendor(asarPath, asar, core, { expectEngineVersion });
    failures.push(...engine.failures.map((f) => `engine vendor: ${f}`));
    details.engineVendor = engine.detail;
    const tooltip = auditUiTooltip(asarPath, asar);
    failures.push(...tooltip);
    details.uiTooltipOk = tooltip.length === 0;
  }
  return { failures, details };
}

module.exports = {
  CANDIDATE_MODULES, PREVIOUS_STABLE, WB_QUOTA_AUDITED, BRIDGE_FIX_MARKERS, UI_TOOLTIP_MARKERS,
  CORE_ASAR_PREFIX,
  asarPrefixFor, readTarballManifest, parseNpmAliasSpec, resolveCandidates,
  scratchDependencyOverrides, stagedDependencyOverrides,
  assertNoDuplicateModulesInAsar, auditWbQuota, auditBridgeFixMarkers,
  auditEngineVendor, auditUiTooltip, auditLocalModules,
};
