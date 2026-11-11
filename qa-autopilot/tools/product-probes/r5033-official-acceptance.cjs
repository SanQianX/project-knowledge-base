#!/usr/bin/env node
'use strict';
// Official acceptance for 5.0.33 next: isolated fresh install + 37-check
// browser smoke (the audited trio tool, engine pinned to 0.2.8) + THE SESSION
// INDEX INJECTION live check - the shipped e2e runs against the INSTALLED
// bytes (one index per session, silent turns, gated breadcrumbs, once-only
// memory deltas, bounded 30-turn injection) - + the npm upgrade preservation
// seed/verify pair from 5.0.32.
//
// Usage: node qa-autopilot/tools/product-probes/r5033-official-acceptance.cjs <reviewed-sha256>
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const PKB_ROOT = path.resolve(__dirname, '..', '..', '..');
const VERSION = '5.0.33';
const ENGINE_VERSION = '0.2.8';
const B = `D:/SanQian.Xu/.project-knowledge-test-temp/release-5.0.33-20261111/core5033-official`;
const ARTIFACTS = path.join(PKB_ROOT, 'qa-autopilot', 'artifacts', 'parallel-20261111');
const REVIEWED_SHA256 = process.argv[2] || '';
if (!/^[0-9a-f]{64}$/.test(REVIEWED_SHA256)) { console.error('pass the reviewed TGZ sha256 as the only argument'); process.exit(1); }

async function main() {
  fs.mkdirSync(B, { recursive: true });
  fs.mkdirSync(ARTIFACTS, { recursive: true });
  const evidence = { schema: 'qa-autopilot/official-acceptance-5033/v1', startedAt: new Date().toISOString(), reviewedSha256: REVIEWED_SHA256, steps: [], expectations: [], firstFailure: null };
  try {
    // ---- 1. Official TGZ download + digest vs reviewed bytes -----------------
    const tgz = path.join(B, `sanqianx-project-knowledge-${VERSION}.tgz`);
    if (!fs.existsSync(tgz)) spawnSync('curl', ['-sSfL', '-o', tgz, `https://registry.npmjs.org/@sanqianx/project-knowledge/-/project-knowledge-${VERSION}.tgz`], { stdio: 'inherit', windowsHide: true });
    const crypto = require('crypto');
    const sha256 = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
    const actual = sha256(tgz);
    const sri = 'sha512-' + crypto.createHash('sha512').update(fs.readFileSync(tgz)).digest('base64');
    evidence.steps.push({ step: 'official-download', sha256Match: actual === REVIEWED_SHA256, sri });
    if (actual !== REVIEWED_SHA256) throw new Error('official TGZ digest mismatch');

    // ---- 2. Isolated fresh install ------------------------------------------
    const prefix = path.join(B, 'install-prefix');
    const cache = path.join(B, 'npm-cache');
    if (!fs.existsSync(path.join(prefix, 'node_modules', '@sanqianx', 'project-knowledge', 'package.json'))) {
      fs.mkdirSync(cache, { recursive: true });
      const r = spawnSync(process.execPath, ['C:/Program Files/nodejs/node_modules/npm/bin/npm-cli.js', 'install', '--prefix', prefix, tgz, '--ignore-scripts', '--no-audit', '--no-fund', '--prefer-offline', '--fetch-retries=0', '--fetch-timeout=120000', '--cache', cache, '--registry=https://registry.npmjs.org', '--userconfig', path.join(B, 'npmrc-empty'), '--globalconfig', path.join(B, 'npmrc-global-empty')], { encoding: 'utf8', windowsHide: true, timeout: 300000 });
      if (r.status !== 0) throw new Error('fresh install failed: ' + String(r.stderr).slice(0, 300));
    }
    const installed = JSON.parse(fs.readFileSync(path.join(prefix, 'node_modules', '@sanqianx', 'project-knowledge', 'package.json'), 'utf8')).version;
    const installedEngine = JSON.parse(fs.readFileSync(path.join(prefix, 'node_modules', '@sanqianx', 'ai-coding-knowledge-engine', 'package.json'), 'utf8')).version;
    evidence.steps.push({ step: 'fresh-install', version: installed, engine: installedEngine });

    // ---- 3. The 37-check browser smoke on the official trio ------------------
    const trio = {
      core: tgz,
      wb: 'D:/SanQian.Xu/.project-knowledge-test-temp/release-5.0.30-20261106-leader/core5030-official/official-artifacts/sanqianx-claude-ai-workbench-0.13.13.tgz',
      bridge: 'D:/SanQian.Xu/.project-knowledge-test-temp/release-5.0.25-20261024-leader/artifacts/official-modules/sanqianx-ai-coding-event-bridge-console-0.7.4.tgz',
    };
    const smoke = spawnSync(process.execPath, [path.join(PKB_ROOT, 'desktop', 'test', 'release-browser-5025-smoke.cjs'),
      '--core-tarball', trio.core, '--wb-tarball', trio.wb, '--bridge-tarball', trio.bridge,
      '--owned-cache', path.join(prefix, 'node_modules'),
      '--output-root', path.join(B, 'smoke'),
      '--expect-engine-version', ENGINE_VERSION,
      '--provenance', 'official-next-download'], { encoding: 'utf8', windowsHide: true, timeout: 15 * 60 * 1000, cwd: PKB_ROOT });
    evidence.steps.push({ step: 'browser-smoke', exit: smoke.status, tail: String(smoke.stdout || '').trim().split('\n').slice(-3).join(' | ') });
    if (smoke.status !== 0) throw new Error('37-check browser smoke failed');

    // ---- 4. SESSION INDEX INJECTION live check on the installed bytes --------
    // The shipped e2e proves the installed package itself implements the
    // once-per-session index, silent turns, gated breadcrumbs, once-only
    // memory deltas and the bounded 30-turn cumulative injection.
    const shipped = path.join(prefix, 'node_modules', '@sanqianx', 'project-knowledge', '_site', '_test', 'context-session-index-test.js');
    const session = spawnSync(process.execPath, [shipped], { encoding: 'utf8', windowsHide: true, timeout: 15 * 60 * 1000, cwd: path.dirname(shipped) });
    evidence.steps.push({ step: 'session-index-e2e', exit: session.status, tail: String(session.stdout || '').trim().split('\n').slice(-2).join(' | '), stderrTail: String(session.stderr || '').trim().split('\n').slice(-3).join(' | ') });
    if (session.status !== 0) throw new Error('shipped session-index e2e failed on the installed package');

    // ---- 5. npm upgrade preservation (official 5.0.32 -> this 5.0.33) -------
    const upgradePrefix = path.join(B, 'upgrade-prefix');
    const upgradeState = path.join(B, 'upgrade-state');
    const previousTgz = path.join(B, 'sanqianx-project-knowledge-5.0.32.tgz');
    if (!fs.existsSync(previousTgz)) spawnSync('curl', ['-sSfL', '-o', previousTgz, 'https://registry.npmjs.org/@sanqianx/project-knowledge/-/project-knowledge-5.0.32.tgz'], { stdio: 'inherit', windowsHide: true });
    fs.mkdirSync(upgradePrefix, { recursive: true }); fs.mkdirSync(upgradeState, { recursive: true });
    const preservationTool = path.join(PKB_ROOT, 'qa-autopilot', 'tools', 'npm-upgrade-preservation.cjs');
    if (!fs.existsSync(path.join(upgradePrefix, 'node_modules', '@sanqianx', 'project-knowledge'))) {
      const installOld = spawnSync(process.execPath, ['C:/Program Files/nodejs/node_modules/npm/bin/npm-cli.js', 'install', '--prefix', upgradePrefix, previousTgz, '--ignore-scripts', '--no-audit', '--no-fund', '--cache', cache, '--registry=https://registry.npmjs.org', '--userconfig', path.join(B, 'npmrc-empty'), '--globalconfig', path.join(B, 'npmrc-global-empty')], { encoding: 'utf8', windowsHide: true, timeout: 300000 });
      if (installOld.status !== 0) throw new Error('previous-version install failed: ' + String(installOld.stderr).slice(0, 300));
    }
    const seed = spawnSync(process.execPath, [preservationTool, 'seed', upgradePrefix, upgradeState], { encoding: 'utf8', windowsHide: true, timeout: 15 * 60 * 1000 });
    evidence.steps.push({ step: 'preservation-seed', exit: seed.status, tail: String(seed.stdout || '').trim().split('\n').slice(-1).join('') });
    if (seed.status !== 0) throw new Error('preservation seed failed: ' + String(seed.stderr).slice(0, 300));
    const upgrade = spawnSync(process.execPath, ['C:/Program Files/nodejs/node_modules/npm/bin/npm-cli.js', 'install', '--prefix', upgradePrefix, tgz, '--ignore-scripts', '--no-audit', '--no-fund', '--cache', cache, '--registry=https://registry.npmjs.org', '--userconfig', path.join(B, 'npmrc-empty'), '--globalconfig', path.join(B, 'npmrc-global-empty')], { encoding: 'utf8', windowsHide: true, timeout: 300000 });
    if (upgrade.status !== 0) throw new Error('upgrade install failed: ' + String(upgrade.stderr).slice(0, 300));
    const verify = spawnSync(process.execPath, [preservationTool, 'verify', upgradePrefix, upgradeState, VERSION], { encoding: 'utf8', windowsHide: true, timeout: 15 * 60 * 1000 });
    evidence.steps.push({ step: 'preservation-verify', exit: verify.status, tail: String(verify.stdout || '').trim().split('\n').slice(-1).join('') });
    if (verify.status !== 0) throw new Error('preservation verify failed: ' + String(verify.stderr).slice(0, 300));

    evidence.expectations.push({ key: 'official-bytes-and-install', pass: actual === REVIEWED_SHA256 && installed === VERSION && installedEngine === ENGINE_VERSION, observed: { sha256Match: actual === REVIEWED_SHA256, installed, installedEngine } });
    evidence.expectations.push({ key: 'browser-smoke-37', pass: smoke.status === 0, observed: { exit: smoke.status } });
    evidence.expectations.push({ key: 'session-index-injection', pass: session.status === 0, observed: { exit: session.status } });
    evidence.expectations.push({ key: 'npm-upgrade-preservation', pass: seed.status === 0 && verify.status === 0, observed: { seed: seed.status, verify: verify.status } });

    evidence.finishedAt = new Date().toISOString();
    evidence.verdict = evidence.expectations.every(e => e.pass) ? 'PASS' : 'FAIL';
    fs.writeFileSync(path.join(ARTIFACTS, 'official-5033.json'), JSON.stringify(evidence, null, 2));
    console.log(`[r5033] official-${VERSION} ${evidence.verdict}`);
    process.exitCode = evidence.verdict === 'PASS' ? 0 : 1;
  } catch (error) {
    evidence.firstFailure = String(error && error.stack || error);
    evidence.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(ARTIFACTS, 'official-5033.json'), JSON.stringify(evidence, null, 2));
    console.error(`[r5033] FATAL ${evidence.firstFailure}`);
    process.exitCode = 1;
  }
}
main();
