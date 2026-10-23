'use strict';
// Environment-dependent chain probe for RET-007-R2 (the REAL next-round
// session that R1 did not prove).
//
// This file is NOT a regression test and is deliberately kept out of
// _site/_test/ so the offline runner never collects it: it needs the
// operator's real subscription profile (in memory, read-only; glm since the
// 2026-10-23T09:31Z dispatch, minimax before it), the offline
// model cache, real Git and the real Workbench module.
//
// R1 proved: real Git commit -> real managed hook -> real bridge journal ->
// real engine analysis -> real promotion -> real 512-dim index -> a FRESH
// HTTP CLIENT that asked the engine /api/context and /api/ask. The Leader
// rejected the last step: a new PID speaking HTTP is not "a real next-round
// session that adopts the fact", so RET-007 was PARTIAL at that step.
//
// R2 keeps the whole proven chain and replaces the last step with a REAL
// session of the REAL Workbench module (claude-ai-workbench 0.13.6) driving
// the REAL Agent SDK against the REAL provider:
//
//   real Workbench session (module HTTP contract)
//     -> the module's own KnowledgeContext.retrieve() POSTs /api/context to
//        the real engine (observed through a byte-for-byte recording proxy)
//     -> the engine returns the promoted fact (body + full commit SHA +
//        project) and the module assembles it into the session context
//     -> the CLI driver appends the context to the REAL user message of the
//        REAL SDK turn (observed in the CLI transcript of that run)
//     -> the REAL model answers, and the answer carries the identifier that
//        exists ONLY inside the promoted knowledge
//
// The causality is protected by the workspace itself: after the promotion and
// the index the working tree is rolled back to the pre-commit content and the
// Git repository is REBUILT, so the planted commit is neither reachable nor
// present as an object and neither the file system nor the Git history of the
// workspace can supply the identifier. The workspace stays a real Git
// repository on purpose: the engine resolves a session to a project through
// `git rev-parse --show-toplevel`, so a workspace without Git metadata would
// make the product deliver nothing at all. The negative control runs the same
// driver, the same question, the same provider and the same file content in a
// second, knowledge-free workspace.
//
// The workspaces live in their own directory tree, separate from the tree
// that holds the knowledge, the engine data and the vector index: a model
// that walks one level up from its workspace finds nothing but the other
// workspace.
//
// Exit codes: 0 PASS, 3 BLOCKED (model cache / subscription unavailable),
// 1 FAIL (the first failure is captured verbatim).
//
// Invoke explicitly:
//   node qa-autopilot/tools/product-probes/parallel-retrieval-followup-ret007-r2.js
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const shell = require(path.join(__dirname, '..', '..', '..', '_site', '_test', 'helpers', 'parallel-retrieval-followup-r2-shell'));
const chain = shell.chain;
// Isolate before any product module is loaded.
chain.isolateProcess();

const { LocalEmbeddingService } = require(path.join(chain.REPO_ROOT, '_site', 'lib', 'embedding-service'));
const { EMBEDDING_DIMENSIONS } = require(path.join(chain.REPO_ROOT, '_site', 'lib', 'knowledge-schema'));
const { createEngineServer } = require(path.join(chain.REPO_ROOT, '_modules', 'knowledge-engine', 'src', 'server'));
const { BridgeClient } = require(path.join(chain.REPO_ROOT, '_modules', 'knowledge-engine', 'src', 'bridge-client'));
const { installHook } = require(path.join(chain.REPO_ROOT, '_site', 'lib', 'hook-manager'));

const PROJECT_ID = 'ret007-r2-demo';
const CONTROL_PROJECT_ID = 'ret007-r2-control';
const WORKSPACE_REF = 'wb-ret007r2';
const CONTROL_WORKSPACE_REF = 'wb-ret007r2-control';
// Dispatch 2026-10-23T09:31Z: the operator's minimax subscription returned a
// REAL 429/2067 (Token Plan limit) on a normal task, so this lane runs on the
// operator's ORIGINAL glm profile (glm-5.3, effort max) instead. The earlier
// minimax attempts (runs 1 and 2 of this probe) keep their evidence; the
// model switch is recorded here and in the round report.
const PROFILE_ID = 'glm';
const MODEL_CANDIDATES = ['glm-5.3', 'glm-5.2'];
const MODEL_CACHE = process.env.PK_RETRIEVAL_MODEL_CACHE
  ? path.resolve(process.env.PK_RETRIEVAL_MODEL_CACHE)
  : path.join(chain.resolveTempRoot(), 'parallel-knowledge-hf-cache');
const ANALYZER_TIMEOUT_MS = 10 * 60 * 1000;
const RUN_TIMEOUT_MS = 14 * 60 * 1000;
const TURN_TIMEOUT_MS = 7 * 60 * 1000;

// The question of BOTH legs. It carries no answer, no identifier and no
// commit SHA: the model can only answer it from the knowledge context that
// the product itself delivers.
const QUESTION = '当前泵阀的重试上限设成了多少？最近一次调整的决策编号是什么？请一并给出这次调整对应的提交 SHA。';

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

function walkJsonl(root, visit) {
  let names;
  try { names = fs.readdirSync(root, { withFileTypes: true }); } catch { return; }
  for (const entry of names) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) walkJsonl(full, visit);
    else if (entry.isFile() && full.endsWith('.jsonl')) visit(full);
  }
}

// The user messages of ONE claude session, exactly as the SDK sent them.
// Only the derived flags and short excerpts are returned: the transcript
// itself is never copied into the evidence.
function readTranscriptUserMessages(roots, claudeSessionId) {
  const messages = [];
  const assistantModels = new Set();
  let assistantCount = 0;
  for (const root of roots) {
    walkJsonl(root, file => {
      let text;
      try { text = fs.readFileSync(file, 'utf8'); } catch { return; }
      if (claudeSessionId && !text.includes(claudeSessionId)) return;
      for (const line of text.split(/\r?\n/)) {
        let entry;
        try { entry = JSON.parse(line); } catch { continue; }
        if (claudeSessionId && entry.sessionId !== claudeSessionId) continue;
        if (entry.type === 'user' && entry.message) {
          const raw = entry.message.content;
          const content = Array.isArray(raw) ? raw : (typeof raw === 'string' ? [{ text: raw }] : []);
          const body = content.map(block => (block && typeof block.text === 'string' ? block.text : '')).join('\n');
          if (!body) continue;
          messages.push({ length: body.length, body });
        }
        if (entry.type === 'assistant' && entry.message) {
          assistantCount += 1;
          if (typeof entry.message.model === 'string' && entry.message.model) assistantModels.add(entry.message.model);
        }
      }
    });
  }
  return { messages, assistantCount, assistantModels: [...assistantModels] };
}

function sha256Of(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

// A directory listing with the hashes of the files: the evidence needs to
// show what the workspace contained at the moment of the session.
function treeState(dir) {
  const files = {};
  const walk = (current, prefix) => {
    let names;
    try { names = fs.readdirSync(current, { withFileTypes: true }); } catch { return; }
    for (const entry of names) {
      const full = path.join(current, entry.name);
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(full, relative);
      else if (entry.isFile()) files[relative] = sha256Of(fs.readFileSync(full));
    }
  };
  walk(dir, '');
  return files;
}

function treeContains(files, needle) {
  const lower = String(needle).toLowerCase();
  return Object.keys(files).some(name => name.toLowerCase().includes(lower));
}

// Every readable byte of a workspace, including its Git metadata, searched
// for the needles that would break the causality of the chain.
function scanWorkspaceForNeedles(dir, needles) {
  const hits = [];
  const walk = current => {
    let names;
    try { names = fs.readdirSync(current, { withFileTypes: true }); } catch { return; }
    for (const entry of names) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      let text;
      try { text = fs.readFileSync(full, 'utf8'); } catch { continue; }
      const lower = text.toLowerCase();
      for (const needle of needles) {
        if (lower.includes(String(needle).toLowerCase())) hits.push({ file: path.relative(dir, full).replace(/\\/g, '/'), needle });
      }
    }
  };
  walk(dir);
  return hits;
}

// Close a workspace without breaking the product's own project resolution.
// The engine maps a session to a project through `git rev-parse
// --show-toplevel`, so the workspace has to stay a Git repository; what must
// disappear is every trace of the planted commit. The tree is rolled back to
// the pre-commit content, the managed hook is removed (it embeds the
// absolute engine data directory) and a FRESH repository is created, so no
// ORIG_HEAD, reflog or COMMIT_EDITMSG of the planted commit survives and the
// planted object itself is gone.
function closeWorkspace(repoPath, { token, commitSha, resetTo }) {
  const env = { GIT_TERMINAL_PROMPT: '0' };
  if (resetTo) chain.gitIn(repoPath, ['reset', '--hard', resetTo], env);
  const hookPath = path.join(repoPath, '.git', 'hooks', 'post-commit');
  const managedHookPresent = fs.existsSync(hookPath);
  if (managedHookPresent) fs.rmSync(hookPath, { force: true });
  fs.rmSync(path.join(repoPath, '.git'), { recursive: true, force: true });
  chain.gitIn(repoPath, ['init', '-q'], env);
  chain.gitIn(repoPath, ['config', 'user.email', 'parallel-knowledge@local.invalid'], env);
  chain.gitIn(repoPath, ['config', 'user.name', 'Parallel Knowledge Test'], env);
  chain.gitIn(repoPath, ['config', 'commit.gpgsign', 'false'], env);
  chain.gitIn(repoPath, ['add', '-A'], env);
  chain.gitIn(repoPath, ['commit', '-q', '-m', '初始提交：泵阀通道配置'], env);
  const head = chain.gitIn(repoPath, ['rev-parse', 'HEAD'], env);
  const log = chain.gitIn(repoPath, ['log', '--all', '--format=%H %s'], env);
  const toplevel = chain.gitIn(repoPath, ['rev-parse', '--show-toplevel'], env);
  let plantedObjectPresent = false;
  try {
    chain.gitIn(repoPath, ['rev-parse', '--verify', '--quiet', `${commitSha}^{commit}`], env);
    plantedObjectPresent = true;
  } catch { /* the planted commit is gone, which is the point */ }
  const leaks = scanWorkspaceForNeedles(repoPath, [token, commitSha, commitSha.slice(0, 7), 'valve_retry_limit: 7']);
  return {
    head,
    log,
    toplevel,
    managedHookPresent,
    managedHookRemoved: managedHookPresent && !fs.existsSync(hookPath),
    plantedObjectPresent,
    plantedCommitInHistory: log.includes(commitSha),
    leakHits: leaks,
    gitMetadataStillPresent: fs.existsSync(path.join(repoPath, '.git')),
  };
}

(async () => {
  const root = chain.makeTempDir('parallel-retrieval-followup-ret007-r2');
  // The workspaces get their own tree: the knowledge, the engine data and
  // the vector index stay in `root`, so a model that walks one level up from
  // its workspace finds nothing but the other workspace.
  const wsRoot = chain.makeTempDir('parallel-retrieval-followup-r2-ws');
  const stops = [];
  let runtime = null;
  let hostChild = null;
  try {
    // ---- L1: the offline model cache (BLOCKED, never a download).
    const cache = chain.verifyModelCache(MODEL_CACHE);
    layer('L1-model-cache', cache);
    if (!cache.ok) {
      verdicts['RET-007-R2'] = 'BLOCKED';
      console.log(`parallel-retrieval-followup-ret007-r2 BLOCKED (model cache incomplete: ${cache.missing.join(', ')})`);
      process.exitCode = 3;
      return;
    }

    // ---- L2: the operator's real subscription profile, in memory only.
    const runtimeProfile = chain.loadRuntimeProfile({ profileId: PROFILE_ID, models: MODEL_CANDIDATES });
    layer('L2-subscription-profile', { ok: runtimeProfile.ok, reason: runtimeProfile.reason || null, identity: runtimeProfile.identity || null, listedModels: runtimeProfile.listedModels || null, home: runtimeProfile.home });
    if (!runtimeProfile.ok) {
      verdicts['RET-007-R2'] = 'BLOCKED';
      console.log(`parallel-retrieval-followup-ret007-r2 BLOCKED (${PROFILE_ID} profile unusable: ${runtimeProfile.reason})`);
      process.exitCode = 3;
      return;
    }
    let modelUsed = runtimeProfile.identity.mainModel;

    // ---- L3: real topology — bridge console child, vector hub HTTP server
    // with the product's own embedding service, notification sink, engine.
    const [bridgePort, vectorPort, enginePort] = await Promise.all([chain.freePort(), chain.freePort(), chain.freePort()]);
    const bridgeHome = path.join(root, 'bridge-home');
    const bridge = await chain.spawnBridgeConsole({ home: bridgeHome, port: bridgePort }).catch(error => fail('L3-topology', error));
    stops.push(bridge.stop);

    const embedder = chain.createProductEmbedder(new LocalEmbeddingService({ cacheDir: MODEL_CACHE, localFilesOnly: true, localModelPath: MODEL_CACHE }));
    const vector = await chain.startVectorHttpServer({ root: path.join(root, 'vector-root'), port: vectorPort, embedder }).catch(error => fail('L3-topology', error));
    stops.push(vector.stop);

    const sink = await chain.startNotificationSink();
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
      vector: { url: vector.url, root: vector.root, embedder: embedder.modelId },
      engine: { url: engineUrl, dataDir },
      notificationSink: { port: sink.port },
    });

    // ---- L4: two real repositories. The positive one carries the planted
    // fact; the control one starts from the SAME file content and never gets
    // any knowledge, so the only difference between the two legs is the
    // knowledge the product delivers.
    const token = `RET007R2-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
    const basePump = 'channel: pump\nvalve_retry_limit: 3\n';
    const repo = chain.makeRepo(wsRoot, 'repo', [
      { message: '初始提交：泵阀通道配置', files: { 'README.md': '# 泵阀控制器\n\n演示仓库。\n', 'config/pump.yaml': basePump } },
    ]);
    const controlRepo = chain.makeRepo(wsRoot, 'control-repo', [
      { message: '初始提交：泵阀通道配置', files: { 'README.md': '# 泵阀控制器\n\n演示仓库。\n', 'config/pump.yaml': basePump } },
    ]);
    const knowledgePath = path.join(root, 'knowledge');
    const controlKnowledgePath = path.join(root, 'control-knowledge');
    fs.mkdirSync(knowledgePath, { recursive: true });
    fs.mkdirSync(controlKnowledgePath, { recursive: true });

    const registered = await engineCall(engineUrl, '/api/projects', { projectId: PROJECT_ID, name: 'RET007-R2 泵阀演示', repoPath: repo.repoPath, knowledgePath });
    if (!registered.ok) fail('L4-project-hook', new Error(`project registration failed: HTTP ${registered.status} ${JSON.stringify(registered.body)}`));
    const controlRegistered = await engineCall(engineUrl, '/api/projects', { projectId: CONTROL_PROJECT_ID, name: 'RET007-R2 负控制', repoPath: controlRepo.repoPath, knowledgePath: controlKnowledgePath });
    if (!controlRegistered.ok) fail('L4-project-hook', new Error(`control project registration failed: HTTP ${controlRegistered.status} ${JSON.stringify(controlRegistered.body)}`));

    const hook = installHook({
      repoPath: repo.repoPath,
      projectId: PROJECT_ID,
      triggerScriptPath: path.join(chain.REPO_ROOT, '_site', 'scripts', 'hook-trigger.js'),
      nodeExecutable: process.execPath,
      dataDir,
      bridgeHomeDir: bridgeHome,
      bridgeModulePath: '',
    });
    layer('L4-project-hook', {
      repoPath: repo.repoPath,
      controlRepoPath: controlRepo.repoPath,
      workspaceTreeRoot: wsRoot,
      laneDataRoot: root,
      workspaceTreeIsolation: 'the workspaces live in their own tree; the knowledge, the engine data and the vector index live in the lane data tree',
      initialCommit: repo.head,
      controlInitialCommit: controlRepo.head,
      knowledgePath,
      controlKnowledgePath,
      hookPath: hook.hookPath,
      hookManagedVersion: hook.managedVersion,
      uniqueToken: token,
    });

    // ---- L5: the real runtime-config route with the real subscription
    // profile, then real activation.
    const configured = await engineCall(engineUrl, '/api/runtime-config', { projectId: 'default', profile: runtimeProfile.profile }, runtimeToken);
    if (!configured.ok) fail('L5-engine-config', new Error(`runtime-config failed: HTTP ${configured.status}`));
    const activated = await engineCall(engineUrl, '/api/control', { enabled: true, projectIds: [PROJECT_ID, CONTROL_PROJECT_ID] }, runtimeToken);
    if (!activated.ok) fail('L5-engine-config', new Error(`control/activate failed: HTTP ${activated.status}`));
    layer('L5-engine-config', { runtimeConfig: configured.status, activate: activated.status, profileIdentity: runtimeProfile.identity, modelCandidates: MODEL_CANDIDATES, modelUsed });

    // ---- L6: the planted fact, committed for real.
    fs.writeFileSync(path.join(repo.repoPath, 'config', 'pump.yaml'), 'channel: pump\nvalve_retry_limit: 7\n', 'utf8');
    fs.mkdirSync(path.join(repo.repoPath, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(repo.repoPath, 'docs', 'decisions.md'), `# 泵阀重试上限调整\n\n湿运行期间出现间歇性超时，泵阀重试上限由 3 上调至 7（决策编号 ${token}）。本调整仅适用于泵阀通道，不影响其它执行器。\n`, 'utf8');
    const commitEnv = { KB_SITE_PORT: String(sink.port), KB_DATA_DIR: dataDir, AI_CODING_EVENT_BRIDGE_HOME: bridgeHome };
    chain.gitIn(repo.repoPath, ['add', '-A'], commitEnv);
    chain.gitIn(repo.repoPath, ['commit', '-q', '-m', `调整泵阀重试上限为 7 并记录决策（${token}）`], commitEnv);
    const commitSha = chain.gitIn(repo.repoPath, ['rev-parse', 'HEAD'], commitEnv);
    const parents = chain.gitIn(repo.repoPath, ['show', '-s', '--format=%P', 'HEAD'], commitEnv);

    const boundary = await chain.waitFor(async () => {
      const journals = await chain.httpJson(`${bridge.url}/api/journals`).then(response => (response.body && response.body.journals) || []);
      for (const journal of journals) {
        const events = await chain.httpJson(`${bridge.url}/api/journal/events?journalId=${encodeURIComponent(journal.journalId)}&fromSequence=1&limit=100`).then(response => (response.body && response.body.events) || []);
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
      boundary: { journalId: boundary.journalId, commitSha: boundary.event.commitSha, operationId: boundary.event.operationId },
    });

    // ---- L7: the engine consumes the boundary and runs the REAL analysis.
    await chain.waitFor(async () => {
      const response = await engineCall(engineUrl, `/api/runs?projectId=${encodeURIComponent(PROJECT_ID)}`);
      const runs = (response.body && response.body.runs) || [];
      return runs.some(run => run.commitSha === commitSha) || null;
    }, 90000, 'the engine to enqueue the hook-triggered run').catch(async error => {
      const health = await engineCall(engineUrl, '/api/health');
      return fail('L7-analysis-promotion', error, { engineHealth: health.body });
    });
    let run = await waitForRun(engineUrl, PROJECT_ID, commitSha, RUN_TIMEOUT_MS).catch(error => fail('L7-analysis-promotion', error));
    if (run.state === 'failed') {
      const failure = { state: run.state, phase: run.phase, error: run.error, runId: run.runId, attempt: 1, modelUsed };
      if (!firstFailure) firstFailure = { layer: 'L7-analysis-promotion', at: new Date().toISOString(), message: `engine run failed: ${JSON.stringify(run.error)}`, run: failure };
      const failureText = JSON.stringify(run.error || {});
      const nextModel = MODEL_CANDIDATES.find(candidate => candidate !== modelUsed);
      if (nextModel && /model/i.test(failureText)) {
        const reconfigured = await engineCall(engineUrl, '/api/runtime-config', { projectId: 'default', profile: { ...runtimeProfile.profile, mainModel: nextModel } }, runtimeToken);
        modelUsed = nextModel;
        layer('L7-model-fallback', { reason: 'the provider rejected the instructed model id', nextModel, reconfigureStatus: reconfigured.status });
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
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const promotedTree = chain.hashTree(knowledgePath);
    const promotedContents = {};
    for (const relative of Object.keys(promotedTree)) promotedContents[relative] = fs.readFileSync(path.join(knowledgePath, ...relative.split('/')), 'utf8');
    const factRegex = /重试[^。\n]{0,20}(3|三)[^。\n]{0,12}(7|七)|(7|七)[^。\n]{0,8}(重试|上限)/;
    const bodyHit = Object.entries(promotedContents).filter(([, content]) => factRegex.test(content) && content.includes('泵阀'));
    const tokenHit = Object.entries(promotedContents).filter(([, content]) => content.includes(token));
    layer('L7-analysis-promotion', {
      runId: run.runId,
      analysisRunId: run.analysisRunId,
      commitSha: run.commitSha,
      trigger: run.trigger,
      runState: run.state,
      manifestOperations: manifest.operations.map(operation => ({ path: operation.path, operation: operation.operation, evidenceReferences: operation.evidenceReferences })),
      manifestCommitEvidence: manifest.operations.every(operation => operation.evidenceReferences.includes(`commit:${commitSha}`)),
      promotedFiles: Object.keys(promotedTree),
      promotedFileHashes: promotedTree,
      factBodyFiles: bodyHit.map(([file]) => file),
      identifierInPromotedBody: tokenHit.length > 0,
      identifierFiles: tokenHit.map(([file]) => file),
      modelUsed,
      runError: run.error || null,
    });
    if (!bodyHit.length) fail('L7-analysis-promotion', new Error('the promoted knowledge does not carry the planted fact body (泵阀重试上限=7)'));
    if (!tokenHit.length) fail('L7-analysis-promotion', new Error('the promoted knowledge does not carry the planted identifier'));

    // ---- L8: the real index (512-dim, non-zero) plus a direct chunk query.
    await chain.waitFor(async () => fs.existsSync(path.join(vector.root, PROJECT_ID, 'index.json')), 30000, 'the vector index file');
    const stored = chain.inspectStoredVectors(path.join(vector.root, PROJECT_ID), EMBEDDING_DIMENSIONS);
    const direct = await chain.httpJson(`${vector.url}/api/search?q=${encodeURIComponent('泵阀重试上限调整')}&projects=${encodeURIComponent(PROJECT_ID)}&maxResults=5&resultLevel=chunk&perProjectLimit=30`);
    const directRows = (direct.body && direct.body.results) || [];
    layer('L8-real-index', {
      vectorProject: PROJECT_ID,
      storedVectors: stored,
      syncModel: direct.body && direct.body.model,
      syncDimensions: direct.body && direct.body.dimensions,
      directChunkRows: directRows.length,
      directTop: directRows[0] ? { uri: directRows[0].uri, scoreType: directRows[0].scoreType, score: directRows[0].score, hasBodyHash: typeof directRows[0].bodyHash === 'string', snippetHead: String(directRows[0].snippet || '').slice(0, 120) } : null,
      embedderCalls: embedder.state.calls,
      embedderNonZero: embedder.state.nonZeroVectors,
    });
    if (!stored.inspected || !stored.dimensionsMatch || !stored.allVectorsNonZero) fail('L8-real-index', new Error(`the vector index is not real: ${JSON.stringify(stored)}`));

    // ---- L9a: close the leak. The identifier and the promoted value must
    // exist ONLY inside the promoted knowledge, otherwise the answer could
    // come from the workspace instead of from the delivered context. The
    // workspace stays a real Git repository (the engine resolves a session
    // to a project through `git rev-parse --show-toplevel`), but the planted
    // commit is rolled back, its hook is removed and the repository is
    // rebuilt, so the commit is neither reachable nor present as an object.
    const closedPositive = closeWorkspace(repo.repoPath, { token, commitSha, resetTo: repo.head });
    const closedControl = closeWorkspace(controlRepo.repoPath, { token, commitSha, resetTo: null });
    const workspaceFiles = treeState(repo.repoPath);
    const controlWorkspaceFiles = treeState(controlRepo.repoPath);
    const workspaceCarriesIdentifier = treeContains(workspaceFiles, token);
    const workspaceCarriesValue = Object.keys(workspaceFiles).some(name => {
      try { return fs.readFileSync(path.join(repo.repoPath, ...name.split('/')), 'utf8').includes('valve_retry_limit: 7'); } catch { return false; }
    });
    layer('L9a-workspace-closed', {
      reason: 'after the promotion and the index the working tree is rolled back to the pre-commit content, the managed hook is removed and the Git repository is rebuilt, so neither the files nor the Git history of the workspace can supply the identifier or the promoted value; the repository itself stays, because the product resolves the project through git rev-parse --show-toplevel',
      positive: closedPositive,
      control: closedControl,
      workspaceFiles,
      controlWorkspaceFiles,
      workspaceCarriesIdentifier,
      workspaceCarriesValue,
      workspaceHasGitMetadata: fs.existsSync(path.join(repo.repoPath, '.git')),
      controlHasGitMetadata: fs.existsSync(path.join(controlRepo.repoPath, '.git')),
    });
    if (workspaceCarriesIdentifier || workspaceCarriesValue) fail('L9a-workspace-closed', new Error('the workspace still exposes the identifier or the promoted value'));
    if (closedPositive.leakHits.length || closedControl.leakHits.length) fail('L9a-workspace-closed', new Error(`the closed workspace still carries the identifier or the commit: ${JSON.stringify([...closedPositive.leakHits, ...closedControl.leakHits])}`));
    if (closedPositive.plantedObjectPresent || closedPositive.plantedCommitInHistory) fail('L9a-workspace-closed', new Error('the planted commit is still present in the closed workspace'));

    // ---- L9b: the REAL Workbench module, hosted in its own child process.
    const moduleRoot = shell.resolveWorkbenchModuleRoot();
    if (!moduleRoot) fail('L9b-workbench-host', new Error('the claude-ai-workbench module could not be located'));
    const proxy = await shell.startRecordingProxy({ target: engineUrl, label: 'engine' });
    stops.push(() => proxy.close());

    const layout = shell.createIsolationLayout('parallel-retrieval-followup-ret007-r2');
    const hostPort = await shell.freePort();
    const hostBase = `http://127.0.0.1:${hostPort}`;
    hostChild = shell.spawnNode([path.join(chain.REPO_ROOT, '_site', '_test', 'helpers', 'parallel-retrieval-followup-r2-wb-host.js')], shell.hostEnv(layout, {
      PK_WB_MODULE_ROOT: moduleRoot,
      PK_WB_HOST_PORT: String(hostPort),
      PK_WB_HOST_DATA_DIR: layout.dataDir,
      PK_WB_HOST_WORKSPACES: JSON.stringify({ [WORKSPACE_REF]: repo.repoPath, [CONTROL_WORKSPACE_REF]: controlRepo.repoPath }),
      PK_WB_ENGINE_URL: proxy.url,
      PK_WB_PROFILE_SOURCE: 'real-readonly',
    }));
    await shell.waitForHttp(`${hostBase}/api/claude-workbench/v1/health`, 30000).catch(error => fail('L9b-workbench-host', error, { hostStdout: hostChild.output.stdout.slice(0, 800), hostStderr: hostChild.output.stderr.slice(0, 800) }));
    const profiles = await shell.getJson(`${hostBase}/api/claude-workbench/v1/profiles`);
    const listed = Array.isArray(profiles.body && profiles.body.profiles) ? profiles.body.profiles : [];
    const profile = listed.find(entry => entry.id === PROFILE_ID) || null;
    layer('L9b-workbench-host', {
      moduleRoot: moduleRoot.replace(/\\/g, '/'),
      moduleIdentity: shell.packageIdentity(moduleRoot),
      hostBase,
      engineUrlSeenByModule: proxy.url,
      workspaces: { [WORKSPACE_REF]: repo.repoPath, [CONTROL_WORKSPACE_REF]: controlRepo.repoPath },
      profileVisible: Boolean(profile),
      profileId: profile ? profile.id : null,
      profileCredentialConfigured: profile ? profile.credentialConfigured === true : null,
      profileBaseUrl: profile ? profile.baseUrl : null,
      profileDefaultModel: profile ? profile.models && profile.models.default : null,
      isolation: { home: layout.home, claudeConfigDir: layout.claudeConfigDir, dataDir: layout.dataDir, temp: layout.temp },
      snapshotProvenance: shell.snapshotProvenance(),
    });
    if (!profile) fail('L9b-workbench-host', new Error(`the ${PROFILE_ID} profile was not visible through the read-only facade`));

    // ---- L9c: the two real turns. Same driver, same question, same
    // provider, same file content; only the knowledge differs.
    const positiveTurn = await shell.runWorkbenchTurn({
      base: hostBase,
      profileId: PROFILE_ID,
      model: modelUsed,
      effort: 'max',
      workspaceRef: WORKSPACE_REF,
      contextId: 'ret007-r2',
      question: QUESTION,
      sessionInputOrigin: 'human',
      timeoutMs: TURN_TIMEOUT_MS,
    });
    const controlTurn = await shell.runWorkbenchTurn({
      base: hostBase,
      profileId: PROFILE_ID,
      model: modelUsed,
      effort: 'max',
      workspaceRef: CONTROL_WORKSPACE_REF,
      contextId: 'ret007-r2-control',
      question: QUESTION,
      sessionInputOrigin: 'human',
      timeoutMs: TURN_TIMEOUT_MS,
    });
    layer('L9c-real-turns', {
      question: QUESTION,
      questionCarriesAnswer: false,
      questionCarriesIdentifier: QUESTION.includes(token),
      questionCarriesSha: /[0-9a-f]{7}/i.test(QUESTION),
      positive: {
        sessionId: positiveTurn.sessionId,
        claudeSessionId: positiveTurn.claudeSessionId,
        sdkReportedModel: positiveTurn.sdkReportedModel,
        sdkReportedModelNote: 'the system/init model string the SDK reports; NOT vendor-returned evidence',
        isError: positiveTurn.isError,
        usage: positiveTurn.usage,
        errorEvent: positiveTurn.error,
        cliStderr: (positiveTurn.stderrEvents || []).slice(0, 8),
        answerHead: positiveTurn.answer.slice(0, 800),
        answerLength: positiveTurn.answer.length,
        permissionRequests: positiveTurn.events.filter(event => event.type === 'claude/permission-request').length,
      },
      control: {
        sessionId: controlTurn.sessionId,
        claudeSessionId: controlTurn.claudeSessionId,
        sdkReportedModel: controlTurn.sdkReportedModel,
        isError: controlTurn.isError,
        usage: controlTurn.usage,
        errorEvent: controlTurn.error,
        cliStderr: (controlTurn.stderrEvents || []).slice(0, 8),
        answerHead: controlTurn.answer.slice(0, 800),
        answerLength: controlTurn.answer.length,
        permissionRequests: controlTurn.events.filter(event => event.type === 'claude/permission-request').length,
      },
    });
    if (positiveTurn.isError) fail('L9c-real-turns', new Error(`the positive turn failed: ${JSON.stringify(positiveTurn.error)} cliStderr=${JSON.stringify((positiveTurn.stderrEvents || []).slice(0, 4))}`));
    if (controlTurn.isError) fail('L9c-real-turns', new Error(`the control turn failed: ${JSON.stringify(controlTurn.error)} cliStderr=${JSON.stringify((controlTurn.stderrEvents || []).slice(0, 4))}`));

    // ---- L9d: layer 1 — prepared. The engine really answered /api/context
    // for THIS session, and the answer carries the promoted fact.
    const contextCalls = proxy.records.filter(entry => entry.method === 'POST' && /\/api\/context/.test(entry.url));
    const preparedFor = sessionId => contextCalls.find(call => call.requestBody && call.requestBody.sessionId === sessionId) || null;
    const preparedCall = preparedFor(positiveTurn.sessionId);
    const preparedResponse = preparedCall && preparedCall.responseBody;
    const preparedFacts = preparedResponse && Array.isArray(preparedResponse.facts) ? preparedResponse.facts : [];
    const preparedFact = preparedFacts.find(fact => fact && fact.commitSha === commitSha && fact.projectId === PROJECT_ID && typeof fact.text === 'string' && fact.text.includes(token)) || null;
    layer('L9d-prepared-engine-context', {
      engineRoute: '/api/context',
      requestBody: preparedCall ? preparedCall.requestBody : null,
      responseStatus: preparedCall ? preparedCall.responseStatus : null,
      contextStatus: preparedResponse ? preparedResponse.status : null,
      projectId: preparedResponse ? preparedResponse.projectId : null,
      requestId: preparedResponse ? preparedResponse.requestId : null,
      factCount: preparedFacts.length,
      factHit: preparedFact ? { entryId: preparedFact.entryId, commitSha: preparedFact.commitSha, projectId: preparedFact.projectId, projectName: preparedFact.projectName, title: preparedFact.title, textHead: String(preparedFact.text).slice(0, 240) } : null,
      allContextCalls: contextCalls.map(call => ({ sessionId: call.requestBody ? call.requestBody.sessionId : null, repoPath: call.requestBody ? call.requestBody.repoPath : null, responseStatus: call.responseStatus, status: call.responseBody ? call.responseBody.status : null, projectId: call.responseBody ? call.responseBody.projectId : null, factCount: call.responseBody && Array.isArray(call.responseBody.facts) ? call.responseBody.facts.length : null })),
      detail: 'the real engine answered /api/context for this very session and the answer carries the promoted fact with its full commit SHA and project',
    });
    if (!preparedCall || preparedCall.responseStatus !== 200) fail('L9d-prepared-engine-context', new Error(`the engine did not answer /api/context for this session (HTTP ${preparedCall ? preparedCall.responseStatus : 'no call'})`));
    if (!preparedFact) fail('L9d-prepared-engine-context', new Error('the engine did not deliver the promoted fact to the session context request'));

    // ---- L9e: layer 2 — output. The module kept the engine answer as the
    // session knowledge context and correlated it by requestId.
    const moduleKnowledge = await shell.getJson(`${hostBase}/api/claude-workbench/v1/sessions/${encodeURIComponent(positiveTurn.sessionId)}/knowledge`);
    const moduleBody = moduleKnowledge.body || {};
    const moduleReferences = Array.isArray(moduleBody.references) ? moduleBody.references : [];
    const moduleFact = moduleReferences.find(reference => reference && reference.commitSha === commitSha && reference.entryId === preparedFact.entryId) || null;
    const requestIdMatches = Boolean(moduleBody.requestId) && moduleBody.requestId === preparedResponse.requestId;
    layer('L9e-output-module-assembled-context', {
      moduleRoute: 'GET /sessions/:id/knowledge',
      httpStatus: moduleKnowledge.status,
      status: moduleBody.status || null,
      memoryCount: moduleBody.memoryCount === undefined ? null : moduleBody.memoryCount,
      memoryStatus: moduleBody.memoryStatus || null,
      moduleRequestId: moduleBody.requestId || null,
      engineRequestId: preparedResponse ? preparedResponse.requestId : null,
      requestIdsCorrelate: requestIdMatches,
      referenceCount: moduleReferences.length,
      factReference: moduleFact ? { entryId: moduleFact.entryId, commitSha: moduleFact.commitSha, projectId: moduleFact.projectId, memoryId: moduleFact.memoryId || null } : null,
      detail: 'the module kept the engine answer as this session knowledge context and correlated it by requestId',
    });
    if (!moduleFact || !requestIdMatches) fail('L9e-output-module-assembled-context', new Error('the module did not keep the engine fact for this session (or the requestIds do not correlate)'));

    // ---- L9f: layer 3 — delivery. The REAL user message of THIS SDK turn
    // carries the delivered context.
    const transcriptRoots = [layout.claudeConfigDir, path.join(layout.home, '.claude')];
    // shell.eventually (the R2 shell's own) returns the callback's value; the
    // base chain's eventually is a boolean poller and must not be used here.
    const positiveTranscript = await shell.eventually(() => {
      const scan = readTranscriptUserMessages(transcriptRoots, positiveTurn.claudeSessionId);
      const hit = scan.messages.find(message => message.body.includes('<knowledge_context>'));
      return hit ? { ...scan, hit } : null;
    }, 60000, 500) || { messages: [], assistantCount: 0, assistantModels: [] };
    const deliveryBody = positiveTranscript.hit ? positiveTranscript.hit.body : '';
    const deliveryCarriesIdentifier = deliveryBody.toLowerCase().includes(token.toLowerCase());
    const deliveryCarriesSha = deliveryBody.includes(commitSha);
    const deliveryCarriesProject = deliveryBody.includes(PROJECT_ID);
    layer('L9f-delivery-model-request-carries-fact', {
      claudeSessionId: positiveTurn.claudeSessionId,
      transcriptUserMessages: positiveTranscript.messages.length,
      deliveredMessageLength: deliveryBody.length,
      requestCarriesKnowledgeContext: deliveryBody.includes('<knowledge_context>'),
      requestCarriesIdentifier: deliveryCarriesIdentifier,
      requestCarriesFullCommitSha: deliveryCarriesSha,
      requestCarriesProject: deliveryCarriesProject,
      deliveredExcerpt: deliveryBody.slice(0, 900),
      detail: 'the real user message of THIS claude session carries the product-delivered knowledge context, so the fact reached the real model request',
    });
    if (!deliveryCarriesIdentifier) fail('L9f-delivery-model-request-carries-fact', new Error('the real model request of this turn did not carry the identifier'));

    // ---- L9g: layer 4 — actual use. The model's own answer uses the fact.
    const answer = positiveTurn.answer;
    const answerCarriesIdentifier = answer.toLowerCase().includes(token.toLowerCase());
    const answerCarriesShaPrefix = (answer.match(/[0-9a-f]{7,40}/gi) || []).some(value => commitSha.startsWith(value.toLowerCase()));
    const answerStatesValue = /\b7\b|七/.test(answer);
    const controlAnswer = controlTurn.answer;
    const controlCarriesIdentifier = controlAnswer.toLowerCase().includes(token.toLowerCase());
    const controlCarriesShaPrefix = (controlAnswer.match(/[0-9a-f]{7,40}/gi) || []).some(value => commitSha.startsWith(value.toLowerCase()));
    layer('L9g-actual-use-model-answers-from-delivered-fact', {
      identifier: token,
      positiveAnswerCarriesIdentifier: answerCarriesIdentifier,
      positiveAnswerCarriesCommitShaPrefix: answerCarriesShaPrefix,
      positiveAnswerStatesPromotedValue: answerStatesValue,
      positiveAnswerHead: answer.slice(0, 1200),
      controlAnswerCarriesIdentifier: controlCarriesIdentifier,
      controlAnswerCarriesCommitShaPrefix: controlCarriesShaPrefix,
      controlAnswerHead: controlAnswer.slice(0, 800),
      detail: 'the model answered from the delivered context: the identifier exists nowhere in the workspace, so it can only come from the promoted knowledge',
    });
    if (!answerCarriesIdentifier) fail('L9g-actual-use-model-answers-from-delivered-fact', new Error('the model did not use the delivered identifier in its own answer'));

    // ---- L9h: the negative control must be clean at every layer. The
    // control project is registered and resolvable, so the engine really
    // answered for it: an empty answer is a decision, not a resolution
    // failure.
    const controlPrepared = preparedFor(controlTurn.sessionId);
    const controlFacts = controlPrepared && controlPrepared.responseBody && Array.isArray(controlPrepared.responseBody.facts) ? controlPrepared.responseBody.facts : [];
    const controlCarries = controlFacts.some(fact => fact && typeof fact.text === 'string' && fact.text.includes(token));
    const controlTranscript = readTranscriptUserMessages(transcriptRoots, controlTurn.claudeSessionId);
    const controlDelivery = controlTranscript.messages.some(message => message.body.toLowerCase().includes(token.toLowerCase()));
    const controlKnowledgeContextDelivered = controlTranscript.messages.some(message => message.body.includes('<knowledge_context>'));
    const controlCarriesValue = /valve_retry_limit:\s*7/.test(controlAnswer);
    layer('L9h-negative-control-clean', {
      controlEngineHttpStatus: controlPrepared ? controlPrepared.responseStatus : null,
      controlEngineStatus: controlPrepared && controlPrepared.responseBody ? controlPrepared.responseBody.status : null,
      controlEngineProjectId: controlPrepared && controlPrepared.responseBody ? controlPrepared.responseBody.projectId : null,
      controlFactCount: controlFacts.length,
      controlContextCarriesIdentifier: controlCarries,
      controlRequestCarriesIdentifier: controlDelivery,
      controlRequestCarriesKnowledgeContext: controlKnowledgeContextDelivered,
      controlAnswerCarriesIdentifier: controlCarriesIdentifier,
      controlAnswerCarriesCommitShaPrefix: controlCarriesShaPrefix,
      controlAnswerCarriesPromotedValue: controlCarriesValue,
      detail: 'the same driver, the same question, the same provider and the same file content in a knowledge-free workspace produce the identifier at no layer',
    });
    if (!controlPrepared || controlPrepared.responseStatus !== 200) fail('L9h-negative-control-clean', new Error(`the control session never reached the engine (HTTP ${controlPrepared ? controlPrepared.responseStatus : 'no call'})`));
    if (controlFacts.length) fail('L9h-negative-control-clean', new Error(`the control project received ${controlFacts.length} facts`));
    if (controlCarries || controlDelivery || controlCarriesIdentifier || controlCarriesShaPrefix || controlCarriesValue) fail('L9h-negative-control-clean', new Error('the negative control leaked the identifier'));

    // ---- L9i: the vendor-returned model. The assistant messages of the
    // transcript carry the model string the VENDOR returned; the SDK init
    // string is a local configuration echo and is not used as evidence.
    const positiveModels = positiveTranscript.assistantModels || [];
    const controlModels = positiveTranscript.assistantModels.length ? [] : (readTranscriptUserMessages(transcriptRoots, controlTurn.claudeSessionId).assistantModels || []);
    const vendorModels = positiveModels.length ? positiveModels : controlModels;
    const vendorMatches = vendorModels.length > 0 && vendorModels.every(value => value.replace(/\s+/g, '').toLowerCase() === modelUsed.replace(/\s+/g, '').toLowerCase());
    layer('L9i-vendor-returned-model', {
      requestedModel: modelUsed,
      sdkReportedModel: positiveTurn.sdkReportedModel,
      sdkReportedModelNote: 'the system/init model string the SDK reports; NOT by itself vendor-returned evidence',
      vendorReturnedModels: vendorModels,
      assistantMessageCount: positiveTranscript.assistantCount,
      vendorSource: 'CLI transcript of THIS run: entry.message.model of the type=assistant messages, correlated by claudeSessionId',
      vendorMatchesRequestedModel: vendorMatches,
    });
    if (!vendorModels.length) fail('L9i-vendor-returned-model', new Error('the CLI transcript of this run carries no assistant message model'));
    if (!vendorMatches) fail('L9i-vendor-returned-model', new Error(`the vendor returned ${vendorModels.join(', ')} instead of ${modelUsed}`));

    // ---- L10: the engine state after the session.
    const health = await engineCall(engineUrl, '/api/health');
    layer('L10-engine-state', { health: health.body });

    verdicts['RET-007-R2'] = 'PASS';
    const evidence = {
      probe: 'qa-autopilot/tools/product-probes/parallel-retrieval-followup-ret007-r2.js',
      date: new Date().toISOString(),
      batch: 'P-RETRIEVAL-FOLLOWUP-R2',
      expected: {
        '真实下一轮 Workbench 会话由产品自身把唯一事实交付给真实模型任务': preparedFact && moduleFact && deliveryCarriesIdentifier ? 'PASS' : 'FAIL',
        '同轮输出真的采用了该事实（且负控制干净）': answerCarriesIdentifier && !controlCarriesIdentifier ? 'PASS' : 'FAIL',
        '工作区本身不再泄漏该标识，因果链只可能来自交付的上下文': !workspaceCarriesIdentifier && !workspaceCarriesValue ? 'PASS' : 'FAIL',
        '模型字段取自供应商返回': vendorMatches ? 'PASS' : 'FAIL',
      },
      layers,
      verdicts,
      firstFailure,
    };
    const written = chain.writeEvidence('ret007-r2-session-evidence.json', evidence);
    console.log(JSON.stringify({ verdict: 'PASS', layers: Object.keys(layers), evidence: written.file, sha256: written.sha256, identifier: token, commitSha, model: modelUsed }, null, 2));
    console.log('parallel-retrieval-followup-ret007-r2 PASS');
  } catch (error) {
    const evidence = {
      probe: 'qa-autopilot/tools/product-probes/parallel-retrieval-followup-ret007-r2.js',
      date: new Date().toISOString(),
      batch: 'P-RETRIEVAL-FOLLOWUP-R2',
      layers,
      verdicts,
      firstFailure: firstFailure || { layer: 'unknown', message: String((error && error.message) || error), stack: String((error && error.stack) || '').split('\n').slice(0, 12) },
    };
    const written = chain.writeEvidence('ret007-r2-session-evidence.json', evidence);
    console.error(JSON.stringify(evidence.firstFailure, null, 2));
    console.error(`evidence: ${written.file}`);
    console.log('parallel-retrieval-followup-ret007-r2 FAIL');
    process.exitCode = 1;
  } finally {
    for (const stop of stops.reverse()) { await stop().catch(() => {}); }
    if (hostChild && hostChild.child && hostChild.child.exitCode === null) {
      hostChild.child.kill();
      await Promise.race([hostChild.exited, new Promise(resolve => setTimeout(resolve, 5000))]);
    }
    await shell.removeTreeAsync(root);
    await shell.removeTreeAsync(wsRoot);
    chain.cleanupIsolatedProcess();
  }
})();
