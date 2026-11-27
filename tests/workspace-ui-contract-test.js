'use strict';
// The shell owns the primary navigation and embeds Workbench and Workflow.
// Both provider-management entry points open the same Workbench page.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = require("./paths").ROOT;
const html = fs.readFileSync(path.join(root, 'resources/ui/index.html'), 'utf8');
const script = fs.readFileSync(path.join(root, 'resources/ui/product.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'resources/ui/product.css'), 'utf8');
const primaryViews = ['home', 'work', 'team', 'memory', 'projects', 'search', 'activity'];
for (const view of primaryViews) {
  assert.equal((html.match(new RegExp(`data-view="${view}"`, 'g')) || []).length, 1);
  assert.ok(html.includes(`id="view-${view}"`));
}
assert.equal((html.match(/data-view=/g) || []).length, primaryViews.length, 'diagnostics stay outside the primary navigation');
const navOrder = [...html.matchAll(/data-view="([^"]+)"/g)].map(m => m[1]);
assert.deepEqual(navOrder, primaryViews, 'the primary navigation order is fixed');
// The AI team page is an embedded module surface, not shell business code:
// an iframe mount plus the /workflow-ui/ proxy, and nothing else in shell UI.
assert.match(html, /<section[^>]*id="view-team"[^>]*>\s*<div class="frame-container"><iframe id="workflowFrame"/, 'team view is a module iframe mount');
assert.match(script, /workflow: \{ id: 'workflowFrame', url: '\/workflow-ui\/\?embed=1&apiBase=\/api\/workflow'/, 'the team frame targets the workflow-ui proxy');
assert.match(html, /<section class="view module-view" id="view-work">[\s\S]*?id="workProviders"[\s\S]*?<iframe id="workFrame"/, 'Start Work contains its provider shortcut and iframe');
assert.match(script, /terminal: \{ id: 'workFrame'[^}]*view: 'work'/, 'the Workbench frame belongs to Start Work');
assert.match(script, /if \(view === 'work'\) initializeFrame\('terminal'\)/, 'Start Work lazily loads Workbench');
assert.match(script, /on\('openSystem', 'click', openSystem\)/, 'the system drawer opens from the sidebar');
assert.match(script, /function openWorkbenchProviders\(\)[\s\S]*?setView\('work'\)[\s\S]*?kb:open-settings/, 'provider management opens Workbench settings in the visible page');
for (const trigger of ['workProviders', 'configureProviders']) assert.ok(script.includes("on('" + trigger + "', 'click', openWorkbenchProviders)"));
assert.match(html, /<select\b[^>]*id="projectSelect"[^>]*\bdisabled\b/, 'project selection is disabled until the initial registry snapshot has loaded');
for (const id of ['workFrame', 'workProviders', 'bridgeFrame', 'engineFrame', 'importDialog', 'importCode', 'importKnowledge', 'importDomain', 'setupImportRoot', 'createDomain', 'logsDialog', 'systemDrawer', 'openSystem', 'configureProviders', 'repairWiring', 'appDialog', 'unbindDialog', 'referenceDialog', 'copyReference']) assert.equal((html.match(new RegExp(`id="${id}"`, 'g')) || []).length, 1);
// Legacy one-frame-per-surface elements must not come back.
for (const gone of ['vectorFrame', 'projectTree', 'projectDetail']) assert.ok(!html.includes(`id="${gone}"`), `#${gone} was removed with the five-page UI`);
assert.ok(html.includes('data-action="import"') && html.includes('不分析全部历史'));
assert.ok(!html.includes('srcdoc') && !/data-simulate|data-analyze|data-install-hook/.test(html));
assert.equal((script.match(/\.src = /g) || []).length, 1, 'frames initialize once, not on project/theme/page changes');
for (const contract of ['kb:theme', 'kb:select-project', 'kb:visibility', 'kb:knowledge', 'kb:ready', 'kb:open-settings']) assert.ok(script.includes(contract));
assert.ok(script.includes('event.origin !== location.origin') && script.includes('contentWindow === event.source'), 'module messages must be from the expected frame and origin');
assert.ok(script.includes('state.epoch++') && script.includes('referenceEpoch') && script.includes('logEpoch'), 'late project/reference/log feedback must be isolated');
assert.match(script, /on\('domainForm'[\s\S]*?await refreshRegistry\(true\)/, 'domain writes must invalidate pre-mutation reads');
assert.match(script, /registered = true;[\s\S]*?await refreshRegistry\(true\)/, 'import must not reuse a pre-import snapshot');
assert.ok(script.includes("title: String(r.title || r.entryId || '')") && script.includes('esc(memory.text)') && script.includes('esc(clamp2(m.text)') && script.includes('esc(project.name)'));
assert.ok(script.includes('text.textContent = record.message') && script.includes("'logs/appended'"), 'diagnostics stay inert and stream live');
assert.ok(script.includes('URL.revokeObjectURL(url)') && script.includes('logStream?.close()'));
assert.ok(script.includes('resumeImport = true') && script.includes("$('importDialog').showModal()") && script.includes("p.code === 'KNOWLEDGE_ROOT_MISSING'"), 'first import can return from setup without resetting its input');
assert.ok(css.includes('height:100%') && css.includes('.view.module-view{padding:0;overflow:hidden}') && css.includes('overflow-wrap:anywhere'));
assert.ok(css.includes('html[data-theme=dark]') && css.includes('prefers-reduced-motion'));
assert.doesNotThrow(() => new Function(script));
console.log('workspace UI contract test PASS (source contract; not browser acceptance)');
