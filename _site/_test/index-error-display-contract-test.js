'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.resolve(__dirname, '../../ui/product.js'), 'utf8');
for (const field of ['upstreamMessage', 'failureKind', 'upstreamCode', 'requestId', 'attempt', 'httpStatus', 'durationMs']) {
  assert.ok(source.includes(`esc(r.error.details.${field}`), `index detail must be escaped: ${field}`);
}
assert.ok(source.includes("['failed', 'index-pending'].includes(r.state)"));
console.log('index-error-display-contract-test PASS (real rendering/export covered by engine test:web:faults)');
