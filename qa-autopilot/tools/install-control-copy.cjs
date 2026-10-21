'use strict';
const fs = require('node:fs'), path = require('node:path');
const { must, readJSON, noLinks, hash, atomicJSON } = require('../lib/safety.cjs');
const { assertRepo } = require('../lib/git.cjs');
function install(cfg, apply = false) { assertRepo(cfg, false); must(fs.realpathSync(cfg.repoRoot) !== fs.realpathSync(cfg.sourceRoot), 'ORIGINAL_WORKTREE', 'Use the isolated QA clone'); const manifest = readJSON(path.join(cfg.qaRoot, 'DELIVERY_MANIFEST.json')); must(manifest.schema === 1 && Array.isArray(manifest.files), 'MANIFEST', 'Invalid package manifest'); const target = path.join(cfg.repoRoot, 'qa-autopilot'); must(!fs.existsSync(target), 'TARGET_EXISTS', 'Do not overwrite a prior control copy; review changes'); const items = manifest.files.filter(x => !x.path.startsWith('reports/delivery/')); for (const x of items) {
    must(!/^(state|artifacts|\.runtime|node_modules)\//.test(x.path) && x.path !== 'config/local.json', 'CONTROL_LEAK', 'Runtime file in source copy');
    const file = noLinks(cfg.qaRoot, path.join(cfg.qaRoot, x.path));
    must(hash(fs.readFileSync(file)) === x.sha256, 'DELIVERY_CHANGED', 'Delivery manifest mismatch: ' + x.path);
    noLinks(cfg.repoRoot, path.join(target, x.path), true);
} if (!apply)
    return { dryRun: true, target, files: items.map(x => 'qa-autopilot/' + x.path) }; must(cfg.authorization?.bootstrapCopyEnabled === true, 'BOOTSTRAP_APPROVAL', 'Approve the initial QA tooling import separately', 20); for (const x of items) {
    const dest = path.join(target, x.path);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(cfg.qaRoot, x.path), dest, fs.constants.COPYFILE_EXCL);
} atomicJSON(path.join(cfg.qaRoot, 'state', 'bootstrap-copy.json'), { target, files: items.map(x => 'qa-autopilot/' + x.path), status: 'COPIED_NOT_COMMITTED' }); return { status: 'COPIED_NOT_COMMITTED', target }; }
if (require.main === module) {
    try {
        console.log(JSON.stringify(install(readJSON(process.argv[2]), process.argv.includes('--apply')), null, 2));
    }
    catch (e) {
        console.error(e.message);
        process.exitCode = e.exitCode || 2;
    }
}
module.exports = { install };
