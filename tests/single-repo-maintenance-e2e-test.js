'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { createAiTeamUiFixture, cliOptions } = require('./helpers/ai-team-ui-fixture');

async function until(read, predicate, label) {
  const deadline = Date.now() + 30_000;
  let value;
  while (Date.now() < deadline) {
    value = await read();
    if (predicate(value)) return value;
    await delay(125);
  }
  throw new Error('Timed out waiting for ' + label + '\n' + JSON.stringify(value));
}

async function main() {
  const options = cliOptions();
  let fakeTime;
  const fixture = await createAiTeamUiFixture({
    ...options, maintenance: true, emptyTeam: false,
    maintenanceTiming: { pollMs: 150, bridgePollMs: 250, clock: () => fakeTime || new Date() },
  });
  try {
    const { repo, remote, baseline, configPath, projectId, journalId, bridge, git, gitAsync, appendBoundary } = fixture.maintenance;
    const status = () => fixture.call('maintenance');
    const post = (route, body) => fixture.call('maintenance/' + route, { method: 'POST', body });
    const detail = runId => fixture.call('maintenance/runs/' + runId).then(value => value.run);
    const upstream = () => git(remote, 'rev-parse', 'refs/heads/main');
    const terminal = run => !['queued', 'running'].includes(run.status);
    const waitRun = id => until(() => detail(id), terminal, 'run ' + id);
    const getRuns = async (job, kind) => (await status()).runs.filter(run => run.jobId === job.jobId && run.trigger.kind === kind);
    let requestIndex = 0;
    const save = fields => post('jobs', {
      requestId: 'job-' + (++requestIndex), memberId: fixture.members[0].memberId,
      enabled: true, delivery: 'candidate', ...fields,
    }).then(value => value.job);
    const control = (busy, fields = {}) => post('control', { requestId: 'control-' + (++requestIndex), busy, ...fields });
    const runNow = (job, id) => post('runs', { requestId: id || 'run-' + (++requestIndex), jobId: job.jobId }).then(value => value.run);

    const available = await status();
    assert.equal(available.projectId, projectId);
    assert.equal(available.workspace, null);
    assert.equal(available.timeZone, 'Asia/Shanghai');
    assert.ok(available.tools.every(tool => !tool.phases && !tool.command));
    const consumers = await bridge.listConsumers();
    assert.deepEqual(consumers.find(item => item.name === 'workflow:default').meta.journals, ['global', journalId]);
    const direct = fixture.workflowUrl + '/api/workflow/v1/maintenance';
    assert.equal((await fetch(direct, { headers: { Origin: 'https://foreign.example' } })).status, 403);
    assert.equal((await fetch(direct + '/runs', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' })).status, 400);
    assert.equal((await fetch(fixture.address + '/api/workflow/maintenance/control', {
      method: 'POST', headers: { Origin: 'https://foreign.example', 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId: 'cross-origin', busy: true }),
    })).status, 403);
    await assert.rejects(save({ title: 'Invalid member', toolId: 'review', memberId: 'other', trigger: { kind: 'commit' } }), /400/);
    await assert.rejects(save({ title: 'Unknown executable', toolId: 'arbitrary', trigger: { kind: 'commit' } }), /400/);

    const historical = await appendBoundary(); // Already captured before maintenance is enabled.
    assert.ok(historical.sequence > 1, 'the project journal starts with a real compacted prefix');
    let review = await save({ title: '处理提交检查', toolId: 'review', trigger: { kind: 'commit' } });
    assert.deepEqual(await getRuns(review, 'commit'), []);
    await control(true);
    fs.writeFileSync(path.join(repo, 'policy.txt'), 'FAIL\n');
    await gitAsync(repo, 'add', 'policy.txt');
    await gitAsync(repo, 'commit', '-qm', 'source commit from development');
    const source = git(repo, 'rev-parse', 'HEAD');
    const queued = await until(() => getRuns(review, 'commit'), runs => runs.length === 1, 'real managed Git hook');
    assert.equal(queued[0].trigger.commitSha, source);
    assert.equal(queued[0].status, 'queued');
    assert.equal((await status()).workspace, null);
    const events = await bridge.readEvents({ journalId, fromSequence: 1 });
    assert.ok(events.some(event => event.schema === 'git-commit-boundary/v1' && event.commitSha === source));
    await appendBoundary();
    await appendBoundary({ projectId: 'project-another-repo', commitSha: baseline });
    await appendBoundary({ branch: 'different-branch', commitSha: baseline });
    const lastBoundary = await bridge.getHighWatermark({ journalId });
    await until(() => fixture.call('consumer'), result => result.cursors[journalId] === lastBoundary, 'all journal events processed');
    const workflowState = JSON.parse(fs.readFileSync(path.join(options.dataDir, 'workflow-data', 'workflow', 'state.json'), 'utf8'));
    assert.ok(workflowState.consumer.gaps.some(gap => gap.journalId === journalId && gap.reason === 'retained-prefix'));
    assert.equal((await getRuns(review, 'commit')).length, 1);

    const devFile = path.join(repo, 'work-in-progress.txt');
    fs.writeFileSync(devFile, 'Development workspace only\n');
    await control(false);
    await until(status, data => data.waitReason === 'original-busy', 'uncommitted original work held');
    assert.equal(fs.readFileSync(devFile, 'utf8'), 'Development workspace only\n');
    assert.equal((await status()).workspace, null);
    fs.unlinkSync(devFile);

    const first = await waitRun(queued[0].runId);
    assert.equal(first.status, 'succeeded', JSON.stringify(first));
    assert.equal(first.delivery, 'candidate');
    assert.equal(first.baseSha, source);
    assert.deepEqual(first.receipts.map(receipt => [receipt.phase, receipt.exitCode]), [['check', 1], ['repair', 0], ['check', 0]]);
    assert.equal(git(repo, 'rev-parse', first.candidateRef), first.commitSha);
    assert.equal(git(repo, 'rev-parse', first.commitSha + '^'), source);
    assert.equal(git(repo, 'show', first.commitSha + ':policy.txt'), 'PASS');
    assert.equal(git(repo, 'rev-parse', 'HEAD'), source);
    assert.equal(fs.readFileSync(path.join(repo, 'policy.txt'), 'utf8'), 'FAIL\n');
    assert.equal(upstream(), baseline);
    const workspace = (await status()).workspace;
    assert.ok(workspace && workspace !== repo);
    assert.equal(git(repo, 'worktree', 'list', '--porcelain').split(/\r?\n/).filter(line => line.startsWith('worktree ')).length, 2);

    await fixture.restartWorkflow();
    assert.equal((await status()).workspace, workspace);
    await appendBoundary();
    assert.equal((await getRuns(review, 'commit')).length, 1, 'dedupe persists across service restart');
    review = await save({ ...review, expectedRevision: review.revision, delivery: 'push' });
    await assert.rejects(save({ ...review, expectedRevision: review.revision - 1 }), /409/);
    fs.writeFileSync(path.join(repo, 'second-source.txt'), 'This local commit must stay local\n');
    await gitAsync(repo, 'add', 'second-source.txt');
    await gitAsync(repo, 'commit', '-qm', 'second unpublished source commit');
    const next = await until(() => getRuns(review, 'commit'), runs => runs.length === 2, 'second Git boundary');
    const unpushed = await waitRun(next[0].runId);
    assert.equal(unpushed.delivery, 'remote-changed', JSON.stringify(unpushed));
    assert.equal(upstream(), baseline);
    assert.equal((await status()).workspace, workspace);

    fakeTime = new Date('2031-01-20T00:58:00.000Z');
    await control(true);
    const schedule = { kind: 'daily', at: '09:00' };
    const formatter = await save({ title: '日常格式整理', toolId: 'format', trigger: schedule, delivery: 'push' });
    const docs = await save({ title: '更新项目文档', toolId: 'docs', trigger: schedule, delivery: 'push' });
    assert.equal((await status()).queueLength, 0);
    fakeTime = new Date('2031-01-20T01:00:00.000Z');
    const dailyQueue = await until(status, data => data.queueLength === 2, '09:00 China time schedule');
    const formatQueued = dailyQueue.runs.find(run => run.jobId === formatter.jobId);
    const docsQueued = dailyQueue.runs.find(run => run.jobId === docs.jobId);
    assert.deepEqual(formatQueued.trigger, { kind: 'daily', date: '2031-01-20', at: '09:00', timeZone: 'Asia/Shanghai' });
    await control(false);
    const formatted = await waitRun(formatQueued.runId);
    const documented = await waitRun(docsQueued.runId);
    assert.equal(formatted.delivery, 'pushed', JSON.stringify(formatted));
    assert.equal(formatted.baseSha, baseline);
    assert.equal(documented.delivery, 'pushed', JSON.stringify(documented));
    assert.equal(documented.baseSha, formatted.commitSha, 'second write fetches the completed first write');
    assert.equal(upstream(), documented.commitSha);
    assert.equal(git(remote, 'show', 'main:docs/usage.md'), '# Formatted repository');
    assert.equal(git(repo, 'status', '--porcelain'), '');
    assert.equal((await status()).workspace, workspace);
    fakeTime = new Date('2031-01-20T01:10:00.000Z');
    await fixture.restartWorkflow();
    const noOp = await runNow(formatter, 'manual-idempotent');
    assert.equal((await runNow(formatter, 'manual-idempotent')).runId, noOp.runId);
    assert.equal((await waitRun(noOp.runId)).delivery, 'no-changes');
    assert.equal((await getRuns(formatter, 'daily')).length, 1);
    assert.equal((await getRuns(docs, 'daily')).length, 1);

    const reject = await save({ title: '无法修复的规则', toolId: 'reject', trigger: { kind: 'manual' } });
    const failed = await waitRun((await runNow(reject)).runId);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.reason, 'review-findings');
    assert.deepEqual(failed.receipts.map(item => item.exitCode), [1, 0, 1]);
    assert.equal(failed.commitSha, undefined);
    const heldRun = await runNow(formatter);
    await until(status, data => data.waitReason === 'workspace-dirty', 'dirty maintenance worktree held');
    const unresolved = path.join(workspace, 'unresolved.txt');
    assert.match(fs.readFileSync(unresolved, 'utf8'), /Keep this/);
    fs.renameSync(unresolved, path.join(options.dataDir, 'preserved-failed-review.txt'));
    assert.equal((await waitRun(heldRun.runId)).delivery, 'no-changes');

    const timeout = await save({ title: '超时后保护', toolId: 'timeout', trigger: { kind: 'manual' } });
    const interrupted = await waitRun((await runNow(timeout)).runId);
    assert.equal(interrupted.status, 'interrupted');
    assert.equal(interrupted.receipts[0].error, 'command-timeout');
    assert.equal((await status()).hold.runId, interrupted.runId);
    const queuedAfterTimeout = await runNow(formatter);
    assert.equal((await detail(queuedAfterTimeout.runId)).status, 'queued');
    await assert.rejects(control(false, { clearHold: true, holdRunId: 'stale' }), /409/);
    const leftovers = path.join(workspace, 'timed-out.txt');
    fs.renameSync(leftovers, path.join(options.dataDir, 'preserved-timeout.txt'));
    await control(false, { clearHold: true, holdRunId: interrupted.runId });
    assert.equal((await waitRun(queuedAfterTimeout.runId)).delivery, 'no-changes');
    const pushProbe = await save({ title: '本机授权变更', toolId: 'probe', trigger: { kind: 'manual' }, delivery: 'push' });
    const registry = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    fs.writeFileSync(configPath, JSON.stringify({ ...registry, allowPush: false }));
    await fixture.restartWorkflow();
    const candidate = await waitRun((await runNow(pushProbe)).runId);
    assert.equal(candidate.delivery, 'candidate');
    assert.equal(git(repo, 'show', candidate.commitSha + ':push-permission.txt'), 'This candidate should stay local');
    assert.equal(upstream(), documented.commitSha);
    assert.equal(git(repo, 'status', '--porcelain'), '');
    assert.equal(git(repo, 'worktree', 'list', '--porcelain').split(/\r?\n/).filter(line => line.startsWith('worktree ')).length, 2);
    console.log(JSON.stringify({
      passed: ['real managed Git hook and Bridge', 'commit repair and bounded retry', 'busy and dirty guards',
        'persistent trigger dedupe', 'worktree reuse', 'schedule and serial remote baselines', 'true fast-forward push',
        'unpushed source stays local', 'push permission revocation', 'timeout hold and resume', 'JSON, origin and job permissions'],
      workspace, reviewCommit: first.commitSha, remoteTip: documented.commitSha,
    }));
  } finally {
    const closed = await fixture.close();
    assert.ok(closed.every(item => item.status === 'fulfilled'), JSON.stringify(closed));
  }
}

main().catch(error => { console.error(error.stack); process.exitCode = 1; });
