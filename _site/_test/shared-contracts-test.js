const assert = require('assert');
const contracts = require('../lib/contracts');

assert.deepStrictEqual(contracts.TRIGGERS, ['git-hook', 'startup']);
assert.deepStrictEqual(contracts.LOG_LEVELS, ['trace', 'debug', 'info', 'warn', 'error', 'fatal']);
assert.strictEqual(contracts.SCHEMAS.projectState, 'project-state/v2');
assert.strictEqual(contracts.SCHEMA_VERSIONS.layoutMigration, 'layout-v2');

for (const trigger of contracts.TRIGGERS) assert.strictEqual(contracts.validateTrigger(trigger), trigger);
assert.throws(() => contracts.validateTrigger('simulate'), error => error.code === 'INVALID_TRIGGER');
assert.throws(() => contracts.validateTrigger('project-init'), error => error.code === 'INVALID_TRIGGER');

const publicProfile = contracts.publicAiProfileView({
  id: 'primary',
  name: 'Primary',
  apiKey: 'sk-super-secret-1234',
  authToken: 'second-secret',
  baseUrl: 'https://example.invalid',
});
assert.strictEqual(publicProfile.id, 'primary');
assert.strictEqual(publicProfile.baseUrl, 'https://example.invalid');
assert.strictEqual(publicProfile.hasApiKey, true);
assert.strictEqual(publicProfile.apiKeyMasked, '****1234');
assert.strictEqual(Object.prototype.hasOwnProperty.call(publicProfile, 'apiKey'), false);
assert.strictEqual(Object.prototype.hasOwnProperty.call(publicProfile, 'authToken'), false);

const domainError = new contracts.DomainError('HOOK_CONFLICT', 'A non-managed hook exists.', {
  status: 409,
  operationId: 'op-test',
  details: {
    apiKey: 'must-not-leak',
    stack: 'must-not-leak',
    nested: { authorization: 'Bearer must-not-leak', safe: 'kept' },
  },
});
const envelope = contracts.serializeErrorEnvelope(domainError);
const serialized = JSON.stringify(envelope);
assert.strictEqual(envelope.ok, false);
assert.strictEqual(envelope.error.code, 'HOOK_CONFLICT');
assert.strictEqual(envelope.error.operationId, 'op-test');
assert(!serialized.includes('must-not-leak'));
assert(!serialized.includes('stack'));
assert(serialized.includes('kept'));

assert.strictEqual(contracts.validateStateTransition('idle', 'scanning'), true);
assert.strictEqual(contracts.validateStateTransition('markdown.promoted', 'state.advanced'), true);
assert.throws(() => contracts.validateStateTransition('idle', 'markdown.promoted'));

assert.strictEqual(contracts.assertMutableProjectPatch({ displayName: 'New', enabled: false }), true);
assert.throws(() => contracts.assertMutableProjectPatch({ projectId: 'new' }), error => error.code === 'IMMUTABLE_FIELD');
assert.throws(() => contracts.assertMutableProjectPatch({ knowledgePath: 'D:/new' }), error => error.code === 'IMMUTABLE_FIELD');
assert.strictEqual(contracts.assertMutableProjectPatch({ knowledgePath: 'D:/new' }, { allowKnowledgePath: true }), true);
assert.throws(() => contracts.assertMutableProjectPatch({ repoPath: 'D:/moved' }), error => error.code === 'INVALID_ARGUMENT');
assert.strictEqual(contracts.assertMutableProjectPatch({ repoPath: 'D:/moved' }, { allowRepoPath: true }), true);
assert.throws(() => contracts.assertMutableProjectPatch({ teamBinding: {} }), error => error.code === 'INVALID_ARGUMENT');

console.log('shared-contracts-test PASS');
