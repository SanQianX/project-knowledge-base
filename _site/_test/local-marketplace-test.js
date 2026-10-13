'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { IntegrationManager } = require('../lib/integration-installer');
const commands = [];
const root = path.resolve(__dirname, '../..');
const manager = new IntegrationManager({ rootDir: root, commandResolver: name => name, runner: (cmd, args) => {
  commands.push(args);
  return { status: 0, stdout: '[]', stderr: '' };
} });
manager.ensureClaudeMarketplace();
assert.equal(commands.find(args => args.slice(0, 3).join(' ') === 'plugin marketplace add')[3], root, 'Claude installs from the downloaded npm package, not GitHub');
const custom = new IntegrationManager({ marketplaceSource: 'https://example.invalid/explicit.git', commandResolver: name => name, runner: (cmd, args) => ({ status: 0, stdout: '[]' }), dryRun: true });
custom.ensureClaudeMarketplace();
assert.equal(custom.planned[0].args[3], 'https://example.invalid/explicit.git');
console.log('Local marketplace and explicit-source override passed.');
