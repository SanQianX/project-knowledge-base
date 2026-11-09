#!/usr/bin/env node
'use strict';
// qa-autopilot/tools/product-probes/parallel-wb-acceptance-r18-wb011.js
//
// P-WB-ACCEPTANCE-R18 — WB-011 主回复与后台 (user-approved real model turn).
//
//   steps:   主回复结束但两个子任务仍运行时继续输入。
//   expected: 按当前合同主输入可用。/ 后台卡片仍真实运行，不能仅从文字猜启动。
//
// r3 isolation launcher (real minimax profile read-only, secret via pipe).
// ONE real turn that starts TWO long background tasks and answers; while the
// tasks still run:
//   * the main input is ENABLED again (the contract: input reopens after the
//     main reply ends, independent of background tasks);
//   * the 子代理任务 console shows the tasks as 运行中 with REAL taskIds
//     from the module's native-task records (verified against the API, not
//     guessed from text); after they finish the cards settle to 已完成.
// A second input is then typed (kept as a draft — proving input usability
// without spending another model call).

const fs = require('node:fs');
const path = require('node:path');

const PKB_ROOT = path.resolve(__dirname, '..', '..', '..');
const UI = require(path.join(PKB_ROOT, '_site', '_test', 'helpers', 'parallel-dock-isolation-r3-ui.js'));
const { createDockIsolationEnv } = require(path.join(PKB_ROOT, '_site', '_test', 'helpers', 'parallel-dock-isolation-r3-env.js'));

const ARTIFACTS = process.env.PK_R18_ARTIFACTS || path.join(PKB_ROOT, 'qa-autopilot', 'artifacts', 'parallel-20261106', 'wb-acceptance-r18');
const MODEL_PROFILE_ID = process.env.R18_MODEL_PROFILE || 'minimax';
const TURN_BUDGET_MS = Number(process.env.R18_TURN_BUDGET_MS || 8 * 60 * 1000);

const TASK_PROMPT = [
  '请执行这一组真实任务（不要修改仓库任何文件）：',
  '1) 用 Bash 工具在后台（run_in_background）运行：',
  '   node -e "setTimeout(()=>{console.log(\'R18-TASK-ONE-OK\')},25000)"',
  '2) 再用 Bash 工具在后台（run_in_background）运行另一条：',
  '   node -e "setTimeout(()=>{console.log(\'R18-TASK-TWO-OK\')},31000)"',
  '3) 两个后台任务都启动后，立刻回答我一句话：「两个后台任务已启动」，不要等待它们结束。',
].join('\n');

function looksRateLimited(payload) {
  const text = JSON.stringify(payload || '').toLowerCase();
  return /rate[_\s-]?limit|\b429\b|2067|too many requests|quota|insufficient balance|余额不足|限流/.test(text);
}

async function main() {
  fs.mkdirSync(ARTIFACTS, { recursive: true });
  const evidence = { schema: 'qa-autopilot/wb-acceptance-evidence/v1', lane: 'P-WB-ACCEPTANCE-R18', case: 'WB-011', startedAt: new Date().toISOString(), steps: [], expectations: [], firstFailure: null, modelLimitation: null };
  let env = null;
  let browser = null;
  let sessionId = null;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const consoleCards = () => UI.frameEval(browser, `return (() => {
    const panel = doc.getElementById('background-tasks');
    if (!panel) return { panelPresent: false, cards: [] };
    return { panelPresent: true, hidden: panel.hidden === true, cards: Array.from(panel.querySelectorAll('.task-card')).map(card => ({
      taskId: card.dataset.taskId || '', status: (card.querySelector('.task-row-status') || { textContent: '' }).textContent || '',
    })) };
  })()`);
  try {
    const HANDOFF_FILE = process.env.PK_R3_HANDOFF || null;
    if (!HANDOFF_FILE) throw new Error('this probe only runs through parallel-dock-isolation-r3-launch.js');
    const handoff = JSON.parse(fs.readFileSync(HANDOFF_FILE, 'utf8'));
    env = await createDockIsolationEnv({ tag: 'wb-r18', handoff });
    evidence.identity = { ...env.identity(), fileHashes: env.fileHashes() };
    browser = await UI.launchCdpBrowser({ chrome: env.chromePath, profileDir: env.layout.browserProfile, url: env.productUrl, width: 1920, height: 1080 });
    await UI.installProductLog(browser);
    await UI.openWorkView(browser, env.productUrl);
    await UI.installTerminalLog(browser);

    const profiles = await env.termApi('profiles');
    const profileRows = (profiles.data && profiles.data.profiles) || [];
    const profile = profileRows.find(row => row.id === MODEL_PROFILE_ID) || profileRows[0];
    if (!profile) throw new Error('no model profile available');
    const created = await env.termApi('sessions', { method: 'POST', body: { context: { contextId: env.terminalProjectId, workspaceRef: env.terminalProjectId }, aiProfileId: profile.id, model: profile.defaultModel || undefined, permissionMode: 'bypassPermissions' } });
    if (created.status !== 201) throw new Error(`session create ${created.status}`);
    sessionId = created.data.session.sessionId;
    await UI.waitFor(async () => Boolean(await UI.sessionRowExists(browser, sessionId)), 'session row', 30000);
    await UI.clickSessionRow(browser, sessionId);
    await sleep(1500);

    // The ONE real model turn: two background tasks + an immediate reply.
    const turnStartedAt = Date.now();
    const input = await env.termApi(`sessions/${sessionId}/input`, { method: 'POST', body: { text: TASK_PROMPT } });
    if (input.status !== 202) { evidence.modelLimitation = { kind: 'input-rejected', status: input.status }; throw new Error('input rejected'); }

    const readEvents = async () => { const r = await env.termApi(`sessions/${sessionId}`); return (r.data && r.data.events) || []; };
    const nativeTasks = async () => {
      const scope = env.storeScope();
      const r = await env.termApi(`sessions/${sessionId}/native-tasks?storeScope=${encodeURIComponent(scope)}&contextId=${encodeURIComponent(env.terminalProjectId)}`);
      const page = r.data || {};
      return (Array.isArray(page.tasks) ? page.tasks : page.items || []);
    };
    const inputState = () => browser.evaluate(`(() => { const doc = document.getElementById('workFrame').contentDocument; const input = doc.getElementById('chat-input'); return input ? { disabled: input.disabled, value: input.value } : null; })()`);

    // Phase 1: wait until the main reply ended while tasks still run.
    let replyEnded = false, runningCards = [], apiRunning = [];
    const phaseDeadline = Date.now() + TURN_BUDGET_MS;
    while (Date.now() < phaseDeadline) {
      const events = await readEvents();
      const assistant = [...events].reverse().find(e => /claude\/(assistant|text)/.test(String(e.type || '')));
      const tasks = await nativeTasks();
      const running = tasks.filter(t => t.status === 'running' || t.status === 'pending');
      if (assistant && running.length >= 2) {
        // The reply exists AND both tasks are still running — the exact WB-011 moment.
        const state = await inputState();
        const cards = await consoleCards();
        if (!state.disabled) {
          replyEnded = true;
          // The console renders task cards from REAL records on session
          // (re)open — the r7-proven restore path (live taskViews need the
          // claude-code SDK; the workbench driver restores from summary.tasks).
          await UI.clickSessionRow(browser, sessionId);
          await sleep(2500);
          const restored = await consoleCards();
          runningCards = restored.cards.filter(c => /运行中|待执行/.test(c.status));
          cards.cards = restored.cards;
          apiRunning = running.map(t => ({ taskId: t.taskId, status: t.status, taskType: t.taskType }));
          evidence.steps.push({ step: 'wb011-moment', inputState: state, cards: cards.cards, apiRunning });
          break;
        }
      }
      await sleep(2000);
    }

    // The card states must come from REAL records: every card taskId exists
    // in the module's native-task API rows.
    const apiIds = new Set(apiRunning.map(t => t.taskId));
    const cardsBackedByRealTasks = runningCards.length >= 2 && runningCards.every(c => c.taskId && apiIds.has(c.taskId));

    // Type into the reopened input (usable, kept as draft — no extra call).
    const typed = await browser.evaluate(`(() => { const doc = document.getElementById('workFrame').contentDocument; const input = doc.getElementById('chat-input'); if (!input || input.disabled) return false; input.value = 'R18-SECOND-INPUT 输入可用验证'; input.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);

    // Phase 2: wait for both tasks to complete; the cards settle to 已完成.
    let completed = false, finalCards = [];
    const completeDeadline = Date.now() + 120000;
    while (Date.now() < completeDeadline) {
      const tasks = await nativeTasks();
      if (tasks.length >= 2 && tasks.every(t => t.status === 'completed')) {
        await UI.clickSessionRow(browser, sessionId);
        await sleep(2500);
        const cards = await consoleCards();
        finalCards = cards.cards;
        completed = cards.cards.filter(c => /已完成/.test(c.status)).length >= 2;
        break;
      }
      await sleep(3000);
    }

    evidence.expectations.push({
      key: 'main-input-usable-while-background-runs',
      pass: replyEnded && typed === true,
      observed: { replyEnded, typed },
    });
    evidence.expectations.push({
      key: 'background-cards-real-running',
      pass: cardsBackedByRealTasks,
      observed: { runningCards, apiRunning, note: 'every 运行中 card carries a taskId that exists in the module native-task records — never guessed from text' },
    });
    evidence.expectations.push({
      key: 'cards-settle-completed',
      pass: completed,
      observed: { finalCards },
    });
    evidence.turn = { durationMs: Date.now() - turnStartedAt };
    evidence.finishedAt = new Date().toISOString();
    evidence.verdict = evidence.expectations.every(item => item.pass) ? 'PASS' : 'FAIL';
    fs.writeFileSync(path.join(ARTIFACTS, 'wb-011.json'), JSON.stringify(evidence, null, 2));
    console.log(`[r18] WB-011 ${evidence.verdict}`);
    process.exitCode = evidence.verdict === 'PASS' ? 0 : 1;
  } catch (error) {
    if (looksRateLimited(error)) evidence.modelLimitation = { kind: 'provider-limit', error: String(error.message).slice(0, 200) };
    evidence.firstFailure = String(error && error.stack || error);
    evidence.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(ARTIFACTS, 'wb-011.json'), JSON.stringify(evidence, null, 2));
    console.error(`[r18] FATAL ${evidence.firstFailure}`);
    process.exitCode = 1;
  } finally {
    if (browser) { try { await browser.close(); } catch { /* best effort */ } }
    if (env && sessionId) { try { await env.termApi(`sessions/${sessionId}/abort`, { method: 'POST', body: { reason: 'wb-r18 cleanup' } }); } catch { /* gone */ } }
    if (env) { try { await env.cleanup(); } catch { /* best effort */ } }
  }
}

main().catch(error => { console.error(String(error && error.stack || error)); process.exit(1); });
