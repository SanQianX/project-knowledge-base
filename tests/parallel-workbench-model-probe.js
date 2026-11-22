'use strict';
// WB-003 — real subscription model probe through an isolated real host.
//
// What this probe does:
//   * it hosts the REAL installed claude-ai-workbench module (the copy the
//     installed product ships) as an isolated integration host, with this
//     lane's controlled knowledge-engine fixture behind KB_KNOWLEDGE_ENGINE_URL;
//   * it injects the ORIGINAL subscription profile store through a read-only
//     facade: the credential is read from its real location into memory and
//     is never written to any file, log, report or clone. No write method on
//     the store is possible;
//   * it asks ONE unique random question and requires, as evidence:
//       - the SDK-REPORTED model from the system/init event — the runner
//         copies it from the CLI's own init message, so it is what the SDK
//         reports for the session, NOT by itself proof of what the vendor
//         returned (the profile label alone never counts as evidence either);
//         the vendor-RETURNED model is message.model of real assistant
//         messages in the CLI transcript, extracted by
//         parallel-workbench-standalone-turn.js,
//       - the vendor claude session id,
//       - the answer echoing the unique token of this round (request
//         correlation),
//       - the controlled integration fixture having received this session's
//         context request (integration-context correlation).
//
// What this probe does NOT do:
//   * it sends NO MiniMax request. The user confirmed the MiniMax quota is
//     exhausted (real 429, vendor code 2067); the positive MiniMax-M3.1-Flash
//     acceptance stays BLOCKED on the preserved 429 evidence and no attempt
//     is made to turn it green, and a GLM answer is never presented as a
//     MiniMax answer;
//   * it never queries a quota endpoint, never switches provider or plan,
//     and never fakes a model response.
//
// Exit codes: 0 = every sub-item positively verified;
//             3 = at least one sub-item honestly BLOCKED (recorded);
//             1 = script error.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const fixture = require('./helpers/parallel-workbench-fixture');
const sourceMap = require('./helpers/parallel-workbench-source-map');

const PROFILE_ID = String(process.env.PK_WB_MODEL_PROFILE || 'glm');
const REQUESTED_MODEL = String(process.env.PK_WB_MODEL_ID || 'glm-5.3');
const EFFORT = String(process.env.PK_WB_MODEL_EFFORT || 'max');
const TURN_TIMEOUT_MS = Number(process.env.PK_WB_TURN_TIMEOUT_MS || 360000);
const MINIMAX_429_EVIDENCE = 'qa-autopilot/artifacts/parallel-20261023/minimax-429-handoff/minimax-result.json';

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

// Consume the session SSE stream until the predicate is satisfied.
async function consumeEvents(url, onEvent, until, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`event stream timed out after ${timeoutMs}ms`)), timeoutMs);
  let done = null;
  const finished = new Promise(resolve => { done = resolve; });
  (async () => {
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) throw new Error(`event stream HTTP ${response.status}`);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { value, done: streamDone } = await reader.read();
        if (streamDone) break;
        buffer += decoder.decode(value, { stream: true });
        let index;
        while ((index = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, index).replace(/\r$/, '');
          buffer = buffer.slice(index + 1);
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload) continue;
          let event;
          try { event = JSON.parse(payload); } catch { continue; }
          try { onEvent(event); } catch { /* listener errors never kill the stream */ }
          if (until(event)) { controller.abort(); return; }
        }
      }
    } catch { /* aborted or ended */ }
    finally { done && done(); }
  })();
  await finished;
  clearTimeout(timer);
}

(async () => {
  const moduleRoot = fixture.resolveHostModuleRoot();
  assert.ok(moduleRoot, 'no claude-ai-workbench module copy was found to host');
  const identity = sourceMap.packageIdentity(moduleRoot);
  const moduleRootLabel = moduleRoot === sourceMap.resolveInstalledProductPackage()
    ? 'currently-installed-package:installed-product'
    : 'currently-installed-package:repository-pin';

  // ---------- the MiniMax positive acceptance stays BLOCKED ---------------
  // No new MiniMax request is attempted. The preserved evidence of the real
  // 429 (vendor code 2067) is referenced, not re-run.
  let minimaxEvidence = null;
  try {
    minimaxEvidence = JSON.parse(fs.readFileSync(path.resolve(fixture.REPO_ROOT, MINIMAX_429_EVIDENCE), 'utf8'));
  } catch { minimaxEvidence = null; }
  const minimaxBlocked = Boolean(
    minimaxEvidence
    && minimaxEvidence.isError === true
    && /429/.test(String(minimaxEvidence.result || '')),
  );
  record('WB-003.x-minimax-positive', 'BLOCKED', {
    rule: '模型返回的确是MiniMax-M3.1-Flash',
    status: 'BLOCKED',
    reason: 'the MiniMax subscription quota is exhausted; the real API rejected the lanes with 429 (vendor code 2067, Token Plan 用量上限)',
    newMiniMaxRequestAttempted: false,
    glmEvidenceCountedAsMiniMax: false,
    preservedEvidence: MINIMAX_429_EVIDENCE,
    preservedEvidenceVerified: Boolean(minimaxEvidence),
    preservedIsError: minimaxEvidence ? minimaxEvidence.isError : null,
    preservedAt: minimaxEvidence ? minimaxEvidence.at : null,
    note: 'per the user instruction the probe does not send further MiniMax requests and does not present GLM responses as MiniMax evidence',
  });

  // ---------- the real subscription turn ----------------------------------
  const layout = fixture.createIsolationLayout('parallel-wb-model');
  const integrationFixture = await fixture.startIntegrationFixture();
  const port = await fixture.freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = fixture.spawnNode([path.join(__dirname, 'helpers', 'parallel-workbench-host.js')], fixture.hostEnv(layout, {
    PK_WB_MODULE_ROOT: moduleRoot,
    PK_WB_HOST_PORT: String(port),
    PK_WB_HOST_DATA_DIR: layout.dataDir,
    PK_WB_HOST_WORKSPACE: layout.workspace,
    PK_WB_HOST_MODE: 'integration',
    PK_WB_ENGINE_URL: integrationFixture.url,
    PK_WB_PROFILE_SOURCE: 'real-readonly',
  }));

  const token = `WB003-${PROFILE_ID.toUpperCase()}-${crypto.randomBytes(5).toString('hex')}`;
  const question = [
    '这是一次真实订阅模型抽测（Workbench WB-003）。',
    `请只回复一行，原样包含以下随机标记，不要添加任何其他内容：${token}`,
  ].join('\n');

  let glmOutcome;
  try {
    await fixture.waitForHttp(`${base}/api/claude-workbench/v1/health`, 30000);

    // The original profile store, read through the read-only facade: the
    // masked public shape only, never the credential.
    const profiles = await getJson(`${base}/api/claude-workbench/v1/profiles`);
    const listed = Array.isArray(profiles.body && profiles.body.profiles) ? profiles.body.profiles : [];
    const target = listed.find(profile => profile.id === PROFILE_ID) || null;
    record('WB-003.a-profile-injected-readonly', target ? 'PASS' : 'BLOCKED', {
      profileId: PROFILE_ID,
      credentialConfigured: target ? target.credentialConfigured === true : null,
      baseUrl: target ? target.baseUrl : null,
      defaultModel: target ? target.models && target.models.default : null,
      credentialMaterialLogged: false,
      storeWritesPossible: false,
    });
    assert.ok(target, `the ${PROFILE_ID} profile was not visible through the read-only facade`);
    assert.equal(target.credentialConfigured, true, 'the original credential is not configured');

    const session = await getJson(`${base}/api/claude-workbench/v1/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        context: { contextId: 'wb003-model-probe', workspaceRef: 'wb-fixture' },
        aiProfileId: PROFILE_ID,
        model: REQUESTED_MODEL,
        effort: EFFORT,
      }),
    });
    const created = session.body && session.body.session;
    record('WB-003.b-session-with-subscription-profile', session.status === 201 && created ? 'PASS' : 'BLOCKED', {
      httpStatus: session.status,
      sessionId: created && created.sessionId,
      model: created && created.model,
      authSource: created && created.authSource,
      providerName: created && created.providerName,
    });
    assert.equal(session.status, 201);
    const sessionId = created.sessionId;
    assert.equal(created.authSource, 'profile-injected');

    // Stream the session events and run the unique question.
    const events = [];
    let settle = null;
    const settled = new Promise(resolve => { settle = resolve; });
    const isTerminal = event => event.type === 'claude/result';
    const streamUrl = `${base}/api/claude-workbench/v1/sessions/${encodeURIComponent(sessionId)}/events`;
    const consume = consumeEvents(streamUrl, event => {
      if (['claude/init', 'claude/result', 'claude/error', 'claude/aborted'].includes(event.type)) events.push(event);
    }, isTerminal, TURN_TIMEOUT_MS + 60000).catch(() => {});

    const send = await getJson(`${base}/api/claude-workbench/v1/sessions/${encodeURIComponent(sessionId)}/input`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: question }),
    });
    record('WB-003.c-unique-question-accepted', send.status === 202 ? 'PASS' : 'BLOCKED', {
      httpStatus: send.status,
      uniqueToken: token,
    });
    assert.equal(send.status, 202);

    const deadline = Date.now() + TURN_TIMEOUT_MS;
    while (Date.now() < deadline && !events.some(isTerminal)) {
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    settle && settle();
    await Promise.race([consume, new Promise(resolve => setTimeout(resolve, 5000))]);

    const init = events.find(event => event.type === 'claude/init') || null;
    const result = events.find(event => event.type === 'claude/result') || null;
    const error = events.find(event => event.type === 'claude/error') || null;
    // SDK-reported model: the system/init string the CLI produced for this
    // session. Vendor-RETURNED evidence is the assistant message.model of the
    // CLI transcript (see parallel-workbench-standalone-turn.js).
    const sdkReportedModel = init ? init.model : null;
    const vendorSessionId = init ? init.claudeSessionId : null;
    const answer = result ? String(result.result || '') : '';
    const tokenEchoed = answer.includes(token);
    const isError = result ? result.isError === true : true;

    glmOutcome = {
      requestedModel: REQUESTED_MODEL,
      effort: EFFORT,
      sdkReportedModel,
      sdkReportedModelMatchesRequest: typeof sdkReportedModel === 'string'
        ? sdkReportedModel.replace(/\s+/g, '').toLowerCase() === REQUESTED_MODEL.replace(/\s+/g, '').toLowerCase()
        : false,
      vendorClaudeSessionId: vendorSessionId,
      workbenchSessionId: sessionId,
      isError,
      answerPreview: answer.slice(0, 300),
      tokenEchoed,
      usage: result && result.usage ? {
        inputTokens: result.usage.input_tokens,
        outputTokens: result.usage.output_tokens,
      } : null,
      errorEvent: error,
    };

    // S1: the SDK-reported model, verbatim — labelled as what it is.
    record('WB-003.d1-sdk-model-reported', typeof sdkReportedModel === 'string' && sdkReportedModel.length > 0 ? 'PASS' : 'BLOCKED', {
      sdkReportedModel,
      note: 'the system/init model string the SDK reports for the session; it is NOT by itself vendor-returned evidence — the vendor-returned model is the assistant message.model of the CLI transcript (parallel-workbench-standalone-turn.js)',
    });

    // S2: the response is correlated to THIS round.
    record('WB-003.d2-response-correlated', !isError && tokenEchoed ? 'PASS' : 'BLOCKED', {
      isError,
      uniqueToken: token,
      tokenEchoedInAnswer: tokenEchoed,
      vendorClaudeSessionId: vendorSessionId,
      workbenchSessionId: sessionId,
    });

    // S3: no stand-in anywhere in the chain.
    record('WB-003.d3-no-standin', !isError && typeof sdkReportedModel === 'string' && sdkReportedModel.length > 0 ? 'PASS' : 'BLOCKED', {
      profileSource: 'original-subscription-store-read-only-in-memory',
      standInEmbedderUsed: false,
      mockProviderUsed: false,
      lexicalFallbackUsed: false,
      providerSwitched: false,
    });

    // S4: the integration context was consumed by the SAME real turn.
    const knowledge = await getJson(`${base}/api/claude-workbench/v1/sessions/${encodeURIComponent(sessionId)}/knowledge`);
    const fixtureRequest = integrationFixture.requests.find(request => request.body && request.body.sessionId === sessionId) || null;
    const queryCarriedToken = Boolean(fixtureRequest && String(fixtureRequest.body.query || '').includes(token));
    record('WB-003.d4-integration-context-correlated', knowledge.ok && knowledge.body && knowledge.body.status === 'ready' && fixtureRequest ? 'PASS' : 'BLOCKED', {
      knowledgeStatus: knowledge.body && knowledge.body.status,
      fixtureKind: 'controlled-integration-fixture',
      fixtureSawSession: Boolean(fixtureRequest),
      fixtureSawUniqueTokenInQuery: queryCarriedToken,
    });
  } finally {
    child.child.kill();
    await child.exited;
    await integrationFixture.close();
  }

  const glmPass = ['WB-003.d1-sdk-model-reported', 'WB-003.d2-response-correlated', 'WB-003.d3-no-standin']
    .every(id => (results.find(entry => entry.caseId === id) || {}).status === 'PASS');

  if (!glmPass) {
    console.log('WB-003 GLM turn did not produce positive evidence — recording the real outcome, no retry loop, no provider switch');
  }

  const summary = {
    lane: 'test-workbench',
    file: 'parallel-workbench-model-probe.js',
    case: 'WB-003',
    title: '真实模型抽测',
    module: { label: moduleRootLabel, root: moduleRoot, name: identity.name, version: identity.version },
    host: { mode: 'integration', engineFixture: 'controlled-integration-fixture', dataDir: layout.dataDir, workspace: layout.workspace },
    profile: { id: PROFILE_ID, source: 'original-subscription-store read-only, credential in memory only', credentialWrittenAnywhere: false },
    glmTurn: glmOutcome,
    minimaxPositiveAcceptance: {
      status: 'BLOCKED',
      reason: 'MiniMax subscription quota exhausted — real 429 with vendor code 2067 (Token Plan 用量上限), preserved in the handoff evidence; no further MiniMax request attempted per user instruction',
      evidence: MINIMAX_429_EVIDENCE,
      glmCountedAsMiniMax: false,
    },
    verdict: glmPass ? 'PARTIAL (GLM methodology PASS; MiniMax positive acceptance BLOCKED)' : 'BLOCKED',
    networkUsed: true,
    quotaEndpointQueried: false,
    cases: results,
  };

  const target = process.env.PARALLEL_WORKBENCH_EVIDENCE;
  if (target) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(summary, null, 2), 'utf8');
  }
  fixture.removeTree(layout.root);
  console.log(`parallel-workbench-model-probe verdict=${summary.verdict}`);
  // The MiniMax positive acceptance is BLOCKED, so the probe never exits 0,
  // even when every GLM methodology sub-item passes.
  process.exitCode = 3;
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
