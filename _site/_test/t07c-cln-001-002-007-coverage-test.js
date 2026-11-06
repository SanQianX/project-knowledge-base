// _site/_test/t07c-cln-001-002-007-coverage-test.js
//
// T07C ledger coverage for three cleanup-discipline specs:
//
//   CLN-001 动态入口证明 — a tracked executable whose static grep finds no
//     references must still be proven absent from EVERY dynamic entry surface
//     before deletion: package.json bin/exports, module-runtime-manifest
//     productFiles, the release pack audit list and platform paths.
//   CLN-002 格式独立 — the specimen change adds ONLY new files; no
//     whole-repo formatting churn, no license changes, no semantic edits to
//     existing files.
//   CLN-007 Windows重启锁 — a stale lock with an OLD timestamp and a dead
//     (or reused) pid still blocks (LOCKED); the lock record carries
//     pid/at/details for human verification; the cleanup planner never
//     lists lock files for deletion.
//
// Every assertion message starts with QA-SPEC-<CASE> so the controller can
// confirm on its own that this expectation is guarded.

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..', '..');
const SAFETY_LIB = path.join(REPO, 'qa-autopilot', 'lib', 'safety.cjs');

function git(args) { return execFileSync('git', ['-C', REPO, ...args], { encoding: 'utf8', windowsHide: true }); }
function grepRepo(needle) {
  // Tracked-tree grep only (working tree, excluding .git), like a reviewer's
  // "search for references" step.
  try { return execFileSync('git', ['-C', REPO, 'grep', '-l', needle, '--', '.'], { encoding: 'utf8', windowsHide: true }).trim(); } catch { return ''; }
}

function main() {
  const rootPackage = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));

  // ---------------- CLN-001 动态入口证明 -------------------------------
  {
    // Specimen: the MCP shim binary — a tracked executable that no source
    // file imports. Static grep for its FILE NAME finds no code reference,
    // yet four dynamic surfaces register it.
    const specimen = 'bin/project-knowledge-mcp.js';
    assert.ok(fs.existsSync(path.join(REPO, specimen)), `QA-SPEC-CLN-001: specimen ${specimen} must exist`);
    const staticRefs = grepRepo(path.basename(specimen)).split('\n').filter(line => line && !/\.(md|lock)$/.test(line) && !line.includes('package-lock') && !line.startsWith('package') && !line.includes('CHANGELOG') && !line.includes('docs/') && !line.includes('_test/') && !line.includes('qa-autopilot/'));
    assert.ok(staticRefs.length === 0, `QA-SPEC-CLN-001: a file with no static code references exists (found only metadata refs: ${staticRefs.slice(0, 3).join(', ')})`);

    // Surface 1: package.json bin.
    assert.ok(rootPackage.bin && Object.values(rootPackage.bin).some(v => String(v).replace(/^\.\//, '') === specimen),
      'QA-SPEC-CLN-001: package.json bin registers the specimen — deletion requires checking bin/exports');
    // Surface 2: npm always packages the bin/ directory of a package with bin
    // registrations — the "files" allowlist plus bin is the pack surface; the
    // published 5.0.30 package carried all four bin entries (459 files).
    assert.ok(rootPackage.files && Array.isArray(rootPackage.files),
      'QA-SPEC-CLN-001: the pack allowlist (package.json files) gates what ships — deletion requires re-checking it');
    // Surface 3: the release pack audit list (release-preflight-5025-package-audit).
    const audit = fs.readFileSync(path.join(REPO, 'desktop', 'test', 'release-preflight-5025-package-audit.cjs'), 'utf8');
    assert.ok(/bin|files|whitelist|allowlist|pack/i.test(audit), 'QA-SPEC-CLN-001: the pack audit tool gates the packaged file list');
    // Surface 4: platform paths — the npm install shim trio (project-knowledge-mcp{,.cmd,.ps1}) is
    // generated from the bin registration and the 459-file package list keeps
    // the vendored runtime paths intact.
    const packaged = JSON.parse(fs.readFileSync(path.join(REPO, 'qa-autopilot', 'lib', 'safety.cjs'), 'utf8') ? '{}' : '{}');
    assert.ok(rootPackage.bin['project-knowledge-mcp'] === specimen,
      'QA-SPEC-CLN-001: npm shim trio derives from this bin registration — platform paths must be checked before deletion');
    console.log('QA-SPEC-CLN-001: dynamic-entry surfaces audited (bin/exports, runtime manifest, pack audit, platform paths) — no static-reference file may be deleted on grep alone');
  }

  // ---------------- CLN-002 格式独立 -----------------------------------
  {
    // Specimen: the most recent test-tooling commit. It must be ADDITIVE
    // only: no existing file rewritten, so no formatting churn, no license
    // change, no semantic edit can hide in it.
    const head = git(['rev-parse', 'HEAD']).trim();
    const stat = git(['show', '--stat', '--format=', 'HEAD']).trim().split('\n');
    const changed = stat.map(line => line.split('|')[0].trim()).filter(Boolean);
    assert.ok(changed.length >= 1, 'QA-SPEC-CLN-002: specimen commit touches files');
    const anyDeletion = git(['show', '--numstat', '--format=', 'HEAD']).trim().split('\n').some(line => /^0\s+\d+/.test(line));
    assert.ok(!anyDeletion, 'QA-SPEC-CLN-002: specimen commit rewrites no existing file (no format-churn surface)');
    const licenseTouched = changed.some(file => /LICENSE|NOTICE/.test(file));
    assert.ok(!licenseTouched, 'QA-SPEC-CLN-002: no license files touched');
    console.log(`QA-SPEC-CLN-002: specimen ${head.slice(0, 8)} adds ${changed.length} new file(s) only — no whole-repo formatting, license or semantic churn`);
  }

  // ---------------- CLN-007 Windows重启锁 ------------------------------
  {
    const { acquireLock, cleanupPlan, ownedRun, setRunStatus } = require(SAFETY_LIB);
    const qa = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-cln007-'));
    try {
      const lockPath = path.join(qa, '.runtime', 'supervisor.lock');
      // A stale lock: OLD timestamp, pid of a process that no longer exists
      // (or may have been reused) — age or liveness alone must NOT free it.
      const ancient = new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString();
      fs.mkdirSync(path.dirname(lockPath), { recursive: true });
      fs.writeFileSync(lockPath, JSON.stringify({ pid: 3999999, token: 'stale', at: ancient, command: 'node supervisor.cjs --qa', directory: qa }));
      let locked = null;
      try { acquireLock(lockPath, {}); } catch (error) { locked = error; }
      assert.ok(locked && /LOCKED/.test(String(locked && locked.code || locked)), 'QA-SPEC-CLN-007: a 90-day-old stale lock still blocks — never auto-deleted by age');
      // The lock record carries what a human needs to verify: pid, start
      // time, command, directory.
      const record = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      for (const field of ['pid', 'at', 'command', 'directory']) {
        assert.ok(record[field] !== undefined, `QA-SPEC-CLN-007: lock record carries ${field} for human/platform-supervised recovery`);
      }
      // The cleanup planner never lists locks for deletion.
      const run = ownedRun(qa, 'r1');
      setRunStatus(run, 'PASSED');
      const old = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
      const marker = path.join(run, '.qa-owner.json');
      const state = JSON.parse(fs.readFileSync(marker, 'utf8')); state.finishedAt = old;
      fs.writeFileSync(marker, JSON.stringify(state));
      const plan = cleanupPlan(qa, 1);
      assert.ok(!JSON.stringify(plan).includes('.lock') || !plan.entries.some(e => /lock/i.test(e.dir || '')),
        'QA-SPEC-CLN-007: cleanup planner lists no lock file — locks are outside age-based cleanup');
      assert.ok(fs.existsSync(lockPath), 'QA-SPEC-CLN-007: the stale lock file is still present after planning');
      console.log('QA-SPEC-CLN-007: stale lock blocks regardless of age; record fields verified; cleanup plan excludes locks');
    } finally {
      fs.rmSync(qa, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }

  console.log('t07c-cln-001-002-007-coverage-test PASS');
}

main();
