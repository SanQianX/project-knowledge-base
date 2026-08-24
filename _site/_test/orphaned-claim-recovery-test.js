// Run: node _site/_test/orphaned-claim-recovery-test.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { StorageLayout } = require('../lib/storage-layout');
const { ProjectRegistryStore } = require('../lib/project-registry-store');
const { ProjectStore } = require('../lib/project-store');
const { recoverOrphanedClaims } = require('../lib/post-commit-automation');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), `kb-orphaned-claim-${process.pid}-`));
const layout = new StorageLayout({ dataDir: path.join(temp, 'data') });
const registryStore = new ProjectRegistryStore({ layout });
const projectStore = new ProjectStore({ layout });
const projectId = 'project-orphaned-claim';
const oldCommit = 'a'.repeat(40);
const lastAnalyzedCommit = 'b'.repeat(40);
let warnings = 0;
let analyzerCalls = 0;

(async () => {
  await registryStore.initialize();
  await registryStore.add(projectId);
  await projectStore.create(projectId, {
    repoPath: temp,
    knowledgePath: path.join(temp, 'knowledge'),
  }, {
    trackingStartCommit: lastAnalyzedCommit,
    lastAnalyzedCommit,
    analysis: {
      status: 'evidence.prepared',
      activeClaim: {
        schema: 'commit-claim/v1',
        projectId,
        commitSha: oldCommit,
        runId: 'run-before-restart',
        operationId: 'operation-before-restart',
        fingerprint: 'frozen-claim',
        phase: 'evidence.prepared',
      },
    },
  });

  const recovered = await recoverOrphanedClaims({
    layout,
    registryStore,
    projectStore,
    claimProcessor: { processClaim: async () => { analyzerCalls += 1; } },
    now: () => '2026-08-25T00:00:00.000Z',
    logger: { warn: async () => { warnings += 1; } },
  });

  assert.deepStrictEqual(recovered, [{
    projectId,
    commitSha: oldCommit,
    runId: 'run-before-restart',
    previousPhase: 'evidence.prepared',
  }]);
  const state = projectStore.readState(projectId);
  assert.strictEqual(state.lastAnalyzedCommit, lastAnalyzedCommit, 'startup recovery must not advance commit state');
  assert.strictEqual(state.analysis.status, 'failed');
  assert.strictEqual(state.analysis.activeClaim.commitSha, oldCommit);
  assert.strictEqual(state.analysis.activeClaim.phase, 'failed');
  assert.strictEqual(state.analysis.activeClaim.error.code, 'ORPHANED_CLAIM');
  assert.strictEqual(state.analysis.activeClaim.error.retryable, false);
  assert.strictEqual(state.analysis.lastError.code, 'ORPHANED_CLAIM');
  assert.strictEqual(analyzerCalls, 0, 'startup recovery must never invoke analysis');
  assert.strictEqual(warnings, 1);

  const secondPass = await recoverOrphanedClaims({ layout, registryStore, projectStore });
  assert.strictEqual(secondPass.length, 0, 'recovery is idempotent while the terminal claim remains visible');
  assert.strictEqual(projectStore.readState(projectId).analysis.activeClaim.error.code, 'ORPHANED_CLAIM');
  console.log('orphaned-claim-recovery-test PASS');
})().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}).finally(() => {
  fs.rmSync(temp, { recursive: true, force: true });
});
