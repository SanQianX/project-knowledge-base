'use strict';

// P-ENGINE-RECONCILE-R4 deterministic analyzer stand-in.
//
// SCOPE (declared): this stand-in writes REAL staged Markdown bytes and a REAL
// staging manifest through the engine's real promotion path (journal, backups,
// hashing, state advance, index sync). It does NOT exercise a real model, a
// real prompt, or any paid API - the promoted text is fixture content. The
// analyzer's atomic-file helper comes from the engine under test, so a
// candidate host promotes with its own bytes.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function hashBuffer(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function createStandinAnalyzer(options = {}) {
  const { eventsFile = null, engineRoot = null } = options;

  function record(entry) {
    if (!eventsFile) return;
    fs.mkdirSync(path.dirname(eventsFile), { recursive: true });
    fs.appendFileSync(eventsFile, `${JSON.stringify({ ...entry, at: new Date().toISOString(), pid: process.pid })}\n`);
  }

  return {
    sourceReadMode: 'isolated-frozen-evidence',
    async runClaim(input) {
      const claim = input.claim;
      const sha = claim.commitSha;
      record({ kind: 'start', projectId: input.projectId, runId: claim.runId, commitSha: sha });
      try {
        const filename = `changes/${sha.slice(0, 12)}.md`;
        const markdown = [
          '---',
          `commit: ${sha}`,
          `run: ${claim.runId}`,
          '---',
          `# Fixture knowledge ${input.projectId}`,
          '',
          `Commit ${sha} promoted by the deterministic stand-in analyzer (no real model output).`,
          '',
        ].join('\n');

        const atomicFilePath = engineRoot
          ? path.join(engineRoot, 'src', 'runtime', 'atomic-file.js')
          : path.join(__dirname, '..', '..', '..', '_modules', 'knowledge-engine', 'src', 'runtime', 'atomic-file.js');
        const AtomicFile = require(atomicFilePath);
        AtomicFile.writeFileAtomic(path.join(input.stagingPath, 'files', ...filename.split('/')), markdown);

        const references = [
          `commit:${claim.commitSha}`,
          `patch:${claim.patchHash}`,
          `conversation:${claim.conversationSnapshotHash}`,
          `retrieval:${claim.retrievalManifestHash}`,
        ];
        AtomicFile.writeJsonAtomic(input.manifestPath, {
          schema: 'knowledge-staging-manifest/v1',
          projectId: input.projectId,
          runId: claim.runId,
          commitSha: claim.commitSha,
          operations: [{
            operation: 'create',
            path: filename,
            reason: 'Deterministic stand-in knowledge for reconciliation coverage',
            sha256: hashBuffer(markdown),
            evidenceReferences: references,
          }],
          memoryCandidates: [],
        });
        return { ok: true };
      } finally {
        record({ kind: 'finish', projectId: input.projectId, runId: claim.runId, commitSha: sha });
      }
    },
  };
}

module.exports = { createStandinAnalyzer };
