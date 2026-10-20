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
    test('quota explicit ' + p, () => assert.equal(q.normalizeQuota(raw(p), quotaCfg).remainingPercent, p));
for (const p of [-1, 101, NaN, Infinity, '80', null])
    test('invalid quota percent ' + String(p), () => assert.equal(q.normalizeQuota(raw(p), quotaCfg).state, 'UNKNOWN'));
test('ambiguous usage never inferred', () => assert.equal(q.normalizeQuota({ model_remains: [{ model_name: 'MiniMax-M3.1-Flash', current_interval_usage_count: 20, current_interval_total_count: 100 }] }, quotaCfg).reason, 'AMBIGUOUS_USAGE_COUNT'));
for (const meaning of ['used', 'remaining'])
    test('verified count ' + meaning, () => assert.equal(q.normalizeQuota({ model_remains: [{ model_name: 'MiniMax-M3.1-Flash', current_interval_usage_count: 20, current_interval_total_count: 100 }] }, { ...quotaCfg, verifiedCountMeaning: meaning, countMeaningEvidence: 'reviewed' }).remainingPercent, meaning === 'used' ? 80 : 20));
test('unknown weekly blocks', () => assert.equal(q.normalizeQuota(raw(80), { modelNames: quotaCfg.modelNames }).state, 'UNKNOWN'));
test('weekly minimum used', () => { const b = raw(80); b.model_remains[0].weekly = 12; assert.equal(q.normalizeQuota(b, { modelNames: quotaCfg.modelNames, weeklyPercentField: 'weekly' }).remainingPercent, 12); });
test('duplicate model rows block', () => { const b = raw(80); b.model_remains.push(b.model_remains[0]); assert.equal(q.normalizeQuota(b, quotaCfg).reason, 'MODEL_MAPPING_REQUIRED'); });
test('account balance not quota', () => assert.equal(q.normalizeQuota({ balance: 99 }, quotaCfg).state, 'UNKNOWN'));
test('upstream application failure blocks', () => assert.equal(q.normalizeQuota({ ...raw(99), base_resp: { status_code: 1000 } }, quotaCfg).state, 'UNKNOWN'));
const known = p => ({ state: 'KNOWN', remainingPercent: p, checkedAt: 1000 });
for (const [p, task, req, state] of [[5, false, false, 'PAUSED'], [10, false, false, 'PAUSED'], [11, false, true, 'DRAINING'], [20, false, true, 'DRAINING'], [21, true, true, 'RUNNING']])
    test('quota thresholds ' + p, () => { const x = q.quotaDecision(known(p), {}, 'RUNNING', 1000); assert.equal(x.admitTask, task); assert.equal(x.admitRequest, req); assert.equal(x.state, state); });
test('recovery requires two samples', () => { const a = q.quotaDecision(known(80), {}, 'PAUSED', 1000); assert.equal(a.admitTask, false); assert.equal(q.quotaDecision(known(80), {}, a.state, 1000, a.successes).admitTask, true); });
test('recovery hysteresis', () => assert.equal(q.quotaDecision(known(30), {}, 'PAUSED', 1000, 3).admitTask, false));
test('stale quota blocks', () => assert.equal(q.quotaDecision(known(80), {}, 'RUNNING', 200000).admitRequest, false));
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
    assert.deepEqual(s.cleanupPlan(d, 1), []);
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
    assert.equal(plan.length, 1);
    s.applyCleanup(d, { olderThanHours: 1, planHash: s.hash(JSON.stringify(plan)) });
    assert.equal(fs.existsSync(p), false);
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
    assert.equal(st.beginOperation('x', {}).existing, true);
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
    assert.equal(st.recoverJournal().recovered, 1);
    assert.equal(st.read().phase, 'DISCOVERING');
    assert.equal(st.recoverJournal().recovered, 0);
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
    assert.throws(() => st.recoverJournal(), { code: 'JOURNAL_CHAIN' });
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
    assert.equal(st.resumeAfterReconciliation({ externalStateVerified: true }).phase, 'BASELINE_VERIFYING');
}
finally {
    clean(d);
} });
for (const b of ['main', 'qa/../main', 'qa/x//y', 'feature/test', 'qa/x/'])
    test('reject branch ' + b, () => assert.throws(() => g.branchName(b)));
test('QA branch accepted', () => assert.equal(g.branchName('qa/test-20261020'), 'qa/test-20261020'));
test('origin exact ownership', () => { assert.equal(g.allowedOrigin('git@github.com:SanQianX/project-knowledge-base.git', 'SanQianX/project-knowledge-base'), true); assert.equal(g.allowedOrigin('https://github.com/other/project-knowledge-base.git', 'SanQianX/project-knowledge-base'), false); });
test('ref parsing rejects malformed SHA', () => assert.throws(() => g.parseRemoteRefs('wrong refs/heads/main')));
const ct = { bugId: 'QA-001', allowedFiles: ['ui/product.js'], summary: 'test' };
test('out of scope change blocks', () => assert.throws(() => g.validateChanges({}, ct, ['ui/product.css']), { code: 'OUT_OF_SCOPE' }));
test('native assertion changes need review', () => assert.throws(() => g.validateChanges({}, { ...ct, allowedFiles: ['_site/_test/test-test.js'] }, ['_site/_test/test-test.js']), { code: 'PROTECTED_FILE' }));
test('no empty successful change', () => assert.throws(() => g.validateChanges({}, ct, []), { code: 'DIFF_SIZE' }));
test('public API change blocks', () => assert.throws(() => g.validateChanges({}, { ...ct, publicApiChange: true }, ['ui/product.js']), { code: 'DESIGN_CHANGE' }));
for (const version of ['1.2.3', 'latest', 'next', 'v1.2.3-rc.1', '1.2.3-rc.01', '1.2.3-beta.1'])
    test('reject nonfixed RC ' + version, () => assert.equal(r.isRC(version), false));
test('fixed RC accepts', () => assert.equal(r.isRC('5.0.25-rc.1'), true));
const required = ['package.json', '_site/server.js', 'ui/index.html', 'ui/product.js', 'ui/live-client.js', 'module-runtime-manifest.json', 'vendor-manifest.json', '_modules/knowledge-engine/index.js'];
test('package runtime allowlist', () => assert.equal(r.validatePack(required), true));
for (const f of ['qa-autopilot/plans/test.md', '.env', 'artifacts/trace.zip', 'credentials.json'])
    test('package leak ' + f, () => assert.throws(() => r.validatePack([...required, f]), { code: 'PACKAGE_LEAK' }));
test('missing engine blocks', () => assert.throws(() => r.validatePack(required.slice(0, -1)), { code: 'ENGINE_MISSING' }));
test('empty package blocks', () => assert.throws(() => r.validatePack([])));
test('RC without complete release gates blocks', () => assert.throws(() => r.validateReleaseAcceptance({}, null, {}), { code: 'RC_ACCEPTANCE' }));
