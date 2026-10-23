'use strict';

// P-ENG-FINAL deterministic analyzer stand-in.
//
// SCOPE (declared): this stand-in writes REAL staged Markdown bytes and a REAL
// staging manifest through the engine's real promotion path (journal, backups,
// hashing, state advance, index sync). It does NOT exercise a real model, a
// real prompt, or any paid API - the promoted text is fixture content, and the
// memory candidates it emits are engine-validated against the frozen
// conversation snapshot exactly like a real analyzer's would be.
//
// The stand-in exists to make timing and failure deterministic; every engine
// behaviour asserted by the drivers (journal, claim binding, promotion,
// eligibility gate, dedup, retry) is the production code path.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function hashBuffer(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function createStandinAnalyzer(options = {}) {
  const {
    eventsFile = null,
    failShas = new Set(),
    // Transient fault model: the FIRST invocation for a listed SHA fails, the
    // retry succeeds (models a one-off fault, not a permanently broken commit).
    failOnceShas = new Set(),
    readSnapshot = null,
    humanQuote = null,
    delegatedQuote = null,
    emitMemoryCandidates = false,
    extraOperations = [],
  } = options;

  function record(entry) {
    if (!eventsFile) return;
    fs.mkdirSync(path.dirname(eventsFile), { recursive: true });
    fs.appendFileSync(eventsFile, `${JSON.stringify({ ...entry, at: new Date().toISOString(), pid: process.pid })}\n`);
  }

  const attemptsBySha = new Map();

  function pickEvent(snapshot, origin) {
    const turns = snapshot?.turns || [];
    for (const turn of turns) {
      for (const event of turn.userEvents || []) {
        if ((event.inputOrigin || 'unknown') === origin) return event;
      }
    }
    return null;
  }

  return {
    sourceReadMode: 'isolated-frozen-evidence',
    async runClaim(input) {
      const claim = input.claim;
      const sha = claim.commitSha;
      const attempt = (attemptsBySha.get(sha) || 0) + 1;
      attemptsBySha.set(sha, attempt);
      record({ kind: 'start', projectId: input.projectId, runId: claim.runId, commitSha: sha, attempt });
      try {
        if (failShas.has(sha) || (failOnceShas.has(sha) && attempt === 1)) {
          const error = new Error('stand-in analyzer failure (injected)');
          error.code = 'STANDIN_ANALYZER_FAILURE';
          throw error;
        }
        const filename = `changes/${sha.slice(0, 12)}.md`;
        const lines = [
          '---',
          `commit: ${sha}`,
          `run: ${claim.runId}`,
          '---',
          `# Fixture knowledge ${input.projectId}`,
          '',
          `Commit ${sha} promoted by the deterministic stand-in analyzer (no real model output).`,
          '',
        ];
        if (humanQuote) lines.push(`用户原话：${humanQuote}`, '');
        if (delegatedQuote) lines.push(`维护指令：${delegatedQuote}`, '');
        const markdown = lines.join('\n');

        const AtomicFile = require('../../../_modules/knowledge-engine/src/runtime/atomic-file.js');
        AtomicFile.writeFileAtomic(path.join(input.stagingPath, 'files', ...filename.split('/')), markdown);

        const references = [
          `commit:${claim.commitSha}`,
          `patch:${claim.patchHash}`,
          `conversation:${claim.conversationSnapshotHash}`,
          `retrieval:${claim.retrievalManifestHash}`,
        ];
        const operations = [{
          operation: 'create',
          path: filename,
          reason: 'Deterministic stand-in knowledge for acceptance coverage',
          sha256: hashBuffer(markdown),
          evidenceReferences: references,
        }];
        for (const extra of extraOperations) {
          operations.push({
            operation: extra.operation,
            path: extra.path,
            reason: extra.reason || 'Deterministic stand-in extra operation',
            sha256: extra.operation === 'delete' ? undefined : hashBuffer(extra.content || ''),
            evidenceReferences: references,
          });
          if (extra.operation !== 'delete' && extra.content) {
            AtomicFile.writeFileAtomic(path.join(input.stagingPath, 'files', ...extra.path.split('/')), extra.content);
          }
        }

        const memoryCandidates = [];
        if (emitMemoryCandidates && readSnapshot) {
          const snapshot = readSnapshot(input.projectId, sha);
          const human = pickEvent(snapshot, 'human');
          const delegated = pickEvent(snapshot, 'agent-delegation');
          if (human && humanQuote) {
            memoryCandidates.push({
              text: humanQuote,
              entryId: filename,
              quote: humanQuote,
              sourceEventId: human.eventId,
              sourceHash: human.contentHash,
              scopeType: 'global',
              eligibility: { durable: true, crossProject: true, reason: 'fixture durable owner preference', scopeReason: 'fixture scope reason' },
            });
          }
          if (delegated && delegatedQuote) {
            memoryCandidates.push({
              text: delegatedQuote,
              entryId: filename,
              quote: delegatedQuote,
              sourceEventId: delegated.eventId,
              sourceHash: delegated.contentHash,
              scopeType: 'global',
              eligibility: { durable: true, crossProject: true, reason: 'fixture delegated maintenance instruction', scopeReason: 'fixture scope reason' },
            });
          }
        }

        AtomicFile.writeJsonAtomic(input.manifestPath, {
          schema: 'knowledge-staging-manifest/v1',
          projectId: input.projectId,
          runId: claim.runId,
          commitSha: claim.commitSha,
          operations,
          memoryCandidates,
        });
        return { ok: true };
      } finally {
        record({ kind: 'finish', projectId: input.projectId, runId: claim.runId, commitSha: sha });
      }
    },
  };
}

module.exports = { createStandinAnalyzer };
