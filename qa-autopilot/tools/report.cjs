'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { readJSON, atomicJSON } = require('../lib/safety.cjs');
function report(cfg) {
    const root = path.join(cfg.qaRoot, 'artifacts'), receipts = [];
    if (fs.existsSync(root))
        for (const d of fs.readdirSync(root, { withFileTypes: true })) {
            if (!d.isDirectory() || d.isSymbolicLink())
                continue;
            const p = path.join(root, d.name, 'receipt.json');
            if (fs.existsSync(p))
                receipts.push(readJSON(p));
        }
    const cases = readJSON(path.join(cfg.qaRoot, 'config', 'test-cases.json')).cases;
    const result = { schema: 1, at: new Date().toISOString(), status: 'NOT_RELEASE_APPROVED', requiredCases: cases.length,
        recordedSuiteRuns: receipts.length, passedRuns: receipts.filter(r => r.status === 'PASS').length,
        failedRuns: receipts.filter(r => r.status !== 'PASS').length,
        limitation: 'Suite receipts alone do not prove all matrix cases. Case-level, same-RC acceptance must be audited before stable approval.' };
    atomicJSON(path.join(cfg.qaRoot, 'reports', 'runs', 'summary-' + Date.now() + '.json'), result);
    return result;
}
module.exports = { report };
