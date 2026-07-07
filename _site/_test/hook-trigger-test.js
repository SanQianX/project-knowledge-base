// _site/_test/hook-trigger-test.js
//
// Post-commit hook regression test.
//
// Verifies:
// 1. hook-manager.installHook writes a KB-managed post-commit script.
// 2. installHook refuses to overwrite a non-KB-managed hook without overwrite.
// 3. uninstallHook refuses to delete a non-KB-managed hook.
// 4. uninstallHook removes a KB-managed hook.
// 5. hook-trigger.js exits 0 when the server is unreachable.
// 6. A real git commit fires the hook, calls /api/hooks/post-commit, and
//    records a project automation run.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, spawnSync } = require('child_process');
const { installHook, uninstallHook, readHookStatus, HOOK_MARKER } = require('../lib/hook-manager');
const {
  CLAUDE_MD_FILENAME,
  SECTION_MARKER_START,
  SECTION_MARKER_END,
  readClaudeMdStatus,
} = require('../lib/claude-md-manager');
const { spawnServer } = require('./helpers/spawn-server');

const ROOT = path.resolve(__dirname, '..', '..');
const SERVER = path.join(ROOT, '_site', 'server.js');
const HOOK_TRIGGER = path.join(ROOT, '_site', 'scripts', 'hook-trigger.js');
const SITE_ROOT = path.join(ROOT, '_site');
const KB_ROOT = ROOT;
let DATA_DIR; // assigned when spawnServer returns
let PROJECTS_JSON; // assigned after DATA_DIR
const PORT = process.env.KB_HOOK_TEST_PORT || '7802';
const BASE_URL = `http://127.0.0.1:${PORT}`;

const SLUG = 'hook-test-proj';
const FIXTURE_REPO = path.join(os.tmpdir(), `kb-hook-test-${process.pid}`);
const FIXTURE_KB_PATH = path.join(os.tmpdir(), `kb-hook-test-kb-${process.pid}`);
const FIXTURE_PROJECTS_PATH = path.join(os.tmpdir(), `kb-hook-projects-${process.pid}.json`);
const BASELINE_AI_PROFILES = {
  schema: 'ai-profiles/v1',
  profiles: [{
    id: 'minimax-m3',
    name: 'MiniMax M3',
    enabled: true,
    implementation: 'claude-code-agent',
    baseUrl: 'https://example.test/anthropic',
    apiKey: 'test-key',
    mainModel: 'MiniMax-M3',
  }],
};

function assert(cond, msg) {
  if (!cond) throw new Error('ASSERT: ' + msg);
}

function rmrf(p) {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch {}
}

function execGit(cwd, args) {
  return spawnSync('git', args, { cwd, encoding: 'utf-8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
}

function initRepo(p) {
  rmrf(p);
  fs.mkdirSync(p, { recursive: true });
  let r = execGit(p, ['init', '--initial-branch=main']);
  assert(r.status === 0, 'git init failed: ' + r.stderr);
  execGit(p, ['config', 'user.email', 'kb-test@example.com']);
  execGit(p, ['config', 'user.name', 'KB Test']);
  execGit(p, ['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(p, 'README.md'), '# hook test\n', 'utf-8');
  execGit(p, ['add', 'README.md']);
  r = execGit(p, ['commit', '-m', 'init']);
  assert(r.status === 0, 'initial commit failed: ' + r.stderr);
}

function makeCommit(p, msg) {
  fs.writeFileSync(path.join(p, 'changelog.md'), `+ ${msg}\n`, { flag: 'a' });
  execGit(p, ['add', 'changelog.md']);
  const r = execGit(p, ['commit', '-m', msg]);
  assert(r.status === 0, 'commit failed: ' + r.stderr + ' :: ' + r.stdout);
}

function enabledProfileId() {
  const p = (BASELINE_AI_PROFILES.profiles || []).find(item => item.enabled !== false);
  return p && p.id || 'minimax';
}

async function waitForServer() {
  const deadline = Date.now() + 15000;
  let last;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE_URL}/api/state`);
      if (r.status < 500) return;
      last = new Error('HTTP ' + r.status);
    } catch (e) {
      last = e;
    }
    await new Promise(r => setTimeout(r, 250));
  }
  throw last || new Error('server did not start');
}

async function json(method, url, body) {
  const r = await fetch(`${BASE_URL}${url}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let data = {};
  if (text) {
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
  }
  return { res: r, status: r.status, data };
}

async function waitForAutomationRun(slug, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await json('GET', `/api/projects/${slug}/automation/runs`);
    if (r.data && Array.isArray(r.data.runs)) {
      const hit = r.data.runs.find(j => j.projectSlug === slug && j.source === 'git-hook');
      if (hit) return hit;
    }
    await new Promise(r => setTimeout(r, 500));
  }
  return null;
}

(async () => {
  initRepo(FIXTURE_REPO);

  execGit(FIXTURE_REPO, ['config', 'core.hooksPath', '.githooks']);
  let r = installHook({ repoPath: FIXTURE_REPO, siteRoot: SITE_ROOT, host: '127.0.0.1', port: Number(PORT), kbPath: FIXTURE_KB_PATH });
  assert(r.ok, 'installHook with core.hooksPath failed: ' + r.error);
  let legacyClaudeText = fs.readFileSync(path.join(FIXTURE_REPO, CLAUDE_MD_FILENAME), 'utf-8');
  assert(!legacyClaudeText.includes(FIXTURE_KB_PATH.replace(/\\/g, '/')),
    'installHook must not embed kbPath in CLAUDE.md even when legacy callers pass kbPath');
  assert(!legacyClaudeText.includes('lives at:'),
    'installHook must not write legacy direct-mode CLAUDE.md blocks');
  const customHookPath = path.join(FIXTURE_REPO, '.githooks', 'post-commit');
  assert(fs.existsSync(customHookPath), 'hook file not created under core.hooksPath');
  let customStatus = readHookStatus({ repoPath: FIXTURE_REPO });
  assert(customStatus.installed === true, 'readHookStatus should follow core.hooksPath');
  assert(path.resolve(customStatus.hookPath) === path.resolve(customHookPath), 'readHookStatus returned wrong hookPath for core.hooksPath');
  r = uninstallHook({ repoPath: FIXTURE_REPO });
  assert(r.ok && r.removed === true, 'uninstallHook should remove hook under core.hooksPath');
  assert(!fs.existsSync(customHookPath), 'hook under core.hooksPath still exists after uninstall');
  execGit(FIXTURE_REPO, ['config', '--unset', 'core.hooksPath']);
  rmrf(path.join(FIXTURE_REPO, '.githooks'));

  r = installHook({
    repoPath: FIXTURE_REPO,
    siteRoot: SITE_ROOT,
    host: '127.0.0.1',
    port: Number(PORT),
    projectSlug: SLUG,
  });
  assert(r.ok, 'installHook failed: ' + r.error);
  const hookPath = path.join(FIXTURE_REPO, '.git', 'hooks', 'post-commit');
  assert(fs.existsSync(hookPath), 'hook file not created at ' + hookPath);
  const hookText = fs.readFileSync(hookPath, 'utf-8');
  assert(hookText.includes(HOOK_MARKER), 'hook missing KB marker');
  assert(hookText.includes('hook-trigger.js'), 'hook does not call hook-trigger.js');
  assert(hookText.includes('--kb-root'), 'hook missing --kb-root flag');
  assert(hookText.includes(FIXTURE_REPO.replace(/\\/g, '/')), 'hook missing repo path');

  // installHook should also drop a KB-managed rule block into <repo>/CLAUDE.md.
  // v2.4.2+ default form: discovery chain + slug only, no absolute path
  // embedded — so cloning the repo to another machine never ships a
  // baked-in user-specific path.
  assert(r.claudeMd && r.claudeMd.ok, 'installHook should report claudeMd.ok=true: ' + JSON.stringify(r.claudeMd));
  const claudeMdPath = path.join(FIXTURE_REPO, CLAUDE_MD_FILENAME);
  assert(fs.existsSync(claudeMdPath), 'installHook should create CLAUDE.md in repo');
  const claudeMdText0 = fs.readFileSync(claudeMdPath, 'utf-8');
  assert(claudeMdText0.includes(SECTION_MARKER_START), 'CLAUDE.md missing start marker after install');
  assert(claudeMdText0.includes(SECTION_MARKER_END), 'CLAUDE.md missing end marker after install');
  assert(claudeMdText0.includes('Knowledge Base Reading Rule'), 'CLAUDE.md missing rule heading after install');
  const expectedKbPath = FIXTURE_KB_PATH.replace(/\\/g, '/');
  const expectedProjectsPath = FIXTURE_PROJECTS_PATH.replace(/\\/g, '/');
  // Default v2.4.2+ form embeds the discovery chain and the slug only.
  assert(claudeMdText0.includes('$PROJECT_KNOWLEDGE_REGISTRY'),
    'CLAUDE.md should declare $PROJECT_KNOWLEDGE_REGISTRY env-var discovery');
  assert(claudeMdText0.includes('~/.project-knowledge/projects.json'),
    'CLAUDE.md should declare tilde-fallback discovery');
  assert(claudeMdText0.includes(`projectSlug: ${SLUG}`),
    'CLAUDE.md should reference project slug');
  assert(claudeMdText0.includes('<resolved kbPath>/GOAL.md'),
    'CLAUDE.md should reference resolved GOAL.md path');
  // Hard guarantee: no absolute path embedded, no fixture paths leaking.
  assert(!claudeMdText0.includes(`projects.json: ${expectedProjectsPath}`),
    `CLAUDE.md must NOT embed projects.json path ${expectedProjectsPath}`);
  assert(!claudeMdText0.includes(expectedKbPath),
    `CLAUDE.md must NOT embed absolute kbPath ${expectedKbPath}`);
  assert(!claudeMdText0.includes(FIXTURE_PROJECTS_PATH),
    'CLAUDE.md must not embed the fixture projects.json path');
  let s0 = readClaudeMdStatus(FIXTURE_REPO);
  assert(s0.ok && s0.present && s0.managed, 'readClaudeMdStatus should report managed after install: ' + JSON.stringify(s0));
  assert(s0.kbPath === null, `readClaudeMdStatus should not report direct kbPath, got ${s0.kbPath}`);
  assert(s0.projectsPath === null,
    `readClaudeMdStatus should not report projectsPath in default form, got ${s0.projectsPath}`);
  assert(s0.projectSlug === SLUG, `readClaudeMdStatus should report projectSlug=${SLUG}, got ${s0.projectSlug}`);

  if (process.platform !== 'win32') {
    const st = fs.statSync(hookPath);
    assert((st.mode & 0o111) !== 0, 'hook is not executable on POSIX');
  }

  rmrf(hookPath);
  fs.writeFileSync(hookPath, '#!/bin/sh\necho "user hook, do not touch"\n', 'utf-8');
  r = installHook({ repoPath: FIXTURE_REPO, siteRoot: SITE_ROOT, host: '127.0.0.1', port: Number(PORT), kbPath: FIXTURE_KB_PATH });
  assert(!r.ok && r.status === 409, 'installHook should refuse non-KB hook without overwrite');
  assert(fs.readFileSync(hookPath, 'utf-8').includes('do not touch'), 'user hook was overwritten');

  r = installHook({ repoPath: FIXTURE_REPO, siteRoot: SITE_ROOT, host: '127.0.0.1', port: Number(PORT), overwrite: true, kbPath: FIXTURE_KB_PATH });
  assert(r.ok, 'overwrite installHook failed: ' + r.error);
  assert(fs.readFileSync(hookPath, 'utf-8').includes(HOOK_MARKER), 'overwrite did not write KB hook');

  rmrf(hookPath);
  fs.writeFileSync(hookPath, '#!/bin/sh\necho "user hook"\n', 'utf-8');
  r = uninstallHook({ repoPath: FIXTURE_REPO });
  assert(!r.ok && r.status === 409, 'uninstallHook should refuse non-KB hook');
  assert(fs.existsSync(hookPath), 'non-KB hook was deleted');

  installHook({ repoPath: FIXTURE_REPO, siteRoot: SITE_ROOT, host: '127.0.0.1', port: Number(PORT), overwrite: true, kbPath: FIXTURE_KB_PATH });
  assert(fs.existsSync(hookPath), 'KB hook not present before uninstall');
  assert(fs.readFileSync(hookPath, 'utf-8').includes(HOOK_MARKER), 'KB hook did not replace the non-KB hook');
  r = uninstallHook({ repoPath: FIXTURE_REPO });
  assert(r.ok && r.removed === true, 'uninstallHook failed: ' + r.error);
  assert(!fs.existsSync(hookPath), 'hook still exists after uninstall');

  // uninstallHook should also remove the KB-managed rule block from CLAUDE.md.
  // In this fixture CLAUDE.md was created by install and contains nothing else,
  // so the file itself should be deleted.
  assert(r.claudeMd && r.claudeMd.ok, 'uninstallHook should report claudeMd.ok=true: ' + JSON.stringify(r.claudeMd));
  assert(r.claudeMd.removed === true, 'uninstallHook should report claudeMd.removed=true: ' + JSON.stringify(r.claudeMd));
  assert(r.claudeMd.fileDeleted === true, 'uninstallHook should report claudeMd.fileDeleted=true when file becomes empty: ' + JSON.stringify(r.claudeMd));
  assert(!fs.existsSync(claudeMdPath), 'CLAUDE.md should be deleted when KB rule was the only content');
  let s0b = readClaudeMdStatus(FIXTURE_REPO);
  assert(s0b.ok && s0b.present === false, 'CLAUDE.md should be absent after uninstall: ' + JSON.stringify(s0b));

  let s = readHookStatus({ repoPath: FIXTURE_REPO });
  assert(s.installed === false, 'readHookStatus should report not installed');
  assert(s.claudeMd && s.claudeMd.present === false, 'readHookStatus should report claudeMd absent when no CLAUDE.md');
  installHook({ repoPath: FIXTURE_REPO, siteRoot: SITE_ROOT, host: '127.0.0.1', port: Number(PORT), kbPath: FIXTURE_KB_PATH });
  s = readHookStatus({ repoPath: FIXTURE_REPO });
  assert(s.installed === true && s.kbManaged === true, 'readHookStatus should report KB-managed hook');
  assert(s.claudeMd && s.claudeMd.managed === true, 'readHookStatus should report claudeMd.managed=true when rule is installed');

  // opt-out: updateClaudeMd:false should leave CLAUDE.md alone.
  uninstallHook({ repoPath: FIXTURE_REPO });
  rmrf(claudeMdPath);
  fs.writeFileSync(claudeMdPath, '# user-written only, do not touch\n', 'utf-8');
  r = installHook({ repoPath: FIXTURE_REPO, siteRoot: SITE_ROOT, host: '127.0.0.1', port: Number(PORT), updateClaudeMd: false, kbPath: FIXTURE_KB_PATH });
  assert(r.ok, 'installHook with updateClaudeMd:false failed: ' + r.error);
  assert(r.claudeMd && r.claudeMd.action === 'skipped', 'installHook with updateClaudeMd:false should skip CLAUDE.md: ' + JSON.stringify(r.claudeMd));
  const userOnly = fs.readFileSync(claudeMdPath, 'utf-8');
  assert(userOnly === '# user-written only, do not touch\n', 'updateClaudeMd:false must not modify user CLAUDE.md');
  assert(!userOnly.includes(SECTION_MARKER_START), 'updateClaudeMd:false must not insert rule markers');
  uninstallHook({ repoPath: FIXTURE_REPO, updateClaudeMd: false });
  assert(fs.readFileSync(claudeMdPath, 'utf-8') === '# user-written only, do not touch\n', 'uninstallHook with updateClaudeMd:false must not touch user CLAUDE.md');
  rmrf(claudeMdPath);

  // Reinstall with default behavior so the rest of the test (server + real
  // git commit) runs against a repo whose CLAUDE.md has the KB rule.
  installHook({ repoPath: FIXTURE_REPO, siteRoot: SITE_ROOT, host: '127.0.0.1', port: Number(PORT), kbPath: FIXTURE_KB_PATH });
  assert(fs.existsSync(claudeMdPath), 'CLAUDE.md should exist after default installHook');

  const childDown = spawn(process.execPath, [HOOK_TRIGGER, '--kb-root', KB_ROOT, '--repo', FIXTURE_REPO, '--host', '127.0.0.1', '--port', '1'], {
    cwd: ROOT,
    stdio: 'pipe',
    windowsHide: true,
    env: { ...process.env, KB_SITE_PORT: '1' },
  });
  const downExit = await new Promise(res => { childDown.on('exit', res); });
  assert(downExit === 0, `hook-trigger should exit 0 even when server is down, got ${downExit}`);

  const serverHandle = spawnServer({
    root: ROOT,
    port: Number(PORT),
    tag: 'hook-trigger',
    extraEnv: { KB_AUTOMATION_FAKE_CLAUDE: '1' },
  });
  const server = serverHandle.child;
  const serverDataDir = serverHandle.dataDir;
  DATA_DIR = serverDataDir;
  // Override the test's PROJECTS_JSON so it writes into the same data dir
  // the spawned server reads from.
  PROJECTS_JSON = path.join(serverDataDir, 'projects.json');
  fs.writeFileSync(
    path.join(serverDataDir, 'ai-profiles.json'),
    JSON.stringify(BASELINE_AI_PROFILES, null, 2) + '\n',
    'utf-8'
  );
  let serverOutput = '';
  server.stdout.on('data', d => { serverOutput += d.toString(); });
  server.stderr.on('data', d => { serverOutput += d.toString(); });

  const projKb = path.join(serverDataDir, 'projects', SLUG);
  try {
    await waitForServer();

    rmrf(projKb);
    rmrf(path.join(serverDataDir, '_ai', SLUG));
    fs.mkdirSync(projKb, { recursive: true });
    fs.mkdirSync(path.join(projKb, 'modules'), { recursive: true });
    fs.mkdirSync(path.join(projKb, 'changes'), { recursive: true });
    fs.writeFileSync(path.join(projKb, 'README.md'), '# hook test kb\n', 'utf-8');
    fs.writeFileSync(path.join(projKb, 'GOAL.md'), '# goal\n\ntest goal\n', 'utf-8');
    fs.writeFileSync(path.join(projKb, 'ARCHITECTURE.md'), '# architecture\n', 'utf-8');
    fs.writeFileSync(path.join(projKb, 'modules', '00-index.md'), '# Modules Index\n', 'utf-8');
    fs.writeFileSync(path.join(projKb, 'changes', '00-index.md'), '# Changes Index\n', 'utf-8');

    const projects = JSON.parse(fs.readFileSync(PROJECTS_JSON, 'utf-8'));
    projects[SLUG] = {
      displayName: 'Hook Test',
      localPath: FIXTURE_REPO,
      gitPath: FIXTURE_REPO,
      isReference: false,
      primaryLanguage: 'JavaScript',
      tags: [],
      docConvention: 'frontmatter-relations',
      kbPath: projKb,
      enabled: true,
      repoStatus: 'unknown',
      headCommit: null,
      lastSeenCommit: null,
      lastAnalyzedCommit: null,
      aiProfileId: enabledProfileId(),
      kbSchemaVersion: 'minimal',
      goalStatus: 'accepted',
      kbInitialized: true,
      automation: {
        enabled: true,
        postCommitEnabled: true,
        knowledgeMode: 'directWriteKb',
        allowReadOnlyBash: true,
        hookPromptTemplate: 'Hook test {{projectSlug}} {{shortHash}} {{changedFiles}} {{knowledgeMode}} {{permissionMode}}',
      },
      claudeWorkbench: { permissionMode: 'bypassPermissions' },
    };
    fs.writeFileSync(PROJECTS_JSON, JSON.stringify(projects, null, 2) + '\n', 'utf-8');

    uninstallHook({ repoPath: FIXTURE_REPO });
    r = installHook({ repoPath: FIXTURE_REPO, siteRoot: SITE_ROOT, host: '127.0.0.1', port: Number(PORT), kbPath: FIXTURE_KB_PATH });
    assert(r.ok, 'reinstall failed: ' + r.error);

    makeCommit(FIXTURE_REPO, 'feat: add changelog entry to trigger hook');

    const run = await waitForAutomationRun(SLUG, 30000);
    assert(run, `no automation run for ${SLUG} appeared within 30s; server output: ${serverOutput.slice(-1000)}`);
    assert(run.knowledgeMode === 'directWriteKb', 'wrong knowledge mode: ' + run.knowledgeMode);
    assert(run.permissionMode === 'bypassPermissions', 'wrong permission mode: ' + run.permissionMode);
    assert(run.allowedTools.includes('Write'), 'directWriteKb should allow Write in the automation policy');
    console.log('hook automation observed:', run.runId, run.projectSlug, run.status);

    const logPath = path.join(serverDataDir, '.hook-trigger-errors.log');
    if (fs.existsSync(logPath)) {
      const lines = fs.readFileSync(logPath, 'utf-8').split('\n').filter(Boolean);
      console.log('hook error log lines:', lines.length);
    }

    console.log('hook trigger test passed');
  } catch (e) {
    console.error('hook trigger test failed:', e.message);
    if (serverOutput) console.error('--- server output ---');
    if (serverOutput) console.error(serverOutput.slice(-2000));
    process.exitCode = 1;
  } finally {
    try { uninstallHook({ repoPath: FIXTURE_REPO }); } catch {}
    rmrf(FIXTURE_REPO);
    rmrf(FIXTURE_KB_PATH);
    rmrf(FIXTURE_PROJECTS_PATH);
    rmrf(projKb);
    rmrf(path.join(serverDataDir, '_ai', SLUG));
    try { fs.rmSync(serverDataDir, { recursive: true, force: true }); } catch {}
    try {
      const projects = JSON.parse(fs.readFileSync(PROJECTS_JSON, 'utf-8'));
      if (projects[SLUG]) {
        delete projects[SLUG];
        fs.writeFileSync(PROJECTS_JSON, JSON.stringify(projects, null, 2) + '\n', 'utf-8');
      }
    } catch {}
    server.kill();
  }
})();
