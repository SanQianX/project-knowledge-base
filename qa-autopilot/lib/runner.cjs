'use strict';
// A passing process is not full product acceptance. / 进程通过不等于完整产品验收。
const fs = require('node:fs');
const path = require('node:path');
const { must, hash, readJSON, atomicJSON, ownedRun, setRunStatus, isolatedEnv, runLogged, safeName, acquireLock } = require('./safety.cjs');
const { snapshot, assertRepo } = require('./git.cjs');
function selectTests(repo, suite, config) {
    const root = path.join(repo, '_site', '_test');
    const available = fs.readdirSync(root).filter(f => f.endsWith('-test.js')).sort();
    must(available.length > 0, 'NO_TESTS', 'Canonical test discovery returned no files.');
    if (suite === 'all')
        return available;
    const names = config[suite];
    must(Array.isArray(names) && names.length > 0, 'UNKNOWN_SUITE', 'Suite must have an explicit, nonempty file list.');
    for (const f of names)
        must(available.includes(f), 'TEST_MISSING', 'Test file missing at this checkout: ' + f, 20);
    return names;
}
/**
 * 隔离环境会重写 LOCALAPPDATA，机器级浏览器的安装位置因此不可见。
 * 产品自带的 _site/_test/helpers/find-chrome.js 已把 KB_CHROME_PATH 作为首选候选，
 * 这里只把经审阅的浏览器路径透传下去；不改动产品代码，也不放宽 profile 隔离
 * （CDP helper 始终用新建 profile 目录，真实用户 profile 不被读写）。
 */
function browserEnv(cfg) {
    const configured = cfg.browser && cfg.browser.chromePath;
    return configured ? { KB_CHROME_PATH: configured } : {};
}
/**
 * Windows MAX_PATH 是 260。QA 的运行目录本身很深
 * （.runtime/runs/<suite>-<ts>/<test-file>/tmp/...），
 * 产品测试再在其中创建 Lance 的 _transactions/<uuid>.txn 时会超限，
 * 以 ENOENT（os error 3）失败。给子进程一个系统短路径下的独立临时根，
 * 既保留每个 run 相互隔离，又把最坏路径压到上限以内。
 * 运行证据仍由 runLogged 写入 qaRoot/artifacts，run 目录仍在 qaRoot/.runtime。
 */
function shortTempEnv(run) {
    const os = require("node:os");
    const tag = path.basename(run).slice(-12).replace(/[^A-Za-z0-9-]/g, "");
    const base = path.join(os.tmpdir(), "qa-" + tag);
    fs.mkdirSync(base, { recursive: true });
    return { TEMP: base, TMP: base, TMPDIR: base };
}

/**
 * 浏览器用例需要真实的应用数据视图。
 * Chrome 在 Windows 上用 HOME/USERPROFILE/LOCALAPPDATA 判断默认用户数据目录；
 * 这几个变量被重定向时，Chrome 认为给定的 --user-data-dir 就是默认目录，
 * 于是拒绝 --remote-debugging（DevTools remote debugging requires a
 * non-default data directory）。纯真实环境下端口 0 模式可正常写出
 * DevToolsActivePort。
 * 产品的数据隔离并不依赖这些变量：知识目录、桥接目录、Claude 配置目录、
 * npm 缓存与模块开关都有各自独立的位置，因此只对引用 cdp-browser 的用例
 * 放宽这四项，其余隔离照旧。判定方式与产品自带 run-all-tests.js 相同。
 */
function browserCapableEnv(cfg, run) {
    const env = Object.assign(isolatedEnv(run, browserEnv(cfg)), shortTempEnv(run));
    for (const key of ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA"]) {
        if (process.env[key]) env[key] = process.env[key];
    }
    return env;
}

/** 该用例是否依赖真实浏览器（与产品 run-all-tests.js 的判定一致）。 */
function needsBrowser(file) {
    try { return fs.readFileSync(file, "utf8").includes("helpers/cdp-browser"); }
    catch { return false; }
}

async function runSuite(cfg, suite, contract) {
    assertRepo(cfg, false);
    must(fs.realpathSync(cfg.repoRoot) !== fs.realpathSync(cfg.sourceRoot), 'ORIGINAL_WORKTREE', 'Execute product tests in the isolated QA clone.');
    const release = acquireLock(path.join(cfg.qaRoot, 'state', 'test.lock'), { suite });
    try {
        const before = snapshot(cfg), names = selectTests(cfg.repoRoot, suite, readJSON(path.join(cfg.qaRoot, 'config', 'suites.json')));
        const id = 'test-' + safeName(suite) + '-' + Date.now(), run = ownedRun(cfg.qaRoot, id);
        const evidenceDir = path.join(cfg.qaRoot, 'artifacts', id);
        fs.mkdirSync(evidenceDir, { recursive: true });
        const results = [];
        for (const file of names) {
            const childDir = path.join(run, path.basename(file, '.js'));
            fs.mkdirSync(childDir);
            const result = await runLogged(cfg.tools.node, [path.join(cfg.repoRoot, '_site/_test', file)], {
                cwd: cfg.repoRoot,
                env: needsBrowser(path.join(cfg.repoRoot, "_site/_test", file)) ? browserCapableEnv(cfg, childDir) : Object.assign(isolatedEnv(childDir, browserEnv(cfg)), shortTempEnv(childDir)),
                logDir: path.join(evidenceDir, file), timeoutMs: cfg.limits?.perTestTimeoutMs || 120000
            });
            const skipped = /#\s*SKIP\b|\uFE63|^\s*SKIP(?:PED)?\b|\bbrowser tests are excluded\b/.test(result.stdout + result.stderr) ? 1 : 0;
            const r = { file, exitCode: result.code, signal: result.signal, durationMs: result.durationMs, timedOut: result.timedOut, skipped, status: result.code === 0 && !result.timedOut && !result.error && !skipped ? 'PASS' : skipped && result.code === 0 ? 'BLOCKED_CAPABILITY' : 'FAIL' };
            results.push(r);
            atomicJSON(path.join(evidenceDir, 'progress.json'), { id, results });
        }
        const after = snapshot(cfg), allPass = results.every(x => x.status === 'PASS'), unchanged = after.fingerprint === before.fingerprint;
        const receipt = { schema: 1, kind: 'suite', id, suite, head: before.head, fingerprint: before.fingerprint,
            contractHash: hash(JSON.stringify(contract)), startedFrom: cfg.repoRoot, node: process.version,
            status: allPass && unchanged ? 'PASS' : 'FAIL', exitCode: allPass && unchanged ? 0 : 10,
            executed: results.length, skipped: results.reduce((n, r) => n + r.skipped, 0), timedOut: results.some(r => r.timedOut), flaky: false,
            sourceUnchanged: unchanged, results, at: new Date().toISOString() };
        atomicJSON(path.join(evidenceDir, 'receipt.json'), receipt);
        setRunStatus(run, receipt.status === 'PASS' ? 'PASSED' : 'FAILED');
        return { ...receipt, receiptPath: path.join(evidenceDir, 'receipt.json') };
    }
    finally {
        release();
    }
}
module.exports = { selectTests, runSuite, browserEnv, shortTempEnv, browserCapableEnv, needsBrowser };
