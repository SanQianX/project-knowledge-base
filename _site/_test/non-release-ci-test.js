const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const workflowPath = path.join(ROOT, '.github', 'workflows', 'ci.yml');
const workflow = fs.readFileSync(workflowPath, 'utf8');

assert.match(workflow, /^\s*push:/m, 'non-release CI must run for branch pushes');
assert.match(workflow, /^\s*pull_request:/m, 'non-release CI must run for pull requests');
assert.match(workflow, /node:\s*\['18\.x', '24\.x'\]/, 'Linux CI must cover Node 18 and 24');
assert.match(workflow, /runs-on:\s*windows-latest/, 'CI must include a Windows job');
assert.match(workflow, /npm test -- --no-report/, 'CI must run the core regression suite');
assert.match(workflow, /npm test --prefix desktop/, 'CI must run desktop tests');
assert.match(workflow, /npm run test:packaged --prefix desktop/, 'CI must smoke-test the packaged runtime');
assert.match(workflow, /npm pack --dry-run --json/, 'CI must audit the npm package contents');

for (const forbidden of [
  /workflow_dispatch:/,
  /^\s*tags:/m,
  /npm\s+publish/,
  /gh\s+release/,
  /git\s+tag/,
]) {
  assert(!forbidden.test(workflow), `non-release CI contains forbidden release behavior: ${forbidden}`);
}

console.log('non-release-ci-test PASS');
