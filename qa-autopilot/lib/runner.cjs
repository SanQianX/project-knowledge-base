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
                cwd: cfg.repoRoot, env: isolatedEnv(childDir), logDir: path.join(evidenceDir, file), timeoutMs: cfg.limits?.perTestTimeoutMs || 120000
            });
            const skipped = /#\s*SKIP\b|\bSKIP(?:PED)?\b|browser tests are excluded/i.test(result.stdout + result.stderr) ? 1 : 0;
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
module.exports = { selectTests, runSuite };
