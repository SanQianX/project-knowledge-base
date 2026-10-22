'use strict';
// L-QA-01 治理与隔离回归。/ Governance and isolation regressions.
//
// 每条规则都有正反例：不是“文档里写了隔离”，而是执行后能证明隔离成立或被破坏。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const g = require('../lib/git.cjs');
const iso = require('../lib/isolation.cjs');
const { commandSync, readJSON } = require('../lib/safety.cjs');
const { fetchQuota } = require('../lib/quota.cjs');

const PROTECTED_CFG = {
    protected: {
        desktop: { host: '127.0.0.1', port: 5757, pid: 37368, version: '5.0.24' },
        dataDir: 'C:\\Users\\SanQian\\.project-knowledge-v5',
        knowledgeRoot: 'D:\\SanQian.Xu\\knowledge',
        globalNpmRoot: 'C:\\Users\\SanQian\\AppData\\Roaming\\npm',
        reservedPorts: [5757, 5760, 5789],
        files: ['C:\\Users\\SanQian\\AppData\\Roaming\\npm\\node_modules\\@sanqianx\\project-knowledge\\package.json']
    }
};

function tempDir(tag) { return fs.mkdtempSync(path.join(os.tmpdir(), 'qa-gov-' + tag + '-')); }
function rawGit(cwd, args) { return commandSync('git', args, { cwd, timeout: 60000 }); }

/** 建立一个真实的 source + bare remote，用于验证 clone、基准与 ref 行为。 */
function makeSourceRepo() {
    const root = tempDir('repo');
    const remote = path.join(root, 'remote.git');
    const source = path.join(root, 'source');
    rawGit(root, ['init', '--bare', '-q', '-b', 'main', remote]);
    fs.mkdirSync(source, { recursive: true });
    rawGit(source, ['init', '-q', '-b', 'main']);
    rawGit(source, ['config', 'user.name', 'QA']);
    rawGit(source, ['config', 'user.email', 'qa@local.invalid']);
    fs.mkdirSync(path.join(source, '.github', 'workflows'), { recursive: true });
    fs.writeFileSync(path.join(source, '.github', 'workflows', 'publish.yml'), "on:\n  push:\n    tags: ['v*']\n");
    fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0' }));
    rawGit(source, ['add', '-A']);
    rawGit(source, ['commit', '-qm', 'base']);
    rawGit(source, ['remote', 'add', 'origin', remote]);
    rawGit(source, ['push', '-q', 'origin', 'main']);
    return { root, remote, source };
}

function makeCfg(fixture) {
    const qaRoot = path.join(fixture.root, 'control');
    fs.mkdirSync(qaRoot, { recursive: true });
    return {
        qaRoot,
        sourceRoot: fixture.source,
        repoRoot: path.join(qaRoot, '.runtime', 'workspaces', 'main'),
        githubRepo: 'SanQianX/project-knowledge-base',
        mainBranch: 'main',
        originAllowlist: [fixture.remote],
        tools: { git: 'git', node: process.execPath, npmCli: '' },
        authorization: { localCloneEnabled: true, controllerIsolationVerified: true, remoteWriteEnabled: false },
        limits: { maxChangedFiles: 15, maxPatchBytes: 200000 }
    };
}

// ---------------------------------------------------------------- main-only 治理

test('main is the only accepted branch', () => {
    assert.equal(g.branchName('main'), 'main');
    assert.equal(g.mainBranch({ mainBranch: 'main' }), 'main');
});

for (const b of ['qa/continuous-repair-20261020', 'qa/x', 'feature/test', 'backup/pre-clean-history', 'release/5.0.25', 'master', ''])
    test('branch forbidden: ' + (b || '(empty)'), () => {
        assert.throws(() => g.branchName(b), e => e.code === 'BRANCH_FORBIDDEN');
    });

test('configured branch other than main is rejected', () => {
    assert.throws(() => g.mainBranch({ mainBranch: 'qa/legacy' }), e => e.code === 'BRANCH_FORBIDDEN');
});

// ---------------------------------------------------------------- 基准不再建 tag / 分支

test('baseline creates no tag, no extra branch and no remote ref', () => {
    const fixture = makeSourceRepo();
    try {
        const cfg = makeCfg(fixture);
        const receipt = g.baseline(cfg, true);
        assert.equal(receipt.mode, 'sha-receipt');
        assert.equal(receipt.status, 'LOCAL_BASELINE_CONFIRMED');
        assert.equal(receipt.baseSha, rawGit(fixture.source, ['rev-parse', 'HEAD']));
        // 没有基准 tag
        assert.equal(rawGit(cfg.repoRoot, ['tag']).trim(), '');
        assert.equal(rawGit(fixture.remote, ['tag']).trim(), '');
        // 没有 QA/备份/发布分支
        assert.deepEqual(rawGit(cfg.repoRoot, ['branch', '--format=%(refname:short)']).split('\n').map(s => s.trim()).filter(Boolean), ['main']);
        // 远端只多出 main 本身
        const refs = rawGit(fixture.remote, ['for-each-ref', '--format=%(refname)']).split('\n').map(s => s.trim()).filter(Boolean);
        assert.deepEqual(refs, ['refs/heads/main']);
        // 收据落盘
        const stored = readJSON(path.join(cfg.qaRoot, 'state', 'baseline.json'));
        assert.equal(stored.baseSha, receipt.baseSha);
        assert.equal(stored.clone.checks.onlyMainBranch, true);
    }
    finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
});

test('baseline without local clone authorization is refused', () => {
    const fixture = makeSourceRepo();
    try {
        const cfg = makeCfg(fixture);
        cfg.authorization.localCloneEnabled = false;
        assert.throws(() => g.baseline(cfg, true), e => e.code === 'CLONE_NOT_AUTHORIZED');
        assert.equal(fs.existsSync(cfg.repoRoot), false);
    }
    finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
});

test('baseline dry run creates nothing', () => {
    const fixture = makeSourceRepo();
    try {
        const cfg = makeCfg(fixture);
        const plan = g.baseline(cfg, false);
        assert.equal(plan.dryRun, true);
        assert.equal(fs.existsSync(cfg.repoRoot), false);
        assert.equal(rawGit(fixture.remote, ['for-each-ref', '--format=%(refname)']).split('\n').map(s => s.trim()).filter(Boolean).length, 1);
    }
    finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- 隔离 clone 自证

test('isolated clone proves origin, HEAD, cleanliness and independence', () => {
    const fixture = makeSourceRepo();
    try {
        const cfg = makeCfg(fixture);
        const verified = g.prepareClone(cfg);
        assert.equal(verified.ok, true);
        assert.equal(verified.checks.originExact, true);
        assert.equal(verified.checks.originMatchesSource, true);
        assert.equal(verified.checks.onMain, true);
        assert.equal(verified.checks.headMatchesRemoteMain, true, 'QA-SPEC-GIT-002 隔离 clone 必须用 ls-remote 核对远程 main 的完整 SHA，不能把命令成功当成远程完成');
        assert.equal(verified.checks.worktreeClean, true);
        assert.equal(verified.checks.distinctFromSource, true);
        assert.equal(verified.checks.noHardlinkedObjects, true);
        assert.equal(verified.checks.onlyMainBranch, true);
        assert.notEqual(verified.root, fs.realpathSync(cfg.sourceRoot));
    }
    finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
});

test('a QA branch inside the clone breaks the clone self-check', () => {
    const fixture = makeSourceRepo();
    try {
        const cfg = makeCfg(fixture);
        g.prepareClone(cfg);
        rawGit(cfg.repoRoot, ['branch', 'qa/should-not-exist']);
        const verified = g.verifyClone(cfg);
        assert.equal(verified.ok, false);
        assert.equal(verified.checks.onlyMainBranch, false);
        rawGit(cfg.repoRoot, ['branch', '-D', 'qa/should-not-exist']);
        assert.equal(g.verifyClone(cfg).ok, true);
    }
    finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
});

test('a dirty clone breaks the clone self-check', () => {
    const fixture = makeSourceRepo();
    try {
        const cfg = makeCfg(fixture);
        g.prepareClone(cfg);
        fs.writeFileSync(path.join(cfg.repoRoot, 'dirty.txt'), 'x');
        const verified = g.verifyClone(cfg);
        assert.equal(verified.ok, false);
        assert.equal(verified.checks.worktreeClean, false);
        fs.unlinkSync(path.join(cfg.repoRoot, 'dirty.txt'));
        assert.equal(g.verifyClone(cfg).ok, true);
    }
    finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
});

test('a foreign origin breaks the clone self-check', () => {
    const fixture = makeSourceRepo();
    try {
        const cfg = makeCfg(fixture);
        g.prepareClone(cfg);
        rawGit(cfg.repoRoot, ['remote', 'set-url', 'origin', 'https://example.invalid/other.git']);
        const verified = g.verifyClone(cfg);
        assert.equal(verified.ok, false);
        assert.equal(verified.checks.originExact, false);
    }
    finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
});

test('the work root may not be the user worktree', () => {
    const fixture = makeSourceRepo();
    try {
        const cfg = makeCfg(fixture);
        cfg.repoRoot = cfg.sourceRoot;
        assert.throws(() => g.prepareClone(cfg), e => e.code === 'SOURCE_WRITE_FORBIDDEN');
    }
    finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
});

test('the work root must live under .runtime/workspaces', () => {
    const fixture = makeSourceRepo();
    try {
        const cfg = makeCfg(fixture);
        cfg.repoRoot = path.join(fixture.root, 'escape');
        assert.throws(() => g.prepareClone(cfg), e => e.code === 'WORKROOT_ESCAPE');
    }
    finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
});

test('an existing non-git work root is not overwritten', () => {
    const fixture = makeSourceRepo();
    try {
        const cfg = makeCfg(fixture);
        fs.mkdirSync(cfg.repoRoot, { recursive: true });
        fs.writeFileSync(path.join(cfg.repoRoot, 'keep.txt'), 'keep');
        assert.throws(() => g.prepareClone(cfg), e => e.code === 'WORKROOT_INVALID');
        assert.equal(fs.existsSync(path.join(cfg.repoRoot, 'keep.txt')), true);
    }
    finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- 环境隔离

test('product environment is isolated: data dirs, module URLs, port, credentials', () => {
    const run = tempDir('env');
    try {
        const env = iso.productEnv(PROTECTED_CFG, run, { KB_SITE_PORT: '45231' });
        const check = iso.assertEnvIsolated(env, PROTECTED_CFG, { runRoot: run });
        assert.deepEqual(check.violations, []);
        assert.equal(check.ok, true);
        assert.equal(path.resolve(env.KB_DATA_DIR).startsWith(path.resolve(run)), true);
        assert.equal(path.resolve(env.KB_KNOWLEDGE_DATA_DIR).startsWith(path.resolve(run)), true);
        assert.equal(env.KB_KNOWLEDGE_ENGINE_URL, iso.DEAD_MODULE_URL);
        assert.equal(env.KB_EVENTBRIDGE_URL, iso.DEAD_MODULE_URL);
        assert.equal(env.KB_TERMINAL_URL, iso.DEAD_MODULE_URL);
        assert.equal(env.KB_VECTORHUB_URL, iso.DEAD_MODULE_URL);
        assert.equal(env.KB_DEAD_MODULE_PORT, undefined, '死地址端口只是构造参数，不是环境变量');
        assert.equal(env.KB_MODULES_AUTOSTART, '0');
        assert.equal(env.MINIMAX_API_KEY, undefined);
    }
    finally { fs.rmSync(run, { recursive: true, force: true }); }
});

test('inherited module URLs and keys never reach the product environment', () => {
    const run = tempDir('inherit');
    const saved = {};
    const injected = { KB_KNOWLEDGE_ENGINE_URL: 'http://127.0.0.1:5790', KB_EVENTBRIDGE_URL: 'http://127.0.0.1:8790', MINIMAX_API_KEY: 'sk-live-should-not-leak' };
    try {
        for (const [k, v] of Object.entries(injected)) { saved[k] = process.env[k]; process.env[k] = v; }
        const env = iso.productEnv(PROTECTED_CFG, run);
        assert.equal(env.KB_KNOWLEDGE_ENGINE_URL, iso.DEAD_MODULE_URL);
        assert.equal(env.KB_EVENTBRIDGE_URL, iso.DEAD_MODULE_URL);
        assert.equal(env.MINIMAX_API_KEY, undefined);
        assert.equal(iso.assertEnvIsolated(env, PROTECTED_CFG, { runRoot: run }).ok, true);
    }
    finally {
        for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
        fs.rmSync(run, { recursive: true, force: true });
    }
});

test('the dead module URL uses a legal port, not port zero', () => {
    // 产品的 module-port-resolver 要求端口 1..65535，端口 0 会被判
    // INVALID_MODULE_URL，让产品用例直接抛错而不是被隔离。
    const run = tempDir('dead-module-port');
    try {
        const env = iso.productEnv(PROTECTED_CFG, run);
        for (const key of iso.MODULE_URL_KEYS) {
            const port = Number(new URL(env[key]).port);
            assert.ok(port >= 1 && port <= 65535, key + ' 的端口必须是合法端口，实际 ' + env[key]);
        }
        assert.equal(iso.assertEnvIsolated(env, PROTECTED_CFG, { runRoot: run }).ok, true);
    }
    finally { fs.rmSync(run, { recursive: true, force: true }); }
});

test('a run-specific dead module port is used for every module URL', () => {
    const run = tempDir('dead-module-port-2');
    try {
        const env = iso.productEnv(PROTECTED_CFG, run, { KB_DEAD_MODULE_PORT: 45311 });
        for (const key of iso.MODULE_URL_KEYS) assert.equal(env[key], 'http://127.0.0.1:45311', key);
        assert.equal(env.KB_DEAD_MODULE_PORT, undefined);
        assert.equal(iso.assertEnvIsolated(env, PROTECTED_CFG, { runRoot: run }).ok, true);
    }
    finally { fs.rmSync(run, { recursive: true, force: true }); }
});

test('a module URL on a protected port is a violation', () => {
    const run = tempDir('bad-module-url');
    try {
        const env = iso.productEnv(PROTECTED_CFG, run);
        env.KB_TERMINAL_URL = 'http://127.0.0.1:5760';
        const check = iso.assertEnvIsolated(env, PROTECTED_CFG, { runRoot: run });
        assert.equal(check.ok, false);
        assert.ok(check.violations.some(v => v.includes('KB_TERMINAL_URL')));
    }
    finally { fs.rmSync(run, { recursive: true, force: true }); }
});

test('a module URL with port zero is a violation', () => {
    const run = tempDir('bad-module-url-zero');
    try {
        const env = iso.productEnv(PROTECTED_CFG, run);
        env.KB_VECTORHUB_URL = 'http://127.0.0.1:0';
        const check = iso.assertEnvIsolated(env, PROTECTED_CFG, { runRoot: run });
        assert.equal(check.ok, false);
        assert.ok(check.violations.some(v => v.includes('KB_VECTORHUB_URL')));
    }
    finally { fs.rmSync(run, { recursive: true, force: true }); }
});

test('bridge capture stays enabled and the journal location is what isolates it', () => {
    // AI_CODING_EVENT_BRIDGE_CAPTURE=0 会让 capture 用例拿不到 turnId；
    // 隔离靠 AI_CODING_EVENT_BRIDGE_HOME 落在隔离运行目录内。
    const run = tempDir('bridge-home');
    try {
        const env = iso.productEnv(PROTECTED_CFG, run);
        assert.notEqual(env.AI_CODING_EVENT_BRIDGE_CAPTURE, '0');
        assert.equal(path.resolve(env.AI_CODING_EVENT_BRIDGE_HOME).startsWith(path.resolve(run)), true);
        assert.equal(iso.assertEnvIsolated(env, PROTECTED_CFG, { runRoot: run }).ok, true);
    }
    finally { fs.rmSync(run, { recursive: true, force: true }); }
});

test('a bridge journal outside the isolated run directory is a violation', () => {
    const run = tempDir('bad-bridge-home');
    try {
        const env = iso.productEnv(PROTECTED_CFG, run);
        env.AI_CODING_EVENT_BRIDGE_HOME = path.join(os.tmpdir(), 'qa-real-journal');
        const check = iso.assertEnvIsolated(env, PROTECTED_CFG, { runRoot: run });
        assert.equal(check.ok, false);
        assert.ok(check.violations.some(v => v.includes('AI_CODING_EVENT_BRIDGE_HOME')));
    }
    finally { fs.rmSync(run, { recursive: true, force: true }); }
});

test('a data directory pointing at the real desktop data is a violation', () => {
    const run = tempDir('bad-data');
    try {
        const env = iso.productEnv(PROTECTED_CFG, run);
        env.KB_DATA_DIR = PROTECTED_CFG.protected.dataDir;
        const check = iso.assertEnvIsolated(env, PROTECTED_CFG, { runRoot: run });
        assert.equal(check.ok, false);
        assert.ok(check.violations.some(v => v.includes('KB_DATA_DIR')));
    }
    finally { fs.rmSync(run, { recursive: true, force: true }); }
});

test('a knowledge directory pointing at the real knowledge root is a violation', () => {
    const run = tempDir('bad-know');
    try {
        const env = iso.productEnv(PROTECTED_CFG, run);
        env.KB_KNOWLEDGE_DATA_DIR = PROTECTED_CFG.protected.knowledgeRoot;
        const check = iso.assertEnvIsolated(env, PROTECTED_CFG, { runRoot: run });
        assert.equal(check.ok, false);
        assert.ok(check.violations.some(v => v.includes('KB_KNOWLEDGE_DATA_DIR')));
    }
    finally { fs.rmSync(run, { recursive: true, force: true }); }
});

test('a real module URL in the child environment is a violation', () => {
    const run = tempDir('bad-module');
    try {
        const env = iso.productEnv(PROTECTED_CFG, run);
        env.KB_KNOWLEDGE_ENGINE_URL = 'http://127.0.0.1:5790';
        const check = iso.assertEnvIsolated(env, PROTECTED_CFG, { runRoot: run });
        assert.equal(check.ok, false);
        assert.ok(check.violations.some(v => v.includes('KB_KNOWLEDGE_ENGINE_URL')));
    }
    finally { fs.rmSync(run, { recursive: true, force: true }); }
});

test('module command variables are reset to a falsy value, not the string zero', () => {
    // 产品用真值判定模块命令（`if (process.env.KB_VECTORHUB_COMMAND)`）。
    // 置 '0' 仍是真值，会让产品以为“已配置显式命令”，从而改变受保护实例的行为。
    const run = tempDir('module-command');
    try {
        const env = iso.productEnv(PROTECTED_CFG, run);
        for (const key of iso.MODULE_COMMAND_KEYS) assert.equal(env[key], '', key + ' 必须为空串');
        assert.equal(iso.assertEnvIsolated(env, PROTECTED_CFG, { runRoot: run }).ok, true);
    }
    finally { fs.rmSync(run, { recursive: true, force: true }); }
});

test('a module command left as the string zero is a violation', () => {
    const run = tempDir('bad-module-command');
    try {
        const env = iso.productEnv(PROTECTED_CFG, run);
        env.KB_VECTORHUB_COMMAND = '0';
        const check = iso.assertEnvIsolated(env, PROTECTED_CFG, { runRoot: run });
        assert.equal(check.ok, false);
        assert.ok(check.violations.some(v => v.includes('KB_VECTORHUB_COMMAND')));
    }
    finally { fs.rmSync(run, { recursive: true, force: true }); }
});

test('binding the protected desktop port is a violation', () => {
    const run = tempDir('bad-port');
    try {
        const env = iso.productEnv(PROTECTED_CFG, run, { KB_SITE_PORT: '5757' });
        const check = iso.assertEnvIsolated(env, PROTECTED_CFG, { runRoot: run });
        assert.equal(check.ok, false);
        assert.ok(check.violations.some(v => v.includes('KB_SITE_PORT')));
    }
    finally { fs.rmSync(run, { recursive: true, force: true }); }
});

test('a secret in the child environment is a violation', () => {
    const run = tempDir('bad-secret');
    try {
        const env = iso.productEnv(PROTECTED_CFG, run);
        env.ANTHROPIC_API_KEY = 'sk-ant-should-not-be-here';
        const check = iso.assertEnvIsolated(env, PROTECTED_CFG, { runRoot: run });
        assert.equal(check.ok, false);
        assert.ok(check.violations.some(v => v.includes('ANTHROPIC_API_KEY')));
    }
    finally { fs.rmSync(run, { recursive: true, force: true }); }
});

test('the product environment refuses to accept a secret key', () => {
    const run = tempDir('bad-add');
    try {
        assert.throws(() => iso.productEnv(PROTECTED_CFG, run, { MINIMAX_API_KEY: 'x' }), /ENV_FORBIDDEN/);
    }
    finally { fs.rmSync(run, { recursive: true, force: true }); }
});

test('protected path detection covers data dir, knowledge root and global npm', () => {
    assert.equal(iso.isProtectedPath('C:\\Users\\SanQian\\.project-knowledge-v5', PROTECTED_CFG), true);
    assert.equal(iso.isProtectedPath('C:\\Users\\SanQian\\.project-knowledge-v5\\projects', PROTECTED_CFG), true);
    assert.equal(iso.isProtectedPath('D:\\SanQian.Xu\\knowledge', PROTECTED_CFG), true);
    assert.equal(iso.isProtectedPath('C:\\Users\\SanQian\\AppData\\Roaming\\npm\\node_modules', PROTECTED_CFG), true);
    assert.equal(iso.isProtectedPath('D:\\SanQian.Xu\\project-knowledge-base\\qa-autopilot\\.runtime\\runs\\x', PROTECTED_CFG), false);
    assert.equal(iso.isProtectedPath(PROTECTED_CFG.protected.files[0], PROTECTED_CFG), true);
});

// ---------------------------------------------------------------- 受保护目标前后对比

function fakeSnapshot(overrides = {}) {
    return {
        schema: 'qa-autopilot/protected-snapshot/v1',
        desktop: { pid: 37368, port: 5757, alive: true, health: { ok: true, body: { ok: true, projects: 7 } } },
        files: [{ path: 'C:\\pkg\\package.json', sha256: 'aaa' }],
        dirs: { dataDir: { path: 'C:\\data', exists: true, fingerprint: 'dir1' } },
        ...overrides
    };
}

test('identical protected snapshots report no drift', () => {
    assert.deepEqual(iso.diffProtected(fakeSnapshot(), fakeSnapshot()), []);
});

test('a changed protected file is reported', () => {
    const after = fakeSnapshot({ files: [{ path: 'C:\\pkg\\package.json', sha256: 'bbb' }] });
    const drift = iso.diffProtected(fakeSnapshot(), after);
    assert.equal(drift.length, 1);
    assert.equal(drift[0].reason, 'PROTECTED_FILE_CHANGED');
});

test('a replaced desktop process is reported', () => {
    const after = fakeSnapshot({ desktop: { pid: 999, port: 5757, alive: true, health: { ok: true, body: { ok: true, projects: 7 } } } });
    const drift = iso.diffProtected(fakeSnapshot(), after);
    assert.ok(drift.some(d => d.reason === 'DESKTOP_PID_CHANGED'));
});

test('a stopped desktop is reported', () => {
    const after = fakeSnapshot({ desktop: { pid: 37368, port: 5757, alive: false, health: { ok: true, body: { ok: true, projects: 7 } } } });
    const drift = iso.diffProtected(fakeSnapshot(), after);
    assert.ok(drift.some(d => d.reason === 'DESKTOP_LIFECYCLE_CHANGED'));
});

test('a lost desktop health endpoint is reported', () => {
    const after = fakeSnapshot({ desktop: { pid: 37368, port: 5757, alive: true, health: { ok: false, status: 0, body: null } } });
    const drift = iso.diffProtected(fakeSnapshot(), after);
    assert.ok(drift.some(d => d.reason === 'DESKTOP_HEALTH_LOST'));
});

test('a changed real data directory is reported as an observation, not a violation', () => {
    const after = fakeSnapshot({ dirs: { dataDir: { path: 'C:\\data', exists: true, fingerprint: 'dir2' } } });
    const drift = iso.diffProtected(fakeSnapshot(), after);
    assert.ok(drift.some(d => d.reason === 'PROTECTED_DIR_CHANGED'));
    const classified = iso.classifyDrift(drift);
    assert.equal(classified.violations.length, 0, '真实可变目录的变化不能归因于 QA，不得判为越界');
    assert.equal(classified.observations.length, 1, '真实可变目录的变化必须被记录为观察项');
});

test('a changed desktop project count is reported', () => {
    const after = fakeSnapshot({ desktop: { pid: 37368, port: 5757, alive: true, health: { ok: true, body: { ok: true, projects: 6 } } } });
    const drift = iso.diffProtected(fakeSnapshot(), after);
    assert.ok(drift.some(d => d.reason === 'DESKTOP_PROJECT_COUNT_CHANGED'));
});

// ---------------------------------------------------------------- 执行前端口/路径筛查

test('preflight flags a test file that hardcodes the protected port', () => {
    const repo = tempDir('preflight');
    try {
        fs.mkdirSync(path.join(repo, '_site', '_test'), { recursive: true });
        fs.writeFileSync(path.join(repo, '_site', '_test', 'safe-test.js'), 'const port = 45311;');
        fs.writeFileSync(path.join(repo, '_site', '_test', 'risky-test.js'), 'const port = 5757;');
        const ok = iso.preflightSuite(repo, ['safe-test.js'], PROTECTED_CFG);
        assert.equal(ok.ok, true);
        const bad = iso.preflightSuite(repo, ['risky-test.js'], PROTECTED_CFG);
        assert.equal(bad.ok, false);
        assert.equal(bad.findings[0].kind, 'PROTECTED_PORT_LITERAL');
    }
    finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test('preflight flags a test file that names the real data directory', () => {
    const repo = tempDir('preflight-path');
    try {
        fs.mkdirSync(path.join(repo, '_site', '_test'), { recursive: true });
        fs.writeFileSync(path.join(repo, '_site', '_test', 'leaky-test.js'), "const dir = 'C:\\\\Users\\\\SanQian\\\\.project-knowledge-v5';");
        const bad = iso.preflightSuite(repo, ['leaky-test.js'], PROTECTED_CFG);
        assert.equal(bad.ok, false);
        assert.ok(bad.findings.some(f => f.kind === 'PROTECTED_PATH_LITERAL'));
    }
    finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- 额度：只读代理已发布状态

test('published quota file yields a KNOWN percentage without touching a key', async () => {
    const dir = tempDir('quota');
    try {
        const file = path.join(dir, 'quota-status.json');
        fs.writeFileSync(file, JSON.stringify({ quota: { state: 'KNOWN', model: 'general', remainingPercent: 99, fiveHourRemainingPercent: 99, weeklyRemainingPercent: null, source: 'explicit_percent', checkedAt: Date.now() }, gate: { state: 'RUNNING', admitTask: true } }));
        const q = await fetchQuota({ mode: 'published-file', file, modelNames: ['general'], weeklyUnlimitedApproved: true });
        assert.equal(q.state, 'KNOWN');
        assert.equal(q.remainingPercent, 99);
        assert.equal(q.source, 'published_explicit_percent');
    }
    finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('an unknown published quota state is refused', async () => {
    const dir = tempDir('quota-unknown');
    try {
        const file = path.join(dir, 'quota-status.json');
        fs.writeFileSync(file, JSON.stringify({ quota: { state: 'UNKNOWN' } }));
        await assert.rejects(() => fetchQuota({ mode: 'published-file', file, modelNames: ['general'], weeklyUnlimitedApproved: true }), e => e.code === 'QUOTA_UNKNOWN');
    }
    finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a missing published quota file is refused', async () => {
    await assert.rejects(() => fetchQuota({ mode: 'published-file', file: path.join(os.tmpdir(), 'qa-no-such-quota.json'), modelNames: ['general'] }), e => e.code === 'QUOTA_NOT_CONFIGURED');
});

// ------------------------------------------------ 运行身份：/api/runtime/identity

/**
 * 起一个假的运行实例，只回答 /api/runtime/identity。
 * body 可以是对象，也可以是 (port) => 对象，用来报出真实监听端口。
 */
function fakeDesktop(body, status = 200) {
    const http = require('node:http');
    let boundPort = 0;
    const server = http.createServer((req, res) => {
        if (req.url === '/api/runtime/identity') {
            res.writeHead(status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(typeof body === 'function' ? body(boundPort) : body));
            return;
        }
        res.writeHead(404); res.end('{}');
    });
    return new Promise(resolve => {
        server.listen(0, '127.0.0.1', () => {
            const port = server.address().port;
            boundPort = port;
            resolve({
                port,
                cfg: {
                    protected: {
                        desktop: { host: '127.0.0.1', port, pid: process.pid, version: '5.0.24' },
                        dataDir: 'C:\\Users\\SanQian\\.project-knowledge-v5'
                    }
                },
                close: () => new Promise(r => server.close(r))
            });
        });
    });
}

test('a matching runtime identity passes the gate', async () => {
    const d = await fakeDesktop(port => ({ version: '5.0.24', pid: process.pid, dataDir: 'C:\\Users\\SanQian\\.project-knowledge-v5', port, host: '127.0.0.1' }));
    try {
        const gate = await iso.assertRuntimeIdentity(d.cfg);
        assert.equal(gate.ok, true, gate.violations.join('; '));
        assert.equal(gate.identity.body.version, '5.0.24');
    }
    finally { await d.close(); }
});

test('a replaced desktop version is refused by the identity gate', async () => {
    const d = await fakeDesktop(port => ({ version: '5.0.25', pid: process.pid, dataDir: 'C:\\Users\\SanQian\\.project-knowledge-v5', port, host: '127.0.0.1' }));
    try {
        const gate = await iso.assertRuntimeIdentity(d.cfg);
        assert.equal(gate.ok, false);
        assert.ok(gate.violations.some(v => v.startsWith('IDENTITY_VERSION_MISMATCH')));
    }
    finally { await d.close(); }
});

test('a replaced desktop pid is refused by the identity gate', async () => {
    const d = await fakeDesktop(port => ({ version: '5.0.24', pid: 424242, dataDir: 'C:\\Users\\SanQian\\.project-knowledge-v5', port, host: '127.0.0.1' }));
    try {
        const gate = await iso.assertRuntimeIdentity(d.cfg);
        assert.equal(gate.ok, false);
        assert.ok(gate.violations.some(v => v.startsWith('IDENTITY_PID_MISMATCH')));
    }
    finally { await d.close(); }
});

test('a redirected desktop data directory is refused by the identity gate', async () => {
    const d = await fakeDesktop(port => ({ version: '5.0.24', pid: process.pid, dataDir: 'C:\\tmp\\elsewhere', port, host: '127.0.0.1' }));
    try {
        const gate = await iso.assertRuntimeIdentity(d.cfg);
        assert.equal(gate.ok, false);
        assert.ok(gate.violations.some(v => v.startsWith('IDENTITY_DATADIR_MISMATCH')));
    }
    finally { await d.close(); }
});

test('an incomplete protected configuration blocks the identity gate', async () => {
    const gate = await iso.assertRuntimeIdentity({ protected: { desktop: { host: '127.0.0.1', port: 5757 } } });
    assert.equal(gate.ok, false);
    assert.ok(gate.violations.some(v => v.startsWith('PROTECTED_CONFIG_MISSING')));
});

test('an unreachable identity endpoint blocks the identity gate', async () => {
    const cfg = { protected: { desktop: { host: '127.0.0.1', port: 1, pid: process.pid, version: '5.0.24' }, dataDir: 'C:\\data' } };
    const gate = await iso.assertRuntimeIdentity(cfg);
    assert.equal(gate.ok, false);
    assert.ok(gate.violations.some(v => v.startsWith('IDENTITY_UNREACHABLE')));
});

test('an identity change between snapshots is reported', () => {
    const before = { desktop: { pid: 1, port: 5757, alive: true, health: { ok: true, status: 200, body: { projects: 1 } } }, identity: { ok: true, body: { version: '5.0.24', pid: 1, dataDir: 'C:\\data' } }, files: [], dirs: {} };
    const after = { desktop: { pid: 1, port: 5757, alive: true, health: { ok: true, status: 200, body: { projects: 1 } } }, identity: { ok: true, body: { version: '5.0.25', pid: 2, dataDir: 'C:\\other' } }, files: [], dirs: {} };
    const drift = iso.diffProtected(before, after);
    assert.ok(drift.some(d => d.reason === 'IDENTITY_VERSION_CHANGED'));
    assert.ok(drift.some(d => d.reason === 'IDENTITY_PID_CHANGED'));
    assert.ok(drift.some(d => d.reason === 'IDENTITY_DATADIR_CHANGED'));
});

// ------------------------------------------------ 具名静态单元例外：按内容哈希绑定

test('a named exception releases a reviewed static unit test', () => {
    const repo = tempDir('preflight-exception');
    try {
        fs.mkdirSync(path.join(repo, '_site', '_test'), { recursive: true });
        const file = 'reviewed-unit-test.js';
        fs.writeFileSync(path.join(repo, '_site', '_test', file), 'const port = 5757;');
        const sha256 = iso.fileHash(path.join(repo, '_site', '_test', file));
        const cfg = {
            protected: PROTECTED_CFG.protected,
            preflightExceptions: [{ file, sha256, reason: 'reviewed static unit test', approvedBy: 'leader' }]
        };
        const out = iso.preflightSuite(repo, [file], cfg);
        assert.equal(out.ok, true);
        assert.equal(out.findings[0].kind, 'PROTECTED_PORT_LITERAL_EXCEPTED');
        assert.equal(out.exceptionsApplied.length, 1);
    }
    finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test('an exception does not survive a change of the source file', () => {
    const repo = tempDir('preflight-stale');
    try {
        fs.mkdirSync(path.join(repo, '_site', '_test'), { recursive: true });
        const file = 'reviewed-unit-test.js';
        fs.writeFileSync(path.join(repo, '_site', '_test', file), 'const port = 5757;');
        const stale = iso.fileHash(path.join(repo, '_site', '_test', file));
        fs.writeFileSync(path.join(repo, '_site', '_test', file), 'const port = 5757; const extra = 1;');
        const cfg = {
            protected: PROTECTED_CFG.protected,
            preflightExceptions: [{ file, sha256: stale, reason: 'reviewed static unit test' }]
        };
        const out = iso.preflightSuite(repo, [file], cfg);
        assert.equal(out.ok, false);
        assert.equal(out.blocking[0].kind, 'PROTECTED_PORT_LITERAL');
    }
    finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test('an exception never releases a protected path literal', () => {
    const repo = tempDir('preflight-path-exception');
    try {
        fs.mkdirSync(path.join(repo, '_site', '_test'), { recursive: true });
        const file = 'reviewed-unit-test.js';
        fs.writeFileSync(path.join(repo, '_site', '_test', file), "const dir = 'C:\\Users\\SanQian\\.project-knowledge-v5';");
        const sha256 = iso.fileHash(path.join(repo, '_site', '_test', file));
        const cfg = {
            protected: PROTECTED_CFG.protected,
            preflightExceptions: [{ file, sha256, reason: 'reviewed static unit test' }]
        };
        const out = iso.preflightSuite(repo, [file], cfg);
        assert.equal(out.ok, false);
        assert.equal(out.blocking[0].kind, 'PROTECTED_PATH_LITERAL');
    }
    finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test('an exception without a review reason is ignored', () => {
    const repo = tempDir('preflight-noreason');
    try {
        fs.mkdirSync(path.join(repo, '_site', '_test'), { recursive: true });
        const file = 'reviewed-unit-test.js';
        fs.writeFileSync(path.join(repo, '_site', '_test', file), 'const port = 5757;');
        const sha256 = iso.fileHash(path.join(repo, '_site', '_test', file));
        const cfg = { protected: PROTECTED_CFG.protected, preflightExceptions: [{ file, sha256 }] };
        const out = iso.preflightSuite(repo, [file], cfg);
        assert.equal(out.ok, false);
        assert.equal(out.blocking[0].kind, 'PROTECTED_PORT_LITERAL');
    }
    finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

// ------------------------------------------------ 静态安装产物：递归清单哈希

test('a recursive install manifest covers nested files and changes when they change', () => {
    const dir = tempDir('install-manifest');
    try {
        fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"x"}');
        fs.writeFileSync(path.join(dir, 'lib', 'runtime.cjs'), 'module.exports = 1;');
        const before = iso.directoryManifest(dir);
        assert.equal(before.count, 2);
        assert.ok(before.files.some(f => f.path === 'lib/runtime.cjs'));
        fs.writeFileSync(path.join(dir, 'lib', 'runtime.cjs'), 'module.exports = 2;');
        const after = iso.directoryManifest(dir);
        assert.notEqual(before.manifestHash, after.manifestHash);
    }
    finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a changed install manifest is reported as a protected violation', () => {
    const before = { desktop: { pid: 1, port: 5757, alive: true, health: { ok: true, status: 200, body: { projects: 1 } } }, files: [], dirs: {}, installs: { 'C:/npm/pkg': { manifestHash: 'aaa', files: [] } } };
    const after = { desktop: { pid: 1, port: 5757, alive: true, health: { ok: true, status: 200, body: { projects: 1 } } }, files: [], dirs: {}, installs: { 'C:/npm/pkg': { manifestHash: 'bbb', files: [] } } };
    const drift = iso.diffProtected(before, after);
    assert.ok(drift.some(d => d.reason === 'INSTALL_MANIFEST_CHANGED'));
});

// ------------------------------------------- 受保护目录指纹：现场桌面在跑时不得误报

test('the live desktop writing inside a protected directory is not a violation', () => {
    const dir = tempDir('live-dir');
    try {
        fs.writeFileSync(path.join(dir, 'settings.json'), '{"a":1}');
        fs.writeFileSync(path.join(dir, 'desktop-backend.log'), 'line-1\n');
        fs.mkdirSync(path.join(dir, 'events'));
        const before = iso.directoryFingerprint(dir);
        // 现场桌面继续写自己的事件与日志：目录内容变化，但顶层身份不变。
        fs.writeFileSync(path.join(dir, 'events', '2026-10-23.jsonl'), '{}\n');
        fs.appendFileSync(path.join(dir, 'desktop-backend.log'), 'line-2\n');
        const after = iso.directoryFingerprint(dir);
        assert.equal(before.fingerprint, after.fingerprint);
        const drift = iso.diffProtected(
            { desktop: { pid: 1, port: 5757, alive: true, health: { ok: true, status: 200, body: { projects: 1 } } }, files: [], dirs: { dataDir: before } },
            { desktop: { pid: 1, port: 5757, alive: true, health: { ok: true, status: 200, body: { projects: 1 } } }, files: [], dirs: { dataDir: after } }
        );
        assert.equal(drift.length, 0);
    }
    finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a new top-level file in a protected directory is recorded in detail but stays an observation', () => {
    const dir = tempDir('added-file');
    try {
        fs.writeFileSync(path.join(dir, 'settings.json'), '{"a":1}');
        const before = iso.directoryFingerprint(dir);
        fs.writeFileSync(path.join(dir, 'qa-wrote-here.json'), '{}');
        const after = iso.directoryFingerprint(dir);
        const drift = iso.diffProtected(
            { desktop: { pid: 1, port: 5757, alive: true, health: { ok: true, status: 200, body: { projects: 1 } } }, files: [], dirs: { dataDir: before } },
            { desktop: { pid: 1, port: 5757, alive: true, health: { ok: true, status: 200, body: { projects: 1 } } }, files: [], dirs: { dataDir: after } }
        );
        const hit = drift.find(d => d.reason === 'PROTECTED_DIR_CHANGED');
        assert.ok(hit);
        assert.deepEqual(hit.added, ['qa-wrote-here.json']);
        assert.equal(iso.classifyDrift(drift).violations.length, 0, '目录级差异没有归因能力，不得直接判为 QA 越界');
    }
    finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a changed protected data file is recorded in detail', () => {
    const dir = tempDir('changed-file');
    try {
        fs.writeFileSync(path.join(dir, 'settings.json'), '{"a":1}');
        const before = iso.directoryFingerprint(dir);
        fs.writeFileSync(path.join(dir, 'settings.json'), '{"a":2}');
        const after = iso.directoryFingerprint(dir);
        const drift = iso.diffProtected(
            { desktop: { pid: 1, port: 5757, alive: true, health: { ok: true, status: 200, body: { projects: 1 } } }, files: [], dirs: { dataDir: before } },
            { desktop: { pid: 1, port: 5757, alive: true, health: { ok: true, status: 200, body: { projects: 1 } } }, files: [], dirs: { dataDir: after } }
        );
        const hit = drift.find(d => d.reason === 'PROTECTED_DIR_CHANGED');
        assert.ok(hit);
        assert.deepEqual(hit.changedFiles, ['settings.json']);
    }
    finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// --------------------------------- 违规与观察的分界：能归因的差异仍然必须拦住

test('a vanished protected directory is still a violation', () => {
    const before = fakeSnapshot({ dirs: { dataDir: { path: 'C:\\data', exists: true, fingerprint: 'dir1' } } });
    const after = fakeSnapshot({ dirs: { dataDir: { path: 'C:\\data', exists: false, fingerprint: 'dir1' } } });
    const classified = iso.classifyDrift(iso.diffProtected(before, after));
    assert.equal(classified.violations.length, 1, '目录消失必须继续判为越界');
    assert.equal(classified.observations.length, 0);
});

test('a changed protected file is still a violation', () => {
    const after = fakeSnapshot({ files: [{ path: 'C:\\pkg\\package.json', sha256: 'bbb' }] });
    const classified = iso.classifyDrift(iso.diffProtected(fakeSnapshot(), after));
    assert.equal(classified.violations.length, 1, '受保护文件被改必须继续判为越界');
    assert.equal(classified.observations.length, 0);
});

test('a changed install manifest is still a violation', () => {
    const before = { desktop: { pid: 1, port: 5757, alive: true, health: { ok: true, status: 200, body: { projects: 1 } } }, files: [], dirs: {}, installs: { 'C:/npm/pkg': { manifestHash: 'aaa', files: [] } } };
    const after = { desktop: { pid: 1, port: 5757, alive: true, health: { ok: true, status: 200, body: { projects: 1 } } }, files: [], dirs: {}, installs: { 'C:/npm/pkg': { manifestHash: 'bbb', files: [] } } };
    const classified = iso.classifyDrift(iso.diffProtected(before, after));
    assert.equal(classified.violations.length, 1, '静态安装清单变化必须继续判为越界');
    assert.equal(classified.observations.length, 0);
});

test('a replaced desktop instance is still a violation', () => {
    const after = fakeSnapshot({ desktop: { pid: 999, port: 5757, alive: true, health: { ok: true, body: { ok: true, projects: 7 } } } });
    const classified = iso.classifyDrift(iso.diffProtected(fakeSnapshot(), after));
    assert.ok(classified.violations.some(d => d.reason === 'DESKTOP_PID_CHANGED'), '桌面实例被替换必须继续判为越界');
});
