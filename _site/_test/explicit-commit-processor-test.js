const assert = require('assert');
const { CommitReconciler } = require('../lib/commit-reconciler');

const sha = suffix => `${'a'.repeat(39)}${suffix}`;
const calls = [];
let active = 0;
let maxActive = 0;
const completed = new Set();
const projectStore = { readConfig: id => ({ projectId: id, enabled: true, repoPath: 'C:/fixture', knowledgePath: 'C:/knowledge' }) };
const reconciler = new CommitReconciler({ projectStore, registryStore: {}, requireAiProfile: false });
reconciler.processingLedger = {
  read: (projectId, commitSha) => completed.has(`${projectId}:${commitSha}`) ? { status: 'completed' } : null,
  complete: (projectId, commitSha) => { completed.add(`${projectId}:${commitSha}`); return { status: 'completed' }; },
};
reconciler.processCommit = async (projectId, _trigger, _operationId, _config, _branch, commitSha) => {
  active += 1; maxActive = Math.max(maxActive, active); calls.push(`${projectId}:${commitSha}`);
  await new Promise(resolve => setTimeout(resolve, 20));
  active -= 1;
  return { ok: true, commitSha, runId: `run-${commitSha.slice(-1)}`, claimFingerprint: `fp-${commitSha.slice(-1)}` };
};

(async () => {
  const d = sha('d'); const e = sha('e'); const f = sha('f');
  const duplicateA = reconciler.processCommitEvent({ projectId: 'project-a', commitSha: d, branch: 'main' });
  const duplicateB = reconciler.processCommitEvent({ projectId: 'project-a', commitSha: d, branch: 'main' });
  const next = reconciler.processCommitEvent({ projectId: 'project-a', commitSha: e, branch: 'main' });
  const other = reconciler.processCommitEvent({ projectId: 'project-b', commitSha: f, branch: 'main' });
  const [first, second, third, fourth] = await Promise.all([duplicateA, duplicateB, next, other]);
  assert.equal(first.status, 'completed'); assert.equal(second.status, 'completed');
  assert.equal(third.status, 'completed'); assert.equal(fourth.status, 'completed');
  assert.deepEqual(calls.filter(value => value.startsWith('project-a:')), [`project-a:${d}`, `project-a:${e}`]);
  assert.equal(calls.filter(value => value === `project-a:${d}`).length, 1, 'duplicate explicit Hook event must join');
  assert(maxActive >= 2, 'different projects may process in parallel');
  const repeated = await reconciler.processCommitEvent({ projectId: 'project-a', commitSha: d, branch: 'main' });
  assert.equal(repeated.status, 'already-completed');
  console.log('explicit-commit-processor-test PASS');
})().catch(error => { console.error(error.stack || error.message); process.exit(1); });
