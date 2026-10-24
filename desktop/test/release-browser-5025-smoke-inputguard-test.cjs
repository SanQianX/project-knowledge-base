'use strict';
// desktop/test/release-browser-5025-smoke-inputguard-test.cjs
//
// Focused input-guard test for release-browser-5025-smoke.cjs: every case is a
// BAD-INPUT combination that the tool must reject BEFORE spawning any service
// (no core CLI, no modules, no browser). Mock tarballs are packed locally with
// the repo's System32 bsdtar; no network, no npm, no product bytes.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const TOOL = path.join(__dirname, 'release-browser-5025-smoke.cjs');
const coreTarballLib = require('./release-preflight-5025-core-tarball.cjs');

function makeTgz(dir, packageJson) {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'r14guard-src-'));
  fs.mkdirSync(path.join(src, 'package'));
  fs.writeFileSync(path.join(src, 'package', 'package.json'), `${JSON.stringify(packageJson, null, 2)}\n`);
  const tgz = path.join(dir, `mock-${Date.now()}-${Math.random().toString(36).slice(2)}.tgz`);
  const r = spawnSync(coreTarballLib.bsdtar(), ['-czf', tgz, '-C', src, 'package'], {
    encoding: 'utf8', windowsHide: true, timeout: 30000,
  });
  fs.rmSync(src, { recursive: true, force: true });
  if (r.status !== 0) throw new Error(`mock tgz pack failed: ${(r.stderr || '').slice(-200)}`);
  return tgz;
}

const run = (argv) => {
  const r = spawnSync(process.execPath, [TOOL, ...argv], { encoding: 'utf8', windowsHide: true, timeout: 120000 });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
};

const cases = [];
const check = (name, ok, detail) => {
  cases.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'r14guard-'));
try {
  const ownedCache = path.join(tmp, 'node_modules');
  fs.mkdirSync(path.join(ownedCache, '@sanqianx', 'project-knowledge'), { recursive: true });
  fs.writeFileSync(path.join(ownedCache, '@sanqianx', 'project-knowledge', 'package.json'),
    `${JSON.stringify({ name: '@sanqianx/project-knowledge', version: '5.0.24' })}\n`);
  const outRoot = path.join(tmp, 'out');
  fs.mkdirSync(outRoot);

  // 1. no arguments -> usage rejection before anything else
  let r = run([]);
  check('usage-rejects-no-args', r.code !== 0 && r.out.includes('usage'), `exit ${r.code}`);

  // 2. nonexistent input path
  r = run(['--core-tarball', path.join(tmp, 'missing.tgz'), '--wb-tarball', 'nope.tgz',
    '--bridge-tarball', 'nope.tgz', '--owned-cache', ownedCache, '--output-root', outRoot]);
  check('rejects-missing-input', r.code !== 0 && r.out.includes('missing or not found'), `exit ${r.code}`);

  // 3. output root inside the source repository
  const repoRoot = path.resolve(__dirname, '..', '..');
  r = run(['--core-tarball', tmp, '--wb-tarball', tmp, '--bridge-tarball', tmp,
    '--owned-cache', ownedCache, '--output-root', path.join(repoRoot, 'tmp-r14-guard')]);
  check('rejects-output-root-inside-repo', r.code !== 0 && r.out.includes('outside the source repository'), `exit ${r.code}`);

  // mock trio: correct names, fresh (unpublished) versions
  const CORE = { name: '@sanqianx/project-knowledge', version: '9.9.9-r14guard' };
  const WB = { name: 'claude-ai-workbench', version: '8.8.8-r14guard' };
  const BRIDGE = { name: '@sanqianx/ai-coding-event-bridge-console', version: '7.7.7-r14guard' };

  // 4. wrong package name inside the core tarball
  const wbTgz = makeTgz(tmp, WB);
  const bridgeTgz = makeTgz(tmp, BRIDGE);
  r = run(['--core-tarball', makeTgz(tmp, { name: 'definitely-not-the-core', version: CORE.version }),
    '--wb-tarball', wbTgz, '--bridge-tarball', bridgeTgz, '--owned-cache', ownedCache, '--output-root', outRoot]);
  check('rejects-name-mismatch', r.code !== 0 && /packages .+, expected/.test(r.out), `exit ${r.code}`);

  // 5. the last published stable trio masquerading as the candidate
  r = run(['--core-tarball', makeTgz(tmp, { name: CORE.name, version: '5.0.24' }),
    '--wb-tarball', makeTgz(tmp, { name: WB.name, version: '0.13.6' }),
    '--bridge-tarball', makeTgz(tmp, { name: BRIDGE.name, version: '0.7.2' }),
    '--owned-cache', ownedCache, '--output-root', outRoot]);
  check('rejects-previous-stable', r.code !== 0 && r.out.includes('last published stable'), `exit ${r.code}`);

  // 6. non-exact (range) version
  r = run(['--core-tarball', makeTgz(tmp, { name: CORE.name, version: '^9.9.9' }),
    '--wb-tarball', wbTgz, '--bridge-tarball', bridgeTgz, '--owned-cache', ownedCache, '--output-root', outRoot]);
  check('rejects-non-exact-version', r.code !== 0 && r.out.includes('non-exact version'), `exit ${r.code}`);

  const failed = cases.filter((c) => !c.ok);
  console.log(failed.length === 0
    ? 'release-browser-5025-smoke-inputguard PASS (6/6 bad inputs rejected before any service start)'
    : `release-browser-5025-smoke-inputguard FAIL (${failed.length}/${cases.length} case(s) were not rejected)`);
  process.exitCode = failed.length ? 1 : 0;
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
