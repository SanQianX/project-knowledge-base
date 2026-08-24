const assert = require('assert');
const automation = require('../lib/post-commit-automation');

// Pending repository scans are not a recovery mechanism. A Hook event is the
// only authority that can request analysis.
assert.equal(Object.hasOwn(automation, 'dispatchPendingAutomations'), false);
assert.equal(Object.hasOwn(automation, 'getQueueSize'), false);
assert.equal(Object.hasOwn(automation, 'drainQueue'), false);
console.log('pending-sweep-test PASS');
