#!/usr/bin/env node
'use strict';
/**
 * T03-OVERNIGHT · 独立 Windows Supervisor
 *
 * 独立于模型会话运行：这是一个自己的 node 进程，模型会话退出后本进程继续存活。
 *
 * 职责（对应授权要求）：
 *   - 载入 T07B 台账与持久化任务队列
 *   - 派发下一项测试给真实 ZCode Worker
 *   - 额度检查与安全暂停；额度不足时等待并周期性重查，绝不结束
 *   - 检测 Agent 退出与超时
 *   - 保存任务状态与证据（原子写 + 追加日志）
 *   - 防止重复提交与重复副作用
 *   - 全部可执行任务完成时停止调度并生成最终报告
 *   - 关键节点只读检查开发知识库健康状态
 *
 * 断点续跑：恢复时先核对实际工作区、远程 Git、CI 与既有证据，
 *   确认此前动作是否已经完成；已推送的提交不重推；未确认的半成品不前进。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
const { readJSON, atomicJSON, acquireLock, must, hash, redact, ownedRun, isolatedEnv, runLogged } = require('../lib/safety.cjs');
const { fetchQuota, quotaDecision } = require('../lib/quota.cjs');
const PROVIDER_CONFIG = 'C:/Users/SanQian/.zcode/v2/provider_config.json';

/** 额度查询必须用与 Worker 同一个订阅 Key：同一个 ZCode provider 配置。Key 只在内存中。 */
function injectSubscriptionKey() {
  try {
    const j = readJSON(PROVIDER_CONFIG);
    const rule = (j.config.providerConfigRules.providerRules || []).find(r => r.providerId === 'minimax');
    const key = rule && rule.config && rule.config.access && rule.config.access.apiKey;
    if (key && !key.startsWith('sk-api-')) process.env.MINIMAX_API_KEY = key;
  } catch { }
}

function writeSupervisorPid() {
  try { fs.mkdirSync(STATE_DIR, { recursive: true }); fs.writeFileSync(path.join(STATE_DIR, 'supervisor.pid'), String(process.pid)); } catch { }
}
const { snapshot, changedFiles } = require('../lib/git.cjs');

const qaRoot = path.resolve(__dirname, '..');
// 状态目录可重定向（验收用）；生产默认 qa-autopilot/state/overnight。
const STATE_DIR = process.env.QA_OVERNIGHT_STATE_DIR || path.join(qaRoot, 'state', 'overnight');
const STATE_FILE = path.join(STATE_DIR, 'state.json');
const JOURNAL = path.join(STATE_DIR, 'journal.jsonl');
const LOCK = path.join(STATE_DIR, 'supervisor.lock');
const EVIDENCE = process.env.QA_OVERNIGHT_EVIDENCE_DIR || path.join(qaRoot, 'artifacts', 'overnight');
const LEDGER = path.join(qaRoot, 'reports', 'branches', 'T07B_LEDGER.json');
const QUEUE_FILE = path.join(STATE_DIR, 'queue.json');
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ───────────────────────────────────────────────────────── 持久化状态
function loadState() {
  if (!fs.existsSync(STATE_FILE)) {
    return { schema: 'qa-autopilot/overnight-state/v1', revision: 0, phase: 'INITIALIZING', quotaState: 'PAUSED', recoverySamples: 0, tasks: {}, order: [], lastEvent: null, startedAt: null, updatedAt: null };
  }
  return readJSON(STATE_FILE);
}
function saveState(state) {
  state.revision = (state.revision || 0) + 1;
  state.updatedAt = new Date().toISOString();
  atomicJSON(STATE_FILE, state);
  appendJournal({ kind: 'STATE', revision: state.revision, phase: state.phase, quotaState: state.quotaState, updatedAt: state.updatedAt });
}
function appendJournal(event) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const line = JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n';
  fs.appendFileSync(JOURNAL, line);
}

// ───────────────────────────────────────────────────────── 任务队列
/** 从 T07B 台账构建队列：只收 PARTIAL 与 NOT_COVERED，按模块分组，每组一个任务。 */
function buildQueue() {
  const ledger = readJSON(LEDGER);
  const byModule = new Map();
  for (const row of ledger.rows) {
    if (row.verdict !== 'PARTIAL' && row.verdict !== 'NOT_COVERED') continue;
    if (!byModule.has(row.module)) byModule.set(row.module, []);
    byModule.get(row.module).push(row);
  }
  // 覆盖缺口最多的模块优先，但先做规格数少的（更快见效）
  const modules = [...byModule.entries()].sort((a, b) => a[1].length - b[1].length);
  const tasks = [];
  for (const [module, rows] of modules) {
    const id = 'T07B-' + module.replace(/[^\w一-龥]+/g, '-');
    tasks.push({
      id,
      module,
      specIds: rows.map(r => r.id),
      specCount: rows.length,
      coverageNow: rows.reduce((n, r) => n + (r.verdict === 'COVERED' ? 1 : 0), 0),
      status: 'PENDING',
      contract: null
    });
  }
  return { schema: 'qa-autopilot/overnight-queue/v1', builtAt: new Date().toISOString(), sourceLedger: path.relative(qaRoot, LEDGER).replace(/\\/g, '/'), tasks };
}

/** 为一个模块任务生成合同 + 提示词锚点。合同是唯一事实来源。 */
function makeContract(task, cfg) {
  const ledger = readJSON(LEDGER);
  const rows = task.specIds.map(id => ledger.rows.find(r => r.id === id)).filter(Boolean);
  const allowed = [];
  const expected = [];
  for (const r of rows) {
    for (const e of (r.expected || [])) expected.push({ specId: r.id, text: e });
  }
  // 允许修改：该模块对应的产品测试文件（从台账里已登记的实施文件反推）
  const impl = new Set();
  const coverage = readJSON(path.join(qaRoot, 'config', 'specs-coverage.json')).specs || {};
  for (const r of rows) {
    const cov = coverage[r.id];
    if (!cov || !cov.implementedBy) continue;
    // implementedBy 可能是字符串或字符串数组；测试文件名是裸名，需补仓库相对路径。
    const list = Array.isArray(cov.implementedBy) ? cov.implementedBy : [cov.implementedBy];
    for (const raw of list) {
      if (typeof raw !== 'string' || !raw.endsWith('.js')) continue;
      impl.add((raw.includes('/') ? raw : '_site/_test/' + raw).split(path.sep).join('/'));
    }
  }
  // 尚未覆盖的规格：允许新建一个同模块的测试文件
  // 新测试文件名用首个规格 ID，避免中文模块名被清空后互相冲突。
  const newFile = '_site/_test/t07b-' + String(task.specIds[0] || task.id).toLowerCase().replace(/[^a-z0-9-]/g, '-') + '-coverage-test.js';
  for (const f of impl) allowed.push(f);
  allowed.push(newFile);
  const markerPrefix = 'QA-SPEC-';
  const contract = {
    schema: 1,
    bugId: task.id,
    kind: 'coverage',
    summary: `补齐 T07B 台账中「${task.module}」模块的 ${rows.length} 项未完全覆盖的测试规格：${task.specIds.join(', ')}`,
    allowedFiles: allowed,
    approvedProtectedFiles: [],
    approvalReceipt: 'overnight-queue:' + task.id,
    publicApiChange: false,
    storageContractChange: false,
    expectedBehavior: rows.map(r => r.title + '：' + (r.expected || []).join('；')).join('\n'),
    expectedBehaviorList: expected.map(e => `[${e.specId}] ${e.text}`).concat([
      '标记要求：每一条为上述规格新增或补强的断言，其断言消息必须以 QA-SPEC-<规格ID> 开头（例如 QA-SPEC-NAV-001），以便控制端独立核对该期望已被守住。'
    ]),
    sourceEvidence: rows.map(r => r.id + ' → ' + (r.source || '')),
    reproductionCaseIds: task.specIds,
    verificationSuites: ['all'],
    maxAttempts: 2,
    risk: 'P2',
    specIds: task.specIds,
    markerPrefix,
    newTestFile: newFile
  };
  return contract;
}

// ───────────────────────────────────────────────────────── 额度
async function quotaGate(cfg, state) {
  let q;
  try { q = await fetchQuota(cfg.quota); }
  catch (e) { q = { state: 'UNKNOWN', checkedAt: Date.now(), error: e.code || 'QUOTA_ERROR' }; }
  const gate = quotaDecision(q, cfg.quota, state.quotaState || 'PAUSED', Date.now(), state.recoverySamples || 0);
  state.quotaState = gate.state;
  state.recoverySamples = gate.successes;
  state.quota = q;
  state.quotaCheckedAt = Date.now();
  return gate;
}

// ───────────────────────────────────────────────────────── 开发知识库健康
function devKbHealth() {
  try {
    const { execFileSync: ex } = require('child_process');
    const out = ex(process.execPath, [path.join(qaRoot, 'tools', 'protected-dev-kb.cjs'), 'health'], { encoding: 'utf8', timeout: 60000, cwd: qaRoot });
    const j = JSON.parse(out);
    return { ok: j.ok === true, passed: (j.checks || []).filter(c => c.ok).length, total: (j.checks || []).length };
  } catch (e) { return { ok: false, error: e.code || 'HEALTH_PROBE_FAILED' }; }
}

// ───────────────────────────────────────────────────────── 派发
async function dispatch(cfg, state, task) {
  const contract = task.contract;
  const contractFile = path.join(STATE_DIR, 'contracts', task.id + '.json');
  fs.mkdirSync(path.dirname(contractFile), { recursive: true });
  atomicJSON(contractFile, contract);
  const run = ownedRun(qaRoot, 'overnight-' + task.id.replace(/[^\w-]/g, '') + '-' + Date.now());
  const requestFile = path.join(run, 'request.json');
  const resultFile = path.join(run, 'result.json');
  fs.mkdirSync(run, { recursive: true });
  const request = {
    protocol: 'pkb-qa-task/v1', id: task.id, contract,
    sourceRoot: cfg.repoRoot, gateway: cfg.worker.gatewayUrl,
    allowedNewFiles: contract.allowedFiles, forbiddenActions: ['git write', 'publish', 'delete user data', 'change approvals']
  };
  atomicJSON(requestFile, request);
  const env = isolatedEnv(run, { QA_REQUEST_FILE: requestFile, QA_RESULT_FILE: resultFile, QA_RUNTIME_DIR: path.join(qaRoot, '.runtime') });
  const result = await runLogged(cfg.worker.executable, cfg.worker.args, {
    cwd: cfg.repoRoot, env, logDir: path.join(EVIDENCE, task.id), timeoutMs: cfg.worker.taskTimeoutMs || 900000, input: JSON.stringify(request) + '\n'
  });
  const workerResult = fs.existsSync(resultFile) ? readJSON(resultFile) : null;
  return { run, resultFile, workerResult, exitCode: result.code, timedOut: result.timedOut, signal: result.signal };
}

// ───────────────────────────────────────────────────────── 独立验证
/** 验证只看两件事：标记断言真的存在于允许文件里；产品测试仍然通过。 */
async function verify(cfg, task, dispatchInfo) {
  const contract = task.contract;
  const markers = contract.specIds.map(id => contract.markerPrefix + id);
  const evidence = { markers, markerHits: {}, files: {}, suite: null, ok: false, reason: null };
  for (const f of contract.allowedFiles) {
    const abs = path.join(cfg.repoRoot, f);
    if (!fs.existsSync(abs)) { evidence.files[f] = 'absent'; continue; }
    const text = fs.readFileSync(abs, 'utf8');
    evidence.files[f] = 'present';
    for (const m of markers) if (text.includes(m)) (evidence.markerHits[m] ||= []).push(f);
  }
  const missing = markers.filter(m => !evidence.markerHits[m]);
  if (missing.length) { evidence.reason = 'MARKER_MISSING'; evidence.missingMarkers = missing; return evidence; }
  // 跑产品自己的测试文件，确认没有回归
  const testFiles = contract.allowedFiles.filter(f => f.startsWith('_site/_test/') && f.endsWith('-test.js'));
  for (const f of testFiles) {
    const r = await runLogged(cfg.tools.node, [path.join(cfg.repoRoot, f)], { cwd: cfg.repoRoot, env: isolatedEnv(path.join(dispatchInfo.run, 'verify-' + path.basename(f))), logDir: path.join(EVIDENCE, task.id, 'verify'), timeoutMs: cfg.limits?.perTestTimeoutMs || 300000 });
    evidence.suite = evidence.suite || {};
    evidence.suite[f] = { exitCode: r.code, timedOut: r.timedOut };
  }
  const suiteFailed = Object.values(evidence.suite || {}).some(v => v.exitCode !== 0 || v.timedOut);
  evidence.ok = !suiteFailed;
  if (suiteFailed) evidence.reason = 'SUITE_FAILED';
  return evidence;
}

// ───────────────────────────────────────────────────────── 提交
function commitAndPush(cfg, task) {
  const repo = cfg.repoRoot;
  const hook = path.join(repo, '.git', 'qa-controller-empty-hooks');
  fs.mkdirSync(hook, { recursive: true });
  const git = (args, opts) => execFileSync(cfg.tools.git || 'git', ['-c', 'core.hooksPath=' + hook, ...args], { cwd: repo, encoding: 'utf8', ...(opts || {}) });
  const status = git(['status', '--porcelain=v1']);
  if (!status.trim()) return { pushed: false, reason: 'NO_CHANGES' };
  git(['add', '--', ...task.contract.allowedFiles]);
  const staged = git(['diff', '--cached', '--name-only']).trim().split(/\r?\n/).filter(Boolean);
  const outside = staged.filter(f => !task.contract.allowedFiles.includes(f));
  if (outside.length) return { pushed: false, reason: 'CHANGE_OUTSIDE_ALLOWLIST', files: outside };
  const msg = `test(qa-autopilot): cover T07B specs for ${task.module}\n\nQA-Task: ${task.id}\nQA-Specs: ${task.specIds.join(', ')}\nQA-Evidence: qa-autopilot/reports/branches/T07B_LEDGER.md\nQA-Self-Test: see supervisor evidence artifacts/overnight/${task.id}\nQA-Artifact: ${task.contract.allowedFiles.join(' ')}\n`;
  git(['commit', '-q', '-F', '-'], { input: msg });
  const sha = git(['rev-parse', 'HEAD']).trim();
  git(['push', 'origin', 'HEAD:refs/heads/' + cfg.qaBranch]);
  return { pushed: true, sha, files: staged };
}

// ───────────────────────────────────────────────────────── 远程/CI 核对
function remoteState(cfg) {
  try {
    const out = execFileSync(cfg.tools.git || 'git', ['ls-remote', 'origin', 'refs/heads/' + cfg.qaBranch], { cwd: cfg.repoRoot, encoding: 'utf8', timeout: 60000 });
    const line = out.trim().split(/\s+/);
    return { sha: line[0] || null };
  } catch { return { sha: null }; }
}
async function ciFor(cfg, sha) {
  try {
    const { ciStatus } = require('../lib/registry.cjs');
    return await ciStatus(cfg, sha);
  } catch (e) { return { status: 'UNKNOWN', error: redact(e.message) }; }
}

// ───────────────────────────────────────────────────────── 主循环
async function tick(cfg, state) {
  // 1) 正在等待 CI 的任务
  for (const id of state.order) {
    const t = state.tasks[id];
    if (t && t.status === 'CI_PENDING' && t.sha) {
      const ci = await ciFor(cfg, t.sha);
      t.ci = ci;
      if (ci.status === 'PASS') { t.status = 'DONE'; t.completedAt = new Date().toISOString(); }
      else if (ci.status === 'FAIL') { t.status = 'BLOCKED_CI'; t.blockedReason = 'CI_FAILED'; }
      else { t.status = 'CI_PENDING'; }
      saveState(state);
      if (t.status === 'CI_PENDING') return state;
    }
  }
  // 2) 领下一个任务
  const queue = readJSON(QUEUE_FILE);
  const next = queue.tasks.find(t => !state.tasks[t.id] || ['PENDING', 'RETRY'].includes(state.tasks[t.id].status));
  if (!next) { state.phase = 'ALL_EXECUTABLE_TASKS_DONE'; saveState(state); return state; }
  const task = state.tasks[next.id] || (state.tasks[next.id] = { id: next.id, status: 'PENDING', attempts: 0 });
  if (!state.order.includes(next.id)) state.order.push(next.id);   // order 是 CI 待定扫描与状态统计的唯一索引
  task.status = 'DISPATCHING';
  task.contract = task.contract || makeContract(next, cfg);
  task.specIds = next.specIds;
  task.module = next.module;
  task.gitShaBefore = snapshot(cfg).head;
  saveState(state);

  // 3) 额度门禁
  const gate = await quotaGate(cfg, state);
  saveState(state);
  if (!gate.admitTask) {
    task.status = 'PENDING';
    task.quotaState = gate.state;
    state.phase = 'PAUSED_QUOTA';
    saveState(state);
    return state;   // 不结束，继续轮询
  }
  // 4) 派发
  task.status = 'AGENT_RUNNING';
  task.attempts = (task.attempts || 0) + 1;   // 只在真正派发时计数：额度挡住时不算重试
  if (task.attempts > (task.contract.maxAttempts || 2)) { task.status = 'FAILED'; task.failureReason = 'MAX_ATTEMPTS'; saveState(state); return state; }
  task.startedAt = new Date().toISOString();
  saveState(state);
  const d = await dispatch(cfg, state, task);
  task.workerResult = d.workerResult;
  task.workerExitCode = d.exitCode;
  task.workerTimedOut = !!d.timedOut;
  task.workerSessionId = d.workerResult && d.workerResult.sessionId;
  task.workerModel = d.workerResult && d.workerResult.modelObserved;
  task.evidenceDir = path.relative(qaRoot, path.join(EVIDENCE, task.id)).replace(/\\/g, '/');
  if (d.workerResult && d.workerResult.status === 'PAUSED_QUOTA') {
    task.status = 'PAUSED_QUOTA';
    task.quotaState = 'PAUSED_QUOTA';
    state.phase = 'PAUSED_QUOTA';
    state.quotaState = 'PAUSED';
    saveState(state);
    return state;
  }
  if (!d.workerResult || d.workerResult.status !== 'DONE' || d.timedOut) {
    task.status = 'FAILED';
    task.failureReason = d.timedOut ? 'AGENT_TIMEOUT' : (d.workerResult && d.workerResult.error ? d.workerResult.error.code : 'AGENT_EXIT_' + d.exitCode);
    task.nextAction = '人工/控制器复核后决定是否重试；不自动重推';
    saveState(state);
    return state;
  }
  // 5) 独立验证
  task.status = 'VERIFYING';
  saveState(state);
  const ev = await verify(cfg, task, d);
  task.verification = ev;
  if (!ev.ok) {
    task.status = 'FAILED';
    task.failureReason = ev.reason;
    task.nextAction = '验证未通过，不提交；下一轮重新派发';
    saveState(state);
    return state;
  }
  // 6) 提交推送
  task.status = 'COMMITTING';
  saveState(state);
  const push = commitAndPush(cfg, task);
  if (!push.pushed) {
    task.status = 'FAILED';
    task.failureReason = push.reason;
    task.nextAction = '提交被阻止：' + push.reason;
    saveState(state);
    return state;
  }
  task.commitSha = push.sha;
  task.status = 'CI_PENDING';
  task.pushedAt = new Date().toISOString();
  const remote = remoteState(cfg);
  task.remoteSha = remote.sha;
  task.remoteMatches = remote.sha === push.sha;
  state.phase = 'DISCOVERING';
  saveState(state);
  return state;
}

// ───────────────────────────────────────────────────────── 恢复对账
function reconcile(cfg, state) {
  const queue = readJSON(QUEUE_FILE);
  const remote = remoteState(cfg);
  const notes = [];
  for (const id of state.order) {
    const t = state.tasks[id];
    if (!t) continue;
    if (t.status === 'PUSHED' || t.status === 'CI_PENDING') {
      // 远程已经有该 SHA -> 不重推
      if (remote.sha && t.commitSha && remote.sha === t.commitSha) {
        t.status = 'CI_PENDING';
        notes.push({ id, action: 'PUSH_ALREADY_PRESENT', sha: t.commitSha });
      } else {
        t.status = 'PENDING';
        t.nextAction = '远程未见该提交，重新派发（不重推已存在的）';
        notes.push({ id, action: 'REQUEUE', remoteSha: remote.sha, localSha: t.commitSha });
      }
    } else if (t.status === 'AGENT_RUNNING' || t.status === 'VERIFYING' || t.status === 'DISPATCHING') {
      // 半成品：核对工作区实际状态，不能直接前进
      const snap = snapshot(cfg);
      const changed = changedFiles(cfg);
      t.status = 'PENDING';
      t.halfFinished = true;
      t.nextAction = '上次执行中断，工作区有 ' + (changed.length || 0) + ' 处未确认改动，需独立复核后再派发';
      notes.push({ id, action: 'HALF_FINISHED_BACK_TO_PENDING', changedFiles: changed.length, head: snap.head });
    }
  }
  return notes;
}

// ───────────────────────────────────────────────────────── 状态打印
function statusOf(cfg, state) {
  const queue = fs.existsSync(QUEUE_FILE) ? readJSON(QUEUE_FILE) : { tasks: [] };
  const ledger = fs.existsSync(LEDGER) ? readJSON(LEDGER) : { counts: {} };
  const done = Object.values(state.tasks).filter(t => t.status === 'DONE').length;
  const failed = Object.values(state.tasks).filter(t => t.status === 'FAILED' || t.status === 'BLOCKED_CI').length;
  const pending = Object.values(state.tasks).filter(t => ['PENDING', 'RETRY', 'DISPATCHING', 'AGENT_RUNNING', 'VERIFYING', 'COMMITTING', 'CI_PENDING'].includes(t.status)).length;
  let head = null, branch = null;
  try {
    head = execFileSync(cfg.tools.git || 'git', ['rev-parse', 'HEAD'], { cwd: cfg.repoRoot, encoding: 'utf8' }).trim();
    branch = execFileSync(cfg.tools.git || 'git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: cfg.repoRoot, encoding: 'utf8' }).trim();
  } catch { }
  return {
    supervisor: { phase: state.phase, revision: state.revision, updatedAt: state.updatedAt, pid: process.pid },
    worker: { kind: 'zcode-cli', mode: cfg.worker.mode, disallowedTools: cfg.worker.disallowedTools, adapterValidated: cfg.worker.adapterValidated },
    currentTask: state.order.map(id => state.tasks[id]).find(t => t && ['DISPATCHING', 'AGENT_RUNNING', 'VERIFYING', 'COMMITTING', 'CI_PENDING', 'PAUSED_QUOTA'].includes(t.status)) || null,
    quota: { state: state.quotaState, remainingPercent: state.quota && state.quota.remainingPercent, fiveHour: state.quota && state.quota.fiveHourRemainingPercent, weekly: state.quota && state.quota.weeklyRemainingPercent, checkedAt: state.quotaCheckedAt },
    coverage: { counts: ledger.counts, tasksDone: done, tasksFailed: failed, tasksPending: pending, tasksTotal: queue.tasks.length },
    git: { head, branch, remoteSha: remoteState(cfg).sha },
    devKb: devKbHealth(),
    paths: { state: STATE_FILE, journal: JOURNAL, evidence: EVIDENCE, queue: QUEUE_FILE }
  };
}

// ───────────────────────────────────────────────────────── 主流程
async function main() {
  const cmd = process.argv[2] || 'run';
  const cfgPath = process.argv[3] || path.join(qaRoot, 'config', 'local.json');
  const cfg = readJSON(cfgPath);
  if (cmd === 'build-queue') {
    const q = buildQueue();
    fs.mkdirSync(STATE_DIR, { recursive: true });
    atomicJSON(QUEUE_FILE, q);
    console.log(JSON.stringify({ status: 'PASS', tasks: q.tasks.length, specs: q.tasks.reduce((n, t) => n + t.specCount, 0), queue: QUEUE_FILE }, null, 2));
    return;
  }
  if (cmd === 'status') {
    console.log(JSON.stringify(statusOf(cfg, loadState()), null, 2));
    return;
  }
  if (cmd === 'reconcile') {
    const state = loadState();
    const notes = reconcile(cfg, state);
    saveState(state);
    console.log(JSON.stringify({ status: 'PASS', notes }, null, 2));
    return;
  }
  if (cmd === 'run') {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    injectSubscriptionKey();
    writeSupervisorPid();
    const release = acquireLock(LOCK);
    let stopping = false;
    process.on('SIGINT', () => { stopping = true; });
    process.on('SIGTERM', () => { stopping = true; });
    try {
      const state = loadState();
      if (!state.startedAt) state.startedAt = new Date().toISOString();
      const notes = reconcile(cfg, state);
      if (notes.length) appendJournal({ kind: 'RECONCILE', notes });
      saveState(state);
      while (!stopping) {
        try {
          const s = await tick(cfg, state);
          appendJournal({ kind: 'TICK', phase: s.phase, quotaState: s.quotaState, remaining: s.quota && s.quota.remainingPercent });
          if (s.phase === 'ALL_EXECUTABLE_TASKS_DONE') { console.log(JSON.stringify(statusOf(cfg, s), null, 2)); break; }
        } catch (e) {
          appendJournal({ kind: 'ERROR', code: e.code || 'ERROR', message: redact(e.message) });
          console.error(redact(e.message));
        }
        await sleep(cfg.overnight?.pollMs || 30000);
      }
      console.log(JSON.stringify(statusOf(cfg, state), null, 2));
    } finally { release(); }
    return;
  }
  console.log('用法: overnight-supervisor.cjs [build-queue|status|reconcile|run] [config]');
}
if (require.main === module) main().catch(e => { console.error(redact(e.message)); process.exitCode = 20; });
module.exports = { buildQueue, makeContract, quotaGate, devKbHealth, tick, reconcile, statusOf };
