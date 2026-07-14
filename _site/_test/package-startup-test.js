// Run: node _site/_test/package-startup-test.js
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const BIN = path.join(ROOT, 'bin', 'project-knowledge.js');
const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), `kb-data-package-startup-${process.pid}-`));
const PROJECTS_JSON = path.join(TEST_DATA_DIR, 'projects.json');
const AI_PROFILES_JSON = path.join(TEST_DATA_DIR, 'ai-profiles.json');
const CLAUDE_PROMPTS_JSON = path.join(TEST_DATA_DIR, 'claude-prompts.json');
const PORT = process.env.KB_PACKAGE_TEST_PORT || '7825';
const BASE_URL = `http://127.0.0.1:${PORT}`;

function assert(cond, msg) { if (!cond) throw new Error(msg); }

function backup(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : null;
}

function restore(file, content) {
  if (content == null) fs.rmSync(file, { force: true });
  else fs.writeFileSync(file, content, 'utf-8');
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf-8');
}

async function waitForServer() {
  const deadline = Date.now() + 15000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE_URL}/api/state`);
      if (res.ok) return res.json();
      lastError = new Error(`HTTP ${res.status}`);
    } catch (e) { lastError = e; }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw lastError || new Error('server did not start');
}

async function stop(child) {
  if (!child || child.killed) return;
  child.kill('SIGTERM');
  await new Promise(resolve => setTimeout(resolve, 250));
  if (!child.killed) child.kill('SIGKILL');
}

async function withServer(fn) {
  const child = spawn(process.execPath, [BIN, '--fg', '--port', PORT, '--host', '127.0.0.1', '--no-open'], {
    cwd: ROOT,
    env: { ...process.env, KB_DATA_DIR: TEST_DATA_DIR, KB_CLAUDE_RULES_DIR: TEST_DATA_DIR, KB_SKIP_MIGRATION: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let output = '';
  child.stdout.on('data', d => { output += d.toString(); });
  child.stderr.on('data', d => { output += d.toString(); });
  try {
    const state = await waitForServer();
    await fn(state, output);
  } finally {
    await stop(child);
  }
}

function initGitRepo(repoPath) {
  fs.rmSync(repoPath, { recursive: true, force: true });
  fs.mkdirSync(repoPath, { recursive: true });
  let result = spawnSync('git', ['init'], { cwd: repoPath, encoding: 'utf-8' });
  assert(result.status === 0, 'git init should succeed: ' + result.stderr);
  spawnSync('git', ['config', 'user.email', 'kb-test@example.com'], { cwd: repoPath, encoding: 'utf-8' });
  spawnSync('git', ['config', 'user.name', 'KB Test'], { cwd: repoPath, encoding: 'utf-8' });
  fs.writeFileSync(path.join(repoPath, 'README.md'), '# hook api\n', 'utf-8');
  result = spawnSync('git', ['add', 'README.md'], { cwd: repoPath, encoding: 'utf-8' });
  assert(result.status === 0, 'git add should succeed: ' + result.stderr);
  result = spawnSync('git', ['commit', '-m', 'init'], { cwd: repoPath, encoding: 'utf-8' });
  assert(result.status === 0, 'git commit should succeed: ' + result.stderr);
}

async function requestJson(method, url, body) {
  const res = await fetch(`${BASE_URL}${url}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = {};
  if (text) {
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
  }
  return { res, status: res.status, data };
}

(async () => {
  const originalProjects = backup(PROJECTS_JSON);
  const originalInvalidBackups = new Set(
    fs.readdirSync(TEST_DATA_DIR).filter(name => name.startsWith('projects.json.invalid-') && name.endsWith('.bak'))
  );

  try {
    const version = spawnSync(process.execPath, [BIN, '--version'], { cwd: ROOT, encoding: 'utf-8' });
    assert(version.status === 0, '--version should exit successfully');
    assert(version.stdout.trim() === require(path.join(ROOT, 'package.json')).version, '--version should match package version');

    fs.rmSync(PROJECTS_JSON, { force: true });
    await withServer(async (state) => {
      assert(state && state.projects && typeof state.projects === 'object', 'missing projects.json should still return projects object');
      assert(fs.existsSync(PROJECTS_JSON), 'missing projects.json should be created on first API read');
      assert(fs.readFileSync(PROJECTS_JSON, 'utf-8').trim() === '{}', 'missing projects.json should initialize to {}');
    });

    fs.writeFileSync(PROJECTS_JSON, '', 'utf-8');
    await withServer(async (state) => {
      assert(state && state.projects && typeof state.projects === 'object', 'empty projects.json should still return projects object');
      assert(fs.readFileSync(PROJECTS_JSON, 'utf-8').trim() === '{}', 'empty projects.json should be normalized to {}');
    });

    fs.writeFileSync(PROJECTS_JSON, '{', 'utf-8');
    await withServer(async (state) => {
      assert(state && state.projects && typeof state.projects === 'object', 'invalid projects.json should still return projects object');
      assert(fs.readFileSync(PROJECTS_JSON, 'utf-8').trim() === '{}', 'invalid projects.json should be replaced with {}');
      const newBackups = fs.readdirSync(TEST_DATA_DIR)
        .filter(name => name.startsWith('projects.json.invalid-') && name.endsWith('.bak'))
        .filter(name => !originalInvalidBackups.has(name));
      assert(newBackups.length >= 1, 'invalid projects.json should be backed up before recovery');
    });

    const hookRepo = path.join(TEST_DATA_DIR, 'hook-api-repo');
    const hookKb = path.join(TEST_DATA_DIR, 'projects', 'hook-api-proj');
    initGitRepo(hookRepo);
    writeJson(PROJECTS_JSON, {
      'hook-api-proj': {
        displayName: 'Hook API Project',
        localPath: hookRepo,
        gitPath: hookRepo,
        kbPath: hookKb,
      },
    });
    await withServer(async () => {
      let r = await requestJson('GET', '/api/projects/hook-api-proj/hook-status');
      assert(r.status === 200, 'hook-status should return 200');
      assert(r.data.installed === false, 'hook-status should start as not installed');

      r = await requestJson('POST', '/api/projects/hook-api-proj/hook-install', { overwrite: false });
      assert(r.status === 200, 'hook-install should return 200');
      assert(r.data.ok === true, 'hook-install should return ok=true');
      assert(r.data.installed === true, 'hook-install should return installed=true');
      assert(typeof r.data.hookPath === 'string' && r.data.hookPath.includes('post-commit'), 'hook-install should return hookPath');

      r = await requestJson('GET', '/api/projects/hook-api-proj/hook-status');
      assert(r.status === 200 && r.data.installed === true, 'hook-status should report installed after install');

      r = await requestJson('POST', '/api/projects/hook-api-proj/hook-uninstall', {});
      assert(r.status === 200, 'hook-uninstall should return 200');
      assert(r.data.ok === true, 'hook-uninstall should return ok=true');
      assert(r.data.installed === false, 'hook-uninstall should return installed=false');

      r = await requestJson('GET', '/api/projects/hook-api-proj/hook-status');
      assert(r.status === 200 && r.data.installed === false, 'hook-status should report not installed after uninstall');
    });

    const terminalRepo = path.join(TEST_DATA_DIR, 'terminal-api-repo');
    const terminalKb = path.join(TEST_DATA_DIR, 'projects', 'terminal-api-proj');
    initGitRepo(terminalRepo);
    fs.mkdirSync(terminalKb, { recursive: true });
    fs.writeFileSync(path.join(terminalKb, 'README.md'), '# terminal api kb\n', 'utf-8');
    fs.rmSync(CLAUDE_PROMPTS_JSON, { force: true });
    writeJson(AI_PROFILES_JSON, {
      schema: 'ai-profiles/v1',
      profiles: [{
        id: 'test-claude-agent',
        name: 'Test Claude Agent',
        enabled: true,
        implementation: 'claude-code-agent',
        apiKey: 'sk-test',
        baseUrl: 'https://example.test/anthropic',
        mainModel: 'test-model',
      }],
    });
    writeJson(PROJECTS_JSON, {
      'terminal-api-proj': {
        displayName: 'Terminal API Project',
        localPath: terminalRepo,
        gitPath: terminalRepo,
        kbPath: terminalKb,
        aiProfileId: 'test-claude-agent',
        claudeWorkbench: { permissionMode: 'default' },
      },
    });
    await withServer(async () => {
      assert(!fs.existsSync(CLAUDE_PROMPTS_JSON), 'terminal startup fixture should begin without claude-prompts.json');
      const r = await requestJson('POST', '/api/projects/terminal-api-proj/analyze/initial?mode=cli', {});
      assert(r.status === 200, `terminal kickoff should not require claude-prompts.json, got HTTP ${r.status}: ${JSON.stringify(r.data)}`);
      assert(r.data.ok === true, 'terminal kickoff should return ok=true');
      assert(typeof r.data.sessionId === 'string' && r.data.sessionId.startsWith('sess-'), 'terminal kickoff should return sessionId');
      assert(r.data.runner === 'sdk', 'terminal kickoff should use SDK runner');
    });

    console.log('package-startup-test PASS');
  } finally {
    try { fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true }); } catch {}
    restore(PROJECTS_JSON, originalProjects);
  }
})().catch(err => {
  console.error(err && err.stack || err);
  process.exit(1);
});
