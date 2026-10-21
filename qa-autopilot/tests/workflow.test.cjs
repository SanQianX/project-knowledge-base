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
    assert.throws(() => verifyReceipt(cfg, receipt, contract), { code: 'STALE_TESTS' });
}
finally {
    fs.rmSync(d, { recursive: true, force: true });
} });
const { validateTag } = require('../tools/ci-rc-guard.cjs');
test('release stable tag rejected', () => assert.throws(() => validateTag('5.0.25', 'refs/tags/v5.0.25')));
test('release baseline tag rejected', () => assert.throws(() => validateTag('5.0.25-rc.1', 'refs/tags/qa-baseline-20261020')));
test('release exact RC tag accepted', () => assert.doesNotThrow(() => validateTag('5.0.25-rc.1', 'refs/tags/qa-rc/5.0.25-rc.1')));
test('release mismatched RC number rejected', () => assert.throws(() => validateTag('5.0.25-rc.2', 'refs/tags/qa-rc/5.0.25-rc.1')));
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
        assert.equal(state.task.resumeCheckpoint.step, 1);
        await advance();
        state = await advance();
        assert.equal(state.task.resumeCheckpoint.step, 2);
        assert.equal(snapshot(cfg).head, before.head);
        assert.equal(git(['rev-list', '--count', 'HEAD']), '1');
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
