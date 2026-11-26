'use strict';

// 真实的知识库、工作流模块、事件桥接和受管理的 Git 钩子，在隔离的数据目录里跑完整的维护流程。
// 登记第二个仓库以后：提交只触发提交所在的那个仓库，第一个仓库被开发占用不影响第二个仓库运行。
//
// A real knowledge base, workflow module, Event Bridge and managed Git hook run the whole maintenance flow in an
// isolated data directory. With a second repository registered: a commit triggers only the repository it was made
// in, and the first repository being marked as busy with development does not stop the second one.

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
  const options = cliOptions({ test: true });
  let fakeTime;
  const fixture = await createAiTeamUiFixture({
    ...options, maintenance: true, emptyTeam: false,
    maintenanceTiming: { pollMs: 150, bridgePollMs: 250, clock: () => fakeTime || new Date() },
  });
  try {
    const { repo, remote, baseline, projectId, journalId, bridge, git, gitAsync, appendBoundary, second } = fixture.maintenance;
    const status = () => fixture.call('maintenance');
    const post = (route, body) => fixture.call('maintenance/' + route, { method: 'POST', body });
    const detail = runId => fixture.call('maintenance/runs/' + runId).then(value => value.run);
    const upstream = () => git(remote, 'rev-parse', 'refs/heads/main');
    const terminal = run => !['queued', 'running'].includes(run.status);
    const waitRun = id => until(() => detail(id), terminal, 'run ' + id);
    const getRuns = async (job, kind) => (await status()).runs.filter(run => run.jobId === job.jobId && run.trigger.kind === kind);
    // 第一个仓库在状态里的条目 / the first repository's entry in the status payload
    const first = async () => (await status()).repos.find(item => item.projectId === projectId);
    let requestIndex = 0;
    const save = fields => post('jobs', {
      requestId: 'job-' + (++requestIndex), memberId: fixture.members[0].memberId,
      enabled: true, delivery: 'candidate', ...fields,
    }).then(value => value.job);
    // 占用和解除保护：不指定仓库时落到当时唯一登记的那个 / occupancy and releasing a hold: without a repository they fall to the only one registered at the time
    const control = (busy, fields = {}) => post('control', { requestId: 'control-' + (++requestIndex), busy, ...fields });
    const runNow = (job, id) => post('runs', { requestId: id || 'run-' + (++requestIndex), jobId: job.jobId }).then(value => value.run);

    const available = await status();
    assert.equal(available.configured, true);
    assert.equal(available.repos.length, 1);
    assert.equal(available.repos[0].projectId, projectId);
    assert.equal(available.repos[0].workspace, null);
    assert.equal(available.timeZone, 'Asia/Shanghai');
    assert.deepEqual(available.parallel, { running: 0, limit: 3 });
    assert.ok(available.tools.every(tool => !tool.phases && !tool.command));
    const repoId = available.repos[0].repoId;
    // 0.2.3 的登记文件在启动时导入模块存储一次；页面编辑工具用的完整定义经知识库代理读取。
    // The 0.2.3 registration file is imported into the module store once at startup; the full definitions
    // the page edits with are read through the shell's proxy.
    const stored = JSON.parse(fs.readFileSync(path.join(fixture.workflowData, 'workflow', 'state.json'), 'utf8'));
    assert.equal('maintenanceRegistry' in stored, false, 'the retired single-repository key is never written');
    assert.equal('maintenance' in stored, false);
    assert.deepEqual(Object.keys(stored.maintenanceRepos), [repoId]);
    assert.deepEqual(Object.keys(stored.maintenanceTools), ['review', 'format', 'docs', 'reject', 'timeout', 'probe']);
    assert.deepEqual(stored.maintenanceJobs, {});
    assert.deepEqual((stored.changes || []).filter(change => change.kind === 'maintenance.registry-imported')
      .map(change => [change.source, change.toolCount]), [['maintenance.json', 6]], 'the 0.2.3 registration file is imported once');
    const definitions = await fixture.call('maintenance/tools');
    assert.deepEqual(definitions.tools.map(tool => tool.id), ['review', 'format', 'docs', 'reject', 'timeout', 'probe']);
    assert.ok(definitions.tools.every(tool => Array.isArray(tool.phases.check || tool.phases.apply)), 'full definitions carry their commands');
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
    assert.deepEqual(review.repoIds, [repoId], 'a plan saved without a choice covers the registered repositories');
    assert.deepEqual(await getRuns(review, 'commit'), []);
    await control(true);
    fs.writeFileSync(path.join(repo, 'policy.txt'), 'FAIL\n');
    await gitAsync(repo, 'add', 'policy.txt');
    await gitAsync(repo, 'commit', '-qm', 'source commit from development');
    const source = git(repo, 'rev-parse', 'HEAD');
    const queued = await until(() => getRuns(review, 'commit'), runs => runs.length === 1, 'real managed Git hook');
    assert.deepEqual([queued[0].trigger.commitSha, queued[0].status, queued[0].repoId], [source, 'queued', repoId]);
    assert.equal((await first()).workspace, null);
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
    await until(first, data => data.waitReason === 'original-busy', 'uncommitted original work held');
    assert.equal(fs.readFileSync(devFile, 'utf8'), 'Development workspace only\n');
    assert.equal((await first()).workspace, null);
    fs.unlinkSync(devFile);

    const firstRun = await waitRun(queued[0].runId);
    assert.equal(firstRun.status, 'succeeded', JSON.stringify(firstRun));
    assert.equal(firstRun.delivery, 'candidate');
    assert.equal(firstRun.baseSha, source);
    assert.deepEqual(firstRun.receipts.map(receipt => [receipt.phase, receipt.exitCode]), [['check', 1], ['repair', 0], ['check', 0]]);
    assert.equal(git(repo, 'rev-parse', firstRun.candidateRef), firstRun.commitSha);
    assert.equal(git(repo, 'rev-parse', firstRun.commitSha + '^'), source);
    assert.equal(git(repo, 'show', firstRun.commitSha + ':policy.txt'), 'PASS');
    assert.equal(git(repo, 'rev-parse', 'HEAD'), source);
    assert.equal(fs.readFileSync(path.join(repo, 'policy.txt'), 'utf8'), 'FAIL\n');
    assert.equal(upstream(), baseline);
    const workspace = (await first()).workspace;
    assert.ok(workspace && workspace !== repo);
    assert.equal(git(repo, 'worktree', 'list', '--porcelain').split(/\r?\n/).filter(line => line.startsWith('worktree ')).length, 2);

    await fixture.restartWorkflow();
    assert.equal((await first()).workspace, workspace);
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
    assert.equal((await first()).workspace, workspace);

    // ── 第二个仓库：经知识库受信转发登记，带上真实的事件桥接日志和受管理的 Git 钩子 ──
    // Second repository: registered through the shell's trusted forward, with its own real Bridge journal and managed Git hook.
    const runsOnFirst = (await status()).runs.filter(run => run.repoId === repoId).length;
    const firstHead = git(repo, 'rev-parse', 'HEAD');
    const registered = await post('repos', { requestId: 'register-second', projectId: second.projectId, branch: '', remote: 'origin', allowPush: true });
    assert.deepEqual([registered.created, registered.repo.projectId, registered.repo.branch], [true, second.projectId, 'main'], 'a blank branch means the repository current branch');
    const secondRepoId = registered.repo.repoId;
    const secondJournalId = await second.registerProject();
    second.installHook(process.env.KB_DATA_DIR, Number(new URL(fixture.address).port));
    await fixture.restartWorkflow();
    const twoRepos = await status();
    assert.equal(twoRepos.repos.length, 2, 'both repositories survive a service restart');
    assert.deepEqual(twoRepos.repos.map(item => [item.repoId, item.busy, item.workspace !== null]), [[repoId, false, true], [secondRepoId, false, false]]);
    assert.deepEqual((await bridge.listConsumers()).find(item => item.name === 'workflow:default').meta.journals, ['global', journalId, secondJournalId].sort(),
      'the journal of each registered repository is protected');
    const secondUpstream = git(second.remote, 'rev-parse', 'refs/heads/main');
    const both = await save({ title: '两个仓库提交后检查', toolId: 'review', trigger: { kind: 'commit' }, repoIds: [repoId, secondRepoId] });
    const onlyFirst = await save({ title: '只管第一个仓库', toolId: 'review', trigger: { kind: 'commit' }, repoIds: [repoId] });
    // 不带 repoId 的运行和占用请求，在登记了多个仓库以后不再落到「唯一那个」
    // Once several repositories are registered, a run or occupancy request naming none no longer falls to "the only one"
    await assert.rejects(runNow(both, 'run-names-no-repository'), /400/, 'a run names its repository');
    await assert.rejects(control(true, { requestId: 'control-names-no-repository' }), /400/, 'occupancy names its repository');
    await assert.rejects(post('runs', { requestId: 'run-not-bound', jobId: onlyFirst.jobId, repoId: secondRepoId }), /400/, 'a plan cannot run where it is not bound');
    // 第一个仓库正被开发占用；第二个仓库照常接收触发并运行
    // The first repository is marked as busy with development; the second one still takes its trigger and runs
    await control(true, { repoId });
    assert.deepEqual((await status()).repos.map(item => item.busy), [true, false], 'occupancy belongs to one repository');
    fs.writeFileSync(path.join(second.repo, 'policy.txt'), 'FAIL\n');
    await gitAsync(second.repo, 'add', 'policy.txt');
    await gitAsync(second.repo, 'commit', '-qm', 'commit made in the second repository');
    const secondSha = git(second.repo, 'rev-parse', 'HEAD');
    const routed = await until(async () => (await status()).runs.filter(run => run.trigger.commitSha === secondSha), runs => runs.length === 1, 'the managed Git hook of the second repository');
    assert.deepEqual([routed[0].repoId, routed[0].projectId, routed[0].jobId],
      [secondRepoId, second.projectId, both.jobId], 'the commit is routed to its own repository and to the plans bound to it');
    // 这个仓库没有被占用，所以任务可能已经被认领 / this repository is not marked occupied, so the run may already have been claimed
    assert.ok(['queued', 'running'].includes(routed[0].status), JSON.stringify(routed[0]));
    const secondWatermark = await bridge.getHighWatermark({ journalId: secondJournalId });
    await until(() => fixture.call('consumer'), result => result.cursors[secondJournalId] === secondWatermark, 'the second journal processed');
    assert.equal((await getRuns(both, 'commit')).length, 1, 'one run in the repository the commit was made in');
    assert.equal((await getRuns(onlyFirst, 'commit')).length, 0, 'a plan that does not include this repository is not triggered by its commit');
    assert.equal((await status()).runs.filter(run => run.repoId === repoId).length, runsOnFirst, 'the other repository is left alone');
    const onSecond = await waitRun(routed[0].runId);
    assert.equal(onSecond.status, 'succeeded', JSON.stringify(onSecond));
    assert.deepEqual(onSecond.receipts.map(receipt => [receipt.phase, receipt.exitCode]), [['check', 1], ['repair', 0], ['check', 0]]);
    assert.equal(onSecond.baseSha, secondSha);
    assert.equal(git(second.repo, 'show', onSecond.commitSha + ':policy.txt'), 'PASS', 'the tool repaired the second repository in its own worktree');
    assert.equal(git(second.repo, 'rev-parse', 'HEAD'), secondSha, 'the original working copy of the second repository is untouched');
    assert.equal(fs.readFileSync(path.join(second.repo, 'policy.txt'), 'utf8'), 'FAIL\n');
    assert.equal(git(second.remote, 'rev-parse', 'refs/heads/main'), secondUpstream, 'nothing is pushed for a plan that keeps candidate commits');
    const secondWorkspace = (await status()).repos.find(item => item.repoId === secondRepoId).workspace;
    assert.ok(secondWorkspace && secondWorkspace !== workspace, 'each repository has its own maintenance worktree');
    assert.equal(git(repo, 'worktree', 'list', '--porcelain').split(/\r?\n/).filter(line => line.startsWith('worktree ')).length, 2, 'the first repository gains no worktree from the second one');
    assert.equal(git(second.repo, 'worktree', 'list', '--porcelain').split(/\r?\n/).filter(line => line.startsWith('worktree ')).length, 2);
    assert.equal(git(repo, 'rev-parse', 'HEAD'), firstHead);
    assert.equal((await first()).busy, true, 'the first repository is still held by development throughout');
    // 仍有计划使用的仓库删不掉，提示里列出计划；计划删掉以后才能删，记录归档
    // A repository still used by plans is not deleted and the plans are named; once they are gone it can be deleted and its records are archived
    await assert.rejects(post('repos/delete', { requestId: 'delete-while-used', repoId: secondRepoId }),
      error => /409/.test(error.message) && error.message.includes('两个仓库提交后检查') && error.message.includes('只管第一个仓库') === false,
      'only the plans that include the repository are named');
    await post('jobs/delete', { requestId: 'delete-both', jobId: both.jobId });
    await post('jobs/delete', { requestId: 'delete-only-first', jobId: onlyFirst.jobId });
    await post('repos/delete', { requestId: 'delete-second', repoId: secondRepoId });
    assert.equal((await status()).repos.length, 1);
    const archived = JSON.parse(fs.readFileSync(path.join(fixture.workflowData, 'workflow', 'state.json'), 'utf8')).maintenanceArchive[secondRepoId];
    assert.deepEqual([archived.projectId, archived.runs.length], [second.projectId, 1], 'the removed repository keeps its records');
    await control(false, { repoId });
    assert.equal((await first()).busy, false);

    fakeTime = new Date('2031-01-20T00:58:00.000Z');
    await control(true);
    const schedule = { kind: 'daily', at: '09:00' };
    const formatter = await save({ title: '日常格式整理', toolId: 'format', trigger: schedule, delivery: 'push' });
    const docs = await save({ title: '更新项目文档', toolId: 'docs', trigger: schedule, delivery: 'push' });
    assert.equal((await first()).queueLength, 0);
    fakeTime = new Date('2031-01-20T01:00:00.000Z');
    const dailyQueue = await until(status, data => data.repos.find(item => item.repoId === repoId).queueLength === 2, '09:00 China time schedule');
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
    assert.equal((await first()).workspace, workspace);
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
    await until(first, data => data.waitReason === 'workspace-dirty', 'dirty maintenance worktree held');
    const unresolved = path.join(workspace, 'unresolved.txt');
    assert.match(fs.readFileSync(unresolved, 'utf8'), /Keep this/);
    fs.renameSync(unresolved, path.join(options.dataDir, 'preserved-failed-review.txt'));
    assert.equal((await waitRun(heldRun.runId)).delivery, 'no-changes');

    const timeout = await save({ title: '超时后保护', toolId: 'timeout', trigger: { kind: 'manual' } });
    const interrupted = await waitRun((await runNow(timeout)).runId);
    assert.equal(interrupted.status, 'interrupted');
    assert.equal(interrupted.receipts[0].error, 'command-timeout');
    assert.equal((await first()).hold.runId, interrupted.runId);
    const queuedAfterTimeout = await runNow(formatter);
    assert.equal((await detail(queuedAfterTimeout.runId)).status, 'queued');
    await assert.rejects(control(false, { clearHold: true, holdRunId: 'stale' }), /409/);
    const leftovers = path.join(workspace, 'timed-out.txt');
    fs.renameSync(leftovers, path.join(options.dataDir, 'preserved-timeout.txt'));
    await control(false, { clearHold: true, holdRunId: interrupted.runId });
    assert.equal((await waitRun(queuedAfterTimeout.runId)).delivery, 'no-changes');
    const pushProbe = await save({ title: '本机授权变更', toolId: 'probe', trigger: { kind: 'manual' }, delivery: 'push' });
    // 推送授权在页面上修改，经知识库受信转发，立即生效：不改文件，也不重启。
    // Push permission is changed on the page through the shell's trusted forward and applies at once: no file edit, no restart.
    await post('repos/update', { requestId: 'revoke-push', repoId, branch: 'main', remote: 'origin', allowPush: false });
    assert.equal((await first()).allowPush, false);
    await assert.rejects(post('repos/update', { requestId: 'push-without-remote', repoId, branch: 'main', remote: '', allowPush: true }), /400/);
    const candidate = await waitRun((await runNow(pushProbe)).runId);
    assert.equal(candidate.delivery, 'candidate');
    assert.equal(git(repo, 'show', candidate.commitSha + ':push-permission.txt'), 'This candidate should stay local');
    assert.equal(upstream(), documented.commitSha);
    assert.equal(git(repo, 'status', '--porcelain'), '');
    assert.equal(git(repo, 'worktree', 'list', '--porcelain').split(/\r?\n/).filter(line => line.startsWith('worktree ')).length, 2);
    console.log(JSON.stringify({
      passed: ['real managed Git hook and Bridge', 'commit repair and bounded retry', 'busy and dirty guards',
        'persistent trigger dedupe', 'worktree reuse', 'schedule and serial remote baselines', 'true fast-forward push',
        'unpushed source stays local', 'push permission revoked from the page', 'timeout hold and resume', 'JSON, origin and job permissions',
        'second repository registered through the shell: its commit triggers only itself, runs while the first is busy, then is removed with its records archived',
        '0.2.3 registration file imported once into the module store'],
      workspace, reviewCommit: firstRun.commitSha, remoteTip: documented.commitSha,
    }));
  } finally {
    const closed = await fixture.close();
    assert.ok(closed.every(item => item.status === 'fulfilled'), JSON.stringify(closed));
  }
}

main().catch(error => { console.error(error.stack); process.exitCode = 1; });
