'use strict';
// project_workflow_* MCP tool contract: the tools are a thin adapter over the
// shell proxy into the workflow module. This suite runs a REAL workflow
// module instance as upstream and verifies start/resume/status/checkpoint and
// the truthful UNSUPPORTED answers for the review pipeline, plus the
// structured degradation when no service is reachable.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { WorkflowToolRuntime } = require('../lib/workflow-tool-runtime');

// Development-machine suite: the upstream is the real workflow module from
// its private source checkout. CI without that checkout gets an explicit,
// logged skip (never a silent pass); once the package publishes (W8) this
// switches to installing the tarball and the suite becomes mandatory.
let createWorkflowServer = null;
try {
  createWorkflowServer = require('D:/SanQian.Xu/ai-coding-workflow/src/server').createWorkflowServer;
} catch { /* not present on this machine */ }
if (!createWorkflowServer) {
  console.log('workflow-tools-test SKIP: workflow module source not present (dev-machine suite; becomes mandatory after the package publishes in W8)');
  process.exit(0);
}

function tempDataDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'ai-workflow-mcp-')); }

async function withUpstream(fn) {
  const runtime = createWorkflowServer({ dataDir: tempDataDir() });
  const bound = await runtime.listen(0);
  const base = `http://127.0.0.1:${bound.port}`;
  // Seed the default team so task creation is allowed.
  await fetch(`${base}/api/workflow/v1/team`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId: 'mcp-seed' }) });
  try { await fn(base); } finally { await runtime.close(); }
}

(async () => {
  await withUpstream(async base => {
    const tools = new WorkflowToolRuntime({ workflowUrl: base });

    // start creates a task, binds the declared session, returns the contract.
    const started = await tools.start({ title: '修复重复重试', goal: '超时后不得重复提交', acceptance: [{ title: '重试幂等', kind: 'automated' }], client: 'claude', sessionId: 'sess-mcp-1', projectId: 'p1' });
    assert.ok(started.taskId.startsWith('task_'));
    assert.equal(started.sessionBinding.basis, 'declared');
    assert.ok(started.nextStep.includes('checkpoint'));

    // resume answers the short contract with acceptance and remaining.
    const resumed = await tools.resume({ taskId: started.taskId });
    assert.equal(resumed.title, '修复重复重试');
    assert.equal(resumed.acceptance.length, 1);
    assert.equal(resumed.remaining[0], '重试幂等');
    assert.ok(resumed.acceptanceRevision >= 1);

    // status lists and reads.
    const list = await tools.status({ projectId: 'p1' });
    assert.equal(list.total, 1);
    const one = await tools.status({ taskId: started.taskId });
    assert.equal(one.task.taskId, started.taskId);

    // checkpoint candidate does not move nextAction; fact does.
    await tools.checkpoint({ taskId: started.taskId, kind: 'candidate', summary: '可能完成', nextAction: '不该出现' });
    let task = await tools.status({ taskId: started.taskId });
    assert.notEqual(task.task.nextAction, '不该出现');
    await tools.checkpoint({ taskId: started.taskId, kind: 'fact', summary: '修复完成', verifiedResults: ['单测通过'], nextAction: '提交审查' });
    task = await tools.status({ taskId: started.taskId });
    assert.equal(task.task.nextAction, '提交审查');
    const resumed2 = await tools.resume({ taskId: started.taskId });
    assert.deepEqual(resumed2.verifiedResults, ['单测通过']);

    // request_review / review_result answer truthfully UNSUPPORTED until W5.
    for (const [label, promise] of [['request_review', tools.requestReview({ taskId: started.taskId })], ['review_result', tools.reviewResult({ taskId: started.taskId })]]) {
      try { await promise; throw new Error(`${label} should have failed`); }
      catch (error) { assert.equal(error.code, 'UNSUPPORTED', `${label} must be truthful`); }
    }
    console.log('workflow-tools-test PASS (start/resume/status/checkpoint/UNSUPPORTED review over a real module instance)');
  });

  // Degradation: no live shell, no explicit URL -> structured WORKFLOW_UNAVAILABLE.
  const offline = new WorkflowToolRuntime({ workflowUrl: 'http://127.0.0.1:9' });
  try { await offline.status({}); throw new Error('offline status should fail'); }
  catch (error) { assert.equal(error.code, 'WORKFLOW_UNAVAILABLE'); }
  console.log('workflow-tools-test PASS (structured degradation when unreachable)');
})().catch(error => { console.error(error); process.exitCode = 1; });
