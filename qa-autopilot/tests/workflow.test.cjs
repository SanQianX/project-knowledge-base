'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { createGateway, tokenEqual } = require('../tools/quota-gateway.cjs');
const { encode, decode, diff } = require('../lib/png.cjs');
const { quantile, summarize, compare } = require('../tools/performance.cjs');
const { selectTests } = require('../lib/runner.cjs');
const { commandSync, hash } = require('../lib/safety.cjs');
const { snapshot, verifyReceipt } = require('../lib/git.cjs');
const token = 'test-local-token-0123456789-abcdefgh';
async function withGateway(fn) { let percent = 80, calls = 0; const g = createGateway({ queryQuota: async () => ({ state: 'KNOWN', remainingPercent: percent, checkedAt: Date.now() }), upstreamFetch: async (url, options) => { calls++; assert.match(url, /\/anthropic\/v1\/messages$/); assert.equal(options.headers.Authorization, 'Bearer private-test-key'); return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } }); }, apiKey: 'private-test-key', localToken: token, upstreamBase: 'https://api.minimax.io', model: 'MiniMax-M3.1-Flash', policy: { sampleMs: 120000, maxOutputTokens: 1024 } }); await g.sample(); await g.sample(); await new Promise(r => g.server.listen(0, '127.0.0.1', r)); const base = 'http://127.0.0.1:' + g.server.address().port; const send = (body = {}, headers = { Authorization: 'Bearer ' + token }, route = '/v1/messages') => fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ model: 'MiniMax-M3.1-Flash', max_tokens: 128, messages: [], ...body }) }); try {
    await fn({ g, send, setPercent: p => { percent = p; }, calls: () => calls });
}
finally {
    g.server.closeAllConnections();
    await new Promise(r => g.server.close(r));
} }
test('gateway token equal check', () => { assert.equal(tokenEqual('abc', 'abc'), true); assert.equal(tokenEqual('abc', 'abcd'), false); });
test('gateway authorized request proxies', () => withGateway(async ({ send, calls }) => { assert.equal((await send()).status, 200); assert.equal(calls(), 1); }));
test('gateway unauthorized blocked', () => withGateway(async ({ send, calls }) => { assert.equal((await send({}, {})).status, 401); assert.equal(calls(), 0); }));
test('gateway model mismatch blocked', () => withGateway(async ({ send, calls }) => { assert.equal((await send({ model: 'another' })).status, 503); assert.equal(calls(), 0); }));
test('gateway output bound blocked', () => withGateway(async ({ send, calls }) => { assert.equal((await send({ max_tokens: 9000 })).status, 503); assert.equal(calls(), 0); }));
test('gateway route not forwarded', () => withGateway(async ({ send, calls }) => { assert.equal((await send({}, undefined, '/admin')).status, 404); assert.equal(calls(), 0); }));
test('gateway exhaustion blocks actual next upstream call', () => withGateway(async ({ g, send, setPercent, calls }) => { await send(); setPercent(5); await g.sample(); assert.equal((await send()).status, 429); assert.equal(calls(), 1); }));
test('gateway recovery requires consecutive fresh samples', () => withGateway(async ({ g, send, setPercent, calls }) => { setPercent(0); await g.sample(); setPercent(80); await g.sample(); assert.equal((await send()).status, 429); await g.sample(); assert.equal((await send()).status, 200); assert.equal(calls(), 1); }));
function quotaError(code, httpStatus) { const e = new Error(code); e.code = code; if (httpStatus !== undefined) e.httpStatus = httpStatus; return e; }
const knownQuota = p => ({ state: 'KNOWN', remainingPercent: p, checkedAt: Date.now() });
async function withResilientGateway(fn, { queryQuota, policy = {} }) {
    const g = createGateway({ queryQuota, upstreamFetch: async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } }), apiKey: 'private-test-key', localToken: token, upstreamBase: 'https://api.minimax.io', model: 'MiniMax-M3.1-Flash', policy: { sampleMs: 120000, maxOutputTokens: 1024, quotaRetryDelayMs: 1, ...policy } });
    await new Promise(r => g.server.listen(0, '127.0.0.1', r));
    const base = 'http://127.0.0.1:' + g.server.address().port;
    const send = () => fetch(base + '/v1/messages', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify({ model: 'MiniMax-M3.1-Flash', max_tokens: 128, messages: [] }) });
    try { await fn({ g, send }); }
    finally { g.server.closeAllConnections(); await new Promise(r => g.server.close(r)); }
}
test('gateway transient quota failure is retried inside one sample and still recovers', async () => {
    let calls = 0;
    await withResilientGateway(async ({ g, send }) => {
        await g.sample();
        assert.equal(calls, 2, 'L-QUOTAFIX-001 一次瞬态失败在单次采样内有界重试，共两次真实查询');
        assert.equal(g.status().gate.state, 'WAITING_RECOVERY');
        await g.sample();
        assert.equal(g.status().gate.state, 'RUNNING');
        assert.equal((await send()).status, 200, '瞬态失败被有界重试吸收后请求照常放行');
    }, { queryQuota: async () => { calls += 1; if (calls === 1) throw quotaError('QUOTA_UNAVAILABLE'); return knownQuota(80); } });
});
test('gateway exhausted transient retries fail closed with the classified reason', async () => {
    let calls = 0;
    await withResilientGateway(async ({ g, send }) => {
        await g.sample();
        assert.equal(calls, 3, '重试有上界（1+2 次），不做无限循环');
        assert.equal(g.status().gate.state, 'UNKNOWN');
        assert.equal(g.status().gate.admitRequest, false);
        const res = await send();
        assert.equal(res.status, 429);
        const body = await res.json();
        assert.equal(body.error.code, 'QA_QUOTA_PAUSED');
        assert.equal(body.error.details.quotaReason, 'QUOTA_UNAVAILABLE', 'L-QUOTAFIX-001 429 携带脱敏失败类别，不再一律 QUERY_FAILED');
    }, { queryQuota: async () => { calls += 1; throw quotaError('QUOTA_UNAVAILABLE'); } });
});
test('gateway concurrent sampling shares one real query and advances recovery once', async () => {
    let calls = 0, release;
    const openQuery = () => new Promise(resolve => { calls += 1; release = () => resolve(knownQuota(80)); });
    await withResilientGateway(async ({ g }) => {
        const shared = [g.sample(), g.sample(), g.sample()];
        await new Promise(r => setTimeout(r, 5));
        assert.equal(calls, 1, 'L-QUOTAFIX-001 interval 与请求并发采样共享同一次真实查询');
        release();
        const gates = await Promise.all(shared);
        assert.deepEqual(gates[0], gates[1]);
        assert.deepEqual(gates[0], gates[2]);
        assert.equal(gates[0].state, 'WAITING_RECOVERY', '共享一次查询只推进一次恢复计数，不把共享 promise 算两次');
        assert.equal(gates[0].successes, 1);
        const second = g.sample();
        await new Promise(r => setTimeout(r, 5));
        assert.equal(calls, 2, '之后的采样是独立的新查询');
        release();
        await second;
        assert.equal(g.status().gate.state, 'RUNNING', '两次独立成功采样完成恢复');
    }, { queryQuota: openQuery });
});
test('gateway auth and quota-rate-limit failures are never retried', async () => {
    for (const code of ['QUOTA_AUTH', 'QUOTA_RATE_LIMIT']) {
        let calls = 0;
        await withResilientGateway(async ({ g, send }) => {
            await g.sample();
            assert.equal(calls, 1, code + ' 不做重试循环');
            assert.equal(g.status().gate.admitRequest, false, code + ' 不放行');
            const res = await send();
            assert.equal(res.status, 429);
            assert.equal((await res.json()).error.details.quotaReason, code);
        }, { queryQuota: async () => { calls += 1; throw quotaError(code); } });
    }
});
test('gateway 5xx quota failures retry, other HTTP errors do not', async () => {
    let five = 0;
    await withResilientGateway(async ({ g }) => {
        await g.sample();
        assert.equal(five, 3, 'QUOTA_HTTP 5xx 属于瞬态，按上界重试');
    }, { queryQuota: async () => { five += 1; throw quotaError('QUOTA_HTTP', 503); } });
    let four = 0;
    await withResilientGateway(async ({ g }) => {
        await g.sample();
        assert.equal(four, 1, '非 5xx HTTP 错误不重试');
        assert.equal(g.status().quota.httpStatus, 404, 'L-QUOTAFIX-001 HTTP 状态随分类保留在采样记录上');
    }, { queryQuota: async () => { four += 1; throw quotaError('QUOTA_HTTP', 404); } });
});
test('gateway stale quota still refuses fail-closed', async () => {
    let calls = 0;
    await withResilientGateway(async ({ g, send }) => {
        await g.sample(); await g.sample();
        assert.equal(g.status().gate.state, 'RUNNING');
        await new Promise(r => setTimeout(r, 80));
        assert.equal((await send()).status, 429, '样本超过 maxAgeMs 后仍拒绝新请求（fail-closed 原样）');
        assert.equal(calls, 2, '新鲜窗口内不重复采样');
    }, { queryQuota: async () => { calls += 1; return knownQuota(80); }, policy: { sampleMs: 600000, maxAgeMs: 40 } });
});
test('PNG encode decode roundtrip', () => { const x = { width: 2, height: 2, pixels: Buffer.from([0, 0, 0, 255, 255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255]) }; assert.deepEqual(decode(encode(x)), x); });
test('PNG rejects corruption', () => { const b = encode({ width: 1, height: 1, pixels: Buffer.from([1, 2, 3, 255]) }); b[30] ^= 1; assert.throws(() => decode(b)); });
test('visual exact pair passes', () => { const x = { width: 1, height: 1, pixels: Buffer.from([1, 2, 3, 255]) }; assert.equal(diff(x, x).status, 'PASS'); });
test('visual changed pixel fails', () => { const a = { width: 1, height: 1, pixels: Buffer.from([1, 2, 3, 255]) }, b = { ...a, pixels: Buffer.from([9, 2, 3, 255]) }; assert.equal(diff(a, b).status, 'FAIL'); });
test('visual dimension changes need review', () => assert.throws(() => diff({ width: 1, height: 1 }, { width: 2, height: 1 })));
test('visual permissive thresholds rejected', () => assert.throws(() => diff({ width: 1, height: 1 }, { width: 1, height: 1 }, { maxChangedRatio: 1 })));
test('performance percentiles known values', () => { assert.equal(quantile(Array.from({ length: 100 }, (_, i) => i + 1), .95), 95); assert.equal(summarize([{ ok: true, ms: 10 }, { ok: false, ms: 50 }]).errors, 1); });
test('performance requires approved baseline', () => assert.throws(() => compare({}, {}, {})));
test('performance threshold meaningful', () => { const b = { environmentId: 'env', scenario: 'a', fixtureHash: 'f', summary: { p95Ms: 100 } }, n = { ...b, summary: { p95Ms: 130, count: 100, errors: 0 } }; assert.equal(compare(n, b, { approved: true, environmentId: 'env', maxP95RegressionPercent: 10, maxErrorRate: 0 }).status, 'FAIL'); });
test('test discovery empty does not pass', () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-discovery-')); try {
    fs.mkdirSync(path.join(d, '_site/_test'), { recursive: true });
    assert.throws(() => selectTests(d, 'all', {}));
}
finally {
    fs.rmSync(d, { recursive: true, force: true });
} });
test('missing named test blocks', () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-discovery-')); try {
    fs.mkdirSync(path.join(d, '_site/_test'), { recursive: true });
    fs.writeFileSync(path.join(d, '_site/_test/a-test.js'), '');
    assert.throws(() => selectTests(d, 'suite', { suite: ['b-test.js'] }));
}
finally {
    fs.rmSync(d, { recursive: true, force: true });
} });
test('actual local Git fingerprint invalidates stale proof', () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-git-')); try {
    const git = args => commandSync('git', args, { cwd: d });
    git(['init', '-q']);
    git(['config', 'user.name', 'QA Selftest']);
    git(['config', 'user.email', 'qa@local.invalid']);
    fs.writeFileSync(path.join(d, 'a.txt'), 'a');
    git(['add', 'a.txt']);
    git(['commit', '-qm', 'base']);
    const cfg = { repoRoot: d, tools: { git: 'git' } }, contract = { bugId: 'QA-001' }, snap = snapshot(cfg), receipt = { schema: 1, kind: 'suite', status: 'PASS', exitCode: 0, executed: 1, skipped: 0, head: snap.head, fingerprint: snap.fingerprint, contractHash: hash(JSON.stringify(contract)) };
    verifyReceipt(cfg, receipt, contract);
    fs.writeFileSync(path.join(d, 'a.txt'), 'b');
    assert.throws(() => verifyReceipt(cfg, receipt, contract), { code: 'STALE_TESTS' }, 'QA-SPEC-GIT-003 源码改动后旧测试收据失效');
}
finally {
    fs.rmSync(d, { recursive: true, force: true });
} });
const { validateTag } = require('../tools/ci-rc-guard.cjs');
test('release stable tag rejected', () => assert.throws(() => validateTag('5.0.25', 'refs/tags/v5.0.25'), undefined, 'QA-SPEC-REL-001 稳定版标签不得进入候选通道'));
test('release baseline tag rejected', () => assert.throws(() => validateTag('5.0.25-rc.1', 'refs/tags/qa-baseline-20261020'), undefined, 'QA-SPEC-REL-001 基准标签不得进入候选通道'));
test('release exact RC tag accepted', () => assert.doesNotThrow(() => validateTag('5.0.25-rc.1', 'refs/tags/qa-rc/5.0.25-rc.1'), undefined, 'QA-SPEC-REL-001 只有精确的 qa-rc/x.y.z-rc.n 标签可进入候选通道'));
test('release mismatched RC number rejected', () => assert.throws(() => validateTag('5.0.25-rc.2', 'refs/tags/qa-rc/5.0.25-rc.1'), undefined, 'QA-SPEC-REL-001 序号不匹配的 RC 标签必须被拒绝'));
test('supervisor controlled quota pause resumes the same task without new Git commits', async () => {
    const { tick } = require('../tools/supervisor.cjs'), { atomicJSON, readJSON } = require('../lib/safety.cjs');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-resume-test-')), repo = path.join(dir, 'source'), qa = path.join(dir, 'control');
    fs.mkdirSync(repo);
    fs.mkdirSync(path.join(qa, 'config'), { recursive: true });
    try {
        const git = args => commandSync('git', args, { cwd: repo });
        git(['init', '-q']);
        git(['config', 'user.name', 'Selftest']);
        git(['config', 'user.email', 'selftest@local.invalid']);
        fs.writeFileSync(path.join(repo, 'a.txt'), 'baseline');
        git(['add', 'a.txt']);
        git(['commit', '-qm', 'base']);
        const quotaFile = path.join(dir, 'quota.cjs');
        fs.writeFileSync(quotaFile, "console.log(JSON.stringify({model_remains:[{model_name:'MiniMax-M3.1-Flash',current_interval_remaining_percent:80}]}));");
        const workerFile = path.join(dir, 'worker.cjs');
        fs.writeFileSync(workerFile, "const fs=require('fs');const r=JSON.parse(fs.readFileSync(process.env.QA_REQUEST_FILE,'utf8'));fs.writeFileSync(process.env.QA_RESULT_FILE,JSON.stringify({protocol:'pkb-qa-task/v1',taskId:r.id,status:'PAUSED_QUOTA',safeBoundary:true,checkpoint:{step:(r.resume?.step||0)+1}}));process.exitCode=75;");
        const cfg = { qaRoot: qa, repoRoot: repo, tools: { git: 'git', node: process.execPath }, authorization: { controllerIsolationVerified: true }, quota: { mode: 'cli', executable: process.execPath, args: [quotaFile], modelNames: ['MiniMax-M3.1-Flash'], weeklyUnlimitedApproved: true, weeklyEntitlementEvidence: 'synthetic-account', sampleMs: 1 }, worker: { adapterValidated: true, executable: process.execPath, args: [workerFile], gatewayUrl: 'http://127.0.0.1:1' } };
        const contract = { bugId: 'QA-001', allowedFiles: ['a.txt'] };
        atomicJSON(path.join(qa, 'config', 'task.json'), contract);
        const before = snapshot(cfg);
        atomicJSON(path.join(qa, 'config', 'failure.json'), { kind: 'suite', status: 'FAIL', executed: 1, head: before.head, fingerprint: before.fingerprint });
        atomicJSON(path.join(qa, 'config', 'queue.json'), { tasks: [{ id: 'QA-001', contract: 'config/task.json', approvedContractHash: hash(JSON.stringify(contract)), reproductionReceipt: 'config/failure.json', suites: ['smoke'] }] });
        async function advance() { const sf = path.join(qa, 'state', 'supervisor.json'); if (fs.existsSync(sf)) {
            const old = readJSON(sf);
            old.nextPollAt = 0;
            atomicJSON(sf, old);
        } return tick(cfg); }
        await advance();
        let state = await advance();
        assert.equal(state.task.status, 'PAUSED_QUOTA');
        assert.equal(state.task.resumeCheckpoint.step, 1, 'QA-SPEC-QTA-004 暂停后从检查点继续，不重做已完成步骤');
        await advance();
        state = await advance();
        assert.equal(state.task.resumeCheckpoint.step, 2, 'QA-SPEC-QTA-004 恢复只执行未完成动作');
        assert.equal(snapshot(cfg).head, before.head);
        assert.equal(git(['rev-list', '--count', 'HEAD']), '1', 'QA-SPEC-QTA-004 恢复过程不产生新的 Git 提交');
    }
    finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
test('controller commit does not run a configured production-like hook', () => {
    const { git } = require('../lib/git.cjs');
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-hook-boundary-'));
    try {
        const raw = a => commandSync('git', a, { cwd: d });
        raw(['init', '-q']);
        raw(['config', 'user.name', 'QA']);
        raw(['config', 'user.email', 'qa@local.invalid']);
        const hooks = path.join(d, 'danger-hooks');
        fs.mkdirSync(hooks);
        const sentinel = path.join(d, 'unexpected-hook');
        fs.writeFileSync(path.join(hooks, 'post-commit'), '#!/bin/sh\ntouch "' + sentinel + '"\n', { mode: 0o755 });
        raw(['config', 'core.hooksPath', hooks]);
        fs.writeFileSync(path.join(d, 'a.txt'), 'a');
        raw(['add', 'a.txt']);
        git({ repoRoot: d, tools: { git: 'git' } }, ['commit', '-qm', 'isolated']);
        assert.equal(fs.existsSync(sentinel), false);
    }
    finally {
        fs.rmSync(d, { recursive: true, force: true });
    }
});
