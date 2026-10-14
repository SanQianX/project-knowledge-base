'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const { safeRelative } = require('./pack-module-candidates');
function verifyProductRuntime(coreRoot, resolveFrom = path.join(coreRoot, 'package.json')) {
  const manifest = JSON.parse(fs.readFileSync(path.join(coreRoot, 'module-runtime-manifest.json')));
  if (manifest.schema !== 'project-knowledge/module-content/v1' || Object.keys(manifest.modules).length !== 3) throw new Error('Incomplete module content manifest');
  for (const file of ['ui/index.html', 'ui/product.js', 'ui/product.css', 'ui/favicon.svg', 'plugins/project-knowledge/hooks/claude.json', 'plugins/project-knowledge/hooks/codex.json', 'plugins/project-knowledge/scripts/context-hook.cjs', 'plugins/project-knowledge/scripts/mcp-launcher.cjs', 'plugins/project-knowledge/.claude-plugin/plugin.json', 'plugins/project-knowledge/.codex-plugin/plugin.json', 'plugins/project-knowledge/.mcp.json']) if (!manifest.productFiles?.[file]) throw new Error(`Product asset missing from content manifest: ${file}`);
  const resolve = createRequire(resolveFrom);
  for (const [relative, expected] of Object.entries(manifest.productFiles || {})) {
    if (!safeRelative(relative) || crypto.createHash('sha256').update(fs.readFileSync(path.join(coreRoot, relative))).digest('hex') !== expected) throw new Error(`Product UI content mismatch: ${relative}`);
  }
  const modules = {};
  for (const [key, module] of Object.entries(manifest.modules)) {
    const pkgFile = resolve.resolve(`${module.installName}/package.json`);
    const directory = path.dirname(pkgFile);
    const pkg = JSON.parse(fs.readFileSync(pkgFile));
    if (pkg.name !== module.name || pkg.version !== module.version) throw new Error(`Module version mismatch: ${key}`);
    for (const [relative, expected] of Object.entries(module.files)) {
      if (!safeRelative(relative) || !/^[a-f0-9]{64}$/.test(expected)) throw new Error('Unsafe module content manifest');
      const file = path.join(directory, relative);
      if (fs.lstatSync(file).isSymbolicLink() || crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') !== expected) throw new Error(`Module content mismatch: ${key}/${relative}. Install the tested candidate before packaging.`);
    }
    modules[key] = { directory, version: pkg.version };
  }
  for (const file of ['ui/index.html', 'ui/product.js', 'ui/product.css', '_modules/knowledge-engine/src/bin.js', '_modules/knowledge-engine/src/coordinator.js']) if (!fs.existsSync(path.join(coreRoot, file))) throw new Error(`Product runtime missing: ${file}`);
  return modules;
}
if (require.main === module) {
  try { verifyProductRuntime(path.resolve(process.argv[2] || path.join(__dirname, '../..'))); process.stdout.write('All product module versions and contents verified.\n'); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
module.exports = { verifyProductRuntime };
