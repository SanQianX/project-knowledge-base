'use strict';
// Lane-owned stand-in analyzer for the P-MEMORY-01 memory lane.
//
// HONEST SCOPE LABEL: this analyzer replaces the model-driven analysis step
// of the knowledge engine. It writes a real staged Markdown file and a real
// knowledge-staging-manifest through the engine's REAL promotion path, and it
// can declare memory candidates, but it proves nothing about model quality,
// prompt adherence or the headless Agent SDK worker. Every case that relies on
// it is evidence about the engine's memory admission, scope and injection
// machinery, never about the model.
//
// The manifest it writes is the engine's own schema. The engine's own
// KnowledgePromotionService validates it, promotes the staged file into the
// project knowledge directory and hands the run's staging to the real
// MemoryService.capture(), which applies the real provenance gate.
//
// The candidates it declares come from the test's plan. The test owns them
// because the engine's own gate requires them to quote a real human
// conversation event, and only the test knows that event's id and hash.

const path = require('node:path');
const crypto = require('node:crypto');
const AtomicFile = require('../../../_modules/knowledge-engine/src/runtime/atomic-file.js');

/**
 * A long enough sentence that the engine's own capture gate accepts it as a
 * quote (the gate requires at least eight characters) and that the promoted
 * Markdown always contains, so the promoted file can be checked against the
 * candidate's quote on disk.
 */
const EVIDENCE_QUOTE = '候选记忆依据：以下文字来自冻结的提交与人工对话，可用于验证记忆候选的来源可追溯性。';

function hashBuffer(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

/**
 * @param {object} options
 * @param {object} options.plan  Mutable plan the test owns. `plan.document` is
 *   the staged Markdown, `plan.memoryCandidates` are the candidates the
 *   stand-in proposes to the real capture path.
 */
function createMemoryStandinAnalyzer({ plan = {} } = {}) {
  return {
    sourceReadMode: 'isolated-frozen-evidence',
    async runClaim(input) {
      const relative = `changes/${input.claim.commitSha.slice(0, 12)}.md`;
      const base = plan.document
        || `# 维护产物 ${input.projectId}\n\nCommit ${input.claim.commitSha} 的冻结提交证据。\n`;
      const document = base.includes(EVIDENCE_QUOTE) ? base : `${base}\n${EVIDENCE_QUOTE}\n`;
      AtomicFile.writeFileAtomic(path.join(input.stagingPath, 'files', relative), document);
      const evidenceReferences = [
        `commit:${input.claim.commitSha}`,
        input.claim.patchHash && `patch:${input.claim.patchHash}`,
        input.claim.conversationSnapshotHash && `conversation:${input.claim.conversationSnapshotHash}`,
        input.claim.retrievalManifestHash && `retrieval:${input.claim.retrievalManifestHash}`,
      ].filter(Boolean);
      const memoryCandidates = (plan.memoryCandidates || []).map(candidate => ({
        ...candidate,
        entryId: candidate.entryId || relative,
      }));
      AtomicFile.writeJsonAtomic(input.manifestPath, {
        schema: 'knowledge-staging-manifest/v1',
        projectId: input.projectId,
        runId: input.claim.runId,
        commitSha: input.claim.commitSha,
        operations: [{
          path: relative,
          operation: 'create',
          sha256: hashBuffer(document),
          reason: 'Frozen Git evidence from the fixture commit (stand-in analyzer, no real model output)',
          evidenceReferences,
        }],
        memoryCandidates,
      });
      return { ok: true };
    },
  };
}

module.exports = { createMemoryStandinAnalyzer, EVIDENCE_QUOTE };
