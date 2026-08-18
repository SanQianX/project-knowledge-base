const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { BridgeAdapter } = require('../lib/bridge-adapter');

(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-bridge-adapter-'));
  const calls = [];
  const bridge = {
    async getHighWatermark(input) { calls.push({ method: 'getHighWatermark', input }); return { cursor: 40 }; },
    async appendCommitBoundary(input) {
      calls.push({ method: 'appendCommitBoundary', input });
      return { sequence: 41, bridgeCursorAtCommit: 41, openTurnIdsAtCommit: ['turn-open'] };
    },
    getCursor() { throw new Error('consumer must not compose a non-atomic cursor + append sequence'); },
  };
  const adapter = new BridgeAdapter({ dataDir, bridgeModule: bridge });
  const baseline = await adapter.getHighWatermark({ repoIdentity: { commonDir: '/repo/.git' } });
  assert.deepStrictEqual(baseline, { status: 'captured', cursor: 40 });
  const result = await adapter.appendCommitBoundary({
    projectId: 'project-bridge',
    repoIdentity: { commonDir: '/repo/.git' },
    commitSha: 'a'.repeat(40),
    parentShas: ['b'.repeat(40)],
    branch: 'main',
    committedAt: '2026-08-18T02:00:00.000Z',
    operationId: 'op-boundary-test',
  });
  assert.strictEqual(result.status, 'captured');
  assert.strictEqual(result.boundary.bridgeCursorAtCommit, 41);
  assert.deepStrictEqual(result.boundary.openTurnIdsAtCommit, ['turn-open']);
  assert.strictEqual(calls.filter(call => call.method === 'appendCommitBoundary').length, 1, 'consumer must use the one atomic Bridge boundary API');

  const unavailable = new BridgeAdapter({ dataDir, bridgeModule: {} });
  const gapResult = await unavailable.appendCommitBoundary({
    projectId: 'project-gap',
    repoIdentity: null,
    commitSha: 'c'.repeat(40),
    operationId: 'op-gap-test',
  });
  assert.strictEqual(gapResult.status, 'unavailable');
  assert.strictEqual(gapResult.gap.reason, 'bridge-unavailable');
  const gapsPath = path.join(dataDir, 'runtime', 'conversation-capture-gaps.jsonl');
  const gaps = fs.readFileSync(gapsPath, 'utf8').trim().split(/\r?\n/).map(JSON.parse);
  assert(gaps.some(gap => gap.commitSha === 'c'.repeat(40) && gap.reason === 'bridge-unavailable'));
  assert(!JSON.stringify(gaps).includes('prompt'), 'capture gap diagnostics must not contain conversation bodies');

  console.log('bridge-adapter-test PASS');
})().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
