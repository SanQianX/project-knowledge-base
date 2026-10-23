'use strict';
// P-NAV-VECTOR-ISOLATION-R7 — the live incident path through the fixed wiring.
//
// The 2026-10-23T18:00:54Z overwrite of the real collection
// scope-brain-brain-default happened exactly here: a NAV harness run let the
// real engine keep its constructor-default vectorUrl (the LIVE desktop hub on
// 127.0.0.1:8787), the product registered its brain scope at boot, and the
// engine's syncSharedIndexes wrote the collection at that default.
//
// This probe replays the smallest faithful version: boot the REAL product and
// the REAL engine through the REAL startHarness wiring. The product registers
// the brain-default shared scope by itself (an explicit rebind is refused
// with IMMUTABLE_FIELD, which is itself correct engine behaviour), the
// engine's syncSharedIndexes runs for real, and every scope-index call must
// land on the lane stand-in with sourceDir inside the fixture root. The
// vector module is NOT the subject under test — it is the substituted part
// (see parallel-nav-module-ui.js); the engine, the routes and the routing
// decision stay real.

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const { startHarness } = require('./helpers/parallel-nav-shell');
const { waitFor } = require('./helpers/cdp-browser');

const EVIDENCE = process.env.PK_R7_EVIDENCE_DIR ? path.resolve(process.env.PK_R7_EVIDENCE_DIR) : null;

(async () => {
  const proof = { startedAt: new Date().toISOString() };
  const harness = await startHarness({ tag: 'nav-vector-path' });
  try {
    // The wiring assert already ran inside startHarness; hold the live values
    // as evidence and re-state the two invariants this lane exists for.
    assert.equal(harness.engine.coordinator.vectorUrl, harness.moduleUi.url,
      'the live engine must hold the stand-in URL');
    assert.notEqual(harness.engine.coordinator.vectorUrl, 'http://127.0.0.1:8787',
      'the live-port default must never be the engine vectorUrl');
    assert.equal(harness.engine.coordinator.bridge.url, harness.moduleUi.url,
      'the real engine BridgeClient must also point at the owned fixture');
    assert.deepEqual(await harness.engine.coordinator.bridge.listJournals(), [],
      'a real bridge poll must receive the owned fixture empty journal contract');
    assert.ok(harness.moduleUi.state.requests.some(entry => entry.path === '/api/journals'),
      'the owned fixture must record the engine BridgeClient request');

    // The product registers the brain-default shared scope by itself during
    // boot and the engine indexes it for real — wait for that flow to reach
    // the stand-in (this is the exact flow that wrote the real collection).
    await waitFor(async () => harness.moduleUi.vectorImports().length > 0,
      'the stand-in receiving the boot-time scope-index call', 30000);

    const snapshot = await harness.engineApi('GET', '/api/snapshot');
    assert.equal(snapshot.status, 200, `the engine snapshot must answer: ${JSON.stringify(snapshot.body)}`);
    const brainScope = (snapshot.body.sharedScopes || []).find(scope => scope.id === 'brain-default');
    assert.ok(brainScope, 'the product really registered the brain-default shared scope');
    assert.ok(brainScope.knowledgePath.startsWith(harness.fixture + path.sep),
      `the registered brain scope must live inside the fixture root: ${brainScope.knowledgePath}`);

    const isolation = harness.assertVectorIsolation();
    const incidentImports = harness.moduleUi.vectorImports().filter(entry => entry.body && entry.body.projectName === 'scope-brain-brain-default');
    assert.ok(incidentImports.length >= 1, 'the incident collection name is built and routed by the real engine');
    for (const entry of incidentImports) {
      assert.equal(entry.body.sourceDir, brainScope.knowledgePath,
        'the incident-path sourceDir is the product-registered scope, not a probe value');
      assert.ok(entry.body.sourceDir.startsWith(harness.fixture + path.sep),
        `the incident-path sourceDir must stay inside the fixture root: ${entry.body.sourceDir}`);
    }

    proof.engineVectorUrl = harness.engine.coordinator.vectorUrl;
    proof.engineBridgeUrl = harness.engine.coordinator.bridge.url;
    proof.standInUrl = harness.moduleUi.url;
    proof.fixtureRoot = harness.fixture;
    proof.registeredBrainScope = brainScope.knowledgePath;
    proof.incidentPathCalls = incidentImports.map(entry => ({ route: entry.path, body: entry.body }));
    proof.containment = isolation;
    proof.verdict = 'PASS — the real product registered the brain-default scope on the real engine, and the engine routed the real incident path (scope-brain-brain-default index) to the lane stand-in with every sourceDir inside the fixture root';
  } finally {
    await harness.cleanup();
  }

  proof.finishedAt = new Date().toISOString();
  if (EVIDENCE) {
    fs.mkdirSync(EVIDENCE, { recursive: true });
    fs.writeFileSync(path.join(EVIDENCE, 'vector-path.json'), JSON.stringify(proof, null, 2) + '\n', 'utf8');
  }
  console.log(JSON.stringify(proof, null, 2));
})().catch(error => {
  console.error(String(error && error.stack || error));
  process.exitCode = 1;
});
