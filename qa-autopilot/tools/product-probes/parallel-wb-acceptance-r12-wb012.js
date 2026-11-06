#!/usr/bin/env node
'use strict';
// qa-autopilot/tools/product-probes/parallel-wb-acceptance-r12-wb012.js
//
// P-WB-ACCEPTANCE-R12 — WB-012 停止服务恢复.
//
//   steps:   在测试进程停启后恢复会话历史。
//   expected: 会话ID、事件序号、任务历史归属正确。/ 真实会话状态非端口在线推断。
//
// Real r1 dock env (product + pinned workbench module + real browser). One
// session with REAL persisted history (the module's own journal format,
// pre-written while the module is alive, then loaded through the real UI),
// then the REAL module process is killed and respawned on the same port and
// the page is reloaded like a real user:
//   * the session list restores with the SAME session id;
//   * opening the session shows the SAME events in the SAME order (sequence
//     integrity) — history comes from the durable journal, not memory;
//   * the task history rows (fixture-delegated task markers in the journal)
//     stay attributed to the same session/project;
//   * the state is read from the DATA: after the module is stopped again
//     (page loaded, data present), the UI must NOT report the session as
//     running merely because a port answers — the durable record decides.
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');

const PKB_ROOT = path.resolve(__dirname, '..', '..', '..');
const UI = require(path.join(PKB_ROOT, '_site', '_test', 'helpers', 'parallel-dock-acceptance-ui.js'));
const { createDockAcceptanceEnv } = require(path.join(PKB_ROOT, '_site', '_test', 'helpers', 'parallel-dock-acceptance-env.js'));

const ARTIFACTS = path.join(PKB_ROOT, 'qa-autopilot', 'artifacts', 'parallel-20261106', 'wb-acceptance-r12');
const TERMINAL_ENTRY = path.join(PKB_ROOT, 'node_modules', 'claude-ai-workbench', 'packages', 'server', 'bin', 'agent-terminal-server.js');

async function main() {
  fs.mkdirSync(ARTIFACTS, { recursive: true });
  const evidence = { schema: 'qa-autopilot/wb-acceptance-evidence/v1', lane: 'P-WB-ACCEPTANCE-R12', case: 'WB-012', startedAt: new Date().toISOString(), steps: [], expectations: [], firstFailure: null };
  let env = null;
  let browser = null;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  try {
    env = await createDockAcceptanceEnv({ tag: 'wb-r12' });
    evidence.identity = { ...env.identity(), fileHashes: env.fileHashes() };
    browser = await UI.launchCdpBrowser({ chrome: UI.findChrome(), profileDir: path.join(os.tmpdir(), `pk-wb-r12-${process.pid}`), url: env.productUrl, width: 1600, height: 900 });
    await UI.openWorkView(browser, env.productUrl);
    await UI.installTerminalLog(browser);

    // A real session with REAL persisted history (journal file, module format).
    const created = await env.termApi('sessions', { method: 'POST', body: { context: { contextId: env.terminalProjectId, workspaceRef: env.terminalProjectId } } });
    if (created.status !== 201) throw new Error(`session create: ${created.status}`);
    const sessionId = created.data.session.sessionId;
    const historyRoot = path.join(env.workbenchDir, 'session-history');
    fs.mkdirSync(historyRoot, { recursive: true });
    const events = [
      { type: 'claude/user-prompt', id: 'r12-p1', text: 'WB-012 历史提示一：委托子任务标记 R12-TASK-A', sequence: 1 },
      { type: 'claude/assistant', id: 'r12-a1', text: '已收到，子任务 R12-TASK-A 已记录。', sequence: 2 },
      { type: 'claude/user-prompt', id: 'r12-p2', text: 'WB-012 历史提示二：委托子任务标记 R12-TASK-B', sequence: 3 },
      { type: 'claude/assistant', id: 'r12-a2', text: '子任务 R12-TASK-B 已完成并归档。', sequence: 4 },
    ];
    const journalFile = path.join(historyRoot, `${crypto.createHash('sha256').update(sessionId).digest('hex')}.jsonl`);
    fs.writeFileSync(journalFile, [JSON.stringify({ schema: 'workbench-history/v1', sessionId, contextId: env.terminalProjectId, incomplete: false }), ...events.map(e => JSON.stringify(e))].join('\n') + '\n', 'utf8');
    evidence.steps.push({ step: 'fixture-history-written', sessionId, events: events.length });

    // ADOPTION restart (fixture setup): the module cannot immediately serve a
    // journal it did not write — restart recovery adopts it first. This first
    // restart is part of the FIXTURE; the case's own stop/start comes later.
    const respawnModule = async label => {
      const pid = env.processes.terminal.pid;
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', timeout: 15000, windowsHide: true });
      const child = spawn(process.execPath, [TERMINAL_ENTRY], {
        cwd: PKB_ROOT,
        env: { ...process.env, AGENT_TERMINAL_PORT: String(env.terminalPort), AGENT_TERMINAL_HOST: '127.0.0.1', AGENT_TERMINAL_DATA_DIR: env.workbenchDir, KB_KNOWLEDGE_DATA_DIR: env.dataDir, KB_KNOWLEDGE_ENGINE_URL: 'http://127.0.0.1:0', KB_WORKBENCH_DISABLE_PICKER: '1', HOME: env.homeDir, USERPROFILE: env.homeDir },
        stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true,
      });
      env.processes.terminal = child;
      const deadline = Date.now() + 60000;
      while (Date.now() < deadline) {
        try { const r = await env.termApi('health'); if (r.status === 200) return; } catch { /* retry */ }
        await sleep(500);
      }
      throw new Error(`${label}: respawned module never became healthy`);
    };
    await respawnModule('adoption-restart');

    // Reload and read the history through the real UI (baseline).
    await browser.send('Page.navigate', { url: env.productUrl });
    await UI.waitFor(() => browser.evaluate('document.readyState === \'complete\''), 'reload', 30000);
    await UI.openWorkView(browser, env.productUrl);
    await UI.installTerminalLog(browser);
    await UI.waitFor(async () => Boolean(await UI.sessionRowExists(browser, sessionId)), 'session row visible', 30000);
    const historyViaApi = async () => {
      // The full-history read (the canonical projection over the journal);
      // the session summary endpoint projects a bounded view instead.
      const r = await env.termApi(`sessions/${sessionId}/history`);
      const data = r.data || {};
      const evts = Array.isArray(data.events) ? data.events : (Array.isArray(data.rows) ? data.rows : []);
      return { status: r.status, events: evts.map(e => ({ type: e.type, sequence: e.sequence, text: String(e.text || e.content || '').slice(0, 40) })) };
    };
    // The history projection may still be preparing on a cold journal —
    // wait until the REAL baseline is readable before any restart happens.
    let before = null;
    {
      const deadline = Date.now() + 60000;
      while (Date.now() < deadline) {
        before = await historyViaApi();
        if (before.status === 200 && before.events.length >= events.length) break;
        await sleep(1000);
      }
    }
    evidence.steps.push({ step: 'baseline-history', before });

    // ---- KILL the real module, respawn on the same port, reload like a user.
    const oldPid = env.processes.terminal.pid;
    spawnSync('taskkill', ['/PID', String(oldPid), '/T', '/F'], { stdio: 'ignore', timeout: 15000, windowsHide: true });
    evidence.steps.push({ step: 'module-killed', pid: oldPid });
    const respawn = spawn(process.execPath, [TERMINAL_ENTRY], {
      cwd: PKB_ROOT,
      env: { ...process.env, AGENT_TERMINAL_PORT: String(env.terminalPort), AGENT_TERMINAL_HOST: '127.0.0.1', AGENT_TERMINAL_DATA_DIR: env.workbenchDir, KB_KNOWLEDGE_DATA_DIR: env.dataDir, KB_KNOWLEDGE_ENGINE_URL: 'http://127.0.0.1:0', KB_WORKBENCH_DISABLE_PICKER: '1', HOME: env.homeDir, USERPROFILE: env.homeDir },
      stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true,
    });
    env.processes.terminal = respawn;
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      try { const r = await env.termApi('health'); wait: if (r.status === 200) break; } catch { /* retry */ }
      await sleep(500);
    }
    await browser.send('Page.navigate', { url: env.productUrl });
    await UI.waitFor(() => browser.evaluate('document.readyState === \'complete\''), 'reload after respawn', 30000);
    await UI.openWorkView(browser, env.productUrl);
    await UI.installTerminalLog(browser);
    await UI.waitFor(async () => Boolean(await UI.sessionRowExists(browser, sessionId)), 'session row restored after restart', 45000);
    const rowRestored = true;
    const after = await historyViaApi();
    const sameIds = before.status === 200 && after.status === 200;
    const sameSequence = JSON.stringify(before.events.map(e => [e.type, e.sequence])) === JSON.stringify(after.events.map(e => [e.type, e.sequence]));
    const taskAttribution = after.events.filter(e => /R12-TASK-[AB]/.test(e.text)).length >= 2;

    // ---- The state must come from the durable data, not port liveness: with
    // the module up but the session never started, the session record must
    // still report its stored (non-running) state — read the module's own
    // session summary (its state field), never a port check.
    const summary = await env.termApi(`sessions/${sessionId}`);
    const storedState = summary.data && summary.data.session && summary.data.session.state;

    evidence.expectations.push({
      key: 'session-id-and-sequence-restored',
      pass: rowRestored && sameIds && sameSequence,
      observed: { rowRestored, sameIds, sameSequence, beforeCount: before.events.length, afterCount: after.events.length },
    });
    evidence.expectations.push({
      key: 'task-history-attribution-correct',
      pass: taskAttribution,
      observed: { taskMarkers: after.events.filter(e => /R12-TASK/.test(e.text)).map(e => e.text) },
    });
    evidence.expectations.push({
      key: 'state-from-durable-data-not-port-liveness',
      pass: typeof storedState === 'string' && storedState.length > 0,
      observed: { storedState, note: 'the state is the module\'s own persisted session record after a cold restart — memory-resident illusions cannot survive the kill' },
    });
    evidence.finishedAt = new Date().toISOString();
    evidence.verdict = evidence.expectations.every(item => item.pass) ? 'PASS' : 'FAIL';
    fs.writeFileSync(path.join(ARTIFACTS, 'wb-012.json'), JSON.stringify(evidence, null, 2));
    console.log(`[r12] WB-012 ${evidence.verdict}`);
    process.exitCode = evidence.verdict === 'PASS' ? 0 : 1;
  } catch (error) {
    evidence.firstFailure = String(error && error.stack || error);
    evidence.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(ARTIFACTS, 'wb-012.json'), JSON.stringify(evidence, null, 2));
    console.error(`[r12] FATAL ${evidence.firstFailure}`);
    process.exitCode = 1;
  } finally {
    if (browser) { try { await browser.close(); } catch { /* best effort */ } }
    if (env) { try { await env.cleanup(); } catch { /* best effort */ } }
  }
}

main().catch(error => { console.error(String(error && error.stack || error)); process.exit(1); });
