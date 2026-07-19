const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const ui = fs.readFileSync(path.join(ROOT, '_site', 'index.html'), 'utf-8');
const preload = fs.readFileSync(path.join(ROOT, 'desktop', 'preload.cjs'), 'utf-8');
const main = fs.readFileSync(path.join(ROOT, 'desktop', 'main.cjs'), 'utf-8');
const runtime = require(path.join(ROOT, 'desktop', 'lib', 'backend-runtime.cjs'));

assert(ui.includes('desktop.openExternal(target)'),
  'OAuth UI should use the acknowledged desktop external-link bridge');
assert(!/authorizationUrl\)\s*window\.open/.test(ui) && !/verificationUri\)\s*window\.open/.test(ui),
  'GitHub and Gitea OAuth must not call window.open directly');
assert(preload.includes("project-knowledge:open-external") && preload.includes('openExternal:'),
  'desktop preload should expose only the bounded external-link operation');
assert(main.includes('externalLink.registerExternalLink'),
  'desktop main process should own system-browser opening');
assert(runtime.isAllowedExternalUrl('https://github.com/login/device'),
  'GitHub authorization URLs should be accepted');
assert(runtime.isAllowedExternalUrl('http://gitea.internal/login/oauth/authorize'),
  'HTTP intranet Gitea authorization URLs should be accepted');
assert(!runtime.isAllowedExternalUrl('file:///C:/Users/test/token.txt'),
  'local files must not cross the desktop browser boundary');
assert(!runtime.isAllowedExternalUrl('javascript:alert(1)'),
  'script URLs must not cross the desktop browser boundary');

console.log('desktop browser compatibility test passed');
