'use strict';
// P-WB-QA-INTEGRATION-5025 canonical copy of the accepted WB-003 entry
// (_site/_test/parallel-workbench-runtime-minimax-probe.js, frozen untracked).
// P-WB-CANONICAL-R2 wiring: the entry goes through the canonical launcher boot
// (paid gate + explicit real-profile authorization → read-only discovery with
// the real environment → FULL driver isolation incl. APPDATA/LOCALAPPDATA/
// CODEX_HOME → carried-through captures); the host child now receives the
// canonical fixture's complete whitelist (the pre-R5 tracked fixture's env
// lacked those keys), with the authorized real profile directory passed
// explicitly for the in-memory read-only key facade. Case logic, expecteds and
// the two-level model evidence are unchanged. Real paid model probe (exactly
// ONE paid turn, real network to the provider) — run only explicitly via the
// integration-5025 runner with PK_WB_ALLOW_PAID_TURNS=1 and an explicit
// PK_WB_REAL_PROFILE_DIR.
// P-WB-RUNTIME-03 / WB-003 — real MiniMax positive acceptance probe.
//
// The MiniMax subscription quota is refreshed (a real tool-input-delta was
// observed on the first RET line at 2026-10-23T07:38:15Z), so the positive
// acceptance that was BLOCKED on the old 429/2067 evidence is executed for
// real now — with the ORIGINAL minimax profile, read-only in memory.
//
// Model evidence is the same two-level scheme the r2 supplement established:
//   * sdkReportedModel  — the system/init model string the SDK reports for the
//     session (what the CLI resolved locally);
//   * vendorReturnedModel — message.model of the REAL assistant messages in
//     the CLI transcript written under the ISOLATED CLAUDE_CONFIG_DIR,
//     correlated to the same claudeSessionId and to the unique token echoed
//     in that same transcript. This is the vendor-returned field.
//
// Everything else is unchanged from the frozen lane rules: the REAL installed
// module hosted standalone (no knowledge engine), the original profile store
// behind a read-only facade (every write method refuses), the credential only
// in memory, isolated HOME/CLAUDE_CONFIG_DIR/data/temp/ports, live ports
// refused, ambient credentials stripped, and a byte-level SHA256 comparison of
// the real profile directory before/after (digests never leave the process).
//
// Exactly ONE paid request. No quota endpoint, no retry loop, no PAYG.
//
// Exit codes: 0 = MiniMax positive acceptance positively proven;
//             3 = honestly BLOCKED (e.g. the vendor rejected the call);
//             1 = script error.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const launcher = require('./helpers/parallel-workbench-integration-5025-launcher');
const fixture = require('./helpers/parallel-workbench-integration-5025-fixture');
const sourceMap = require('./helpers/parallel-workbench-source-map');

const PROFILE_ID = String(process.env.PK_WB_MODEL_PROFILE || 'minimax');
const REQUESTED_MODEL = String(process.env.PK_WB_MODEL_ID || 'MiniMax-M3.1-Flash');
const TURN_TIMEOUT_MS = Number(process.env.PK_WB_TURN_TIMEOUT_MS || 420000);

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

// The vendor-returned model of THIS session, read from the CLI transcript of
// the isolated host. Only file names, model strings and booleans leave here.
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
      for (const line of text.split(/\r?\n/)) {
        let entry;
        try { entry = JSON.parse(line); } catch { continue; }
        if (entry.type !== 'assistant' || !entry.message) continue;
        const belongs = entry.sessionId === claudeSessionId
          || (entry.sessionId == null && claudeSessionId != null && text.includes(claudeSessionId));
        if (!belongs) continue;
        sessionCorrelated = true;
        if (typeof entry.message.model === 'string' && entry.message.model) assistantModels.add(entry.message.model);
        const content = Array.isArray(entry.message.content) ? entry.message.content : [];
        for (const block of content) {
          if (block && block.type === 'text' && typeof block.text === 'string' && block.text.includes(token)) tokenEchoed = true;
        }
      }
    });
  }
  return {
    transcriptFilesMatched: matchedFiles,
    sessionCorrelated,
    assistantModelValues: [...assistantModels],
    tokenEchoedInTranscript: tokenEchoed,
  };
}

const sameModel = (a, b) => String(a).replace(/\s+/g, '').toLowerCase() === String(b).replace(/\s+/g, '').toLowerCase();

(async () => {
  // The single safe entry discipline: paid gate + explicit real-profile
  // authorization, read-only discovery with the real environment, then FULL
  // driver isolation (incl. APPDATA/LOCALAPPDATA/CODEX_HOME) with the
  // captures carried through — before anything else happens.
  const boot = launcher.boot({ prefix: 'parallel-wb-rt-minimax', paid: true, needsRealProfile: true, requireChrome: false });
  const moduleRoot = boot.discovery.moduleRoot;
  const identity = sourceMap.packageIdentity(moduleRoot);
  // The installed-product root resolves from the pre-isolation capture — an
  // isolated APPDATA can no longer mislabel an AppData install as a pin.
  const moduleRootLabel = moduleRoot === fixture.installedProductPackage()
    ? 'currently-installed-package:installed-product'
    : 'currently-installed-package:repository-pin';

  const realProfilesBefore = launcher.digestDirectory(boot.discovery.realProfileDir);
  const layout = boot.layout;
  const port = await fixture.freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = fixture.spawnNode([path.join(__dirname, 'helpers', 'parallel-workbench-host.js')], fixture.hostEnv(layout, {
    PK_WB_MODULE_ROOT: moduleRoot,
    PK_WB_HOST_PORT: String(port),
    PK_WB_HOST_DATA_DIR: layout.dataDir,
    PK_WB_HOST_WORKSPACE: layout.workspace,
    PK_WB_HOST_MODE: 'standalone',
    PK_WB_PROFILE_SOURCE: 'real-readonly',
    PK_WB_REAL_PROFILE_DIR: boot.discovery.realProfileDir,
  }));

  const token = `WBRT-MINIMAX-${crypto.randomBytes(5).toString('hex')}`;
  const question = [
    '这是一次真实 MiniMax 订阅模型正向抽测（Workbench WB-003 / P-WB-RUNTIME-03）。',
    `请只回复一行，原样包含以下随机标记，不要添加任何其他内容：${token}`,
  ].join('\n');

  let outcome = null;
  try {
    await fixture.waitForHttp(`${base}/api/claude-workbench/v1/health`, 30000);

    const profiles = await getJson(`${base}/api/claude-workbench/v1/profiles`);
    const listed = Array.isArray(profiles.body && profiles.body.profiles) ? profiles.body.profiles : [];
    const target = listed.find(profile => profile.id === PROFILE_ID) || null;
    record('WB-003.m1-profile-injected-readonly', target ? 'PASS' : 'BLOCKED', {
      profileId: PROFILE_ID,
      profileName: target && target.name,
      baseUrl: target && target.baseUrl,
      defaultModel: target && target.models && target.models.default,
      credentialConfigured: target ? target.credentialConfigured === true : null,
      storeWritesPossible: false,
      credentialMaterialLogged: false,
    });
    assert.ok(target, `the ${PROFILE_ID} profile was not visible through the read-only facade`);

    const session = await getJson(`${base}/api/claude-workbench/v1/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        context: { contextId: 'wbrt-minimax-probe', workspaceRef: 'wb-fixture' },
        aiProfileId: PROFILE_ID,
        model: REQUESTED_MODEL,
      }),
    });
    const created = session.body && session.body.session;
    record('WB-003.m2-session-with-subscription-profile', session.status === 201 && created ? 'PASS' : 'BLOCKED', {
      httpStatus: session.status,
      sessionId: created && created.sessionId,
      model: created && created.model,
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
    record('WB-003.m3-unique-question-accepted', send.status === 202 ? 'PASS' : 'BLOCKED', { httpStatus: send.status, uniqueToken: token });
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

    const transcript = scanTranscriptForVendorModel([layout.claudeConfigDir, path.join(layout.home, '.claude')], claudeSessionId, token);
    const vendorModels = transcript.assistantModelValues;
    const vendorModelProven = transcript.sessionCorrelated
      && vendorModels.length > 0
      && transcript.tokenEchoedInTranscript
      && vendorModels.every(model => sameModel(model, REQUESTED_MODEL));

    record('WB-003.m4-vendor-returned-model', vendorModelProven ? 'PASS' : 'BLOCKED', {
      requestedModel: REQUESTED_MODEL,
      sdkReportedModel,
      assistantModelValues: vendorModels,
      vendorModelMatchesRequest: vendorModels.length > 0 ? vendorModels.every(model => sameModel(model, REQUESTED_MODEL)) : null,
      sessionCorrelated: transcript.sessionCorrelated,
      tokenEchoedInTranscript: transcript.tokenEchoedInTranscript,
      transcriptFilesMatched: transcript.transcriptFilesMatched,
      detail: 'message.model of the real assistant messages in the CLI transcript under the ISOLATED CLAUDE_CONFIG_DIR, correlated by claudeSessionId and the unique token echo',
    });

    record('WB-003.m5-response-correlated', !isError && tokenEchoed ? 'PASS' : 'BLOCKED', {
      isError,
      uniqueToken: token,
      tokenEchoedInAnswer: tokenEchoed,
      claudeSessionId,
      workbenchSessionId: sessionId,
      answerPreview: answer.slice(0, 200),
      errorEvent: error,
    });

    outcome = {
      requestedModel: REQUESTED_MODEL,
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

  const digestComparison = launcher.compareDigests(realProfilesBefore, launcher.digestDirectory(boot.discovery.realProfileDir));
  record('WB-003.m6-real-profiles-byte-identical', digestComparison.byteIdentical ? 'PASS' : 'FAIL', {
    profileDir: boot.discovery.realProfileDir,
    comparison: 'byte-level SHA256, computed in memory; digests never printed, logged or persisted',
    fileCount: digestComparison.count,
    changedFiles: digestComparison.changedFiles,
    addedFiles: digestComparison.addedFiles,
    removedFiles: digestComparison.removedFiles,
  });

  const essential = ['WB-003.m1-profile-injected-readonly', 'WB-003.m2-session-with-subscription-profile', 'WB-003.m3-unique-question-accepted', 'WB-003.m4-vendor-returned-model', 'WB-003.m5-response-correlated', 'WB-003.m6-real-profiles-byte-identical'];
  const proven = essential.every(id => (results.find(entry => entry.caseId === id) || {}).status === 'PASS');

  const summary = {
    lane: 'test-workbench-runtime',
    file: 'parallel-workbench-runtime-minimax-probe.js',
    case: 'WB-003',
    title: '真实模型抽测（MiniMax 正向验收）',
    module: { label: moduleRootLabel, root: moduleRoot, name: identity.name, version: identity.version },
    host: { mode: 'standalone', engineUrlConfigured: false, dataDir: layout.dataDir, workspace: layout.workspace },
    profile: { id: PROFILE_ID, source: 'original-subscription-store read-only, credential in memory only', credentialWrittenAnywhere: false },
    turn: outcome,
    cases: results,
    verdict: proven ? 'PASS (MiniMax positive acceptance proven: vendor-returned model + unique fact + session correlation)' : 'BLOCKED',
    paidTurnsSent: 1,
    quotaEndpointQueried: false,
    networkUsed: true,
  };

  const target = process.env.PARALLEL_WORKBENCH_RUNTIME_EVIDENCE;
  if (target) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(summary, null, 2), 'utf8');
  }
  fixture.removeTree(layout.root);
  console.log(`parallel-workbench-runtime-minimax-probe verdict=${summary.verdict}`);
  process.exitCode = proven ? 0 : 3;
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
