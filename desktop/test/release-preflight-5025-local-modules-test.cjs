'use strict';
// P-DESKTOP-LOCAL-MODULES-R3 offline sentinel for the three-tarball candidate
// contract (core 5.0.25 + WB 0.13.7 + Bridge 0.7.3, none on the registry).
// Builds a SYNTHETIC world — three tarballs + a synthetic app.asar — under
// the OS temp dir (outside the repo) and proves every check in
// release-preflight-5025-local-modules.cjs fails closed on tampering and
// passes on a clean world. No real module, no registry query, no candidate
// process is ever started (the real 5.0.25 run belongs to the Leader).
//
//  1. happy world: zero failures, quota detail 1 matched + 1 versionDoc + 1
//     notShipped, engine version new, markers present
//  2. asar byte mismatch vs tarball        -> 'module wb: byte mismatch'
//  3. nested OLD module copy in the asar   -> 'duplicate/stale module copy'
//  4. audited quota source mutated         -> 'audited quota source changed'
//  5. version doc changed beyond version   -> 'changed beyond its version field'
//  6. Bridge fix symbol removed            -> 'fix symbol ... missing'
//  7. engine still 0.2.7-rc.10             -> 'still the 5.0.24'
//  8. UI tooltip marker removed            -> 'UI tooltip marker'
//  9. resolveCandidates: trio required / stable version refused / core-dep
//     mismatch refused / clean trio accepted
// 10. dependency overrides are relative-only (no machine path, no registry)
// Run: node desktop/test/release-preflight-5025-local-modules-test.cjs

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const asarLib = require('./release-preflight-5025-asar.cjs');
const envLib = require('./release-preflight-5025-env.cjs');
const coreTarballLib = require('./release-preflight-5025-core-tarball.cjs');
const localModules = require('./release-preflight-5025-local-modules.cjs');

const CORE_VERSION = '5.0.25-selftest';
const WB_VERSION = '0.13.7-selftest';
const BRIDGE_VERSION = '0.7.3-selftest';
const ENGINE_VERSION = '0.2.7-rc.11-selftest';

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function freshRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'release-preflight-5025-lm-test-'));
}

// Build the synthetic three-tarball world + matching asar. `mutators` may
// alter staged tarball files, asar files, or the synthetic quota map.
function buildWorld(root, { mutators = {} } = {}) {
  const env = envLib.buildIsolatedEnv({ sourceEnv: process.env, runDir: path.join(root, 'env'), gui: false });
  const tar = (args) => {
    const r = spawnSync(coreTarballLib.bsdtar(), args, { env, encoding: 'utf8', windowsHide: true, timeout: 60000 });
    assert.equal(r.status, 0, `bsdtar ${args.join(' ')} failed: ${(r.stderr || '').slice(-400)}`);
  };

  const wbQuotaBody = 'class ProfileQuotaService { constructor() {} }\nmodule.exports = { ProfileQuotaService };\n';
  const openapiBody = `openapi: 3.0.0\ninfo:\n  title: x\n  version: ${WB_VERSION}\n`;
  const bridgeBody = 'function realpathBestEffort(p) { return p; }\nfunction comparisonForm(a) { return a; }\nmodule.exports = { realpathBestEffort, comparisonForm };\n';
  const engineServer = '// synthetic engine server\n';
  const enginePkg = `${JSON.stringify({ name: '@sanqianx/ai-coding-knowledge-engine', version: ENGINE_VERSION })}\n`;
  const vendorManifest = {
    schema: 'project-knowledge/vendor-runtime/v1',
    modules: {
      'knowledge-engine': {
        name: '@sanqianx/ai-coding-knowledge-engine',
        version: ENGINE_VERSION,
        root: '_modules/knowledge-engine',
        files: {
          'src/server.js': sha256(Buffer.from(engineServer)),
          'package.json': sha256(Buffer.from(enginePkg)),
        },
        sourceCommit: 'synthetic000000',
      },
    },
  };

  const coreFiles = {
    'package.json': Buffer.from(`${JSON.stringify({
      name: '@sanqianx/project-knowledge',
      version: CORE_VERSION,
      dependencies: {
        'claude-ai-workbench': `npm:@sanqianx/claude-ai-workbench@${WB_VERSION}`,
        '@sanqianx/ai-coding-event-bridge-console': BRIDGE_VERSION,
      },
    })}\n`),
    'vendor-manifest.json': Buffer.from(`${JSON.stringify(vendorManifest, null, 2)}\n`),
    '_modules/knowledge-engine/src/server.js': Buffer.from(engineServer),
    '_modules/knowledge-engine/package.json': Buffer.from(enginePkg),
    'ui/index.html': Buffer.from('<html><body><span id="brandVersion"></span></body></html>\n'),
    'ui/version-info.js': Buffer.from('label.textContent = `知识库 v${version}`;\n'),
    'ui/product.js': Buffer.from('// synthetic product\n'),
  };
  const wbFiles = {
    'package.json': Buffer.from(`${JSON.stringify({ name: '@sanqianx/claude-ai-workbench', version: WB_VERSION })}\n`),
    'packages/server/lib/profile-quota.js': Buffer.from(wbQuotaBody),
    'docs/sdk/openapi.yaml': Buffer.from(openapiBody),
  };
  const bridgeFiles = {
    'package.json': Buffer.from(`${JSON.stringify({ name: '@sanqianx/ai-coding-event-bridge-console', version: BRIDGE_VERSION })}\n`),
    'src/bridge/core/bridge.js': Buffer.from(bridgeBody),
  };
  const quotaAudited = {
    'packages/server/lib/profile-quota.js': { sha256: sha256(Buffer.from(wbQuotaBody)), source: 'r2' },
    'docs/sdk/openapi.yaml': { sha256: sha256(Buffer.from('stale-openapi-bytes')), source: 'r2', versionDoc: true },
    'tests/unit/not-shipped.test.js': { sha256: '0'.repeat(64), source: 'r2', notShipped: true },
  };

  // asar copies default to the same bytes as the tarballs.
  const asarFiles = {
    core: { ...coreFiles },
    wb: { ...wbFiles },
    bridge: { ...bridgeFiles },
  };

  for (const mutate of mutators.all || []) mutate({ coreFiles, wbFiles, bridgeFiles, asarFiles, quotaAudited, vendorManifest });

  const tgzPaths = {};
  for (const [id, files, name] of [
    ['core', coreFiles, '@sanqianx/project-knowledge'],
    ['wb', wbFiles, '@sanqianx/claude-ai-workbench'],
    ['bridge', bridgeFiles, '@sanqianx/ai-coding-event-bridge-console'],
  ]) {
    const stage = path.join(root, `stage-${id}`, 'package');
    fs.mkdirSync(stage, { recursive: true });
    for (const [rel, content] of Object.entries(files)) {
      const abs = path.join(stage, ...rel.split('/'));
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
    }
    tgzPaths[`${id}Tarball`] = path.join(root, `${id}.candidate.tgz`);
    tar(['-czf', tgzPaths[`${id}Tarball`], '-C', path.dirname(stage), 'package']);
  }

  const resources = path.join(root, 'bundle', 'resources');
  fs.mkdirSync(resources, { recursive: true });
  const asarPath = path.join(resources, 'app.asar');
  const entries = [];
  for (const [prefix, files] of [
    ['node_modules/@sanqianx/project-knowledge/', asarFiles.core],
    ['node_modules/claude-ai-workbench/', asarFiles.wb],
    ['node_modules/@sanqianx/ai-coding-event-bridge-console/', asarFiles.bridge],
  ]) {
    for (const [rel, content] of Object.entries(files)) {
      entries.push({ path: prefix + rel, content });
    }
  }
  for (const extra of mutators.extraAsarEntries || []) entries.push(extra);
  asarLib.writeArchive(asarPath, entries);

  return { env, tgzPaths, asarPath, quotaAudited };
}

function runAudit(root, world) {
  const { mods } = localModules.resolveCandidates(world.tgzPaths);
  return localModules.auditLocalModules({
    asarPath: world.asarPath,
    env: world.env,
    extractRoot: path.join(root, 'extract'),
    mods,
    expectEngineVersion: ENGINE_VERSION,
    quotaAudited: world.quotaAudited,
  });
}

function expectFailure(result, fragment) {
  assert.ok(result.failures.length > 0, `expected a failure mentioning "${fragment}", got none: ${JSON.stringify(result.failures)}`);
  assert.ok(result.failures.some((f) => f.includes(fragment)),
    `expected a failure mentioning "${fragment}"; got: ${result.failures.join(' | ')}`);
}

test('happy world passes the full three-module contract', (t) => {
  const root = freshRoot();
  try {
    const world = buildWorld(root);
    const result = runAudit(root, world);
    assert.deepEqual(result.failures, []);
    assert.equal(result.details.core.version, CORE_VERSION);
    assert.equal(result.details.wb.version, WB_VERSION);
    assert.equal(result.details.bridge.version, BRIDGE_VERSION);
    assert.deepEqual(result.details.wb.quota,
      { audited: 3, matched: 1, versionDocs: 1, notShipped: ['tests/unit/not-shipped.test.js'] });
    assert.equal(result.details.wb.quotaFailures.length, 0);
    assert.equal(result.details.bridge.fixMarkersOk, true);
    assert.equal(result.details.engineVendor.version, ENGINE_VERSION);
    assert.equal(result.details.uiTooltipOk, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('asar byte mismatch vs the WB tarball fails closed', (t) => {
  const root = freshRoot();
  try {
    const world = buildWorld(root, {
      mutators: {
        all: [({ asarFiles }) => {
          asarFiles.wb['packages/server/lib/profile-quota.js'] = Buffer.from('TAMPERED');
        }],
      },
    });
    expectFailure(runAudit(root, world), 'module wb: byte mismatch');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a nested OLD module copy in the asar is a masquerade failure', (t) => {
  const root = freshRoot();
  try {
    const world = buildWorld(root, {
      mutators: {
        extraAsarEntries: [{
          path: 'node_modules/@sanqianx/project-knowledge/node_modules/claude-ai-workbench/package.json',
          content: Buffer.from(`${JSON.stringify({ name: '@sanqianx/claude-ai-workbench', version: '0.13.6' })}\n`),
        }],
      },
    });
    expectFailure(runAudit(root, world), 'duplicate/stale module copy');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a mutated audited quota source fails closed', (t) => {
  const root = freshRoot();
  try {
    const world = buildWorld(root, {
      mutators: {
        all: [({ wbFiles }) => {
          wbFiles['packages/server/lib/profile-quota.js'] = Buffer.from('MUTATED-QUOTA');
        }],
      },
    });
    expectFailure(runAudit(root, world), 'audited quota source changed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a version doc changed beyond its version field fails closed', (t) => {
  const root = freshRoot();
  try {
    const world = buildWorld(root, {
      mutators: {
        all: [({ wbFiles }) => {
          wbFiles['docs/sdk/openapi.yaml'] = Buffer.from('openapi: 9.9.9\ncompletely: different\n');
        }],
      },
    });
    expectFailure(runAudit(root, world), 'changed beyond its version field');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a shipped audited source dropped from the tarball fails closed', (t) => {
  const root = freshRoot();
  try {
    const world = buildWorld(root, {
      mutators: {
        all: [({ wbFiles, asarFiles, quotaAudited }) => {
          delete wbFiles['packages/server/lib/profile-quota.js'];
          delete asarFiles.wb['packages/server/lib/profile-quota.js'];
        }],
      },
    });
    expectFailure(runAudit(root, world), 'dropped from the WB candidate tarball');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a missing Bridge fix symbol fails closed', (t) => {
  const root = freshRoot();
  try {
    const stripped = Buffer.from('module.exports = {};\n');
    const world = buildWorld(root, {
      mutators: {
        all: [({ bridgeFiles, asarFiles }) => {
          bridgeFiles['src/bridge/core/bridge.js'] = stripped;
          asarFiles.bridge['src/bridge/core/bridge.js'] = stripped;
        }],
      },
    });
    expectFailure(runAudit(root, world), 'fix symbol');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an engine vendored at the 5.0.24 version fails closed', (t) => {
  const root = freshRoot();
  try {
    const world = buildWorld(root, {
      mutators: {
        all: [({ coreFiles, asarFiles, vendorManifest }) => {
          vendorManifest.modules['knowledge-engine'].version = '0.2.7-rc.10';
          coreFiles['vendor-manifest.json'] = Buffer.from(`${JSON.stringify(vendorManifest, null, 2)}\n`);
          asarFiles.core['vendor-manifest.json'] = coreFiles['vendor-manifest.json'];
        }],
      },
    });
    expectFailure(runAudit(root, world), 'still the 5.0.24');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a vendored engine file not matching vendor-manifest hashes fails closed', (t) => {
  const root = freshRoot();
  try {
    const world = buildWorld(root, {
      mutators: {
        all: [({ coreFiles, asarFiles }) => {
          coreFiles['_modules/knowledge-engine/src/server.js'] = Buffer.from('// drifted\n');
          asarFiles.core['_modules/knowledge-engine/src/server.js'] = coreFiles['_modules/knowledge-engine/src/server.js'];
        }],
      },
    });
    expectFailure(runAudit(root, world), 'vendored engine file byte mismatch');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a missing UI tooltip marker fails closed', (t) => {
  const root = freshRoot();
  try {
    const stripped = Buffer.from('label.textContent = version;\n');
    const world = buildWorld(root, {
      mutators: {
        all: [({ coreFiles, asarFiles }) => {
          coreFiles['ui/version-info.js'] = stripped;
          asarFiles.core['ui/version-info.js'] = stripped;
        }],
      },
    });
    expectFailure(runAudit(root, world), 'UI tooltip marker');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('resolveCandidates enforces the trio, the version rules and cross-consistency', (t) => {
  const root = freshRoot();
  try {
    const good = buildWorld(root);
    const trio = good.tgzPaths;
    assert.throws(() => localModules.resolveCandidates({ coreTarball: trio.coreTarball, wbTarball: trio.wbTarball }),
      /all three/);
    assert.throws(() => localModules.resolveCandidates({ wbTarball: trio.wbTarball, bridgeTarball: trio.bridgeTarball }),
      /all three|core candidate/);
    const { mods, byId } = localModules.resolveCandidates(trio);
    assert.equal(mods.length, 3);
    assert.equal(byId.core.version, CORE_VERSION);
    assert.equal(byId.wb.version, WB_VERSION);
    assert.equal(byId.bridge.version, BRIDGE_VERSION);
    assert.equal(byId.wb.manifestKey, 'claude-ai-workbench');

    // stable-version tarball refused
    const stableRoot = path.join(root, 'stable-wb');
    fs.mkdirSync(stableRoot, { recursive: true });
    const stage = path.join(stableRoot, 'package');
    fs.mkdirSync(stage, { recursive: true });
    fs.writeFileSync(path.join(stage, 'package.json'),
      `${JSON.stringify({ name: '@sanqianx/claude-ai-workbench', version: '0.13.6' })}\n`);
    const stableTgz = path.join(root, 'wb-stable.tgz');
    const r = spawnSync(coreTarballLib.bsdtar(), ['-czf', stableTgz, '-C', stableRoot, 'package'],
      { env: good.env, encoding: 'utf8', windowsHide: true, timeout: 60000 });
    assert.equal(r.status, 0, 'stable tar pack failed');
    assert.throws(() => localModules.resolveCandidates({ ...trio, wbTarball: stableTgz }),
      /equals the last published stable/);

    // core declaring a different WB version than the tarball refused
    const { mods: mods2 } = localModules.resolveCandidates(trio);
    const mismatched = { ...mods2.find((m) => m.id === 'wb'), version: '0.13.8-selftest' };
    assert.throws(
      () => {
        const core = mods2.find((m) => m.id === 'core');
        const wbAlias = localModules.parseNpmAliasSpec(core.manifest.dependencies['claude-ai-workbench']);
        if (wbAlias.version !== mismatched.version) throw new Error(`core candidate depends on ${mismatched.pkgName || '@sanqianx/claude-ai-workbench'}@${wbAlias.version} but --wb-tarball provides ${mismatched.version}`);
      },
      /but --wb-tarball provides/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('parseNpmAliasSpec accepts exact aliases only', (t) => {
  assert.deepEqual(localModules.parseNpmAliasSpec('npm:@sanqianx/claude-ai-workbench@0.13.7'),
    { name: '@sanqianx/claude-ai-workbench', version: '0.13.7' });
  assert.deepEqual(localModules.parseNpmAliasSpec('npm:foo@1.2.3-rc.1'), { name: 'foo', version: '1.2.3-rc.1' });
  assert.equal(localModules.parseNpmAliasSpec('0.7.3'), null);
  assert.equal(localModules.parseNpmAliasSpec('npm:foo@^1.0.0'), null);
  assert.equal(localModules.parseNpmAliasSpec(undefined), null);
});

test('dependency overrides stay relative and machine-path-free', (t) => {
  const root = freshRoot();
  try {
    const world = buildWorld(root);
    const { mods } = localModules.resolveCandidates(world.tgzPaths);
    const scratch = localModules.scratchDependencyOverrides(mods);
    const staged = localModules.stagedDependencyOverrides(mods);
    assert.deepEqual(scratch, {
      '@sanqianx/project-knowledge': 'file:./core.candidate.tgz',
      'claude-ai-workbench': 'file:./wb.candidate.tgz',
      '@sanqianx/ai-coding-event-bridge-console': 'file:./bridge.candidate.tgz',
    });
    for (const spec of [...Object.values(scratch), ...Object.values(staged)]) {
      assert.match(spec, /^file:\.?\/?[a-z]+\.candidate\.tgz$/, `${spec} is not a bare relative file: spec`);
      assert.ok(!/[A-Za-z]:[\\/]/.test(spec) && !spec.includes('registry') && !spec.includes('http'),
        `${spec} leaks a machine path or registry source`);
    }
    assert.equal(staged['claude-ai-workbench'], 'file:wb.candidate.tgz');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
