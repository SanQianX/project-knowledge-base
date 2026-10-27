'use strict';
// _site/_test/qa-r44-permission-question.js
//
// The R44 lane scenarios (WB-006 permission deny, WB-007 user question).
//
// Both scenarios drive the REAL Workbench 0.13.9 agent-terminal UI in a REAL
// browser, hosted as an isolated child process of the REAL module, with a
// REAL model turn of this session's original subscription profile.
//
// What is proved:
//   WB-006  a real Agent tool permission card is raised for a self-owned
//           fixture marker; the product's own 拒绝 button is clicked; the
//           protected tool does NOT execute (the marker is not written); the
//           UI state and the rejection receipt agree.
//   WB-007  a real product question card covers a single-select, a
//           multi-select and a custom answer; the turn is proven to PAUSE
//           without a submission; a bypass-style resolution, an empty answer
//           and a wrong-question answer are all REFUSED with 400 and the
//           pending question survives every one of them; the product's own
//           bypass permission mode does not release the pending question;
//           the real UI selection is submitted and the receipt matches.
//
// Nothing here fabricates a model event, substitutes an API call for a UI
// action that must be verified, or counts a driver-side PASS as acceptance.
// Every verdict is read from the product's own events, DOM and disk.
//
// R44C (canonical packaging, no behaviour change):
//   * the lane now uses the TRACKED canonical harness
//     (helpers/parallel-workbench-integration-5025-runtime-harness.js). The
//     previous, untracked lane harness is no longer part of the dependency
//     closure, so the lane can be checked out from a clean tracked tree;
//   * the browser is opened with the Chrome path captured BEFORE the
//     isolation — the canonical harness refuses to discover a browser from an
//     isolated environment;
//   * the session event stream is read by the lane's own reader below. The
//     shared helper's reader leaves its timeout timer armed after the stream
//     ends, which keeps the event loop alive for the whole turn-timeout
//     window (the frozen R44 run-history records the resulting linger). The
//     shared helper is frozen and is NOT patched; the lane owns its own reader
//     and clears its own timer.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const harness = require('./helpers/parallel-workbench-integration-5025-runtime-harness');
const envLib = require('./helpers/qa-r44-env');
const ui = require('./helpers/qa-r44-ui');

const PROFILE_ID = String(process.env.PK_WB_MODEL_PROFILE || 'minimax');
const MODEL_ID = String(process.env.PK_WB_MODEL_ID || 'MiniMax-M3.1-Flash');
const TURN_TIMEOUT_MS = Number(process.env.PK_WB_TURN_TIMEOUT_MS || 420000);
const CARD_TIMEOUT_MS = Number(process.env.QA_R44_CARD_TIMEOUT_MS || 240000);
const WB_SOURCE_ROOT = String(process.env.QA_R44_WB_SOURCE_ROOT || '').trim();

const results = [];
function record(caseId, status, detail) {
  results.push({ caseId, status, detail });
  console.log(`CASE ${caseId} ${status} ${JSON.stringify(detail)}`);
}
function assertTrue(condition, message) {
  if (!condition) throw new Error(message);
}

// The cases that must PASS for the lane to be accepted. Both bypass cases
// are part of it: the product's own bypass mode must not release the pending
// question (R44.g) and a bounded bypass turn must still ask it (R44.j). A run
// that never recorded them, or that recorded them as anything but PASS, is
// BLOCKED - never a partial PASS.
const ESSENTIAL_CASES = [
  'R44.a-isolated-host-and-real-browser',
  'R44.b-model-selected-through-the-real-ui',
  'R44.c-wb006-real-permission-card-raised',
  'R44.d-wb006-deny-executed-by-the-real-ui',
  'R44.e-wb007-real-question-card-and-pause',
  'R44.f-wb007-bypass-cannot-substitute-empty-answer-or-let-it-through',
  'R44.g-wb007-bypass-mode-does-not-release-the-question',
  'R44.h-wb007-ui-enables-the-submit-only-after-a-complete-answer',
  'R44.i-wb007-real-ui-selection-submitted-and-the-receipt-matches',
  'R44.j-wb007-the-bypass-mode-still-asks-the-question',
  'R44.k-real-profiles-byte-identical',
];

// The verdict of a set of case results. This is a pure function of the
// recorded results, so a zero-model probe can prove the negative cases: a
// result set that lacks a required case is not a PASS.
function evaluateCases(caseResults) {
  const list = Array.isArray(caseResults) ? caseResults : [];
  const byId = new Map();
  for (const entry of list) if (entry && entry.caseId) byId.set(entry.caseId, entry);
  const cases = ESSENTIAL_CASES.map(caseId => {
    const found = byId.get(caseId);
    const status = found ? found.status : 'MISSING';
    return { caseId, status, proven: status === 'PASS' };
  });
  const missing = cases.filter(entry => entry.status === 'MISSING').map(entry => entry.caseId);
  const notPassed = cases.filter(entry => entry.status !== 'PASS').map(entry => ({ caseId: entry.caseId, status: entry.status }));
  const proven = notPassed.length === 0;
  return {
    essential: cases,
    missing,
    notPassed,
    proven,
    verdict: proven ? 'PASS' : 'BLOCKED',
  };
}
const sha256 = buffer => crypto.createHash('sha256').update(buffer).digest('hex');
const sha256File = file => {
  try { return sha256(fs.readFileSync(file)); } catch { return null; }
};

// The product's own resolve endpoint. It is used ONLY as a negative control:
// every attempt this lane makes through it must be REFUSED, and the pending
// request must survive. The acceptance itself is done through the UI.
async function postResolve(base, sessionId, requestId, body) {
  const url = `${base}${harness.API_BASE}/sessions/${encodeURIComponent(sessionId)}/permissions/${encodeURIComponent(requestId)}/resolve`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  const parsed = await response.json().catch(() => null);
  return { status: response.status, ok: response.ok, body: parsed };
}

// A read-only read of the product's own session record. It is used as
// evidence of the effective permission mode, of the still-pending request
// and of the event snapshot. It never performs a state change.
async function readSession(base, sessionId) {
  const url = `${base}${harness.API_BASE}/sessions/${encodeURIComponent(sessionId)}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
  const parsed = await response.json().catch(() => null);
  return { status: response.status, ok: response.ok, body: parsed };
}

// Every file of the self-owned fixture project that carries the marker text.
// The marker is the proof that the protected tool did not run — and that no
// other route wrote it either.
function scanProjectForMarker(root, needle) {
  const hits = [];
  const walk = dir => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      try {
        if (fs.statSync(full).size > 1024 * 1024) continue;
        if (fs.readFileSync(full, 'utf8').includes(needle)) hits.push(full);
      } catch { /* an unreadable or binary file cannot carry the marker */ }
    }
  };
  walk(root);
  return hits;
}

// The source identity of the Workbench repository, read-only.
function sourceIdentity() {
  if (!WB_SOURCE_ROOT || !fs.existsSync(path.join(WB_SOURCE_ROOT, '.git'))) {
    return { root: WB_SOURCE_ROOT || null, head: null, note: 'the source checkout was not addressed by this lane' };
  }
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: WB_SOURCE_ROOT, encoding: 'utf8', windowsHide: true, timeout: 30000 });
  const branch = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: WB_SOURCE_ROOT, encoding: 'utf8', windowsHide: true, timeout: 30000 });
  return {
    root: WB_SOURCE_ROOT,
    head: head.status === 0 ? String(head.stdout || '').trim() : null,
    branch: branch.status === 0 ? String(branch.stdout || '').trim() : null,
    readOnly: true,
  };
}

// The pinned public module of the root repository.
function pinnedIdentity() {
  const rootPkg = JSON.parse(fs.readFileSync(path.join(envLib.REPO_ROOT, 'package.json'), 'utf8'));
  const spec = (rootPkg.dependencies || {})['claude-ai-workbench'] || null;
  const { createRequire } = require('node:module');
  const req = createRequire(path.join(envLib.REPO_ROOT, 'package.json'));
  const pkgJson = req.resolve('claude-ai-workbench/package.json');
  const root = path.dirname(pkgJson);
  const pkg = JSON.parse(fs.readFileSync(pkgJson, 'utf8'));
  return {
    spec,
    resolvedRoot: root,
    version: pkg.version,
    keyFiles: {
      'apps/agent-terminal/app.js': sha256File(path.join(root, 'apps', 'agent-terminal', 'app.js')),
      'apps/agent-terminal/user-question-card.js': sha256File(path.join(root, 'apps', 'agent-terminal', 'user-question-card.js')),
      'packages/server/lib/user-questions.js': sha256File(path.join(root, 'packages', 'server', 'lib', 'user-questions.js')),
      'packages/server/lib/workbench-service.js': sha256File(path.join(root, 'packages', 'server', 'lib', 'workbench-service.js')),
      'src/backend/lib/claude-cli-runner.js': sha256File(path.join(root, 'src', 'backend', 'lib', 'claude-cli-runner.js')),
    },
  };
}

// The lane's own reader of the product's session event stream.
//
// It has the same contract as the shared helper's reader — the same URL, the
// same "data:" payload contract, the same abort on the terminal event — and it
// CLEARS its own timeout timer. The shared helper arms a timer it never
// clears, so a reader that has already finished still keeps the event loop
// alive for the whole turn-timeout window: the R44 acceptance process wrote
// its report at 02:01:20Z and only exited about six minutes later, with the
// turn timeout armed at 420000 ms. The shared helper is frozen and is NOT
// patched; the lane owns its reader instead.
function readSessionEvents(url, onEvent, until, timeoutMs) {
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
          try { onEvent(event); } catch { /* a listener error never kills the stream */ }
          if (until && until(event)) { controller.abort(); return; }
        }
      }
    } catch { /* aborted or ended */ }
    finally {
      clearTimeout(timer);
      if (done) done();
    }
  })();
  return { finished, stop: () => { clearTimeout(timer); controller.abort(); } };
}

async function newSession(browser, host, readers) {
  await harness.clickNewSession(browser);
  const state = await harness.waitForState(browser, s => s.product && s.product.activeSessionId, 'a new session', 30000);
  const sessionId = state.product.activeSessionId;
  // The page must be subscribed to THIS session before a turn is sent, so no
  // event of the turn can be missed by the browser.
  await ui.waitUntil(async () => {
    const urls = await ui.readPageStreams(browser);
    return urls.some(url => url.includes(encodeURIComponent(sessionId))) ? urls : null;
  }, `the page to subscribe to the session ${sessionId}`, 30000);
  const events = [];
  const stream = readSessionEvents(
    harness.sessionEventsUrl(host.base, sessionId),
    event => events.push(event),
    event => event.type === 'claude/result' || event.type === 'claude/error' || event.type === 'claude/aborted',
    TURN_TIMEOUT_MS,
  );
  if (readers) readers.push(stream);
  return { sessionId, events, stream };
}

const eventsOfType = (events, type) => events.filter(event => event.type === type);

// A path comparison that tolerates the separator and the spelling of the
// model: the tool call may carry the absolute path or the name relative to
// the session cwd. The marker name itself is the invariant.
const normalizePath = value => String(value || '').replace(/\\/g, '/').toLowerCase();
const isMarkerPath = (value, markerPath, markerName) => {
  const normalized = normalizePath(value);
  if (!normalized) return false;
  return normalized === normalizePath(markerPath) || normalized.endsWith(`/${normalizePath(markerName)}`);
};

// The tool call a permission request belongs to: the last call of that tool
// BEFORE the request was raised. A model may call the same tool more than
// once; the receipt must belong to the call that was actually answered.
function toolCallBefore(events, requestId, toolName) {
  const index = events.findIndex(event => event.type === 'claude/permission-request' && event.requestId === requestId);
  if (index < 0) return null;
  const before = events.slice(0, index).filter(event => event.type === 'claude/tool-use' && event.name === toolName);
  return before.length ? before[before.length - 1] : null;
}

async function main() {
  const startedAt = new Date().toISOString();
  const cases = [];

  // --- 1. capture the real environment, then isolate the driver -----------
  const captured = envLib.captureRealEnvironment();
  const layout = envLib.createLaneLayout();
  const hardened = envLib.hardenDriverEnv(layout, captured);
  envLib.assertIsolatedEnv(process.env, layout, captured);

  const realProfilesBefore = envLib.digestDirectory(envLib.realProfileDir());
  const host = await harness.startHost({ layout, prefix: 'qa-r44' });
  const identity = harness.moduleIdentity(host.moduleRoot);
  let browser = null;
  let wb006 = null;
  let wb007 = null;
  let bypassTurn = null;
  let paidTurns = 0;
  // Every event reader this lane opened. They are stopped in the finally
  // block, so no handle of this lane survives the run.
  const readers = [];

  try {
    // The Chrome path was captured BEFORE the isolation; the canonical harness
    // refuses to discover a browser from an isolated environment.
    const opened = await harness.openBrowser(host.base, host.layout, { chrome: captured.chrome.path });
    browser = opened.browser;
    const health = await harness.getJson(`${host.base}${harness.API_BASE}/health`);
    assertTrue(health.ok && health.body && health.body.status === 'ok', 'the isolated host is not healthy');

    const projectRoot = path.join(layout.root, 'qa-r44-project');
    const project = await harness.ensureProject(browser, projectRoot, { name: 'qa-r44-project' });
    const profiles = await harness.getJson(`${host.base}${harness.API_BASE}/profiles`);
    const listed = Array.isArray(profiles.body && profiles.body.profiles) ? profiles.body.profiles : [];
    const profile = listed.find(item => item.id === PROFILE_ID);
    assertTrue(profile, `the ${PROFILE_ID} profile is not visible through the read-only facade`);
    await harness.selectModel(browser, profile.name, MODEL_ID);
    const afterModel = await harness.readState(browser);

    record('R44.a-isolated-host-and-real-browser', 'PASS', {
      health: health.body,
      browser: 'real Chrome via CDP (headless) with its own user-data-dir below the isolated run root',
      chrome: opened.chrome,
      module: identity,
      host: { mode: 'standalone', port: host.port, dataDir: layout.dataDir, workspace: layout.workspace, hostPid: host.child.child.pid },
      project: { id: project.projectId, name: project.name, path: projectRoot, createdThroughTheProductForm: project.created === true },
      isolation: envLib.isolationContract(layout, captured, hardened),
    });

    record('R44.b-model-selected-through-the-real-ui', afterModel.product.currentProfileId === PROFILE_ID && afterModel.product.currentModel === MODEL_ID ? 'PASS' : 'BLOCKED', {
      profileId: PROFILE_ID,
      profileName: profile.name,
      requestedModel: MODEL_ID,
      uiProfileId: afterModel.product.currentProfileId,
      uiModel: afterModel.product.currentModel,
      credentialSource: 'the original subscription store, read-only; the credential stays in the host process memory',
      credentialWrittenAnywhere: false,
      quotaEndpointQueried: false,
    });
    assertTrue(afterModel.product.currentProfileId === PROFILE_ID, 'the profile was not selected through the UI');

    // =====================================================================
    // WB-006 — permission deny
    // =====================================================================
    const markerName = 'qa-r44-wb006-marker.txt';
    const markerPath = envLib.containedPath(projectRoot, markerName);
    const session6 = await newSession(browser, host, readers);
    // The precondition of WB-006 is the default protection mode. It is set
    // through the product's own menu and then read back from the product.
    let modeSwitch6 = null;
    try {
      modeSwitch6 = await ui.selectPermissionMode(browser, '默认防护');
    } catch (error) {
      modeSwitch6 = { switched: false, reason: String(error && error.message ? error.message : error) };
    }
    await harness.wait(500);
    const modeBefore6 = await readSession(host.base, session6.sessionId);
    const effectiveMode6 = modeBefore6.body && modeBefore6.body.permissionMode;
    assertTrue(effectiveMode6 === 'default', `the WB-006 session is not in the default protection mode: ${effectiveMode6}`);
    paidTurns += 1;
    const wb006Prompt = [
      '这是 WB-006 权限拒绝的真实抽测。',
      `请使用 Write 工具，把文本 WB006-DENIED-MARKER 写入文件 ${markerPath}。`,
      '必须使用 Write 工具，不要使用 Bash、Edit 或任何其它工具。',
      '如果 Write 工具没有获得授权，请直接说明被拒绝，不要改用其它方式。',
    ].join('\n');
    await harness.typeText(browser, wb006Prompt);
    await harness.clickSend(browser);

    // The product renders exactly one tool permission card for the pending
    // request. The card is identified by the request id the product put into
    // `data-perm-id`; the tool identity comes from the product's own event,
    // because the card title itself does not name the tool.
    const wb006Card = await ui.waitUntil(async () => {
      const cards = await ui.readToolPermissionCards(browser);
      const pending = cards.find(card => !card.settled && card.hasAllow && card.hasDeny);
      return pending || null;
    }, 'the pending tool permission card of WB-006', CARD_TIMEOUT_MS);

    const snapshot6 = await readSession(host.base, session6.sessionId);
    const pageEvents6 = (await ui.readPageEvents(browser, 'claude/permission-request')).map(entry => entry.event);
    const requestEvent6 = eventsOfType(session6.events, 'claude/permission-request').find(event => event.requestId === wb006Card.requestId)
      || eventsOfType(pageEvents6, 'claude/permission-request').find(event => event.requestId === wb006Card.requestId)
      || eventsOfType((snapshot6.body && snapshot6.body.events) || [], 'claude/permission-request').find(event => event.requestId === wb006Card.requestId)
      || null;
    const toolUse6 = eventsOfType(session6.events, 'claude/tool-use').find(event => event.name === 'Write' && event.input && isMarkerPath(event.input.file_path, markerPath, markerName)) || null;
    const markerBefore = fs.existsSync(markerPath);
    const protectedToolName = requestEvent6 && requestEvent6.summary && requestEvent6.summary.toolName;

    record('R44.c-wb006-real-permission-card-raised', requestEvent6 && toolUse6 && !markerBefore && protectedToolName === 'Write' ? 'PASS' : 'BLOCKED', {
      sessionId: session6.sessionId,
      effectivePermissionMode: effectiveMode6,
      modeSwitchThroughTheProductMenu: modeSwitch6,
      card: wb006Card,
      cardTitleNote: 'the product renders the tool name of a permission card in the EVENT summary; the card title itself reads "Agent 请求执行操作"',
      requestEvent: requestEvent6 ? {
        requestId: requestEvent6.requestId,
        kind: requestEvent6.kind || null,
        toolName: protectedToolName,
        allowedTools: requestEvent6.summary && requestEvent6.summary.allowedTools,
        permissionMode: requestEvent6.summary && requestEvent6.summary.permissionMode,
        toolUseID: requestEvent6.summary && requestEvent6.summary.toolUseID,
        promptPreview: requestEvent6.summary && requestEvent6.summary.promptPreview,
      } : null,
      protectedTool: toolUse6 ? { id: toolUse6.id, name: toolUse6.name, filePath: toolUse6.input.file_path } : null,
      markerPath,
      markerExistsBeforeTheDecision: markerBefore,
      markerIsSelfOwned: markerPath.startsWith(layout.root),
      markerIsInsideTheRepository: envLib.isInside(markerPath, envLib.REPO_ROOT),
    });
    assertTrue(requestEvent6, 'no permission-request event for the Write card');
    assertTrue(protectedToolName === 'Write', `the pending permission does not protect the Write tool: ${protectedToolName}`);
    assertTrue(toolUse6, 'no Write tool-use event for the marker path');

    await ui.clickDeny(browser, wb006Card.requestId);
    const settled6 = await ui.waitUntil(async () => {
      const settled = await ui.readSettledCard(browser, wb006Card.requestId);
      return settled.found && settled.settledState ? settled : null;
    }, 'the settled WB-006 card', 60000);
    const resolved6 = await ui.waitUntil(async () => {
      const found = eventsOfType(session6.events, 'claude/permission-resolved').find(event => event.requestId === wb006Card.requestId);
      return found || null;
    }, 'the WB-006 permission-resolved event', 60000);
    await harness.waitUntil(() => eventsOfType(session6.events, 'claude/result').length > 0 || eventsOfType(session6.events, 'claude/error').length > 0, 'the end of the WB-006 turn', TURN_TIMEOUT_MS, 250);

    const markerAfter = fs.existsSync(markerPath);
    const markerHits = scanProjectForMarker(projectRoot, 'WB006-DENIED-MARKER');
    const toolResult6 = eventsOfType(session6.events, 'claude/tool-result').find(event => event.id === toolUse6.id) || null;
    const result6 = eventsOfType(session6.events, 'claude/result')[0] || null;
    const sessionAfter6 = await readSession(host.base, session6.sessionId);
    const wb006Ok = markerAfter === false
      && markerHits.length === 0
      && resolved6.allow === false
      && settled6.settledState === '已拒绝'
      && (toolResult6 ? toolResult6.isError === true : true);
    wb006 = {
      sessionId: session6.sessionId,
      effectivePermissionMode: effectiveMode6,
      protectedTool: { id: toolUse6.id, name: toolUse6.name, filePath: toolUse6.input.file_path },
      markerPath,
      markerExistsAfterTheDenial: markerAfter,
      filesCarryingTheMarkerText: markerHits,
      permissionResolved: { requestId: resolved6.requestId, allow: resolved6.allow, kind: resolved6.kind || null, resolvedAt: resolved6.resolvedAt },
      uiSettledState: settled6.settledState,
      uiSettledCard: settled6,
      pendingPermissionAfterTheDecision: (sessionAfter6.body && sessionAfter6.body.permission) || null,
      toolResult: toolResult6 ? { id: toolResult6.id, isError: toolResult6.isError, output: String(toolResult6.output || '').slice(0, 400) } : null,
      turnResult: result6 ? { subtype: result6.subtype, isError: result6.isError, resultPreview: String(result6.result || '').slice(0, 400) } : null,
      eventTypes: [...new Set(session6.events.map(event => event.type))],
    };
    record('R44.d-wb006-deny-executed-by-the-real-ui', wb006Ok ? 'PASS' : 'FAIL', wb006);
    assertTrue(wb006Ok, 'the denied Write tool still executed, or the receipt and the UI disagree');

    // =====================================================================
    // WB-007 — user question
    // =====================================================================
    const session7 = await newSession(browser, host, readers);
    paidTurns += 1;
    const wb007Prompt = [
      '这是 WB-007 用户问题选择的真实抽测。',
      '请调用 AskUserQuestion 工具向我提问（必须调用该工具，不要用普通文字提问，也不要自己回答）。',
      '一次提出下面三个问题，参数严格如下：',
      '问题1（单选，multiSelect=false）：question 为 "QA-R44 单选：请选择要执行的操作"，header 为 "单选"，options 为 [{"label":"选项甲","description":"第一个选项"},{"label":"选项乙","description":"第二个选项"},{"label":"选项丙","description":"第三个选项"}]',
      '问题2（多选，multiSelect=true）：question 为 "QA-R44 多选：请选择需要检查的项目"，header 为 "多选"，options 为 [{"label":"检查项一","description":"第一项"},{"label":"检查项二","description":"第二项"},{"label":"检查项三","description":"第三项"}]',
      '问题3（单选，multiSelect=false）：question 为 "QA-R44 自定义：请补充你的要求"，header 为 "自定义"，options 为 [{"label":"无特殊要求","description":"不需要额外说明"},{"label":"有特殊要求","description":"有额外要求"},{"label":"需要补充说明","description":"再补充一条"}]',
      '等我回答后，请把三个问题的答案原样复述，每行一条，格式为“问题N：答案”。',
    ].join('\n');
    await harness.typeText(browser, wb007Prompt);
    await harness.clickSend(browser);

    // The product raises the question card from its own
    // `claude/permission-request` event of kind "question". The card is
    // correlated with that event by the request id the product put into
    // `data-perm-id`.
    const questionEvent7 = await ui.waitUntil(async () => {
      const fromStream = eventsOfType(session7.events, 'claude/permission-request').find(event => event.kind === 'question');
      if (fromStream) return fromStream;
      const fromPage = (await ui.readPageEvents(browser, 'claude/permission-request')).map(entry => entry.event);
      return eventsOfType(fromPage, 'claude/permission-request').find(event => event.kind === 'question') || null;
    }, 'the question permission-request event of WB-007', CARD_TIMEOUT_MS);
    const questionCard = await ui.waitUntil(async () => {
      const cards = await ui.readQuestionCards(browser);
      return cards.find(card => card.requestId === questionEvent7.requestId && card.fields.length > 0) || null;
    }, 'the user question card of WB-007', 60000);
    const requestEvent7 = questionEvent7;
    const toolUse7 = toolCallBefore(session7.events, questionCard.requestId, 'AskUserQuestion');
    const askUserQuestionCalls = eventsOfType(session7.events, 'claude/tool-use').filter(event => event.name === 'AskUserQuestion');

    const pendingState = await harness.readState(browser);
    const pendingSession7 = await readSession(host.base, session7.sessionId);
    const pauseProved = pendingState.product.sessionState === 'pending-permission'
      && questionCard.submitDisabled === true
      && Boolean(pendingSession7.body && pendingSession7.body.permission && pendingSession7.body.permission.requestId === questionCard.requestId);
    record('R44.e-wb007-real-question-card-and-pause', pauseProved && requestEvent7 ? 'PASS' : 'BLOCKED', {
      sessionId: session7.sessionId,
      card: questionCard,
      requestEvent: requestEvent7 ? { requestId: requestEvent7.requestId, kind: requestEvent7.kind, toolName: requestEvent7.toolName, questions: requestEvent7.questions } : null,
      toolUse: toolUse7 ? { id: toolUse7.id, name: toolUse7.name } : null,
      askUserQuestionCalls: askUserQuestionCalls.map(call => ({ id: call.id, questionCount: call.input && Array.isArray(call.input.questions) ? call.input.questions.length : null })),
      uiSessionStateWhilePending: pendingState.product.sessionState,
      productPendingPermission: pendingSession7.body && pendingSession7.body.permission ? { requestId: pendingSession7.body.permission.requestId, kind: pendingSession7.body.permission.kind, toolName: pendingSession7.body.permission.toolName, status: pendingSession7.body.permission.status } : null,
      submitDisabledWithoutAnyAnswer: questionCard.submitDisabled,
      answersSubmittedSoFar: 0,
      pausedWithoutSubmission: pauseProved,
    });
    assertTrue(requestEvent7, 'no permission-request event for the question card');
    assertTrue(pauseProved, 'the question card did not hold the turn in the pending-permission state');

    // --- the refused resolutions -----------------------------------------
    const attempts = [];
    const attemptBodies = [
      { label: 'bypass-without-a-selection', body: { allow: true } },
      { label: 'empty-answer', body: { allow: true, answers: { 'question-1': [] } } },
      { label: 'wrong-question-answer', body: { allow: true, answers: { 'question-99': ['选项甲'] } } },
      { label: 'deny-without-a-selection', body: { allow: false } },
    ];
    for (const attempt of attemptBodies) {
      const response = await postResolve(host.base, session7.sessionId, questionCard.requestId, attempt.body);
      const resolvedEvents = eventsOfType(session7.events, 'claude/permission-resolved').filter(event => event.requestId === questionCard.requestId);
      const stillPending = await ui.readQuestionCards(browser);
      const cardStillThere = stillPending.some(card => card.requestId === questionCard.requestId && !card.settled);
      const stateNow = await harness.readState(browser);
      const sessionNow = await readSession(host.base, session7.sessionId);
      const productPending = sessionNow.body && sessionNow.body.permission;
      attempts.push({
        attempt: attempt.label,
        requestBody: attempt.body,
        httpStatus: response.status,
        ok: response.ok,
        error: response.body && response.body.error,
        code: response.body && response.body.code,
        refused: response.status === 400 && response.ok === false,
        permissionResolvedEventsEmitted: resolvedEvents.length,
        questionCardStillPending: cardStillThere,
        productStillHoldsThePendingQuestion: Boolean(productPending && productPending.requestId === questionCard.requestId),
        uiSessionState: stateNow.product.sessionState,
      });
      await harness.wait(300);
    }
    const allRefused = attempts.every(attempt => attempt.refused
      && attempt.permissionResolvedEventsEmitted === 0
      && attempt.questionCardStillPending
      && attempt.productStillHoldsThePendingQuestion);
    record('R44.f-wb007-bypass-cannot-substitute-empty-answer-or-let-it-through', allRefused ? 'PASS' : 'FAIL', {
      sessionId: session7.sessionId,
      requestId: questionCard.requestId,
      attempts,
      everyAttemptRefused: allRefused,
      pendingQuestionSurvivedEveryAttempt: attempts.every(attempt => attempt.questionCardStillPending && attempt.productStillHoldsThePendingQuestion),
      note: 'these resolve calls are NEGATIVE CONTROLS on the product\'s own endpoint; the acceptance below is done through the UI',
    });
    assertTrue(allRefused, 'the product accepted a bypass/empty/wrong resolution of the pending question');

    // --- the product's own bypass mode does not release the question ------
    let bypassSwitch = null;
    try {
      await ui.selectPermissionMode(browser, '完全访问');
      await harness.wait(1500);
      const afterSwitch = await ui.readQuestionCards(browser);
      const resolvedAfterSwitch = eventsOfType(session7.events, 'claude/permission-resolved').filter(event => event.requestId === questionCard.requestId);
      const stateAfterSwitch = await harness.readState(browser);
      const sessionAfterSwitch = await readSession(host.base, session7.sessionId);
      bypassSwitch = {
        control: 'the product\'s own permission-mode menu (完全访问 / bypassPermissions)',
        effectivePermissionModeInTheProduct: sessionAfterSwitch.body && sessionAfterSwitch.body.permissionMode,
        questionCardStillPending: afterSwitch.some(card => card.requestId === questionCard.requestId && !card.settled),
        permissionResolvedEventsEmitted: resolvedAfterSwitch.length,
        uiSessionState: stateAfterSwitch.product.sessionState,
        releasedByTheBypass: resolvedAfterSwitch.length > 0,
      };
      record('R44.g-wb007-bypass-mode-does-not-release-the-question', bypassSwitch.questionCardStillPending && !bypassSwitch.releasedByTheBypass && bypassSwitch.effectivePermissionModeInTheProduct === 'bypassPermissions' ? 'PASS' : 'FAIL', bypassSwitch);
      // Leave the session in the default mode for the rest of the lane.
      await ui.selectPermissionMode(browser, '默认防护');
      await harness.wait(800);
    } catch (error) {
      bypassSwitch = { error: String(error && error.message ? error.message : error) };
      record('R44.g-wb007-bypass-mode-does-not-release-the-question', 'BLOCKED', bypassSwitch);
    }

    // --- the real UI selection -------------------------------------------
    const fields = questionCard.fields;
    const singleIndex = fields.findIndex(field => field.legend.includes('单选'));
    const multiIndex = fields.findIndex(field => field.legend.includes('多选'));
    const customIndex = fields.findIndex(field => field.legend.includes('自定义'));
    assertTrue(singleIndex >= 0 && multiIndex >= 0 && customIndex >= 0, `the question card does not carry the three expected questions: ${JSON.stringify(fields.map(field => field.legend))}`);

    const chosenSingle = '选项甲';
    const chosenMulti = ['检查项一', '检查项二'];
    const chosenCustom = 'QA-R44-CUSTOM-ANSWER-请按选项甲执行并输出确认';

    await ui.selectRadioOption(browser, questionCard.requestId, singleIndex, chosenSingle);
    await ui.selectCheckboxOptions(browser, questionCard.requestId, multiIndex, chosenMulti);
    await ui.typeCustomAnswer(browser, questionCard.requestId, customIndex, chosenCustom);
    await harness.wait(400);
    const filled = await ui.readQuestionCards(browser);
    const filledCard = filled.find(card => card.requestId === questionCard.requestId);
    const submitEnabled = filledCard && filledCard.submitDisabled === false;
    record('R44.h-wb007-ui-enables-the-submit-only-after-a-complete-answer', submitEnabled ? 'PASS' : 'FAIL', {
      requestId: questionCard.requestId,
      submitDisabledBeforeAnyAnswer: questionCard.submitDisabled,
      submitDisabledAfterTheCompleteSelection: filledCard ? filledCard.submitDisabled : null,
      fields: filledCard ? filledCard.fields : null,
    });
    assertTrue(submitEnabled, 'the product\'s submit button stayed disabled after a complete answer');

    await ui.clickSubmitAnswer(browser, questionCard.requestId);
    // The card settles itself: the title becomes 答案已提交 and the card
    // takes the question-settled class. The wait must look for THAT, not
    // for a non-empty title (the title is non-empty before the submission).
    const settled7 = await ui.waitUntil(async () => {
      const settled = await ui.readSettledCard(browser, questionCard.requestId);
      return settled.found && (settled.settled === true || settled.settledState) ? settled : null;
    }, 'the settled WB-007 question card', 60000);
    const resolved7 = await ui.waitUntil(async () => {
      const found = eventsOfType(session7.events, 'claude/permission-resolved').find(event => event.requestId === questionCard.requestId);
      return found || null;
    }, 'the WB-007 permission-resolved event', 60000);
    await harness.waitUntil(() => eventsOfType(session7.events, 'claude/result').length > 0 || eventsOfType(session7.events, 'claude/error').length > 0, 'the end of the WB-007 turn', TURN_TIMEOUT_MS, 250);

    const toolResult7 = toolUse7 ? eventsOfType(session7.events, 'claude/tool-result').find(event => event.id === toolUse7.id) || null : null;
    const result7 = eventsOfType(session7.events, 'claude/result')[0] || null;
    const answerText7 = String((toolResult7 && toolResult7.output) || '');
    const selections = [chosenSingle, ...chosenMulti, chosenCustom];
    const receiptContains = selections.every(value => answerText7.includes(value));
    const finalAnswer7 = String((result7 && result7.result) || '');
    const finalEchoes = selections.every(value => finalAnswer7.includes(value));
    const wb007Ok = resolved7.allow === true
      && resolved7.kind === 'question'
      && settled7.title.includes('答案已提交')
      && receiptContains
      && finalEchoes;
    wb007 = {
      sessionId: session7.sessionId,
      requestId: questionCard.requestId,
      questions: fields.map(field => ({ legend: field.legend, optionLabels: field.options.map(option => option.label), customInput: field.customPresent })),
      selection: { single: chosenSingle, multi: chosenMulti, custom: chosenCustom },
      permissionResolved: { requestId: resolved7.requestId, allow: resolved7.allow, kind: resolved7.kind, resolvedAt: resolved7.resolvedAt },
      uiSettledTitle: settled7.title,
      uiSettledCard: settled7,
      answeredToolCall: toolUse7 ? { id: toolUse7.id, name: toolUse7.name } : null,
      toolResult: toolResult7 ? { id: toolResult7.id, isError: toolResult7.isError, output: answerText7.slice(0, 800) } : null,
      askUserQuestionToolResults: eventsOfType(session7.events, 'claude/tool-result')
        .filter(event => askUserQuestionCalls.some(call => call.id === event.id))
        .map(event => ({ id: event.id, isError: event.isError, output: String(event.output || '').slice(0, 400) })),
      receiptContainsEverySelection: receiptContains,
      finalAnswerEchoesEverySelection: finalEchoes,
      finalAnswerPreview: finalAnswer7.slice(0, 600),
      eventTypes: [...new Set(session7.events.map(event => event.type))],
    };
    record('R44.i-wb007-real-ui-selection-submitted-and-the-receipt-matches', wb007Ok ? 'PASS' : 'FAIL', wb007);
    assertTrue(wb007Ok, 'the submitted answers did not reach the model, or the receipt disagrees with the selection');

    // =====================================================================
    // the bounded bypass turn
    // =====================================================================
    if (String(process.env.QA_R44_BYPASS_TURN || '1') === '1') {
      try {
        const session8 = await newSession(browser, host, readers);
        // The bypass mode is a property of the SESSION, so it is switched on
        // the new session itself and read back from the product.
        await ui.selectPermissionMode(browser, '完全访问');
        await harness.wait(800);
        const mode8 = await readSession(host.base, session8.sessionId);
        const effectiveMode8 = mode8.body && mode8.body.permissionMode;
        paidTurns += 1;
        await harness.typeText(browser, '请调用 AskUserQuestion 工具问一个问题：question 为 "QA-R44 bypass 完全访问下的问题"，options 为 [{"label":"同意","description":"同意"},{"label":"不同意","description":"不同意"}]，multiSelect=false。收到回答后原样复述。');
        await harness.clickSend(browser);
        const event8 = await ui.waitUntil(async () => {
          const found = eventsOfType(session8.events, 'claude/permission-request').find(event => event.kind === 'question');
          return found || null;
        }, 'the question permission-request event of the bypass turn', 120000);
        const card8 = await ui.waitUntil(async () => {
          const cards = await ui.readQuestionCards(browser);
          return cards.find(card => card.requestId === event8.requestId && card.fields.length > 0) || null;
        }, 'the question card of the bypass turn', 60000);
        const resolved8 = eventsOfType(session8.events, 'claude/permission-resolved').find(event => event.requestId === card8.requestId) || null;
        const stillPending8 = resolved8 === null;
        // Answer it through the UI so the bounded turn can finish.
        const field8 = card8.fields[0];
        const option8 = field8.options[0];
        if (option8) await ui.selectRadioOption(browser, card8.requestId, 0, option8.label);
        else await ui.typeCustomAnswer(browser, card8.requestId, 0, 'QA-R44-BYPASS-ANSWER');
        await harness.wait(400);
        await ui.clickSubmitAnswer(browser, card8.requestId);
        await harness.waitUntil(() => eventsOfType(session8.events, 'claude/result').length > 0 || eventsOfType(session8.events, 'claude/error').length > 0, 'the end of the bypass turn', TURN_TIMEOUT_MS, 250);
        bypassTurn = {
          permissionMode: 'bypassPermissions (完全访问), selected through the product\'s own menu',
          effectivePermissionModeInTheProduct: effectiveMode8,
          questionCardRaised: true,
          questionPausedWithoutAnAnswer: stillPending8,
          resolvedBeforeAnySelection: resolved8 !== null,
          requestId: card8.requestId,
          eventTypes: [...new Set(session8.events.map(event => event.type))],
        };
        record('R44.j-wb007-the-bypass-mode-still-asks-the-question', stillPending8 && effectiveMode8 === 'bypassPermissions' ? 'PASS' : 'FAIL', bypassTurn);
        await ui.selectPermissionMode(browser, '默认防护');
      } catch (error) {
        bypassTurn = { error: String(error && error.message ? error.message : error), note: 'the bounded bypass turn did not complete; R44.j is a required case, so the lane verdict is BLOCKED' };
        record('R44.j-wb007-the-bypass-mode-still-asks-the-question', 'BLOCKED', bypassTurn);
      }
    } else {
      bypassTurn = { skipped: true, note: 'the bounded bypass turn was disabled with QA_R44_BYPASS_TURN=0; R44.j is a required case, so the lane verdict is BLOCKED' };
      record('R44.j-wb007-the-bypass-mode-still-asks-the-question', 'BLOCKED', bypassTurn);
    }
  } catch (error) {
    record('R44.runtime', 'BLOCKED', { error: String(error && error.message ? error.message : error), stack: String(error && error.stack || '').split('\n').slice(0, 6) });
  } finally {
    // Every reader of this lane is stopped first, so no timer and no socket
    // of this lane survives the run.
    for (const reader of readers) { try { reader.stop(); } catch { /* the reader is disposable */ } }
    if (browser) { try { await browser.close(); } catch { /* the browser is disposable */ } }
    if (host.child) { await harness.stopHost(host); }
  }

  const digestComparison = envLib.compareDigests(realProfilesBefore, envLib.digestDirectory(envLib.realProfileDir()));
  record('R44.k-real-profiles-byte-identical', digestComparison.byteIdentical ? 'PASS' : 'FAIL', {
    profileDir: envLib.realProfileDir(),
    comparison: 'byte-level SHA256, computed in memory; the digests are never printed, logged or persisted',
    fileCount: digestComparison.count,
    changedFiles: digestComparison.changedFiles,
    addedFiles: digestComparison.addedFiles,
    removedFiles: digestComparison.removedFiles,
  });

  const evaluation = evaluateCases(results);
  const proven = evaluation.proven;

  return {
    lane: 'P-WB-PERMISSION-QUESTION-R44',
    file: '_site/_test/qa-r44-permission-question.js',
    startedAt,
    finishedAt: new Date().toISOString(),
    cases: ['WB-006', 'WB-007'],
    module: identity,
    pinned: pinnedIdentity(),
    source: sourceIdentity(),
    profile: { id: PROFILE_ID, source: 'the original subscription store, read-only; the credential stays in the host process memory', credentialWrittenAnywhere: false, quotaEndpointQueried: false },
    isolation: envLib.isolationContract(layout, captured, hardened),
    wb006,
    wb007,
    bypassTurn,
    paidTurnsSent: paidTurns,
    networkUsed: true,
    cases_detail: results,
    essentialCases: ESSENTIAL_CASES,
    caseEvaluation: evaluation,
    verdict: proven ? 'PASS' : 'BLOCKED',
  };
}

module.exports = { main, results, ESSENTIAL_CASES, evaluateCases };
