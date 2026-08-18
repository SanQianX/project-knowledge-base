const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const html = fs.readFileSync(path.join(ROOT, 'ui', 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(ROOT, 'ui', 'app.js'), 'utf8');
const server = fs.readFileSync(path.join(ROOT, '_site', 'lib', 'server-app.js'), 'utf8');

assert.strictEqual((html.match(/class="shell"/g) || []).length, 1, 'production UI must have one full product shell');
assert.strictEqual((html.match(/id="settings-logs"/g) || []).length, 1, 'production UI must have one Settings logs section');
assert(html.includes('id="view-workbench"') && html.includes('id="view-import"'), 'Workbench and Import must remain reachable');

const forbiddenUi = [
  /\/api\/projects\/[^"' ]+\/hook/,
  /\/api\/projects\/[^"' ]+\/analy/,
  /\/api\/projects\/[^"' ]+\/scan/,
  /\/api\/projects\/[^"' ]+\/init/,
  /simulate/i,
  /installHook\s*\(/,
  /uninstallHook\s*\(/,
  /reinstallHook\s*\(/,
  /manual analysis/i,
];
for (const pattern of forbiddenUi) assert(!pattern.test(html + app), 'removed manual automation control/call remains: ' + pattern);

for (const route of [
  '/api/projects/:projectId/hook/install',
  '/api/projects/:projectId/hook/uninstall',
  '/api/projects/:projectId/analyze/initial',
  '/api/projects/:projectId/analyze/incremental',
  '/api/projects/:projectId/simulate',
]) {
  assert(!server.includes(route), 'removed backend route remains: ' + route);
}

assert(!html.includes('vue.global.prod.js'), 'product shell must not require the old Vue runtime');
assert(!html.includes('tailwind-browser.js'), 'product shell must not require the old browser Tailwind runtime');

console.log('automation UI test PASS');
