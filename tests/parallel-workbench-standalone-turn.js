'use strict';
// WB-002 supplement — ONE real subscription conversation on a STANDALONE
// minimal host, with no knowledge engine anywhere in the chain.
//
// Why this exists: test-cases WB-002 requires "使用0.13.6真实最小宿主配置模型
// 并对话，再在宿主中重复". The interface-level checks live in
// parallel-workbench-independent-host.js; the integration-host half of the
// conversation evidence is the recorded WB-003 GLM turn (reused, not re-run).
// This script supplies the missing standalone half: the REAL installed module
// hosted with NO KB_KNOWLEDGE_ENGINE_URL, one real GLM subscription turn, and
// the proof that the conversation completed with knowledge status
// 'not-retrieved' — i.e. the model conversation does not depend on
// knowledge-base business objects.
//
// Model evidence labels (supplement round 2):
//   * sdkReportedModel — the model string of the SDK system/init event. The
//     runner copies it from the CLI's own init message, so it is what the SDK
//     reports, NOT by itself proof of what the vendor returned.
//   * vendorReturnedModel — message.model of real assistant messages in the
//     CLI session transcript written under the ISOLATED CLAUDE_CONFIG_DIR,
//     correlated to the same claudeSessionId, with the unique token echoed in
//     the same transcript. This is the vendor-returned field.
//
// Isolation and credential rules are those of the lane fixture: read-only
// profile facade (every write method refuses, credential stays in memory),
// isolated HOME/CLAUDE_CONFIG_DIR/data/temp/ports, live ports refused,
// ambient credential variables stripped. Exactly ONE paid turn is sent.
//
// Exit codes: 0 = every WB-002 essential positively verified;
//             3 = at least one essential honestly BLOCKED;
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

function walkFiles(root, visit) {
  let names;
  try { names = fs.readdirSync(root, { withFileTypes: true }); } catch { return; }
  for (const entry of names) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) walkFiles(full, visit);
    else if (entry.isFile()) visit(full);
  }
}

// Extract the vendor-returned model from the CLI transcript of THIS session.
// Only file names, the model string and booleans leave this function — the
// transcript itself (which may hold the conversation and CLI metadata) is
// never copied anywhere.
function scanTranscriptForVendorModel(roots, claudeSessionId, token) {
  const matchedFiles = [];
  const assistantModels = new Set();
  let sessionCorrelated = false;
  let tokenEchoed = false;
  for (const root of roots) {
    walkFiles(root, file => {
      if (!file.endsWith('.jsonl')) return;
      let text;
      try { text = fs.readFileSync(file, 'utf8'); } catch { return; }
      if (claudeSessionId && !text.includes(claudeSessionId)) return;
      matchedFiles.push(path.basename(file));
      let sawAssistantForSession = false;
      for (const line of text.split(/\r?\n/)) {
        let entry;
        try { entry = JSON.parse(line); } catch { continue; }
        if (entry.type !== 'assistant' || !entry.message) continue;
        const belongs = entry.sessionId === claudeSessionId
          || (entry.sessionId == null && claudeSessionId != null && text.includes(claudeSessionId));
        if (!belongs) continue;
        sawAssistantForSession = true;
        if (typeof entry.message.model === 'string' && entry.message.model) assistantModels.add(entry.message.model);
        const content = Array.isArray(entry.message.content) ? entry.message.content : [];
        for (const block of content) {
          if (block && block.type === 'text' && typeof block.text === 'string' && block.text.includes(token)) tokenEchoed = true;
        }
      }
      if (sawAssistantForSession) sessionCorrelated = true;
    });
  }
  return {
    transcriptFilesMatched: matchedFiles,
    sessionCorrelated,
    assistantModelValues: [...assistantModels],
    tokenEchoedInTranscript: tokenEchoed,
  };
}

(async () => {
  const moduleRoot = fixture.resolveHostModuleRoot();
  assert.ok(moduleRoot, 'no claude-ai-workbench module copy was found to host');
  const identity = sourceMap.packageIdentity(moduleRoot);
  const moduleRootLabel = moduleRoot === sourceMap.resolveInstalledProductPackage()
    ? 'currently-installed-package:installed-product'
    : 'currently-installed-package:repository-pin';

  const realProfilesBefore = fixture.digestDirectory(fixture.realWorkbenchProfileDir());

  const layout = fixture.createIsolationLayout('parallel-wb-standalone');
  const port = await fixture.freePort();
  const base = `http://127.0.0.1:${port}`;
  // STANDALONE mode: no PK_WB_ENGINE_URL, so the host child never sets
  // KB_KNOWLEDGE_ENGINE_URL and no engine is reachable from this host.
  const child = fixture.spawnNode([path.join(__dirname, 'helpers', 'parallel-workbench-host.js')], fixture.hostEnv(layout, {
    PK_WB_MODULE_ROOT: moduleRoot,
    PK_WB_HOST_PORT: String(port),
    PK_WB_HOST_DATA_DIR: layout.dataDir,
    PK_WB_HOST_WORKSPACE: layout.workspace,
    PK_WB_HOST_MODE: 'standalone',
    PK_WB_PROFILE_SOURCE: 'real-readonly',
  }));

  const token = `WB002-${PROFILE_ID.toUpperCase()}-${crypto.randomBytes(5).toString('hex')}`;
  const question = [
    '这是一次独立宿主真实订阅对话（Workbench WB-002 补充）。',
    `请只回复一行，原样包含以下随机标记，不要添加任何其他内容：${token}`,
  ].join('\n');

  let outcome;
  try {
    await fixture.waitForHttp(`${base}/api/claude-workbench/v1/health`, 30000);

    const profiles = await getJson(`${base}/api/claude-workbench/v1/profiles`);
    const listed = Array.isArray(profiles.body && profiles.body.profiles) ? profiles.body.profiles : [];
    const target = listed.find(profile => profile.id === PROFILE_ID) || null;
    record('WB-002.s1-profile-injected-readonly', target ? 'PASS' : 'BLOCKED', {
      profileId: PROFILE_ID,
      credentialConfigured: target ? target.credentialConfigured === true : null,
      storeWritesPossible: false,
      credentialMaterialLogged: false,
    });
    assert.ok(target, `the ${PROFILE_ID} profile was not visible through the read-only facade`);

    const session = await getJson(`${base}/api/claude-workbench/v1/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        context: { contextId: 'wb002-standalone-turn', workspaceRef: 'wb-fixture' },
        aiProfileId: PROFILE_ID,
        model: REQUESTED_MODEL,
        effort: EFFORT,
      }),
    });
    const created = session.body && session.body.session;
    record('WB-002.s2-session-configured-model', session.status === 201 && created ? 'PASS' : 'BLOCKED', {
      httpStatus: session.status,
      sessionId: created && created.sessionId,
      requestedModel: REQUESTED_MODEL,
      effort: EFFORT,
      authSource: created && created.authSource,
    });
    assert.equal(session.status, 201);
    const sessionId = created.sessionId;
    assert.equal(created.authSource, 'profile-injected');

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
    record('WB-002.s3-unique-question-accepted', send.status === 202 ? 'PASS' : 'BLOCKED', {
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
    const sdkReportedModel = init ? init.model : null;
    const claudeSessionId = init ? init.claudeSessionId : null;
    const answer = result ? String(result.result || '') : '';
    const tokenEchoed = answer.includes(token);
    const isError = result ? result.isError === true : true;

    // The real conversation happened on THIS standalone host.
    record('WB-002.s4-real-answer-on-standalone-host', !isError && tokenEchoed ? 'PASS' : 'BLOCKED', {
      isError,
      uniqueToken: token,
      tokenEchoedInAnswer: tokenEchoed,
      sdkReportedModel,
      sdkReportedModelNote: 'the system/init model string the SDK reports for the session; NOT by itself vendor-returned evidence',
      claudeSessionId,
      usage: result && result.usage ? { inputTokens: result.usage.input_tokens, outputTokens: result.usage.output_tokens } : null,
      errorEvent: error,
    });

    // The conversation completed with NO knowledge retrieval: no engine URL
    // exists on this host, and the knowledge surface must say so. After a real
    // turn the status is 'disabled' — KnowledgeContext.retrieve returns
    // {status:'disabled'} when no engineUrl is configured (knowledge-context.js
    // line 20); 'not-retrieved' is the pre-turn shape. Both mean zero
    // knowledge was retrieved; anything else (ready/empty/file-fallback) would
    // mean an engine was somehow consulted.
    const knowledge = await getJson(`${base}/api/claude-workbench/v1/sessions/${encodeURIComponent(sessionId)}/knowledge`);
    const knowledgeStatus = knowledge.body && knowledge.body.status;
    record('WB-002.s5-conversation-without-knowledge-dependency', knowledge.ok && ['disabled', 'not-retrieved'].includes(knowledgeStatus) ? 'PASS' : 'BLOCKED', {
      knowledgeStatus,
      engineUrlConfigured: false,
      detail: 'standalone host has no KB_KNOWLEDGE_ENGINE_URL; retrieve() is structurally disabled and the real turn still completed',
    });

    // The vendor-returned model, from the CLI transcript this isolated host
    // produced, correlated to the same session and token.
    const transcriptRoots = [layout.claudeConfigDir, path.join(layout.home, '.claude')];
    const transcript = scanTranscriptForVendorModel(transcriptRoots, claudeSessionId, token);
    const vendorModels = transcript.assistantModelValues;
    const vendorModelProven = transcript.sessionCorrelated
      && vendorModels.length > 0
      && transcript.tokenEchoedInTranscript
      && vendorModels.every(model => model.replace(/\s+/g, '').toLowerCase() === REQUESTED_MODEL.replace(/\s+/g, '').toLowerCase());
    record('WB-002.s6-vendor-model-from-transcript', vendorModelProven ? 'PASS' : 'NOT_PROVEN', {
      ...transcript,
      requestedModel: REQUESTED_MODEL,
      vendorModelMatchesRequest: vendorModels.length > 0
        ? vendorModels.every(model => model.replace(/\s+/g, '').toLowerCase() === REQUESTED_MODEL.replace(/\s+/g, '').toLowerCase())
        : null,
      detail: 'message.model of assistant messages in the CLI transcript under the ISOLATED CLAUDE_CONFIG_DIR; correlated by claudeSessionId and the unique token echo',
    });

    outcome = {
      requestedModel: REQUESTED_MODEL,
      effort: EFFORT,
      sdkReportedModel,
      vendorReturnedModels: vendorModels,
      vendorModelProven,
      claudeSessionId,
      workbenchSessionId: sessionId,
      isError,
      tokenEchoed,
      answerPreview: answer.slice(0, 200),
      usage: result && result.usage ? { inputTokens: result.usage.input_tokens, outputTokens: result.usage.output_tokens } : null,
    };
  } finally {
    child.child.kill();
    await child.exited;
  }

  const digestComparison = fixture.compareDigests(realProfilesBefore, fixture.digestDirectory(fixture.realWorkbenchProfileDir()));
  record('WB-002.s7-real-profiles-byte-identical', digestComparison.byteIdentical ? 'PASS' : 'FAIL', {
    profileDir: fixture.realWorkbenchProfileDir(),
    comparison: 'byte-level SHA256, computed in memory; digests never printed, logged or persisted',
    fileCount: digestComparison.count,
    changedFiles: digestComparison.changedFiles,
    addedFiles: digestComparison.addedFiles,
    removedFiles: digestComparison.removedFiles,
  });

  const essentialsPass = ['WB-002.s1-profile-injected-readonly', 'WB-002.s2-session-configured-model', 'WB-002.s3-unique-question-accepted', 'WB-002.s4-real-answer-on-standalone-host', 'WB-002.s5-conversation-without-knowledge-dependency', 'WB-002.s7-real-profiles-byte-identical']
    .every(id => (results.find(entry => entry.caseId === id) || {}).status === 'PASS');

  const summary = {
    lane: 'test-workbench',
    file: 'parallel-workbench-standalone-turn.js',
    case: 'WB-002',
    scope: 'supplement: the standalone half of "配置模型并对话，再在宿主中重复" (the integration half is the recorded WB-003 GLM turn, reused without a new call)',
    module: { label: moduleRootLabel, root: moduleRoot, name: identity.name, version: identity.version },
    host: { mode: 'standalone', engineUrlConfigured: false, dataDir: layout.dataDir, workspace: layout.workspace },
    profile: { id: PROFILE_ID, source: 'original-subscription-store read-only, credential in memory only', credentialWrittenAnywhere: false },
    turn: outcome,
    cases: results,
    verdict: essentialsPass ? 'PASS (standalone real conversation without knowledge dependency)' : 'BLOCKED',
    paidTurnsSent: 1,
    networkUsed: true,
  };

  const target = process.env.PARALLEL_WORKBENCH_EVIDENCE;
  if (target) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(summary, null, 2), 'utf8');
  }
  fixture.removeTree(layout.root);
  console.log(`parallel-workbench-standalone-turn verdict=${summary.verdict}`);
  process.exitCode = essentialsPass ? 0 : 3;
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
