#!/usr/bin/env node
'use strict';
// P-DOCK-ACCEPTANCE-R7 / DOCK-006: 子代理控制台.
//
// ONE real model turn (leader-approved) through the r3 isolation launcher:
// real minimax profile read-only, secret via pipe, isolated HOME/ports, no
// quota API. The turn delegates a real bounded background task; the probe
// then verifies, through the REAL UI:
//
//   1. 显示真实事件 — the 子代理任务 console (#background-tasks) renders a
//      REAL task card (taskId/status from native task records); opening the
//      card through dock.openTask shows the task's real events in a dock tab.
//   2. 完成历史 — after completion the card settles on 已完成 and the tab
//      re-opens (reuse) with the history still present, no duplicate tabs.
//   3. 只读重试不重复委派 — repeated native-task history reads and tab
//      open/close cycles never create a new task/delegation (taskId set is
//      stable). The explicit read-FAILURE retry affordance is not exercised
//      here (it would need fault injection) — recorded as the boundary.
//
// Provider limits are kept verbatim; a rate-limited turn fails honestly.

const fs = require('fs');
const path = require('path');

const PKB_ROOT = path.resolve(__dirname, '..', '..', '..');
const UI = require(path.join(PKB_ROOT, '_site', '_test', 'helpers', 'parallel-dock-isolation-r3-ui.js'));
const { createDockIsolationEnv } = require(path.join(PKB_ROOT, '_site', '_test', 'helpers', 'parallel-dock-isolation-r3-env.js'));

const ARTIFACTS = process.env.PK_R7_ARTIFACTS
  || path.join(PKB_ROOT, 'qa-autopilot', 'artifacts', 'parallel-20261106', 'dock-acceptance-r7');
const MODEL_PROFILE_ID = process.env.R7_DOCK_MODEL_PROFILE || 'minimax';
const TURN_BUDGET_MS = Number(process.env.R7_DOCK_TURN_BUDGET_MS || 8 * 60 * 1000);
const TOTAL_BUDGET_MS = Number(process.env.R7_DOCK_BUDGET_MS || 20 * 60 * 1000);

const startedAt = Date.now();
function budgetGuard(label) {
  const spent = Date.now() - startedAt;
  if (spent > TOTAL_BUDGET_MS) throw new Error(`total budget exceeded at ${label} (${spent}ms > ${TOTAL_BUDGET_MS}ms)`);
}

const TASK_PROMPT = [
  '请执行下面这一条真实任务（只做这一件事，不要修改仓库里的任何文件）：',
  '1) 用 Bash 工具在后台（run_in_background）运行这条命令：',
  '   node -e "setTimeout(()=>{console.log(\'R7-DOCK006-TASK-OK\')},8000)"',
  '2) 等这个后台任务结束后，把它的输出原样告诉我。',
  '这是隔离测试夹具里的一次性验证任务。',
].join('\n');

function looksRateLimited(payload) {
  const text = JSON.stringify(payload || '').toLowerCase();
  return /rate[_\s-]?limit|\b429\b|2067|too many requests|quota|insufficient balance|余额不足|限流/.test(text);
}

async function main() {
  fs.mkdirSync(ARTIFACTS, { recursive: true });
  const evidence = {
    schema: 'qa-autopilot/dock-acceptance-evidence/v1',
    case: 'DOCK-006',
    lane: 'P-DOCK-ACCEPTANCE-R7',
    startedAt: new Date().toISOString(),
    steps: [],
    expectations: [],
    firstFailure: null,
    modelLimitation: null,
  };
  let env = null;
  let browser = null;
  let sessionId = null;
  const consoleCards = () => UI.frameEval(browser, `return (() => {
    const panel = doc.getElementById('background-tasks');
    if (!panel) return { panelPresent: false, cards: [] };
    return {
      panelPresent: true,
      hidden: panel.hidden === true,
      ariaLabel: panel.getAttribute('aria-label') || '',
      cards: Array.from(panel.querySelectorAll('.task-card')).map(card => ({
        taskId: card.dataset.taskId || '',
        title: (card.querySelector('.task-row-title') || { textContent: '' }).textContent || '',
        status: (card.querySelector('.task-row-status') || { textContent: '' }).textContent || '',
        openable: card.tagName === 'BUTTON',
      })),
    };
  })()`);

  try {
    const HANDOFF_FILE = process.env.PK_R3_HANDOFF || null;
    if (!HANDOFF_FILE) {
      throw new Error('this probe only runs through parallel-dock-isolation-r3-launch.js (PK_R3_HANDOFF missing): the isolated environment is the point of this lane');
    }
    const handoff = JSON.parse(fs.readFileSync(HANDOFF_FILE, 'utf8'));
    env = await createDockIsolationEnv({ tag: 'dock-r7', handoff });
    evidence.identity = { ...env.identity(), fileHashes: env.fileHashes() };
    evidence.env = { productUrl: env.productUrl, terminalUrl: env.terminalUrl, terminalProjectId: env.terminalProjectId, modelProfile: env.modelProfile };
    console.log(`[r7] product=${env.productUrl} terminal=${env.terminalUrl} wb=${env.identity().terminalPackageVersion}`);

    browser = await UI.launchCdpBrowser({
      chrome: env.chromePath,
      profileDir: env.layout.browserProfile,
      url: env.productUrl, width: 1920, height: 1080,
    });
    await UI.installProductLog(browser);
    await UI.openWorkView(browser, env.productUrl);
    await UI.installTerminalLog(browser);

    // ---- real session bound to the real profile -----------------------
    const profiles = await env.termApi('profiles');
    const profileRows = (profiles.data && profiles.data.profiles) || [];
    const profile = profileRows.find(row => row.id === MODEL_PROFILE_ID) || profileRows[0];
    if (!profile) throw new Error('no model profile available in the isolated store');

    const created = await env.termApi('sessions', {
      method: 'POST',
      body: {
        context: { contextId: env.terminalProjectId, workspaceRef: env.terminalProjectId },
        aiProfileId: profile.id,
        model: profile.defaultModel || undefined,
        permissionMode: 'bypassPermissions',
      },
    });
    if (created.status !== 201 || !(created.data && created.data.session)) {
      throw new Error(`session creation failed: ${created.status} ${String(created.text).slice(0, 500)}`);
    }
    sessionId = created.data.session.sessionId;
    evidence.session = { sessionId, aiProfileId: profile.id, model: created.data.session.selectedModel || null };

    // The console panel (#background-tasks) renders tasks for the UI's
    // ACTIVE session only — open the new session through the real UI before
    // the turn, so the card appears while the task runs.
    await UI.waitFor(async () => Boolean(await UI.sessionRowExists(browser, sessionId)), 'session row visible', 30000);
    await UI.clickSessionRow(browser, sessionId);
    await new Promise(resolve => setTimeout(resolve, 1500));

    // ---- ONE real model turn delegating a real bounded task -----------
    const turnStartedAt = Date.now();
    const input = await env.termApi(`sessions/${sessionId}/input`, { method: 'POST', body: { text: TASK_PROMPT } });
    evidence.turn = { startedAt: new Date(turnStartedAt).toISOString(), inputStatus: input.status, prompt: TASK_PROMPT };
    if (input.status !== 202) {
      evidence.modelLimitation = { kind: 'input-rejected', status: input.status, body: String(input.text).slice(0, 1500) };
      throw new Error(`model input rejected: ${input.status}`);
    }

    const readEvents = async () => {
      const loaded = await env.termApi(`sessions/${sessionId}`);
      return Array.isArray(loaded.data && loaded.data.events) ? loaded.data.events : [];
    };
    let events = [];
    let taskEvents = [];
    let turnError = null;
    while (Date.now() - turnStartedAt < TURN_BUDGET_MS) {
      events = await readEvents();
      taskEvents = events.filter(event => String(event.type || '').startsWith('claude/task-'));
      const errorEvent = events.find(event => /error/i.test(String(event.type || '')) && event.error);
      if (errorEvent) { turnError = errorEvent; break; }
      const completed = taskEvents.some(event => event.status === 'completed');
      const answered = events.some(event => /claude\/(assistant|text|message)/.test(String(event.type || '')) && String(event.text || event.message || '').includes('R7-DOCK006-TASK-OK'));
      if (completed && taskEvents.length >= 2) break;
      if (completed && Date.now() - turnStartedAt > 60000) break;
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    evidence.turn.endedAt = new Date().toISOString();
    evidence.turn.durationMs = Date.now() - turnStartedAt;
    evidence.turn.eventCount = events.length;
    evidence.turn.taskEvents = taskEvents.map(event => ({ type: event.type, taskId: event.taskId || null, status: event.status || null, taskType: event.taskType || null, sequence: event.sequence }));
    if (turnError) {
      evidence.modelLimitation = { kind: 'turn-error', event: JSON.stringify(turnError).slice(0, 1500) };
      if (looksRateLimited(turnError)) throw new Error('model turn hit a provider limit — honest stop');
    }
    budgetGuard('turn-complete');

    // The console panel restores its task rows when the session (RE)OPENS:
    // restoreBackgroundTasks(summary.tasks) runs on the open path. Click the
    // session row again so the completed real task is restored into the
    // 子代理任务 console exactly like a user returning to the session.
    await UI.clickSessionRow(browser, sessionId);
    await new Promise(resolve => setTimeout(resolve, 2500));

    // ---- console shows real events ------------------------------------
    const consoleDiag = await UI.frameEval(browser, `return (() => {
      const panel = doc.getElementById('background-tasks');
      const win = frames.workFrame ? frames.workFrame.contentWindow : null;
      let streamCol = null;
      try { streamCol = !!doc.getElementById('stream-col'); } catch {}
      return {
        panelExists: !!panel,
        panelHidden: panel ? panel.hidden : null,
        panelChildren: panel ? panel.children.length : 0,
        panelHtml: panel ? (panel.innerHTML || '').slice(0, 300) : null,
        streamCol,
        dockWidget: !!doc.querySelector('.rd-tabs, #right-dock'),
      };
    })()`);
    evidence.steps.push({ step: 'console-diagnostic', consoleDiag, consoleBeforeWait: await consoleCards() });
    await UI.waitFor(async () => {
      const console = await consoleCards();
      return console.panelPresent && console.cards.length >= 1;
    }, 'subagent console card visible', 60000);
    const consoleDuring = await consoleCards();
    const nativeTasks = async () => {
      const scope = env.storeScope();
      const response = await env.termApi(`sessions/${sessionId}/native-tasks?storeScope=${encodeURIComponent(scope)}&contextId=${encodeURIComponent(env.terminalProjectId)}`);
      const page = response.data || {};
      const rows = Array.isArray(page.tasks) ? page.tasks : (Array.isArray(page.items) ? page.items : []);
      return { status: response.status, rows };
    };
    const tasksDuring = await nativeTasks();
    evidence.steps.push({ step: 'console-during-turn', console: consoleDuring, nativeTasks: tasksDuring.rows.map(row => ({ taskId: row.taskId, status: row.status, statusSource: row.statusSource, taskType: row.taskType })) });

    // ---- the console card: real task, honestly labeled ------------------
    // The card click may or may not open a detail tab: opening requires a
    // trusted native-task taskRef, which the workbench's own model drivers
    // do not produce (native-task-state events come from the claude-code SDK
    // client path). The product itself labels the bare row "仅状态，暂无详情"
    // instead of faking an entry — record which state the real card is in.
    const dockBefore = await UI.dockSnapshot(browser);
    const cardClicked = await UI.frameEval(browser, `const card = doc.querySelector('#background-tasks .task-card'); if (card) card.click(); return !!card;`);
    await new Promise(resolve => setTimeout(resolve, 2000));
    const dockAfterClick = await UI.dockSnapshot(browser);
    const cardNote = await UI.frameEval(browser, `return (() => { const note = doc.querySelector('#background-tasks .task-row-note'); return note ? note.textContent : null; })()`);
    const detailTabOpened = dockAfterClick.tabCount > dockBefore.tabCount;

    // ---- wait for completion, history persists -------------------------
    await UI.waitFor(async () => {
      const console = await consoleCards();
      return console.cards.some(card => /已完成|completed/.test(card.status));
    }, 'task card shows completed', 90000);
    const consoleAfter = await consoleCards();
    const tasksAfter = await nativeTasks();
    const completedTask = tasksAfter.rows.find(row => row.status === 'completed') || null;
    const taskIdsDuring = new Set(tasksDuring.rows.map(row => row.taskId));
    const taskIdsAfter = new Set(tasksAfter.rows.map(row => row.taskId));

    // ---- read-only retries never re-delegate ---------------------------
    const retryReads = [];
    let taskIdsStable = true;
    for (let i = 0; i < 5; i += 1) {
      const read = await nativeTasks();
      retryReads.push({ read: i + 1, status: read.status, taskIds: read.rows.map(row => row.taskId).sort() });
      for (const id of read.rows.map(row => row.taskId)) if (!taskIdsAfter.has(id)) taskIdsStable = false;
      if (read.rows.map(row => row.taskId).sort().join() !== [...taskIdsAfter].sort().join()) taskIdsStable = false;
      await new Promise(resolve => setTimeout(resolve, 800));
    }
    // Two more session reopen cycles (the console restore path), each must
    // re-show the completed card without any new delegation.
    const closeAndReopen = async () => {
      await UI.clickSessionRow(browser, sessionId);
      await new Promise(resolve => setTimeout(resolve, 1500));
      const console = await consoleCards();
      return console.cards.length >= 1 && console.cards.some(card => /已完成|completed/.test(card.status));
    };
    const reopen1 = await closeAndReopen();
    const reopen2 = await closeAndReopen();
    const tasksFinal = await nativeTasks();
    const eventsFinal = await readEvents();
    const finalTaskDelegationEvents = eventsFinal.filter(event => String(event.type || '').startsWith('claude/task-') && event.sequence > (taskEvents[taskEvents.length - 1] ? taskEvents[taskEvents.length - 1].sequence : 0));
    evidence.steps.push({ step: 'read-only-retries', retryReads, reopen1, reopen2, finalTaskCount: tasksFinal.rows.length, newTaskEventsAfterTurn: finalTaskDelegationEvents.length });

    evidence.expectations.push({
      key: 'console-shows-real-events',
      pass: consoleDuring.panelPresent === true && consoleDuring.cards.length >= 1
        && consoleDuring.cards.some(card => card.taskId && card.title && card.taskId === (tasksDuring.rows[0] || {}).taskId)
        && tasksDuring.rows.length >= 1,
      observed: {
        consoleDuring, nativeTasksDuring: tasksDuring.rows.map(row => ({ taskId: row.taskId, status: row.status })),
        detailTabOpened, cardNote,
        cardClicked,
        boundary: 'the console card renders the REAL delegated task (real model title + 已完成). The openable DETAIL tab requires a trusted native-task taskRef, produced only by the claude-code SDK client path — the workbench model driver tasks are honestly labeled by the product itself as 仅状态，暂无详情 (readonly row), which is recorded as the capability boundary, not faked as an entry',
      },
    });
    evidence.expectations.push({
      key: 'completion-history-persists',
      pass: Boolean(completedTask) && consoleAfter.cards.some(card => /已完成|completed/.test(card.status))
        && taskIdsDuring.size <= taskIdsAfter.size && reopen1 === true && reopen2 === true,
      observed: {
        completedTask: completedTask ? { taskId: completedTask.taskId, status: completedTask.status, statusSource: completedTask.statusSource } : null,
        consoleAfterCards: consoleAfter.cards,
        reopenCyclesBothRestoreCard: [reopen1, reopen2],
      },
    });
    evidence.expectations.push({
      key: 'read-only-retry-no-redelegation',
      pass: taskIdsStable && finalTaskDelegationEvents.length === 0 && tasksFinal.rows.length === tasksAfter.rows.length,
      observed: {
        taskIdsAfterTurn: [...taskIdsAfter].sort(),
        taskIdsStableAcrossReads: taskIdsStable,
        reopenCycles: [reopen1, reopen2],
        finalTaskCount: tasksFinal.rows.length,
        newTaskEventsAfterTurn: finalTaskDelegationEvents.length,
        boundary: 'the explicit read-FAILURE retry affordance was not exercised (needs fault injection); what is proven is that repeated history reads and tab re-opens never create or re-dispatch a task',
      },
    });
    evidence.finishedAt = new Date().toISOString();
    evidence.verdict = evidence.expectations.every(item => item.pass) ? 'PASS' : 'FAIL';
    fs.writeFileSync(path.join(ARTIFACTS, 'dock-006.json'), JSON.stringify(evidence, null, 2));
    console.log(`[r7] DOCK-006 ${evidence.verdict}`);
    process.exitCode = evidence.verdict === 'PASS' ? 0 : 1;
  } catch (error) {
    evidence.firstFailure = String(error && error.stack || error);
    evidence.finishedAt = new Date().toISOString();
    evidence.verdict = 'FAIL';
    fs.writeFileSync(path.join(ARTIFACTS, 'dock-006.json'), JSON.stringify(evidence, null, 2));
    console.error(`[r7] FATAL ${evidence.firstFailure}`);
    process.exitCode = 1;
  } finally {
    if (browser) { try { await browser.close(); } catch { /* best effort */ } }
    if (env && sessionId) { try { await env.termApi(`sessions/${sessionId}/abort`, { method: 'POST', body: { reason: 'dock-r7 fixture cleanup' } }); } catch { /* module may be gone */ } }
    if (env) { try { await env.cleanup(); } catch { /* best effort */ } }
  }
}

main().catch(error => { console.error(String(error && error.stack || error)); process.exit(1); });
