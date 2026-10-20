'use strict';
// K1 knowledge panel contract: the shell registers a same-origin provider with
// the workbench, streams structured references only to user-added tabs,
// validates matching receipts, never renders an outside column, and the panel
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
assert.ok(!panelHtml.includes('KB-K1-KNOWLEDGE-PANEL-v1'), 'test contract markers never enter customer markup');
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
    documentElement: { dataset: {} },
    getElementById: id => elements[id] || null,
    createElement: () => node(),
  };
  new Function('window', 'document', panelScriptMatch[1])(fakeWindow, fakeDocument);
  assert.equal(typeof listener, 'function', 'the panel registers a message listener');
  const deliver = (data, source = parent) => listener({ source, data });
  return { acks, elements, deliver, document: fakeDocument };
}

{
  const page = runPanelPage();
  page.deliver({ type: 'kb:panel/content', panelId: 'tab-1', version: 3, content: {
    title: '本次知识引用', projectId: 'proj-a', projectName: '项目 A', status: 'ready', theme: 'dark',
    references: [{ entryId: 'docs/a.md', title: 'T', text: '<img src=x onerror=alert(1)>', source: 'proj / docs/a.md' }],
  } });
  const ack = page.acks[page.acks.length - 1];
  assert.equal(ack.type, 'kb:panel/content-ack');
  assert.equal(ack.panelId, 'tab-1');
  assert.equal(ack.version, 3);
  assert.equal(ack.ok, true);
  assert.equal(page.elements.panelTitle.textContent, '本次知识引用');
  assert.equal(page.elements.panelProject.textContent, '项目 A');
  assert.equal(page.document.documentElement.dataset.theme, 'dark', 'the reference page follows the host theme');
  const reference = page.elements.panelReferences.children[0];
  assert.ok(reference, 'one reference card rendered');
  assert.equal(reference.children.length, 3, 'reference cards show title, source and excerpt without a repeated internal entry identifier');
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
assert.ok(script.includes("'kb:panel/register'") && script.includes("'kb:panel/content'"), 'the host registers the page and supplies its content');
assert.ok(!script.includes("'kb:panel/open'"), 'registration and retrieval cannot open a page');
assert.match(script, /if \(message\.type === 'kb:knowledge' && key === 'terminal'\)[\s\S]*?state\.contexts\.set[\s\S]*?void pushKnowledgeToPanel/, 'retrieved knowledge stays cached and updates existing pages only');
assert.match(script, /const ack = panel\.content\?\.ack;[\s\S]*?if \(ack && String\(ack\.version\) === String\(pending\.version\)\)/, 'receipts match the currently pending content');
assert.match(script, /if \(ack\.ok && !panel\.error\) \{ knowledgePanel\.deliveredPanelId = panel\.panelId;/, 'delivery is confirmed only by an error-free acknowledgement');
assert.match(script, /if \(!panel\) \{[\s\S]*?knowledgePanel\.panelId = '';[\s\S]*?return;/, 'closing a page cancels its delivery');
assert.match(script, /if \(!knowledgePanel\.registered \|\| knowledgePanel\.failed \|\| !projectId \|\| !panelId\) return;/, 'closed pages cannot be opened by background updates');
assert.ok(!/setKnowledgeCollapsed|panelNotice|contextContent|knowledge-context/.test(script), 'the old outside-column paths are removed');
assert.match(script, /\.slice\(0, 50\)\.map\(r => \(\{/, 'the payload bounds the reference count');
assert.match(script, /text: String\(r\.text \|\| ''\)\.slice\(0, 800\)/, 'the payload bounds reference text');
assert.match(script, /knowledgePayload\(projectId\)[\s\S]*?entryId: String\(/, 'payload fields are coerced to plain strings');
assert.ok(!/data-action="collapse|toggle-context|折叠知识栏/.test(script + html), 'no duplicate column control button is introduced');
assert.match(script, /panelRequest\('kb:panel\/content', \{ panelId: knowledgePanel\.panelId, providerId: knowledgePanel\.providerId, version, content: knowledgePayload\(projectId\) \}\)/, 'content carries panelId, providerId and version');
assert.match(script, /message\.type\.startsWith\('kb:panel\/'\)/, 'panel replies are routed before the frame-context staleness drop');
assert.match(script, /if \(message\.requestId && message\.requestId !== frames\[key\]\.requestId\) return;/, 'the legacy staleness drop stays intact for module traffic');
assert.doesNotThrow(() => new Function(script));

/* ===================== markup and css contract ===================== */
assert.ok(!/knowledge-context|contextContent|contextScope|panelNotice/.test(html), 'there is no outside knowledge column, including hidden markup');
assert.ok(!/knowledge-context|kb-panel-collapsed|panel-notice/.test(css), 'no space or fallback layout is reserved for a second column');
assert.match(css, /\.work-layout\{display:grid;grid-template-columns:minmax\(0,1fr\);/, 'the host gives the whole workspace to the conversation and its dock');

console.log('knowledge panel UI contract test PASS (source contract + sandboxed render behavior; not browser acceptance)');
