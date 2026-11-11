'use strict';
// Recompute module-runtime-manifest.json content hashes from the actual
// release bytes: product files from the working tree, module files from the
// installed pinned packages in node_modules. Version pins are NOT touched -
// they must already match package.json (verify-module-runtime enforces it).
//
// Usage: node _site/scripts/refresh-runtime-manifest.js [--check]
//   default: rewrite the manifest with fresh hashes
//   --check: only report which entries would change
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const { definitions } = require('./pack-module-candidates');

const root = path.resolve(__dirname, '../..');
const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const check = process.argv.includes('--check');
const manifestPath = path.join(root, 'module-runtime-manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const resolve = createRequire(path.join(root, 'package.json'));
const changes = [];

for (const relative of Object.keys(manifest.productFiles || {})) {
  const file = path.join(root, relative);
  if (!fs.existsSync(file)) { changes.push(`product ${relative}: MISSING`); continue; }
  const fresh = sha256(file);
  if (manifest.productFiles[relative] !== fresh) {
    changes.push(`product ${relative}`);
    if (!check) manifest.productFiles[relative] = fresh;
  }
}

for (const [key, module] of Object.entries(manifest.modules || {})) {
  const pkgFile = resolve.resolve(`${module.installName}/package.json`);
  const directory = path.dirname(pkgFile);
  const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
  const pinned = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).dependencies[module.installName];
  if (pkg.version !== module.version) {
    if (pkg.version === pinned) {
      // The pin moved to a new exact version and node_modules already holds
      // it: adopt the version and refresh that module's hashes from the
      // actually installed bytes.
      changes.push(`${key}: version ${module.version} -> ${pkg.version} (pinned)`);
      if (!check) module.version = pkg.version;
    } else {
      changes.push(`${key}: node_modules has ${pkg.version}, manifest says ${module.version} (update package.json pin + npm install first)`);
      continue;
    }
  }
  for (const relative of Object.keys(module.files)) {
    const file = path.join(directory, relative);
    if (!fs.existsSync(file)) { changes.push(`${key}/${relative}: MISSING in install (stale entry for old version)`); if (!check) delete module.files[relative]; continue; }
    const fresh = sha256(file);
    if (module.files[relative] !== fresh) {
      changes.push(`${key}/${relative}`);
      if (!check) module.files[relative] = fresh;
    }
  }
  // New runtime files that the installed package ships but the manifest
  // never listed would silently escape the gate: list them too.
  const listed = new Set(Object.keys(module.files));
  const walk = (dir, prefix = '') => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      const relative = prefix + entry.name;
      if (entry.isDirectory()) walk(file, relative + '/');
      else if (!listed.has(relative) && definitionIncludes(key, relative)) {
        changes.push(`${key}/${relative}: NEW runtime file`);
        if (!check) module.files[relative] = sha256(file);
      }
    }
  };
  const srcDir = path.join(directory, 'src');
  if (fs.existsSync(srcDir)) walk(srcDir, 'src/');
  // Engine runtimes ship their whole src tree (the 0.2.8 manifest listed all
  // of it): never let a newly added engine file slip outside the content gate.
  if (key === 'engine') {
    const walkAll = (dir, prefix = '') => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        const relative = prefix + entry.name;
        if (entry.isDirectory()) walkAll(file, relative + '/');
        else if (!listed.has(relative) && /\.(js|json)$/.test(relative)) {
          changes.push(`${key}/${relative}: NEW runtime file`);
          if (!check) module.files[relative] = sha256(file);
        }
      }
    };
    walkAll(srcDir, 'src/');
  }
}

function definitionIncludes(key, relative) {
  const definition = definitions[key];
  if (!definition) return false;
  const allow = [...definition.required, ...(definition.files || [])];
  return allow.some(pattern => pattern === relative || (pattern.endsWith('/') && relative.startsWith(pattern)));
}

if (!changes.length) {
  process.stdout.write('module-runtime-manifest.json is already in sync.\n');
} else if (check) {
  process.stdout.write(`Stale manifest entries (${changes.length}):\n${changes.join('\n')}\n`);
} else {
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  process.stdout.write(`Refreshed ${changes.length} manifest hashes:\n${changes.join('\n')}\n`);
}
