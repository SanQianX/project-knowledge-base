'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { verifyProductRuntime } = require('./verify-product-runtime');
const { definitions } = require('./pack-module-candidates');
const root = path.resolve(__dirname, '../..');
const workingTree = process.argv.includes('--working-tree');
function isPinnedModuleVersion(name, value) {
  const version = name === 'claude-ai-workbench' ? String(value || '').replace(/^npm:@sanqianx\/claude-ai-workbench@/, '') : value;
  return /^\d+\.\d+\.\d+(?:-rc\.\d+)?$/.test(version || '');
}
function verify() {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json')));
  for (const { installName } of Object.values(definitions)) {
    if (!isPinnedModuleVersion(installName, pkg.dependencies[installName])) throw new Error(`Module dependency must be pinned: ${installName}`);
  }
  const modules = verifyProductRuntime(root);
  const engine = JSON.parse(fs.readFileSync(path.join(modules.engine.directory, 'package.json')));
  if (Object.keys(engine.dependencies || {}).length || Object.keys(engine.devDependencies || {}).length) throw new Error('Engine must remain dependency-free');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'module-runtime-manifest.json')));
  for (const file of Object.keys(manifest.modules.engine.files).filter(file => file.endsWith('.js'))) {
    const syntax = spawnSync(process.execPath, ['--check', path.join(modules.engine.directory, file)], { windowsHide: true, encoding: 'utf8' });
    if (syntax.status !== 0) throw new Error(`Engine runtime syntax error: ${file}`);
  }
  if (fs.existsSync(path.join(root, '.git')) && !workingTree) {
    for (const file of ['package.json', 'module-runtime-manifest.json']) {
      const indexed = spawnSync('git', ['show', `:${file}`], { cwd: root, windowsHide: true });
      if (indexed.status !== 0 || indexed.stdout.toString().replace(/\r\n/g, '\n') !== fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n')) throw new Error(`Release blocked: Git bytes differ from runtime contract: ${file}`);
    }
  }
  process.stdout.write(workingTree ? 'Four npm module runtimes verified; working tree is not release approval.\n' : 'Pinned npm runtime release gate passed.\n');
}
if (require.main === module) { try { verify(); } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; } }
module.exports = { isPinnedModuleVersion };
