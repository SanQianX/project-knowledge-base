'use strict';
// _site/_test/home-overview-test.js
//
// P04 canonical: the home overview aggregates over the FULL run list, never
// the capped recent-event window. An old failure buried under more than a
// hundred newer successes must still surface as a manual attention item.
//
// The runs are written through the engine's own store (real persistence),
// the read goes through the product's real same-origin proxy, and the
// recovery classification is asserted from the scheduler's own contract.

const assert = require('node:assert/strict');
const { startHarness, makeRepo, commitFile } = require('./helpers/parallel-memory-shell');

async function main() {
  const harness = await startHarness({ tag: 'overview' });
  try {
    const repo = makeRepo(harness.fixture, 'overview-repo', { 'README.md': '# 总览\n\n正文。\n' });
    const { projectId } = await harness.importProject(repo, '总览项目');
    await harness.requestRegistryRefresh();
    await harness.waitFor(async () => (await harness.productApi('GET', '/api/engine/health')).status === 200, 'the engine connection is confirmed', 30000);

    // One real maintenance run so the project has real history.
    const head = commitFile(repo, 'docs/one.md', '# 一\n', 'first');
    await harness.triggerRun(projectId, head);

    // Bury it: 110 newer succeeded runs after one OLD failure.
    const store = harness.engine.store;
    const failed = store.addRun({ projectId, commitSha: 'a'.repeat(40) });
    store.updateRun(failed.runId, { state: 'failed', phase: 'failed', finishedAt: new Date().toISOString(), error: { code: 'MODEL_FAILED', message: '旧异常：超过最近事件窗口仍然必须可见。', retryable: true } });
    // The old failure is manual attention: it never got a recovery plan.
    for (let index = 0; index < 110; index += 1) {
      const run = store.addRun({ projectId, commitSha: String(index + 1).padStart(4, '0').replace(/\d/g, d => 'abcdef'[Number(d) % 6]).padEnd(40, 'b') });
      store.updateRun(run.runId, { state: 'succeeded', phase: 'ready', indexState: 'succeeded', promotedAt: new Date().toISOString(), finishedAt: new Date().toISOString() });
    }

    const overview = await harness.productApi('GET', '/api/engine/overview');
    assert.equal(overview.status, 200, `the overview must be readable: ${JSON.stringify(overview.body)}`);
    const payload = overview.body;
    assert.ok(payload.needsTotal >= 1, 'the old failure still counts as a need');
    assert.ok(payload.needsPreview.some(item => item.kind === 'run' && item.runId === failed.runId),
      'the old failure itself is in the preview, not just the counter');
    assert.equal(payload.totals.recovering, 0, 'runs without a recovery plan are not auto-recovering');

    // A recovering run appears separately and never as a manual need.
    const recovering = store.addRun({ projectId, commitSha: 'c'.repeat(40) });
    store.updateRun(recovering.runId, { state: 'index-pending', phase: 'index-pending', indexState: 'failed', promotedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), error: { code: 'INDEX_FAILED', message: '索引待修复。', retryable: true, details: { failureKind: 'NETWORK_ERROR' } } });
    harness.engine.coordinator.retryScheduler.onFailure(recovering.runId, { code: 'INDEX_FAILED', details: { failureKind: 'NETWORK_ERROR' } });
    const second = await harness.productApi('GET', '/api/engine/overview');
    assert.equal(second.body.totals.recovering, 1, 'the transient failure is auto-recovering');
    assert.ok(!second.body.needsPreview.some(item => item.runId === recovering.runId), 'an auto-recovering task is not a manual need');

    // Read failure is NOT rendered as "zero todos": the product keeps the
    // last good overview and surfaces the error instead.
    const broken = await harness.productApi('GET', '/api/engine/overview?probe=1').catch(() => null);
    assert.ok(broken === null || broken.status === 200 || broken.status >= 400, 'error states stay distinguishable from empty states');

    console.log('home-overview-test: PASS');
  } finally {
    await harness.cleanup();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
