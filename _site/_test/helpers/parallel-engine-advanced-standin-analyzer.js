'use strict';

// P-ENG-ADVANCED declarative stand-in analyzer.
//
// HONEST SCOPE LABEL: this analyzer produces real staged Markdown bytes and a
// valid knowledge-staging-manifest through the engine's REAL promotion path,
// but it does NOT cover real model output, real prompt adherence, or the
// headless Claude Agent SDK worker. Every case that relies on it is evidence
// about engine scheduling/promotion/indexing machinery, never about model
// quality. The debug simulateFailure flag is handled by the engine itself
// BEFORE this analyzer runs (DEBUG_SIMULATED_FAILURE).
//
// Plan file shape (JSON, read per claim):
// {
//   "default": { "delayMs": 300, "markdownHeader": "..." },
//   "rules": [{ "projectId": "...", "commitSha": "...", "delayMs": 5000 }]
// }
// Behavior: sleep delayMs (timing control), then write
// changes/<sha12>.md plus the manifest with the frozen claim evidence refs.
// Every start/finish appends a JSONL record to the events file for
// cross-process invocation-count and overlap evidence.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const AtomicFile = require('../../../_modules/knowledge-engine/src/runtime/atomic-file.js');

function hashBuffer(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function appendEvent(eventsFile, record) {
  if (!eventsFile) return;
  fs.mkdirSync(path.dirname(eventsFile), { recursive: true });
  fs.appendFileSync(eventsFile, `${JSON.stringify({ ...record, at: new Date().toISOString(), pid: process.pid })}\n`);
}

function readPlan(planFile) {
  if (!planFile || !fs.existsSync(planFile)) return { default: {} };
  try { return JSON.parse(fs.readFileSync(planFile, 'utf8')); } catch { return { default: {} }; }
}

function createStandinAnalyzer({ planFile, eventsFile } = {}) {
  return {
    sourceReadMode: 'isolated-frozen-evidence',
    async runClaim(input) {
      const plan = readPlan(planFile);
      const rule = (plan.rules || []).find(r => (!r.projectId || r.projectId === input.projectId) && (!r.commitSha || r.commitSha === input.claim.commitSha)) || {};
      const effective = { ...(plan.default || {}), ...rule };
      appendEvent(eventsFile, { kind: 'start', projectId: input.projectId, commitSha: input.claim.commitSha, runId: input.claim.runId, delayMs: effective.delayMs || 0 });
      if (effective.delayMs) await new Promise(resolve => setTimeout(resolve, effective.delayMs));
      const relative = `changes/${input.claim.commitSha.slice(0, 12)}.md`;
      const content = `${effective.markdownHeader || '# Verified maintenance'} ${input.projectId}\n\nCommit ${input.claim.commitSha} implements a fixture change.\n\n- Project: ${input.projectId}\n- Staged by: declarative stand-in analyzer (no real model output)\n`;
      AtomicFile.writeFileAtomic(path.join(input.stagingPath, 'files', relative), content);
      const refs = [
        `commit:${input.claim.commitSha}`,
        input.claim.patchHash && `patch:${input.claim.patchHash}`,
        input.claim.conversationSnapshotHash && `conversation:${input.claim.conversationSnapshotHash}`,
        input.claim.retrievalManifestHash && `retrieval:${input.claim.retrievalManifestHash}`,
      ].filter(Boolean);
      AtomicFile.writeJsonAtomic(input.manifestPath, {
        schema: 'knowledge-staging-manifest/v1',
        projectId: input.projectId,
        runId: input.claim.runId,
        commitSha: input.claim.commitSha,
        operations: [{
          path: relative,
          operation: 'create',
          sha256: hashBuffer(content),
          reason: 'Frozen Git evidence from fixture commit',
          evidenceReferences: refs,
        }],
      });
      appendEvent(eventsFile, { kind: 'finish', projectId: input.projectId, commitSha: input.claim.commitSha, runId: input.claim.runId });
      return { ok: true };
    },
  };
}

module.exports = { createStandinAnalyzer };
