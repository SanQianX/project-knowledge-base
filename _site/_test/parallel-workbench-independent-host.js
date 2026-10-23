'use strict';
// WB-002 — the Workbench module hosted for real, independently of the
// knowledge-base product.
//
// Two independent hosts are started from the REAL installed module (the copy
// the installed product 5.0.24 ships; the repository pin is byte-identical to
// it, proven by parallel-workbench-source-match.js):
//
//   host A (standalone)     no knowledge engine URL, no profile injection:
//                           the module must work with nothing but its own
//                           isolated data directory — the proof that it does
//                           not depend on knowledge-base business objects.
//   host B (integration)    KB_KNOWLEDGE_ENGINE_URL points at this lane's
//                           controlled integration fixture; the module's own
//                           KnowledgeContext contract is verified against
//                           that fixture, separately from the standalone
//                           host. The fixture is a FIXTURE: it stands in for
//                           a knowledge engine and is never counted as real
//                           knowledge or real retrieval.
//
// The model call itself is NOT faked here and is NOT performed here either:
// the real model turn lives in parallel-workbench-model-probe.js, which runs
// one real subscription call through an isolated integration host.
//
// Isolation: every directory, port, HOME and Claude config dir of both hosts
// is isolated; the live product ports are refused; nothing under the real
// product data directories is read for writing or written.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fixture = require('./helpers/parallel-workbench-fixture');
const sourceMap = require('./helpers/parallel-workbench-source-map');

const results = [];
function record(caseId, status, detail) {
  results.push({ caseId, status, detail });
  console.log(`CASE ${caseId} ${status} ${JSON.stringify(detail)}`);
}

async function getJson(url, options) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(30000) });
  const body = await response.json().catch(() => null);
  return { status: response.status, ok: response.ok, body };
}

async function startHost(layout, moduleRoot, port, mode, extraEnv = {}) {
  const child = fixture.spawnNode([path.join(__dirname, 'helpers', 'parallel-workbench-host.js')], fixture.hostEnv(layout, {
    PK_WB_MODULE_ROOT: moduleRoot,
    PK_WB_HOST_PORT: String(port),
    PK_WB_HOST_DATA_DIR: layout.dataDir,
    PK_WB_HOST_WORKSPACE: layout.workspace,
    PK_WB_HOST_MODE: mode,
    ...extraEnv,
  }));
  return child;
}

function snapshotRealProfileDir() {
  // Byte-level in-memory SHA256 snapshot; the digests never leave the process.
  return fixture.digestDirectory(fixture.realWorkbenchProfileDir());
}

(async () => {
  const moduleRoot = fixture.resolveHostModuleRoot();
  assert.ok(moduleRoot, 'no claude-ai-workbench module copy was found to host');
  const identity = sourceMap.packageIdentity(moduleRoot);
  const manifest = sourceMap.loadManifest();
  const moduleRootLabel = moduleRoot === sourceMap.resolveInstalledProductPackage()
    ? 'currently-installed-package:installed-product'
    : moduleRoot === sourceMap.resolveRepoTargetPackage()
      ? 'currently-installed-package:repository-pin'
      : 'explicit-override';
  console.log(`hosting module ${moduleRootLabel} ${identity.name}@${identity.version} from ${moduleRoot}`);

  const realProfilesBefore = snapshotRealProfileDir();
  let standalone;
  let integration;
  let integrationFixture;

  // ---------- host A: standalone independent host -------------------------
  const layoutA = fixture.createIsolationLayout('parallel-wb-indep');
  const portA = await fixture.freePort();
  const baseA = `http://127.0.0.1:${portA}`;
  standalone = await startHost(layoutA, moduleRoot, portA, 'standalone');
  try {
    await fixture.waitForHttp(`${baseA}/api/claude-workbench/v1/health`, 30000);

    const health = await getJson(`${baseA}/api/claude-workbench/v1/health`);
    record('WB-002.a-standalone-health', health.ok && health.body && health.body.status === 'ok' ? 'PASS' : 'FAIL', {
      httpStatus: health.status,
      status: health.body && health.body.status,
      version: health.body && health.body.version,
      apiVersion: health.body && health.body.apiVersion,
      expectVersion: identity.version,
    });
    assert.equal(health.body.status, 'ok');
    assert.equal(health.body.version, identity.version);

    const runtime = await getJson(`${baseA}/api/claude-workbench/v1/runtime`);
    record('WB-002.b-standalone-runtime', runtime.ok && runtime.body && runtime.body.runtime === 'claude-code' ? 'PASS' : 'FAIL', {
      body: runtime.body,
    });
    assert.equal(runtime.body.runtime, 'claude-code');
    assert.equal(runtime.body.transport, 'agent-sdk');

    const agents = await getJson(`${baseA}/api/claude-workbench/v1/agents`);
    const agentIds = agents.body && Array.isArray(agents.body.agents) ? agents.body.agents.map(agent => agent.id) : [];
    record('WB-002.c-standalone-agents', agents.ok && agentIds.includes('claude-code') ? 'PASS' : 'FAIL', { agentIds });
    assert.ok(agentIds.includes('claude-code'), 'the claude-code agent is not listed');

    // No knowledge engine, no profile injection: the module must still serve
    // its own profile and project surfaces from the isolated data directory.
    const profiles = await getJson(`${baseA}/api/claude-workbench/v1/profiles`);
    const profileList = Array.isArray(profiles.body && profiles.body.profiles) ? profiles.body.profiles : [];
    record('WB-002.d-standalone-profiles-isolated', profiles.ok && profileList.length === 0 ? 'PASS' : 'FAIL', {
      profileCount: profileList.length,
      detail: 'the isolated store starts empty; the real profile store is never consulted by the standalone host',
    });
    assert.equal(profileList.length, 0, 'the standalone host must not see real profiles');

    const projects = await getJson(`${baseA}/api/claude-workbench/v1/projects`);
    record('WB-002.e-standalone-projects', projects.ok ? 'PASS' : 'FAIL', { httpStatus: projects.status });
    assert.ok(projects.ok);

    const session = await getJson(`${baseA}/api/claude-workbench/v1/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ context: { contextId: 'wb002-standalone', workspaceRef: 'wb-fixture' } }),
    });
    const created = session.body && session.body.session;
    record('WB-002.f-standalone-session-created', session.status === 201 && created && created.sessionId ? 'PASS' : 'FAIL', {
      httpStatus: session.status,
      sessionId: created && created.sessionId,
      state: created && created.state,
      agentId: created && created.agentId,
      authSource: created && created.authSource,
    });
    assert.equal(session.status, 201);
    assert.ok(created.sessionId);

    // The session must exist with NO knowledge context: the module works
    // without knowledge-base business objects.
    const knowledge = await getJson(`${baseA}/api/claude-workbench/v1/sessions/${encodeURIComponent(created.sessionId)}/knowledge`);
    record('WB-002.g-standalone-no-knowledge-context', knowledge.ok && knowledge.body && knowledge.body.status === 'not-retrieved' ? 'PASS' : 'FAIL', {
      knowledgeStatus: knowledge.body && knowledge.body.status,
      detail: 'no engine URL is configured, so nothing was retrieved — the session still started',
    });
    assert.equal(knowledge.body.status, 'not-retrieved');

    // The session artefacts must live in the ISOLATED data directory.
    await fixture.waitForHttp(`${baseA}/api/claude-workbench/v1/health`, 2000).catch(() => {});
    const isolatedFiles = fs.existsSync(layoutA.dataDir) ? fs.readdirSync(layoutA.dataDir) : [];
    record('WB-002.h-standalone-data-isolated', isolatedFiles.length > 0 ? 'PASS' : 'FAIL', {
      dataDir: layoutA.dataDir,
      entries: isolatedFiles.slice(0, 12),
    });
    assert.ok(isolatedFiles.length > 0, 'the standalone host wrote nothing into its isolated data directory');
  } finally {
    standalone.child.kill();
    await standalone.exited;
  }

  // ---------- host B: integration host + controlled fixture ---------------
  const layoutB = fixture.createIsolationLayout('parallel-wb-integ');
  integrationFixture = await fixture.startIntegrationFixture();
  const portB = await fixture.freePort();
  const baseB = `http://127.0.0.1:${portB}`;
  integration = await startHost(layoutB, moduleRoot, portB, 'integration', {
    PK_WB_ENGINE_URL: integrationFixture.url,
  });
  try {
    await fixture.waitForHttp(`${baseB}/api/claude-workbench/v1/health`, 30000);

    // The integration contract, verified through the module's own
    // KnowledgeContext against this lane's controlled fixture. The fixture is
    // labelled: it is not real knowledge.
    const { KnowledgeContext } = require(path.join(moduleRoot, 'packages', 'server', 'lib', 'knowledge-context.js'));
    const context = new KnowledgeContext({ engineUrl: integrationFixture.url });
    const retrieved = await context.retrieve(layoutB.workspace, 'integration contract probe', 'project', { sessionId: 'wb002-contract' });
    const requestSeen = integrationFixture.requests[integrationFixture.requests.length - 1] || null;
    const promptCarried = String(retrieved.prompt || '').includes(integrationFixture.marker);
    record('WB-002.i-integration-context-contract', retrieved.status === 'ready' && promptCarried && requestSeen ? 'PASS' : 'FAIL', {
      fixtureKind: 'controlled-integration-fixture (stand-in knowledge engine; never counted as real knowledge or real retrieval)',
      engineUrl: integrationFixture.url,
      retrievedStatus: retrieved.status,
      references: retrieved.references ? retrieved.references.length : null,
      memoryCount: retrieved.memoryCount == null ? null : retrieved.memoryCount,
      promptCarriedMarker: promptCarried,
      requestSeenByFixture: requestSeen && {
        method: requestSeen.method,
        url: requestSeen.url,
        client: requestSeen.body && requestSeen.body.client,
        repoPath: requestSeen.body && requestSeen.body.repoPath,
        query: requestSeen.body && requestSeen.body.query,
        sessionId: requestSeen.body && requestSeen.body.sessionId,
      },
    });
    assert.equal(retrieved.status, 'ready');
    assert.ok(promptCarried, 'the retrieved prompt did not carry the fixture marker');
    assert.equal(requestSeen.body.client, 'workbench', 'the module did not identify itself as the workbench client');

    // The integration host itself must still create sessions; its knowledge
    // surface stays empty until a real turn retrieves through the engine.
    const session = await getJson(`${baseB}/api/claude-workbench/v1/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ context: { contextId: 'wb002-integration', workspaceRef: 'wb-fixture' } }),
    });
    const created = session.body && session.body.session;
    record('WB-002.j-integration-session-created', session.status === 201 && created && created.sessionId ? 'PASS' : 'FAIL', {
      httpStatus: session.status,
      sessionId: created && created.sessionId,
    });
    assert.equal(session.status, 201);
  } finally {
    integration.child.kill();
    await integration.exited;
    await integrationFixture.close();
  }

  // ---------- the real product surfaces stayed untouched -------------------
  const realProfilesAfter = snapshotRealProfileDir();
  const digestComparison = fixture.compareDigests(realProfilesBefore, realProfilesAfter);
  record('WB-002.k-real-profiles-untouched', digestComparison.byteIdentical ? 'PASS' : 'FAIL', {
    profileDir: fixture.realWorkbenchProfileDir(),
    comparison: 'byte-level SHA256, computed in memory; digests are never printed, logged or persisted',
    fileCount: digestComparison.count,
    changedFiles: digestComparison.changedFiles,
    addedFiles: digestComparison.addedFiles,
    removedFiles: digestComparison.removedFiles,
  });
  assert.ok(digestComparison.byteIdentical, 'the real workbench profile directory changed during the run (byte-level comparison)');

  const summary = {
    lane: 'test-workbench',
    file: 'parallel-workbench-independent-host.js',
    case: 'WB-002',
    title: '独立宿主',
    module: { label: moduleRootLabel, root: moduleRoot, name: identity.name, version: identity.version, manifestVersion: manifest.terminal.version },
    hosts: {
      standalone: { port: portA, dataDir: layoutA.dataDir, workspace: layoutA.workspace, mode: 'standalone' },
      integration: { port: portB, dataDir: layoutB.dataDir, workspace: layoutB.workspace, mode: 'integration', engineUrl: integrationFixture.url, fixtureKind: 'controlled-integration-fixture' },
    },
    modelCallPerformedHere: false,
    modelProbe: 'parallel-workbench-model-probe.js',
    networkUsed: false,
    forbiddenPortsAvoided: [...fixture.FORBIDDEN_PORTS],
    cases: results,
  };

  const target = process.env.PARALLEL_WORKBENCH_EVIDENCE;
  if (target) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(summary, null, 2), 'utf8');
  }
  fixture.removeTree(layoutA.root);
  fixture.removeTree(layoutB.root);
  console.log('parallel-workbench-independent-host PASS');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
