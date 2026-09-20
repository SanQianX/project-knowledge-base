'use strict';

// Vendor compiled module runtimes into _modules/ so the npm package ships the
// Agent Terminal and vector-hub services. Run from the repo root whenever the
// sibling projects change, then commit the result:
//
//   npm run vendor:modules
//
// Sources are sibling checkouts (overridable for non-standard layouts):
//   KB_VENDOR_WORKBENCH    default <repo>/../claude-ai-workbench
//   KB_VENDOR_VECTORHUB    default <repo>/../vector-hub
//   KB_VENDOR_EVENTBRIDGE  default <repo>/../ai-coding-event-bridge
//
// The npm package must stay installable without the siblings present, so the
// vendored output is committed rather than built at publish time.

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const MODULES_ROOT = path.join(ROOT, '_modules');
const WORKBENCH_ROOT = path.resolve(process.env.KB_VENDOR_WORKBENCH || path.join(ROOT, '..', 'claude-ai-workbench'));
const VECTORHUB_ROOT = path.resolve(process.env.KB_VENDOR_VECTORHUB || path.join(ROOT, '..', 'vector-hub'));
const EVENTBRIDGE_ROOT = path.resolve(process.env.KB_VENDOR_EVENTBRIDGE || path.join(ROOT, '..', 'ai-coding-event-bridge'));

const DEFAULT_IGNORES = new Set(['node_modules', '.git']);

function copyTree(source, target, { ignores = DEFAULT_IGNORES } = {}) {
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (ignores.has(entry.name)) continue;
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isDirectory()) copyTree(from, to, { ignores });
    else if (entry.isFile()) fs.copyFileSync(from, to);
  }
}

function mustExist(dir, label) {
  if (!fs.existsSync(dir)) {
    throw new Error(`${label} not found at ${dir} — set KB_VENDOR_* or clone the sibling project`);
  }
}

function readVersion(pkgPath) {
  return JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version || '0.0.0';
}

function verifyVectorHubBuild(root) {
  for (const file of ['dist/cjs/bin.js', 'ui/index.html']) {
    if (!fs.existsSync(path.join(root, file))) {
      throw new Error(`vector-hub build output missing: ${file} — run "npm run build" in ${root} first`);
    }
  }
}

function verifyEventBridgeSources(root) {
  for (const file of [
    'packages/core/package.json',
    'packages/core/src/index.js',
    'packages/console/package.json',
    'packages/console/src/bin.js',
    'packages/console/console/index.html',
  ]) {
    if (!fs.existsSync(path.join(root, file))) {
      throw new Error(`ai-coding-event-bridge source missing: ${file} — check the ${root} checkout`);
    }
  }
}

function vendor() {
  mustExist(WORKBENCH_ROOT, 'claude-ai-workbench checkout');
  mustExist(path.join(WORKBENCH_ROOT, 'packages', 'server'), 'workbench server package');
  mustExist(path.join(WORKBENCH_ROOT, 'src', 'backend', 'lib'), 'workbench legacy runtime');
  mustExist(VECTORHUB_ROOT, 'vector-hub checkout');
  verifyVectorHubBuild(VECTORHUB_ROOT);
  mustExist(EVENTBRIDGE_ROOT, 'ai-coding-event-bridge checkout');
  verifyEventBridgeSources(EVENTBRIDGE_ROOT);

  fs.rmSync(MODULES_ROOT, { recursive: true, force: true });

  // Terminal: distribution root layout that server/index.js resolves via
  // require.resolve('claude-ai-workbench/package.json') with NODE_PATH=_modules.
  const wb = path.join(MODULES_ROOT, 'claude-ai-workbench');
  fs.mkdirSync(wb, { recursive: true });
  fs.copyFileSync(path.join(WORKBENCH_ROOT, 'package.json'), path.join(wb, 'package.json'));
  copyTree(path.join(WORKBENCH_ROOT, 'apps', 'agent-terminal'), path.join(wb, 'apps', 'agent-terminal'));
  for (const pkg of ['server', 'contracts', 'core', 'client', 'ui']) {
    copyTree(path.join(WORKBENCH_ROOT, 'packages', pkg), path.join(wb, 'packages', pkg));
  }
  copyTree(path.join(WORKBENCH_ROOT, 'src', 'backend', 'lib'), path.join(wb, 'src', 'backend', 'lib'));

  // vector-hub: prebuilt dist + console UI. dist/cjs resolves <root>/ui via
  // __dirname/../../../ui, so ui/ must sit next to dist/.
  const vh = path.join(MODULES_ROOT, 'vectorhub');
  fs.mkdirSync(vh, { recursive: true });
  fs.copyFileSync(path.join(VECTORHUB_ROOT, 'package.json'), path.join(vh, 'package.json'));
  copyTree(path.join(VECTORHUB_ROOT, 'dist', 'cjs'), path.join(vh, 'dist', 'cjs'));
  copyTree(path.join(VECTORHUB_ROOT, 'ui'), path.join(vh, 'ui'));

  // vectra fork: plain-JS lib + grpc proto, resolved via NODE_PATH=_modules.
  const vectraSource = path.join(VECTORHUB_ROOT, 'packages', 'vectra');
  mustExist(path.join(vectraSource, 'lib'), 'vectra lib');
  const ve = path.join(MODULES_ROOT, 'vectra');
  fs.mkdirSync(ve, { recursive: true });
  fs.copyFileSync(path.join(vectraSource, 'package.json'), path.join(ve, 'package.json'));
  copyTree(path.join(vectraSource, 'lib'), path.join(ve, 'lib'));
  copyTree(path.join(vectraSource, 'proto'), path.join(ve, 'proto'));

  // ai-coding-event-bridge console: plain-JS CommonJS, no build step. The core
  // package is vendored INSIDE the console's node_modules so the console's
  // `require('@sanqianx/ai-coding-event-bridge')` resolves to the exact
  // vendored copy — the walk-up would otherwise reach the host package's own
  // (older) npm dependency first and silently mix two core versions.
  const eb = path.join(MODULES_ROOT, 'event-bridge', 'packages', 'console');
  fs.mkdirSync(eb, { recursive: true });
  fs.copyFileSync(path.join(EVENTBRIDGE_ROOT, 'packages', 'console', 'package.json'), path.join(eb, 'package.json'));
  copyTree(path.join(EVENTBRIDGE_ROOT, 'packages', 'console', 'src'), path.join(eb, 'src'));
  copyTree(path.join(EVENTBRIDGE_ROOT, 'packages', 'console', 'console'), path.join(eb, 'console'));
  const ebCore = path.join(eb, 'node_modules', '@sanqianx', 'ai-coding-event-bridge');
  fs.mkdirSync(ebCore, { recursive: true });
  fs.copyFileSync(path.join(EVENTBRIDGE_ROOT, 'packages', 'core', 'package.json'), path.join(ebCore, 'package.json'));
  copyTree(path.join(EVENTBRIDGE_ROOT, 'packages', 'core', 'src'), path.join(ebCore, 'src'));

  const manifest = {
    generatedAt: new Date().toISOString(),
    claudeAiWorkbench: readVersion(path.join(WORKBENCH_ROOT, 'package.json')),
    vectorHub: readVersion(path.join(VECTORHUB_ROOT, 'package.json')),
    vectra: readVersion(path.join(vectraSource, 'package.json')),
    eventBridge: readVersion(path.join(EVENTBRIDGE_ROOT, 'packages', 'console', 'package.json')),
  };
  fs.writeFileSync(path.join(MODULES_ROOT, 'vendor-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log(`vendored modules into ${MODULES_ROOT}:`, JSON.stringify(manifest));
}

function gitTracksFile(relPath) {
  // CI publishes from the git checkout: a vendored file that exists on the
  // dev disk but was never committed (e.g. swallowed by a gitignore rule)
  // silently drops out of the tarball. `--error-unmatch` exits nonzero when
  // nothing under the path is tracked.
  try {
    require('child_process').execFileSync('git', ['ls-files', '--error-unmatch', '--', relPath], { cwd: ROOT, stdio: 'ignore' });
    return true;
  } catch { return false; }
}

function check() {
  const required = [
    'vendor-manifest.json',
    'claude-ai-workbench/package.json',
    'claude-ai-workbench/packages/server/bin/agent-terminal-server.js',
    'claude-ai-workbench/apps/agent-terminal/index.html',
    'claude-ai-workbench/src/backend/lib',
    'vectorhub/dist/cjs/bin.js',
    'vectorhub/ui/index.html',
    'vectra/lib/index.js',
    'vectra/proto',
    'event-bridge/packages/console/src/bin.js',
    'event-bridge/packages/console/console/index.html',
    'event-bridge/packages/console/node_modules/@sanqianx/ai-coding-event-bridge/src/index.js',
  ];
  const missing = required.filter(rel => !fs.existsSync(path.join(MODULES_ROOT, rel)));
  if (missing.length) {
    throw new Error(`vendored modules incomplete, missing: ${missing.join(', ')} — run "npm run vendor:modules"`);
  }
  const uncommitted = required.filter(rel => !gitTracksFile(`_modules/${rel}`));
  if (uncommitted.length) {
    throw new Error(`vendored modules not tracked by git: ${uncommitted.join(', ')} — fix .gitignore and commit them (files on disk but outside git never reach the published tarball)`);
  }
  console.log(`vendored modules present (${fs.readFileSync(path.join(MODULES_ROOT, 'vendor-manifest.json'), 'utf8').trim().split('\n')[0]})`);
}

const mode = process.argv[2] || '';
if (mode === '--check') check();
else if (mode === '' || mode === '--force') vendor();
else throw new Error(`Unknown argument: ${mode}`);
