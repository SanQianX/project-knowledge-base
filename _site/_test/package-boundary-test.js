const assert = require('assert');
const fs = require('fs');
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

// Every local asset referenced by the packaged HTML must be present in the
// tarball. This is deliberately derived from index.html so adding a future
// script, stylesheet, or icon cannot silently produce a broken npm install.
const html = fs.readFileSync(path.join(root, 'ui', 'index.html'), 'utf8');
const referencedAssets = [...html.matchAll(/<(?:script|link)\b[^>]*(?:src|href)="(\/[^"?#]+)(?:[?#][^"]*)?"/gi)]
  .map(match => `ui/${match[1].replace(/^\//, '')}`);
assert(referencedAssets.length > 0, 'ui/index.html must reference packaged assets');
for (const asset of referencedAssets) {
  assert(files.includes(asset), `HTML references an asset missing from the npm package: ${asset}`);
}
console.log('package-boundary-test PASS');
