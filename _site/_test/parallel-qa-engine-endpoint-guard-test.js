'use strict';
// _site/_test/parallel-qa-engine-endpoint-guard-test.js — P-QA-ENGINE-ENDPOINT-FIX-R5
//
// Safety regression for the engine endpoint lane. The original defect: tests
// constructed engines WITHOUT vectorUrl/bridgeUrl, and the coordinator falls
// back to hardcoded LIVE ports (127.0.0.1:8787 / :8790) regardless of env, so
// confirm/scopes-sync/index/search chains dialed LIVE services. This test
// reproduces every one of those chains while an egress guard blocks protected
// ports BEFORE any I/O — no socket is ever opened toward 5757/5760/5789/5790/
// 8787/8790. The positive leg runs the same chains against an OWN ephemeral
// vector stand-in and asserts the actual requests arrived there (fixture-side
// records, independent expected origin).
//
// P-QA-ENGINE-ENDPOINT-REVIEW-R6 legs, appended after the R5 legs:
//   D. IPv6 alignment — the egress judge accepts the bracketed [::1] form of
//      URL.hostname (the same form assertOwnedEndpoint accepts), proven with a
//      STUBBED original fetch so no real IPv6 socket is ever opened;
//   E. PSModuleAnalysisCachePath file shape — parent materialized, target
//      never a directory, and a REAL PowerShell child that writes its own
//      cache file under the isolated root while seeing only the isolated
//      home (its own echoed env is the evidence; no browser involved);
//   F. offline POSIX socket-budget string contract — the CI-long root shape
//      is rejected, the short POSIX components hold with margin, the boundary
//      is exact, and accounting is UTF-8 bytes. Windows cannot prove Linux:
//      actual Linux proof stays with CI; this leg proves the byte math.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  applyDriverIsolation, childEnv, LIVE_HOME,
  POSIX_SOCKET_CHAR_LIMIT, worstCaseSocketPaths, socketBudgetVerdict, assertSocketBudget,
} = require('./helpers/parallel-qa-engine-endpoint-isolate');
const {
  REFUSAL_CODE, EGRESS_BLOCK_CODE, PROTECTED_PORTS,
  assertOwnedEndpoint, guardedCreateEngineServer, installEgressGuard,
  createEngineVectorStandin, createEngineBridgeDouble,
} = require('./helpers/parallel-qa-engine-endpoint-guard');

(async () => {
  const applied = applyDriverIsolation({ prefix: 'pk-qa-engine-endpoint-guard' });
  const mkdtemp = name => fs.mkdtempSync(path.join(applied.layout.temp, `${name}-`));
  // Shared-index jobs run on a serialized queue and may chain dirty reruns, so
  // awaiting one job promise does not prove the observable effect landed. Wait
  // bounded on the effect itself.
  async function waitFor(predicate, label, timeoutMs = 5000) {
    const started = Date.now();
    while (!predicate()) {
      if (Date.now() - started > timeoutMs) throw new Error(`timeout waiting for: ${label}`);
      await new Promise(resolve => setImmediate(resolve));
    }
  }
  const guard = installEgressGuard();
  let negativeEngine = null, positiveEngine = null, standin = null;
  try {
    // ── Leg A: fail-closed constructor refusals (product code never loads) ──
    for (const [label, build] of [
      ['missing vectorUrl', () => guardedCreateEngineServer({})],
      ['null vectorUrl', () => guardedCreateEngineServer({ vectorUrl: null })],
      ['missing bridge leg', () => guardedCreateEngineServer({ vectorUrl: 'http://127.0.0.1:41234' })],
      ['live vectorUrl 8787', () => guardedCreateEngineServer({ vectorUrl: 'http://127.0.0.1:8787', bridgeUrl: 'http://127.0.0.1:41235' })],
      ['live bridgeUrl 8790', () => guardedCreateEngineServer({ vectorUrl: 'http://127.0.0.1:41236', bridgeUrl: 'http://127.0.0.1:8790' })],
      ['non-loopback vectorUrl', () => guardedCreateEngineServer({ vectorUrl: 'http://10.9.8.7:41237', bridgeUrl: 'http://127.0.0.1:41238' })],
      ['non-loopback bridgeUrl', () => guardedCreateEngineServer({ vectorUrl: 'http://127.0.0.1:41239', bridgeUrl: 'http://example.test:9' })],
      ['port 0 vectorUrl', () => guardedCreateEngineServer({ vectorUrl: 'http://127.0.0.1:0', bridgeUrl: 'http://127.0.0.1:41240' })],
      ['https vectorUrl', () => guardedCreateEngineServer({ vectorUrl: 'https://127.0.0.1:41241', bridgeUrl: 'http://127.0.0.1:41242' })],
      ['non-http scheme', () => assertOwnedEndpoint('ws://127.0.0.1:41243', { role: 'vectorUrl' })],
    ]) assert.throws(build, error => error.code === REFUSAL_CODE, `refusal: ${label}`);
    for (const port of PROTECTED_PORTS) assert.throws(() => assertOwnedEndpoint(`http://127.0.0.1:${port}`, { role: 'vectorUrl' }), error => error.code === REFUSAL_CODE, `refusal: protected port ${port}`);
    const probeUrl = assertOwnedEndpoint('http://127.0.0.1:41244/foo', { role: 'vectorUrl' });
    assert.equal(probeUrl.port, '41244');

    // Egress guard blocks non-loopback targets pre-I/O as well.
    await assert.rejects(() => fetch('https://registry.npmjs.org/never-requested-r5'), error => error.code === EGRESS_BLOCK_CODE && error.reason === 'non-loopback-host:registry.npmjs.org');

    // ── Leg B: negative regression — the ORIGINAL defect, safely held ──
    // Raw product constructor without vectorUrl (exactly the S1/S2/S3 shape).
    const { createEngineServer } = require('../../_modules/knowledge-engine/src/server');
    const negRoot = mkdtemp('neg');
    const negBrainDir = path.join(negRoot, 'brain-shared');
    fs.mkdirSync(negBrainDir, { recursive: true });
    fs.writeFileSync(path.join(negBrainDir, 'note.md'), '# 共享知识\n\n负向回归锚点：缺省构造不得触碰 LIVE 端口。\n');
    negativeEngine = createEngineServer({ dataDir: path.join(negRoot, 'engine'), consume: false, runtimeToken: 'r5-guard-neg' });
    await negativeEngine.ready;
    assert.equal(negativeEngine.coordinator.vectorUrl, 'http://127.0.0.1:8787', 'negative leg must model the defect: hardcoded LIVE fallback');

    // S3 chain: scopes sync → shared index import at LIVE 8787 — blocked pre-I/O.
    await negativeEngine.coordinator.memories.configure([{ id: 'brain-r5', kind: 'brain', brainId: 'brain-r5', knowledgePath: negBrainDir }]);
    const negScope = negativeEngine.store.state.sharedScopes.find(scope => scope.id === 'brain-r5');
    await negativeEngine.coordinator.indexSharedScope(negScope);
    assert.equal(negScope.index.status, 'pending', 'blocked import must leave the shared index pending');
    assert.equal(negScope.index.error.details.upstreamCode, EGRESS_BLOCK_CODE);

    // S1/S2 chain: manual memory confirm → materialize → onMaterialized → import.
    const negMemory = await negativeEngine.coordinator.memories.create({ text: '负向回归：确认流必须在 LIVE 8787 之前被拦截', brainId: 'brain-r5' });
    assert.equal(negMemory.status, 'confirmed');
    await waitFor(() => guard.blocked.filter(entry => entry.href === 'http://127.0.0.1:8787/api/import').length >= 2, 'confirm chain attempting LIVE import while blocked');
    // index() chain: run maintenance index → /api/sync at LIVE 8787.
    fs.mkdirSync(path.join(negRoot, 'knowledge'), { recursive: true });
    negativeEngine.store.addProject({ projectId: 'proj-neg', repoPath: path.join(negRoot, 'code'), knowledgePath: path.join(negRoot, 'knowledge') });
    const negRun = negativeEngine.store.addRun({ projectId: 'proj-neg', commitSha: 'a'.repeat(40), trigger: 'manual' });
    await negativeEngine.coordinator.index(negRun);
    const blockedNegRun = negativeEngine.store.getRun(negRun.runId);
    assert.equal(blockedNegRun.state, 'index-pending');
    assert.equal(blockedNegRun.error.details.upstreamCode, EGRESS_BLOCK_CODE);
    // search chain: recallIndex would GET /api/search at LIVE 8787 — blocked too.
    const negSearch = await negativeEngine.coordinator.retrieval.search({ projectId: 'proj-neg', query: '向量索引守护与导入契约' });
    assert.deepEqual(negSearch.retrievalModes, ['lexical'], 'blocked vector must degrade to lexical, never fake success');

    const blockedImports = guard.blocked.filter(entry => entry.href === 'http://127.0.0.1:8787/api/import');
    assert.ok(blockedImports.length >= 2, `expected the configure+confirm chains to attempt LIVE import at least twice (got ${blockedImports.length})`);
    assert.ok(guard.blocked.some(entry => entry.href === 'http://127.0.0.1:8787/api/sync'), 'index() chain must attempt LIVE sync');
    assert.ok(guard.blocked.some(entry => entry.href.startsWith('http://127.0.0.1:8787/api/search')), 'search chain must attempt LIVE search');
    assert.ok(guard.blocked.every(entry => entry.reason.startsWith('protected-port:') || entry.reason.startsWith('non-loopback-host:')), 'every block must name a protected port or a non-loopback host');
    assert.ok(guard.requests.every(entry => !/:87(87|90)|:57(57|60|89|90)/.test(entry.href)), 'no protected-port request may ever be passed through');

    // ── Leg C: positive proof at the OWN stand-in ──
    standin = createEngineVectorStandin();
    const standinUrl = await standin.ready;
    const bridgeDouble = createEngineBridgeDouble();
    const posRoot = mkdtemp('pos');
    const posBrainDir = path.join(posRoot, 'brain-shared');
    fs.mkdirSync(posBrainDir, { recursive: true });
    fs.writeFileSync(path.join(posBrainDir, 'note.md'), '# 共享知识\n\n正向证明锚点。\n');
    fs.mkdirSync(path.join(posRoot, 'knowledge'), { recursive: true });
    const blockedBeforePositive = guard.blocked.length;
    positiveEngine = guardedCreateEngineServer({ dataDir: path.join(posRoot, 'engine'), consume: false, runtimeToken: 'r5-guard-pos', vectorUrl: standinUrl, bridge: bridgeDouble });
    await positiveEngine.ready;
    assert.equal(positiveEngine.coordinator.vectorUrl, standinUrl);
    const importCount = () => standin.records.filter(record => record.method === 'POST' && record.path === '/api/import').length;

    // Scopes sync imports at the OWN stand-in, and the recorded origin (server
    // side) — not a driver-echoed value — proves where the request landed.
    await positiveEngine.coordinator.memories.configure([{ id: 'brain-pos', kind: 'brain', brainId: 'brain-pos', knowledgePath: posBrainDir }]);
    const posScope = positiveEngine.store.state.sharedScopes.find(scope => scope.id === 'brain-pos');
    await positiveEngine.coordinator.indexSharedScope(posScope);
    assert.equal(posScope.index.status, 'ready');
    const importRecord = standin.records.find(record => record.method === 'POST' && record.path === '/api/import');
    assert.equal(importRecord.body.projectName, 'scope-brain-brain-pos');
    assert.equal(importRecord.body.sourceDir, posBrainDir);

    // Confirm chain: memory create → materialize → real import; unchanged
    // content then takes the GET /api/projects health path and skips import.
    const importsAfterConfigure = importCount();
    const healthGets = () => standin.records.filter(record => record.method === 'GET' && record.path === '/api/projects').length;
    const posMemory = await positiveEngine.coordinator.memories.create({ text: '正向证明：确认流导入必须落到自有替身', brainId: 'brain-pos' });
    assert.equal(posMemory.status, 'confirmed');
    await waitFor(() => importCount() >= importsAfterConfigure + 1, 'confirm chain importing at the OWN stand-in');
    assert.equal(importCount(), importsAfterConfigure + 1, 'materialized memory must trigger exactly one real import at the stand-in');
    const importsAfterConfirm = importCount();
    const getsBeforeHealth = healthGets();
    await positiveEngine.coordinator.indexSharedScope(positiveEngine.store.state.sharedScopes.find(scope => scope.id === 'brain-pos')).catch(() => {});
    await waitFor(() => healthGets() > getsBeforeHealth, 'unchanged fingerprint taking the /api/projects health check');
    assert.equal(importCount(), importsAfterConfirm, 'unchanged fingerprint must skip import via the /api/projects health check');
    assert.ok(healthGets() > getsBeforeHealth, 'health check must have queried the stand-in');

    // index() chain with an explicit vectorProjectId mapping.
    positiveEngine.store.addProject({ projectId: 'proj-pos', repoPath: path.join(posRoot, 'code'), knowledgePath: path.join(posRoot, 'knowledge'), vectorProjectId: 'vec-proj-pos' });
    const posRun = positiveEngine.store.addRun({ projectId: 'proj-pos', commitSha: 'b'.repeat(40), trigger: 'manual' });
    await positiveEngine.coordinator.index(posRun);
    assert.equal(positiveEngine.store.getRun(posRun.runId).state, 'succeeded');
    assert.equal(positiveEngine.store.readRuntime('proj-pos').index.status, 'ready');
    const syncRecord = standin.records.find(record => record.method === 'POST' && record.path === '/api/sync');
    assert.equal(syncRecord.body.project, 'vec-proj-pos');
    assert.equal(syncRecord.body.sourceDir, path.join(posRoot, 'knowledge'));

    // search chain: routed to the stand-in, whose honest 503 degrades retrieval
    // to lexical. The stand-in proves routing/contract parity only — never real
    // vector retrieval quality.
    const posSearch = await positiveEngine.coordinator.retrieval.search({ projectId: 'proj-pos', query: '向量索引守护与导入契约' });
    assert.deepEqual(posSearch.retrievalModes, ['lexical']);
    assert.equal(posSearch.backend, 'markdown-hybrid-fallback');
    const searchRecord = standin.records.find(record => record.method === 'GET' && record.path.startsWith('/api/search'));
    assert.ok(searchRecord, 'search must have queried the stand-in');
    const searchQuery = new URL(`http://127.0.0.1${searchRecord.path}`);
    assert.equal(searchQuery.searchParams.get('q'), '向量索引守护与导入契约');
    assert.equal(searchQuery.searchParams.get('projects'), 'vec-proj-pos');

    assert.equal(guard.blocked.length, blockedBeforePositive, 'positive leg must produce zero blocked egress');
    assert.ok(guard.requests.every(entry => entry.href.startsWith(standinUrl)), 'every positive-leg request must target the OWN stand-in');
    assert.equal(bridgeDouble.calls.length, 0, 'bridge double must never be dialed while consume:false');

    // ── Leg D: IPv6 alignment against a STUBBED original fetch ──
    {
      const realFetch = global.fetch;
      const dialed = [];
      global.fetch = async (input, init) => {
        dialed.push(input instanceof URL ? input.href : String(input?.url || input));
        return { ok: true, stubbed: true };
      };
      let stubGuard = null;
      try {
        stubGuard = installEgressGuard();
        assert.ok(assertOwnedEndpoint('http://[::1]:41245/own-ipv6', { role: 'vectorUrl' }), 'assertOwnedEndpoint accepts the bracketed [::1] hostname');
        await fetch('http://[::1]:41245/own-ipv6');
        await assert.rejects(() => fetch('http://127.0.0.1:8787/api/import'), error => error.code === EGRESS_BLOCK_CODE && error.reason === 'protected-port:8787');
        assert.deepEqual(dialed, ['http://[::1]:41245/own-ipv6'],
          'only the allowed [::1] target reaches the original (stub) fetch — the 8787 call is blocked before any dialing');
      } finally {
        if (stubGuard) stubGuard.uninstall();
        global.fetch = realFetch;
      }
    }

    // ── Leg E: PSModuleAnalysisCachePath is a FILE; a real PowerShell child
    // runs under the isolated env and writes its own startup cache inside the
    // isolated home, without touching the live home ──
    {
      assert.ok(fs.statSync(applied.layout.psModuleCacheParent).isDirectory(), 'the cache PARENT is materialized');
      assert.ok(!fs.existsSync(applied.layout.psModuleCache), 'the fresh layout must not pre-create the cache target');
      assert.equal(process.env.PSModuleAnalysisCachePath, applied.layout.psModuleCache, 'the driver env points at the cache FILE path');
      if (process.platform === 'win32') {
        // Windows PowerShell writes ModuleAnalysisCache from its idle loop,
        // which -Command sessions exit before — so the module-analysis file
        // itself is recorded as EVIDENCE, not asserted. The startup cache
        // (StartupProfileData-NonInteractive under <USERPROFILE>\AppData)
        // IS written on every -NonInteractive startup and is the reliable
        // observable proof of a real PowerShell-owned cache write.
        const isolatedStartupCache = path.join(applied.layout.home, 'AppData', 'Local', 'Microsoft', 'Windows', 'PowerShell', 'StartupProfileData-NonInteractive');
        const liveStartupCache = path.join(LIVE_HOME, 'AppData', 'Local', 'Microsoft', 'Windows', 'PowerShell', 'StartupProfileData-NonInteractive');
        const liveMtimeBefore = fs.existsSync(liveStartupCache) ? fs.statSync(liveStartupCache).mtimeMs : null;
        const psCommand = '"$env:PSModuleAnalysisCachePath`n$env:USERPROFILE"; $ErrorActionPreference=\'Stop\'; Get-Module -ListAvailable | Out-Null; Write-Output "PS-CACHE-OK"';
        const probe = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psCommand],
          { env: childEnv(), timeout: 120000, windowsHide: true, encoding: 'utf8' });
        const lines = String(probe.stdout || '').trim().split(/\r?\n/);
        assert.equal(probe.status, 0, `PowerShell probe failed (${probe.status}): ${probe.stderr}`);
        assert.equal(lines[0], applied.layout.psModuleCache, 'the child must see the isolated cache FILE path');
        assert.equal(lines[1], applied.layout.home, 'the child must see the isolated home');
        assert.notEqual(lines[1], LIVE_HOME, 'the child home must never be the live home');
        assert.equal(lines[lines.length - 1], 'PS-CACHE-OK', 'the PowerShell child really ran to completion');
        assert.ok(fs.existsSync(isolatedStartupCache) && fs.statSync(isolatedStartupCache).isFile(),
          'the PowerShell child must have written its own startup cache file inside the isolated home');
        const liveMtimeAfter = fs.existsSync(liveStartupCache) ? fs.statSync(liveStartupCache).mtimeMs : null;
        assert.equal(liveMtimeAfter, liveMtimeBefore, 'the isolated child must not touch the live home startup cache');
        assert.ok(!fs.existsSync(applied.layout.psModuleCache) || fs.statSync(applied.layout.psModuleCache).isFile(),
          'the cache target stays a FILE path, never a directory, after the child ran');
        console.log(`leg E evidence: moduleAnalysisCacheWrittenAtTarget=${fs.existsSync(applied.layout.psModuleCache)} (idle-write, not asserted); startupCacheWrittenInsideIsolation=true`);
      } else {
        console.log('leg E: PowerShell child probe is Windows-only; cache-file shape assertions ran');
      }
    }

    // ── Leg F: offline POSIX socket-budget string contract ──
    {
      const ciFailedRoot = '/home/runner/work/_temp/pk-nav-r7-9399-ChZLZ5/pk-parallel-nav-nav004-pUkYfU';
      const failed = socketBudgetVerdict(ciFailedRoot);
      assert.ok(!failed.ok, 'the CI-long root shape must be rejected by the socket budget');
      assert.ok(failed.chromeSocketBytes > POSIX_SOCKET_CHAR_LIMIT, `rejected with the computed worst case (${failed.chromeSocketBytes} bytes)`);
      assert.throws(() => assertSocketBudget(ciFailedRoot, 'ci-long-root'), /socket path budget exceeded/, 'assertSocketBudget fails fast on the over-budget root');

      const shortRoot = '/home/runner/work/_temp/pkqabcdef';
      const held = socketBudgetVerdict(shortRoot);
      assert.ok(held.ok, `the short POSIX root this helper creates must hold: ${JSON.stringify({ chrome: held.chromeSocketBytes, control: held.controlSocketBytes })}`);
      assert.ok(POSIX_SOCKET_CHAR_LIMIT - held.chromeSocketBytes >= 10, `short root holds with margin (limit ${POSIX_SOCKET_CHAR_LIMIT}, chrome worst case ${held.chromeSocketBytes})`);

      assert.equal(worstCaseSocketPaths('/tmp').chromeSingletonSocket.length - '/tmp'.length, 49,
        'the Chrome socket tail is pinned at 49 bytes (12-char rand bound)');
      assert.ok(socketBudgetVerdict('/tmp/' + 'a'.repeat(53)).ok, 'a root landing exactly at the byte ceiling is accepted');
      assert.ok(!socketBudgetVerdict('/tmp/' + 'a'.repeat(54)).ok, 'one byte over the ceiling is rejected');

      const multibyte = socketBudgetVerdict('/tmp/π');
      assert.equal(multibyte.chromeSocketBytes, multibyte.paths.chromeSingletonSocket.length + 1,
        'the budget counts UTF-8 bytes, not chars');
    }

    console.log('parallel-qa-engine-endpoint-guard-test PASS');
  } finally {
    if (negativeEngine) await negativeEngine.close().catch(() => {});
    if (positiveEngine) await positiveEngine.close().catch(() => {});
    if (standin) await standin.close().catch(() => {});
    guard.uninstall();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
