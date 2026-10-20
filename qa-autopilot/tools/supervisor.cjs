'use strict';
// Worker output is untrusted until independent verification. / 工作模型输出须经独立验证。
const fs = require('node:fs');
const path = require('node:path');
const { readJSON, atomicJSON, acquireLock, must, ownedRun, isolatedEnv, runLogged, hash, redact } = require('../lib/safety.cjs');
const { fetchQuota, quotaDecision } = require('../lib/quota.cjs');
const { snapshot, validateChanges, changedFiles, commitPush } = require('../lib/git.cjs');
const { runSuite } = require('../lib/runner.cjs');
const { ciStatus } = require('../lib/registry.cjs');
const { Store } = require('../lib/state.cjs');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function tick(cfg) {
    must(cfg.worker?.adapterValidated === true && cfg.authorization?.controllerIsolationVerified === true, 'ADAPTER_UNVERIFIED', 'Complete T03 adapter and OS isolation acceptance first.', 20);
    const statePath = path.join(cfg.qaRoot, 'state', 'supervisor.json');
    let state = fs.existsSync(statePath) ? readJSON(statePath) : { schema: 1, quotaState: 'PAUSED', recoverySamples: 0, task: null, nextPollAt: 0 };
    const save = () => atomicJSON(statePath, state);
    if (Date.now() < state.nextPollAt)
        return state;
    if (state.task?.status === 'CI_PENDING') {
        const ci = await ciStatus(cfg, state.task.sha);
        state.task.ci = ci;
        if (ci.status === 'PASS') {
            state.task.status = 'DONE';
            state.lastCompleted = state.task;
        }
        else if (ci.status === 'FAIL')
            state.task.status = 'BLOCKED_CI';
        state.nextPollAt = Date.now() + 60000;
        save();
        return state;
    }
    if (state.task && !['DONE', 'PAUSED_QUOTA'].includes(state.task.status)) {
        save();
        return state;
    }
    let q;
    try {
        q = await fetchQuota(cfg.quota);
    }
    catch {
        q = { state: 'UNKNOWN', checkedAt: Date.now() };
    }
    const gate = quotaDecision(q, cfg.quota, state.quotaState, Date.now(), state.recoverySamples);
    state.quotaState = gate.state;
    state.recoverySamples = gate.successes;
    state.quota = q;
    state.nextPollAt = Date.now() + (cfg.quota.sampleMs || 120000);
    if (!gate.admitTask) {
        save();
        return state;
    }
    const queue = readJSON(path.join(cfg.qaRoot, 'config', 'queue.json'));
    const done = fs.existsSync(path.join(cfg.qaRoot, 'state', 'completed.json')) ? readJSON(path.join(cfg.qaRoot, 'state', 'completed.json')) : [];
    if (state.lastCompleted && !done.includes(state.lastCompleted.id)) {
        done.push(state.lastCompleted.id);
        atomicJSON(path.join(cfg.qaRoot, 'state', 'completed.json'), done);
    }
    const task = queue.tasks.find(t => !done.includes(t.id));
    if (!task) {
        state.status = 'IDLE_NO_APPROVED_TASK';
        save();
        return state;
    }
    const contract = readJSON(path.join(cfg.qaRoot, task.contract));
    must(task.approvedContractHash === hash(JSON.stringify(contract)), 'CONTRACT_NOT_APPROVED', 'Task contract hash not approved by the controller.', 20);
    const failure = readJSON(path.join(cfg.qaRoot, task.reproductionReceipt));
    const base = snapshot(cfg);
    const resuming = state.task?.id === task.id && state.task.status === 'PAUSED_QUOTA';
    if (resuming) {
        must(base.head === state.task.parent && base.fingerprint === state.task.resumeFingerprint, 'PAUSE_SOURCE_CHANGED', 'Paused files changed outside the checkpoint; reconcile first.', 20);
        if (changedFiles(cfg).length)
            validateChanges(cfg, contract, changedFiles(cfg));
    }
    must(resuming || failure.kind === 'suite' && failure.status === 'FAIL' && failure.executed > 0 && failure.head === base.head && failure.fingerprint === base.fingerprint, 'REPRODUCTION_REQUIRED', 'Current-code failing evidence is required before an automatic repair.', 20);
    must(Array.isArray(task.suites) && task.suites.length > 0, 'SUITES', 'Nonempty verification suite list required.');
    must(resuming || changedFiles(cfg).length === 0, 'DIRTY_TASK_START', 'A repair task must start from a clean QA checkout.', 20);
    const run = ownedRun(cfg.qaRoot, 'agent-' + task.id + '-' + Date.now());
    const previousCheckpoint = resuming ? state.task.resumeCheckpoint : null;
    const request = { resume: previousCheckpoint, protocol: 'pkb-qa-task/v1', id: task.id, contract, sourceRoot: cfg.repoRoot, gateway: cfg.worker.gatewayUrl, allowedNewFiles: contract.allowedFiles, forbiddenActions: ['git write', 'publish', 'delete user data', 'change approvals'] };
    const requestFile = path.join(run, 'request.json'), resultFile = path.join(run, 'worker-result.json');
    request.resultFile = resultFile;
    atomicJSON(requestFile, request);
    state.task = { id: task.id, status: 'AGENT_RUNNING', parent: base.head, requestFile };
    save();
    const args = cfg.worker.args.map(a => a.replaceAll('{requestFile}', requestFile));
    const env = isolatedEnv(run, { QA_REQUEST_FILE: requestFile, QA_RESULT_FILE: resultFile, ANTHROPIC_BASE_URL: cfg.worker.gatewayUrl, ANTHROPIC_AUTH_TOKEN: process.env.QA_GATEWAY_TOKEN || '', QA_TASK_ROOT: cfg.repoRoot });
    const result = await runLogged(cfg.worker.executable, args, { cwd: cfg.repoRoot, env, logDir: path.join(cfg.qaRoot, 'artifacts', path.basename(run)), timeoutMs: cfg.worker.taskTimeoutMs || 900000, input: JSON.stringify(request) + '\n' });
    state.task.status = 'AGENT_EXITED_NEEDS_VERIFICATION';
    save();
    if (result.code === 75 && !result.timedOut) {
        const response = readJSON(resultFile), current = snapshot(cfg);
        must(response.protocol === 'pkb-qa-task/v1' && response.taskId === task.id && response.status === 'PAUSED_QUOTA' && response.safeBoundary === true, 'PAUSE_PROTOCOL', 'Adapter must report a validated safe pause boundary.', 20);
        must(current.head === base.head, 'WORKER_GIT_WRITE', 'Worker changed Git history.');
        if (changedFiles(cfg).length)
            validateChanges(cfg, contract, changedFiles(cfg));
        state.task = { ...state.task, status: 'PAUSED_QUOTA', resumeFingerprint: current.fingerprint, resumeCheckpoint: response.checkpoint || null };
        state.quotaState = 'PAUSED';
        state.recoverySamples = 0;
        save();
        return state;
    }
    if (result.code !== 0 || result.timedOut) {
        state.task.status = 'BLOCKED_AGENT';
        save();
        return state;
    }
    validateChanges(cfg, contract, changedFiles(cfg));
    const receipts = [];
    for (const suite of task.suites)
        receipts.push(await runSuite(cfg, suite, contract));
    if (receipts.some(r => r.status !== 'PASS')) {
        state.task.status = 'BLOCKED_VERIFICATION';
        state.task.receipts = receipts.map(r => r.receiptPath);
        save();
        return state;
    }
    const last = receipts[receipts.length - 1];
    must(receipts.every(r => r.fingerprint === last.fingerprint), 'MUTATING_TESTS', 'Source changed between test suites.');
    const combined = { ...last, suite: task.suites.join('+'), executed: receipts.reduce((n, r) => n + r.executed, 0), results: receipts.flatMap(r => r.results) };
    atomicJSON(path.join(cfg.qaRoot, 'artifacts', path.basename(run), 'combined-verification.json'), combined);
    const pushed = commitPush(cfg, contract, combined, new Store(path.join(cfg.qaRoot, 'state')), true);
    state.task = { ...state.task, status: 'CI_PENDING', sha: pushed.sha };
    save();
    return state;
}
async function main() {
    const cfg = readJSON(process.argv[2]);
    const release = acquireLock(path.join(cfg.qaRoot, 'state', 'supervisor.lock'));
    let stopping = false;
    process.on('SIGINT', () => { stopping = true; });
    process.on('SIGTERM', () => { stopping = true; });
    try {
        do {
            try {
                console.log(JSON.stringify(await tick(cfg)));
            }
            catch (e) {
                atomicJSON(path.join(cfg.qaRoot, 'state', 'supervisor-blocked.json'), { status: 'BLOCKED', code: e.code || 'ERROR', message: redact(e.message), at: new Date().toISOString() });
                throw e;
            }
            if (process.argv.includes('--once'))
                break;
            await sleep(15000);
        } while (!stopping);
    }
    finally {
        release();
    }
}
if (require.main === module)
    main().catch(e => { console.error(redact(e.message)); process.exitCode = 20; });
module.exports = { tick };
