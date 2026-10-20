'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../../ui/product.js'), 'utf8');
const lifecycle = source.slice(source.indexOf('  function knowledgePanelFailed('), source.indexOf('  function panelRequest('))
  + source.slice(source.indexOf('  async function resetKnowledgePanel('), source.indexOf('  function setView('));
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };
function harness(options = {}) {
  const calls = [], notices = [], timers = new Map();
  const panel = { providerId: 'knowledge', registered: true, registering: false, failed: false, error: null, panelId: '', version: 0, pending: null, sending: null, queued: false, deliveredPanelId: '' };
  const state = { projectId: 'project-a', epoch: 0 };
  let serial = 0, context;
  const deliver = (id, content = null, error = null) => context.handlePanelState({ panels: id ? [{ providerId: 'knowledge', panelId: id, content, error }] : [] });
  context = vm.createContext({
    knowledgePanel: panel, state, frames: { terminal: { ready: true } },
    knowledgePayload: id => ({ projectId: id, references: [{ title: state.reference || id + '-fact' }] }),
    toast: text => notices.push(text),
    setTimeout(fn) { timers.set(++serial, fn); return serial; }, clearTimeout: id => timers.delete(id),
    panelRequest: async (type, payload) => {
      calls.push({ type, payload });
      if (options.request) {
        const response = options.request(type, payload, { deliver, panel, state });
        if (response !== undefined) return response;
      }
      if (type === 'kb:panel/register') return { ok: true };
      if (type === 'kb:panel/content') {
        deliver(payload.panelId, { ack: { version: payload.version, ok: true } });
        return { ok: true };
      }
      throw new Error('Knowledge delivery cannot open, activate or unregister a view: ' + type);
    },
  });
  vm.runInContext(lifecycle, context);
  const show = async id => { deliver(id); await settle(); };
  return { context, panel, state, calls, notices, timers, deliver, show };
}

test('startup registration and cached updates never create a knowledge tab', async () => {
  const h = harness();
  await h.context.resetKnowledgePanel();
  assert.equal(h.panel.registered, true);
  assert.equal(h.panel.panelId, '');
  await h.context.pushKnowledgeToPanel();
  h.state.projectId = 'project-b'; h.state.epoch++;
  await h.context.pushKnowledgeToPanel();
  assert.deepEqual(h.calls.map(call => call.type), ['kb:panel/register']);
  assert.equal(h.timers.size, 0);
});

test('user-added tabs receive content and fast acknowledgements without opening another view', async () => {
  const h = harness();
  await h.show('tab-1');
  assert.equal(h.panel.pending, null);
  assert.equal(h.panel.deliveredPanelId, 'tab-1');
  assert.equal(h.timers.size, 0);
  assert.deepEqual(h.calls.map(call => call.type), ['kb:panel/content']);
});

test('closing keeps cached updates invisible until the user adds the page again', async () => {
  const h = harness();
  await h.show('tab-1');
  h.deliver(null);
  h.state.reference = 'updated while closed';
  await h.context.pushKnowledgeToPanel();
  assert.equal(h.panel.panelId, '');
  assert.equal(h.calls.length, 1, 'closing or receiving knowledge must not create another view');
  await h.show('tab-2');
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[1].payload.panelId, 'tab-2');
  assert.equal(h.calls[1].payload.content.references[0].title, 'updated while closed');
  assert.equal(h.panel.deliveredPanelId, 'tab-2');
  h.deliver('tab-2', { ack: { version: h.panel.version, ok: true } });
  await settle();
  assert.equal(h.calls.length, 2, 'focus and repeated receipts cannot create a delivery loop');
});

test('errors never create an outside fallback and a newly added page can retry', async () => {
  let first = true;
  const h = harness({ request(type) {
    if (type === 'kb:panel/content' && first) { first = false; return { ok: false }; }
  } });
  await h.show('tab-1');
  assert.equal(h.panel.failed, true);
  assert.equal(h.panel.registered, true, 'the page remains available in the dock selector');
  assert.match(h.notices.join(' '), /关闭引用标签/);
  assert.deepEqual(h.calls.map(call => call.type), ['kb:panel/content']);
  h.deliver(null);
  await h.show('tab-2');
  assert.equal(h.panel.failed, false);
  assert.equal(h.panel.deliveredPanelId, 'tab-2');
});

test('closing during a content transfer makes late replies inert', async () => {
  let reply;
  const h = harness({ request(type) {
    if (type === 'kb:panel/content') return new Promise(resolve => { reply = resolve; });
  } });
  await h.show('tab-1');
  h.deliver(null);
  reply({ ok: true });
  await settle();
  assert.equal(h.panel.panelId, '');
  assert.equal(h.panel.pending, null);
  assert.equal(h.timers.size, 0);
  assert.equal(h.calls.length, 1);
});

test('an older failed acknowledgement cannot close the current reference view', async () => {
  const h = harness({ request(type) { if (type === 'kb:panel/content') return { ok: true }; } });
  await h.show('tab-1');
  await h.context.pushKnowledgeToPanel();
  const version = h.panel.pending.version;
  h.deliver('tab-1', { ack: { version: version - 1, ok: false } }, 'CONTENT_ACK_ERROR');
  await settle();
  assert.equal(h.panel.pending.version, version);
  assert.equal(h.panel.failed, false);
  assert.equal(h.calls.length, 2);
  h.deliver('tab-1', { ack: { version, ok: true } });
  assert.equal(h.panel.deliveredPanelId, 'tab-1');
});

test('a queued project switch sends only the latest scope and rejects a stale acknowledgement', async () => {
  let oldReply;
  const h = harness({ request(type, payload) {
    if (type === 'kb:panel/content' && payload.content.projectId === 'project-a') return new Promise(resolve => { oldReply = resolve; });
  } });
  await h.show('tab-1');
  h.state.projectId = 'project-b'; h.state.epoch++;
  await h.context.pushKnowledgeToPanel();
  h.deliver('tab-1', { ack: { version: 1, ok: true } });
  assert.equal(h.panel.deliveredPanelId, '');
  oldReply({ ok: true });
  await settle();
  assert.deepEqual(h.calls.map(call => call.payload.content.projectId), ['project-a', 'project-b']);
  assert.equal(h.panel.deliveredPanelId, 'tab-1');
  assert.equal(h.panel.pending, null);
});

test('restored inactive reference tabs wait for their page to load before content delivery', async () => {
  const h = harness();
  await h.context.resetKnowledgePanel();
  h.context.handlePanelState({ panels: [{ providerId: 'knowledge', panelId: 'restored', ready: false }] });
  await h.context.pushKnowledgeToPanel(); await settle();
  assert.deepEqual(h.calls.map(call => call.type), ['kb:panel/register']);
  assert.equal(h.panel.failed, false);
  assert.equal(h.timers.size, 0);
  h.context.handlePanelState({ panels: [{ providerId: 'knowledge', panelId: 'restored', ready: true }] });
  await settle();
  assert.deepEqual(h.calls.map(call => call.type), ['kb:panel/register', 'kb:panel/content']);
  assert.equal(h.panel.deliveredPanelId, 'restored');
});
