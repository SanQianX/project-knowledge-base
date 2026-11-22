'use strict';
// WB-002/WB-001 offline regression — the portable, zero-network slice.
//
// Collected by run-all-tests.js (suffix -test.js). Everything here must hold
// on a bare CI runner:
//   * the hosted module is the REPOSITORY PIN (node_modules/claude-ai-workbench)
//     — never the machine-local installed product and never a D:-only path;
//   * no account, no real profile, no credential: the standalone host runs on
//     its own empty isolated store and the integration host talks only to this
//     test's controlled localhost fixture;
//   * no paid model turn — the real subscription conversations live in
//     parallel-workbench-standalone-turn.js and parallel-workbench-model-probe.js,
//     which are explicitly invoked and NEVER collected by the runner;
//   * budget: the whole file must finish well under 90s.
//
// When the claude CLI is absent (CI), the session-creation sub-checks degrade
// to an explicit SKIPPED_NO_CLI record instead of a false failure; hosting,
// health, agents, isolated profile store and the integration contract are
// asserted unconditionally.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fixture = require('./helpers/parallel-workbench-fixture');
const sourceMap = require('./helpers/parallel-workbench-source-map');

const BUDGET_MS = 90000;
const startedAt = Date.now();
const results = [];
function record(caseId, status, detail) {
  results.push({ caseId, status, detail });
  console.log(`CASE ${caseId} ${status} ${JSON.stringify(detail)}`);
}

async function getJson(url, options) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(20000) });
  const body = await response.json().catch(() => null);
  return { status: response.status, ok: response.ok, body };
}

async function startHost(layout, moduleRoot, port, mode, extraEnv = {}) {
  return fixture.spawnNode([path.join(__dirname, 'helpers', 'parallel-workbench-host.js')], fixture.hostEnv(layout, {
    PK_WB_MODULE_ROOT: moduleRoot,
    PK_WB_HOST_PORT: String(port),
    PK_WB_HOST_DATA_DIR: layout.dataDir,
    PK_WB_HOST_WORKSPACE: layout.workspace,
    PK_WB_HOST_MODE: mode,
    ...extraEnv,
  }));
}

(async () => {
  // The repository pin only — the machine-local installed product is
  // deliberately NOT consulted, so the test stays portable.
  const moduleRoot = sourceMap.resolveRepoTargetPackage();
  assert.ok(moduleRoot, 'the repository pin node_modules/claude-ai-workbench was not found — run npm install');
  const pinVersion = JSON.parse(fs.readFileSync(path.join(moduleRoot, 'packages', 'server', 'package.json'), 'utf8')).version;
  const manifest = sourceMap.loadManifest();
  record('WB-OFF.a-pin-identity', manifest.terminal.version === pinVersion ? 'PASS' : 'FAIL', {
    moduleRoot,
    pinVersion,
    manifestVersion: manifest.terminal.version,
  });
  assert.equal(manifest.terminal.version, pinVersion, 'the repository pin and the runtime manifest disagree');

  // ---------- standalone host: no engine, no profiles, no account ----------
  const layoutA = fixture.createIsolationLayout('parallel-wb-off');
  const portA = await fixture.freePort();
  const baseA = `http://127.0.0.1:${portA}`;
  const standalone = await startHost(layoutA, moduleRoot, portA, 'standalone');
  let cliAvailable = null;
  try {
    await fixture.waitForHttp(`${baseA}/api/claude-workbench/v1/health`, 30000);
    const health = await getJson(`${baseA}/api/claude-workbench/v1/health`);
    record('WB-OFF.b-standalone-health', health.ok && health.body && health.body.status === 'ok' && health.body.version === pinVersion ? 'PASS' : 'FAIL', {
      status: health.body && health.body.status,
      version: health.body && health.body.version,
      expectVersion: pinVersion,
    });
    assert.equal(health.body.status, 'ok');
    assert.equal(health.body.version, pinVersion);

    const runtime = await getJson(`${baseA}/api/claude-workbench/v1/runtime`);
    cliAvailable = Boolean(runtime.body && runtime.body.available);
    record('WB-OFF.c-standalone-runtime', runtime.ok && runtime.body && runtime.body.runtime === 'claude-code' ? 'PASS' : 'FAIL', {
      runtime: runtime.body && runtime.body.runtime,
      transport: runtime.body && runtime.body.transport,
      cliAvailable,
      note: 'cliAvailable may be false on a bare CI runner; only the runtime name is asserted',
    });
    assert.equal(runtime.body.runtime, 'claude-code');

    const agents = await getJson(`${baseA}/api/claude-workbench/v1/agents`);
    const agentIds = agents.body && Array.isArray(agents.body.agents) ? agents.body.agents.map(agent => agent.id) : [];
    record('WB-OFF.d-standalone-agents', agents.ok && agentIds.includes('claude-code') ? 'PASS' : 'FAIL', { agentIds });
    assert.ok(agentIds.includes('claude-code'));

    const profiles = await getJson(`${baseA}/api/claude-workbench/v1/profiles`);
    const profileCount = Array.isArray(profiles.body && profiles.body.profiles) ? profiles.body.profiles.length : -1;
    record('WB-OFF.e-standalone-profiles-empty', profiles.ok && profileCount === 0 ? 'PASS' : 'FAIL', { profileCount });
    assert.equal(profileCount, 0, 'the isolated profile store must start empty');

    if (cliAvailable) {
      const session = await getJson(`${baseA}/api/claude-workbench/v1/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ context: { contextId: 'wb-off-standalone', workspaceRef: 'wb-fixture' } }),
      });
      const created = session.body && session.body.session;
      record('WB-OFF.f-standalone-session', session.status === 201 && created && created.sessionId ? 'PASS' : 'FAIL', {
        httpStatus: session.status,
        sessionId: created && created.sessionId,
      });
      assert.equal(session.status, 201);
      const knowledge = await getJson(`${baseA}/api/claude-workbench/v1/sessions/${encodeURIComponent(created.sessionId)}/knowledge`);
      record('WB-OFF.g-standalone-knowledge-none', knowledge.ok && knowledge.body && ['disabled', 'not-retrieved'].includes(knowledge.body.status) ? 'PASS' : 'FAIL', {
        knowledgeStatus: knowledge.body && knowledge.body.status,
      });
      assert.ok(['disabled', 'not-retrieved'].includes(knowledge.body.status));
    } else {
      record('WB-OFF.f-standalone-session', 'SKIPPED_NO_CLI', { cliAvailable, reason: 'the claude CLI is not available in this environment; session creation is not asserted offline' });
      record('WB-OFF.g-standalone-knowledge-none', 'SKIPPED_NO_CLI', { cliAvailable });
    }
  } finally {
    standalone.child.kill();
    await standalone.exited;
  }

  // ---------- integration host + controlled fixture (localhost only) -------
  const layoutB = fixture.createIsolationLayout('parallel-wb-offint');
  const integrationFixture = await fixture.startIntegrationFixture();
  const portB = await fixture.freePort();
  const baseB = `http://127.0.0.1:${portB}`;
  const integration = await startHost(layoutB, moduleRoot, portB, 'integration', { PK_WB_ENGINE_URL: integrationFixture.url });
  try {
    await fixture.waitForHttp(`${baseB}/api/claude-workbench/v1/health`, 30000);
    const { KnowledgeContext } = require(path.join(moduleRoot, 'packages', 'server', 'lib', 'knowledge-context.js'));
    const context = new KnowledgeContext({ engineUrl: integrationFixture.url });
    const retrieved = await context.retrieve(layoutB.workspace, 'offline integration contract probe', 'project', { sessionId: 'wb-off-contract' });
    const requestSeen = integrationFixture.requests[integrationFixture.requests.length - 1] || null;
    const promptCarried = String(retrieved.prompt || '').includes(integrationFixture.marker);
    record('WB-OFF.h-integration-contract', retrieved.status === 'ready' && promptCarried && requestSeen ? 'PASS' : 'FAIL', {
      fixtureKind: 'controlled-integration-fixture (localhost stand-in; never counted as real knowledge)',
      retrievedStatus: retrieved.status,
      promptCarriedMarker: promptCarried,
      client: requestSeen && requestSeen.body && requestSeen.body.client,
    });
    assert.equal(retrieved.status, 'ready');
    assert.ok(promptCarried);
    assert.equal(requestSeen.body.client, 'workbench');
  } finally {
    integration.child.kill();
    await integration.exited;
    await integrationFixture.close();
  }

  fixture.removeTree(layoutA.root);
  fixture.removeTree(layoutB.root);

  const elapsed = Date.now() - startedAt;
  record('WB-OFF.i-budget', elapsed < BUDGET_MS ? 'PASS' : 'FAIL', { elapsedMs: elapsed, budgetMs: BUDGET_MS });
  assert.ok(elapsed < BUDGET_MS, `the offline slice exceeded its ${BUDGET_MS}ms budget: ${elapsed}ms`);

  const failures = results.filter(entry => entry.status === 'FAIL');
  console.log(`parallel-workbench-offline-test ${failures.length === 0 ? 'PASS' : 'FAIL'} (${results.filter(r => r.status === 'PASS').length} pass, ${failures.length} fail, ${results.filter(r => r.status.startsWith('SKIPPED')).length} skipped) in ${elapsed}ms`);
  if (failures.length) process.exitCode = 1;
})().catch(error => {
  console.error(error);
  process.exit(1);
});
