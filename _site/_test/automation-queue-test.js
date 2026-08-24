// Run: node _site/_test/automation-queue-test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const automation = require('../lib/post-commit-automation');

(() => {
  assert.strictEqual(fs.existsSync(path.join(__dirname, '..', 'lib', 'automation-queue.js')), false, 'legacy in-memory automation queue must be deleted');
  assert.strictEqual(fs.existsSync(path.join(__dirname, '..', 'lib', 'commit-automation-store.js')), false, 'legacy commit automation state must not remain a second pending authority');
  assert.strictEqual(typeof automation.reconcileProjectCommits, 'function', 'Git-backed reconciler should be the single automation authority');
  assert.strictEqual(Object.hasOwn(automation, 'dispatchPendingAutomations'), false, 'startup must not dispatch pending commit analysis');
  console.log('automation-queue-test PASS');
})();
