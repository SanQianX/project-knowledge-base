// Run: node _site/_test/requirement-binding-test.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SCHEMAS } = require('../lib/contracts');
const { StorageLayout } = require('../lib/storage-layout');
const { ProjectRegistryStore } = require('../lib/project-registry-store');
const { ProjectStore } = require('../lib/project-store');
const { RequirementBinder } = require('../lib/requirement-binder');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), `kb-requirement-binding-${process.pid}-`));
const layout = new StorageLayout({ dataDir: path.join(temp, 'data') });
const registry = new ProjectRegistryStore({ layout });
const projects = new ProjectStore({ layout });
const commit = 'c'.repeat(40);

function record(id, projectId, sessionId, head, options = {}) {
  return {
    schema: SCHEMAS.requirement,
    id,
    ts: options.ts || '2026-08-17T00:00:00.000Z',
    projectId,
    client: options.client || 'codex',
    sessionId,
    conversationId: null,
    branch: options.branch || 'main',
    headAtRecord: head,
    requirement: `Requirement ${id}`,
    requirementHash: `sha256:${id}`,
    explicitCommit: options.explicitCommit || null,
  };
}

(async () => {
  await registry.initialize();
  for (const projectId of ['project-a', 'project-b']) {
    const repoPath = path.join(temp, projectId);
    fs.mkdirSync(repoPath, { recursive: true });
    await projects.create(projectId, {
      storageName: projectId,
      displayName: projectId,
      repoPath,
      knowledgePath: path.join(temp, 'knowledge', projectId),
    });
    await registry.add(projectId, { displayName: projectId });
  }
  await projects.appendRequirement('project-a', record('req-a1', 'project-a', 'session-one', 'a'.repeat(40), { ts: '2026-08-17T00:00:01.000Z' }));
  await projects.appendRequirement('project-a', record('req-a2', 'project-a', 'session-one', 'b'.repeat(40), { ts: '2026-08-17T00:00:02.000Z' }));
  await projects.appendRequirement('project-a', record('req-a3', 'project-a', 'session-two', 'd'.repeat(40)));
  await projects.appendRequirement('project-a', record('req-branch', 'project-a', 'session-one', 'e'.repeat(40), { branch: 'feature' }));
  await projects.appendRequirement('project-a', record('req-future', 'project-a', 'session-one', 'f'.repeat(40)));
  await projects.appendRequirement('project-a', record('req-explicit-commit', 'project-a', 'session-three', '9'.repeat(40), { explicitCommit: '8'.repeat(40) }));
  await projects.appendRequirement('project-b', record('req-other-project', 'project-b', 'session-one', 'a'.repeat(40)));

  const ancestry = new Set(['a'.repeat(40), 'b'.repeat(40), 'd'.repeat(40), 'e'.repeat(40)]);
  const binder = new RequirementBinder({
    layout,
    registryStore: registry,
    projectStore: projects,
    gitReader: { isAncestor: async (_repoPath, headAtRecord, target) => target === commit && ancestry.has(headAtRecord) },
  });

  const sameSession = await binder.bind({ projectId: 'project-a', commitSha: commit, branch: 'main', client: 'codex', sessionId: 'session-one' });
  assert.deepStrictEqual(sameSession.requirementIds, ['req-a1', 'req-a2'], 'same session and ancestry should bind its ordered unclaimed sequence');
  assert.strictEqual(sameSession.requirementBinding, 'session-ancestry');

  const ambiguous = await binder.bind({ projectId: 'project-a', commitSha: commit, branch: 'main' });
  assert.strictEqual(ambiguous.requirementBinding, 'unavailable');
  assert.strictEqual(ambiguous.reason, 'ambiguous-sessions', 'multiple candidate sessions must never use most-recent guessing');

  const wrongSession = await binder.bind({ projectId: 'project-a', commitSha: commit, branch: 'main', client: 'codex', sessionId: 'unknown' });
  assert.strictEqual(wrongSession.reason, 'no-reliable-requirement');
  const changedBranch = await binder.bind({ projectId: 'project-a', commitSha: commit, branch: 'release', client: 'codex', sessionId: 'session-one' });
  assert.strictEqual(changedBranch.requirementBinding, 'unavailable', 'branch changes should lower confidence to unavailable');

  const explicit = await binder.bind({ projectId: 'project-a', commitSha: commit, requirementId: 'req-a1' });
  assert.deepStrictEqual(explicit.requirementIds, ['req-a1']);
  assert.strictEqual(explicit.requirementBinding, 'explicit');
  await assert.rejects(
    binder.bind({ projectId: 'project-a', commitSha: commit, requirementId: 'req-other-project' }),
    error => error.code === 'INVALID_ARGUMENT' && /different project/.test(error.message),
  );

  const unclaimed = await binder.bind({
    projectId: 'project-a', commitSha: commit, branch: 'main', client: 'codex', sessionId: 'session-one', claimedRequirementIds: ['req-a1'],
  });
  assert.deepStrictEqual(unclaimed.requirementIds, ['req-a2'], 'already advanced requirements should be excluded from a later claim');

  const explicitCommit = await binder.bind({ projectId: 'project-a', commitSha: '8'.repeat(40), branch: 'main' });
  assert.deepStrictEqual(explicitCommit.requirementIds, ['req-explicit-commit']);
  assert.strictEqual(explicitCommit.reason, 'explicit-commit');

  const claim = {
    schema: SCHEMAS.commitClaim,
    projectId: 'project-a',
    commitSha: commit,
    requirementIds: ['req-a1'],
    requirementBinding: 'session-ancestry',
  };
  await projects.appendRequirement('project-a', record('req-recorded-after-claim', 'project-a', 'session-one', 'a'.repeat(40), { ts: '2026-08-17T00:00:03.000Z' }));
  const retry = await binder.bind({ projectId: 'project-a', commitSha: commit, claim });
  assert.deepStrictEqual(retry.requirementIds, ['req-a1'], 'retry must reuse frozen IDs and ignore future records');
  assert.strictEqual(retry.frozen, true);

  console.log('requirement-binding-test PASS');
})().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}).finally(() => {
  fs.rmSync(temp, { recursive: true, force: true });
});
