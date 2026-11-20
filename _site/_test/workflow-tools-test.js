'use strict';
// project_workflow_* MCP tool contract: the tools are a thin adapter over the
// shell proxy into the workflow module. This suite runs a REAL workflow module
// instance (installed pinned package by default, an explicit local candidate
// via KB_WORKFLOW_TEST_SOURCE) and drives a REAL stdio MCP child through
// initialize → tools/list → tools/call for all six tools, plus the review-job
// flow and the structured degradation when no service is reachable. Missing
// module sources FAIL the suite — they are never a silent pass.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { WorkflowToolRuntime } = require('../lib/workflow-tool-runtime');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CANDIDATE_SOURCE = process.env.KB_WORKFLOW_TEST_SOURCE || '';

function resolveWorkflowModule() {
  if (CANDIDATE_SOURCE) {
    const entry = path.resolve(CANDIDATE_SOURCE);
    if (!fs.existsSync(entry)) throw new Error(`workflow-tools-test FAIL: KB_WORKFLOW_TEST_SOURCE points at a missing file: ${entry}`);
    return { createWorkflowServer: require(entry).createWorkflowServer, source: entry };
  }
  try {
    const entry = require.resolve('@sanqianx/ai-coding-workflow/src/server', { paths: [REPO_ROOT] });
    return { createWorkflowServer: require(entry).createWorkflowServer, source: entry };
  } catch (error) {
    throw new Error(`workflow-tools-test FAIL: the pinned @sanqianx/ai-coding-workflow package is not installed and KB_WORKFLOW_TEST_SOURCE is not set (${error.message}).`);
  }
}

function tempDataDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'ai-workflow-mcp-')); }

/**
 * Real workflow module upstream: the resolved module's createWorkflowServer
 * binds an ephemeral loopback port in THIS process (the real-CLI lifecycle
 * gate lives in the workflow repo's own integration suite — that keeps this
 * suite working against the currently pinned installed package too).
 */
async function startWorkflowModule({ createWorkflowServer, runtimeToken }) {
  const runtime = createWorkflowServer({ dataDir: tempDataDir(), runtimeToken });
  const bound = await runtime.listen(0);
  const base = `http://127.0.0.1:${bound.port}`;
  await fetch(`${base}/api/workflow/v1/team`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId: 'mcp-seed' }) });
  let hasProjectRoots = false;
  try {
    const probe = await fetch(`${base}/api/health`);
    const health = await probe.json();
    hasProjectRoots = Boolean(health.capabilities && health.capabilities.projectRepoBinding);
  } catch { hasProjectRoots = false; }
  return { runtime, base, hasProjectRoots, close: () => runtime.close() };
}

function makeGitRepo(files) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-mcp-review-'));
  const git = args => { const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' }); if (r.status !== 0) throw new Error(r.stderr); };
  git(['init', '-b', 'main']); git(['config', 'user.email', 't@t']); git(['config', 'user.name', 't']);
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(repo, name), content);
  git(['add', '.']); git(['commit', '-m', 'init']);
  return repo;
}

/** Minimal MCP stdio client: newline-delimited JSON-RPC over the child. */
class McpClient {
  constructor(env) {
    this.child = spawn(process.execPath, [path.join(REPO_ROOT, 'bin', 'project-knowledge-mcp.js')], {
      cwd: REPO_ROOT,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = '';
    this.child.stdout.on('data', data => {
      this.buffer += data.toString('utf8');
      for (;;) {
        const newline = this.buffer.indexOf('\n');
        if (newline < 0) break;
        const line = this.buffer.slice(0, newline).trim();
        this.buffer = this.buffer.slice(newline + 1);
        if (!line) continue;
        let message; try { message = JSON.parse(line); } catch { continue; }
        const pending = this.pending.get(message.id);
        if (pending) { this.pending.delete(message.id); pending(message); }
      }
    });
    this.child.stderr.on('data', () => { /* diagnostics only */ });
  }
  request(method, params) {
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`MCP ${method} timed out`)); }, 60_000);
      this.pending.set(id, message => { clearTimeout(timer); resolve(message); });
      this.child.stdin.write(payload);
    });
  }
  async initialize() {
    const reply = await this.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'workflow-tools-test', version: '0.0.1' } });
    assert.equal(reply.result.serverInfo.name, 'project-knowledge');
    await this.request('notifications/initialized', {});
    return reply.result;
  }
  async listTools() { return (await this.request('tools/list', {})).result.tools; }
  async callTool(name, args) { return (await this.request('tools/call', { name, arguments: args })).result; }
  close() { try { this.child.kill(); } catch { /* already gone */ } }
}

(async () => {
  const { createWorkflowServer, source } = resolveWorkflowModule();
  const runtimeToken = 'test-runtime-token';
  const upstream = await startWorkflowModule({ createWorkflowServer, runtimeToken });
  let repo = null;
  try {
    repo = makeGitRepo({
      'package.json': '{"name":"x","private":true}',
      'eslint.config.mjs': 'export default [{ rules: { complexity: ["error", { max: 1 }] } }];\n',
      'violation.js': 'export function b(x){if(x===1){return 1;}if(x===2){return 2;}if(x===3){return 3;}return 0;}\n',
    });
    // Capability branch: a NEW module exposes the trusted project-roots
    // registry; the pinned installed package may predate it and keeps its
    // own (unbound) behavior — both are real, honestly asserted.
    let boundMode = false;
    if (upstream.hasProjectRoots) {
      const reg = await fetch(`${upstream.base}/api/internal/project-roots`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-KB-Runtime-Token': runtimeToken },
        body: JSON.stringify({ requestId: 'reg-p1', projectId: 'p1', canonicalGitRoot: repo }),
      });
      assert.equal(reg.status, 201, `trusted project-roots registration must succeed: ${JSON.stringify(await reg.json().catch(() => ({})))}`);
      boundMode = true;
    }

    // ---- Real stdio MCP: initialize → tools/list → tools/call × 6 ----
    const mcp = new McpClient({ KB_WORKFLOW_URL: upstream.base, KB_DATA_DIR: tempDataDir() });
    try {
      await mcp.initialize();
      const tools = await mcp.listTools();
      const workflowTools = tools.filter(t => t.name.startsWith('project_workflow_'));
      assert.equal(workflowTools.length, 6, 'the six workflow tools are exposed');
      const byName = Object.fromEntries(workflowTools.map(t => [t.name, t]));
      assert.ok(byName.project_workflow_request_review.inputSchema.properties.tools, 'request_review declares the tools parameter');
      assert.ok(byName.project_workflow_review_result.inputSchema.properties.reviewJobId, 'review_result declares the optional reviewJobId');
      assert.ok(byName.project_workflow_review_result.inputSchema.properties.waitMs.maximum <= 8000, 'the wait ceiling stays inside the runtime timeout');

      const started = JSON.parse((await mcp.callTool('project_workflow_start', { title: '修复重复重试', goal: '超时后不得重复提交', acceptance: [{ title: '无违规', kind: 'automated', requiredEvidence: [{ toolId: 'eslint' }] }], client: 'claude', sessionId: 'sess-mcp-1', projectId: 'p1' })).content[0].text);
      assert.ok(started.taskId.startsWith('task_'));
      if (boundMode) assert.equal(started.repoBinding.status, 'bound', 'the task binds the trusted root at creation');
      assert.equal(started.sessionBinding.basis, 'declared');

      const resumed = JSON.parse((await mcp.callTool('project_workflow_resume', { taskId: started.taskId })).content[0].text);
      assert.equal(resumed.title, '修复重复重试');
      assert.equal(resumed.acceptance.length, 1);

      const listed = JSON.parse((await mcp.callTool('project_workflow_status', { projectId: 'p1' })).content[0].text);
      assert.equal(listed.total, 1);

      const checkpointed = JSON.parse((await mcp.callTool('project_workflow_checkpoint', { taskId: started.taskId, kind: 'fact', summary: '修复完成', verifiedResults: ['单测通过'], nextAction: '提交审查' })).content[0].text);
      assert.ok(checkpointed.checkpoint.checkpointId);

      // request_review: a NEW module reserves a job and answers with the
      // reviewJobId; the pinned old module answers with legacy receipts.
      // Over the installed package eslint is absent — 'missing' never passes.
      const review = JSON.parse((await mcp.callTool('project_workflow_request_review', { taskId: started.taskId, repoPath: repo, tools: ['eslint'], note: '第一轮检查' })).content[0].text);
      assert.ok(['completed', 'running', 'legacy-sync'].includes(review.reviewStatus), `honest review status: ${JSON.stringify(review).slice(0, 300)}`);
      if (review.reviewStatus === 'legacy-sync') {
        assert.ok(Array.isArray(review.receipts) && review.receipts.length >= 1, 'the old module still answers with receipts');
        assert.notEqual(review.receipts[0].verdict, 'pass');
      } else {
        assert.ok(review.reviewJobId, 'the review answer carries the job id');
        if (review.reviewStatus === 'completed') {
          assert.equal(review.receipts[0].toolId, 'eslint');
          assert.notEqual(review.receipts[0].verdict, 'pass', 'missing tool never passes');
        } else {
          assert.equal(review.pending, true);
        }
        const resultRead = JSON.parse((await mcp.callTool('project_workflow_review_result', { taskId: started.taskId, reviewJobId: review.reviewJobId, waitMs: 8000 })).content[0].text);
        assert.equal(resultRead.reviewJobId, review.reviewJobId);
        assert.ok(['completed', 'running', 'failed', 'stale'].includes(resultRead.reviewStatus));
        assert.ok(Array.isArray(resultRead.acceptance));
      }
    } finally { mcp.close(); }

    console.log(`workflow-tools-test PASS (real stdio MCP over a real workflow module [${boundMode ? 'job+binding' : 'legacy'} mode]: 6 tools, review flow)`);
  } finally {
    await upstream.close();
  }

  // Degradation: no live shell, no explicit URL -> structured WORKFLOW_UNAVAILABLE.
  const offline = new WorkflowToolRuntime({ workflowUrl: 'http://127.0.0.1:9' });
  try { await offline.status({}); throw new Error('offline status should fail'); }
  catch (error) { assert.equal(error.code, 'WORKFLOW_UNAVAILABLE'); }
  const offlineMcp = new McpClient({ KB_DATA_DIR: tempDataDir() });
  try {
    await offlineMcp.initialize();
    const offlineCall = await offlineMcp.callTool('project_workflow_status', {});
    assert.equal(offlineCall.isError, true, 'an unreachable module is a structured tool error');
    assert.match(offlineCall.content[0].text, /WORKFLOW_UNAVAILABLE/);
  } finally { offlineMcp.close(); }
  console.log('workflow-tools-test PASS (structured degradation when unreachable)');
})().catch(error => { console.error(error); process.exitCode = 1; });
