// Run: node tests/legacy-relocation-recovery-test.js
// Legacy 执行路径的数据目录迁移恢复：旧版在目录 A 冻结的 claim（v1 快照携带
// A 的绝对路径）在目录改名后，经 processCommitEvent 重试入口从当前目录 B 读取
// 同一份证据完成维护；证据缺失以可定位类别失败，不写知识、不推进状态。

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { StorageLayout } = require('../_site/lib/storage-layout');
const { ProjectRegistryStore } = require('../_site/lib/project-registry-store');
const { ProjectStore } = require('../_site/lib/project-store');
const { CommitReconciler, SNAPSHOT_SCHEMA_V1 } = require('../_site/lib/commit-reconciler');
const { KnowledgePromotionService, MANIFEST_SCHEMA, hashBuffer } = require('../_site/lib/knowledge-promotion');
const AtomicFile = require('../_site/lib/atomic-file');

const git = (cwd, args) => execFileSync('git', args, { cwd, windowsHide: true, encoding: 'utf8' }).trim();

function makeRepo(root, name, { bigPatch = false } = {}) {
  const repoPath = path.join(root, `代码 ${name}`);
  fs.mkdirSync(repoPath, { recursive: true });
  git(repoPath, ['init', '-q']);
  git(repoPath, ['config', 'user.email', 'legacy-relocation@local.invalid']);
  git(repoPath, ['config', 'user.name', 'Legacy Relocation Test']);
  fs.writeFileSync(path.join(repoPath, 'README.md'), '# Initial\n');
  git(repoPath, ['add', '.']);
  git(repoPath, ['commit', '-qm', 'initial']);
  const baseline = git(repoPath, ['rev-parse', 'HEAD']);
  const payload = bigPatch ? `line ${'x'.repeat(96)} ${Date.now()}\n`.repeat(30000) : 'small feature change\n';
  fs.writeFileSync(path.join(repoPath, 'feature.txt'), payload);
  git(repoPath, ['add', '.']);
  git(repoPath, ['commit', '-qm', 'feature']);
  return { repoPath, baseline, commitSha: git(repoPath, ['rev-parse', 'HEAD']) };
}

function analyzerFor({ events = [] } = {}) {
  return {
    async runClaim(input) {
      events.push({ evidenceRoot: input.evidenceRoot, runId: input.claim.runId, chunked: Boolean(input.evidence.patchChunked) });
      fs.readFileSync(path.join(input.evidenceRoot, 'patch-manifest.json'), 'utf8');
      const relative = `changes/${input.claim.commitSha.slice(0, 12)}.md`;
      const content = `# Verified maintenance\n\nCommit ${input.claim.commitSha} analyzed from relocated legacy evidence.\n`;
      const target = path.join(input.stagingPath, 'files', relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content, 'utf8');
      AtomicFile.writeJsonAtomic(input.manifestPath, {
        schema: MANIFEST_SCHEMA,
        projectId: input.projectId,
        runId: input.claim.runId,
        commitSha: input.claim.commitSha,
        operations: [{
          path: relative,
          operation: 'create',
          sha256: hashBuffer(Buffer.from(content)),
          reason: 'Relocated frozen evidence',
          evidenceReferences: [
            `commit:${input.claim.commitSha}`,
            `patch:${input.claim.patchHash}`,
            `conversation:${input.claim.conversationSnapshotHash}`,
            `retrieval:${input.claim.retrievalManifestHash}`,
          ].filter(reference => !reference.endsWith(':')),
        }],
      });
      return { ok: true };
    },
  };
}

async function buildStores(layout) {
  const registry = new ProjectRegistryStore({ layout });
  const projects = new ProjectStore({ layout });
  await registry.initialize();
  return { registry, projects };
}

// Rewrite the on-disk snapshot into the exact v1 shape an older version wrote:
// absolute evidence/retrieval locations under `dataDir`, no runId field.
function downgradeSnapshotToV1(dataDir, projectId, commitSha, runId) {
  const file = path.join(dataDir, 'runtime', 'claims', projectId, `${commitSha}.json`);
  const snapshot = JSON.parse(fs.readFileSync(file, 'utf8'));
  const evidenceRoot = path.join(dataDir, 'runtime', 'runs', projectId, runId, 'input', 'evidence');
  const legacy = {
    schema: SNAPSHOT_SCHEMA_V1,
    projectId,
    commitSha,
    claimFingerprint: snapshot.claimFingerprint,
    evidence: {
      ...snapshot.evidence,
      evidenceBundle: {
        ...snapshot.evidence.evidenceBundle,
        root: evidenceRoot,
        commitPath: path.join(evidenceRoot, 'commit.json'),
        manifestPath: path.join(evidenceRoot, 'patch-manifest.json'),
      },
    },
    prompt: snapshot.prompt,
    requirements: snapshot.requirements || [],
    conversationSnapshot: snapshot.conversationSnapshot || null,
    existingKnowledge: {
      ...snapshot.existingKnowledge,
      manifestPath: path.join(dataDir, 'runtime', 'runs', projectId, runId, 'input', 'retrieval', 'manifest.json'),
    },
    createdAt: snapshot.createdAt,
  };
  AtomicFile.writeJsonAtomic(file, legacy);
  return legacy;
}

async function relocateAndRetry(t, { root, name, bigPatch, tamper = null }) {
  const projectId = `project-${name.replace(/\s+/g, '-')}`;
  const knowledgePath = path.join(root, `知识 ${name}`);
  fs.mkdirSync(knowledgePath, { recursive: true });
  const repo = makeRepo(root, name, { bigPatch });
  const dataA = path.join(root, `数据 A ${name}`);
  const layoutA = new StorageLayout({ dataDir: dataA });
  const storesA = await buildStores(layoutA);
  await storesA.registry.add(projectId, { displayName: projectId });
  await storesA.projects.create(projectId, { repoPath: repo.repoPath, knowledgePath }, { trackingStartCommit: repo.baseline });

  const failingProcessor = { processClaim: async () => { throw Object.assign(new Error('知识分析超时。'), { code: 'MODEL_TIMEOUT', retryable: true, phase: 'analyzing' }); } };
  const reconcilerA = new CommitReconciler({ layout: layoutA, registryStore: storesA.registry, projectStore: storesA.projects, claimProcessor: failingProcessor, requireAiProfile: false });
  const first = await reconcilerA.processCommitEvent({ projectId, commitSha: repo.commitSha, branch: 'main' });
  assert.strictEqual(first.ok, false);
  assert.strictEqual(first.error.code, 'MODEL_TIMEOUT');
  const stateA = storesA.projects.readState(projectId);
  const runId = stateA.analysis.activeClaim.runId;
  assert.ok(runId, 'the failed attempt keeps its frozen claim');
  const legacy = downgradeSnapshotToV1(dataA, projectId, repo.commitSha, runId);
  assert.ok(legacy.evidence.evidenceBundle.root.startsWith(dataA), 'the v1 snapshot carries absolute A paths');
  const staleEvidenceRoot = legacy.evidence.evidenceBundle.root;

  const dataB = path.join(root, `数据 B ${name}`);
  fs.renameSync(dataA, dataB);
  assert.strictEqual(fs.existsSync(dataA), false, 'directory A no longer exists');

  const layoutB = new StorageLayout({ dataDir: dataB });
  const storesB = await buildStores(layoutB);
  const events = [];
  const promotion = new KnowledgePromotionService({ layout: layoutB, projectStore: storesB.projects, analyzer: analyzerFor({ events }) });
  const reconcilerB = new CommitReconciler({ layout: layoutB, registryStore: storesB.registry, projectStore: storesB.projects, claimProcessor: promotion, requireAiProfile: false });

  const currentEvidenceRoot = path.join(dataB, 'runtime', 'runs', projectId, runId, 'input', 'evidence');
  if (tamper) tamper({ evidenceRoot: currentEvidenceRoot, retrievalDir: path.join(dataB, 'runtime', 'runs', projectId, runId, 'input', 'retrieval') });
  const second = await reconcilerB.processCommitEvent({ projectId, commitSha: repo.commitSha, branch: 'main' });
  return { second, events, storesB, knowledgePath, repo, dataB, projectId, runId, staleEvidenceRoot };
}

(async () => {
  // 1) Happy path: v1 claim + chunked patch retries from directory B and the
  //    queue continues to the next commit.
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-legacy-reloc happy-'));
    try {
      const result = await relocateAndRetry(null, { root, name: 'chunked', bigPatch: true });
      assert.strictEqual(result.second.ok, true, JSON.stringify(result.second.error));
      assert.strictEqual((result.second.processed && result.second.processed[0] || {}).runId, result.runId, 'the retry reuses the SAME analysis run');
      assert.ok(result.events.length >= 1 && result.events[0].evidenceRoot.includes(`数据 B chunked`), 'the analyzer read from directory B');
      assert.strictEqual(result.events[0].chunked, true, 'the big patch stayed chunked');
      const state = result.storesB.projects.readState(result.projectId);
      assert.strictEqual(state.lastAnalyzedCommit, result.repo.commitSha, 'state advanced after relocated retry');
      assert.strictEqual(state.analysis.activeClaim, null);
      assert.ok(fs.existsSync(path.join(result.knowledgePath, 'changes', `${result.repo.commitSha.slice(0, 12)}.md`)), 'knowledge promoted from relocated evidence');
      assert.strictEqual(fs.existsSync(path.join(result.dataB, 'runtime', 'claims', result.projectId, `${result.repo.commitSha}.json`)), false, 'claim snapshot released');
      // A second, queued commit continues in order after recovery.
      const repoPath = result.repo.repoPath;
      fs.writeFileSync(path.join(repoPath, 'second.txt'), 'second\n');
      git(repoPath, ['add', '.']);
      git(repoPath, ['commit', '-qm', 'second']);
      const secondSha = git(repoPath, ['rev-parse', 'HEAD']);
      const events = [];
      const promotion = new KnowledgePromotionService({
        layout: new StorageLayout({ dataDir: result.dataB }),
        projectStore: result.storesB.projects,
        analyzer: analyzerFor({ events }),
      });
      const reconciler = new CommitReconciler({ layout: new StorageLayout({ dataDir: result.dataB }), registryStore: result.storesB.registry || {}, projectStore: result.storesB.projects, claimProcessor: promotion, requireAiProfile: false });
      const next = await reconciler.processCommitEvent({ projectId: result.projectId, commitSha: secondSha, branch: 'main' });
      assert.strictEqual(next.ok, true, JSON.stringify(next.error));
      assert.ok(fs.existsSync(path.join(result.knowledgePath, 'changes', `${secondSha.slice(0, 12)}.md`)), 'the queued commit continued after recovery');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }

  // 2) Stale old directory with different content never satisfies the retry.
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-legacy-reloc stale-'));
    try {
      // Keep a poisoned copy at the old location to prove reads come from B.
      const result = await relocateAndRetry(null, { root, name: 'stale', bigPatch: false });
      fs.mkdirSync(result.staleEvidenceRoot, { recursive: true });
      AtomicFile.writeJsonAtomic(path.join(result.staleEvidenceRoot, 'patch-manifest.json'), { schema: 'tampered', chunks: [] });
      assert.strictEqual(result.second.ok, true, JSON.stringify(result.second.error));
      assert.ok(result.events[0].evidenceRoot.includes('数据 B stale'), 'reads came from directory B');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }

  // 3) Missing evidence fails with a locatable category and no fake success.
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-legacy-reloc missing-'));
    try {
      const result = await relocateAndRetry(null, {
        root, name: 'missing', bigPatch: false,
        tamper: ({ retrievalDir }) => fs.unlinkSync(path.join(retrievalDir, 'manifest.json')),
      });
      assert.strictEqual(result.second.ok, false);
      assert.strictEqual(result.second.error.code, 'EVIDENCE_MISSING', JSON.stringify(result.second.error));
      assert.strictEqual(result.second.error.details.resource, 'input/retrieval/manifest.json', 'the failure names the concrete resource');
      assert.strictEqual(result.second.error.retryable, false);
      const state = result.storesB.projects.readState(result.projectId);
      assert.strictEqual(state.lastAnalyzedCommit, null, 'analysis head not advanced');
      assert.strictEqual(fs.existsSync(path.join(result.knowledgePath, 'changes')), false, 'no knowledge was written');
      assert.strictEqual(state.analysis.activeClaim.phase, 'failed', 'the failed claim is preserved for diagnostics');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }

  // 4) A v2 snapshot survives a second relocation without any rewrite.
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-legacy-reloc twice-'));
    try {
      // Produce the failed state on A, move A->B without downgrading (v2 stays).
      const projectId = 'project-twice';
      const knowledgePath = path.join(root, '知识 twice');
      fs.mkdirSync(knowledgePath, { recursive: true });
      const repo = makeRepo(root, 'twice', { bigPatch: false });
      const dataA = path.join(root, '数据 A twice');
      const layoutA = new StorageLayout({ dataDir: dataA });
      const storesA = await buildStores(layoutA);
      await storesA.registry.add(projectId, { displayName: projectId });
      await storesA.projects.create(projectId, { repoPath: repo.repoPath, knowledgePath }, { trackingStartCommit: repo.baseline });
      const failing = { processClaim: async () => { throw Object.assign(new Error('知识分析超时。'), { code: 'MODEL_TIMEOUT', retryable: true, phase: 'analyzing' }); } };
      const reconcilerA = new CommitReconciler({ layout: layoutA, registryStore: storesA.registry, projectStore: storesA.projects, claimProcessor: failing, requireAiProfile: false });
      await reconcilerA.processCommitEvent({ projectId, commitSha: repo.commitSha, branch: 'main' });
      const runId = storesA.projects.readState(projectId).analysis.activeClaim.runId;
      const dataB = path.join(root, '数据 B twice');
      fs.renameSync(dataA, dataB);
      const snapshot = JSON.parse(fs.readFileSync(path.join(dataB, 'runtime', 'claims', projectId, `${repo.commitSha}.json`), 'utf8'));
      assert.strictEqual(snapshot.schema, 'commit-claim-snapshot/v2');
      assert.strictEqual(snapshot.evidence.evidenceBundle.root, undefined, 'v2 stores no absolute evidence path');
      const dataC = path.join(root, '数据 C twice');
      fs.renameSync(dataB, dataC);
      const layoutC = new StorageLayout({ dataDir: dataC });
      const storesC = await buildStores(layoutC);
      const events = [];
      const promotion = new KnowledgePromotionService({ layout: layoutC, projectStore: storesC.projects, analyzer: analyzerFor({ events }) });
      const reconcilerC = new CommitReconciler({ layout: layoutC, registryStore: storesC.registry, projectStore: storesC.projects, claimProcessor: promotion, requireAiProfile: false });
      const retried = await reconcilerC.processCommitEvent({ projectId, commitSha: repo.commitSha, branch: 'main' });
      assert.strictEqual(retried.ok, true, JSON.stringify(retried.error));
      assert.strictEqual((retried.processed && retried.processed[0] || {}).runId, runId, 'same analysis run across both relocations');
      assert.ok(events[0].evidenceRoot.includes('数据 C twice'));
      assert.ok(fs.existsSync(path.join(knowledgePath, 'changes', `${repo.commitSha.slice(0, 12)}.md`)));
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }

  console.log('legacy-relocation-recovery-test PASS');
})().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
