'use strict';
// P-DESKTOP-FINAL-THIN-R5 offline sentinel for the afterPrune manifest-restore
// contract (merged queued parallel-desktop-manifest-restore task). Proves,
// WITHOUT running any build, that:
//   1. restorePackagedAppFiles restores the export's ORIGINAL package.json and
//      forge.config.cjs bytes in the packaged copy and removes the scratch
//      package-lock.json plus every candidate tarball
//   2. assertPackagedAppFilesClean accepts the restored tree
//   3. every violation class fails closed: a manifest that still carries a
//      build-only file:*.candidate.tgz spec, a shipped scratch lock, a shipped
//      candidate tarball, or the staged forge config with absolute build paths
// Run: node desktop/test/release-preflight-5025-make-manifest-test.cjs

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const make = require('./release-preflight-5025-make.cjs');

const ORIGINAL_MANIFEST = `${JSON.stringify({
  name: '@sanqianx/project-knowledge-desktop',
  version: '5.0.25',
  main: 'main.cjs',
  dependencies: {
    '@sanqianx/project-knowledge': '5.0.25',
    electron: '43.1.1',
    'electron-squirrel-startup': '1.0.1',
    'claude-ai-workbench': 'npm:@sanqianx/claude-ai-workbench@0.13.7',
    '@sanqianx/ai-coding-event-bridge-console': '0.7.3',
  },
}, null, 2)}\n`;
const ORIGINAL_CONFIG = "const path = require('node:path');\nmodule.exports = { packagerConfig: { asar: true } };\n";
// The staged build manifest: build-only file: specs, build-only apache-arrow
// pin, electron moved to devDependencies — exactly the deltas afterPrune must
// undo before the app ships.
const STAGED_MANIFEST = `${JSON.stringify({
  name: '@sanqianx/project-knowledge-desktop',
  version: '5.0.25',
  main: 'main.cjs',
  dependencies: {
    '@sanqianx/project-knowledge': 'file:core.candidate.tgz',
    'electron-squirrel-startup': '1.0.1',
    'apache-arrow': '18.1.0',
    'claude-ai-workbench': 'file:wb.candidate.tgz',
    '@sanqianx/ai-coding-event-bridge-console': 'file:bridge.candidate.tgz',
  },
  devDependencies: { electron: '43.1.1' },
}, null, 2)}\n`;
const STAGED_CONFIG = `'use strict';
const base = require("D:\\\\build-machine\\\\sources\\\\core\\\\desktop\\\\forge.config.cjs");
module.exports = { ...base, packagerConfig: { ...base.packagerConfig,
  afterPrune: [function (buildPath, a, b, c, done) { done(); }] } };
`;
const SCRATCH_LOCK = `${JSON.stringify({
  name: '@sanqianx/project-knowledge-desktop',
  lockfileVersion: 3,
  packages: {
    '': { dependencies: { '@sanqianx/project-knowledge': 'file:core.candidate.tgz' } },
    'node_modules/@sanqianx/project-knowledge': { resolved: 'file:core.candidate.tgz', version: '5.0.25' },
  },
}, null, 2)}\n`;
const CANDIDATE_FILES = ['core.candidate.tgz', 'wb.candidate.tgz', 'bridge.candidate.tgz'];

function buildTree(root, { manifest = STAGED_MANIFEST, config = STAGED_CONFIG, lock = SCRATCH_LOCK, withTarballs = true } = {}) {
  const exportDir = path.join(root, 'export');
  const packaged = path.join(root, 'packaged');
  fs.mkdirSync(exportDir, { recursive: true });
  fs.mkdirSync(packaged, { recursive: true });
  fs.writeFileSync(path.join(exportDir, 'package.json'), ORIGINAL_MANIFEST);
  fs.writeFileSync(path.join(exportDir, 'forge.config.cjs'), ORIGINAL_CONFIG);
  fs.writeFileSync(path.join(packaged, 'package.json'), manifest);
  fs.writeFileSync(path.join(packaged, 'forge.config.cjs'), config);
  if (lock !== null) fs.writeFileSync(path.join(packaged, 'package-lock.json'), lock);
  if (withTarballs) for (const name of CANDIDATE_FILES) fs.writeFileSync(path.join(packaged, name), 'tgz-bytes');
  return { exportDir, packaged };
}

const cleanArgs = (root, tree, { asarFiles = ['package.json', 'forge.config.cjs', 'main.cjs'] } = {}) => ({
  manifestBytes: fs.readFileSync(path.join(tree.packaged, 'package.json')),
  configBytes: fs.readFileSync(path.join(tree.packaged, 'forge.config.cjs')),
  originalManifestBytes: fs.readFileSync(path.join(tree.exportDir, 'package.json')),
  originalConfigBytes: fs.readFileSync(path.join(tree.exportDir, 'forge.config.cjs')),
  asarFiles,
  candidateFiles: CANDIDATE_FILES,
});

test('restorePackagedAppFiles restores export bytes and drops scratch lock + tarballs', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-preflight-5025-manifest-'));
  try {
    const tree = buildTree(root);
    make.restorePackagedAppFiles(tree.packaged, tree.exportDir, CANDIDATE_FILES);
    assert.equal(fs.readFileSync(path.join(tree.packaged, 'package.json'), 'utf8'), ORIGINAL_MANIFEST,
      'packaged manifest must be the export bytes again');
    assert.equal(fs.readFileSync(path.join(tree.packaged, 'forge.config.cjs'), 'utf8'), ORIGINAL_CONFIG,
      'packaged forge config must be the export bytes again (no absolute build paths)');
    assert.ok(!fs.existsSync(path.join(tree.packaged, 'package-lock.json')), 'scratch lock must not ship');
    for (const name of CANDIDATE_FILES) {
      assert.ok(!fs.existsSync(path.join(tree.packaged, name)), `${name} must not ship`);
    }
    make.assertPackagedAppFilesClean(cleanArgs(root, tree));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('assertPackagedAppFilesClean fails closed on every violation class', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-preflight-5025-manifest-'));
  try {
    // (a) manifest still carrying the build-only file:*.candidate.tgz specs
    const poisoned = buildTree(root);
    assert.throws(() => make.assertPackagedAppFilesClean(cleanArgs(root, poisoned)),
      { message: /differs from the export manifest/ });
    // (b) shipped scratch package-lock.json inside the asar (even with a restored manifest)
    const withLock = buildTree(path.join(root, 'b'), { manifest: ORIGINAL_MANIFEST, config: ORIGINAL_CONFIG });
    assert.throws(() => make.assertPackagedAppFilesClean(cleanArgs(root, withLock,
      { asarFiles: ['package.json', 'forge.config.cjs', 'package-lock.json', 'main.cjs'] })),
      { message: /must not ship package-lock\.json/ });
    // (c) shipped candidate tarball
    const withTgz = buildTree(path.join(root, 'c'), { manifest: ORIGINAL_MANIFEST, config: ORIGINAL_CONFIG, lock: null });
    assert.throws(() => make.assertPackagedAppFilesClean(cleanArgs(root, withTgz,
      { asarFiles: ['package.json', 'forge.config.cjs', 'core.candidate.tgz'] })),
      { message: /must not ship core\.candidate\.tgz/ });
    // (d) staged forge config with absolute build paths shipped
    const withStagedCfg = buildTree(path.join(root, 'd'), { manifest: ORIGINAL_MANIFEST, lock: null });
    assert.throws(() => make.assertPackagedAppFilesClean(cleanArgs(root, withStagedCfg)),
      { message: /forge\.config\.cjs differs from the export config/ });
    // (e) the file:*.candidate.tgz regex itself, independent of byte equality
    assert.throws(() => make.assertPackagedAppFilesClean({
      ...cleanArgs(root, buildTree(path.join(root, 'e'), { manifest: STAGED_MANIFEST, config: ORIGINAL_CONFIG, lock: null })),
      originalManifestBytes: Buffer.from(STAGED_MANIFEST), // byte-equal on purpose
    }), { message: /file:\S*\.candidate\.tgz/ });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
