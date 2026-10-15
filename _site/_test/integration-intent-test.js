'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SCHEMA, readIntent, markIntent, bootstrapIntent, summarizeClient } = require('../lib/integration-intent');

const tmpDataDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kb-intent-'));
const intentPath = dataDir => path.join(dataDir, 'integration-intent.json');

// A: markIntent merges atomically and readIntent round-trips.
{
  const dir = tmpDataDir();
  const first = markIntent(dir, 'claude', 'connected');
  assert.deepEqual(first, { schema: SCHEMA, clients: { claude: 'connected' } });
  const second = markIntent(dir, 'codex', 'disconnected');
  assert.deepEqual(second, { schema: SCHEMA, clients: { claude: 'connected', codex: 'disconnected' } });
  assert.deepEqual(readIntent(dir), { schema: SCHEMA, clients: { claude: 'connected', codex: 'disconnected' } });
  assert.deepEqual(fs.readdirSync(dir), ['integration-intent.json'], 'atomic write must not leave temp files behind');
  assert.throws(() => markIntent(dir, 'claude', 'sometimes'), 'invalid states must throw');
  assert.equal(readIntent(tmpDataDir()), null, 'missing file reads as null');
  const corrupt = tmpDataDir();
  fs.writeFileSync(intentPath(corrupt), '{ not json');
  assert.equal(readIntent(corrupt), null, 'corrupt file reads as null');
  const foreign = tmpDataDir();
  fs.writeFileSync(intentPath(foreign), JSON.stringify({ schema: 'someone-else/v9', clients: { claude: 'connected' } }));
  assert.equal(readIntent(foreign), null, 'schema mismatch reads as null');
  const unknown = tmpDataDir();
  fs.writeFileSync(intentPath(unknown), JSON.stringify({ schema: SCHEMA, clients: { claude: 'connected', codex: 'weird-state' } }));
  assert.deepEqual(readIntent(unknown), { schema: SCHEMA, clients: { claude: 'connected' } }, 'unknown client values are dropped');
}
// B: bootstrapIntent only fills gaps and never rewrites decisions.
{
  const dir = tmpDataDir();
  markIntent(dir, 'claude', 'disconnected');
  const clientsStatus = [
    { client: 'claude', developmentCapture: { installed: true } },
    { client: 'codex', developmentCapture: { installed: true } },
    { client: 'zcode', developmentCapture: { installed: false } },
  ];
  const bootstrapped = bootstrapIntent(dir, clientsStatus);
  assert.deepEqual(bootstrapped, { schema: SCHEMA, clients: { claude: 'disconnected', codex: 'connected', zcode: 'disconnected' } }, 'existing entries are never overwritten');
  const before = fs.statSync(intentPath(dir)).mtimeMs;
  bootstrapIntent(dir, clientsStatus);
  assert.equal(fs.statSync(intentPath(dir)).mtimeMs, before, 'no-change bootstrap must not rewrite the file');
  const fresh = tmpDataDir();
  const created = bootstrapIntent(fresh, [{ client: 'codex', developmentCapture: { installed: false } }]);
  assert.deepEqual(created, { schema: SCHEMA, clients: { codex: 'disconnected' } });
  assert.deepEqual(readIntent(fresh), created, 'bootstrap creates the file when missing');
}
// C: summarizeClient covers all five states plus precedence rules.
{
  const failedRepair = { claude: { state: 'failed', at: new Date().toISOString(), error: 'boom' } };
  assert.equal(summarizeClient({ client: 'claude', available: true, developmentCapture: { state: 'checking' } }, null), 'checking');
  assert.equal(summarizeClient({ client: 'claude', available: true, developmentCapture: {}, knowledgeIntegration: { state: 'checking' } }, null), 'checking');
  assert.equal(summarizeClient({ client: 'claude', available: false, developmentCapture: { state: 'checking' } }, null), 'checking', 'checking wins over not-detected');
  assert.equal(summarizeClient({ client: 'claude', available: false, configFound: false, developmentCapture: {} }, null), 'not-detected');
  assert.equal(summarizeClient({ client: 'claude', available: false, configFound: true, developmentCapture: {} }, null), 'disconnected', 'configFound alone counts as detected');
  assert.equal(summarizeClient({ client: 'claude', available: true, developmentCapture: { installed: true } }, failedRepair), 'connected', 'installed outranks a failed repair');
  assert.equal(summarizeClient({ client: 'claude', available: true, developmentCapture: {} }, failedRepair), 'error');
  assert.equal(summarizeClient({ client: 'claude', available: true, developmentCapture: {} }, null), 'disconnected');
}
console.log('integration intent test PASS');
