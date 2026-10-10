'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ui = path.resolve(__dirname, '../../ui');
const html = fs.readFileSync(path.join(ui, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(ui, 'product.css'), 'utf8');
const mark = fs.readFileSync(path.join(ui, 'favicon.svg'), 'utf8');
const favicon = html.match(/<link\b(?=[^>]*\brel="icon")[^>]*\bhref="([^"]+)"/);
const sidebar = html.match(/<img\b(?=[^>]*\bclass="brand-mark")[^>]*\bsrc="([^"]+)"/);

assert(favicon, 'Product needs an SVG favicon.');
assert(sidebar, 'Sidebar must use the product mark, not a second drawn icon.');
assert.equal(sidebar[1], favicon[1], 'Favicon and sidebar must share the exact asset URL.');
assert.equal(favicon[1].split('?')[0], '/favicon.svg');
assert.match(favicon[1], /\?v=/, 'Brand changes need a new browser cache identity.');
assert.match(mark, /viewBox="0 0 64 64"/);
assert.match(mark, /fill="#516f89"/);
assert.equal((mark.match(/<path\b/g) || []).length, 1, 'Keep one geometric silhouette.');
assert.doesNotMatch(mark, /<(?:script|image|text|filter|linearGradient|radialGradient)\b/i);
assert.doesNotMatch(html, /<span class="brand-mark">知<\/span>/);
assert.match(css, /\.brand-mark\{[^}]*width:32px;[^}]*height:32px;[^}]*flex:none/);
console.log('PASS product brand: shared SVG, cache identity, fixed-size layout, no decorative dependencies');
