const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const ui = fs.readFileSync(path.join(ROOT, 'ui', 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(ROOT, 'ui', 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'ui', 'app.css'), 'utf8');
const preload = fs.readFileSync(path.join(ROOT, 'desktop', 'preload.cjs'), 'utf8');
const main = fs.readFileSync(path.join(ROOT, 'desktop', 'main.cjs'), 'utf8');
const runtime = require(path.join(ROOT, 'desktop', 'lib', 'backend-runtime.cjs'));

assert(ui.includes('<script src="/app.js"></script>'), 'product shell script is missing');
assert.doesNotThrow(() => new Function(app), 'product shell must parse in the desktop Chromium runtime');
assert(!app.includes('window.open('), 'product shell must not open untrusted browser windows');
assert(!(ui + app).includes('file://'), 'product shell must not expose local file URLs');
assert(app.includes('URL.createObjectURL(blob)') && app.includes('URL.revokeObjectURL(url)'), 'diagnostic export must use a bounded blob URL');
assert(app.includes('navigator.clipboard') && app.includes("document.execCommand('copy')"), 'copy must have a desktop-compatible fallback');
assert(css.includes('@media(prefers-reduced-motion:reduce)'), 'reduced-motion compatibility is required');
assert(css.includes('@media(max-width:820px)'), 'desktop narrow-window layout is required');

assert(preload.includes('project-knowledge:open-external') && preload.includes('openExternal:'), 'desktop preload bounded external-link bridge regressed');
assert(main.includes('externalLink.registerExternalLink'), 'desktop main external-link policy regressed');
assert(runtime.isAllowedExternalUrl('https://github.com/login/device'), 'HTTPS authorization URL policy regressed');
assert(!runtime.isAllowedExternalUrl('file:///C:/Users/test/token.txt'), 'local files must not cross the desktop boundary');
assert(!runtime.isAllowedExternalUrl('javascript:alert(1)'), 'script URLs must not cross the desktop boundary');

console.log('desktop browser compatibility test PASS');
