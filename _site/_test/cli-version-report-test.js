'use strict';
// `project-knowledge --version` is a one-shot inventory: the core version,
// the instance state, and one line per pinned runtime module with a live or
// installed version. Assertions keep the report complete even when no
// instance is running (CI).

const { spawnSync } = require('child_process');
const path = require('path');
const assert = require('assert/strict');

const result = spawnSync(process.execPath, [path.join(__dirname, '..', '..', 'bin', 'project-knowledge.js'), '--version'], { encoding: 'utf8', timeout: 30_000 });
assert.equal(result.status, 0, `--version exited ${result.status}: ${result.stderr}`);
const out = result.stdout;
assert.match(out, /^project-knowledge \d+\.\d+\.\d+/, 'core version line');
assert.match(out, /instance: (running at http|not running)/, 'instance line');
for (const label of ['Workbench (terminal)', 'vector-hub', 'event-bridge', 'knowledge-engine', 'workflow']) {
  const line = out.split('\n').find(l => l.trim().startsWith(label));
  assert.ok(line, `module line for ${label} present`);
  assert.match(line, /\d+\.\d+\.\d+/, `${label} carries a version`);
  assert.match(line, /\[(live|installed)\]/, `${label} carries a source tag`);
}
console.log('cli-version-report-test PASS');
