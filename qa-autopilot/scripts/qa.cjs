#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { readJSON, atomicJSON, must, hash, redact, cleanupPlan, applyCleanup, acquireLock } = require('../lib/safety.cjs');
const { audit, baseline, commitPush, snapshot } = require('../lib/git.cjs');
const { runSuite } = require('../lib/runner.cjs');
const { Store } = require('../lib/state.cjs');
const { fetchQuota } = require('../lib/quota.cjs');
const { packAudit, registryInfo, ciStatus, candidatePlan, tagCandidate, installRC } = require('../lib/registry.cjs');
const qaRoot = path.resolve(__dirname, '..');
function arg(name) { const i = process.argv.indexOf('--' + name); return i < 0 ? null : process.argv[i + 1]; }
async function main() {
    const command = process.argv[2] || 'help';
    const apply = process.argv.includes('--apply');
    if (command === 'help')
        return { commands: ['init', 'self-check', 'audit', 'inventory', 'baseline', 'snapshot', 'quota', 'run-suite --suite NAME --contract FILE', 'commit-push --contract FILE --receipt FILE [--apply]', 'ci', 'pack-audit', 'rc-plan', 'rc-tag --plan FILE [--apply]', 'rc-install --version x.y.z-rc.n [--apply]', 'cleanup-plan', 'cleanup-apply --plan FILE --apply', 'report'], note: 'No stable release command exists.' };
    const configPath = arg('config') || path.join(qaRoot, 'config', 'local.json');
    if (command === 'init') {
        must(!fs.existsSync(configPath), 'CONFIG_EXISTS', 'Local config exists; no overwrite.');
        const cfg = readJSON(path.join(qaRoot, 'config', 'local.example.json'));
        cfg.qaRoot = qaRoot;
        cfg.sourceRoot = path.resolve(qaRoot, '..');
        cfg.repoRoot = path.join(qaRoot, '.runtime', 'workspaces', 'repair');
        cfg.tools.node = process.execPath;
        atomicJSON(configPath, cfg, { exclusive: true });
        return { created: configPath, status: 'CONFIGURATION_REQUIRED', instruction: 'Review absolute executable paths, quota account and controller authorization. No remote write has run.' };
    }
    if (command === 'self-check') {
        const files = ['config/local.example.json', 'config/suites.json', 'config/test-cases.json', 'config/phases.json'];
        for (const f of files)
            readJSON(path.join(qaRoot, f));
        return { status: 'PASS', check: 'configuration JSON syntax', note: 'Run npm test for behavioral self-tests; this is not product acceptance.' };
    }
    must(fs.existsSync(configPath), 'CONFIG_MISSING', 'Run init, then review config/local.json.', 20);
    const cfg = readJSON(configPath);
    cfg.qaRoot = qaRoot;
    if (command === 'audit') {
        const result = audit(cfg);
        atomicJSON(path.join(qaRoot, 'reports', 'runs', 'audit-' + Date.now() + '.json'), result);
        return result;
    }
    if (command === 'inventory')
        return require('../tools/inventory.cjs').inventory(cfg);
    if (command === 'baseline') {
        const b = baseline(cfg, apply);
        if (apply)
            atomicJSON(path.join(qaRoot, 'state', 'baseline.json'), b, { exclusive: true });
        return b;
    }
    if (command === 'recover-state')
        return new Store(path.join(qaRoot, 'state')).recoverJournal();
    if (command === 'snapshot')
        return snapshot(cfg);
    if (command === 'quota') {
        const q = await fetchQuota(cfg.quota);
        atomicJSON(path.join(qaRoot, 'state', 'quota.json'), q);
        return q;
    }
    if (command === 'run-suite') {
        must(arg('contract'), 'CONTRACT', 'Provide the reviewed task contract.');
        return runSuite(cfg, arg('suite'), readJSON(arg('contract')));
    }
    if (command === 'commit-push')
        return commitPush(cfg, readJSON(arg('contract')), readJSON(arg('receipt')), new Store(path.join(qaRoot, 'state')), apply);
    if (command === 'ci')
        return ciStatus(cfg);
    if (command === 'pack-audit')
        return packAudit(cfg);
    if (command === 'rc-plan') {
        const p = await candidatePlan(cfg);
        atomicJSON(path.join(qaRoot, 'state', 'rc-plan.json'), p);
        return p;
    }
    if (command === 'rc-tag')
        return tagCandidate(cfg, readJSON(arg('plan')), apply, new Store(path.join(qaRoot, 'state')));
    if (command === 'rc-install')
        return installRC(cfg, arg('version'), apply);
    if (command === 'cleanup-plan') {
        const hours = Number(arg('hours') || 24), plan = cleanupPlan(qaRoot, hours);
        const p = { olderThanHours: hours, plan, planHash: hash(JSON.stringify(plan)) };
        atomicJSON(path.join(qaRoot, 'state', 'cleanup-plan.json'), p);
        return p;
    }
    if (command === 'cleanup-apply') {
        must(apply, 'DRY_RUN_ONLY', 'Review cleanup-plan before --apply.');
        must(cfg.authorization?.cleanupEnabled && cfg.authorization?.controllerIsolationVerified, 'CLEANUP_NOT_AUTHORIZED', 'A reviewed, exclusive controller cleanup window is required.', 20);
        for (const lock of ['supervisor.lock', 'test.lock', 'git-write.lock'])
            must(!fs.existsSync(path.join(qaRoot, 'state', lock)), 'ACTIVE_CONTROLLER', 'Stop and reconcile active controllers before cleanup.', 20);
        const release = acquireLock(path.join(qaRoot, 'state', 'cleanup.lock'));
        try {
            const result = { deletedRuns: applyCleanup(qaRoot, readJSON(arg('plan'))), at: new Date().toISOString() };
            atomicJSON(path.join(qaRoot, 'reports', 'runs', 'cleanup-' + Date.now() + '.json'), result);
            return result;
        }
        finally {
            release();
        }
    }
    if (command === 'report')
        return require('../tools/report.cjs').report(cfg);
    throw new Error('Unknown command: ' + command);
}
main().then(result => { console.log(JSON.stringify(result, null, 2)); if (result?.state === 'UNKNOWN')
    process.exitCode = 20;
else if (result?.status === 'FAIL')
    process.exitCode = 10;
else if (['PENDING', 'UNKNOWN', 'CONFIGURATION_REQUIRED'].includes(result?.status))
    process.exitCode = 20; }).catch(e => { console.error(JSON.stringify({ status: 'BLOCKED', code: e.code || 'ERROR', message: redact(e.message) })); process.exitCode = e.exitCode || 2; });
