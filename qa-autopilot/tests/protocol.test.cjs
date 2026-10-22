'use strict';
// Git 协议级用例：真实 runner 产出收据 → commitPush 的闭环，以及 REV-01/02 对抗反例。
// 全部使用本机临时裸仓作为远端、回环 HTTP 桩作为运行身份端点，
// 不触碰真实仓库、真实远端、真实受保护实例与用户工作区。
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const http = require('node:http');
const { commandSync, hash, readJSON } = require('../lib/safety.cjs');
const g = require('../lib/git.cjs');
const { runSuite } = require('../lib/runner.cjs');
const { Store } = require('../lib/state.cjs');

function makeFixture() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-protocol-'));
    const remote = path.join(dir, 'remote.git').replace(/\\/g, '/');
    const source = path.join(dir, 'source'), work = path.join(dir, 'work'), qa = path.join(dir, 'qa');
    const raw = (args, cwd) => commandSync('git', args, { cwd });
    raw(['init', '--bare', '-q', '-b', 'main', remote], dir);
    raw(['clone', '-q', remote, source], dir);
    raw(['config', 'user.name', 'QA Selftest'], source);
    raw(['config', 'user.email', 'qa@local.invalid'], source);
    fs.writeFileSync(path.join(source, 'a.txt'), 'a');
    fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify({ name: '@sanqianx/project-knowledge', version: '5.0.25-rc.1' }));
    fs.mkdirSync(path.join(source, '.github', 'workflows'), { recursive: true });
    fs.writeFileSync(path.join(source, '.github', 'workflows', 'publish.yml'), 'name: publish\n');
    raw(['add', '-A'], source);
    raw(['commit', '-qm', 'base'], source);
    raw(['push', '-q', 'origin', 'main'], source);
    raw(['clone', '--no-local', '-q', remote, work], dir);
    raw(['config', 'user.name', 'QA Selftest'], work);
    raw(['config', 'user.email', 'qa@local.invalid'], work);
    const cfg = {
        qaRoot: qa, repoRoot: work, sourceRoot: source,
        githubRepo: 'local/qa-selftest', originAllowlist: [remote],
        tools: { git: 'git' }, mainBranch: 'main', limits: {},
        authorization: { localCloneEnabled: true, remoteWriteEnabled: true, controllerIsolationVerified: true }
    };
    return { dir, remote, source, work, cfg, raw };
}
/**
 * 干净基线自证收据的形状。仅用于 verifyReceipt 自身的行为测试——
 * REV-01 之后 commitPush 不再接受这种对象（见 RECEIPT_NOT_RUNNER 用例），
 * 正向链必须使用真实 runner 写出的收据。
 */
function selfAttestation(cfg, contract) {
    const snap = g.snapshot(cfg);
    return { schema: 1, kind: 'suite', status: 'PASS', exitCode: 0, executed: 1, skipped: 0, timedOut: false, flaky: false,
        head: snap.head, fingerprint: snap.fingerprint, contractHash: hash(JSON.stringify(contract)) };
}
/**
 * 真实 runner 夹具：临时裸仓远端 + 独立 clone + _site/_test 冒烟用例 + suites 配置，
 * 以及只回答 /api/runtime/identity 与 /api/health 的回环桩（身份字段与受保护配置
 * 完全一致，pid 为本测试进程，因此身份门禁可真实通过而不触碰任何真实实例）。
 */
async function makeRunnerFixture() {
    const fx = makeFixture();
    // 冒烟用例必须属于基准提交：否则它会以未跟踪文件进入 changedFiles，
    // 被待测补丁模式的 allowlist 检查拒绝（这本身也是该门禁的正确行为）。
    fs.mkdirSync(path.join(fx.source, '_site', '_test'), { recursive: true });
    fs.writeFileSync(path.join(fx.source, '_site', '_test', 'sanity-test.js'), "'use strict';\nconsole.log('fixture sanity');\n");
    fx.raw(['add', '-A'], fx.source);
    fx.raw(['commit', '-qm', 'fixture smoke test'], fx.source);
    fx.raw(['push', '-q', 'origin', 'main'], fx.source);
    fx.raw(['pull', '-q', '--ff-only', 'origin', 'main'], fx.work);
    fs.mkdirSync(path.join(fx.cfg.qaRoot, 'config'), { recursive: true });
    fs.writeFileSync(path.join(fx.cfg.qaRoot, 'config', 'suites.json'), JSON.stringify({ smoke: ['sanity-test.js'] }));
    fx.cfg.tools = { git: 'git', node: process.execPath };
    const protDir = path.join(fx.dir, 'protected');
    fs.mkdirSync(path.join(protDir, 'data'), { recursive: true });
    fs.mkdirSync(path.join(protDir, 'knowledge'), { recursive: true });
    let boundPort = 0;
    const server = http.createServer((req, res) => {
        if (req.url === '/api/runtime/identity') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ version: 'fixture-5.0.24', pid: process.pid, dataDir: path.join(protDir, 'data'), port: boundPort, host: '127.0.0.1' }));
            return;
        }
        if (req.url === '/api/health') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, projects: 0 }));
            return;
        }
        res.writeHead(404); res.end('{}');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    boundPort = server.address().port;
    fx.cfg.protected = {
        desktop: { host: '127.0.0.1', port: boundPort, pid: process.pid, version: 'fixture-5.0.24' },
        dataDir: path.join(protDir, 'data'), knowledgeRoot: path.join(protDir, 'knowledge'),
        reservedPorts: [boundPort], files: []
    };
    fx.close = async () => {
        await new Promise(resolve => server.close(resolve));
        fs.rmSync(fx.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    };
    fx.applyFix = () => fs.writeFileSync(path.join(fx.work, 'a.txt'), 'a + the reviewed fix under test\n');
    fx.runReal = async contract => {
        fx.applyFix();
        return runSuite(fx.cfg, 'smoke', contract, { patchUnderTest: true });
    };
    return fx;
}
const cleanup = fx => fs.rmSync(fx.dir, { recursive: true, force: true });

test('baseline reports a dirty source and blocks instead of freezing it', () => {
    const fx = makeFixture();
    try {
        fs.writeFileSync(path.join(fx.source, 'a.txt'), 'uncommitted change');
        const before = fs.readFileSync(path.join(fx.source, 'a.txt'), 'utf8');
        const refsBefore = fx.raw(['for-each-ref', '--format=%(refname)'], fx.source);
        const dry = g.baseline(fx.cfg, false);
        assert.equal(dry.dryRun, true);
        assert.notEqual(dry.sourceUncommitted.trim(), '', 'QA-SPEC-GIT-001 基准必须如实报告源工作区的未提交改动');
        assert.equal(dry.sourceMatchesRemote, true, 'QA-SPEC-GIT-001 未提交改动不等于领先远程');
        assert.equal(fs.readFileSync(path.join(fx.source, 'a.txt'), 'utf8'), before, 'QA-SPEC-GIT-001 基准不得 reset 或 stash 用户改动');
        assert.equal(fx.raw(['for-each-ref', '--format=%(refname)'], fx.source), refsBefore, 'QA-SPEC-GIT-001 基准不得创建 tag 或分支');
        assert.throws(() => g.baseline(fx.cfg, true), { code: 'SOURCE_DIRTY' }, 'QA-SPEC-GIT-001 源工作区有未提交改动时基准必须阻断');
        assert.equal(fs.readFileSync(path.join(fx.source, 'a.txt'), 'utf8'), before, 'QA-SPEC-GIT-001 阻断后不得改动用户工作区');
        assert.equal(fx.raw(['rev-list', '--count', 'refs/heads/main'], fx.remote), '1', 'QA-SPEC-GIT-001 基准不得改动远端');
    }
    finally {
        cleanup(fx);
    }
});
test('baseline blocks when the source is ahead of the remote', () => {
    const fx = makeFixture();
    try {
        fs.writeFileSync(path.join(fx.source, 'a.txt'), 'local commit ahead of remote');
        fx.raw(['add', '-A'], fx.source);
        fx.raw(['commit', '-qm', 'ahead of remote'], fx.source);
        const before = fs.readFileSync(path.join(fx.source, 'a.txt'), 'utf8');
        const dry = g.baseline(fx.cfg, false);
        assert.equal(dry.sourceMatchesRemote, false, 'QA-SPEC-GIT-001 源工作区领先远程时基准必须如实报告');
        assert.throws(() => g.baseline(fx.cfg, true), { code: 'SOURCE_AHEAD' }, 'QA-SPEC-GIT-001 源工作区领先远程时基准必须阻断');
        assert.equal(fs.readFileSync(path.join(fx.source, 'a.txt'), 'utf8'), before, 'QA-SPEC-GIT-001 阻断后不得改写用户历史');
        assert.equal(fx.raw(['rev-list', '--count', 'refs/heads/main'], fx.remote), '1', 'QA-SPEC-GIT-001 阻断后远端保持不变');
    }
    finally {
        cleanup(fx);
    }
});
test('a stale suite receipt is refused once the source changed', () => {
    const fx = makeFixture();
    try {
        const contract = { bugId: 'QA-003', allowedFiles: ['a.txt'], summary: 'demo' };
        const receipt = selfAttestation(fx.cfg, contract);
        g.verifyReceipt(fx.cfg, receipt, contract);
        fs.writeFileSync(path.join(fx.work, 'a.txt'), 'changed after the run');
        assert.throws(() => g.verifyReceipt(fx.cfg, receipt, contract), { code: 'STALE_TESTS' }, 'QA-SPEC-GIT-003 源码改动后旧收据失效');
        fs.writeFileSync(path.join(fx.work, 'a.txt'), 'a');
        assert.throws(() => g.verifyReceipt(fx.cfg, receipt, { ...contract, summary: 'other contract' }), { code: 'CONTRACT_CHANGED' }, 'QA-SPEC-GIT-003 合同变化后旧收据失效');
    }
    finally {
        cleanup(fx);
    }
});
test('the run path still refuses a dirty QA clone', () => {
    const fx = makeFixture();
    try {
        fs.writeFileSync(path.join(fx.work, 'stray.txt'), 'stray');
        assert.throws(() => g.assertRepo(fx.cfg, false), { code: 'DIRTY_WORKROOT' }, 'QA-SPEC-GIT-001 运行与自证路径仍然要求隔离 clone 干净');
    }
    finally {
        cleanup(fx);
    }
});

// ---------------------------------------------------------------- REV-01 真实 runner 闭环

test('a real runner receipt closes the loop: run → receipt → commitPush dryRun → apply', async () => {
    const fx = await makeRunnerFixture();
    try {
        const contract = { bugId: 'QA-101', allowedFiles: ['a.txt'], summary: 'demo fix' };
        const receipt = await fx.runReal(contract);
        assert.equal(receipt.status, 'PASS', '真实 runner 必须先通过冒烟套件');
        assert.equal(receipt.executed, 1);
        assert.deepEqual(receipt.patchUnderTest.files, ['a.txt'], 'REV-01 收据必须携带待测补丁绑定');
        assert.ok(fs.existsSync(receipt.receiptPath), '收据必须由 runner 落盘');
        const store = new Store(path.join(fx.cfg.qaRoot, 'state'));
        const plan = g.commitPush(fx.cfg, contract, readJSON(receipt.receiptPath), store, false);
        assert.equal(plan.dryRun, true);
        assert.deepEqual(plan.files, ['a.txt']);
        const pushed = g.commitPush(fx.cfg, contract, readJSON(receipt.receiptPath), store, true);
        assert.equal(pushed.status, 'PUSHED_CI_PENDING', 'REV-01 真实收据走完 dryRun 后可真实提交到临时裸仓');
        assert.equal(fx.raw(['rev-list', '--count', 'refs/heads/main'], fx.remote), '3');
        assert.equal(fx.raw(['rev-parse', 'HEAD^'], fx.work).trim(), receipt.patchUnderTest.head, '提交父级必须是收据绑定的基线 HEAD');
    }
    finally {
        await fx.close();
    }
});
test('a receipt assembled from a snapshot is refused by commitPush (REV-01)', async () => {
    const fx = await makeRunnerFixture();
    try {
        const contract = { bugId: 'QA-102', allowedFiles: ['a.txt'], summary: 'demo' };
        fx.applyFix();
        await assert.rejects(() => runSuite(fx.cfg, 'smoke', contract), { code: 'DIRTY_WORKROOT' }, '干净模式仍拒绝脏树：基线自证不被放宽');
        const fab = selfAttestation(fx.cfg, contract);
        assert.throws(() => g.commitPush(fx.cfg, contract, fab, new Store(path.join(fx.cfg.qaRoot, 'state')), false),
            { code: 'RECEIPT_NOT_RUNNER' }, 'REV-01 仅用 snapshot 拼出的 PASS 对象不得放行提交');
    }
    finally {
        await fx.close();
    }
});
test('receipt ids cannot escape the artifacts root (L-QAFIX-02)', async () => {
    const fx = await makeRunnerFixture();
    const mkLink = (link, target) => {
        try { fs.symlinkSync(target, link, 'dir'); return 'symlink'; }
        catch { fs.symlinkSync(target, link, 'junction'); return 'junction'; }
    };
    try {
        const contract = { bugId: 'QA-201', allowedFiles: ['a.txt'], summary: 'traversal' };
        const store = new Store(path.join(fx.cfg.qaRoot, 'state'));
        const fabricate = id => {
            const snap = g.snapshot(fx.cfg);
            return { schema: 1, kind: 'suite', id, status: 'PASS', exitCode: 0, executed: 1, skipped: 0,
                timedOut: false, flaky: false, head: snap.head, fingerprint: snap.fingerprint,
                contractHash: hash(JSON.stringify(contract)),
                patchUnderTest: { mode: 'patch-under-test', head: snap.head, remoteMain: snap.head, files: ['a.txt'], patchSha256: g.patchFingerprint(fx.cfg, ['a.txt']), contractHash: hash(JSON.stringify(contract)) },
                results: [{ name: 'sanity-test.js', status: 'PASS', exitCode: 0, skipped: false, timedOut: false }] };
        };
        // '../..' 与绝对路径 id：在读文件之前即拒绝，qaRoot/artifacts 之外不读取任何字节。
        fs.mkdirSync(path.join(fx.cfg.qaRoot, 'artifacts'), { recursive: true });
        const outside = path.join(fx.dir, 'outside');
        fs.mkdirSync(outside, { recursive: true });
        const escaping = fabricate('../../outside');
        fs.writeFileSync(path.join(outside, 'receipt.json'), JSON.stringify(escaping, null, 2) + '\n');
        assert.throws(() => g.commitPush(fx.cfg, contract, escaping, store, false),
            { code: 'RECEIPT_NOT_RUNNER' }, 'QA-SPEC-GIT-201 穿越型 id 必须在读文件之前被拒绝');
        assert.throws(() => g.commitPush(fx.cfg, contract, fabricate(fx.dir.replace(/\\/g, '/')), store, false),
            { code: 'RECEIPT_NOT_RUNNER' }, 'QA-SPEC-GIT-201 绝对路径 id 必须被拒绝');
        // 合法单段 id 但 artifacts/<id> 是指向外部的 junction/symlink：拒绝链接本身。
        const linked = fabricate('test-smoke-777');
        fs.writeFileSync(path.join(outside, 'receipt.json'), JSON.stringify(linked, null, 2) + '\n');
        mkLink(path.join(fx.cfg.qaRoot, 'artifacts', 'test-smoke-777'), outside);
        assert.throws(() => g.commitPush(fx.cfg, contract, linked, store, false),
            { code: 'LINK_REJECTED' }, 'QA-SPEC-GIT-201 artifacts 下的链接逃逸必须被拒绝');
        assert.equal(fx.raw(['rev-list', '--count', 'refs/heads/main'], fx.remote), '2', '全部拒绝后远端不得有任何提交');
    }
    finally {
        await fx.close();
    }
});
test('patch mode refuses undeclared files and baseline drift (REV-01)', async () => {
    const fx = await makeRunnerFixture();
    try {
        const contract = { bugId: 'QA-103', allowedFiles: ['a.txt'], summary: 'demo' };
        fx.applyFix();
        fs.writeFileSync(path.join(fx.work, 'stray.txt'), 'not declared');
        await assert.rejects(() => runSuite(fx.cfg, 'smoke', contract, { patchUnderTest: true }), { code: 'OUT_OF_SCOPE' }, '未声明文件在取得收据之前即被拒绝');
        fs.unlinkSync(path.join(fx.work, 'stray.txt'));
        fx.raw(['add', '-A'], fx.work);
        fx.raw(['commit', '-qm', 'local commit ahead of remote'], fx.work);
        fx.applyFix();
        await assert.rejects(() => runSuite(fx.cfg, 'smoke', contract, { patchUnderTest: true }), { code: 'BASELINE_DRIFT' }, '本地基线领先远程时不得以补丁模式取证');
    }
    finally {
        await fx.close();
    }
});
test('a change after the tested run invalidates the receipt (REV-01)', async () => {
    const fx = await makeRunnerFixture();
    try {
        const contract = { bugId: 'QA-104', allowedFiles: ['a.txt', 'fix.js'], summary: 'demo' };
        const receipt = await fx.runReal(contract);
        fs.writeFileSync(path.join(fx.work, 'fix.js'), 'module.exports = 1;\n');
        assert.throws(() => g.commitPush(fx.cfg, contract, readJSON(receipt.receiptPath), new Store(path.join(fx.cfg.qaRoot, 'state')), false),
            { code: 'STALE_TESTS' }, '测试后新增/修改的文件使收据指纹失配');
    }
    finally {
        await fx.close();
    }
});
test('a new untracked file with a credential is refused before staging', async () => {
    const fx = await makeRunnerFixture();
    try {
        fs.mkdirSync(path.join(fx.work, 'ui'), { recursive: true });
        fs.writeFileSync(path.join(fx.work, 'ui', 'demo-widget.js'), 'export const key = "npm_' + 'a'.repeat(30) + '";\n');
        const contract = { bugId: 'QA-004', allowedFiles: ['ui/demo-widget.js'], summary: 'demo' };
        const receipt = await runSuite(fx.cfg, 'smoke', contract, { patchUnderTest: true });
        assert.equal(receipt.status, 'PASS');
        assert.ok(g.changedFiles(fx.cfg).includes('ui/demo-widget.js'), 'QA-SPEC-GIT-004 未跟踪的新文件必须进入待提交集合，不能只扫 git diff');
        assert.throws(() => g.commitPush(fx.cfg, contract, readJSON(receipt.receiptPath), new Store(path.join(fx.cfg.qaRoot, 'state')), false), { code: 'SECRET_DETECTED' }, 'QA-SPEC-GIT-004 新文件中的凭据在暂存前即被拒绝');
        assert.equal(fx.raw(['diff', '--cached', '--name-only'], fx.work).trim(), '', 'QA-SPEC-GIT-004 拒绝后不得留下已暂存内容');
        assert.equal(fx.raw(['rev-list', '--count', 'HEAD'], fx.work), '2', 'QA-SPEC-GIT-004 拒绝后不得产生提交');
    }
    finally {
        await fx.close();
    }
});
test('a push whose remote confirmation is lost is not retried blindly', async () => {
    const fx = await makeRunnerFixture();
    try {
        // 远端 hook 模拟“远程已经收到提交，但客户端拿到的 main 不是这次提交的 SHA”。
        fs.writeFileSync(path.join(fx.remote, 'hooks', 'post-receive'), '#!/bin/sh\nnew=$(git rev-parse refs/heads/main)\nparent=$(git rev-parse refs/heads/main^)\ngit update-ref refs/heads/qa-pushed $new\ngit update-ref refs/heads/main $parent\nexit 0\n', { mode: 0o755 });
        const contract = { bugId: 'QA-005', allowedFiles: ['a.txt'], summary: 'demo' };
        const receipt = await fx.runReal(contract);
        const store = new Store(path.join(fx.cfg.qaRoot, 'state'));
        let error = null;
        try { g.commitPush(fx.cfg, contract, readJSON(receipt.receiptPath), store, true); }
        catch (e) { error = e; }
        assert.ok(error, 'QA-SPEC-GIT-005 远程确认失败时必须报错，不得记为已推送');
        assert.equal(error.code, 'PUSH_UNCONFIRMED', 'QA-SPEC-GIT-005 远程 SHA 不匹配时必须阻断');
        const localHead = fx.raw(['rev-parse', 'HEAD'], fx.work);
        assert.equal(fx.raw(['rev-parse', 'refs/heads/qa-pushed'], fx.remote), localHead, 'QA-SPEC-GIT-005 远程已收到的提交必须完整保留');
        assert.equal(fx.raw(['rev-list', '--count', 'refs/heads/qa-pushed'], fx.remote), '3', 'QA-SPEC-GIT-005 远程不得出现重复提交');
        const opId = 'commit-' + contract.bugId + '-' + receipt.fingerprint;
        assert.equal(store.beginOperation(opId, { parent: receipt.head }).existing, true, 'QA-SPEC-GIT-005 操作 ID 必须留在日志里供人工对账');
        let second = null;
        try { g.commitPush(fx.cfg, contract, readJSON(receipt.receiptPath), store, true); }
        catch (e) { second = e; }
        assert.ok(second, 'QA-SPEC-GIT-005 确认丢失后不得盲目重推');
        assert.equal(fx.raw(['rev-list', '--count', 'refs/heads/qa-pushed'], fx.remote), '3', 'QA-SPEC-GIT-005 重试不得产生第二个提交');
    }
    finally {
        await fx.close();
    }
});
test('a controlled revert keeps the remote history intact', async () => {
    const fx = await makeRunnerFixture();
    try {
        const contract = { bugId: 'QA-007', allowedFiles: ['a.txt'], summary: 'demo' };
        const receipt = await fx.runReal(contract);
        const pushed = g.commitPush(fx.cfg, contract, readJSON(receipt.receiptPath), new Store(path.join(fx.cfg.qaRoot, 'state')), true);
        assert.equal(pushed.status, 'PUSHED_CI_PENDING');
        fx.raw(['revert', '--no-edit', pushed.sha], fx.work);
        const revertSha = fx.raw(['rev-parse', 'HEAD'], fx.work).trim();
        fx.raw(['push', 'origin', 'HEAD:refs/heads/main'], fx.work);
        assert.equal(fx.raw(['rev-parse', 'refs/heads/main'], fx.remote).trim(), revertSha, 'QA-SPEC-GIT-007 受控回退以新提交落地，不改写远程历史');
        assert.equal(fx.raw(['rev-list', '--count', 'refs/heads/main'], fx.remote).trim(), '4', 'QA-SPEC-GIT-007 远程历史保留全部提交，不得改写或强推');
        assert.equal(fs.readFileSync(path.join(fx.work, 'a.txt'), 'utf8'), 'a', 'QA-SPEC-GIT-007 回退后源码回到修复前状态，数据恢复另行验证');
    }
    finally {
        await fx.close();
    }
});
test('a fix and a cleanup cannot be committed under one contract', async () => {
    const fx = await makeRunnerFixture();
    try {
        const store = new Store(path.join(fx.cfg.qaRoot, 'state'));
        const fixContract = { bugId: 'QA-008', allowedFiles: ['a.txt'], summary: 'fix' };
        const fixReceipt = await fx.runReal(fixContract);
        g.commitPush(fx.cfg, fixContract, readJSON(fixReceipt.receiptPath), store, true);
        // 清理文件与修复文件不在同一个任务里：修复任务的合同不允许它，清理任务单独收据。
        fs.writeFileSync(path.join(fx.work, 'dead-code.js'), 'module.exports = 1;\n');
        await assert.rejects(() => runSuite(fx.cfg, 'smoke', fixContract, { patchUnderTest: true }), { code: 'OUT_OF_SCOPE' }, 'QA-SPEC-GIT-008 清理文件不在修复任务的文件许可内，必须拆成两个任务');
        const cleanupContract = { bugId: 'QA-009', allowedFiles: ['dead-code.js'], kind: 'cleanup', summary: 'cleanup' };
        const cleanupReceipt = await runSuite(fx.cfg, 'smoke', cleanupContract, { patchUnderTest: true });
        assert.throws(() => g.commitPush(fx.cfg, fixContract, readJSON(cleanupReceipt.receiptPath), store, false), { code: 'CONTRACT_CHANGED' }, 'QA-SPEC-GIT-008 清理任务的收据绑的是另一个合同，不得用于修复任务提交');
        const plan = g.commitPush(fx.cfg, cleanupContract, readJSON(cleanupReceipt.receiptPath), store, false);
        assert.deepEqual(plan.files, ['dead-code.js'], 'QA-SPEC-GIT-008 清理任务单独提交，各自绑定自己的收据');
        assert.throws(() => g.verifyReceipt(fx.cfg, readJSON(cleanupReceipt.receiptPath), fixContract), { code: 'CONTRACT_CHANGED' }, 'QA-SPEC-GIT-008 两个任务的收据互不通用');
    }
    finally {
        await fx.close();
    }
});
