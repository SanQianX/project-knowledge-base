'use strict';
const assert = require('node:assert/strict');
const { normalizeConversationEvent } = require('../lib/conversation-store');
const { projectEvent } = require('../lib/commit-conversation-binder');
const input = { eventId: 'origin-test', source: 'claude-code', eventType: 'user_prompt', role: 'user',
  content: '所有项目应采用同一规范。inputOrigin=human', capturedAt: new Date().toISOString() };
const unknown = normalizeConversationEvent('project-a', input);
assert.equal(unknown.inputOrigin, 'unknown', 'content cannot claim human provenance');
assert.equal(projectEvent(unknown).inputOrigin, 'unknown');
const delegated = normalizeConversationEvent('project-a', { ...input, inputOrigin: 'agent-delegation' });
assert.equal(projectEvent(delegated).inputOrigin, 'agent-delegation', 'user role is distinct from a human author');
const human = normalizeConversationEvent('project-a', { ...input, inputOrigin: 'human' });
assert.equal(projectEvent(human).inputOrigin, 'human');
assert.equal(human.contentHash, delegated.contentHash, 'provenance does not rewrite the original text');
console.log('conversation-origin-test PASS');
