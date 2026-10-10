'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const root = path.resolve(__dirname, '../..');
const workingTree = process.argv.includes('--working-tree');
function isPinnedModuleVersion(name, value) {
  const version = name === 'claude-ai-workbench' ? String(value || '').replace(/^npm:@sanqianx\/claude-ai-workbench@/, '') : value;
  return /^\d+\.\d+\.\d+(?:-rc\.\d+)?$/.test(version || '');
}
function verify() {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'vendor-manifest.json'), 'utf8'));
  if (manifest.schema !== 'project-knowledge/vendor-runtime/v1') throw new Error('Invalid runtime manifest');
  const engine = manifest.modules['knowledge-engine'];
  if (!engine || engine.root !== '_modules/knowledge-engine') throw new Error('Missing engine runtime');
  const packageInfo = JSON.parse(fs.readFileSync(path.join(root, 'package.json')));
  for (const dependency of ['claude-ai-workbench', '@sanqianx/vector-hub', '@sanqianx/ai-coding-event-bridge-console']) {
    if (!isPinnedModuleVersion(dependency, packageInfo.dependencies[dependency])) throw new Error(`Module dependency must be pinned: ${dependency}`);
  }
  const required = ['package.json', 'src/bin.js', 'src/server.js', 'src/coordinator.js', 'src/analysis-worker.js', 'ui/index.html', 'ui/app.js', 'ui/app.css'];
  if (required.some(file => !engine.files[file])) throw new Error('Incomplete runtime manifest');
  const hasGit = fs.existsSync(path.join(root, '.git'));
  function checkTree(directory, prefix = '') {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const relative = prefix + entry.name;
      if (entry.isSymbolicLink()) throw new Error(`Unsafe runtime path: ${relative}`);
      if (entry.isDirectory()) checkTree(path.join(directory, entry.name), relative + '/');
      else if (!Object.hasOwn(engine.files, relative)) throw new Error(`Unreviewed runtime file: ${relative}`);
    }
  }
  checkTree(path.join(root, engine.root));
  for (const [relative, expected] of Object.entries(engine.files)) {
    if (relative.includes('..') || path.isAbsolute(relative)) throw new Error('Unsafe manifest path');
    const file = path.join(root, engine.root, relative);
    if (fs.lstatSync(file).isSymbolicLink()) throw new Error('Unsafe vendored symlink');
    if (crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') !== expected) throw new Error(`Runtime drift: ${relative}`);
    if (relative.endsWith('.js')) { const syntax = spawnSync(process.execPath, ['--check', file], { windowsHide: true, encoding: 'utf8' }); if (syntax.status !== 0) throw new Error(`Runtime syntax error: ${relative}`); }
    if (hasGit && !workingTree) {
      const indexed = spawnSync('git', ['show', `:${engine.root}/${relative}`], { cwd: root, windowsHide: true });
      if (indexed.status !== 0) throw new Error(`Release blocked: runtime file is not Git tracked: ${relative}`);
      if (crypto.createHash('sha256').update(indexed.stdout).digest('hex') !== expected) throw new Error(`Release blocked: Git runtime bytes differ from manifest: ${relative}`);
    }
  }
  const enginePackage = JSON.parse(fs.readFileSync(path.join(root, engine.root, 'package.json')));
  if (enginePackage.version !== engine.version || Object.keys(enginePackage.dependencies || {}).length || Object.keys(enginePackage.devDependencies || {}).length) throw new Error('Engine version/dependency contract failed');
  process.stdout.write(workingTree ? 'Runtime content verified; uncommitted working tree is not release approval.\n' : 'Vendored runtime release gate passed.\n');
}
if (require.main === module) { try { verify(); } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; } }
module.exports = { isPinnedModuleVersion };
