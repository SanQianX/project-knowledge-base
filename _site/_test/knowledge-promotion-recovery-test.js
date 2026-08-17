// Run: node _site/_test/knowledge-promotion-recovery-test.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SCHEMAS } = require('../lib/contracts');
const { StorageLayout } = require('../lib/storage-layout');
const { ProjectRegistryStore } = require('../lib/project-registry-store');
const { ProjectStore } = require('../lib/project-store');
const { claimFingerprint } = require('../lib/commit-reconciler');
const { KnowledgePromotionService, MANIFEST_SCHEMA, hashBuffer } = require('../lib/knowledge-promotion');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), `kb-promotion-${process.pid}-`));
const layout = new StorageLayout({ dataDir: path.join(temp, 'data') });
const registry = new ProjectRegistryStore({ layout });
const projects = new ProjectStore({ layout });
let sequence = 0;

async function addProject(projectId) {
  const repoPath = path.join(temp, 'repos', projectId);
  const knowledgePath = path.join(temp, 'knowledge', projectId);
  fs.mkdirSync(repoPath, { recursive: true });
  fs.mkdirSync(knowledgePath, { recursive: true });
  await projects.create(projectId, {
    displayName: projectId,
    storageName: projectId,
    repoPath,
    knowledgePath,
    aiProfileId: 'test-profile',
  }, { trackingStartCommit: '1'.repeat(40), trackingMode: 'normal' });
  await registry.add(projectId, { displayName: projectId });
  return projects.readConfig(projectId);
}

async function activate(projectId, requirementIds = []) {
  sequence += 1;
  const commitSha = sequence.toString(16).padStart(40, '0');
  const claim = {
    schema: SCHEMAS.commitClaim,
    projectId,
    commitSha,
    parents: ['1'.repeat(40)],
    triggerFirstSeen: 'git-hook',
    requirementIds,
    requirementBinding: requirementIds.length ? 'explicit' : 'unavailable',
    promptTemplateVersion: 2,
    promptHash: `sha256:prompt-${sequence}`,
    patchHash: `sha256:patch-${sequence}`,
    evidenceHash: `sha256:evidence-${sequence}`,
    knowledgePath: projects.readConfig(projectId).knowledgePath,
    runId: `run-${sequence}`,
    operationId: `op-${sequence}`,
    phase: 'evidence.prepared',
    attempt: 1,
  };
  claim.fingerprint = claimFingerprint(claim);
  await projects.updateState(projectId, state => {
    state.analysis.activeClaim = claim;
    state.analysis.status = 'evidence.prepared';
    state.analysis.lastError = null;
  });
  return claim;
}

function analyzerFor(operations) {
  return {
    calls: 0,
    async runClaim(input) {
      this.calls += 1;
      const manifestOperations = [];
      for (const operation of operations) {
        let digest = null;
        if (operation.operation !== 'delete') {
          const target = path.join(input.stagingPath, 'files', ...operation.path.split('/'));
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, operation.content, 'utf8');
          digest = hashBuffer(Buffer.from(operation.content));
        }
        manifestOperations.push({
          path: operation.path,
          operation: operation.operation,
          sha256: digest,
          reason: operation.reason || 'Verified by the active commit patch.',
          evidenceReferences: operation.evidenceReferences || [input.claim.commitSha],
        });
      }
      fs.writeFileSync(input.manifestPath, JSON.stringify({
        schema: MANIFEST_SCHEMA,
        projectId: input.projectId,
        runId: input.claim.runId,
        commitSha: input.claim.commitSha,
        operations: manifestOperations,
      }, null, 2), 'utf8');
      return { ok: true };
    },
  };
}

(async () => {
  await registry.initialize();

  const validConfig = await addProject('project-valid');
  fs.writeFileSync(path.join(validConfig.knowledgePath, 'README.md'), '# Old README\n\nOld fact.\n', 'utf8');
  fs.mkdirSync(path.join(validConfig.knowledgePath, 'changes'), { recursive: true });
  fs.writeFileSync(path.join(validConfig.knowledgePath, 'changes', 'old.md'), '# Old Change\n\nRemove me.\n', 'utf8');
  const validClaim = await activate('project-valid', ['req-valid']);
  const validAnalyzer = analyzerFor([
    { path: 'README.md', operation: 'replace', content: '# Project Valid\n\nVerified current fact.\n' },
    { path: 'modules/core.md', operation: 'create', content: '# Core Module\n\nThe active commit adds the core module.\n' },
    { path: 'changes/old.md', operation: 'delete' },
  ]);
  let enqueued = 0;
  const validService = new KnowledgePromotionService({
    layout,
    projectStore: projects,
    analyzer: validAnalyzer,
    indexService: { enqueue: async () => { enqueued += 1; return { ok: true }; } },
  });
  const promoted = await validService.processClaim({ projectId: 'project-valid', config: validConfig, claim: validClaim, prompt: 'frozen prompt' });
  assert.strictEqual(promoted.stateAdvanced, true);
  assert.strictEqual(fs.readFileSync(path.join(validConfig.knowledgePath, 'README.md'), 'utf8'), '# Project Valid\n\nVerified current fact.\n');
  assert(fs.existsSync(path.join(validConfig.knowledgePath, 'modules', 'core.md')));
  assert.strictEqual(fs.existsSync(path.join(validConfig.knowledgePath, 'changes', 'old.md')), false);
  const validState = projects.readState('project-valid');
  assert.strictEqual(validState.lastAnalyzedCommit, validClaim.commitSha);
  assert.strictEqual(validState.analysis.activeClaim, null);
  assert.deepStrictEqual(validState.analysis.consumedRequirementIds, ['req-valid']);
  assert.strictEqual(validState.index.dirty, true);
  assert.strictEqual(enqueued, 1);

  const noOutputConfig = await addProject('project-no-output');
  const noOutputClaim = await activate('project-no-output');
  const noOutputService = new KnowledgePromotionService({
    layout,
    projectStore: projects,
    analyzer: { runClaim: async () => ({ ok: true }) },
  });
  await assert.rejects(
    noOutputService.processClaim({ projectId: 'project-no-output', config: noOutputConfig, claim: noOutputClaim, prompt: 'frozen' }),
    error => error.code === 'DATA_CORRUPT' || error.code === 'ENOENT',
  );
  assert.strictEqual(projects.readState('project-no-output').lastAnalyzedCommit, null, 'AI exit 0 without output must not advance');

  const outsideConfig = await addProject('project-outside');
  const outsideClaim = await activate('project-outside');
  const outsideService = new KnowledgePromotionService({
    layout,
    projectStore: projects,
    analyzer: analyzerFor([{ path: '../outside.md', operation: 'create', content: '# Outside\n\nUnsafe.\n' }]),
  });
  await assert.rejects(
    outsideService.processClaim({ projectId: 'project-outside', config: outsideConfig, claim: outsideClaim, prompt: 'frozen' }),
    error => error.code === 'PATH_OUTSIDE_ROOT',
  );
  assert.strictEqual(fs.existsSync(path.join(temp, 'knowledge', 'outside.md')), false);

  const placeholderConfig = await addProject('project-placeholder');
  const placeholderClaim = await activate('project-placeholder');
  const placeholderService = new KnowledgePromotionService({
    layout,
    projectStore: projects,
    analyzer: analyzerFor([{ path: 'README.md', operation: 'create', content: '# Placeholder\n\nTODO: invent this later.\n' }]),
  });
  await assert.rejects(
    placeholderService.processClaim({ projectId: 'project-placeholder', config: placeholderConfig, claim: placeholderClaim, prompt: 'frozen' }),
    error => error.code === 'INVALID_ARGUMENT' && /Placeholder/.test(error.message),
  );

  const rollbackConfig = await addProject('project-rollback');
  fs.writeFileSync(path.join(rollbackConfig.knowledgePath, 'README.md'), '# Original\n\nKeep this.\n', 'utf8');
  const rollbackClaim = await activate('project-rollback');
  const rollbackService = new KnowledgePromotionService({
    layout,
    projectStore: projects,
    analyzer: analyzerFor([
      { path: 'README.md', operation: 'replace', content: '# Replaced\n\nNew verified fact.\n' },
      { path: 'modules/new.md', operation: 'create', content: '# New Module\n\nNew verified module.\n' },
    ]),
    fault: stage => { if (stage === 'operation-applied:0') throw new Error('injected crash after first apply'); },
  });
  await assert.rejects(
    rollbackService.processClaim({ projectId: 'project-rollback', config: rollbackConfig, claim: rollbackClaim, prompt: 'frozen' }),
    /injected crash/,
  );
  assert.strictEqual(projects.readState('project-rollback').lastAnalyzedCommit, null);
  const rollbackRecovery = new KnowledgePromotionService({ layout, projectStore: projects });
  const rolledBack = await rollbackRecovery.recoverAll();
  assert(rolledBack.some(item => item.phase === 'rolled-back'));
  assert.strictEqual(fs.readFileSync(path.join(rollbackConfig.knowledgePath, 'README.md'), 'utf8'), '# Original\n\nKeep this.\n');
  assert.strictEqual(fs.existsSync(path.join(rollbackConfig.knowledgePath, 'modules', 'new.md')), false);

  const recoverConfig = await addProject('project-recover-state');
  const recoverClaim = await activate('project-recover-state');
  const recoverAnalyzer = analyzerFor([{ path: 'README.md', operation: 'create', content: '# Recovered\n\nVerified before the crash.\n' }]);
  const crashBeforeState = new KnowledgePromotionService({
    layout,
    projectStore: projects,
    analyzer: recoverAnalyzer,
    fault: stage => { if (stage === 'promotion-verified') throw new Error('crash before state advance'); },
  });
  await assert.rejects(
    crashBeforeState.processClaim({ projectId: 'project-recover-state', config: recoverConfig, claim: recoverClaim, prompt: 'frozen' }),
    /crash before state advance/,
  );
  assert.strictEqual(projects.readState('project-recover-state').lastAnalyzedCommit, null);
  const recovery = new KnowledgePromotionService({ layout, projectStore: projects });
  const recovered = await recovery.recoverAll();
  assert(recovered.some(item => item.stateAdvanced === true));
  assert.strictEqual(projects.readState('project-recover-state').lastAnalyzedCommit, recoverClaim.commitSha);
  assert.strictEqual(recoverAnalyzer.calls, 1, 'journal recovery must not call AI again');

  const stateFailureConfig = await addProject('project-state-failure');
  const stateFailureClaim = await activate('project-state-failure');
  const stateFailureAnalyzer = analyzerFor([{ path: 'README.md', operation: 'create', content: '# State Repair\n\nVerified before persistence failed.\n' }]);
  const failingStore = {
    readState: projectId => projects.readState(projectId),
    updateState: async () => { throw new Error('injected state persistence failure'); },
  };
  const stateFailureService = new KnowledgePromotionService({
    layout,
    projectStore: failingStore,
    analyzer: stateFailureAnalyzer,
  });
  await assert.rejects(
    stateFailureService.processClaim({ projectId: 'project-state-failure', config: stateFailureConfig, claim: stateFailureClaim, prompt: 'frozen' }),
    /state persistence failure/,
  );
  assert(fs.existsSync(path.join(stateFailureConfig.knowledgePath, 'README.md')), 'verified Markdown should remain promoted while journal awaits state repair');
  assert.strictEqual(projects.readState('project-state-failure').lastAnalyzedCommit, null);
  const stateRepair = new KnowledgePromotionService({ layout, projectStore: projects });
  await stateRepair.recoverAll();
  assert.strictEqual(projects.readState('project-state-failure').lastAnalyzedCommit, stateFailureClaim.commitSha, 'startup recovery should repair state without another AI run');
  assert.strictEqual(stateFailureAnalyzer.calls, 1);

  const conflictConfig = await addProject('project-conflict');
  fs.writeFileSync(path.join(conflictConfig.knowledgePath, 'README.md'), '# Before\n\nOriginal.\n', 'utf8');
  const conflictClaim = await activate('project-conflict');
  const conflictService = new KnowledgePromotionService({
    layout,
    projectStore: projects,
    analyzer: analyzerFor([{ path: 'README.md', operation: 'replace', content: '# After\n\nPromoted.\n' }]),
    fault: stage => {
      if (stage === 'manifest-validated') fs.writeFileSync(path.join(conflictConfig.knowledgePath, 'README.md'), '# User Edit\n\nDo not overwrite.\n', 'utf8');
    },
  });
  await assert.rejects(
    conflictService.processClaim({ projectId: 'project-conflict', config: conflictConfig, claim: conflictClaim, prompt: 'frozen' }),
    error => error.code === 'PROJECT_BUSY',
  );
  assert.strictEqual(fs.readFileSync(path.join(conflictConfig.knowledgePath, 'README.md'), 'utf8'), '# User Edit\n\nDo not overwrite.\n');
  assert.strictEqual(projects.readState('project-conflict').lastAnalyzedCommit, null);

  console.log('knowledge-promotion-recovery-test PASS');
})().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}).finally(() => {
  fs.rmSync(temp, { recursive: true, force: true });
});
