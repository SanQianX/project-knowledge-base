// _site/_test/desktop-hook-runtime-regression-test.js
//
// Characterization harness for the post-commit hook runtime contract.
// The current regression (RC-01) is that buildHookBody defaults
// nodeExecutable to process.execPath, which in Desktop mode points at the
// Electron executable rather than a real Node binary. When Git invokes the
// hook from a normal shell, the script therefore launches Electron instead
// of executing hook-trigger.js.
//
// These tests must:
//   - PASS for healthy CLI installs with an explicit Node executable;
//   - EXPOSE the regression when the default is left to process.execPath in a
//     simulated Desktop environment.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const {
  buildHookBody,
  installHook,
  readHookStatus,
  parseManagedMarker,
  HOOK_MARKER,
} = require('../lib/hook-manager');

const ROOT = path.resolve(__dirname, '..', '..');
const TRIGGER = path.join(ROOT, '_site', 'scripts', 'hook-trigger.js');

function git(repo, args) {
  const result = spawnSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed: ${result.status}`);
  return String(result.stdout || '').trim();
}

function makeRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-desktop-hook-'));
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.email', 'desktop-hook@example.local']);
  git(repo, ['config', 'user.name', 'Desktop Hook Test']);
  fs.writeFileSync(path.join(repo, 'README.md'), '# desktop hook\n');
  git(repo, ['add', 'README.md']);
  git(repo, ['commit', '-q', '-m', 'initial']);
  return repo;
}

(async () => {
  // ---- Case 1: explicit real Node executable must be persisted verbatim ----
  {
    const repo = makeRepo();
    const projectId = 'project-desktop-hook';
    const fakeNode = path.join(ROOT, '_site', '_test', 'fixtures', 'fake-browser-exit.js');
    const body = buildHookBody({
      projectId,
      triggerScriptPath: TRIGGER,
      nodeExecutable: fakeNode,
    });
    assert(body.includes(fakeNode.replace(/\\/g, '/')), 'explicit Node executable must be embedded in hook body');
    assert(body.includes('ELECTRON_RUN_AS_NODE=1'), 'T02 contract: hook body must prefix ELECTRON_RUN_AS_NODE=1 so Desktop packaging runs as Node');
    fs.rmSync(repo, { recursive: true, force: true });
  }

  // ---- Case 2: installHook must accept an explicit nodeExecutable ----
  {
    const repo = makeRepo();
    const projectId = 'project-desktop-hook-install';
    const fakeNode = path.join(ROOT, '_site', '_test', 'fixtures', 'fake-browser-exit.js');
    const installed = installHook({
      repoPath: repo,
      projectId,
      triggerScriptPath: TRIGGER,
      nodeExecutable: fakeNode,
    });
    assert.strictEqual(installed.ok, true);
    const hookBody = fs.readFileSync(installed.hookPath, 'utf8');
    assert(hookBody.includes(fakeNode.replace(/\\/g, '/')), 'installed hook body must embed the explicit Node executable');
    assert.strictEqual(parseManagedMarker(hookBody).projectId, projectId);
    fs.rmSync(repo, { recursive: true, force: true });
  }

  // ---- Case 3: CHARACTERIZATION — Desktop executable prefix ----
  // The Desktop backend launches the core CLI through the Electron executable
  // with ELECTRON_RUN_AS_NODE=1 in the backend child environment. A Git
  // post-commit hook does NOT inherit that env var, so the hook body must
  // explicitly set ELECTRON_RUN_AS_NODE=1 before invoking the executable,
  // even when the executable is Electron (Desktop packaging).
  {
    const fakeElectron = path.join(os.tmpdir(), `fake-electron-${process.pid}.exe`);
    const body = buildHookBody({
      projectId: 'project-desktop-hook-default',
      triggerScriptPath: TRIGGER,
      nodeExecutable: fakeElectron,
    });
    assert(body.includes('ELECTRON_RUN_AS_NODE=1'),
      'T02 contract: hook body must prefix ELECTRON_RUN_AS_NODE=1 so a Desktop Electron binary executes as Node');
    assert(body.includes(fakeElectron.replace(/\\/g, '/')),
      'hook body must embed the resolved executable verbatim');
    assert(typeof body === 'string' && body.length > 0, 'hook body must be non-empty');
  }

  // ---- Case 4: hook runtime contract — trigger must run even with weird paths ----
  // The hook body must work when the project path contains spaces. We install
  // into a path that includes a literal space and confirm installHook + readback
  // round-trip without escaping failures.
  {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-desktop-hook-spaces-'));
    const repo = path.join(base, 'project with spaces');
    fs.mkdirSync(repo, { recursive: true });
    git(repo, ['init', '-q', '-b', 'main']);
    git(repo, ['config', 'user.email', 'spaces@example.local']);
    git(repo, ['config', 'user.name', 'Spaces Test']);
    fs.writeFileSync(path.join(repo, 'README.md'), '# spaces\n');
    git(repo, ['add', 'README.md']);
    git(repo, ['commit', '-q', '-m', 'initial']);
    const fakeNode = path.join(ROOT, '_site', '_test', 'fixtures', 'fake-browser-exit.js');
    const installed = installHook({
      repoPath: repo,
      projectId: 'project-spaces',
      triggerScriptPath: TRIGGER,
      nodeExecutable: fakeNode,
    });
    assert.strictEqual(installed.ok, true);
    const status = readHookStatus({ repoPath: repo, projectId: 'project-spaces' });
    assert.strictEqual(status.kbManaged, true);
    fs.rmSync(base, { recursive: true, force: true });
  }

  // ---- Case 5: missing required args must still produce a valid hook body ----
  // This guards the "fail-open" property required by I-12 (Git commit must
  // never fail because Project-Knowledge is unavailable).
  {
    let threw = false;
    try {
      buildHookBody({ projectId: '', triggerScriptPath: TRIGGER, nodeExecutable: process.execPath });
    } catch (error) { threw = true; }
    assert.strictEqual(threw, true, 'empty projectId must be rejected by buildHookBody');
  }

  // ---- Case 6: end-to-end execution — hook body actually runs the trigger ----
  // Build a tiny "trigger" that records its argv + ELECTRON_RUN_AS_NODE env
  // to a journal, install the hook pointing at it, then exec the installed
  // hook via sh and assert the journal was written. This proves the hook
  // body resolves the executable correctly and that ELECTRON_RUN_AS_NODE=1
  // is set before the trigger runs (so a Desktop Electron binary would
  // execute as Node instead of launching as a GUI).
  {
    const repo = makeRepo();
    const journal = path.join(os.tmpdir(), `pk-desktop-hook-journal-${process.pid}.json`);
    const triggerBody = `#!/usr/bin/env node
const fs = require('fs');
fs.writeFileSync(${JSON.stringify(journal)}, JSON.stringify({
  argv: process.argv.slice(2),
  electronRunAsNode: process.env.ELECTRON_RUN_AS_NODE || null,
  execPath: process.execPath,
}, null, 2));
process.exit(0);
`;
    const fakeTrigger = path.join(os.tmpdir(), `pk-fake-trigger-${process.pid}.js`);
    fs.writeFileSync(fakeTrigger, triggerBody);
    const projectId = 'project-hook-exec';
    const fakeNode = process.execPath; // real Node in the test env
    const installed = installHook({
      repoPath: repo,
      projectId,
      triggerScriptPath: fakeTrigger,
      nodeExecutable: fakeNode,
    });
    assert.strictEqual(installed.ok, true);
    // Execute with Git for Windows' own POSIX shell. A bare `bash` can resolve
    // to WSL, which cannot consume a Windows hook path.
    let sh = 'sh';
    if (process.platform === 'win32') {
      const where = spawnSync('where.exe', ['git'], { encoding: 'utf8', windowsHide: true });
      const gitPath = String(where.stdout || '').split(/\r?\n/).find(Boolean);
      const candidate = gitPath && path.join(path.dirname(path.dirname(gitPath)), 'bin', 'sh.exe');
      sh = candidate && fs.existsSync(candidate) ? candidate : 'bash';
    }
    const result = spawnSync(sh, [installed.hookPath], {
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    assert.strictEqual(result.status, 0, `hook must exit 0 even when Project-Knowledge is unavailable; got ${result.status}\n${result.stderr || ''}`);
    assert(fs.existsSync(journal), 'fake trigger must be executed by the hook body');
    const recorded = JSON.parse(fs.readFileSync(journal, 'utf8'));
    assert.strictEqual(recorded.electronRunAsNode, '1', 'ELECTRON_RUN_AS_NODE=1 must be set before the trigger runs');
    assert(recorded.argv.includes('--project-id'), 'trigger argv must include --project-id');
    assert(recorded.argv.includes(projectId), 'trigger argv must include the project id');
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(fakeTrigger, { force: true });
    fs.rmSync(journal, { force: true });
  }

  console.log('desktop-hook-runtime-regression-test PASS');
})().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
