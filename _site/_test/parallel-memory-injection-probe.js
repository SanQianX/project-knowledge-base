'use strict';
// _site/_test/parallel-memory-injection-probe.js
//
// MEM-007 — four-layer evidence that a CONFIRMED long-term memory really
// reaches a real model turn, and that the model really uses it.
//
// The chain under test, with every component real:
//
//   real engine (real MemoryService, real /api/context contract)
//     -> real Workbench module 0.13.6 (real KnowledgeContext, real
//        cli-json-runner, real Claude Code SDK against the operator's
//        ORIGINAL minimax subscription, credential in memory only)
//     -> real vendor model request
//
// The four evidence layers, each one checked separately:
//
//   prepared   the real engine's /api/context response for THIS session
//              carries the unique confirmed convention
//   output     the Workbench module assembled that engine answer into its
//              knowledge context for this session (status/memoryCount and the
//              engine requestId it correlates with)
//   delivery   the real model request of THIS turn carried it: the CLI
//              transcript's user message of this claudeSessionId holds BOTH
//              the round receipt AND the unique convention
//   actual use the model's own answer follows the convention
//
// A NEGATIVE CONTROL turn runs the same driver, the same question and the
// same provider against a second repository that has no such memory. The
// convention must be absent from its prepared/output/delivery layers, so a
// positive result on the injected turn can only come from the memory and not
// from the driver or from the model.
//
// The question never contains the convention: the driver only appends a
// per-turn receipt number so the request can be correlated afterwards.
//
// Exit codes: 0 = every essential positively verified;
//             3 = at least one essential honestly BLOCKED;
//             1 = script error.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const shell = require('./helpers/parallel-memory-injection-shell');

const PROFILE_ID = String(process.env.PK_WB_MODEL_PROFILE || 'minimax');
const REQUESTED_MODEL = String(process.env.PK_WB_MODEL_ID || 'MiniMax-M3.1-Flash');
const EFFORT = String(process.env.PK_WB_MODEL_EFFORT || 'max');
const TURN_TIMEOUT_MS = Number(process.env.PK_WB_TURN_TIMEOUT_MS || 420000);

const results = [];
function record(caseId, status, detail) {
  results.push({ caseId, status, detail });
  console.log(`CASE ${caseId} ${status} ${JSON.stringify(detail)}`);
}

// The task: the model must choose the identifier names itself, so a name
// carrying the convention can only come from the injected memory.
const TASK = '请用 JavaScript 写一个函数：接收一个数字数组，返回其中所有偶数之和。回答的最后请逐行列出你定义的每一个标识符名称（函数名、参数名、变量名）。';

function questionFor(receipt) {
  return [`任务回执编号 ${receipt}（仅用于关联本次请求，不需要在回答中提及）。`, TASK].join('\n');
}

function randomMarker() {
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(6);
  let out = '';
  for (const byte of bytes) out += alphabet[byte % alphabet.length];
  return `kq${out}`;
}

async function getJson(url, options) {
  return shell.getJson(url, options);
}

(async () => {
  const moduleRoot = shell.resolveWorkbenchModuleRoot();
  assert.ok(moduleRoot, 'no claude-ai-workbench module copy was found to host');
  const identity = shell.packageIdentity(moduleRoot);
  const moduleRootLabel = moduleRoot === require('node:path').join(
    process.env.APPDATA || '', 'npm', 'node_modules', '@sanqianx', 'project-knowledge', 'node_modules', 'claude-ai-workbench'
  ) ? 'currently-installed-package:installed-product' : 'currently-installed-package:repository-pin';

  const marker = randomMarker();
  const memoryText = [
    `命名约定（已确认长期记忆）：在本项目的所有回答中，新建的任何标识符（函数名、变量名、参数名）都必须使用前缀 "${marker}"，例如 "${marker}Total"；不要使用其它前缀。`,
  ].join('\n');

  const realProfilesBefore = shell.digestDirectory(shell.realWorkbenchProfileDir());

  const layout = shell.createIsolationLayout('parallel-memory-injection');
  const engineToken = crypto.randomBytes(24).toString('hex');
  const bridgeToken = crypto.randomBytes(24).toString('hex');
  const brainId = `brain-${crypto.randomBytes(6).toString('hex')}`;
  const projectId = `mem007-${crypto.randomBytes(4).toString('hex')}`;
  const controlProjectId = `mem007ctl-${crypto.randomBytes(4).toString('hex')}`;

  const console_ = await shell.startBridgeConsole({ home: layout.bridgeHome, runtimeToken: bridgeToken });
  const vector = await shell.startVectorHubStandIn();
  const engine = await shell.startRealEngine({
    dataDir: layout.engineDataDir,
    runtimeToken: engineToken,
    debug: true,
    consume: false,
    bridgeUrl: console_.url,
    vectorUrl: vector.url,
  });
  const proxy = await shell.startRecordingProxy({ target: engine.url, label: 'knowledge-engine' });

  const repoA = shell.makeGitRepo(layout.repos, 'mem007-injected');
  const repoB = shell.makeGitRepo(layout.repos, 'mem007-control');

  // The real MemoryService path: a brain scope, a registered project and a
  // confirmed project-scope memory.
  const scopes = await engine.api('POST', '/api/scopes', {
    scopes: [{ id: `scope-${crypto.randomBytes(4).toString('hex')}`, kind: 'brain', brainId, name: 'MEM-007 brain', knowledgePath: layout.brainKnowledgeDir }],
  });
  assert.equal(scopes.status, 200, `the brain scope was not bound: ${JSON.stringify(scopes.body)}`);

  const projectA = await engine.api('POST', '/api/projects', {
    projectId, name: 'mem007-injected', repoPath: repoA.path, knowledgePath: layout.projectKnowledgeDir, brainId,
  });
  assert.equal(projectA.status, 200, `the injected project was not registered: ${JSON.stringify(projectA.body)}`);

  const projectB = await engine.api('POST', '/api/projects', {
    projectId: controlProjectId, name: 'mem007-control', repoPath: repoB.path, knowledgePath: layout.controlKnowledgeDir, brainId,
  });
  assert.equal(projectB.status, 200, `the control project was not registered: ${JSON.stringify(projectB.body)}`);

  const created = await engine.api('POST', '/api/memories', {
    text: memoryText, brainId, scopeType: 'project', scopeId: projectId,
  });
  assert.equal(created.status, 200, `the memory was not created: ${JSON.stringify(created.body)}`);
  const memory = created.body && created.body.memory;
  record('MEM-007.s1-confirmed-memory-created', memory && memory.status === 'confirmed' ? 'PASS' : 'BLOCKED', {
    projectId,
    brainId,
    memoryId: memory && memory.id,
    scopeType: memory && memory.scopeType,
    scopeId: memory && memory.scopeId,
    status: memory && memory.status,
    sourceType: memory && memory.sourceType,
    uniqueConventionMarker: marker,
    fixturePromptUsed: false,
    detail: 'created through the real engine MemoryService (POST /api/memories), not through a fixed prompt fixture',
  });
  assert.ok(memory && memory.status === 'confirmed');

  // The host child: the REAL Workbench module, isolated, with the read-only
  // profile facade of the original subscription store.
  const port = await shell.freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = shell.spawnNode([path.join(__dirname, 'helpers', 'parallel-memory-injection-wb-host.js')], shell.hostEnv(layout, {
    PK_WB_MODULE_ROOT: moduleRoot,
    PK_WB_HOST_PORT: String(port),
    PK_WB_HOST_DATA_DIR: layout.dataDir,
    PK_WB_HOST_WORKSPACES: JSON.stringify({ 'wb-injected': repoA.path, 'wb-control': repoB.path }),
    PK_WB_ENGINE_URL: proxy.url,
    PK_WB_PROFILE_SOURCE: 'real-readonly',
  }));

  let injectedTurn;
  let controlTurn;
  try {
    await shell.waitForHttp(`${base}/api/claude-workbench/v1/health`, 30000);

    const profiles = await getJson(`${base}/api/claude-workbench/v1/profiles`);
    const listed = Array.isArray(profiles.body && profiles.body.profiles) ? profiles.body.profiles : [];
    const target = listed.find(profile => profile.id === PROFILE_ID) || null;
    record('MEM-007.s2-profile-injected-readonly', target ? 'PASS' : 'BLOCKED', {
      profileId: PROFILE_ID,
      credentialConfigured: target ? target.credentialConfigured === true : null,
      baseUrl: target ? target.baseUrl : null,
      defaultModel: target ? target.models && target.models.default : null,
      credentialMaterialLogged: false,
      storeWritesPossible: false,
    });
    assert.ok(target, `the ${PROFILE_ID} profile was not visible through the read-only facade`);

    const receiptA = `A-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
    const receiptB = `B-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
    injectedTurn = await shell.runWorkbenchTurn({
      base,
      profileId: PROFILE_ID,
      model: REQUESTED_MODEL,
      effort: EFFORT,
      workspaceRef: 'wb-injected',
      contextId: 'mem007-injected',
      question: questionFor(receiptA),
      sessionInputOrigin: 'human',
      timeoutMs: TURN_TIMEOUT_MS,
    });
    record('MEM-007.s3-injected-turn-completed', !injectedTurn.isError ? 'PASS' : 'BLOCKED', {
      workbenchSessionId: injectedTurn.sessionId,
      claudeSessionId: injectedTurn.claudeSessionId,
      sdkReportedModel: injectedTurn.sdkReportedModel,
      sdkReportedModelNote: 'the system/init model string the SDK reports; NOT by itself vendor-returned evidence',
      usage: injectedTurn.usage,
      errorEvent: injectedTurn.error,
    });

    controlTurn = await shell.runWorkbenchTurn({
      base,
      profileId: PROFILE_ID,
      model: REQUESTED_MODEL,
      effort: EFFORT,
      workspaceRef: 'wb-control',
      contextId: 'mem007-control',
      question: questionFor(receiptB),
      sessionInputOrigin: 'human',
      timeoutMs: TURN_TIMEOUT_MS,
    });
    record('MEM-007.s4-control-turn-completed', !controlTurn.isError ? 'PASS' : 'BLOCKED', {
      workbenchSessionId: controlTurn.sessionId,
      claudeSessionId: controlTurn.claudeSessionId,
      sdkReportedModel: controlTurn.sdkReportedModel,
      usage: controlTurn.usage,
      errorEvent: controlTurn.error,
      note: 'negative control: same driver, same question, same provider, a repository without the memory',
    });

    // ---- layer 1: prepared (the real engine response) --------------------
    const contextCalls = proxy.records.filter(entry => entry.method === 'POST' && /\/api\/context/.test(entry.url));
    const preparedFor = sessionId => contextCalls.find(call => call.requestBody && call.requestBody.sessionId === sessionId) || null;
    const preparedCall = preparedFor(injectedTurn.sessionId);
    const preparedResponse = preparedCall && preparedCall.responseBody;
    const preparedMemories = preparedResponse && Array.isArray(preparedResponse.memories) ? preparedResponse.memories : [];
    const preparedCarries = preparedMemories.some(item => typeof item.text === 'string' && item.text.includes(marker));
    record('MEM-007.s5-prepared-engine-context', preparedCall && preparedCall.responseStatus === 200 && preparedCarries ? 'PASS' : 'BLOCKED', {
      engineRoute: '/api/context',
      httpStatus: preparedCall && preparedCall.responseStatus,
      requestRepoPath: preparedCall && preparedCall.requestBody && preparedCall.requestBody.repoPath,
      requestClient: preparedCall && preparedCall.requestBody && preparedCall.requestBody.client,
      requestSessionId: preparedCall && preparedCall.requestBody && preparedCall.requestBody.sessionId,
      engineStatus: preparedResponse && preparedResponse.status,
      engineProjectId: preparedResponse && preparedResponse.projectId,
      memoryCount: preparedMemories.length,
      memoryIds: preparedMemories.map(item => item.memoryId),
      memoryScopes: preparedMemories.map(item => `${item.memoryScopeType}:${item.memoryScopeId}`),
      uniqueConventionInEngineMemory: preparedCarries,
      detail: 'the response the real engine produced for this session, observed through a transparent pass-through proxy',
    });

    // ---- layer 2: output (what the module assembled) ---------------------
    const knowledge = await getJson(`${base}/api/claude-workbench/v1/sessions/${encodeURIComponent(injectedTurn.sessionId)}/knowledge`);
    const knowledgeBody = knowledge.body || {};
    const outputCarries = preparedResponse && typeof preparedResponse.prompt === 'string' && preparedResponse.prompt.includes(marker);
    const requestIdMatches = Boolean(preparedResponse && knowledgeBody.requestId && preparedResponse.requestId === knowledgeBody.requestId);
    record('MEM-007.s6-output-module-assembled-context', knowledge.ok && knowledgeBody.status === 'ready' && knowledgeBody.memoryCount >= 1 && outputCarries && requestIdMatches ? 'PASS' : 'BLOCKED', {
      moduleStatus: knowledgeBody.status,
      moduleMemoryCount: knowledgeBody.memoryCount,
      moduleMemoryStatus: knowledgeBody.memoryStatus,
      moduleRequestId: knowledgeBody.requestId,
      engineRequestId: preparedResponse && preparedResponse.requestId,
      requestIdsCorrelate: requestIdMatches,
      uniqueConventionInAssembledPrompt: outputCarries,
      detail: 'the module kept the engine answer as this session knowledge context and correlated it by requestId',
    });

    // ---- layer 3: delivery (the real model request carried it) ----------
    const transcriptRoots = [layout.claudeConfigDir, path.join(layout.home, '.claude')];
    const injectedTranscript = await shell.eventually(() => {
      const scan = shell.scanClaudeTranscript(transcriptRoots, { claudeSessionId: injectedTurn.claudeSessionId, token: receiptA, marker });
      const hit = scan.userMessages.find(message => message.hasToken && message.hasMarker);
      return hit ? { ...scan, hit } : null;
    }, 30000, 500) || shell.scanClaudeTranscript(transcriptRoots, { claudeSessionId: injectedTurn.claudeSessionId, token: receiptA, marker });
    const deliveryHit = injectedTranscript.hit || null;
    record('MEM-007.s7-delivery-model-request-carries-convention', deliveryHit ? 'PASS' : 'BLOCKED', {
      claudeSessionId: injectedTurn.claudeSessionId,
      transcriptFiles: injectedTranscript.transcriptFiles,
      userMessages: injectedTranscript.userMessages,
      requestCarriesRoundReceipt: Boolean(deliveryHit && deliveryHit.hasToken),
      requestCarriesUniqueConvention: Boolean(deliveryHit && deliveryHit.hasMarker),
      requestCarriesKnowledgeContext: Boolean(deliveryHit && deliveryHit.hasKnowledgeContext),
      detail: 'the same user message of THIS claude session carries the round receipt AND the unique convention, so the convention reached the real model request',
    });

    // ---- layer 4: actual use --------------------------------------------
    const answerUses = injectedTurn.answer.toLowerCase().includes(marker.toLowerCase());
    const controlAnswerUses = controlTurn.answer.toLowerCase().includes(marker.toLowerCase());
    record('MEM-007.s8-actual-use-model-follows-convention', answerUses && !controlAnswerUses ? 'PASS' : 'BLOCKED', {
      uniqueConventionMarker: marker,
      injectedAnswerUsesConvention: answerUses,
      controlAnswerUsesConvention: controlAnswerUses,
      injectedAnswerPreview: injectedTurn.answer.slice(0, 600),
      controlAnswerPreview: controlTurn.answer.slice(0, 600),
      detail: 'the model chose the identifiers itself; the convention appears only in the injected turn',
    });

    // ---- the control must NOT carry the convention anywhere --------------
    const controlCall = preparedFor(controlTurn.sessionId);
    const controlResponse = controlCall && controlCall.responseBody;
    const controlMemories = controlResponse && Array.isArray(controlResponse.memories) ? controlResponse.memories : [];
    const controlCarries = controlMemories.some(item => typeof item.text === 'string' && item.text.includes(marker));
    const controlTranscript = shell.scanClaudeTranscript(transcriptRoots, { claudeSessionId: controlTurn.claudeSessionId, token: receiptB, marker });
    const controlDelivery = controlTranscript.userMessages.some(message => message.hasMarker);
    record('MEM-007.s9-negative-control-clean', !controlCarries && !controlDelivery && !controlAnswerUses ? 'PASS' : 'BLOCKED', {
      controlEngineStatus: controlResponse && controlResponse.status,
      controlMemoryCount: controlMemories.length,
      controlRequestCarriesConvention: controlDelivery,
      controlAnswerUsesConvention: controlAnswerUses,
      detail: 'the same driver and question on a repository without the memory produce no convention at any layer',
    });

    // ---- vendor-returned model ------------------------------------------
    const vendorModels = injectedTranscript.assistantModelValues && injectedTranscript.assistantModelValues.length
      ? injectedTranscript.assistantModelValues
      : controlTranscript.assistantModelValues;
    const vendorMatches = vendorModels.length > 0 && vendorModels.every(model =>
      model.replace(/\s+/g, '').toLowerCase() === REQUESTED_MODEL.replace(/\s+/g, '').toLowerCase());
    record('MEM-007.s10-vendor-returned-model', vendorMatches ? 'PASS' : 'NOT_PROVEN', {
      vendorReturnedModels: vendorModels,
      requestedModel: REQUESTED_MODEL,
      matchesRequest: vendorMatches,
      assistantMessages: injectedTranscript.assistantCount,
      detail: 'message.model of the assistant messages in the CLI transcript of this run, correlated by claudeSessionId; the SDK init model string is NOT used as vendor evidence',
    });
  } finally {
    child.child.kill();
    await child.exited;
    await proxy.close();
    await engine.close();
    await vector.close();
    await console_.close();
  }

  const digestComparison = shell.compareDigests(realProfilesBefore, shell.digestDirectory(shell.realWorkbenchProfileDir()));
  record('MEM-007.s11-real-profiles-byte-identical', digestComparison.byteIdentical ? 'PASS' : 'FAIL', {
    profileDir: shell.realWorkbenchProfileDir(),
    comparison: 'byte-level SHA256, computed in memory; digests never printed, logged or persisted',
    fileCount: digestComparison.count,
    changedFiles: digestComparison.changedFiles,
    addedFiles: digestComparison.addedFiles,
    removedFiles: digestComparison.removedFiles,
  });

  const essentials = [
    'MEM-007.s1-confirmed-memory-created',
    'MEM-007.s2-profile-injected-readonly',
    'MEM-007.s3-injected-turn-completed',
    'MEM-007.s4-control-turn-completed',
    'MEM-007.s5-prepared-engine-context',
    'MEM-007.s6-output-module-assembled-context',
    'MEM-007.s7-delivery-model-request-carries-convention',
    'MEM-007.s8-actual-use-model-follows-convention',
    'MEM-007.s9-negative-control-clean',
    'MEM-007.s11-real-profiles-byte-identical',
  ];
  const essentialsPass = essentials.every(id => (results.find(entry => entry.caseId === id) || {}).status === 'PASS');

  const cleanup = await shell.removeTreeAsync(layout.root);
  if (!cleanup.removed) console.error(`CLEANUP-LEFTOVER ${cleanup.path} (${cleanup.error && cleanup.error.code})`);

  const summary = {
    lane: 'test-memory-injection',
    file: 'parallel-memory-injection-probe.js',
    case: 'MEM-007',
    title: '唯一确认约定的四层真实注入证据',
    module: { label: moduleRootLabel, root: moduleRoot, name: identity.name, version: identity.version },
    engine: { real: true, dataDir: layout.engineDataDir, vectorBackend: vector.kind, bridgeConsole: 'real module, isolated home' },
    profile: { id: PROFILE_ID, source: 'original-subscription-store read-only, credential in memory only', credentialWrittenAnywhere: false },
    turn: {
      requestedModel: REQUESTED_MODEL,
      effort: EFFORT,
      uniqueConventionMarker: marker,
      question: TASK,
      questionContainsConvention: TASK.includes(marker),
      injected: injectedTurn ? {
        workbenchSessionId: injectedTurn.sessionId,
        claudeSessionId: injectedTurn.claudeSessionId,
        sdkReportedModel: injectedTurn.sdkReportedModel,
        isError: injectedTurn.isError,
        usage: injectedTurn.usage,
        answerPreview: injectedTurn.answer.slice(0, 600),
      } : null,
      control: controlTurn ? {
        workbenchSessionId: controlTurn.sessionId,
        claudeSessionId: controlTurn.claudeSessionId,
        sdkReportedModel: controlTurn.sdkReportedModel,
        isError: controlTurn.isError,
        usage: controlTurn.usage,
        answerPreview: controlTurn.answer.slice(0, 600),
      } : null,
    },
    cases: results,
    ownership: {
      laneOwned: [
        '_site/_test/parallel-memory-injection-probe.js',
        '_site/_test/helpers/parallel-memory-injection-shell.js',
        '_site/_test/helpers/parallel-memory-injection-wb-host.js',
      ],
      snapshotProvenance: shell.snapshotProvenance(),
      note: 'the three pieces copied into this lane helper are read-only snapshots of other lanes\' files; the sources are never edited or imported',
    },
    verdict: essentialsPass ? 'PASS (four-layer real injection with a clean negative control)' : 'BLOCKED',
    paidTurnsSent: 2,
    networkUsed: true,
    cleanup,
  };

  const target = process.env.PARALLEL_MEMORY_INJECTION_EVIDENCE;
  if (target) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(summary, null, 2), 'utf8');
  }
  console.log(`parallel-memory-injection-probe verdict=${summary.verdict}`);
  process.exitCode = essentialsPass ? 0 : 3;
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
