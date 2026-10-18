'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { isPinnedModuleVersion } = require('../scripts/verify-module-runtime');
for (const name of ['claude-ai-workbench', '@sanqianx/vector-hub', '@sanqianx/ai-coding-event-bridge-console']) {
  for (const version of ['1.2.3', '1.2.3-rc.1', '1.2.3-rc.12']) assert.ok(isPinnedModuleVersion(name, version));
  for (const version of ['latest', 'next', '^1.2.3', '~1.2.3', '>=1.2.3', 'file:../module', 'link:module', 'workspace:*', '1.2.3-beta.1', '1.2.3-rc', undefined]) assert.equal(isPinnedModuleVersion(name, version), false, String(version));
}
assert.ok(isPinnedModuleVersion('claude-ai-workbench', 'npm:@sanqianx/claude-ai-workbench@0.13.2-rc.1'));
assert.equal(isPinnedModuleVersion('@sanqianx/vector-hub', 'npm:@sanqianx/claude-ai-workbench@0.13.2-rc.1'), false);
const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../module-runtime-manifest.json')));
for (const file of ['ui/index.html', 'ui/knowledge-panel.html', 'ui/product.js', 'ui/product.css', 'ui/favicon.svg']) assert.match(manifest.productFiles[file], /^[a-f0-9]{64}$/);
console.log('candidate-release-contract-test PASS');
