'use strict';
const assert = require('node:assert/strict');
const pkg = require('../package.json');

// Thin-shell manifest contract: the desktop package must depend on nothing
// beyond the core package, Electron itself, and the Squirrel bootstrap hook.
const allowedDevDependencies = new Set([
  '@electron-forge/cli',
  '@electron-forge/maker-squirrel',
  'electron-winstaller',
  'png-to-ico',
]);

assert.equal(pkg.name, '@sanqianx/project-knowledge-desktop');
assert.equal(pkg.version, '5.0.18-rc.1');
assert.equal(pkg.main, 'main.cjs');

assert.deepEqual(
  Object.keys(pkg.dependencies || {}).sort(),
  ['@sanqianx/project-knowledge', 'electron', 'electron-squirrel-startup'],
  'runtime dependencies must be exactly the thin trio',
);
assert.equal(pkg.dependencies['@sanqianx/project-knowledge'], '5.0.18-rc.1', 'core dependency must be an exact pin');
assert.equal(pkg.private, undefined, 'the desktop candidate must be publishable');
assert.match(pkg.dependencies.electron, /^\d+\.\d+\.\d+$/, 'electron must be an exact numeric three-segment version');
assert.equal(pkg.dependencies['electron-squirrel-startup'], '1.0.1');

for (const [name, version] of Object.entries(pkg.dependencies)) {
  assert.ok(!String(version).includes('file:'), `${name} must not be resolved via file: references`);
}
for (const [name, version] of Object.entries(pkg.devDependencies || {})) {
  assert.ok(allowedDevDependencies.has(name), `devDependency ${name} is not on the packaging allowlist`);
  assert.ok(!String(version).includes('file:'), `devDependency ${name} must not use file: references`);
}

const testScript = pkg.scripts && pkg.scripts.test;
assert.equal(typeof testScript, 'string', 'scripts.test must exist');
for (const file of ['thin-package-test.cjs', 'backend-runtime-test.cjs', 'cli-args-test.cjs']) {
  assert.ok(testScript.includes(file), `scripts.test must chain ${file}`);
}
assert.ok(
  testScript.indexOf('thin-package-test.cjs') < testScript.indexOf('backend-runtime-test.cjs')
    && testScript.indexOf('backend-runtime-test.cjs') < testScript.indexOf('cli-args-test.cjs'),
  'scripts.test must chain the three files in order',
);

console.log('thin package test PASS');
