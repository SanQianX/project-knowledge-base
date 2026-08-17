const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const html = fs.readFileSync(path.join(ROOT, 'ui', 'index.html'), 'utf8');
const server = fs.readFileSync(path.join(ROOT, '_site', 'lib', 'server-app.js'), 'utf8');

assert.strictEqual((html.match(/data-logging-app/g) || []).length, 1, 'production UI must have one logging application root');
assert.strictEqual((html.match(/data-log-table/g) || []).length, 1, 'production UI must have one log render table');
assert.strictEqual((html.match(/var state\s*=/g) || []).length, 1, 'logging UI must have one root state');
assert(html.includes('data-hook-readonly'), 'managed Hook state must remain visible as read-only status');

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
for (const pattern of forbiddenUi) assert(!pattern.test(html), 'removed manual automation control/call remains: ' + pattern);

for (const route of [
  '/api/projects/:projectId/hook/install',
  '/api/projects/:projectId/hook/uninstall',
  '/api/projects/:projectId/analyze/initial',
  '/api/projects/:projectId/analyze/incremental',
  '/api/projects/:projectId/simulate',
]) {
  assert(!server.includes(route), 'removed backend route remains: ' + route);
}

assert(!html.includes('vue.global.prod.js'), 'focused logging page must not retain the old Vue dashboard');
assert(!html.includes('tailwind-browser.js'), 'focused logging page must not require the old browser Tailwind runtime');

console.log('automation UI test PASS');
