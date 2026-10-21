'use strict';
const fs = require('node:fs'), path = require('node:path');
const { must, readJSON, atomicJSON, commandSync } = require('../lib/safety.cjs');
const { isRC, validatePack } = require('../lib/registry.cjs');
const PACKAGE = '@sanqianx/project-knowledge';
async function meta(v, allowMissing = false) { const r = await fetch('https://registry.npmjs.org/' + encodeURIComponent(PACKAGE) + '/' + encodeURIComponent(v), { redirect: 'error', signal: AbortSignal.timeout(20000) }); if (r.status === 404 && allowMissing)
    return null; must(r.ok, 'REGISTRY', 'Registry lookup failed'); return r.json(); }
function validateTag(version, ref) { must(isRC(version) && ref === 'refs/tags/qa-rc/' + version, 'RC_TAG', 'Tag/version mismatch or non-RC version'); }
async function main() {
    const action = process.argv[2], pkg = readJSON('package.json');
    must(pkg.name === PACKAGE, 'PACKAGE', 'Wrong package');
    validateTag(pkg.version, process.env.GITHUB_REF);
    must(process.env.GITHUB_REPOSITORY === 'SanQianX/project-knowledge-base' && process.env.RUNNER_TEMP, 'CI_IDENTITY', 'Only the approved GitHub workflow can run this helper');
    const dir = path.join(process.env.RUNNER_TEMP, 'qa-rc');
    fs.mkdirSync(dir, { recursive: true });
    const sha = commandSync('git', ['rev-parse', 'HEAD']);
    must(sha === process.env.GITHUB_SHA, 'HEAD', 'Checkout SHA mismatch');
    if (action === 'pre') {
        must(await meta(pkg.version, true) === null, 'VERSION_EXISTS', 'Version already exists; reconcile instead of republishing');
        const latest = await meta('latest');
        atomicJSON(path.join(dir, 'before.json'), { name: pkg.name, version: pkg.version, sha, latest: latest.version, at: new Date().toISOString() });
    }
    else if (action === 'pack') {
        const list = readJSON(process.argv[3]);
        must(list.length === 1 && list[0].name === PACKAGE && list[0].version === pkg.version, 'PACK_ID', 'Wrong pack artifact');
        validatePack(list[0].files);
        must(/^[A-Za-z0-9._-]+\.tgz$/.test(list[0].filename), 'TARBALL_NAME', 'Invalid tarball filename');
        const file = path.join(dir, list[0].filename);
        must(fs.existsSync(file), 'TARBALL_MISSING', 'Tarball missing');
        must(process.env.GITHUB_OUTPUT, 'GITHUB_OUTPUT', 'Missing workflow output');
        fs.appendFileSync(process.env.GITHUB_OUTPUT, 'tarball=' + file + '\n');
    }
    else if (action === 'post') {
        const before = readJSON(path.join(dir, 'before.json')), pack = readJSON(process.argv[3])[0];
        let found = null;
        for (let attempt = 0; attempt < 12; attempt++) {
            found = await meta(pkg.version, true);
            if (found?.dist?.integrity)
                break;
            await new Promise(r => setTimeout(r, 10000));
        }
        must(found && found.dist.integrity === pack.integrity, 'INTEGRITY', 'Registry artifact differs or not yet available; do not rerun publish blindly');
        must((await meta('latest')).version === before.latest, 'LATEST_CHANGED', 'latest changed during RC publication; preserve evidence and block');
        must((await meta('next')).version === pkg.version, 'NEXT_CHANGED', 'next is not this candidate');
        atomicJSON(path.join(dir, 'registry-receipt.json'), { status: 'PUBLISHED_NOT_INSTALLED', name: PACKAGE, version: pkg.version, sha, integrity: found.dist.integrity, latestUnchanged: true });
    }
    else
        throw Error('Unknown RC guard action');
}
if (require.main === module)
    main().catch(e => { console.error(e.message); process.exitCode = 20; });
module.exports = { validateTag };
