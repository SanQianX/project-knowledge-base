'use strict';

// MCP tool runtime for the six project_workflow_* tools. These tools are a
// thin adapter over the shell's /api/workflow/* proxy into the independent
// workflow module — no task state is stored here (runbook §2.3: the tools
// call the workflow master store, never a second copy).
//
// M0-C: project registration is reused from the knowledge runtime, so tasks
// resolve to a registered projectId + canonical repo path instead of a
// silent 'unknown-project'. The review pipeline is job-based: request_review
// reserves a job (202) and polls it with a bounded wait; review_result reads
// a persisted job by reviewJobId (or the task's latest) — a slow check
// answers honestly "pending" instead of blocking the MCP call.

const path = require('path');
const { DomainError } = require('./contracts');
const endpoint = require('./runtime-endpoint');
const { getDataDir } = require('./data-dir');

const DEFAULT_TIMEOUT_MS = 15000;
// A single MCP tool call must stay inside the 15s runtime timeout, so the
// bounded wait never exceeds 8s (M1-B ceiling). Slow checks keep running
// server-side; review_result picks the same reviewJobId up later.
const MAX_WAIT_MS = 8000;
const POLL_INTERVAL_MS = 250;

class WorkflowToolRuntime {
  constructor(options = {}) {
    this.layout = options.layout || null;
    this.workflowUrl = options.workflowUrl || process.env.KB_WORKFLOW_URL || null;
    this.fetchImpl = options.fetchImpl || fetch;
    this.timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
    // Registration resolver reused from the knowledge runtime (read-only).
    // Absent (unit tests, standalone use) → explicit projectId or the
    // historical 'unknown-project' fallback; present → resolution failure is
    // a structured error, never a silent unknown project.
    this.resolveProject = typeof options.resolveProject === 'function' ? options.resolveProject : null;
  }

  /** Prefer an explicit module URL; else the live shell's proxy base. */
  resolveBase() {
    if (this.workflowUrl) return { base: this.workflowUrl.replace(/\/+$/, ''), prefix: '/api/workflow/v1' };
    try {
      const dataDir = this.layout ? this.layout.getDataDir() : getDataDir();
      const live = endpoint.readLiveEndpoint(dataDir, { removeStale: false });
      if (live && live.host && live.port) return { base: `http://${live.host}:${live.port}`, prefix: '/api/workflow' };
    } catch { /* no live shell — surfaced as a structured error below */ }
    return null;
  }

  async request(apiPath, { method = 'GET', body } = {}) {
    const resolved = this.resolveBase();
    if (!resolved) {
      throw new DomainError('WORKFLOW_UNAVAILABLE', '工作流服务不可达：未设置 KB_WORKFLOW_URL，且没有运行中的知识库实例。任务与知识检索不受影响。', { status: 503, retryable: true });
    }
    const url = `${resolved.base}${resolved.prefix}/${apiPath.replace(/^\/+/, '')}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      const json = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new DomainError(json.error && typeof json.error === 'string' ? json.error : 'WORKFLOW_HTTP_ERROR', json.message || `HTTP ${response.status}`, { status: response.status, details: json.details || {}, retryable: response.status >= 500 });
      }
      return json;
    } catch (inner) {
      if (inner instanceof DomainError) throw inner;
      throw new DomainError('WORKFLOW_UNAVAILABLE', '工作流服务不可达；原生开发可以继续，页面会显示降级状态。', { status: 503, retryable: true, cause: inner });
    } finally { clearTimeout(timer); }
  }

  /** Resolve the registered project for this call; null when no resolver. */
  _resolveRegisteredProject(args, { required = false } = {}) {
    if (!this.resolveProject) return null;
    try {
      return this.resolveProject({ projectId: args.projectId, repoPath: args.repoPath });
    } catch (error) {
      if (args.projectId) return null; // an explicit projectId stands as declared; the module verifies the binding
      if (!required) return null; // read/forward paths proceed; the module's binding gate decides
      throw new DomainError('INVALID_ARGUMENT', `PROJECT_NOT_RESOLVED：${error.message || '未找到与当前 Git 根匹配的登记项目'}；请显式传 projectId 或先调用 project_knowledge_resolve。`, { details: { reason: 'project-not-resolved' } });
    }
  }

  /**
   * start: create the business task, bind the calling session (declared
   * basis — the Bridge consumer's captured sessionId drives observation, not
   * acceptance), and return the short task contract. The repo binding is
   * verified server-side from the trusted project mapping; repoPath here is
   * only a match hint.
   */
  async start(args) {
    const title = String(args.title || '').trim();
    if (!title) throw new DomainError('INVALID_ARGUMENT', 'title is required.', { details: { tool: 'project_workflow_start' } });
    const resolved = this._resolveRegisteredProject(args);
    let projectId = args.projectId ? String(args.projectId) : (resolved && resolved.projectId) || null;
    if (!projectId && this.resolveProject) {
      throw new DomainError('INVALID_ARGUMENT', 'PROJECT_NOT_RESOLVED：未找到与当前 Git 根匹配的登记项目；请显式传 projectId 或先调用 project_knowledge_resolve。', { details: { reason: 'project-not-resolved' } });
    }
    if (!projectId) projectId = 'unknown-project'; // no resolver wired (standalone/test) — the module keeps the task honestly unbound
    const payload = {
      requestId: args.requestId || `mcp-start-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      projectId,
      title,
      goal: args.goal || null,
      acceptance: Array.isArray(args.acceptance) ? args.acceptance : undefined,
      ownerMemberId: args.memberId || null,
      repoPath: args.repoPath || (resolved && resolved.repoPath) || undefined,
      executionMode: args.executionMode === 'team' ? 'team' : undefined,
    };
    const created = await this.request('workflow-tasks', { method: 'POST', body: payload });
    const taskId = created.task.taskId;
    let binding = null;
    if (args.client && args.sessionId) {
      const bindBody = {
        requestId: `mcp-bind-${payload.requestId}`,
        client: String(args.client),
        nativeSessionId: String(args.sessionId),
        workspaceIdentity: args.workspaceIdentity || payload.repoPath || process.cwd(),
        memberId: args.memberId || null,
        verificationBasis: 'declared',
      };
      try { binding = await this.request(`workflow-tasks/${encodeURIComponent(taskId)}/session-bindings`, { method: 'POST', body: bindBody }); }
      catch { binding = null; /* observation still works once the hook-captured session id matches */ }
    }
    return {
      ok: true,
      taskId,
      task: created.task,
      repoBinding: created.task.repoBinding || { status: 'unbound' },
      sessionBinding: binding ? { bindingId: binding.binding.bindingId, basis: 'declared' } : null,
      nextStep: args.executionMode === 'team'
        ? '团队任务已激活（taskId 已返回）：服务端按项目团队配置推进计划、执行与独立审查；用 resume/status 读取进展。'
        : '实现需求；完成后用 project_workflow_checkpoint 记录事实，再 request_review 并用 review_result 读取证据。',
      ...(created.task.executionMode === 'team' ? { teamActivated: true, planStatus: created.task.planStatus } : {}),
      ...(args.executionMode === 'team' && created.task.executionMode !== 'team' ? { degraded: true, degradedReason: '团队模式未生效：请求未通过受信通道（项目未登记/未开启 autoDispatch 的模块会降级为普通任务）。' } : {}),
      note: '会话绑定当前为声明级：事件观察按采集会话归因，验收始终由服务端裁决。',
    };
  }

  async resume(args) {
    if (!args.taskId) throw new DomainError('INVALID_ARGUMENT', 'taskId is required.', { details: { tool: 'project_workflow_*' } });
    const result = await this.request(`workflow-tasks/${encodeURIComponent(args.taskId)}`);
    const task = result.task;
    const checkpoints = task.checkpoints || [];
    const latest = checkpoints[checkpoints.length - 1] || null;
    return {
      ok: true,
      taskId: task.taskId,
      title: task.title,
      goal: task.goal,
      status: task.status,
      phase: task.phase,
      acceptance: task.acceptance,
      acceptanceRevision: task.acceptanceRevision,
      confirmedDecisions: latest ? latest.decided : [],
      verifiedResults: latest ? latest.verifiedResults : [],
      remaining: latest ? latest.remaining : task.acceptance.filter(a => a.status === 'pending').map(a => a.title),
      nextAction: task.nextAction,
      revision: task.revision,
    };
  }

  async status(args) {
    if (args.taskId) return { ok: true, task: (await this.request(`workflow-tasks/${encodeURIComponent(args.taskId)}`)).task };
    const query = new URLSearchParams();
    if (args.projectId) query.set('projectId', args.projectId);
    if (args.status) query.set('status', args.status);
    const list = await this.request(`workflow-tasks?${query.toString()}`);
    return { ok: true, total: list.total, tasks: list.tasks.map(t => ({ taskId: t.taskId, title: t.title, projectId: t.projectId, status: t.status, phase: t.phase, nextAction: t.nextAction, updatedAt: t.updatedAt })) };
  }

  async checkpoint(args) {
    if (!args.taskId) throw new DomainError('INVALID_ARGUMENT', 'taskId is required.', { details: { tool: 'project_workflow_*' } });
    const payload = {
      requestId: `mcp-ckpt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      kind: args.kind === 'fact' ? 'fact' : 'candidate',
      summary: args.summary || null,
      decided: args.decided,
      verifiedResults: args.verifiedResults,
      remaining: args.remaining,
      nextAction: args.nextAction || null,
      eventRefs: args.eventRefs,
    };
    const result = await this.request(`workflow-tasks/${encodeURIComponent(args.taskId)}/checkpoints`, { method: 'POST', body: payload });
    return { ok: true, checkpoint: result.checkpoint };
  }

  async _readReviewJob(reviewJobId) {
    return this.request(`review-jobs/${encodeURIComponent(reviewJobId)}`);
  }

  /** Bounded job wait — never exceeds MAX_WAIT_MS, honest pending afterwards. */
  async _awaitJob(reviewJobId, waitMs) {
    const deadline = Date.now() + Math.max(0, Math.min(Number(waitMs) || 0, MAX_WAIT_MS));
    let payload;
    for (;;) {
      payload = await this._readReviewJob(reviewJobId);
      const overall = payload.job && payload.job.overallStatus;
      // P1b: wait on the WHOLE review (checks + model), not just job.status —
      // 'completed' with a pending model phase is still worth polling.
      const settled = overall ? ['review-complete', 'failed', 'stale', 'review-blocked', 'blocked-missing-config'].includes(overall)
        : ['completed', 'failed', 'stale'].includes(payload.job.status);
      if (settled) return payload;
      if (Date.now() >= deadline) return payload;
      await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
    }
  }

  _reviewAnswer(args, payload) {
    const job = payload.job || {};
    const overall = job.overallStatus || job.status;
    const finished = ['completed', 'failed', 'stale'].includes(job.status);
    const settled = ['review-complete', 'failed', 'stale', 'review-blocked', 'blocked-missing-config'].includes(overall);
    const answer = {
      ok: true,
      taskId: args.taskId,
      reviewJobId: job.reviewJobId,
      reviewStatus: job.status,
      overallStatus: overall || null,
      modelRequired: job.modelRequired === true,
      modelState: job.modelState || null,
      pending: !settled,
      snapshotId: job.snapshotId || null,
      acceptanceRevision: job.acceptanceRevision ?? null,
    };
    // P1b: the REAL model phase, never a hard-coded string. Old modules
    // without the projection degrade to 'pending-model-review'.
    const mr = job.modelReview || null;
    if (mr) {
      answer.modelReview = {
        status: mr.status,
        identity: mr.identity || null,
        identityVerified: Boolean(mr.identityVerified),
        blockedReason: mr.blockedReason || null,
        summary: mr.summary || null,
        findings: (mr.findings || []).slice(0, 50),
      };
    } else {
      answer.modelReview = job.modelRequired ? { status: job.modelState || 'pending', identity: null, identityVerified: false, blockedReason: null, summary: null, findings: [] } : 'not-required';
    }
    if (settled && overall === 'review-complete') {
      answer.snapshot = { snapshotId: job.snapshotId, fileCount: job.fileCount };
      answer.receipts = payload.receipts || [];
      answer.decision = job.decision || null;
      answer.note = '程序检查与模型审查（如要求）均完成；自动验收由服务端依据收据与已核实模型意见裁决。';
    } else if (settled && overall === 'review-blocked') {
      answer.error = (mr && mr.blockedReason) || job.error || null;
      answer.note = `模型审查阻塞：${answer.error || '见 modelReview 详情'}。处理后重新 request_review。`;
    } else if (settled && overall === 'blocked-missing-config') {
      answer.error = 'REVIEWER_CONFIG_MISSING';
      answer.note = '本轮要求模型审查但服务端未配置受信 Reviewer（/api/internal/reviewer-config）。程序收据已记录；配置后重新 request_review。';
    } else if (finished) {
      answer.error = job.error || null;
      answer.note = `审查作业 ${job.status}：${job.error || '保留诊断；处理后重新 request_review。'}`;
    } else {
      answer.note = overall === 'awaiting-model' || overall === 'awaiting-model-config'
        ? `程序检查已完成，模型审查进行中（等待上限 ${MAX_WAIT_MS}ms 已到）：稍后用 project_workflow_review_result 读取同一 reviewJobId。`
        : `审查仍在运行（本次等待上限 ${MAX_WAIT_MS}ms 已到）：稍后用 project_workflow_review_result 读取同一 reviewJobId。`;
    }
    if (payload.task) {
      // P1b: attribute carefully — the TASK-level rework list may be newer
      // than this job; surface it read-only with the job's own phase.
      answer.task = { status: payload.task.status, phase: payload.task.phase, nextAction: payload.task.nextAction, reworkItems: (payload.task.reworkItems || []).slice(0, 50) };
      answer.decision = answer.decision || (job.decision || null);
    }
    return answer;
  }

  async requestReview(args) {
    if (!args.taskId) throw new DomainError('INVALID_ARGUMENT', 'taskId is required.', { details: { tool: 'project_workflow_*' } });
    const resolved = this._resolveRegisteredProject(args);
    const body = {
      requestId: args.requestId || `mcp-review-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      repoPath: args.repoPath || (resolved && resolved.repoPath) || undefined,
      projectId: (resolved && resolved.projectId) || args.projectId || undefined,
      tools: Array.isArray(args.tools) ? args.tools : undefined,
      included: Array.isArray(args.included) ? args.included.map(String) : undefined,
      note: args.note || undefined,
    };
    const submitted = await this.request(`workflow-tasks/${encodeURIComponent(args.taskId)}/reviews`, { method: 'POST', body });
    if (!submitted.reviewJobId) {
      // Old workflow module (pre-review-jobs): the POST answered with the
      // full receipt payload — pass it through as the honest degradation.
      return {
        ok: true,
        taskId: args.taskId,
        reviewStatus: 'legacy-sync',
        pending: false,
        snapshot: submitted.snapshot,
        receipts: submitted.receipts,
        decision: submitted.decision,
        modelReview: submitted.modelReview || 'pending-model-review',
        note: '旧版工作流模块（无 review 作业）：已按同步检查结果返回；升级后 review_result 支持 reviewJobId 与有界等待。',
      };
    }
    const payload = await this._awaitJob(submitted.reviewJobId, args.waitMs ?? MAX_WAIT_MS);
    return this._reviewAnswer(args, payload);
  }

  async reviewResult(args) {
    if (!args.taskId) throw new DomainError('INVALID_ARGUMENT', 'taskId is required.', { details: { tool: 'project_workflow_*' } });
    const waitMs = Math.min(Math.max(Number(args.waitMs) || 0, 0), MAX_WAIT_MS);
    let reviewJobId = args.reviewJobId ? String(args.reviewJobId) : null;
    let historical = false;
    if (!reviewJobId) {
      const task = (await this.request(`workflow-tasks/${encodeURIComponent(args.taskId)}`)).task;
      const jobIds = task.reviewJobIds || [];
      if (!jobIds.length) return this._legacyReviewResult(task);
      reviewJobId = jobIds[jobIds.length - 1];
    }
    const payload = await this._awaitJob(reviewJobId, waitMs);
    const job = payload.job || {};
    // P1b: an explicitly passed job must belong to the passed task — a job
    // id from another task is a caller bug, never silently served.
    if (args.reviewJobId && job.taskId && job.taskId !== args.taskId) {
      const error = new DomainError('INVALID_ARGUMENT', `reviewJobId ${reviewJobId} 属于任务 ${job.taskId}，不是 ${args.taskId}。`, { status: 400, details: { reason: 'job-task-mismatch', jobTaskId: job.taskId } });
      throw error;
    }
    if (job.taskId && job.taskId !== args.taskId) {
      // Derived-by-default should never mismatch; treat as unavailable.
      const task = (await this.request(`workflow-tasks/${encodeURIComponent(args.taskId)}`)).task;
      const jobIds = task.reviewJobIds || [];
      if (!jobIds.length) return this._legacyReviewResult(task);
      historical = true;
      const fallback = await this._awaitJob(jobIds[jobIds.length - 1], 0);
      return this._reviewAnswer(args, fallback);
    }
    // Mark historical jobs explicitly: the task's LATEST round is what the
    // rework/next-step summary may speak for; older rounds are read-only.
    const taskNow = payload.task || null;
    if (taskNow && (taskNow.reviewJobIds || []).length && (taskNow.reviewJobIds || []).at(-1) !== reviewJobId) historical = true;
    const answer = this._reviewAnswer(args, payload);
    const task = taskNow || {};
    const checks = (task.runs || []).filter(r => r.kind === 'check');
    return {
      ...answer,
      historical,
      status: task.status,
      phase: task.phase,
      nextAction: task.nextAction,
      reworkItems: task.reworkItems || [],
      checks: checks.map(r => ({ runId: r.runId, summary: r.summary, status: r.status, finishedAt: r.finishedAt })),
      acceptance: task.acceptance,
      ...(historical
        ? { note: `这是历史审查作业（当前最新一轮不是它）；最新整改与下一步以不带 reviewJobId 的 review_result 为准。` }
        : {}),
      ...(!historical && answer.pending && (task.reworkItems || []).length
        ? { note: `作业仍在运行；当前整改清单 ${task.reworkItems.length} 项（来自上一轮快照）。` }
        : {}),
    };
  }

  /** Old workflow module (no review jobs): read checks from the task runs. */
  async _legacyReviewResult(task) {
    const checks = (task.runs || []).filter(r => r.kind === 'check');
    let latestFindings = null;
    const latest = checks[checks.length - 1];
    if (latest && latest.executionRef) {
      try {
        const receipt = await this.request(`check-receipts/${encodeURIComponent(latest.executionRef)}`);
        latestFindings = (receipt.receipt.findings || []).slice(0, 100).map(f => ({ ruleId: f.ruleId, file: f.file, line: f.line, severity: f.severity, message: f.message }));
      } catch { latestFindings = null; /* receipt purged or unavailable — reworkItems on the task still carry the queue */ }
    }
    return {
      ok: true,
      taskId: task.taskId,
      reviewStatus: 'legacy',
      pending: false,
      status: task.status,
      phase: task.phase,
      nextAction: task.nextAction,
      reworkItems: task.reworkItems || [],
      latestCheckFindings: latestFindings,
      checks: checks.map(r => ({ runId: r.runId, summary: r.summary, status: r.status, finishedAt: r.finishedAt })),
      acceptance: task.acceptance,
      modelReview: 'pending-model-review',
      note: task.reworkItems && task.reworkItems.length
        ? `整改 ${task.reworkItems.length} 项：按 file:line[rule] 修复后重新 project_workflow_request_review。`
        : '当前快照没有待整改项。',
    };
  }
}

module.exports = { WorkflowToolRuntime, MAX_WAIT_MS };
