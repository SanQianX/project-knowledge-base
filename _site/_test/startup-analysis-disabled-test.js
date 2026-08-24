const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const server = fs.readFileSync(path.join(root, '_site', 'lib', 'server-app.js'), 'utf8');
const contracts = require('../lib/contracts');
const automation = require('../lib/post-commit-automation');

assert.deepEqual(contracts.TRIGGERS, ['git-hook']);
assert.equal(/reconcileProjectCommits\(projectId, 'startup'/.test(server), false);
assert.equal(server.includes('reconcile.startup_failed'), false);
assert.equal(Object.hasOwn(automation, 'dispatchPendingAutomations'), false);
console.log('startup-analysis-disabled-test PASS');
