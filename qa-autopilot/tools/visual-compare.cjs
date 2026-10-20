'use strict';
const fs = require('node:fs'), path = require('node:path');
const { must, hash, readJSON, atomicJSON } = require('../lib/safety.cjs');
const { decode, encode, diff } = require('../lib/png.cjs');
function compareFiles(baseFile, currentFile, approval, environmentId, out) { must(approval.approved === true && approval.environmentId === environmentId && approval.sha256 === hash(fs.readFileSync(baseFile)), 'BASELINE_NOT_APPROVED', 'Matching reviewed visual baseline and environment required.', 20); must(Number.isFinite(approval.channelTolerance) && Number.isFinite(approval.maxChangedRatio), 'VISUAL_POLICY', 'Baseline thresholds require explicit review.'); const r = diff(decode(baseFile), decode(currentFile), approval); fs.mkdirSync(out, { recursive: true }); fs.writeFileSync(path.join(out, 'diff.png'), encode(r.diffImage)); delete r.diffImage; r.kind = 'visual-pair'; r.baselineHash = approval.sha256; r.currentHash = hash(fs.readFileSync(currentFile)); r.environmentId = environmentId; r.note = 'Pixel comparison does not prove usability or authorize a new baseline.'; atomicJSON(path.join(out, 'comparison.json'), r); return r; }
if (require.main === module) {
    try {
        const r = compareFiles(process.argv[2], process.argv[3], readJSON(process.argv[4]), process.argv[5], process.argv[6]);
        console.log(JSON.stringify(r));
        if (r.status !== 'PASS')
            process.exitCode = 10;
    }
    catch (e) {
        console.error(e.message);
        process.exitCode = e.exitCode || 2;
    }
}
module.exports = { compareFiles };
