'use strict';

// MCP tool runtime for the six project_workflow_* tools. These tools are a
// thin adapter over the shell's /api/workflow/* proxy into the independent
// workflow module — no task state is stored here (runbook §2.3: the tools
// call the workflow master store, never a second copy).

const path = require('path');
const endpoint = require('./runtime-endpoint');
const { getDataDir } = require('./data-dir');

const DEFAULT_TIMEOUT_MS = 15000;

class WorkflowToolRuntime {
  constructor(options = {}) {
    this.layout = options.layout || null;
    this.workflowUrl = options.workflowUrl || process.env.KB_WORKFLOW_URL || null;
    this.fetchImpl = options.fetchImpl || fetch;
    this.timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
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
      const error = new Error('WORKFLOW_UNAVAILABLE');
      error.code = 'WORKFLOW_UNAVAILABLE';
      error.message = '工作流服务不可达：未设置 KB_WORKFLOW_URL，且没有运行中的知识库实例。任务与知识检索不受影响。';
      throw error;
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
        const error = new Error(json.message || `HTTP ${response.status}`);
        error.code = json.error || 'WORKFLOW_HTTP_ERROR';
        error.status = response.status;
        error.details = json.details || {};
        throw error;
      }
      return json;
    } catch (inner) {
      if (inner.code) throw inner;
      const error = new Error('工作流服务不可达；原生开发可以继续，页面会显示降级状态。');
      error.code = 'WORKFLOW_UNAVAILABLE';
      throw error;
    } finally { clearTimeout(timer); }
  }

  /**
   * start: create the business task, bind the calling session (declared
   * basis — the Bridge consumer's captured sessionId drives observation, not
   * acceptance), and return the short task contract.
   */
  async start(args) {
    const title = String(args.title || '').trim();
    if (!title) { const e = new Error('title is required'); e.code = 'VALIDATION'; throw e; }
    const payload = {
      requestId: `mcp-start-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      projectId: args.projectId || 'unknown-project',
      title,
      goal: args.goal || null,
      acceptance: Array.isArray(args.acceptance) ? args.acceptance : undefined,
      ownerMemberId: args.memberId || null,
    };
    const created = await this.request('workflow-tasks', { method: 'POST', body: payload });
    const taskId = created.task.taskId;
    let binding = null;
    if (args.client && args.sessionId) {
      const bindBody = {
        requestId: `mcp-bind-${payload.requestId}`,
        client: String(args.client),
        nativeSessionId: String(args.sessionId),
        workspaceIdentity: args.workspaceIdentity || args.repoPath || process.cwd(),
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
      sessionBinding: binding ? { bindingId: binding.binding.bindingId, basis: 'declared' } : null,
      nextStep: '实现需求；完成后用 project_workflow_checkpoint 记录事实，再 request_review（交付检查在后续版本接入）。',
      note: '会话绑定当前为声明级：事件观察按采集会话归因，验收始终由服务端裁决。',
    };
  }

  async resume(args) {
    if (!args.taskId) { const e = new Error('taskId is required'); e.code = 'VALIDATION'; throw e; }
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
    if (!args.taskId) { const e = new Error('taskId is required'); e.code = 'VALIDATION'; throw e; }
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

  async requestReview(args) {
    if (!args.taskId) { const e = new Error('taskId is required'); e.code = 'VALIDATION'; throw e; }
    // W5: submit the current snapshot to the deterministic check pipeline.
    // Receipt verdicts drive automated acceptance server-side; the model
    // review stage is reported honestly as pending.
    const result = await this.request(`workflow-tasks/${encodeURIComponent(args.taskId)}/reviews`, { method: 'POST', body: {
      requestId: `mcp-review-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      repoPath: args.repoPath || undefined,
      tools: Array.isArray(args.tools) ? args.tools : undefined,
    } });
    return {
      ok: true,
      snapshot: result.snapshot,
      receipts: result.receipts,
      decision: result.decision,
      modelReview: result.modelReview,
      note: '程序检查收据已记录；自动验收由服务端依据收据裁决。模型审查阶段当前为 pending（编排交付前不虚构意见）。',
    };
  }

  async reviewResult(args) {
    if (!args.taskId) { const e = new Error('taskId is required'); e.code = 'VALIDATION'; throw e; }
    const task = (await this.request(`workflow-tasks/${encodeURIComponent(args.taskId)}`)).task;
    const checks = (task.runs || []).filter(r => r.kind === 'check');
    // Full findings of the LATEST check run: the rework member works from
    // concrete file:line[rule] items, not from summaries.
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
      taskId: args.taskId,
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

module.exports = { WorkflowToolRuntime };
