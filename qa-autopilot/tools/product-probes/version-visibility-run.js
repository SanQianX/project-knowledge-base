#!/usr/bin/env node
'use strict';
// FEATURE-VERSIONS-01-R2 runner — model-free gates for the brand hover-tooltip
// version lane. No paid models, no quota reads, no npm latest checks.
//   --check      syntax + module-load check of the three R2 files
//   --run test   the offline acceptance test (real isolated server, no browser)
//   --run browser  the real-Chrome CDP browser probe (hover/focus/unknown)
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const TEST = path.join(REPO_ROOT, '_site', '_test', 'version-visibility-test.js');
const PROBE = path.join(REPO_ROOT, '_site', '_test', 'version-visibility-browser-probe.js');
const FIXTURE = path.join(REPO_ROOT, '_site', '_test', 'helpers', 'version-visibility-fixture.js');

function runNode(file, label) {
  const result = spawnSync(process.execPath, [file], { stdio: 'inherit', windowsHide: true });
  console.log(`[${label}] exit=${result.status}${result.error ? ` error=${result.error.message}` : ''}`);
  return result.status === 0;
}

function check() {
  const { spawnSync: sync } = require('node:child_process');
  let ok = true;
  for (const file of [FIXTURE, TEST, PROBE]) {
    const result = sync(process.execPath, ['--check', file], { windowsHide: true });
    console.log(`[syntax] ${path.relative(REPO_ROOT, file)} -> ${result.status === 0 ? 'ok' : 'FAIL'}`);
    if (result.status !== 0) ok = false;
  }
  // fixture loads Chrome resolution eagerly; module-load check catches that too
  const loadFixture = sync(process.execPath, ['-e', `require(${JSON.stringify(FIXTURE)}); console.log('fixture-load ok, chrome=' + require(${JSON.stringify(FIXTURE)}).CHROME_PATH)`], { windowsHide: true, encoding: 'utf8' });
  console.log(loadFixture.stdout.trim() || loadFixture.stderr.trim());
  if (loadFixture.status !== 0) ok = false;
  console.log(ok ? 'CHECK-PASS version-visibility-run' : 'CHECK-FAIL version-visibility-run');
  process.exitCode = ok ? 0 : 1;
}

const mode = process.argv[2] || '--check';
if (mode === '--check') check();
else if (mode === '--run' && process.argv[3] === 'test') process.exitCode = runNode(TEST, 'test') ? 0 : 1;
else if (mode === '--run' && process.argv[3] === 'browser') process.exitCode = runNode(PROBE, 'browser') ? 0 : 1;
else { console.error('usage: version-visibility-run.js --check | --run test | --run browser'); process.exitCode = 2; }
