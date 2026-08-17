const assert = require('assert');
const { canonicalRelativePath, validateMarkdown } = require('../lib/knowledge-promotion');

assert.strictEqual(canonicalRelativePath('modules/core.md'), 'modules/core.md');
for (const invalid of ['../outside.md', '/absolute.md', 'modules/00-index.md', 'module.txt', 'CON.md', 'modules/file.md:stream']) {
  assert.throws(() => canonicalRelativePath(invalid), undefined, `unsafe promotion path should fail: ${invalid}`);
}
assert.doesNotThrow(() => validateMarkdown('# Verified fact\n\nEvidence-backed content.\n', 'modules/core.md'));
assert.throws(() => validateMarkdown('# Placeholder\n\nTODO: invent this later.\n', 'modules/core.md'), /placeholder/i);
assert.throws(() => validateMarkdown('# Title\n\n\u0000invalid', 'modules/core.md'), /control/i);
console.log('markdown-maintenance-test: PASS');
