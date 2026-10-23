'use strict';

// P-ENG-ADVANCED ENG-009 fault-point writer/child.
//
// Exercises the VENDORED KnowledgePromotionService (byte-identical to source
// e5573bb) using its production `fault` constructor hook - the class's own
// sanctioned interruption point - to hard-exit the process at exact promotion
// phases. A separate process then runs the same vendored service's
// recoverAll(), which is exactly what EngineCoordinator.initialize() calls on
// every startup. The analyzer here is the same declarative stand-in (no real
// model output). The project state container is a real atomic JSON file with
// the runtime shape the promotion service reads/writes.
//
// Usage: node parallel-engine-advanced-fault-writer.js <mode> <workDir>
//   mode crash-prepared    - exit hard at fault point journal-prepared
//   mode crash-mid-apply   - exit hard at fault point operation-applied:0
//   mode crash-after-apply - exit hard at fault point promotion-verified
//                             (journal already persisted as awaiting-state-advance)
//   mode recover           - run recoverAll() and report recovery + final state
//   mode complete          - control: full processClaim without injected crash

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { RuntimeLayout } = require('../../../_modules/knowledge-engine/src/runtime/layout.js');
const { KnowledgePromotionService } = require('../../../_modules/knowledge-engine/src/runtime/knowledge-promotion.js');
const AtomicFile = require('../../../_modules/knowledge-engine/src/runtime/atomic-file.js');

const PROJECT_ID = 'project-eng009-fault';
const COMMIT_SHA = 'a'.repeat(40); // fixture identity; not a real repo commit - promotion only needs claim identity + hashes
const RUN_ID = 'run-11111111-2222-3333-4444-555555555555';
const FINGERPRINT = `sha256:${'f'.repeat(64)}`;

function hashBuffer(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function workPaths(workDir) {
  return {
    dataDir: path.join(workDir, 'engine-data'),
    knowledgePath: path.join(workDir, 'knowledge'),
    stateFile: path.join(workDir, 'project-state.json'),
    output: path.join(workDir, 'fault-result.json'),
  };
}

function initialState() {
  return {
    lastAnalyzedCommit: null,
    analysis: { status: 'idle', activeClaim: {
      schema: 'commit-claim/v1', projectId: PROJECT_ID, commitSha: COMMIT_SHA, runId: RUN_ID,
      fingerprint: FINGERPRINT, patchHash: `sha256:${'p'.repeat(64)}`, promptHash: `sha256:${'q'.repeat(64)}`,
      evidenceHash: `sha256:${'e'.repeat(64)}`, evidenceManifestHash: `sha256:${'m'.repeat(64)}`,
      retrievalManifestHash: `sha256:${'r'.repeat(64)}`, knowledgePath: null, phase: 'evidence.prepared', attempt: 1,
    }, lastError: null },
    index: { generation: 0, dirty: false, status: 'pending', sinceCommit: null, lastError: null },
  };
}

function makeProjectStore(stateFile, knowledgePath) {
  const read = () => AtomicFile.readJsonStrict(stateFile, { category: 'engadv-project-state', allowMissing: true, defaultValue: initialState() });
  return {
    readConfig: () => ({ projectId: PROJECT_ID, knowledgePath, repoPath: null, displayName: 'eng009-fault' }),
    readState: () => read(),
    updateState: async (id, fn) => {
      const draft = read();
      fn(draft);
      AtomicFile.writeJsonAtomic(stateFile, draft);
      return draft;
    },
  };
}

function standinAnalyzer({ knowledgePath }) {
  return {
    sourceReadMode: 'isolated-frozen-evidence',
    async runClaim(input) {
      const newReadme = `# eng009 fixture knowledge (replaced)\n\nPromoted for run ${input.claim.runId}.\n`;
      const changeRel = `changes/${input.claim.runId.slice(4, 16)}.md`;
      const changeContent = `# Change record eng009\n\nCommit ${input.claim.commitSha} via stand-in analyzer (no real model output).\n`;
      AtomicFile.writeFileAtomic(path.join(input.stagingPath, 'files', 'README.md'), newReadme);
      AtomicFile.writeFileAtomic(path.join(input.stagingPath, 'files', ...changeRel.split('/')), changeContent);
      const refs = [
        `commit:${input.claim.commitSha}`,
        `patch:${input.claim.patchHash}`,
        `conversation:${input.claim.conversationSnapshotHash}`,
        `retrieval:${input.claim.retrievalManifestHash}`,
      ];
      AtomicFile.writeJsonAtomic(input.manifestPath, {
        schema: 'knowledge-staging-manifest/v1',
        projectId: input.projectId,
        runId: input.claim.runId,
        commitSha: input.claim.commitSha,
        operations: [
          { path: 'README.md', operation: 'replace', sha256: hashBuffer(newReadme), reason: 'Fixture replace for crash injection', evidenceReferences: refs },
          { path: changeRel, operation: 'create', sha256: hashBuffer(changeContent), reason: 'Fixture create for crash injection', evidenceReferences: refs },
        ],
      });
      return { ok: true };
    },
  };
}

async function main() {
  const mode = process.argv[2];
  const workDir = process.argv[3];
  if (!mode || !workDir) throw new Error('usage: fault-writer <mode> <workDir>');
  const { dataDir, knowledgePath, stateFile, output } = workPaths(workDir);
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(knowledgePath, { recursive: true });
  if (!fs.existsSync(stateFile)) AtomicFile.writeJsonAtomic(stateFile, initialState());
  if (!fs.existsSync(path.join(knowledgePath, 'README.md'))) {
    AtomicFile.writeFileAtomic(path.join(knowledgePath, 'README.md'), '# eng009 fixture knowledge (original)\n\nPre-crash content.\n');
  }
  const layout = new RuntimeLayout(dataDir);
  const projectStore = makeProjectStore(stateFile, knowledgePath);
  const claim = {
    schema: 'commit-claim/v1', projectId: PROJECT_ID, commitSha: COMMIT_SHA, runId: RUN_ID, fingerprint: FINGERPRINT,
    patchHash: `sha256:${'p'.repeat(64)}`, promptHash: `sha256:${'q'.repeat(64)}`,
    conversationSnapshotHash: `sha256:${'c'.repeat(64)}`, retrievalManifestHash: `sha256:${'r'.repeat(64)}`,
  };
  const fault = phase => {
    if (mode === 'crash-prepared' && phase === 'journal-prepared') {
      process.exit(137);
    }
    if (mode === 'crash-mid-apply' && phase === 'operation-applied:0') {
      process.exit(137);
    }
    if (mode === 'crash-after-apply' && phase === 'promotion-verified') {
      process.exit(137);
    }
  };
  const service = new KnowledgePromotionService({ layout, projectStore, analyzer: standinAnalyzer({ knowledgePath }), fault });
  const config = projectStore.readConfig();

  if (mode === 'recover') {
    const results = await service.recoverAll();
    const state = projectStore.readState();
    const readmeHash = hashBuffer(fs.readFileSync(path.join(knowledgePath, 'README.md')));
    const changesDir = path.join(knowledgePath, 'changes');
    AtomicFile.writeJsonAtomic(output, {
      mode,
      recoverAll: results,
      lastAnalyzedCommit: state.lastAnalyzedCommit,
      activeClaimRunId: state.analysis.activeClaim?.runId || null,
      indexDirty: state.index.dirty,
      indexGeneration: state.index.generation,
      readmeHash,
      changesFiles: fs.existsSync(changesDir) ? fs.readdirSync(changesDir) : [],
    });
    process.stdout.write(`ENGADV-FAULT-RECOVER ${JSON.stringify(results)}\n`);
    return;
  }

  const result = await service.processClaim({ projectId: PROJECT_ID, config, claim, operationId: 'engadv-fault-op' });
  const state = projectStore.readState();
  AtomicFile.writeJsonAtomic(output, {
    mode,
    processClaim: { ok: result.ok, stateAdvanced: result.stateAdvanced === true, operations: result.operations },
    lastAnalyzedCommit: state.lastAnalyzedCommit,
    activeClaimRunId: state.analysis.activeClaim?.runId || null,
    indexDirty: state.index.dirty,
  });
  process.stdout.write(`ENGADV-FAULT-COMPLETE ok=${result.ok}\n`);
}

main().catch(error => {
  // A rejection still means the process is alive; crash modes exit via the fault hook.
  process.stderr.write(`[engadv-fault] ${error.code || 'FAULT_FAILED'}: ${error.message}\n`);
  process.exit(1);
});
