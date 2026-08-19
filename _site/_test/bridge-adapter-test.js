const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { BridgeAdapter } = require('../lib/bridge-adapter');
const bridgeModule = require('@sanqianx/ai-coding-event-bridge');

(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-bridge-adapter-'));
  const bridgeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-bridge-adapter-home-'));

  // Real facade: the adapter talks to createBridge() only, with an isolated
  // bridge home — never the user's global spool and never PK's data dir.
  const adapter = new BridgeAdapter({ dataDir, bridgeModule, bridgeHomeDir: bridgeHome });
  assert.strictEqual(adapter.isAvailable(), true);

  // v1 identity flows through the adapter into the real journal.
  const repoTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-bridge-adapter-repo-'));
  require('child_process').execSync('git init -q', { cwd: repoTmp, stdio: 'ignore' });
  const identityResult = await adapter.resolveRepoIdentity(repoTmp);
  assert.strictEqual(identityResult.status, 'ok');
  assert.strictEqual(identityResult.repoIdentity.schema, 'repo-identity/v1');
  assert.match(identityResult.repoIdentity.workspaceId, /^sha256:[0-9a-f]{64}$/);

  const baseline = await adapter.getHighWatermark({});
  assert.deepStrictEqual(baseline, { status: 'captured', cursor: 0 });

  await adapter.registerConsumer('project-knowledge', { notifyUrl: 'http://127.0.0.1:9/bridge' });
  const consumer = await adapter.getHealth?.();
  assert.strictEqual(consumer.status, 'ok');
  assert.ok(consumer.health.consumers.some(entry => entry.name === 'project-knowledge'));

  const result = await adapter.appendCommitBoundary({
    projectId: 'project-bridge',
    repoIdentity: identityResult.repoIdentity,
    commitSha: 'a'.repeat(40),
    parentShas: ['b'.repeat(40)],
    branch: 'main',
    committedAt: '2026-08-18T02:00:00.000Z',
    operationId: 'op-boundary-test',
  });
  assert.strictEqual(result.status, 'captured');
  assert.strictEqual(result.boundary.bridgeCursorAtCommit, 1);
  assert.deepStrictEqual(result.boundary.repoIdentity.workspaceId, identityResult.repoIdentity.workspaceId);

  // Consumer APIs through the adapter.
  await adapter.ackConsumerCursor('project-knowledge', 1);
  const acked = await adapter.getHealth();
  assert.strictEqual(acked.health.minConsumerAck, 1);
  const compacted = await adapter.compact({ throughSequence: 1 });
  assert.strictEqual(compacted.status, 'ok');

  // The old PK-only { commonDir } shape must produce a deterministic gap,
  // never a Bridge write.
  const legacy = await adapter.appendCommitBoundary({
    projectId: 'project-legacy',
    repoIdentity: { commonDir: 'D:\\repo\\.git' },
    commitSha: 'c'.repeat(40),
    operationId: 'op-legacy-test',
  });
  assert.strictEqual(legacy.status, 'unavailable');
  assert.strictEqual(legacy.gap.reason, 'repo-identity-legacy-shape');

  const missing = await adapter.appendCommitBoundary({
    projectId: 'project-missing',
    repoIdentity: null,
    commitSha: 'd'.repeat(40),
    operationId: 'op-missing-test',
  });
  assert.strictEqual(missing.status, 'unavailable');
  assert.strictEqual(missing.gap.reason, 'repo-identity-missing');

  // No further journal growth from rejected shapes.
  const after = await adapter.getHighWatermark({});
  assert.strictEqual(after.cursor, 1, 'rejected identities must not append journal records');

  const unavailable = new BridgeAdapter({ dataDir, bridgeModule: {} });
  const gapResult = await unavailable.appendCommitBoundary({
    projectId: 'project-gap',
    repoIdentity: null,
    commitSha: 'e'.repeat(40),
    operationId: 'op-gap-test',
  });
  assert.strictEqual(gapResult.status, 'unavailable');
  assert.strictEqual(gapResult.gap.reason, 'bridge-unavailable');
  const gapsPath = path.join(dataDir, 'runtime', 'conversation-capture-gaps.jsonl');
  const gaps = fs.readFileSync(gapsPath, 'utf8').trim().split(/\r?\n/).map(JSON.parse);
  assert(gaps.some(gap => gap.commitSha === 'e'.repeat(40) && gap.reason === 'bridge-unavailable'));
  assert(!JSON.stringify(gaps).includes('prompt'), 'capture gap diagnostics must not contain conversation bodies');

  console.log('bridge-adapter-test PASS');
})().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
