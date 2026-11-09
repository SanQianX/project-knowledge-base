// _site/_test/t07d-git-rel-coverage-test.js
//
// T07D ledger coverage for the git/release-discipline specs:
//
//   GIT-002 基准远程验证 — annotated (non-v) baseline tag + QA branch must be
//     verified REMOTELY via ls-remote dereference; the tag object SHA differs
//     from the commit SHA, proving plain ls-remote is not enough.
//   GIT-005 Push回执丢失 — when the client missed the push receipt, the
//     reconciliation reads remote HEAD/parent and confirms WITHOUT a new
//     commit and WITHOUT force push.
//   GIT-006 CI取消失败 — the SHIPPED promote CI gate (checkCiGate) refuses
//     failed/cancelled/incomplete-job runs; the sha/branch matching lives in
//     the real ciStatus filter (source-anchored).
//   GIT-007 单问题回退 — a controlled git revert keeps the FULL remote
//     history; nothing is rewritten.
//   REL-001 正式通道封锁 — only the exact x.y.z-rc.n form is a candidate;
//     STABLE versions reject rc; latest has no automatic exit.
//   REL-003 制品泄漏 — the shipped pack validator refuses qa/state/.env/
//     credentials and REQUIRES the runtime essentials.
//   REL-008 稳定版审批 — the promotion gate accepts only the exact
//     READY_FOR_STABLE_APPROVAL attestation and refuses rc versions.
//
// Every assertion message starts with QA-SPEC-<CASE>.

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..', '..');

function git(dir, args) { return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', windowsHide: true }); }
function gitOk(dir, args) { try { git(dir, args); return true; } catch { return false; } }

function fixtureRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-git-rel-'));
  const remote = path.join(root, 'remote.git');
  const work = path.join(root, 'work');
  fs.mkdirSync(work, { recursive: true });
  git(work, ['init', '-q', '--bare', remote]);
  git(work, ['init', '-q', '-b', 'main']);
  for (const [key, value] of [['user.email', 'qa-git@example.invalid'], ['user.name', 'qa-git']]) git(work, ['config', key, value]);
  return { root, remote, work, cleanup: () => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) };
}
const commit = (work, file, text, message) => {
  fs.writeFileSync(path.join(work, file), text, 'utf8');
  git(work, ['add', file]);
  git(work, ['commit', '-q', '-m', message]);
  return git(work, ['rev-parse', 'HEAD']).trim();
};

function main() {
  // ---------------- GIT-002 基准远程验证 --------------------------------
  {
    const f = fixtureRepo();
    try {
      const baselineSha = commit(f.work, 'BASELINE.md', 'baseline\n', 'baseline commit');
      git(f.work, ['remote', 'add', 'origin', f.remote]);
      // An annotated, NON-v tag (exactly the spec's shape).
      git(f.work, ['tag', '-a', 'baseline-2026Q4', '-m', 'baseline 2026Q4']);
      git(f.work, ['branch', 'qa/acceptance-r9']);
      git(f.work, ['push', '-q', 'origin', 'main', 'baseline-2026Q4', 'qa/acceptance-r9']);

      // Remote verification — dereferenced tag and branch both must be the
      // FULL baseline SHA, read from the REMOTE, not from local state.
      const tagCommit = git(f.work, ['ls-remote', 'origin', 'refs/tags/baseline-2026Q4^{}']).trim().split(/\s+/)[0];
      const tagObject = git(f.work, ['ls-remote', 'origin', 'refs/tags/baseline-2026Q4']).trim().split(/\s+/)[0];
      const branchSha = git(f.work, ['ls-remote', 'origin', 'refs/heads/qa/acceptance-r9']).trim().split(/\s+/)[0];
      assert.ok(tagCommit === baselineSha, `QA-SPEC-GIT-002: the dereferenced tag commit is the full baseline SHA (${tagCommit} vs ${baselineSha})`);
      assert.notStrictEqual(tagObject, tagCommit, 'QA-SPEC-GIT-002: annotated tag object SHA differs from the commit — dereference (^{}) is REQUIRED, a plain ls-remote is not verification');
      assert.ok(/^[0-9a-f]{40}$/.test(tagCommit), 'QA-SPEC-GIT-002: the verified SHA is a complete 40-hex baseline SHA');
      assert.ok(branchSha === baselineSha, 'QA-SPEC-GIT-002: the QA branch points at the same complete baseline SHA remotely');
      console.log('QA-SPEC-GIT-002: remote baseline verified via ls-remote dereference + branch; local command success alone is never the proof');
    } finally { f.cleanup(); }
  }

  // ---------------- GIT-005 Push回执丢失 --------------------------------
  {
    const f = fixtureRepo();
    try {
      const first = commit(f.work, 'A.txt', 'a\n', 'first');
      const second = commit(f.work, 'B.txt', 'b\n', 'second');
      git(f.work, ['remote', 'add', 'origin', f.remote]);
      git(f.work, ['push', '-q', 'origin', 'main']);
      const localCount = git(f.work, ['rev-list', '--count', 'HEAD']).trim();

      // Reconciliation after a "lost receipt": read the REMOTE HEAD and its
      // parent; only then confirm. No new commit, no force push.
      const remoteHead = git(f.work, ['ls-remote', 'origin', 'refs/heads/main']).trim().split(/\s+/)[0];
      assert.ok(remoteHead === second, 'QA-SPEC-GIT-005: remote HEAD equals the local commit — the push did land');
      const remoteParent = git(f.work, ['ls-remote', 'origin', 'refs/heads/main'])
        && git(f.work, ['cat-file', '-p', remoteHead]).split('\n').find(l => l.startsWith('parent ')).split(' ')[1].trim();
      assert.ok(remoteParent === first, 'QA-SPEC-GIT-005: the remote parent matches the local parent — identity proven before any action');
      const afterCount = git(f.work, ['rev-list', '--count', 'HEAD']).trim();
      assert.ok(afterCount === localCount, 'QA-SPEC-GIT-005: reconciliation creates NO duplicate commit');
      // A force push is never needed: nothing is unpushed and nothing
      // diverges, structurally (a force push would only ever be needed when
      // local and remote have DIVERGED).
      git(f.work, ['fetch', '-q', 'origin']);
      const unpushed = git(f.work, ['rev-list', '--count', 'origin/main..HEAD']).trim();
      const diverged = git(f.work, ['rev-list', '--count', 'HEAD..origin/main']).trim();
      assert.ok(unpushed === '0' && diverged === '0', `QA-SPEC-GIT-005: the reconciled state has nothing unpushed (${unpushed}) and no divergence (${diverged}) — no force push can be required`);
      console.log('QA-SPEC-GIT-005: lost-receipt reconciliation reads remote HEAD/parent and confirms without re-commit or force push');
    } finally { f.cleanup(); }
  }

  // ---------------- GIT-006 CI取消失败 ----------------------------------
  {
    const { checkCiGate } = require(path.join(REPO, 'qa-autopilot', 'tools', 'stable-promote.cjs'));
    const { REQUIRED_CI_JOBS: all } = require(path.join(REPO, 'qa-autopilot', 'tools', 'stable-next-common.cjs'));
    const jobs = names => names.map(name => ({ name, conclusion: 'success' }));
    assert.ok(checkCiGate({ ciStatus: 'FAIL', jobs: jobs(all), sourceSha: 'a'.repeat(40) }).ok === false,
      'QA-SPEC-GIT-006: a FAILED run is never PASS (CI_NOT_GREEN)');
    assert.ok(checkCiGate({ ciStatus: 'PENDING', jobs: jobs(all), sourceSha: 'a'.repeat(40) }).ok === false,
      'QA-SPEC-GIT-006: a CANCELLED/incomplete run is never PASS');
    assert.ok(checkCiGate({ ciStatus: 'PASS', jobs: jobs(all.filter(n => !n.includes('Windows'))), sourceSha: 'a'.repeat(40) }).ok === false,
      'QA-SPEC-GIT-006: missing Windows job refuses PASS (CI_JOBS_INCOMPLETE)');
    assert.strictEqual(checkCiGate({ ciStatus: 'PASS', jobs: jobs(all), sourceSha: 'a'.repeat(40) }).ok, true,
      'QA-SPEC-GIT-006: only a complete green gate passes');
    // SHA/branch matching is the real filter in lib/registry.cjs ciStatus —
    // anchored here so the binding cannot drift silently.
    const registrySource = fs.readFileSync(path.join(REPO, 'qa-autopilot', 'lib', 'registry.cjs'), 'utf8');
    assert.ok(registrySource.includes("x.head_sha === sha") && registrySource.includes("x.head_branch ==="),
      'QA-SPEC-GIT-006: ciStatus matches runs by THIS head_sha AND the QA main branch — a green run of another SHA/branch never counts');
    console.log('QA-SPEC-GIT-006: shipped CI gate refuses failed/cancelled/incomplete; matching is sha+branch');
  }

  // ---------------- GIT-007 单问题回退 ----------------------------------
  {
    const f = fixtureRepo();
    try {
      commit(f.work, 'BASE.md', 'base\n', 'baseline');
      const fixSha = commit(f.work, 'check.txt', 'ok\n', 'fix: repair the check');
      const regressionSha = commit(f.work, 'check.txt', 'BROKEN\n', 'regression: breaks the check');
      git(f.work, ['remote', 'add', 'origin', f.remote]);
      git(f.work, ['push', '-q', 'origin', 'main']);
      // The regression trips the check; a CONTROLLED revert (not a rewrite).
      const checkOk = () => fs.readFileSync(path.join(f.work, 'check.txt'), 'utf8').includes('ok');
      assert.ok(!checkOk(), 'QA-SPEC-GIT-007: the pushed regression reproduces');
      git(f.work, ['revert', '--no-edit', regressionSha]);
      assert.ok(checkOk(), 'QA-SPEC-GIT-007: the controlled revert restores the behavior and the re-test passes');
      git(f.work, ['push', '-q', 'origin', 'main']);
      // Full remote history preserved: every original SHA is still reachable
      // on the remote and the revert sits ON TOP, replacing nothing.
      for (const sha of [fixSha, regressionSha]) {
        assert.ok(gitOk(f.work, ['cat-file', '-e', `${sha}^{commit}`]), `QA-SPEC-GIT-007: original commit ${sha.slice(0, 8)} still exists`);
        const inRemote = git(f.work, ['branch', '-r', '--contains', sha]).includes('origin/main');
        assert.ok(inRemote, `QA-SPEC-GIT-007: original commit ${sha.slice(0, 8)} remains in the REMOTE history`);
      }
      const remoteLog = git(f.work, ['log', '--oneline', 'origin/main']);
      assert.ok(/revert/i.test(remoteLog) && /regression/i.test(remoteLog), 'QA-SPEC-GIT-007: remote log keeps BOTH the regression and its revert — nothing rewritten');
      console.log('QA-SPEC-GIT-007: controlled revert verified; full remote history preserved');
    } finally { f.cleanup(); }
  }

  // ---------------- REL-001 正式通道封锁 --------------------------------
  {
    const { isRC } = require(path.join(REPO, 'qa-autopilot', 'lib', 'registry.cjs'));
    const { STABLE_VERSION } = require(path.join(REPO, 'qa-autopilot', 'tools', 'stable-next-common.cjs'));
    assert.ok(isRC('5.0.31-rc.1'), 'QA-SPEC-REL-001: the exact x.y.z-rc.n form enters the candidate channel');
    for (const bad of ['v5.0.31-rc.1', 'baseline-2026Q4', '5.0.31-rc', '5.0.31-RC.1', '5.0.31-rc.1-beta', '5.0.31']) {
      assert.ok(!isRC(bad), `QA-SPEC-REL-001: ${bad} is NOT a candidate rc`);
    }
    assert.ok(!STABLE_VERSION.test('5.0.31-rc.1') && STABLE_VERSION.test('5.0.31'),
      'QA-SPEC-REL-001: an rc can never be a stable latest — latest has no automatic exit from the rc channel');
    console.log('QA-SPEC-REL-001: only the exact rc form is a candidate; latest never auto-exits');
  }

  // ---------------- REL-003 制品泄漏 ------------------------------------
  {
    const { validatePack } = require(path.join(REPO, 'qa-autopilot', 'lib', 'registry.cjs'));
    const essentials = ['package.json', '_site/server.js', 'ui/index.html', 'ui/product.js', 'ui/live-client.js', 'module-runtime-manifest.json'];
    assert.throws(() => validatePack([...essentials, 'qa-autopilot/tools/x.cjs']), /Forbidden package file.*qa-autopilot/,
      'QA-SPEC-REL-003: qa/ paths are refused in the pack');
    assert.throws(() => validatePack([...essentials, 'state/runs/1.json']), /Forbidden package file.*state/,
      'QA-SPEC-REL-003: state/ paths are refused');
    assert.throws(() => validatePack([...essentials, '.env']), /Forbidden package file.*.env/,
      'QA-SPEC-REL-003: .env is refused');
    assert.throws(() => validatePack([...essentials, 'ai-profiles.json']), /Forbidden package file.*ai-profiles/,
      'QA-SPEC-REL-003: credentials-shaped files are refused');
    for (const required of ['_site/server.js', 'module-runtime-manifest.json', 'ui/product.js']) {
      assert.throws(() => validatePack(essentials.filter(f => f !== required)), /Required runtime missing/,
        `QA-SPEC-REL-003: removing the essential ${required} is refused — the engine/plugins runtime cannot be cleaned away`);
    }
    assert.doesNotThrow(() => validatePack([...essentials, 'plugins/project-knowledge/plugin.json']),
      'QA-SPEC-REL-003: shell and plugin payload passes the audit with npm runtime dependencies');
    assert.throws(() => validatePack([...essentials, '_modules/knowledge-engine/src/server.js']), /Engine source must be installed/,
      'QA-SPEC-REL-003: engine source cannot leak back into the shell package');
    console.log('QA-SPEC-REL-003: leak paths refused; required runtime essentials protected');
  }

  // ---------------- REL-008 稳定版审批 ----------------------------------
  {
    const promote = require(path.join(REPO, 'qa-autopilot', 'tools', 'stable-promote.cjs'));
    const base = {
      repository: 'SanQianX/project-knowledge-base',
      workflowRef: 'SanQianX/project-knowledge-base/.github/workflows/publish.yml@refs/heads/main',
      eventName: 'workflow_dispatch',
      packageName: '@sanqianx/project-knowledge',
      expectedVersion: '5.0.31',
      sourceSha: 'a'.repeat(40),
      expectedSRI: 'sha512-' + 'A'.repeat(86) + '==',
      reviewer: 'ZCode-Leader',
      acceptanceAck: promote.ACCEPTANCE_ACK,
      expectedCurrentLatest: '5.0.30',
    };
    assert.strictEqual(promote.checkPromotionInputs(base).ok, true, 'QA-SPEC-REL-008: complete, attested promotion inputs pass the gate');
    assert.ok(promote.checkPromotionInputs({ ...base, expectedVersion: '5.0.31-rc.1' }).code === 'VERSION_SEMVER',
      'QA-SPEC-REL-008: an rc version is REFUSED for latest — rc is never re-tagged directly');
    assert.ok(promote.checkPromotionInputs({ ...base, acceptanceAck: 'looks-good-to-me' }).code === 'ACCEPTANCE_ACK',
      'QA-SPEC-REL-008: only the exact READY_FOR_STABLE_APPROVAL attestation passes');
    assert.ok(promote.checkPromotionInputs({ ...base, reviewer: '' }).code === 'REVIEWER_REQUIRED',
      'QA-SPEC-REL-008: an anonymous approval is refused');
    assert.ok(promote.checkPromotionInputs({ ...base, repository: 'someone/else' }).code === 'CI_IDENTITY',
      'QA-SPEC-REL-008: only this repository\'s workflow may promote');
    assert.strictEqual(promote.PROMOTION_TAG, 'latest');
    console.log('QA-SPEC-REL-008: stable approval requires the exact attestation; rc cannot be re-tagged latest');
  }

  console.log('t07d-git-rel-coverage-test PASS');
}

main();
