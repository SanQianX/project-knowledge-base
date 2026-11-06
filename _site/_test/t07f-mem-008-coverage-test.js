// _site/_test/t07f-mem-008-coverage-test.js
//
// T07F ledger coverage for MEM-008 来源边界 (memory candidate provenance):
//
//   steps:   委派Agent指令/系统维护输出诱发记忆候选。
//   expected: 不得自动当作人类长期偏好。/ C01未解决项明确阻断。
//
// The behaviour under test is the REAL vendored engine's MemoryEligibility
// gate (_modules/knowledge-engine/src/memory-eligibility.js): every candidate
// must be vouched for by a conversation snapshot that is bound to THIS run's
// promoted evidence references, and the quoted source event must be HUMAN
// input with a matching content hash. Delegated-agent instructions and
// system/maintenance outputs are refused with explicit codes; an unresolved
// provenance chain (the C01-class boundary case) blocks explicitly instead
// of admitting silently.

'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const crypto = require('node:crypto');

const REPO = path.resolve(__dirname, '..', '..');
const { MemoryEligibility } = require(path.join(REPO, '_modules', 'knowledge-engine', 'src', 'memory-eligibility.js'));

const sha = text => crypto.createHash('sha256').update(text).digest('hex');

const HUMAN_TEXT = '我以后所有项目的提交信息都用中文写,这是我自己的长期习惯。';
const AGENT_TEXT = '以最小改动修复该测试,不要重构。';
const SYSTEM_TEXT = '索引重建完成:重建了 3 个项目的知识索引。';

const snapshot = {
  snapshotHash: 'snap-1',
  turns: [{
    userEvents: [
      { eventId: 'ev-human', inputOrigin: 'human', content: HUMAN_TEXT, contentHash: sha(HUMAN_TEXT) },
      { eventId: 'ev-agent', inputOrigin: 'agent', content: AGENT_TEXT, contentHash: sha(AGENT_TEXT) },
      { eventId: 'ev-system', inputOrigin: 'system', content: SYSTEM_TEXT, contentHash: sha(SYSTEM_TEXT) },
    ],
  }],
};

function runWith(refs) {
  return { projectId: 'p1', commitSha: 'c1', staging: { operations: [{ evidenceReferences: refs }] } };
}
const candidate = over => ({
  text: HUMAN_TEXT,
  quote: HUMAN_TEXT,
  sourceEventId: 'ev-human',
  sourceHash: sha(HUMAN_TEXT),
  eligibility: { durable: true, crossProject: true, reason: 'owner-stated long-term habit', scopeReason: 'applies across all projects' },
  scopeType: 'global',
  ...over,
});

function main() {
  const gate = new MemoryEligibility({ readSnapshot: () => snapshot });
  const boundRun = runWith(['conversation:snap-1']);

  // 1. A delegated-agent instruction can never become a long-term preference.
  const agentClaim = gate.verify(
    candidate({ text: AGENT_TEXT, quote: AGENT_TEXT, sourceEventId: 'ev-agent', sourceHash: sha(AGENT_TEXT) }),
    gate.resolve(boundRun), 'p1');
  assert.ok(agentClaim.ok === false && agentClaim.code === 'SOURCE_NOT_HUMAN',
    `QA-SPEC-MEM-008: a delegated-agent instruction is refused as a memory source (${agentClaim.code})`);

  // 2. System/maintenance output likewise.
  const systemClaim = gate.verify(
    candidate({ text: SYSTEM_TEXT, quote: SYSTEM_TEXT, sourceEventId: 'ev-system', sourceHash: sha(SYSTEM_TEXT) }),
    gate.resolve(boundRun), 'p1');
  assert.ok(systemClaim.ok === false && systemClaim.code === 'SOURCE_NOT_HUMAN',
    `QA-SPEC-MEM-008: system maintenance output is refused as a memory source (${systemClaim.code})`);

  // 3. The C01-class unresolved chain: no conversation boundary reference (or
  // a reference to a foreign snapshot) resolves -> SNAPSHOT_UNAVAILABLE, an
  // EXPLICIT block, never a silent admission.
  const unresolvedRun = runWith([]); // boundary record never persisted/linked
  assert.strictEqual(gate.resolve(unresolvedRun), null,
    'QA-SPEC-MEM-008: a run without a persisted conversation boundary resolves NO snapshot');
  const foreignRun = runWith(['conversation:some-other-hash']);
  assert.strictEqual(gate.resolve(foreignRun), null,
    'QA-SPEC-MEM-008: a foreign/later-frozen snapshot can never vouch for this claim');
  const blocked = gate.verify(candidate({}), gate.resolve(unresolvedRun), 'p1');
  assert.ok(blocked.ok === false && blocked.code === 'SNAPSHOT_UNAVAILABLE',
    `QA-SPEC-MEM-008: the unresolved C01-class chain blocks the candidate EXPLICITLY (${blocked.code})`);

  // 4. Hash/quote chain integrity.
  const hashMismatch = gate.verify(candidate({ sourceHash: 'deadbeef' }), gate.resolve(boundRun), 'p1');
  assert.ok(hashMismatch.code === 'SOURCE_HASH_MISMATCH', 'QA-SPEC-MEM-008: a rewritten source is refused (hash mismatch)');
  const quoteMismatch = gate.verify(candidate({ quote: '从未说过的偏好' }), gate.resolve(boundRun), 'p1');
  assert.ok(quoteMismatch.code === 'QUOTE_NOT_IN_SOURCE', 'QA-SPEC-MEM-008: a fabricated quote is refused');

  // 5. Positive control: the real human sentence with its frozen chain passes.
  const ok = gate.verify(candidate({}), gate.resolve(boundRun), 'p1');
  assert.ok(ok.ok === true, `QA-SPEC-MEM-008: a genuine human long-term preference with a verified chain passes (${JSON.stringify(ok)})`);

  console.log('QA-SPEC-MEM-008: agent/system sources refused; unresolved provenance blocks explicitly; genuine human chain passes');
  console.log('t07f-mem-008-coverage-test PASS');
}

main();
