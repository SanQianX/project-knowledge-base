'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const input = JSON.parse(fs.readFileSync(0, 'utf8'));
assert.equal(input.schema, 'ai-team-maintenance/v1');
assert.equal(fs.realpathSync(input.workspace), fs.realpathSync(process.cwd()));
assert.equal(typeof input.member.instructions, 'string');
assert.equal(process.env.KB_WORKFLOW_RUNTIME_TOKEN, undefined);
assert.equal(process.env.GIT_DIR, undefined);
const mode = process.argv[2];

switch (mode) {
  case 'check':
    assert.equal(input.phase, 'check');
    assert.deepEqual(input.member.memoryGroupIds, ['group-code']);
    if (fs.readFileSync('policy.txt', 'utf8').trim() !== 'PASS') {
      console.log(JSON.stringify({ path: 'policy.txt', expected: 'PASS' }));
      process.exitCode = 1;
    }
    break;
  case 'repair':
    assert.equal(input.phase, 'repair');
    assert.equal(JSON.parse(input.findings.stdout.text).path, 'policy.txt');
    fs.writeFileSync('policy.txt', 'PASS\n');
    break;
  case 'format':
    assert.equal(input.phase, 'apply');
    fs.writeFileSync('formatted.txt', 'one line\n');
    console.log('format completed');
    break;
  case 'docs':
    assert.equal(input.phase, 'apply');
    assert.ok(fs.existsSync('formatted.txt'), 'docs reads the updated remote baseline');
    fs.mkdirSync('docs', { recursive: true });
    fs.writeFileSync(path.join('docs', 'usage.md'), '# Formatted repository\n');
    break;
  case 'reject':
    console.log('Additional fixes required');
    process.exitCode = 1;
    break;
  case 'stubborn':
    fs.writeFileSync('unresolved.txt', 'Keep this after failed review\n');
    break;
  case 'timeout':
    fs.writeFileSync('timed-out.txt', 'Keep this after timeout\n');
    setTimeout(() => {}, 10_000);
    break;
  case 'record':
    fs.writeFileSync('push-permission.txt', 'This candidate should stay local\n');
    break;
  default:
    throw new Error('Unknown fixture tool action.');
}
