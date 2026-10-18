'use strict';
// K1 knowledge panel contract: the shell registers a same-origin provider with
// the workbench, streams structured references, folds the fixed column only
// after a version-matched panel ack, restores it on any failure, and the panel
// page itself renders external strings through textContent only.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const html = fs.readFileSync(path.join(root, 'ui/index.html'), 'utf8');
const script = fs.readFileSync(path.join(root, 'ui/product.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'ui/product.css'), 'utf8');
const panelPath = path.join(root, 'ui/knowledge-panel.html');
const panelHtml = fs.readFileSync(panelPath, 'utf8');

/* ===================== panel page source contract ===================== */
assert.ok(panelHtml.includes('KB-K1-KNOWLEDGE-PANEL-v1'), 'the panel page shows the stable marker');
assert.ok(panelHtml.includes('event.source !== window.parent'), 'the panel only accepts its Workbench parent as the message source');
assert.ok(panelHtml.includes("data.type !== 'kb:panel/content'"), 'kb:panel/content is the only inbound verb');
assert.ok(panelHtml.includes("'kb:panel/content-ack'"), 'the panel answers with a content ack');
assert.ok(!panelHtml.includes('innerHTML') && !panelHtml.includes('insertAdjacentHTML') && !panelHtml.includes('document.write'), 'no string becomes markup');
assert.ok(!/<(?:script|link|img)[^>]+(?:src|href)=/.test(panelHtml.replace(/<script>[\s\S]*?<\/script>/, '')), 'the panel page loads no external resources');
assert.ok(!panelHtml.includes('fetch(') && !panelHtml.includes('XMLHttpRequest'), 'the sandboxed panel never talks to APIs directly');
const panelScriptMatch = panelHtml.match(/<script>([\s\S]*?)<\/script>/);
assert.ok(panelScriptMatch, 'the panel page carries an inline script');
assert.doesNotThrow(() => new Function(panelScriptMatch[1]));

/* ===================== panel page behavior (minimal DOM) ===================== */
function runPanelPage() {
  const acks = [];
  const node = () => ({ children: [], textContent: '', append(...items) { this.children.push(...items); }, replaceChildren() { this.children.length = 0; } });
  const elements = { panelTitle: node(), panelProject: node(), panelStatus: node(), panelReferences: node(), panelMarker: node() };
  let listener = null;
  const parent = { postMessage(message) { acks.push(message); } };
  const fakeWindow = { parent, addEventListener(type, fn) { if (type === 'message') listener = fn; } };
  const fakeDocument = {
    getElementById: id => elements[id] || null,
    createElement: () => node(),
  };
  new Function('window', 'document', panelScriptMatch[1])(fakeWindow, fakeDocument);
  assert.equal(typeof listener, 'function', 'the panel registers a message listener');
  const deliver = (data, source = parent) => listener({ source, data });
  return { acks, elements, deliver };
}

{
  const page = runPanelPage();
  page.deliver({ type: 'kb:panel/content', panelId: 'tab-1', version: 3, content: {
    title: '本次知识引用', projectId: 'proj-a', status: 'ready',
    references: [{ entryId: 'docs/a.md', title: 'T', text: '<img src=x onerror=alert(1)>', source: 'proj / docs/a.md' }],
  } });
  const ack = page.acks[page.acks.length - 1];
  assert.equal(ack.type, 'kb:panel/content-ack');
  assert.equal(ack.panelId, 'tab-1');
  assert.equal(ack.version, 3);
  assert.equal(ack.ok, true);
  assert.equal(page.elements.panelTitle.textContent, '本次知识引用');
  assert.equal(page.elements.panelProject.textContent, 'proj-a');
  const reference = page.elements.panelReferences.children[0];
  assert.ok(reference, 'one reference card rendered');
  const text = reference.children.find(child => child.textContent.includes('<img'));
  assert.ok(text, 'the reference body exists');
  assert.equal(text.textContent, '<img src=x onerror=alert(1)>', 'markup-looking strings stay inert text');
}
{
  const page = runPanelPage();
  const stranger = { postMessage() {} };
  page.deliver({ type: 'kb:panel/content', panelId: 'tab-1', version: 1, content: { title: 'x' } }, stranger);
  assert.equal(page.acks.length, 0, 'a non-parent source is ignored without any ack');
  page.deliver({ type: 'kb:panel/command', panelId: 'tab-1' });
  assert.equal(page.acks.length, 0, 'non-content verbs are ignored');
  page.deliver({ type: 'kb:panel/content', panelId: 'tab-1', version: 2, content: ['not', 'an', 'object'] });
  const failure = page.acks[page.acks.length - 1];
  assert.equal(failure.ok, false, 'illegal content is refused with an explicit receipt');
  assert.ok(failure.error, 'the refusal carries an error message');
}

/* ===================== shell (product.js) contract ===================== */
assert.ok(script.includes('kb.knowledge.references'), 'the provider id is stable');
assert.match(script, /url: '\/knowledge-panel\.html'/, 'the provider URL is the KB-owned panel page');
assert.match(script, /panelType: 'knowledge', title: '本次知识引用'/, 'panel type and title match the product');
assert.match(script, /capabilities: \['read-only'\]/, 'the panel declares itself read-only');
assert.match(script, /multiInstance: 'single'/, 'the provider is single-instance');
assert.match(script, /if \(message\.type === 'kb:ready'\)[\s\S]*?if \(key === 'terminal'\) void resetKnowledgePanel\(\)/, 'registration starts from the terminal kb:ready');
assert.ok(script.includes("'kb:panel/register'") && script.includes("'kb:panel/open'") && script.includes("'kb:panel/content'"), 'the shell uses the W3 verbs');
assert.match(script, /if \(message\.type === 'kb:knowledge' && key === 'terminal'\)[\s\S]*?renderContext\(\); void pushKnowledgeToPanel/, 'kb:knowledge still refreshes the fixed column first, then streams the panel');
assert.match(script, /const ack = panel\.content\?\.ack;[\s\S]*?if \(ack && String\(ack\.version\) === String\(pending\.version\)\)/, 'collapse waits for the version-matched ack');
assert.match(script, /if \(ack\.ok && !panel\.error\) \{ setKnowledgeCollapsed\(true\)/, 'folding requires an error-free ack');
assert.match(script, /if \(!panel\) \{[\s\S]*?if \(knowledgePanel\.collapsed\) setKnowledgeCollapsed\(false\);[\s\S]*?return;/, 'closing the dock panel unfolds the fixed column again');
assert.match(script, /function knowledgePanelFailed\(reason\)[\s\S]*?setKnowledgeCollapsed\(false\);[\s\S]*?panelNotice\(/, 'every failure path restores the full column with a non-blocking notice');
assert.match(script, /function selectProject\(id\)[\s\S]*?setKnowledgeCollapsed\(false\);[\s\S]*?pushKnowledgeToPanel\(id\)/, 'a project switch re-scopes the panel to the new project before folding again');
assert.match(script, /renderProjectOptions\(\); setKnowledgeCollapsed\(false\); render\(\)/, 'unbinding a project also restores the fixed column');
assert.match(script, /\.slice\(0, 50\)\.map\(r => \(\{/, 'the payload bounds the reference count');
assert.match(script, /text: String\(r\.text \|\| ''\)\.slice\(0, 800\)/, 'the payload bounds reference text');
assert.match(script, /knowledgePayload\(projectId\)[\s\S]*?entryId: String\(/, 'payload fields are coerced to plain strings');
assert.equal((script.match(/classList\.toggle\('kb-panel-collapsed'/g) || []).length, 1, 'collapse is driven only through the work-layout class');
assert.ok(!/data-action="collapse|toggle-context|折叠知识栏/.test(script + html), 'no duplicate column control button is introduced');
assert.match(script, /panelRequest\('kb:panel\/content', \{ panelId: knowledgePanel\.panelId, providerId: knowledgePanel\.providerId, version, content: knowledgePayload\(projectId\) \}\)/, 'content carries panelId, providerId and version');
assert.match(script, /message\.type\.startsWith\('kb:panel\/'\)/, 'panel replies are routed before the frame-context staleness drop');
assert.match(script, /if \(message\.requestId && message\.requestId !== frames\[key\]\.requestId\) return;/, 'the legacy staleness drop stays intact for module traffic');
assert.doesNotThrow(() => new Function(script));

/* ===================== markup and css contract ===================== */
assert.equal((html.match(/id="panelNotice"/g) || []).length, 1, 'exactly one non-blocking panel notice exists');
assert.ok(html.includes('knowledge-context') && html.includes('id="contextContent"'), 'the fixed knowledge column markup is untouched');
assert.ok(css.includes('.work-layout.kb-panel-collapsed{grid-template-columns:minmax(0,1fr) 0px}'), 'the fold animates the grid track instead of removing the column');
assert.match(css, /\.work-layout\{[^}]*transition:grid-template-columns/, 'the fold is a smooth transition');
assert.match(css, /@media \(prefers-reduced-motion: reduce\)\{\.work-layout,\.knowledge-context\{transition:none\}\}/, 'reduced-motion users get no animation');
assert.ok(css.includes('.panel-notice'), 'the notice has styling');
assert.match(css, /\.work-layout\{display:grid;grid-template-columns:minmax\(0,1fr\) 288px/, 'the default full-width column is unchanged');

console.log('knowledge panel UI contract test PASS (source contract + sandboxed render behavior; not browser acceptance)');
