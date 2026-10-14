'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const { safeRelative } = require('./pack-module-candidates');
const AtomicFile = require('../lib/atomic-file');
const root = path.resolve(__dirname, '../..');
const file = path.join(root, 'module-runtime-manifest.json');
const manifest = JSON.parse(fs.readFileSync(file));
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json')));
const resolve = createRequire(path.join(root, 'package.json'));
const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
for (const module of Object.values(manifest.modules)) {
  const directory = path.dirname(resolve.resolve(`${module.installName}/package.json`));
  if (!directory.startsWith(path.join(root, 'node_modules') + path.sep)) throw new Error('Module must resolve inside this installed dependency tree.');
  const installed = JSON.parse(fs.readFileSync(path.join(directory, 'package.json')));
  const expected = pkg.dependencies[module.installName];
  if (installed.name !== module.name || ![installed.version, `npm:${installed.name}@${installed.version}`].includes(expected)) throw new Error('Install the exact registry module version before content synchronization.');
  module.version = installed.version;
  for (const relative of Object.keys(module.files)) { if (!safeRelative(relative)) throw new Error('Unsafe content path'); const target = path.join(directory, relative); if (fs.lstatSync(target).isSymbolicLink()) throw new Error('Unsafe content symlink'); module.files[relative] = digest(target); }
}
for (const relative of ['ui/index.html', 'ui/product.js', 'ui/product.css', 'ui/favicon.svg', 'plugins/project-knowledge/hooks/claude.json', 'plugins/project-knowledge/hooks/codex.json', 'plugins/project-knowledge/scripts/context-hook.cjs', 'plugins/project-knowledge/scripts/mcp-launcher.cjs', 'plugins/project-knowledge/.claude-plugin/plugin.json', 'plugins/project-knowledge/.codex-plugin/plugin.json', 'plugins/project-knowledge/.mcp.json']) manifest.productFiles[relative] = digest(path.join(root, relative));
AtomicFile.writeJsonAtomic(file, manifest);
console.log('Updated content hashes from exact installed modules and reviewed product assets; this is not release acceptance.');
