'use strict';
// PRJ-004: a repository whose path contains Chinese characters and spaces.
//
// Three expectations are covered: the stored paths are normalized absolute
// paths, the managed Hook really runs, and the absolute knowledge path stays
// the same after the isolated instance is restarted. The restart only touches
// this fixture's own instance; no running desktop is stopped or replaced.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { spawnServer } = require('./helpers/spawn-server');
const freePort = require('./helpers/free-port');

const ROOT = path.resolve(__dirname, '../..');

function git(cwd, args) {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
  return String(result.stdout || '').trim();
}

function resolveShell() {
  const execPath = spawnSync('git', ['--exec-path'], { encoding: 'utf8', windowsHide: true }).stdout.trim();
  if (!execPath) return 'sh';
  const root = path.resolve(execPath, '..', '..', '..');
  for (const candidate of [path.join(root, 'bin', 'sh.exe'), path.join(root, 'usr', 'bin', 'sh.exe')]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return 'sh';
}

async function waitForHealth(base, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(2000) });
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for the isolated server on ' + base);
}

function makeApi(base) {
  return async (method, route, body) => {
    const response = await fetch(base + route, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    return { status: response.status, body: await response.json() };
  };
}

async function main() {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-prj-unicode-'));
  const dataDir = path.join(fixture, 'data');
  const repo = path.join(fixture, '中文 空格项目');
  const knowledgeRoot = path.join(fixture, '知识根');
  const knowledge = path.join(knowledgeRoot, '项目知识');
  fs.mkdirSync(repo); fs.mkdirSync(knowledgeRoot); fs.mkdirSync(knowledge);
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.email', 'unicode@local.invalid']);
  git(repo, ['config', 'user.name', 'Unicode Regression']);
  fs.writeFileSync(path.join(repo, '说明.md'), '# 中文路径\n');
  git(repo, ['add', '.']); git(repo, ['commit', '-qm', 'baseline']);
  const baseline = git(repo, ['rev-parse', 'HEAD']);

  const firstPort = await freePort();
  const firstBase = `http://127.0.0.1:${firstPort}`;
  const first = spawnServer({ root: ROOT, port: firstPort, dataDir, tag: 'project-import-unicode' });
  let second = null;
  try {
    await waitForHealth(firstBase);
    const api = makeApi(firstBase);
    // The settings route keeps the operator's spelling of the root; every
    // consumer resolves it, so a trailing separator still names one directory.
    const configured = await api('PATCH', '/api/settings', { knowledge: { rootPath: knowledgeRoot + path.sep } });
    assert.equal(configured.status, 200, JSON.stringify(configured.body));
    assert.equal(path.isAbsolute(configured.body.settings.knowledge.rootPath), true, 'the knowledge root is stored as an absolute path');
    assert.equal(path.resolve(configured.body.settings.knowledge.rootPath), path.resolve(knowledgeRoot), 'the stored knowledge root resolves to the configured directory');

    const imported = await api('POST', '/api/projects/import', { localPath: repo, knowledgePath: knowledge, displayName: '中文 项目' });
    assert.equal(imported.status, 201, JSON.stringify(imported.body));
    const projectId = imported.body.projectId;

    const config = imported.body.project.config;
    assert.equal(config.repoPath, path.resolve(repo), 'the workspace path is stored normalized');
    assert.equal(config.knowledgePath, path.resolve(knowledge), 'the knowledge path is stored normalized');
    assert.equal(path.isAbsolute(config.repoPath), true);
    assert.equal(path.isAbsolute(config.knowledgePath), true);
    assert.ok(config.repoPath.includes('中文 空格项目'), 'the Chinese and spaced segments survive');
    assert.ok(config.knowledgePath.includes('项目知识'), 'the Chinese knowledge segment survives');
    assert.equal(git(repo, ['rev-parse', 'HEAD']), baseline, 'the import does not move HEAD');

    // The managed Hook must exist and be runnable.
    const hookPath = path.join(repo, '.git', 'hooks', 'post-commit');
    assert.ok(fs.existsSync(hookPath), 'the managed Hook is installed');
    const hookText = fs.readFileSync(hookPath, 'utf8');
    assert.ok(hookText.includes(`# PROJECT-KNOWLEDGE-HOOK `), 'the Hook carries the managed marker');
    assert.ok(hookText.includes(projectId), 'the Hook belongs to the imported project');
    const hookRun = spawnSync(resolveShell(), [hookPath], { cwd: repo, encoding: 'utf8', windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    assert.equal(hookRun.status, 0, `the Hook must run successfully: ${hookRun.stderr}`);
    const logDir = path.join(dataDir, 'logs', 'projects', projectId);
    const logFiles = fs.existsSync(logDir) ? fs.readdirSync(logDir).filter(name => name.endsWith('.jsonl')) : [];
    assert.ok(logFiles.length > 0, 'running the Hook leaves a durable log entry');
    const hookLog = logFiles.map(name => fs.readFileSync(path.join(logDir, name), 'utf8')).join('');
    assert.match(hookLog, /hook\./, 'the log entry records the Hook execution');

    // Restart the fixture instance only: same data directory, new port.
    first.child.kill();
    await new Promise(resolve => first.child.once('close', resolve));
    const secondPort = await freePort();
    const secondBase = `http://127.0.0.1:${secondPort}`;
    second = spawnServer({ root: ROOT, port: secondPort, dataDir, tag: 'project-import-unicode-restart' });
    await waitForHealth(secondBase);
    const restartedApi = makeApi(secondBase);
    const reopened = await restartedApi('GET', `/api/projects/${projectId}`);
    assert.equal(reopened.status, 200, JSON.stringify(reopened.body));
    assert.equal(reopened.body.project.config.repoPath, path.resolve(repo), 'the workspace path is unchanged after the restart');
    assert.equal(reopened.body.project.config.knowledgePath, path.resolve(knowledge), 'the absolute knowledge path is unchanged after the restart');
    const settingsAfterRestart = await restartedApi('GET', '/api/settings');
    assert.equal(path.resolve(settingsAfterRestart.body.settings.knowledge.rootPath), path.resolve(knowledgeRoot), 'the knowledge root is unchanged after the restart');
    const aggregated = await restartedApi('GET', '/api/projects/aggregated');
    assert.equal(aggregated.body.projects.length, 1, 'the project is still registered after the restart');
    assert.equal(aggregated.body.projects[0].knowledgePath, path.resolve(knowledge), 'the registered knowledge path is still absolute and identical');
    assert.ok(fs.existsSync(knowledge), 'the knowledge directory still exists on disk');
    console.log('project-import-unicode-restart-test PASS (normalized paths, runnable Hook, stable absolute knowledge path across a fixture-only restart)');
  } finally {
    await second?.cleanup();
    try { await first.cleanup(); } catch {}
    fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
