const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..', '..');
const npmCli = process.env.npm_execpath
  || path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
const result = spawnSync(process.execPath, [npmCli, 'pack', '--dry-run', '--json'], {
  cwd: root,
  encoding: 'utf8',
  windowsHide: true,
});

assert.strictEqual(result.status, 0, result.stderr || result.stdout);
const report = JSON.parse(result.stdout);
const files = report[0].files.map(entry => entry.path.replace(/\\/g, '/'));
const forbidden = [
  'docs/project-knowledge-base-review-deliverables.zip',
  'docs/project-knowledge-base-review-deliverables/',
  'docs/project-knowledge-base-pro-review-prompt.md',
  'docs/knowledge-base-trigger-refactor-plan.md',
  'docs/log-ui-comparison.html',
  'ui/claude-workspace-preview.html',
];
for (const candidate of forbidden) {
  assert(!files.some(file => candidate.endsWith('/') ? file.startsWith(candidate) : file === candidate), `local review artifact leaked into npm package: ${candidate}`);
}
assert(files.includes('docs/README.zh-CN.md'));
assert(files.includes('ui/index.html'));
console.log('package-boundary-test PASS');
