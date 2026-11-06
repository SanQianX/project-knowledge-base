#!/usr/bin/env node
'use strict';
// P-DOCK-ACCEPTANCE-02 / DOCK-001: 右上角显示隐藏控制循环（真实任务版）。
//
// Real product page + real pinned terminal module + real Chrome + ONE real
// model turn through the ORIGINAL minimax / MiniMax-M3.1-Flash profile
// (copied READ-ONLY into the isolated module data dir; the secret never
// leaves that directory, is never logged, never put into a URL and never
// reaches the browser or the report).
//
// R1 gap this probe closes: R1 never produced a non-empty task list, so
// "the task list stayed empty" could not prove that a populated task
// survives the Dock control. Here a real background Node task is produced
// by the model itself, and the Dock toggle is clicked while the task is
// running (active window) and again after it settled (quiescent window).
//
// Expectations (test-cases.json DOCK-001):
//   1. 按钮实际可点        — each real click flips aria-expanded + dock visibility.
//   2. 不改变会话和任务    — in the quiescent window the session id, the event
//                            list, the event sequence ownership and the native
//                            task list are byte-identical before/after; in the
//                            active window every new event is a model/task
//                            event, never a Dock- or panel-caused change.
//   3. 缺实现先标需求差异  — if the toggle never appears, record the gap
//                            instead of fabricating a button.
//
// Real API limits: if the provider rate-limits, the exact error is stored
// verbatim in the evidence, no further model call is made, and the verdict
// stays honest (no "accepted" is reported as a model success).

const os = require('os');
const path = require('path');

const PKB_ROOT = path.resolve(__dirname, '..', '..', '..');
const UI = require(path.join(PKB_ROOT, '_site', '_test', 'helpers', 'parallel-dock-acceptance-r2-ui.js'));
const { createDockAcceptanceEnv } = require(path.join(PKB_ROOT, '_site', '_test', 'helpers', 'parallel-dock-acceptance-r2-env.js'));

const ARTIFACTS = path.join(PKB_ROOT, 'qa-autopilot', 'artifacts', 'parallel-20261023', 'dock-acceptance-r2');
const MODEL_PROFILE_ID = process.env.R2_DOCK_MODEL_PROFILE || 'minimax';
const ACTIVE_TOGGLES = 4;
const QUIESCENT_TOGGLES = 4;
const TOTAL_BUDGET_MS = Number(process.env.R2_DOCK_BUDGET_MS || 20 * 60 * 1000);
const TURN_BUDGET_MS = Number(process.env.R2_DOCK_TURN_BUDGET_MS || 6 * 60 * 1000);

const startedAt = Date.now();
function budgetGuard(label) {
  const spent = Date.now() - startedAt;
  if (spent > TOTAL_BUDGET_MS) throw new Error(`total budget exceeded at ${label} (${spent}ms > ${TOTAL_BUDGET_MS}ms)`);
}

const TASK_PROMPT = [
  '请执行下面这一条真实任务（只做这一件事，不要修改仓库里的任何文件）：',
  '1) 用 Bash 工具在后台（run_in_background）运行这条命令：',
  '   node -e "setTimeout(()=>{console.log(\'R2-DOCK-TASK-OK\')},12000)"',
  '2) 等这个后台任务结束后，把它的输出原样告诉我。',
  '这是隔离测试夹具里的一次性验证任务。',
].join('\n');

function verdictOf(expectations) {
  return expectations.length && expectations.every(item => item.pass) ? 'PASS' : 'FAIL';
}

function eventTypeList(events) {
  return events.map(event => event.type);
}

function sequencesOf(events) {
  return events.map(event => event.sequence).filter(value => Number.isFinite(value));
}

function isStrictlyIncreasing(values) {
  for (let i = 1; i < values.length; i += 1) if (!(values[i] > values[i - 1])) return false;
  return true;
}

// A provider-side limit must never be smoothed over: the exact text is kept.
function looksRateLimited(payload) {
  const text = JSON.stringify(payload || '').toLowerCase();
  return /rate[_\s-]?limit|\b429\b|2067|too many requests|quota|insufficient balance|余额不足|限流/.test(text);
}

async function main() {
  const evidence = {
    schema: 'qa-autopilot/dock-acceptance-evidence/v1',
    case: 'DOCK-001',
    lane: 'P-DOCK-ACCEPTANCE-02',
    startedAt: new Date().toISOString(),
    toggles: [],
    activeWindow: null,
    quiescentWindow: null,
    expectations: [],
    firstFailure: null,
    modelLimitation: null,
  };
  let env = null;
  let browser = null;
  let sessionId = null;

  const readEvents = async () => {
    const loaded = await env.termApi(`sessions/${sessionId}`);
    const events = Array.isArray(loaded.data && loaded.data.events) ? loaded.data.events : [];
    return { loaded, events };
  };

  const readTasks = async () => {
    const scope = env.storeScope();
    if (!scope) return { error: 'store scope unavailable', tasks: [] };
    const response = await env.termApi(
      `sessions/${sessionId}/native-tasks?storeScope=${encodeURIComponent(scope)}&contextId=${encodeURIComponent(env.terminalProjectId)}`
    );
    if (response.status !== 200) {
      return { error: `native-tasks ${response.status}: ${String(response.text).slice(0, 400)}`, tasks: [] };
    }
    const page = response.data || {};
    const rows = Array.isArray(page.tasks) ? page.tasks : (Array.isArray(page.items) ? page.items : []);
    const diagnosticsTotal = page.diagnostics && page.diagnostics.total !== undefined ? page.diagnostics.total : null;
    return {
      scope: page.scope || null,
      total: diagnosticsTotal === null || diagnosticsTotal === 0 ? rows.length : diagnosticsTotal,
      incomplete: Array.isArray(page.incomplete) ? page.incomplete : null,
      tasks: rows.map(item => ({
        taskId: item.taskId || null,
        status: item.status || null,
        statusSource: item.statusSource || null,
        taskType: item.taskType || null,
        taskKind: item.taskKind || null,
        association: item.association || null,
        owner: item.owner || null,
        ownerRunId: item.ownerRunId || null,
        rowCount: item.rowCount === undefined ? null : item.rowCount,
        taskRef: item.taskRef || null,
      })),
      raw: rows,
    };
  };

  try {
    env = await createDockAcceptanceEnv({ tag: 'dock001-r2', modelProfileId: MODEL_PROFILE_ID });
    evidence.identity = { ...env.identity(), fileHashes: env.fileHashes() };
    evidence.env = {
      productUrl: env.productUrl,
      terminalUrl: env.terminalUrl,
      terminalProjectId: env.terminalProjectId,
      fixtureRoot: env.fixtureRoot,
      modelProfile: env.modelProfile,
    };
    console.log(`[dock001-r2] product=${env.productUrl} terminal=${env.terminalUrl} profile=${env.modelProfile && env.modelProfile.profileId}`);

    // The profile must be a real one the module actually resolves. Only the
    // non-secret facts are recorded.
    const profiles = await env.termApi('profiles');
    const profileList = Array.isArray(profiles.data) ? profiles.data
      : ((profiles.data && profiles.data.profiles) || []);
    const resolvedProfile = profileList.find(item => item && item.id === MODEL_PROFILE_ID) || null;
    evidence.profile = {
      profileId: MODEL_PROFILE_ID,
      listedByModule: Boolean(resolvedProfile),
      credentialConfigured: Boolean(resolvedProfile && resolvedProfile.credentialConfigured),
      provider: (resolvedProfile && resolvedProfile.provider) || null,
      baseUrl: (resolvedProfile && resolvedProfile.baseUrl) || null,
      defaultModel: (resolvedProfile && resolvedProfile.models && resolvedProfile.models.default) || null,
      credentialRef: (resolvedProfile && resolvedProfile.credentialRef) || null,
      secretRecorded: false,
    };
    if (!resolvedProfile || !resolvedProfile.credentialConfigured) {
      throw new Error(`profile "${MODEL_PROFILE_ID}" is not usable in the isolated module store`);
    }

    // ---- real session bound to the real profile -----------------------
    const created = await env.termApi('sessions', {
      method: 'POST',
      body: {
        context: { contextId: env.terminalProjectId, workspaceRef: env.terminalProjectId },
        aiProfileId: MODEL_PROFILE_ID,
        model: evidence.profile.defaultModel || undefined,
        permissionMode: 'bypassPermissions',
      },
    });
    if (created.status !== 201 || !created.data || !created.data.session) {
      throw new Error(`session creation failed: ${created.status} ${String(created.text).slice(0, 600)}`);
    }
    sessionId = created.data.session.sessionId;
    evidence.session = {
      sessionId,
      createdVia: 'module public API through the product proxy (POST /api/terminal/sessions) with aiProfileId=' + MODEL_PROFILE_ID,
      aiProfileId: created.data.session.aiProfileId || null,
      selectedModel: created.data.session.selectedModel || null,
      permissionMode: created.data.session.permissionMode || null,
      agentId: created.data.session.agentId || null,
    };
    console.log(`[dock001-r2] session=${sessionId} model=${evidence.session.selectedModel}`);

    // ---- one real model turn that produces a real task record ---------
    const turnStartedAt = Date.now();
    const input = await env.termApi(`sessions/${sessionId}/input`, {
      method: 'POST', body: { text: TASK_PROMPT },
    });
    evidence.turn = {
      startedAt: new Date(turnStartedAt).toISOString(),
      inputStatus: input.status,
      inputAccepted: input.status === 202,
      prompt: TASK_PROMPT,
    };
    if (input.status !== 202) {
      evidence.modelLimitation = {
        kind: 'input-rejected',
        status: input.status,
        body: String(input.text || '').slice(0, 2000),
      };
      throw new Error(`model input rejected: ${input.status} ${String(input.text).slice(0, 600)}`);
    }

    // Wait for the model's own task record (a native task) plus a real
    // tool record. The provider's own errors are captured verbatim.
    let turnEvents = [];
    let taskEvents = [];
    let toolEvents = [];
    let turnError = null;
    while (Date.now() - turnStartedAt < TURN_BUDGET_MS) {
      const { events } = await readEvents();
      turnEvents = events;
      taskEvents = events.filter(event => String(event.type || '').startsWith('claude/task-'));
      toolEvents = events.filter(event => /claude\/tool|claude\/tool-use|claude\/tool-result/.test(String(event.type || '')));
      const errorEvent = events.find(event => /error/i.test(String(event.type || '')) && event.error);
      if (errorEvent) { turnError = errorEvent; break; }
      if (taskEvents.length && toolEvents.length) break;
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
    const turnEndedAt = Date.now();
    evidence.turn.endedAt = new Date(turnEndedAt).toISOString();
    evidence.turn.durationMs = turnEndedAt - turnStartedAt;
    evidence.turn.eventCount = turnEvents.length;
    evidence.turn.eventTypes = [...new Set(eventTypeList(turnEvents))];
    evidence.turn.taskEvents = taskEvents.map(event => ({
      type: event.type, taskId: event.taskId || null, status: event.status || null,
      taskType: event.taskType || null, sequence: event.sequence, at: event.at || null,
    }));
    evidence.turn.toolEvents = toolEvents.slice(0, 12).map(event => ({
      type: event.type, name: event.name || null, sequence: event.sequence, at: event.at || null,
      toolUseId: event.toolUseId || null,
    }));
    if (turnError) {
      const raw = JSON.stringify(turnError).slice(0, 2000);
      evidence.modelLimitation = {
        kind: looksRateLimited(turnError) ? 'provider-rate-limit' : 'model-turn-error',
        event: turnError,
        raw,
      };
      if (looksRateLimited(turnError)) {
        console.error('[dock001-r2] provider rate limit recorded verbatim; no further model call is made');
      }
    }
    if (!taskEvents.length) {
      throw new Error(`no real native task record after ${TURN_BUDGET_MS}ms (event types: ${evidence.turn.eventTypes.join(',')})`);
    }

    // ---- the real UI: the session must be visible there ---------------
    browser = await UI.launchCdpBrowser({
      chrome: UI.findChrome(),
      profileDir: path.join(os.tmpdir(), `pk-dock001-r2-profile-${process.pid}`),
      url: env.productUrl, width: 1920, height: 1080,
    });
    await UI.installProductLog(browser);
    await UI.openWorkView(browser, env.productUrl);
    await UI.installTerminalLog(browser);
    await UI.waitFor(() => UI.sessionRowExists(browser, sessionId), 'session row visible in the real UI', 30000);

    const baseline = await readEvents();
    const baselineTasks = await readTasks();
    evidence.baseline = {
      sessionId,
      eventCount: baseline.events.length,
      eventTypes: [...new Set(eventTypeList(baseline.events))],
      sequences: sequencesOf(baseline.events),
      nativeTasks: baselineTasks,
      modulePid: env.processes.terminal.pid,
      sessionListIds: ((await env.termApi(`sessions?contextId=${env.terminalProjectId}`)).data.sessions || []).map(row => row.sessionId).sort(),
    };

    const baselineDock = await UI.dockSnapshot(browser);
    evidence.dockSnapshots = [{ step: 'baseline', snapshot: baselineDock }];

    let toggleVisible = true;
    try {
      await UI.waitFor(() => UI.dockSnapshot(browser).then(snap => snap && snap.toggleHidden === false),
        'dock toggle button visible', 20000);
    } catch (error) {
      toggleVisible = false;
      evidence.requirementGap = {
        text: '右上角显示/隐藏按钮（#btn-dock-toggle）在有会话后仍未出现/保持 hidden，按用例要求先记录需求差异，不伪造按钮。',
        error: error.message,
      };
    }
    evidence.toggleVisible = toggleVisible;

    const clickToggle = async (index, window) => {
      await UI.clickDockToggle(browser);
      const expectedExpanded = index % 2 === 1;
      const snap = await UI.waitFor(
        () => UI.dockSnapshot(browser).then(value => (value.expanded === String(expectedExpanded) ? value : null)),
        `toggle ${index} -> expanded=${expectedExpanded}`, 10000
      );
      const { events } = await readEvents();
      const tasks = await readTasks();
      const record = {
        window,
        click: index,
        expectedExpanded,
        snapshot: {
          expanded: snap.expanded, dockHidden: snap.dockHidden, dockOpenClass: snap.dockOpenClass,
          toggleTitle: snap.toggleTitle, tabCount: snap.tabCount,
        },
        eventCount: events.length,
        sequences: sequencesOf(events),
        taskIds: tasks.tasks.map(task => `${task.taskId}:${task.status}`),
      };
      evidence.toggles.push(record);
      return record;
    };

    // ---- ACTIVE window: the real task is still running ----------------
    budgetGuard('active window');
    const activeStartEvents = baseline.events.length;
    const activeStartTasks = baselineTasks;
    for (let i = 1; i <= ACTIVE_TOGGLES; i += 1) {
      if (Date.now() - turnStartedAt > TURN_BUDGET_MS + 120000) break;
      await clickToggle(i, 'active');
    }
    const activeEnd = await readEvents();
    const activeEndTasks = await readTasks();
    const newDuringActive = activeEnd.events.slice(activeStartEvents);
    evidence.activeWindow = {
      eventCountBefore: activeStartEvents,
      eventCountAfter: activeEnd.events.length,
      newEventTypes: [...new Set(eventTypeList(newDuringActive))],
      newEventSamples: newDuringActive.slice(0, 20).map(event => ({
        type: event.type, sequence: event.sequence, at: event.at || null,
        taskId: event.taskId || null, status: event.status || null, name: event.name || null,
      })),
      nativeTasksBefore: activeStartTasks,
      nativeTasksAfter: activeEndTasks,
      dockCausedEventTypes: newDuringActive.filter(event => /panel|dock/i.test(String(event.type || ''))).map(event => event.type),
    };

    // ---- wait for the real task to settle -----------------------------
    budgetGuard('task settle');
    const settleDeadline = Date.now() + 180000;
    let settled = null;
    let taskTerminal = false;
    while (Date.now() < settleDeadline) {
      const tasks = await readTasks();
      const statuses = tasks.tasks.map(task => String(task.status || '').toLowerCase());
      taskTerminal = statuses.length > 0
        && statuses.every(status => /completed|done|finished|succeeded|failed|error|cancelled/.test(status));
      if (taskTerminal) { settled = tasks; break; }
      const { events } = await readEvents();
      const turnEnded = events.some(event => /claude\/turn-(complete|ended)|claude\/result/.test(String(event.type || '')));
      // The turn may end before the background task's own facts reach the
      // durable journal: keep waiting for the task rows themselves.
      if (turnEnded && tasks.tasks.length) { settled = tasks; break; }
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
    const afterSettle = await readEvents();
    const afterSettleTasks = await readTasks();
    evidence.taskSettled = {
      settled: Boolean(settled),
      taskReachedTerminalStatus: taskTerminal,
      nativeTasks: afterSettleTasks,
      eventCount: afterSettle.events.length,
      lastEventTypes: [...new Set(eventTypeList(afterSettle.events.slice(-12)))],
    };

    // ---- QUIESCENT window: the Dock must change nothing at all -------
    budgetGuard('quiescent window');
    const quietStart = await readEvents();
    const quietStartTasks = await readTasks();
    const quietStartSessionIds = ((await env.termApi(`sessions?contextId=${env.terminalProjectId}`)).data.sessions || [])
      .map(row => row.sessionId).sort();
    for (let i = 1; i <= QUIESCENT_TOGGLES; i += 1) {
      await clickToggle(ACTIVE_TOGGLES + i, 'quiescent');
    }
    const quietEnd = await readEvents();
    const quietEndTasks = await readTasks();
    const quietEndSessionIds = ((await env.termApi(`sessions?contextId=${env.terminalProjectId}`)).data.sessions || [])
      .map(row => row.sessionId).sort();
    const quietStartSeq = sequencesOf(quietStart.events);
    const quietEndSeq = sequencesOf(quietEnd.events);
    evidence.quiescentWindow = {
      eventCountBefore: quietStart.events.length,
      eventCountAfter: quietEnd.events.length,
      sequencesBefore: quietStartSeq,
      sequencesAfter: quietEndSeq,
      sequencesIdentical: JSON.stringify(quietStartSeq) === JSON.stringify(quietEndSeq),
      tasksBefore: quietStartTasks,
      tasksAfter: quietEndTasks,
      tasksIdentical: JSON.stringify(quietStartTasks.tasks) === JSON.stringify(quietEndTasks.tasks),
      modulePidSame: env.processes.terminal.pid === evidence.baseline.modulePid && env.processes.terminal.exitCode === null,
      modulePid: env.processes.terminal.pid,
      moduleExitCode: env.processes.terminal.exitCode,
      sessionIdsBefore: quietStartSessionIds,
      sessionIdsAfter: quietEndSessionIds,
      sessionIdsUnchanged: JSON.stringify(quietStartSessionIds) === JSON.stringify(quietEndSessionIds),
      sessionIdsAtBaseline: evidence.baseline.sessionListIds,
    };

    const logs = await UI.getLogs(browser);
    evidence.finalDockState = await UI.dockSnapshot(browser);
    evidence.messageCounts = {
      product: logs.productLog.length,
      terminal: logs.termLog.length,
      panelOpenRequests: logs.productLog.filter(entry => entry.type === 'kb:panel/open').length,
      panelContentRequests: logs.productLog.filter(entry => entry.type === 'kb:panel/content').length,
    };
    evidence.productLog = logs.productLog;
    evidence.termLog = logs.termLog;

    // ---- expectations -------------------------------------------------
    const togglesOk = toggleVisible
      && evidence.toggles.length === ACTIVE_TOGGLES + QUIESCENT_TOGGLES
      && evidence.toggles.every(item => String(item.expectedExpanded) === item.snapshot.expanded
        && item.snapshot.dockHidden === !item.expectedExpanded);
    evidence.expectations.push({
      key: 'button-clickable',
      expect: '按钮实际可点：每次点击 aria-expanded 翻转且 #right-dock.hidden 同步变化',
      observed: toggleVisible
        ? evidence.toggles.map(item => `${item.window}#${item.click}: expanded=${item.snapshot.expanded} dockHidden=${item.snapshot.dockHidden}`)
        : '按钮未出现（需求差异已记录）',
      pass: togglesOk,
    });

    const nonEmptyTask = afterSettleTasks.tasks.length > 0 && taskEvents.length > 0;
    // Ownership is proved by the native-task scope the module itself binds to
    // this session, not by anything the driver writes.
    const taskScope = afterSettleTasks.scope || null;
    const taskOwnership = Boolean(taskScope
      && taskScope.parentSessionId === sessionId
      && taskScope.contextId === env.terminalProjectId);
    evidence.expectations.push({
      key: 'real-task-non-empty',
      expect: '任务侧非空：真实模型回合产生可验证的原任务记录与真实工具记录（不是伪造状态），且任务归属本会话',
      observed: JSON.stringify({
        modelProfile: evidence.profile.profileId,
        model: evidence.session.selectedModel,
        inputAccepted: evidence.turn.inputAccepted,
        turnEventCount: evidence.turn.eventCount,
        taskEvents: evidence.turn.taskEvents,
        toolEventCount: evidence.turn.toolEvents.length,
        toolEvents: evidence.turn.toolEvents.slice(0, 6),
        nativeTasks: afterSettleTasks.tasks,
        nativeTaskTotal: afterSettleTasks.total,
        nativeTaskScope: taskScope,
        taskReachedTerminalStatus: evidence.taskSettled.taskReachedTerminalStatus,
        taskOwnership: taskOwnership,
      }),
      pass: nonEmptyTask && taskOwnership && evidence.turn.inputAccepted === true,
    });

    const quiet = evidence.quiescentWindow;
    evidence.expectations.push({
      key: 'no-session-task-change',
      expect: '循环切换不改变会话和任务（静默窗口内事件数、事件序列归属、任务身份与状态逐项一致；活动窗口内的新增事件全部来自模型任务本身）',
      observed: JSON.stringify({
        sessionIdSame: afterSettle.loaded && afterSettle.loaded.data && afterSettle.loaded.data.session
          ? afterSettle.loaded.data.session.sessionId === sessionId : false,
        quiescentEventCount: `${quiet.eventCountBefore} -> ${quiet.eventCountAfter}`,
        quiescentSequencesIdentical: quiet.sequencesIdentical,
        quiescentTasksIdentical: quiet.tasksIdentical,
        quiescentSessionIds: `${JSON.stringify(quiet.sessionIdsBefore)} -> ${JSON.stringify(quiet.sessionIdsAfter)}`,
        sessionIdsAtBaseline: quiet.sessionIdsAtBaseline,
        activeWindowNewEventTypes: evidence.activeWindow.newEventTypes,
        activeWindowDockCausedEventTypes: evidence.activeWindow.dockCausedEventTypes,
        modulePidSame: quiet.modulePidSame,
        sessionIdsUnchanged: quiet.sessionIdsUnchanged,
        panelOpenRequests: evidence.messageCounts.panelOpenRequests,
      }),
      pass: Boolean(
        quiet.eventCountBefore === quiet.eventCountAfter
        && quiet.sequencesIdentical
        && quiet.tasksIdentical
        && quiet.modulePidSame
        && quiet.sessionIdsUnchanged
        && evidence.activeWindow.dockCausedEventTypes.length === 0
        && evidence.messageCounts.panelOpenRequests === 0
      ),
    });

    const seqs = sequencesOf(afterSettle.events);
    evidence.expectations.push({
      key: 'sequence-ownership',
      expect: '事件序列归属保留：会话事件的 sequence 严格递增且唯一，不会被 Dock 操作打断或重排',
      observed: JSON.stringify({
        firstSeq: seqs[0] || null,
        lastSeq: seqs[seqs.length - 1] || null,
        count: seqs.length,
        unique: new Set(seqs).size === seqs.length,
        strictlyIncreasing: isStrictlyIncreasing(seqs),
      }),
      pass: seqs.length > 0 && new Set(seqs).size === seqs.length && isStrictlyIncreasing(seqs),
    });

    evidence.consoleErrors = browser.consoleErrors.length;
    evidence.exceptions = browser.exceptions.length;
    if (browser.consoleErrors.length) evidence.consoleErrorSamples = browser.consoleErrors.slice(0, 5);
    if (browser.exceptions.length) evidence.exceptionSamples = browser.exceptions.slice(0, 5);
  } catch (error) {
    evidence.firstFailure = { message: error.message, stack: String(error.stack || '').split('\n').slice(0, 12) };
    try { if (browser) evidence.failureContext = await UI.failureContext(browser); } catch {}
  } finally {
    // Only this probe's own session is ever touched.
    if (sessionId && env) {
      try {
        const abort = await env.termApi(`sessions/${sessionId}/abort`, { method: 'POST', body: { reason: 'dock-acceptance-r2 fixture cleanup' } });
        evidence.cleanup = { abortedOwnSession: abort.status, sessionId };
      } catch (error) {
        evidence.cleanup = { abortedOwnSession: `error: ${error.message}`, sessionId };
      }
    }
    evidence.verdict = evidence.firstFailure ? 'FAIL' : verdictOf(evidence.expectations);
    evidence.finishedAt = new Date().toISOString();
    try { if (browser) await browser.close(); } catch {}
    try { if (env) await env.cleanup(); } catch (error) { console.error('[dock001-r2] cleanup error:', error.message); }
    const writer = UI.evidenceWriter(ARTIFACTS, 'dock001-evidence.json');
    evidence.file = writer.write(evidence);
    console.log(`[dock001-r2] verdict=${evidence.verdict} evidence=${evidence.file}`);
    process.exitCode = evidence.verdict === 'PASS' ? 0 : 1;
  }
}

main().catch(error => { console.error('[dock001-r2] fatal:', error); process.exitCode = 1; });
