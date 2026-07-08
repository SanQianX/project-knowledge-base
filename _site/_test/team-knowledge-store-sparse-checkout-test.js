// Tests for sparse-checkout automation in github-team-store.js.
// Style mirrors team-knowledge-store-test.js (IIFE + assert()).
//
// Three scenarios:
//   1. New sparse clone — checkoutStore({ subdir, partialClone }) clones with
//      --filter=blob:none --sparse --no-checkout, applies cone, and materializes
//      only the requested subdirectory.
//   2. Re-clone / switch — calling checkoutStore twice on the same local path
//      re-applies sparse-checkout cone (idempotent).
//   3. Git version fallback — _setGitVersionForTests forces a low version; the
//      partial-clone branch must fall back to a full clone and return warning.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const githubTeamStore = require('../lib/github-team-store');
const gitRunner = require('../lib/git-runner');

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function git(cwd, args) {
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString('utf-8').trim();
}

function initBareRemote(cwd) {
  fs.mkdirSync(cwd, { recursive: true });
  git(cwd, ['init', '--bare']);
}

function seedRemoteWith(cwd, files) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), `kb-sparse-seed-${process.pid}-`));
  git(work, ['init']);
  git(work, ['config', 'user.name', 'Test User']);
  git(work, ['config', 'user.email', 'test@example.com']);
  for (const [relPath, content] of Object.entries(files)) {
    const abs = path.join(work, relPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  git(work, ['add', '-A']);
  git(work, ['commit', '-m', 'seed']);
  git(work, ['branch', '-M', 'main']);
  const head = git(work, ['rev-parse', 'HEAD']);
  git(cwd, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  const pushTarget = `file://${path.resolve(cwd)}`;
  git(work, ['remote', 'add', 'origin', pushTarget]);
  git(work, ['push', 'origin', 'main']);
  return { work, head };
}

async function run() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), `kb-team-sparse-${process.pid}-`));
  const TEAM_REMOTE_SPARSE = path.join(tmpRoot, 'remote-sparse.git');
  const LOCAL_CLONE = path.join(tmpRoot, 'local-clone');
  const remoteUrl = `file://${TEAM_REMOTE_SPARSE.replace(/\\/g, '/')}`;

  let scenariosPassed = 0;
  let scenariosTotal = 0;

  // ------------------------------------------------------------------
  // Scenario 1: New sparse clone
  // ------------------------------------------------------------------
  {
    scenariosTotal++;
    fs.rmSync(TEAM_REMOTE_SPARSE, { recursive: true, force: true });
    fs.rmSync(LOCAL_CLONE, { recursive: true, force: true });
    initBareRemote(TEAM_REMOTE_SPARSE);
    seedRemoteWith(TEAM_REMOTE_SPARSE, {
      'acc/README.md': '# acc\n',
      'other/README.md': '# other\n',
      'docs/notes.md': 'docs\n',
    });

    const result = await githubTeamStore.checkoutStore({
      cloneUrl: remoteUrl,
      branch: 'main',
      localPath: LOCAL_CLONE,
      subdir: 'acc',
      partialClone: true,
    });

    assert(result.ok, `[scenario 1] checkoutStore should succeed: ${result.error || ''}`);
    assert(result.action === 'cloned-partial', `[scenario 1] expected action='cloned-partial' but got '${result.action}'`);
    assert(result.sparseCheckedOut === true, '[scenario 1] sparseCheckedOut should be true');
    assert(fs.existsSync(path.join(LOCAL_CLONE, 'acc', 'README.md')), '[scenario 1] acc/README.md should exist');
    assert(!fs.existsSync(path.join(LOCAL_CLONE, 'other', 'README.md')), '[scenario 1] other/README.md should NOT exist (cone excluded)');
    assert(!fs.existsSync(path.join(LOCAL_CLONE, 'docs', 'notes.md')), '[scenario 1] docs/notes.md should NOT exist (cone excluded)');
    const sparseFile = path.join(LOCAL_CLONE, '.git', 'info', 'sparse-checkout');
    assert(fs.existsSync(sparseFile), '[scenario 1] .git/info/sparse-checkout should be present');
    scenariosPassed++;
    console.log('[scenario 1: NEW sparse clone] OK');
  }

  // ------------------------------------------------------------------
  // Scenario 2: Re-clone / add cone
  // ------------------------------------------------------------------
  {
    scenariosTotal++;
    fs.rmSync(TEAM_REMOTE_SPARSE, { recursive: true, force: true });
    fs.rmSync(LOCAL_CLONE, { recursive: true, force: true });
    initBareRemote(TEAM_REMOTE_SPARSE);
    seedRemoteWith(TEAM_REMOTE_SPARSE, {
      'acc/README.md': '# acc\n',
      'other/README.md': '# other\n',
    });
    // First clone with subdir='acc'
    const first = await githubTeamStore.checkoutStore({
      cloneUrl: remoteUrl,
      branch: 'main',
      localPath: LOCAL_CLONE,
      subdir: 'acc',
      partialClone: true,
    });
    assert(first.ok && first.action === 'cloned-partial', `[scenario 2] first clone should be partial`);
    assert(fs.existsSync(path.join(LOCAL_CLONE, 'acc', 'README.md')), '[scenario 2] acc/README.md should exist after first clone');

    // Add a new subdir to remote
    const work = fs.mkdtempSync(path.join(os.tmpdir(), `kb-sparse-switch-${process.pid}-`));
    fs.rmSync(work, { recursive: true, force: true });
    fs.mkdirSync(work, { recursive: true });
    git(work, ['clone', `file://${TEAM_REMOTE_SPARSE}`, '.']);
    git(work, ['config', 'user.name', 'Test User']);
    git(work, ['config', 'user.email', 'test@example.com']);
    fs.mkdirSync(path.join(work, 'acc2'), { recursive: true });
    fs.writeFileSync(path.join(work, 'acc2', 'README.md'), '# acc2\n');
    git(work, ['add', '-A']);
    git(work, ['commit', '-m', 'add acc2']);
    git(work, ['push']);

    // Re-sync with subdir='acc2' should expand the cone, not remove acc.
    const second = await githubTeamStore.checkoutStore({
      cloneUrl: remoteUrl,
      branch: 'main',
      localPath: LOCAL_CLONE,
      subdir: 'acc2',
      partialClone: true,
    });
    assert(second.ok, `[scenario 2] second checkout should succeed: ${second.error || ''}`);
    assert(second.action === 'pulled-partial', `[scenario 2] expected action='pulled-partial' but got '${second.action}'`);
    assert(fs.existsSync(path.join(LOCAL_CLONE, 'acc2', 'README.md')), '[scenario 2] acc2/README.md should exist after adding cone');
    assert(fs.existsSync(path.join(LOCAL_CLONE, 'acc', 'README.md')), '[scenario 2] acc/README.md should still exist after adding acc2');
    scenariosPassed++;
    console.log('[scenario 2: cone expand] OK');
  }

  // ------------------------------------------------------------------
  // Scenario 3: Git version fallback
  // ------------------------------------------------------------------
  {
    scenariosTotal++;
    fs.rmSync(TEAM_REMOTE_SPARSE, { recursive: true, force: true });
    fs.rmSync(LOCAL_CLONE, { recursive: true, force: true });
    initBareRemote(TEAM_REMOTE_SPARSE);
    seedRemoteWith(TEAM_REMOTE_SPARSE, {
      'acc/README.md': '# acc\n',
      'other/README.md': '# other\n',
    });

    // Force the cached version to be < 2.25
    gitRunner._setGitVersionForTests({ ok: true, major: 2, minor: 24, raw: 'git version 2.24.0' });
    try {
      const result = await githubTeamStore.checkoutStore({
        cloneUrl: remoteUrl,
        branch: 'main',
        localPath: LOCAL_CLONE,
        subdir: 'acc',
        partialClone: true,
      });
      assert(result.ok, `[scenario 3] checkoutStore should fall back to full clone: ${result.error || ''}`);
      assert(result.action === 'cloned-fallback', `[scenario 3] expected action='cloned-fallback' but got '${result.action}'`);
      assert(typeof result.warning === 'string' && /2\.25/.test(result.warning), `[scenario 3] warning should mention 2.25: ${result.warning || ''}`);
      // Full clone means both subdirs ARE present.
      assert(fs.existsSync(path.join(LOCAL_CLONE, 'acc', 'README.md')), '[scenario 3] acc/README.md should exist (full clone)');
      assert(fs.existsSync(path.join(LOCAL_CLONE, 'other', 'README.md')), '[scenario 3] other/README.md should exist (full clone)');
      scenariosPassed++;
      console.log('[scenario 3: Git < 2.25 fallback] OK');
    } finally {
      gitRunner._setGitVersionForTests(null);
    }
  }

  console.log(`\nsummary: ${scenariosPassed}/${scenariosTotal} scenarios passed`);
  if (scenariosPassed !== scenariosTotal) {
    process.exitCode = 1;
  }
}

run().catch(err => {
  console.error('test failed:', err.message);
  console.error(err.stack);
  process.exitCode = 1;
});
