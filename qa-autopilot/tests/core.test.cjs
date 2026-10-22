'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const s = require('../lib/safety.cjs'), q = require('../lib/quota.cjs'), g = require('../lib/git.cjs'), { Store } = require('../lib/state.cjs'), r = require('../lib/registry.cjs');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'qa-selftest-'));
const clean = p => fs.rmSync(p, { recursive: true, force: true });
const IS_WINDOWS = process.platform === 'win32';
// Windows creates a true symbolic link only with SeCreateSymbolicLinkPrivilege
// (administrator rights or developer mode); a directory junction needs no extra privilege.
// Node's lstat reports a junction as isSymbolicLink() === true, so the safety check rejects
// junctions and symbolic links through the very same branch.
// 真正的符号链接在 Windows 上需要特权；目录联接不需要，lstat 同样报告为符号链接。
function createLink(link, target, kind) {
    try {
        fs.symlinkSync(target, link, kind);
        return kind;
    }
    catch (e) {
        if (kind !== 'dir' || !IS_WINDOWS || !['EPERM', 'EACCES'].includes(e.code))
            throw e;
        fs.symlinkSync(target, link, 'junction');
        return 'junction';
    }
}
const quotaCfg = { modelNames: ['MiniMax-M3.1-Flash'], weeklyUnlimitedApproved: true, weeklyEntitlementEvidence: 'human-receipt' };
const raw = p => ({ model_remains: [{ model_name: 'MiniMax-M3.1-Flash', current_interval_remaining_percent: p }] });
for (const p of [0, 1, 10, 20, 35, 99, 100])
    test('quota explicit ' + p, () => assert.equal(q.normalizeQuota(raw(p), quotaCfg).remainingPercent, p, 'QA-SPEC-QTA-002 明确百分比优先于任何计数推断'));
for (const p of [-1, 101, NaN, Infinity, '80', null])
    test('invalid quota percent ' + String(p), () => assert.equal(q.normalizeQuota(raw(p), quotaCfg).state, 'UNKNOWN'));
test('ambiguous usage never inferred', () => assert.equal(q.normalizeQuota({ model_remains: [{ model_name: 'MiniMax-M3.1-Flash', current_interval_usage_count: 20, current_interval_total_count: 100 }] }, quotaCfg).reason, 'AMBIGUOUS_USAGE_COUNT', 'QA-SPEC-QTA-002 usage_count 没有语义证据时不得推断百分比'));
for (const meaning of ['used', 'remaining'])
    test('verified count ' + meaning, () => assert.equal(q.normalizeQuota({ model_remains: [{ model_name: 'MiniMax-M3.1-Flash', current_interval_usage_count: 20, current_interval_total_count: 100 }] }, { ...quotaCfg, verifiedCountMeaning: meaning, countMeaningEvidence: 'reviewed' }).remainingPercent, meaning === 'used' ? 80 : 20, 'QA-SPEC-QTA-002 已有审查证据时按明确含义换算百分比'));
test('unknown weekly blocks', () => assert.equal(q.normalizeQuota(raw(80), { modelNames: quotaCfg.modelNames }).state, 'UNKNOWN', 'QA-SPEC-QTA-001 没有周权益证据时不得推定旧套餐额度'));
test('weekly minimum used', () => { const b = raw(80); b.model_remains[0].weekly = 12; assert.equal(q.normalizeQuota(b, { modelNames: quotaCfg.modelNames, weeklyPercentField: 'weekly' }).remainingPercent, 12, 'QA-SPEC-QTA-001 已证实的周权益按最小值计入可用额度'); });
test('duplicate model rows block', () => { const b = raw(80); b.model_remains.push(b.model_remains[0]); assert.equal(q.normalizeQuota(b, quotaCfg).reason, 'MODEL_MAPPING_REQUIRED'); });
test('account balance not quota', () => assert.equal(q.normalizeQuota({ balance: 99 }, quotaCfg).state, 'UNKNOWN', 'QA-SPEC-QTA-001 PAYG 余额不得当作五小时额度'));
test('upstream application failure blocks', () => assert.equal(q.normalizeQuota({ ...raw(99), base_resp: { status_code: 1000 } }, quotaCfg).state, 'UNKNOWN', 'QA-SPEC-QTA-005 上游业务失败归类为 UNKNOWN 并阻断新调用'));
const quotaUrl = 'https://api.minimax.io/v1/token_plan/remains';
const quotaKeyEnv = 'QA_SELFTEST_QUOTA_KEY';
async function withStubbedFetch(handler, fn) {
    const original = globalThis.fetch;
    globalThis.fetch = handler;
    try { return await fn(); }
    finally { globalThis.fetch = original; }
}
async function quotaHttpCall(response) {
    process.env[quotaKeyEnv] = 'qa-selftest-subscription-key';
    try { return await q.fetchQuota({ mode: 'http', url: quotaUrl, keyEnv: quotaKeyEnv }); }
    finally { delete process.env[quotaKeyEnv]; }
}
test('quota upstream 401 is classified as auth failure', async () => {
    await withStubbedFetch(async () => new Response('{}', { status: 401 }), async () => {
        await assert.rejects(() => quotaHttpCall(), { code: 'QUOTA_AUTH' }, 'QA-SPEC-QTA-005 401 单独归类为鉴权失败，不当成额度耗尽');
    });
});
test('quota upstream 429 is classified as rate limit', async () => {
    await withStubbedFetch(async () => new Response('{}', { status: 429 }), async () => {
        await assert.rejects(() => quotaHttpCall(), { code: 'QUOTA_RATE_LIMIT' }, 'QA-SPEC-QTA-005 429 单独归类为限流，不得据此推断订阅耗尽');
    });
});
test('quota upstream 503 is classified as unavailable', async () => {
    await withStubbedFetch(async () => new Response('{}', { status: 503 }), async () => {
        await assert.rejects(() => quotaHttpCall(), { code: 'QUOTA_HTTP' }, 'QA-SPEC-QTA-005 503 归类为端点不可用，不是额度状态');
    });
});
test('quota upstream timeout is classified as unknown', async () => {
    await withStubbedFetch(async () => { const e = new Error('timeout'); e.name = 'TimeoutError'; throw e; }, async () => {
        await assert.rejects(() => quotaHttpCall(), { code: 'QUOTA_TIMEOUT' }, 'QA-SPEC-QTA-005 超时单独归类，不得当作额度充足或耗尽');
    });
});
test('quota PAYG key is refused without fallback', async () => {
    process.env[quotaKeyEnv] = 'sk-api-0123456789abcdef0123456789abcdef';
    try {
        await assert.rejects(() => q.fetchQuota({ mode: 'http', url: quotaUrl, keyEnv: quotaKeyEnv }), { code: 'SUBSCRIPTION_KEY_REQUIRED' }, 'QA-SPEC-QTA-005 拒绝 PAYG 余额代替订阅额度，不自动购买积分');
    }
    finally { delete process.env[quotaKeyEnv]; }
});
test('unknown quota admits no task and no request', () => {
    const x = q.quotaDecision({ state: 'UNKNOWN', checkedAt: 1000 }, {}, 'RUNNING', 1000);
    assert.equal(x.admitTask, false, 'QA-SPEC-QTA-005 额度未知时不派发新任务');
    assert.equal(x.admitRequest, false, 'QA-SPEC-QTA-005 额度未知时不转发新模型调用');
});
const known = p => ({ state: 'KNOWN', remainingPercent: p, checkedAt: 1000 });
for (const [p, task] of [[5, false], [10, false], [11, false], [20, false], [21, true]])
    test('quota task threshold ' + p, () => assert.equal(q.quotaDecision(known(p), {}, 'RUNNING', 1000).admitTask, task, 'QA-SPEC-QTA-003 额度 ≤20% 不派发新任务，>20% 才允许派发'));
for (const [p, req] of [[5, false], [10, false], [11, true], [20, true], [21, true]])
    test('quota request threshold ' + p, () => assert.equal(q.quotaDecision(known(p), {}, 'RUNNING', 1000).admitRequest, req, 'QA-SPEC-QTA-003 额度 ≤10% 不转发新模型调用；额度尚可时在途请求不受影响'));
for (const [p, state] of [[5, 'PAUSED'], [10, 'PAUSED'], [11, 'DRAINING'], [20, 'DRAINING'], [21, 'RUNNING']])
    test('quota state ' + p, () => assert.equal(q.quotaDecision(known(p), {}, 'RUNNING', 1000).state, state, 'QA-SPEC-QTA-006 额度不足时提前暂停新任务，并明确承认在途调用无法保证永不耗尽'));
test('recovery requires two samples', () => { const a = q.quotaDecision(known(80), {}, 'PAUSED', 1000); assert.equal(a.admitTask, false, 'QA-SPEC-QTA-004 恢复需要连续两次新鲜样本，不按固定时长等待'); assert.equal(q.quotaDecision(known(80), {}, a.state, 1000, a.successes).admitTask, true, 'QA-SPEC-QTA-004 连续新鲜样本达标后恢复派发'); });
test('recovery hysteresis', () => assert.equal(q.quotaDecision(known(30), {}, 'PAUSED', 1000, 3).admitTask, false, 'QA-SPEC-QTA-004 恢复阈值高于停止阈值，避免反复抖动'));
test('stale quota blocks', () => assert.equal(q.quotaDecision(known(80), {}, 'RUNNING', 200000).admitRequest, false, 'QA-SPEC-QTA-006 采样陈旧时拒绝新请求（共享消耗的可见部分）'));
test('future quota blocks', () => assert.equal(q.quotaDecision({ ...known(80), checkedAt: 99999 }, {}, 'RUNNING', 1000).admitRequest, false));
test('NaN normalized quota blocks', () => assert.equal(q.quotaDecision(known(NaN), {}, 'RUNNING', 1000).admitTask, false));
test('invalid thresholds reject', () => assert.throws(() => q.quotaDecision(known(80), { stopTaskPercent: 50, resumePercent: 35 }, 'RUNNING', 1000)));
for (const p of ['../escape', '/etc/passwd'])
    test('path escape ' + p, () => assert.throws(() => s.inside('/tmp/owner', path.resolve('/tmp/owner', p))));
test('prefix sibling denied', () => assert.throws(() => s.inside('/tmp/owner', '/tmp/owner-other/x')));
test('root requires explicit approval', () => assert.throws(() => s.inside('/tmp/owner', '/tmp/owner')));
test('symlink rejected', () => { const d = tmp(); try {
    fs.mkdirSync(path.join(d, 'real'));
    let kind;
    try {
        fs.symlinkSync(path.join(d, 'real'), path.join(d, 'link'), 'dir');
        kind = 'symbolic link';
    }
    catch (e) {
        // The OS refuses a true symbolic link. Prove the refusal is exactly the documented
        // privilege limitation, then verify the same rejection through the junction that
        // Node also reports as a symbolic link. The link check never stops running.
        assert.equal(IS_WINDOWS, true, 'symbolic link creation failed for an unexpected reason: ' + e.code);
        assert.ok(['EPERM', 'EACCES'].includes(e.code), 'unexpected symbolic link failure: ' + e.code);
        fs.symlinkSync(path.join(d, 'real'), path.join(d, 'link'), 'junction');
        kind = 'junction (symbolic link privilege unavailable: ' + e.code + ')';
    }
    assert.equal(fs.lstatSync(path.join(d, 'link')).isSymbolicLink(), true, kind + ' must be reported as a link');
    assert.throws(() => s.noLinks(d, path.join(d, 'link')), { code: 'LINK_REJECTED' });
}
finally {
    clean(d);
} });
test('link rejected', () => { const d = tmp(); try {
    fs.mkdirSync(path.join(d, 'real'));
    // Prefer the strongest link the OS grants: a Windows junction needs no elevation.
    const kind = createLink(path.join(d, 'link'), path.join(d, 'real'), IS_WINDOWS ? 'junction' : 'dir');
    assert.equal(fs.lstatSync(path.join(d, 'link')).isSymbolicLink(), true, kind + ' must be reported as a link');
    assert.throws(() => s.noLinks(d, path.join(d, 'link')), { code: 'LINK_REJECTED' });
    // A path that runs through the link is rejected as well.
    assert.throws(() => s.noLinks(d, path.join(d, 'link', 'child')), { code: 'LINK_REJECTED' });
    // A link that escapes the owned root is rejected as a link, never resolved.
    const outside = tmp();
    try {
        fs.mkdirSync(path.join(outside, 'target'));
        createLink(path.join(d, 'escape'), path.join(outside, 'target'), IS_WINDOWS ? 'junction' : 'dir');
        assert.throws(() => s.noLinks(d, path.join(d, 'escape')), { code: 'LINK_REJECTED' });
    }
    finally {
        clean(outside);
    }
}
finally {
    clean(d);
} });
test('plain directory is not rejected as a link', () => { const d = tmp(); try {
    const real = path.join(d, 'real');
    fs.mkdirSync(real);
    assert.equal(s.noLinks(d, real), path.resolve(real));
}
finally {
    clean(d);
} });
test('atomic state update and exclusive collision', () => { const d = tmp(); try {
    const f = path.join(d, 'x.json');
    s.atomicJSON(f, { v: 1 });
    s.atomicJSON(f, { v: 2 });
    assert.equal(s.readJSON(f).v, 2);
    assert.throws(() => s.atomicJSON(f, { v: 3 }, { exclusive: true }));
    assert.equal(s.readJSON(f).v, 2);
}
finally {
    clean(d);
} });
test('lock refuses stale age bypass', () => { const d = tmp(); try {
    const f = path.join(d, 'lock');
    const release = s.acquireLock(f);
    assert.throws(() => s.acquireLock(f), { code: 'LOCKED' });
    release();
    assert.equal(fs.existsSync(f), false);
    // 重启后遗留的旧锁：即使时间戳很旧、PID 已不存在，也不得按年龄自动回收。
    s.atomicJSON(f, { pid: 999999, token: 'stale', at: new Date(0).toISOString() });
    assert.throws(() => s.acquireLock(f), { code: 'LOCKED' }, 'QA-SPEC-CLN-007 旧锁文件不按年龄回收，需人工或平台监督核对后再处理');
}
finally {
    clean(d);
} });
test('sensitive environment not inherited', () => { const d = tmp(); process.env.QA_TEST_SECRET = 'synthetic-secret-test'; try {
    const e = s.isolatedEnv(d);
    assert.equal(e.QA_TEST_SECRET, undefined);
    assert.ok(e.KB_DATA_DIR.startsWith(d));
    assert.ok(e.KB_KNOWLEDGE_DATA_DIR.startsWith(d));
    assert.throws(() => s.isolatedEnv(d, { NODE_OPTIONS: '--inspect' }));
}
finally {
    delete process.env.QA_TEST_SECRET;
    clean(d);
} });
test('redaction', () => { process.env.QA_TEST_SECRET = 'secret-for-unit-check'; try {
    assert.equal(s.redact('x secret-for-unit-check y'), 'x [REDACTED] y');
    assert.match(s.redact('Bearer abc123'), /REDACTED/);
}
finally {
    delete process.env.QA_TEST_SECRET;
} });
test('owned run collision blocks', () => { const d = tmp(); try {
    s.ownedRun(d, 'a');
    assert.throws(() => s.ownedRun(d, 'a'), { code: 'RUN_EXISTS' });
}
finally {
    clean(d);
} });
test('cleanup excludes active failed retained runs', () => { const d = tmp(); try {
    for (const state of ['ACTIVE', 'FAILED', 'RETAIN']) {
        const p = s.ownedRun(d, state);
        s.setRunStatus(p, state);
        const m = s.readJSON(path.join(p, '.qa-owner.json'));
        m.finishedAt = new Date(0).toISOString();
        s.atomicJSON(path.join(p, '.qa-owner.json'), m);
    }
    assert.deepEqual(s.cleanupPlan(d, 1), [], 'QA-SPEC-CLN-005 ACTIVE/FAILED/RETAIN 运行即使过期也不进入清理清单');
}
finally {
    clean(d);
} });
test('cleanup dry-run hash mismatch blocks', () => { const d = tmp(); try {
    assert.throws(() => s.applyCleanup(d, { olderThanHours: 1, planHash: 'wrong' }), { code: 'CLEAN_CHANGED' });
}
finally {
    clean(d);
} });
test('cleanup removes only old successful owned files', () => { const d = tmp(); try {
    const p = s.ownedRun(d, 'old');
    fs.writeFileSync(path.join(p, 'temp.txt'), 'abc');
    s.setRunStatus(p, 'PASSED');
    const m = s.readJSON(path.join(p, '.qa-owner.json'));
    m.finishedAt = new Date(0).toISOString();
    s.atomicJSON(path.join(p, '.qa-owner.json'), m);
    const plan = s.cleanupPlan(d, 1);
    assert.equal(plan.length, 1, 'QA-SPEC-CLN-005 只有 PASSED 且到期的运行进入清理清单');
    s.applyCleanup(d, { olderThanHours: 1, planHash: s.hash(JSON.stringify(plan)) });
    assert.equal(fs.existsSync(p), false);
}
finally {
    clean(d);
} });
test('cleanup refuses a link that escapes the owned root', () => { const d = tmp(); try {
    const p = s.ownedRun(d, 'linked');
    fs.writeFileSync(path.join(p, 'temp.txt'), 'abc');
    s.setRunStatus(p, 'PASSED');
    const m = s.readJSON(path.join(p, '.qa-owner.json'));
    m.finishedAt = new Date(0).toISOString();
    s.atomicJSON(path.join(p, '.qa-owner.json'), m);
    const outside = tmp();
    try {
        fs.mkdirSync(path.join(outside, 'target'));
        fs.writeFileSync(path.join(outside, 'target', 'keep.txt'), 'keep');
        fs.symlinkSync(path.join(outside, 'target'), path.join(p, 'escape'), IS_WINDOWS ? 'junction' : 'dir');
        assert.throws(() => s.cleanupPlan(d, 1), { code: 'LINK_REJECTED' }, 'QA-SPEC-CLN-003 指向项目外目录的链接在 dry-run 阶段即被拒绝');
        assert.equal(fs.readFileSync(path.join(outside, 'target', 'keep.txt'), 'utf8'), 'keep', 'QA-SPEC-CLN-003 外部目录内容不得被改动');
    }
    finally {
        clean(outside);
    }
}
finally {
    clean(d);
} });
test('cleanup refuses a hardlinked file', () => { const d = tmp(); try {
    const p = s.ownedRun(d, 'hardlinked');
    const keeper = path.join(d, 'keeper.txt');
    fs.writeFileSync(keeper, 'shared');
    fs.linkSync(keeper, path.join(p, 'temp.txt'));
    s.setRunStatus(p, 'PASSED');
    const m = s.readJSON(path.join(p, '.qa-owner.json'));
    m.finishedAt = new Date(0).toISOString();
    s.atomicJSON(path.join(p, '.qa-owner.json'), m);
    assert.throws(() => s.cleanupPlan(d, 1), { code: 'CLEAN_SPECIAL' }, 'QA-SPEC-CLN-004 硬链接文件被拒绝清理');
    assert.equal(fs.readFileSync(keeper, 'utf8'), 'shared', 'QA-SPEC-CLN-004 跨边界保留文件不得被误删');
}
finally {
    clean(d);
} });
test('cleanup refuses to apply a changed plan', () => { const d = tmp(); try {
    const p = s.ownedRun(d, 'changed');
    const file = path.join(p, 'temp.txt');
    fs.writeFileSync(file, 'abc');
    s.setRunStatus(p, 'PASSED');
    const m = s.readJSON(path.join(p, '.qa-owner.json'));
    m.finishedAt = new Date(0).toISOString();
    s.atomicJSON(path.join(p, '.qa-owner.json'), m);
    const plan = s.cleanupPlan(d, 1);
    fs.writeFileSync(file, 'changed after the dry-run');
    assert.throws(() => s.applyCleanup(d, { olderThanHours: 1, planHash: s.hash(JSON.stringify(plan)) }), { code: 'CLEAN_CHANGED' }, 'QA-SPEC-CLN-006 清单生成后文件变化时拒绝按旧清单删除');
    assert.equal(fs.existsSync(file), true, 'QA-SPEC-CLN-006 拒绝之后不得删除任何文件');
}
finally {
    clean(d);
} });
test('state illegal transition blocks', () => { const d = tmp(); try {
    assert.throws(() => new Store(d).transition('COMMITTING'), { code: 'ILLEGAL_TRANSITION' });
}
finally {
    clean(d);
} });
test('state stale revision blocks', () => { const d = tmp(); try {
    const st = new Store(d);
    st.transition('BASELINE_VERIFYING');
    assert.throws(() => st.transact(0, x => x), { code: 'STALE_CHECKPOINT' });
}
finally {
    clean(d);
} });
test('operation idempotence', () => { const d = tmp(); try {
    const st = new Store(d);
    assert.equal(st.beginOperation('x', {}).existing, false);
    assert.equal(st.beginOperation('x', {}).existing, true);
    st.completeOperation('x', { remote: 'ok' });
    assert.equal(st.beginOperation('x', {}).existing, true, 'QA-SPEC-REL-004 同一个操作 ID 只允许执行一次，避免覆盖同版本发布');
    assert.throws(() => st.completeOperation('x', {}));
}
finally {
    clean(d);
} });
test('journal recovers checkpoint gap without replaying action', () => { const d = tmp(); try {
    const st = new Store(d);
    st.transition('BASELINE_VERIFYING');
    const before = st.read();
    st.transition('DISCOVERING');
    s.atomicJSON(st.file, before);
    assert.equal(st.recoverJournal().recovered, 1, 'QA-SPEC-QTA-007 重启后按journal链补齐缺口');
    assert.equal(st.read().phase, 'DISCOVERING', 'QA-SPEC-QTA-007 恢复只执行未完成动作，不回到已完成阶段');
    assert.equal(st.recoverJournal().recovered, 0, 'QA-SPEC-QTA-007 已恢复的动作不重发');
}
finally {
    clean(d);
} });
test('journal hash corruption blocks', () => { const d = tmp(); try {
    const st = new Store(d);
    const before = st.read();
    st.transition('BASELINE_VERIFYING');
    s.atomicJSON(st.file, before);
    const file = path.join(d, 'journal', '00000001.json'), e = s.readJSON(file);
    e.previous = 'bad';
    s.atomicJSON(file, e);
    assert.throws(() => st.recoverJournal(), { code: 'JOURNAL_CHAIN' }, 'QA-SPEC-QTA-007 journal 链被破坏时拒绝恢复');
}
finally {
    clean(d);
} });
test('resume requires actual reconciliation', () => { const d = tmp(); try {
    const st = new Store(d);
    st.transition('BASELINE_VERIFYING');
    st.transition('PAUSING');
    st.transition('PAUSED_QUOTA');
    st.transition('RESUMING');
    assert.throws(() => st.resumeAfterReconciliation({}));
    assert.equal(st.resumeAfterReconciliation({ externalStateVerified: true }).phase, 'BASELINE_VERIFYING', 'QA-SPEC-QTA-007 活动操作状态未知时先对账，对账确认外部状态后才继续');
}
finally {
    clean(d);
} });
for (const b of ['qa/../main', 'qa/x//y', 'feature/test', 'qa/x/', 'master', 'qa/test-20261020'])
    test('reject branch ' + b, () => assert.throws(() => g.branchName(b), { code: 'BRANCH_FORBIDDEN' }));
test('main branch accepted', () => assert.equal(g.branchName('main'), 'main'));
test('main branch required by config', () => assert.equal(g.mainBranch({ mainBranch: 'main' }), 'main'));
test('qa branch in config rejected', () => assert.throws(() => g.mainBranch({ mainBranch: 'qa/acceptance' }), { code: 'BRANCH_FORBIDDEN' }));
test('origin exact ownership', () => { assert.equal(g.allowedOrigin('git@github.com:SanQianX/project-knowledge-base.git', 'SanQianX/project-knowledge-base'), true); assert.equal(g.allowedOrigin('https://github.com/other/project-knowledge-base.git', 'SanQianX/project-knowledge-base'), false); });
test('ref parsing rejects malformed SHA', () => assert.throws(() => g.parseRemoteRefs('wrong refs/heads/main')));
const ct = { bugId: 'QA-001', allowedFiles: ['ui/product.js'], summary: 'test' };
test('out of scope change blocks', () => assert.throws(() => g.validateChanges({}, ct, ['ui/product.css']), { code: 'OUT_OF_SCOPE' }));
test('native assertion changes need review', () => assert.throws(() => g.validateChanges({}, { ...ct, allowedFiles: ['_site/_test/test-test.js'] }, ['_site/_test/test-test.js']), { code: 'PROTECTED_FILE' }));
test('no empty successful change', () => assert.throws(() => g.validateChanges({}, ct, []), { code: 'DIFF_SIZE' }));
test('public API change blocks', () => assert.throws(() => g.validateChanges({}, { ...ct, publicApiChange: true }, ['ui/product.js']), { code: 'DESIGN_CHANGE' }));
for (const version of ['1.2.3', 'latest', 'next', 'v1.2.3-rc.1', '1.2.3-rc.01', '1.2.3-beta.1'])
    test('reject nonfixed RC ' + version, () => assert.equal(r.isRC(version), false, 'QA-SPEC-REL-001 latest/next 之类不是固定 RC 版本，没有自动出口'));
test('fixed RC accepts', () => assert.equal(r.isRC('5.0.25-rc.1'), true));
const required = ['package.json', '_site/server.js', 'ui/index.html', 'ui/product.js', 'ui/live-client.js', 'module-runtime-manifest.json', 'vendor-manifest.json', '_modules/knowledge-engine/index.js'];
test('package runtime allowlist', () => assert.equal(r.validatePack(required), true));
for (const f of ['qa-autopilot/plans/test.md', '.env', 'artifacts/trace.zip', 'credentials.json'])
    test('package leak ' + f, () => assert.throws(() => r.validatePack([...required, f]), { code: 'PACKAGE_LEAK' }, 'QA-SPEC-REL-003 制品清单包含 qa/state/.env 一类文件时拒绝打包'));
test('missing engine blocks', () => assert.throws(() => r.validatePack(required.slice(0, -1)), { code: 'ENGINE_MISSING' }, 'QA-SPEC-REL-003 必要引擎不得被清理出制品'));
test('empty package blocks', () => assert.throws(() => r.validatePack([])));
test('RC without complete release gates blocks', () => assert.throws(() => r.validateReleaseAcceptance({}, null, {}), { code: 'RC_ACCEPTANCE' }, 'QA-SPEC-REL-008 候选验收门禁未齐全时不得进入发布动作，稳定版只能经外部审批'));

// ------------------------------------------------ REV-02 published-file 额度：时间戳/路径/门禁对抗反例
const pfBody = checkedAt => ({ quota: { state: 'KNOWN', remainingPercent: 90, checkedAt }, gate: { state: 'RUNNING', admitTask: true, admitRequest: true } });
const pfWrite = body => { const d = tmp(); const f = path.join(d, 'quota-status.json'); fs.writeFileSync(f, JSON.stringify(body)); return f; };
test('published quota without checkedAt is refused (REV-02)', async () => {
    const d = tmp(); const f = path.join(d, 'quota-status.json');
    fs.writeFileSync(f, JSON.stringify({ quota: { state: 'KNOWN', remainingPercent: 90 } }));
    try { await assert.rejects(() => q.fetchQuota({ mode: 'published-file', file: f, maxAgeMs: 120000 }), { code: 'QUOTA_STALE' }, 'REV-02 缺失 checkedAt 不得以 Date.now() 兜底伪造新鲜'); }
    finally { clean(d); }
});
test('published quota with an ISO-string checkedAt is refused (REV-02)', async () => {
    const f = pfWrite({ quota: { state: 'KNOWN', remainingPercent: 90, checkedAt: new Date(Date.now() - 3600000).toISOString() } });
    try { await assert.rejects(() => q.fetchQuota({ mode: 'published-file', file: f, maxAgeMs: 120000 }), { code: 'QUOTA_STALE' }, 'REV-02 Number(iso)=NaN 的陈旧时间戳不得兜底为新鲜'); }
    finally { clean(path.dirname(f)); }
});
test('published quota with negative or far-future checkedAt is refused (REV-02)', async () => {
    for (const checkedAt of [-1, Date.now() + 600000]) {
        const f = pfWrite(pfBody(checkedAt));
        try { await assert.rejects(() => q.fetchQuota({ mode: 'published-file', file: f, maxAgeMs: 120000 }), { code: 'QUOTA_STALE' }); }
        finally { clean(path.dirname(f)); }
    }
});
test('published quota older than maxAgeMs is refused (REV-02)', async () => {
    const f = pfWrite(pfBody(Date.now() - 3600000));
    try { await assert.rejects(() => q.fetchQuota({ mode: 'published-file', file: f, maxAgeMs: 120000 }), { code: 'QUOTA_STALE' }, 'REV-02 网关停更后陈旧文件必须过期（fail-closed）'); }
    finally { clean(path.dirname(f)); }
});
test('published quota accepts only an absolute regular file of bounded size (REV-02)', async () => {
    await assert.rejects(() => q.fetchQuota({ mode: 'published-file', file: 'quota-status.json', maxAgeMs: 120000 }), { code: 'QUOTA_NOT_CONFIGURED' }, 'REV-02 相对路径不被接受');
    const d = tmp();
    try {
        const realDir = path.join(d, 'realdir'); fs.mkdirSync(realDir);
        const link = path.join(d, 'link.json');
        createLink(link, realDir, 'dir');
        await assert.rejects(() => q.fetchQuota({ mode: 'published-file', file: link, maxAgeMs: 120000 }), { code: 'QUOTA_NOT_CONFIGURED' }, 'REV-02 链接（符号链接/junction）不被接受');
        const big = path.join(d, 'big.json');
        fs.writeFileSync(big, JSON.stringify({ quota: { state: 'KNOWN', remainingPercent: 90, checkedAt: Date.now(), pad: 'x'.repeat(70000) } }));
        await assert.rejects(() => q.fetchQuota({ mode: 'published-file', file: big, maxAgeMs: 120000 }), { code: 'QUOTA_SIZE' }, 'REV-02 异常大小的发布文件 fail-closed');
    }
    finally { clean(d); }
});
test('a fresh epoch-ms published file still yields KNOWN (REV-02 compatibility)', async () => {
    const f = pfWrite(pfBody(Date.now()));
    try {
        const got = await q.fetchQuota({ mode: 'published-file', file: f, maxAgeMs: 120000 });
        assert.equal(got.state, 'KNOWN');
        assert.equal(got.remainingPercent, 90);
        assert.equal(typeof got.checkedAt, 'number', 'checkedAt 原样透传发布方 epoch 毫秒');
    }
    finally { clean(path.dirname(f)); }
});
test('publisher gate caps admission regardless of remaining percent (REV-02)', () => {
    const at = (gate, key) => q.quotaDecision({ ...known(90), gate }, {}, 'RUNNING', 1000)[key];
    assert.equal(at({ state: 'PAUSED' }, 'admitTask'), false, 'gate PAUSED 不得被 90% 额度翻案');
    assert.equal(at({ state: 'UNKNOWN' }, 'state'), 'UNKNOWN', 'gate UNKNOWN 阻断双准入');
    assert.equal(at({ state: 'WAITING_RECOVERY' }, 'admitRequest'), false, 'gate WAITING_RECOVERY 阻断双准入');
    assert.equal(at({ deny: true }, 'admitTask'), false, 'gate 显式 deny 阻断双准入');
    const capped = q.quotaDecision({ ...known(90), gate: { state: 'RUNNING', admitTask: false } }, {}, 'RUNNING', 1000);
    assert.deepEqual([capped.admitTask, capped.admitRequest], [false, true], 'gate 的显式 false 只收紧对应开关');
});

// ------------------------------------------------ REV-03/04 台账：SKIP/TODO 与名字对位
const ledger = require('../tools/case-ledger.cjs');
test('TAP SKIP/TODO directives never count as PASS and not-ok is sticky (REV-03)', () => {
    const d = tmp();
    try {
        const f = path.join(d, 'demo.tap');
        fs.writeFileSync(f, ['TAP version 13', 'ok 1 - alpha # SKIP', 'ok 2 - beta # TODO reason', 'ok 3 - gamma', 'not ok 4 - delta', 'ok 4 - delta', 'ok 5 - hash # in name stays'].join('\n'));
        const m = ledger.parseTap(f);
        assert.equal(m.get('alpha'), 'SKIP', 'SKIP 不给 PASS');
        assert.equal(m.get('beta'), 'TODO', 'TODO 不给 PASS');
        assert.equal(m.get('gamma'), 'PASS');
        assert.equal(m.get('delta'), 'FAIL', '真实 not ok 不被后续同名 ok 覆盖');
        assert.equal(m.get('hash # in name stays'), 'PASS', '非 directive 的 # 仍是名字的一部分');
    }
    finally { clean(d); }
});
test('unidentifiable test names cannot be offset by siblings (REV-04)', () => {
    assert.deepEqual(ledger.matchTestNames(null, ['sibling passing']), [], 'nameLiteral 为 null 时不得匹配任何 TAP 名');
    assert.deepEqual(ledger.matchTestNames('alpha', ['alpha', 'alphabet']), ['alpha'], '裸前缀回退已删除：只认精确名');
    assert.deepEqual(ledger.matchTestNames('concat ', ['concat a', 'other']), ['concat a'], '拼接前缀（尾随空格）仍然允许');
    assert.equal(ledger.bindingOutcome([]), 'NOT_EXECUTED');
    assert.equal(ledger.bindingOutcome(['SKIP']), 'NOT_EXECUTED', 'SKIP 只算未执行');
    assert.equal(ledger.bindingOutcome(['TODO']), 'NOT_EXECUTED');
    assert.equal(ledger.bindingOutcome(['PASS', 'PASS']), 'PASS');
    assert.equal(ledger.bindingOutcome(['PASS', 'SKIP']), 'FAIL', '混合状态保守判 FAIL，不给 PASS');
    assert.equal(ledger.bindingOutcome(['FAIL']), 'FAIL');
});
test('scanTestBlocks quotes literals and marks dynamic names null (REV-04)', () => {
    const d = tmp();
    try {
        const src = path.join(d, 'demo.test.cjs');
        fs.writeFileSync(src, ["test('plain name', () => {}); // QA-SPEC-QTA-099 demo", 'test(`tpl ${x}`, () => {}); // QA-SPEC-QTA-098 demo', 'test("double quoted", () => {});'].join('\n'));
        const blocks = ledger.scanTestBlocks(src);
        assert.equal(blocks[0].nameLiteral, 'plain name');
        assert.equal(blocks[1].nameLiteral, null, '模板字面量名不可唯一对位');
        assert.equal(blocks[2].nameLiteral, 'double quoted');
        assert.ok(blocks[0].markers.some(m => m.caseId === 'QA-SPEC-QTA-099'));
    }
    finally { clean(d); }
});
test('legacy overnight commitAndPush is disabled before any mutation (L-QAFIX-02)', () => {
    const d = tmp();
    try {
        const remote = path.join(d, 'remote.git').replace(/\\/g, '/');
        const work = path.join(d, 'work');
        s.commandSync('git', ['init', '--bare', '-q', '-b', 'main', remote], { cwd: d });
        s.commandSync('git', ['clone', '-q', remote, work], { cwd: d });
        s.commandSync('git', ['config', 'user.name', 'QA Selftest'], { cwd: work });
        s.commandSync('git', ['config', 'user.email', 'qa@local.invalid'], { cwd: work });
        fs.writeFileSync(path.join(work, 'a.txt'), 'a');
        s.commandSync('git', ['add', '-A'], { cwd: work });
        s.commandSync('git', ['commit', '-qm', 'base'], { cwd: work });
        s.commandSync('git', ['push', '-q', 'origin', 'main'], { cwd: work });
        fs.writeFileSync(path.join(work, 'a.txt'), 'a + pending legacy write\n');
        const sup = require('../tools/overnight-supervisor.cjs');
        const cfg = { repoRoot: work, tools: { git: 'git' }, mainBranch: 'main',
            worker: { mode: 'selftest', disallowedTools: [], adapterValidated: false } };
        const task = { id: 'T07B-demo', module: 'demo', specIds: ['QA-SPEC-1'], contract: { allowedFiles: ['a.txt'] } };
        const before = { head: s.commandSync('git', ['rev-parse', 'HEAD'], { cwd: work }),
            porcelain: s.commandSync('git', ['status', '--porcelain=v1'], { cwd: work }),
            remote: s.commandSync('git', ['rev-list', '--count', 'refs/heads/main'], { cwd: remote }) };
        assert.throws(() => sup.commitAndPush(cfg, task), { code: 'LEGACY_WRITE_DISABLED' }, 'QA-SPEC-GIT-202 遗留直写入口必须在任何 git add/commit/push 之前禁用');
        assert.equal(s.commandSync('git', ['rev-parse', 'HEAD'], { cwd: work }), before.head, 'QA-SPEC-GIT-202 禁用后不得产生提交');
        assert.equal(s.commandSync('git', ['status', '--porcelain=v1'], { cwd: work }), before.porcelain, 'QA-SPEC-GIT-202 工作区状态不得被改动');
        assert.equal(s.commandSync('git', ['diff', '--cached', '--name-only'], { cwd: work }).trim(), '', 'QA-SPEC-GIT-202 不得留下暂存内容');
        assert.equal(s.commandSync('git', ['rev-list', '--count', 'refs/heads/main'], { cwd: remote }), before.remote, 'QA-SPEC-GIT-202 远端不得被改写');
        assert.ok(!fs.existsSync(path.join(work, '.git', 'qa-controller-empty-hooks')), 'QA-SPEC-GIT-202 禁用路径不得触碰文件系统');
        const st = sup.statusOf(cfg, { phase: 'INITIALIZING', revision: 0, tasks: {}, order: [] });
        assert.equal(st.git.head, before.head, 'QA-SPEC-GIT-202 只读诊断能力保留');
    }
    finally { clean(d); }
});
