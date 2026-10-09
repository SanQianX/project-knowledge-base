'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const html = fs.readFileSync(path.join(root, 'ui/index.html'), 'utf8');
const script = fs.readFileSync(path.join(root, 'ui/product.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'ui/product.css'), 'utf8');
for (const view of ['home', 'work', 'search', 'memory', 'projects', 'activity']) {
  assert.equal((html.match(new RegExp(`data-view="${view}"`, 'g')) || []).length, 1);
  assert.ok(html.includes(`id="view-${view}"`));
}
assert.equal((html.match(/data-view=/g) || []).length, 6, 'diagnostics must not become another primary product');
for (const id of ['workFrame', 'vectorFrame', 'bridgeFrame', 'engineFrame', 'importDialog', 'importCode', 'importKnowledge', 'importDomain', 'setupImportRoot', 'createDomain', 'logsDialog', 'systemDrawer', 'copyReference']) assert.equal((html.match(new RegExp(`id="${id}"`, 'g')) || []).length, 1);
assert.ok(html.includes('data-action="import"') && html.includes('不分析全部历史'));
assert.ok(!html.includes('srcdoc') && !/data-simulate|data-analyze|data-install-hook/.test(html));
assert.equal((script.match(/\.src = /g) || []).length, 1, 'frames initialize once, not on project/theme/page changes');
for (const contract of ['kb:theme', 'kb:select-project', 'kb:scope', 'kb:knowledge', 'kb:ready']) assert.ok(script.includes(contract));
assert.ok(script.includes('event.origin !== location.origin') && script.includes('contentWindow === event.source'), 'module messages must be from the expected frame and origin');
assert.ok(script.includes('state.epoch++') && script.includes('referenceEpoch') && script.includes('logEpoch'), 'late project/reference/log feedback must be isolated');
assert.ok(script.includes('esc(r.title)') && script.includes('esc(m.text)') && script.includes('esc(project.name)'));
assert.ok(script.includes('text.textContent = record.message') && script.includes("'logs/appended'"), 'diagnostics stay inert and stream live');
assert.ok(script.includes('URL.revokeObjectURL(url)') && script.includes('logStream?.close()'));
assert.ok(script.includes('resumeImport = true') && script.includes("$('importDialog').showModal()") && script.includes("p.code === 'KNOWLEDGE_ROOT_MISSING'"), 'first import can return from setup without resetting its input');
assert.ok(css.includes('height:100%') && css.includes('.view.module-view{padding:0;overflow:hidden}') && css.includes('overflow-wrap:anywhere'));
assert.ok(css.includes('html[data-theme=dark]') && css.includes('prefers-reduced-motion'));
assert.doesNotThrow(() => new Function(script));
console.log('workspace UI contract test PASS (source contract; not browser acceptance)');
