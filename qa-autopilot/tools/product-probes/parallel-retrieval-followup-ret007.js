'use strict';
// Environment-dependent chain probe for RET-007 (新提交检索一致).
//
// This file is NOT a regression test and is deliberately kept out of
// _site/_test/ so the offline runner never collects it: it needs the
// operator's real glm subscription (in-memory, read-only), the offline model
// cache and real Git. It proves the WHOLE chain with real components:
//
//   real Git commit in an isolated repo (carrying a unique planted fact)
//     -> the REAL managed post-commit hook (hook-manager) running the REAL
//        hook-trigger script, which appends a real git-commit-boundary/v1 to
//        a REAL event-bridge console (own process, own home)
//     -> the REAL knowledge engine (in-process, own data dir) consuming the
//        journal over HTTP and running the REAL HeadlessAnalyzer against the
//        real glm subscription (glm-5.3 via the engine's runtime-config
//        route; the key never leaves memory and no quota endpoint is read)
//     -> REAL promotion (validated manifest with commit:<full-sha> evidence,
//        atomic apply into the project knowledge dir)
//     -> REAL index (engine POSTs /api/sync to the real pinned vector-hub
//        HTTP server; the product's LocalEmbeddingService embeds the promoted
//        markdown with the offline Xenova/bge-small-zh-v1.5 cache)
//     -> a FRESH next-session process retrieving the fact through the real
//        engine HTTP API with a semantic query that contains NO SHA and no
//        hex identifier, asserting body + full-SHA citation + project match.
//
// Exit codes: 0 PASS, 3 BLOCKED (model cache / subscription unavailable),
// 1 FAIL (first failure captured verbatim before any recovery).
//
// Invoke explicitly:
//   node qa-autopilot/tools/product-probes/parallel-retrieval-followup-ret007.js
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const shell = require(path.join(__dirname, '..', '..', '..', '_site', '_test', 'helpers', 'parallel-retrieval-followup-shell'));
// Isolate before any product module is loaded.
shell.isolateProcess();

const { LocalEmbeddingService } = require(path.join(shell.REPO_ROOT, '_site', 'lib', 'embedding-service'));
const { EMBEDDING_DIMENSIONS } = require(path.join(shell.REPO_ROOT, '_site', 'lib', 'knowledge-schema'));
const { createEngineServer } = require(path.join(shell.REPO_ROOT, '_modules', 'knowledge-engine', 'src', 'server'));
const { BridgeClient } = require(path.join(shell.REPO_ROOT, '_modules', 'knowledge-engine', 'src', 'bridge-client'));
const { installHook } = require(path.join(shell.REPO_ROOT, '_site', 'lib', 'hook-manager'));

const PROJECT_ID = 'ret007-demo';
// The offline model cache lives outside the repository and outside the real
// HOME; the lane's temp root (PK_TEST_TEMP_ROOT / TEMP) is its parent.
const MODEL_CACHE = process.env.PK_RETRIEVAL_MODEL_CACHE
  ? path.resolve(process.env.PK_RETRIEVAL_MODEL_CACHE)
  : path.join(shell.resolveTempRoot(), 'parallel-knowledge-hf-cache');
// The human instruction names the original minimax subscription profile with
// MiniMax-M3.1-Flash. The local catalog lists MiniMax-M3; the instructed id is
// attempted first and the catalog id is used only if the provider rejects it.
const MODEL_CANDIDATES = ['MiniMax-M3.1-Flash', 'MiniMax-M3'];
const PROFILE_ID = 'minimax';
const ANALYZER_TIMEOUT_MS = 10 * 60 * 1000;
const RUN_TIMEOUT_MS = 14 * 60 * 1000;

const layers = {};
const verdicts = {};
let firstFailure = null;

function fail(layer, error, extra = {}) {
  if (!firstFailure) {
    firstFailure = {
      layer,
      at: new Date().toISOString(),
      message: String((error && error.message) || error),
      stack: String((error && error.stack) || '').split('\n').slice(0, 12),
      ...extra,
    };
  }
  throw error;
}

function layer(name, value) {
  layers[name] = { at: new Date().toISOString(), ...value };
  return layers[name];
}

async function engineCall(base, route, body, token) {
  const response = await fetch(`${base}${route}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  return { status: response.status, ok: response.ok, body: await response.json().catch(() => null) };
}

async function waitForRun(base, projectId, commitSha, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const response = await engineCall(base, `/api/runs?projectId=${encodeURIComponent(projectId)}`);
    const runs = (response.body && response.body.runs) || [];
    last = runs.find(run => run.commitSha === commitSha) || null;
    if (last && ['succeeded', 'failed'].includes(last.state)) return last;
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  throw new Error(`Timed out waiting for the engine run of ${commitSha}; last observed: ${JSON.stringify(last && { state: last.state, phase: last.phase })}`);
}

(async () => {
  const root = shell.makeTempDir('parallel-retrieval-followup-ret007');
  const stops = [];
  let runtime = null;
  try {
    // ---- L1: the offline model cache (BLOCKED, never a download).
    const cache = shell.verifyModelCache(MODEL_CACHE);
    layer('L1-model-cache', cache);
    if (!cache.ok) {
      verdicts['RET-007'] = 'BLOCKED';
      console.log(`parallel-retrieval-followup-ret007 BLOCKED (model cache incomplete: ${cache.missing.join(', ')})`);
      process.exitCode = 3;
      return;
    }

    // ---- L2: the operator's real subscription profile, in memory only.
    const glm = shell.loadRuntimeProfile({ profileId: PROFILE_ID, models: MODEL_CANDIDATES });
    layer('L2-subscription-profile', { ok: glm.ok, reason: glm.reason || null, identity: glm.identity || null, listedModels: glm.listedModels || null, home: glm.home });
    if (!glm.ok) {
      verdicts['RET-007'] = 'BLOCKED';
      console.log(`parallel-retrieval-followup-ret007 BLOCKED (${PROFILE_ID} profile unusable: ${glm.reason})`);
      process.exitCode = 3;
      return;
    }
    let modelUsed = glm.identity.mainModel;

    // ---- L3: real topology — bridge console child, vector-hub HTTP server,
    // notification sink (the hook must never reach the live 5757), engine.
    const [bridgePort, vectorPort, enginePort] = await Promise.all([shell.freePort(), shell.freePort(), shell.freePort()]);
    const bridgeHome = path.join(root, 'bridge-home');
    const bridge = await shell.spawnBridgeConsole({ home: bridgeHome, port: bridgePort }).catch(error => fail('L3-topology', error));
    stops.push(bridge.stop);

    const embedder = shell.createProductEmbedder(new LocalEmbeddingService({ cacheDir: MODEL_CACHE, localFilesOnly: true, localModelPath: MODEL_CACHE }));
    const vector = await shell.startVectorHttpServer({ root: path.join(root, 'vector-root'), port: vectorPort, embedder }).catch(error => fail('L3-topology', error));
    stops.push(vector.stop);

    const sink = await shell.startNotificationSink();
    stops.push(sink.stop);

    const dataDir = path.join(root, 'engine-data');
    const runtimeToken = crypto.randomUUID();
    runtime = createEngineServer({
      dataDir,
      vectorUrl: vector.url,
      bridge: new BridgeClient(bridge.url),
      runtimeToken,
      timeoutMs: ANALYZER_TIMEOUT_MS,
    });
    await runtime.ready;
    await new Promise(resolve => runtime.server.listen(enginePort, '127.0.0.1', resolve));
    const engineUrl = `http://127.0.0.1:${runtime.server.address().port}`;
    stops.push(() => runtime.close());
    layer('L3-topology', {
      bridge: { url: bridge.url, home: bridgeHome, childPid: bridge.child.pid },
      vector: { url: vector.url, root: vector.root },
      engine: { url: engineUrl, dataDir },
      notificationSink: { port: sink.port },
    });

    // ---- L4: a real repo with a real initial commit, real registration and
    // the REAL managed post-commit hook.
    const token = `RET007-${crypto.randomBytes(6).toString('hex')}`;
    const repo = shell.makeRepo(root, 'repo', [
      { message: '初始提交：泵阀通道配置', files: { 'README.md': '# 泵阀控制器\n\n演示仓库。\n', 'config/pump.yaml': 'channel: pump\nvalve_retry_limit: 3\n' } },
    ]);
    const knowledgePath = path.join(root, 'knowledge');
    fs.mkdirSync(knowledgePath, { recursive: true });
    const registered = await engineCall(engineUrl, '/api/projects', { projectId: PROJECT_ID, name: 'RET007 泵阀演示', repoPath: repo.repoPath, knowledgePath });
    if (!registered.ok) fail('L4-project-hook', new Error(`project registration failed: HTTP ${registered.status} ${JSON.stringify(registered.body)}`));

    const hook = installHook({
      repoPath: repo.repoPath,
      projectId: PROJECT_ID,
      triggerScriptPath: path.join(shell.REPO_ROOT, '_site', 'scripts', 'hook-trigger.js'),
      nodeExecutable: process.execPath,
      dataDir,
      bridgeHomeDir: bridgeHome,
      bridgeModulePath: '',
    });
    const hookBody = fs.readFileSync(hook.hookPath, 'utf8');
    layer('L4-project-hook', {
      repoPath: repo.repoPath,
      initialCommit: repo.head,
      knowledgePath,
      hookPath: hook.hookPath,
      hookManagedVersion: hook.managedVersion,
      hookBindsDataDir: hookBody.includes(dataDir.replace(/\\/g, '/')) || hookBody.includes(dataDir),
      hookBindsBridgeHome: hookBody.includes(bridgeHome.replace(/\\/g, '/')) || hookBody.includes(bridgeHome),
      uniqueToken: token,
    });

    // ---- L5: real runtime-config (the same trusted route the shell uses)
    // with the real subscription profile, then real activation.
    const configured = await engineCall(engineUrl, '/api/runtime-config', { projectId: 'default', profile: glm.profile }, runtimeToken);
    if (!configured.ok) fail('L5-engine-config', new Error(`runtime-config failed: HTTP ${configured.status}`));
    const activated = await engineCall(engineUrl, '/api/control', { enabled: true, projectIds: [PROJECT_ID] }, runtimeToken);
    if (!activated.ok) fail('L5-engine-config', new Error(`control/activate failed: HTTP ${activated.status}`));
    layer('L5-engine-config', { runtimeConfig: configured.status, activate: activated.status, profileIdentity: glm.identity, modelCandidates: MODEL_CANDIDATES, modelUsed });

    // ---- L6: the planted unique fact, committed for real. The hook fires
    // inside the real Git child; its notification is sunk, its boundary is
    // appended to the real bridge journal.
    fs.writeFileSync(path.join(repo.repoPath, 'config', 'pump.yaml'), `channel: pump\n# 决策 ${token}：湿运行间歇超时，上调泵阀重试上限\nvalve_retry_limit: 7\n`, 'utf8');
    fs.mkdirSync(path.join(repo.repoPath, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(repo.repoPath, 'docs', 'decisions.md'), `# 泵阀重试上限调整\n\n湿运行期间出现间歇性超时，泵阀重试上限由 3 上调至 7（决策编号 ${token}）。本调整仅适用于泵阀通道，不影响其它执行器。\n`, 'utf8');
    const commitEnv = { KB_SITE_PORT: String(sink.port), KB_DATA_DIR: dataDir, AI_CODING_EVENT_BRIDGE_HOME: bridgeHome };
    shell.gitIn(repo.repoPath, ['add', '-A'], commitEnv);
    shell.gitIn(repo.repoPath, ['commit', '-q', '-m', `调整泵阀重试上限为 7 并记录决策（${token}）`], commitEnv);
    const commitSha = shell.gitIn(repo.repoPath, ['rev-parse', 'HEAD'], commitEnv);
    const parents = shell.gitIn(repo.repoPath, ['show', '-s', '--format=%P', 'HEAD'], commitEnv);

    const boundary = await shell.waitFor(async () => {
      const journals = await shell.httpJson(`${bridge.url}/api/journals`).then(response => (response.body && response.body.journals) || []);
      for (const journal of journals) {
        const events = await shell.httpJson(`${bridge.url}/api/journal/events?journalId=${encodeURIComponent(journal.journalId)}&fromSequence=1&limit=100`).then(response => (response.body && response.body.events) || []);
        const hit = events.find(event => event.schema === 'git-commit-boundary/v1' && String(event.commitSha).toLowerCase() === commitSha);
        if (hit) return { journalId: journal.journalId, event: hit };
      }
      return null;
    }, 30000, 'the hook boundary to appear in the bridge journal').catch(error => fail('L6-commit-hook', error, { commitSha }));
    layer('L6-commit-hook', {
      commitSha,
      parents,
      hookNotificationSunk: sink.hits.some(hit => hit.url === '/api/hooks/post-commit' && hit.body && String(hit.body.head || '').toLowerCase() === commitSha),
      sinkHits: sink.hits.length,
      boundary: { journalId: boundary.journalId, commitSha: boundary.event.commitSha, operationId: boundary.event.operationId, repoIdentityWorkspaceRoot: boundary.event.repoIdentity && boundary.event.repoIdentity.workspaceRoot },
    });

    // ---- L7: the engine consumes the boundary and runs the REAL analysis.
    // A fast pre-check first: if no run even queues, the journal matching or
    // the hook chain is broken and waiting the full budget would hide it.
    await shell.waitFor(async () => {
      const response = await engineCall(engineUrl, `/api/runs?projectId=${encodeURIComponent(PROJECT_ID)}`);
      const runs = (response.body && response.body.runs) || [];
      return runs.some(run => run.commitSha === commitSha) || null;
    }, 90000, 'the engine to enqueue the hook-triggered run').catch(async error => {
      const health = await engineCall(engineUrl, '/api/health');
      return fail('L7-analysis-promotion', error, { engineHealth: health.body });
    });
    let run = await waitForRun(engineUrl, PROJECT_ID, commitSha, RUN_TIMEOUT_MS).catch(error => fail('L7-analysis-promotion', error));
    if (run.state === 'failed') {
      // The first failure is kept verbatim. Two bounded recoveries follow:
      // (1) if the provider rejected the model id, the catalog id of the same
      // subscription is configured and the claim is resumed; (2) a retryable
      // failure is retried once through the product's own recovery path.
      const failure = { state: run.state, phase: run.phase, error: run.error, runId: run.runId, attempt: 1, modelUsed };
      if (!firstFailure) firstFailure = { layer: 'L7-analysis-promotion', at: new Date().toISOString(), message: `engine run failed: ${JSON.stringify(run.error)}`, run: failure };
      const failureText = JSON.stringify(run.error || {});
      const nextModel = MODEL_CANDIDATES.find(candidate => candidate !== modelUsed);
      if (nextModel && /model/i.test(failureText)) {
        const reconfigured = await engineCall(engineUrl, '/api/runtime-config', { projectId: 'default', profile: { ...glm.profile, mainModel: nextModel } }, runtimeToken);
        modelUsed = nextModel;
        layer('L7-model-fallback', { reason: 'the provider rejected the instructed model id', rejectedModel: failure.run ? failure.run.modelUsed : null, nextModel, reconfigureStatus: reconfigured.status });
        await engineCall(engineUrl, `/api/runs/${encodeURIComponent(run.runId)}/retry`, {}, runtimeToken);
        run = await waitForRun(engineUrl, PROJECT_ID, commitSha, RUN_TIMEOUT_MS);
      } else if (run.error && run.error.retryable === true) {
        await new Promise(resolve => setTimeout(resolve, 30000));
        await engineCall(engineUrl, `/api/runs/${encodeURIComponent(run.runId)}/retry`, {}, runtimeToken);
        run = await waitForRun(engineUrl, PROJECT_ID, commitSha, RUN_TIMEOUT_MS);
      }
    }
    if (run.state !== 'succeeded') fail('L7-analysis-promotion', new Error(`engine run ended ${run.state}: ${JSON.stringify(run.error)}`));

    const manifestPath = runtime.coordinator.promotion.manifestPath(PROJECT_ID, run.analysisRunId);
    const journalPath = runtime.coordinator.promotion.journalPath(PROJECT_ID, run.analysisRunId);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const promotionJournal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
    const promotedTree = shell.hashTree(knowledgePath);
    const promotedContents = {};
    for (const relative of Object.keys(promotedTree)) promotedContents[relative] = fs.readFileSync(path.join(knowledgePath, ...relative.split('/')), 'utf8');
    const factRegex = /重试[^。\n]{0,20}(3|三)[^。\n]{0,12}(7|七)|(7|七)[^。\n]{0,8}(重试|上限)/;
    const bodyHit = Object.entries(promotedContents).filter(([, content]) => factRegex.test(content) && content.includes('泵阀'));
    layer('L7-analysis-promotion', {
      runId: run.runId,
      analysisRunId: run.analysisRunId,
      commitSha: run.commitSha,
      trigger: run.trigger,
      promotedAt: run.promotedAt,
      runState: run.state,
      manifestOperations: manifest.operations.map(operation => ({ path: operation.path, operation: operation.operation, reason: operation.reason, evidenceReferences: operation.evidenceReferences })),
      manifestCommitEvidence: manifest.operations.every(operation => operation.evidenceReferences.includes(`commit:${commitSha}`)),
      promotionJournalPhase: promotionJournal.phase,
      promotedFiles: Object.keys(promotedTree),
      promotedFileHashes: promotedTree,
      factBodyFiles: bodyHit.map(([file]) => file),
      uniqueTokenInBody: Object.values(promotedContents).some(content => content.includes(token)),
      modelUsed,
      modelProducedFields: {
        source: 'the analysis worker wrote these files from the model response into the run staging directory; the engine then validated and promoted them',
        manifestPath: path.relative(shell.REPO_ROOT, manifestPath).replace(/\\/g, '/'),
        manifestSha256: shell.sha256File(manifestPath),
        journalPath: path.relative(shell.REPO_ROOT, journalPath).replace(/\\/g, '/'),
        manifestOperationCount: manifest.operations.length,
      },
      runError: run.error || null,
    });
    if (!bodyHit.length) fail('L7-analysis-promotion', new Error('the promoted knowledge does not carry the planted fact body (泵阀重试上限=7)'));

    // ---- L8: the real index. The engine already POSTed /api/sync; verify a
    // real vectra index with real 512-dim vectors plus a direct chunk query.
    await shell.waitFor(async () => fs.existsSync(path.join(vector.root, PROJECT_ID, 'index.json')), 30000, 'the vector index file');
    const stored = shell.inspectStoredVectors(path.join(vector.root, PROJECT_ID), EMBEDDING_DIMENSIONS);
    const direct = await shell.httpJson(`${vector.url}/api/search?q=${encodeURIComponent('泵阀重试上限调整')}&projects=${encodeURIComponent(PROJECT_ID)}&maxResults=5&resultLevel=chunk&perProjectLimit=30`);
    const directRows = (direct.body && direct.body.results) || [];
    layer('L8-real-index', {
      vectorProject: PROJECT_ID,
      storedVectors: stored,
      syncModel: direct.body && direct.body.model,
      syncDimensions: direct.body && direct.body.dimensions,
      directChunkRows: directRows.length,
      directTop: directRows[0] ? { uri: directRows[0].uri, scoreType: directRows[0].scoreType, score: directRows[0].score, hasBodyHash: typeof directRows[0].bodyHash === 'string', startPos: directRows[0].startPos, endPos: directRows[0].endPos, snippetHead: String(directRows[0].snippet || '').slice(0, 120) } : null,
      embedderCalls: embedder.state.calls,
      embedderNonZero: embedder.state.nonZeroVectors,
    });
    if (!stored.inspected || !stored.dimensionsMatch || !stored.allVectorsNonZero) fail('L8-real-index', new Error(`the vector index is not real: ${JSON.stringify(stored)}`));

    // ---- L9: the next session. A FRESH process, real engine HTTP, a query
    // with no SHA and no hex identifier.
    const contextQuery = '泵阀的重试上限现在设成多少？为什么要调整？';
    const askQuery = '当前泵阀重试上限是多少，调整的原因是什么';
    // An unrelated hex identifier: same shape as a commit prefix, guaranteed
    // not to be one (checked below). It must NOT unlock the exact-commit
    // channel for the promoted entry.
    let controlQuery = crypto.randomBytes(4).toString('hex');
    while (commitSha.startsWith(controlQuery.slice(0, 7))) controlQuery = crypto.randomBytes(4).toString('hex');
    const nextSessionOut = path.join(shell.LANE_DIR, 'evidence', 'ret007-next-session.json');
    const child = shell.spawnNode(
      [path.join(shell.REPO_ROOT, '_site', '_test', 'helpers', 'parallel-retrieval-followup-next-session.js'),
        '--engine-url', engineUrl, '--project-id', PROJECT_ID,
        '--context-query', contextQuery, '--ask-query', askQuery, '--control-query', controlQuery,
        '--session-id', 'ret007-next-session', '--out', nextSessionOut],
      { KB_KNOWLEDGE_ENGINE_URL: engineUrl },
    );
    const finished = await child.exited;
    if (finished.code !== 0) fail('L9-next-session', new Error(`next-session client exited ${finished.code}: ${finished.stderr.slice(0, 400)}`));
    const nextSession = JSON.parse(fs.readFileSync(nextSessionOut, 'utf8'));

    const isFullSha = value => /^[a-f0-9]{40}$/.test(String(value || ''));
    const facts = (((nextSession.context || {}).body || {}).facts) || [];
    const factHit = facts.find(fact => isFullSha(fact.commitSha)
      && fact.commitSha === commitSha
      && fact.projectId === PROJECT_ID
      && /重试/.test(fact.text) && /7/.test(fact.text));
    const citations = (((nextSession.ask || {}).body || {}).citations) || [];
    const citationHit = citations.find(citation => citation.commitSha === commitSha && citation.projectId === PROJECT_ID && /重试/.test(citation.text) && /7/.test(citation.text));
    const askRows = (((nextSession.ask || {}).body || {}).results) || [];
    const hitRow = askRows.find(row => row.commitSha === commitSha);
    const controlLeak = ((((nextSession.control || {}).body || {}).results) || []).some(row => row.commitSha === commitSha && (row.match_channels || []).includes('exact-commit'));
    const semanticQueriesCarryNoIdentifier = ![contextQuery, askQuery].some(query => /[0-9a-f]{7}/i.test(query)) && !commitSha.startsWith(controlQuery.slice(0, 7));
    layer('L9-next-session', {
      clientPid: nextSession.pid,
      queries: nextSession.queries,
      semanticQueriesCarryNoIdentifier,
      contextStatus: nextSession.context && nextSession.context.status,
      factsCount: facts.length,
      factHit: factHit ? { entryId: factHit.entryId, commitSha: factHit.commitSha, projectId: factHit.projectId, textHead: factHit.text.slice(0, 160) } : null,
      askStatus: nextSession.ask && nextSession.ask.status,
      citationHit: citationHit ? { index: citationHit.index, entryId: citationHit.entryId, commitSha: citationHit.commitSha, projectId: citationHit.projectId } : null,
      hitRowChannels: hitRow ? { match_channels: hitRow.match_channels, matchReason: hitRow.matchReason, retrievalModes: nextSession.ask.body.retrievalModes } : null,
      controlExactCommitLeak: controlLeak,
      contextHealth: ((nextSession.context || {}).body || {}).project || null,
    });
    if (!factHit) fail('L9-next-session', new Error('the next session did not adopt the promoted fact with a full-SHA citation (body/citation chain broken)'));
    if (!citationHit) fail('L9-next-session', new Error('the next session ask citation did not carry the full commit SHA'));
    if (controlLeak) fail('L9-next-session', new Error('an unrelated hex query matched the entry through the exact-commit channel'));

    // ---- wrap-up evidence
    const health = await engineCall(engineUrl, '/api/health');
    const events = await engineCall(engineUrl, `/api/events?projectId=${encodeURIComponent(PROJECT_ID)}&limit=100`);
    layer('L10-engine-state', { health: health.body, events: (events.body && events.body.events) || [] });

    verdicts['RET-007'] = 'PASS';
    const evidence = {
      probe: 'qa-autopilot/tools/product-probes/parallel-retrieval-followup-ret007.js',
      date: new Date().toISOString(),
      batch: 'P-RETRIEVAL-FOLLOWUP-01',
      expected: {
        '完整SHA、项目、正文及索引链匹配': factHit && citationHit && stored.dimensionsMatch ? 'PASS' : 'FAIL',
        '不是只匹配SHA字符串': factHit && citationHit && semanticQueriesCarryNoIdentifier && !(hitRow && (hitRow.match_channels || []).includes('exact-commit')) ? 'PASS' : 'FAIL',
      },
      layers,
      verdicts,
      firstFailure,
    };
    const written = shell.writeEvidence('ret007-chain-evidence.json', evidence);
    console.log(JSON.stringify({ verdict: 'PASS', layers: Object.keys(layers), evidence: written.file, sha256: written.sha256, uniqueToken: token, commitSha }, null, 2));
    console.log('parallel-retrieval-followup-ret007 PASS');
  } catch (error) {
    const evidence = {
      probe: 'qa-autopilot/tools/product-probes/parallel-retrieval-followup-ret007.js',
      date: new Date().toISOString(),
      batch: 'P-RETRIEVAL-FOLLOWUP-01',
      layers,
      verdicts,
      firstFailure: firstFailure || { layer: 'unknown', message: String((error && error.message) || error) },
    };
    const written = shell.writeEvidence('ret007-chain-evidence.json', evidence);
    console.error(JSON.stringify(evidence.firstFailure, null, 2));
    console.error(`evidence: ${written.file}`);
    console.log('parallel-retrieval-followup-ret007 FAIL');
    process.exitCode = 1;
  } finally {
    for (const stop of stops.reverse()) { await stop().catch(() => {}); }
    shell.removeTree(root);
    shell.cleanupIsolatedProcess();
  }
})();
