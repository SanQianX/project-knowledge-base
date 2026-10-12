'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('node:child_process');
const AtomicFile = require('../lib/atomic-file');

const root = path.resolve(__dirname, '../..');
const destination = path.join(root, '_modules', 'knowledge-engine');
const manifestFile = path.join(root, 'vendor-manifest.json');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function sources(source) {
  const files = ['package.json', 'README.md', 'ui/index.html', 'ui/app.js', 'ui/app.css'];
  function walk(directory) {
    for (const entry of fs.readdirSync(path.join(source, directory), { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error('Symlinks are not accepted in a vendored runtime');
      const relative = `${directory}/${entry.name}`;
      if (entry.isDirectory()) walk(relative); else if (entry.isFile()) files.push(relative);
    }
  }
  walk('src'); return files.sort();
}
function vendor(source) {
  source = path.resolve(source);
  const pkg = JSON.parse(fs.readFileSync(path.join(source, 'package.json')));
  if (pkg.name !== '@sanqianx/ai-coding-knowledge-engine' || Object.keys(pkg.dependencies || {}).length || Object.keys(pkg.devDependencies || {}).length) throw new Error('The engine must remain a dependency-free runtime');
  const previous = fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile)) : { schema: 'project-knowledge/vendor-runtime/v1', modules: {} };
  const priorFiles = previous.modules['knowledge-engine']?.files || {};
  const files = {};
  for (const relative of sources(source)) {
    const sourceFile = path.join(source, relative), target = path.join(destination, relative);
    if (fs.lstatSync(sourceFile).isSymbolicLink() || fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) throw new Error('Unsafe runtime path');
    const bytes = fs.readFileSync(sourceFile), digest = hash(bytes);
    if (fs.existsSync(target)) {
      const current = hash(fs.readFileSync(target));
      if (current !== digest && current !== priorFiles[relative]) throw new Error(`Preserving unrecognized local runtime change: ${relative}`);
    }
    AtomicFile.writeFileAtomic(target, bytes); files[relative] = digest;
  }
  // No broad cleanup: obsolete files remain visible to the verifier until an
  // explicit reviewed cleanup. Untracked/user changes are never overwritten.
  previous.modules['knowledge-engine'] = { name: pkg.name, version: pkg.version, root: '_modules/knowledge-engine', files };
  if (fs.existsSync(path.join(source, '.git'))) previous.modules['knowledge-engine'].sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8', windowsHide: true }).trim();
  AtomicFile.writeJsonAtomic(manifestFile, previous);
  process.stdout.write(`Vendored knowledge-engine ${pkg.version}: ${Object.keys(files).length} runtime files\n`);
}
const option = process.argv.indexOf('--engine-source');
if (option < 0 || !process.argv[option + 1]) { process.stderr.write('Usage: vendor-modules --engine-source <explicit checkout path>\n'); process.exitCode = 1; }
else vendor(process.argv[option + 1]);
