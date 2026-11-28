'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { createRequire } = require('node:module');
const { corpus, listen, setup } = require('./helpers/agentic-context-fixture');

async function main() {
  const root = process.env.PKB_CONTEXT_CANDIDATE_ROOT;
  if (!root || !path.isAbsolute(root)) throw new Error('Set PKB_CONTEXT_CANDIDATE_ROOT to the isolated installed host package directory.');
  const installed = fs.realpathSync(root);
  const candidateRequire = createRequire(path.join(installed, 'package.json'));
  const { verifyProductRuntime } = candidateRequire('./src/scripts/verify-product-runtime');
  const verified = verifyProductRuntime(installed);
  const version = candidateRequire('./package.json').version;
  const baselineRoot = process.env.PKB_CONTEXT_BASELINE_HOST_SOURCE || path.resolve(__dirname, '..');
  const baselineRequire = createRequire(path.join(baselineRoot, 'package.json'));
  const engineModule = '@sanqianx/ai-coding-knowledge-engine';
  const baselineVersion = baselineRequire(`${engineModule}/package.json`).version;
  assert.equal(baselineVersion, baselineRequire('./package-lock.json').packages[`node_modules/${engineModule}`]?.version,
    'the baseline installation must match its lockfile');
  assert.notEqual(fs.realpathSync(baselineRequire.resolve(engineModule)), fs.realpathSync(candidateRequire.resolve(engineModule)),
    'the old and candidate engines must come from separate installations');
  const baseline = baselineRequire(engineModule);
  const candidate = candidateRequire(engineModule);
  const fixture = await setup({ createEngineServer: baseline.createEngineServer });
  const item = corpus.cases[0];
  const input = { projectId: fixture.projectId, query: item.queries[0], client: 'codex', scope: 'project', sessionId: 'before' };
  let old;
  try { old = await fixture.request('/api/context', input); }
  finally { await fixture.close(); }
  const statePath = path.join(fixture.root, 'engine', 'engine-state.json');
  const stable = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const offline = http.createServer((req, res) => res.writeHead(503).end());
  const offlineUrl = await listen(offline);
  const next = candidate.createEngineServer({ dataDir: path.dirname(statePath), managed: true, consume: false,
    vectorUrl: offlineUrl, bridgeUrl: offlineUrl, runtimeToken: 'candidate-upgrade-isolated' });
  try {
    await next.ready;
    const endpoint = await listen(next.server);
    const capability = await (await fetch(new URL('/api/context/capabilities', endpoint))).json();
    assert.equal(capability.enabled, false);
    const response = await fetch(new URL('/api/context', endpoint), { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...input, sessionId: 'after', mode: 'adaptive' }) });
    assert.equal(response.status, 200);
    const after = await response.json();
    assert.equal(after.injectionKind, 'index');
    assert.equal(after.prompt, old.prompt);
    const upgraded = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.deepEqual(upgraded.memories, stable.memories);
    assert.deepEqual(upgraded.memoryGroups, stable.memoryGroups);
    assert.deepEqual(upgraded.contextBindings, stable.contextBindings);
    const marked = await fetch(new URL('/api/runtime-context-config', endpoint), { method: 'POST',
      headers: { Authorization: 'Bearer candidate-upgrade-isolated', 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true }) });
    assert.equal(marked.status, 200);
    const fast = await fetch(new URL('/api/context', endpoint), { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...input, sessionId: 'candidate-fast', mode: 'fast' }) });
    const pack = await fast.json();
    assert.equal(pack.delivery.status, 'prepared');
    assert.deepEqual(pack.memories.map(memory => memory.text), [item.memory]);
    console.log(JSON.stringify({ hostVersion: version, modules: Object.fromEntries(Object.entries(verified).map(([key, value]) => [key, value.version])),
      upgrades: { baselineVersion, schema: stable.schemaVersion, memories: stable.memories.length, groups: stable.memoryGroups.length,
        existingContextUnchanged: true, optInWorks: true }, installed: true }));
  } finally {
    await next.close();
    offline.closeAllConnections();
    await new Promise(resolve => offline.close(resolve));
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
