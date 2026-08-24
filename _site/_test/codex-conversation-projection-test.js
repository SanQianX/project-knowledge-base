// Run: node _site/_test/codex-conversation-projection-test.js
//
// Codex Bridge 0.1.1 compatibility: generated rollout context is excluded,
// orphan assistant records are projected onto the latest real user turn, and
// raw append-only events are never rewritten.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  computeConversationExclusions,
  projectCodexTurns,
} = require('../lib/conversation-exclusions');

const projectId = 'project-codex-projection';
const sessionId = 'codex-session';
const base = {
  source: 'codex',
  sessionId,
  rawEventType: 'response_item',
  capturedAt: '2026-08-24T16:06:00.000Z',
};
const event = input => ({ ...base, ...input });
const context = event({
  eventId: 'context', sequence: 1, role: 'user', turnId: 'generated-context',
  content: '<recommended_plugins>generated</recommended_plugins>\n<environment_context>generated</environment_context>',
});
const user = event({ eventId: 'user', sequence: 2, role: 'user', turnId: 'turn-user', content: 'hello' });
const commentary = event({ eventId: 'assistant-1', sequence: 3, role: 'assistant', turnId: null, content: 'Working.' });
const finalReply = event({ eventId: 'assistant-2', sequence: 4, role: 'assistant', turnId: null, content: 'Done.' });
const nextUser = event({ eventId: 'next-user', sequence: 5, role: 'user', turnId: 'turn-next', content: 'Next request.' });
const aborted = event({
  eventId: 'aborted', sequence: 6, role: 'user', turnId: 'generated-abort',
  content: '<turn_aborted>\nThe user interrupted the previous turn.\n</turn_aborted>',
});
const orphan = event({ eventId: 'orphan', sequence: 7, role: 'assistant', turnId: null, sessionId: 'other-session', content: 'No known user.' });
const raw = [orphan, aborted, finalReply, nextUser, context, commentary, user];
const before = JSON.stringify(raw);

const manifest = computeConversationExclusions(projectId, raw);
assert.deepStrictEqual(manifest.excludedEventIds, ['aborted', 'context']);

const projected = projectCodexTurns(raw, manifest.excludedEventIds);
assert.deepStrictEqual(projected.map(item => item.eventId), ['user', 'assistant-1', 'assistant-2', 'next-user', 'orphan']);
assert.deepStrictEqual(
  projected.filter(item => item.eventId.startsWith('assistant-')).map(item => item.turnId),
  ['turn-user', 'turn-user'],
  'all Codex assistant messages in the turn must pair with its real user prompt',
);
assert.strictEqual(projected.find(item => item.eventId === 'user').developmentTurnClosedAtSequence, 5);
assert.strictEqual(projected.find(item => item.eventId === 'next-user').developmentTurnClosedAtSequence, 6);
assert.strictEqual(projected.find(item => item.eventId === 'orphan').turnId, null, 'never pair across Codex sessions');
assert.strictEqual(JSON.stringify(raw), before, 'projection must not rewrite durable source events');

const uiSource = fs.readFileSync(path.resolve(__dirname, '..', '..', 'ui', 'app.js'), 'utf8');
assert(!uiSource.includes('（无用户文本）'), 'UI must not invent a user message for an assistant-only record');
assert(!uiSource.includes('（尚无回复）'), 'UI must not invent an assistant reply for an incomplete turn');

console.log('codex-conversation-projection-test PASS');
