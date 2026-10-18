'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const AtomicFile = require('../lib/atomic-file');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const root = path.resolve(__dirname, '../..');
const npmCli = process.env.npm_execpath || path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
const definitions = {
  terminal: { option: '--terminal-source', name: '@sanqianx/claude-ai-workbench', installName: 'claude-ai-workbench', required: ['apps/agent-terminal/app.js', 'apps/agent-terminal/app.css', 'packages/server/lib/knowledge-context.js'] },
  vectorHub: { option: '--vector-source', name: '@sanqianx/vector-hub', installName: '@sanqianx/vector-hub', required: ['dist/cjs/bin.js', 'dist/cjs/server/manager.js', 'ui/index.html'] },
  eventBridge: { option: '--bridge-source', name: '@sanqianx/ai-coding-event-bridge-console', installName: '@sanqianx/ai-coding-event-bridge-console', required: ['src/server.js', 'src/bridge/core/consumer-registry.js', 'console/index.html'] },
};
function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, windowsHide: true, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`${path.basename(command)} failed (${result.status}): ${result.error?.message || result.stderr}`);
  return result.stdout;
}
function safeRelative(file) { return typeof file === 'string' && !path.isAbsolute(file) && !/[\\\x00-\x1f]/.test(file) && !file.split('/').some(p => p === '..' || p === '.'); }
function installedFileBytes(pkg, relative, bytes) {
  const bins = typeof pkg.bin === 'string' ? [pkg.bin] : Object.values(pkg.bin || {});
  const isBin = bins.some(file => String(file).replace(/\\/g, '/').replace(/^\.\//, '') === relative);
  // npm bin-links removes CRLF from the shebang only, on every platform.
  // Hash the installed bytes; keep body line endings and ordinary files exact.
  if (isBin && /^#![^\n]+\r\n/.test(bytes.subarray(0, 2048).toString('utf8'))) return Buffer.from(bytes.toString('utf8').replace(/^(#![^\n]+)\r\n/, '$1\n'));
  return bytes;
}
function productFiles(directory) {
  const previous = JSON.parse(fs.readFileSync(path.join(directory, 'module-runtime-manifest.json'), 'utf8'));
  const files = new Set(['ui/index.html', 'ui/knowledge-panel.html', 'ui/product.js', 'ui/live-client.js', 'ui/product.css', 'ui/favicon.svg', ...Object.keys(previous.productFiles || {})]);
  return Object.fromEntries([...files].map(file => {
    if (!safeRelative(file)) throw new Error('Unsafe product asset path');
    const target = path.join(directory, file);
    if (fs.lstatSync(target).isSymbolicLink()) throw new Error('Symlink in product assets');
    return [file, hash(fs.readFileSync(target))];
  }));
}
function verifyInstalled(manifest, installedRoot) {
  for (const [key, module] of Object.entries(manifest.modules)) {
    const directory = path.join(installedRoot, 'node_modules', module.installName);
    const pkg = JSON.parse(fs.readFileSync(path.join(directory, 'package.json')));
    if (pkg.name !== module.name || pkg.version !== module.version) throw new Error(`Installed module identity mismatch: ${key}`);
    for (const [relative, expected] of Object.entries(module.files)) {
      if (!safeRelative(relative)) throw new Error('Unsafe module manifest path');
      const file = path.join(directory, relative);
      if (fs.lstatSync(file).isSymbolicLink() || hash(fs.readFileSync(file)) !== expected) throw new Error(`Installed module is stale or altered: ${key}/${relative}`);
    }
  }
}
function pack(sources) {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-module-candidates-'));
  const manifest = { schema: 'project-knowledge/module-candidates/v1', createdAt: new Date().toISOString(), modules: {} };
  for (const [key, definition] of Object.entries(definitions)) {
    const source = path.resolve(sources[key]);
    const pkg = JSON.parse(fs.readFileSync(path.join(source, 'package.json')));
    if (pkg.name !== definition.name) throw new Error(`Unexpected source identity: ${key}`);
    const expectedVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'))).dependencies[definition.installName];
    if (expectedVersion !== pkg.version && expectedVersion !== `npm:${pkg.name}@${pkg.version}`) throw new Error(`Source version is not pinned by the shell: ${key}`);
    const result = JSON.parse(run(process.execPath, [npmCli, 'pack', '--ignore-scripts', '--json', '--pack-destination', output], source))[0];
    const files = {};
    for (const entry of result.files) {
      if (!safeRelative(entry.path)) throw new Error('Unsafe npm package path');
      const file = path.join(source, entry.path);
      if (fs.lstatSync(file).isSymbolicLink()) throw new Error(`Symlink in module package: ${key}/${entry.path}`);
      files[entry.path] = hash(installedFileBytes(pkg, entry.path, fs.readFileSync(file)));
    }
    if (definition.required.some(file => !files[file])) throw new Error(`Incomplete module runtime: ${key}`);
    manifest.modules[key] = { name: pkg.name, installName: definition.installName, version: pkg.version, tarball: result.filename, sha256: hash(fs.readFileSync(path.join(output, result.filename))), files };
    process.stdout.write(`Packed ${key} ${pkg.version}: ${result.files.length} files\n`);
  }
  const manifestPath = path.join(output, 'module-candidates.json'); AtomicFile.writeJsonAtomic(manifestPath, manifest);
  AtomicFile.writeJsonAtomic(path.join(root, 'module-runtime-manifest.json'), { schema: 'project-knowledge/module-content/v1', productFiles: productFiles(root), modules: Object.fromEntries(Object.entries(manifest.modules).map(([key, module]) => [key, { name: module.name, installName: module.installName, version: module.version, files: module.files }])) });
  process.stdout.write(`MODULE_CANDIDATES ${manifestPath}\n`);
  return manifestPath;
}
if (require.main === module) {
  try {
    const at = process.argv.indexOf('--verify-installed');
    if (at >= 0) { const manifest = JSON.parse(fs.readFileSync(process.argv[at + 1])); verifyInstalled(manifest, path.resolve(process.argv[at + 2])); process.stdout.write('Installed module bytes verified against candidate artifacts.\n'); }
    else {
      const sources = {};
      for (const [key, d] of Object.entries(definitions)) { const i = process.argv.indexOf(d.option); if (i < 0 || !process.argv[i + 1]) throw new Error(`Explicit source required: ${d.option}`); sources[key] = process.argv[i + 1]; }
      pack(sources);
    }
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
module.exports = { verifyInstalled, safeRelative, productFiles, installedFileBytes };
