'use strict';
// PRJ-008: Git initialization needs an explicit user confirmation.
//
// The steps of the case are "select a directory that is not a Git repository,
// then request the import with and without the initialization confirmation".
// Two expectations are covered:
//   1. without an explicit confirmation no `git init` may happen;
//   2. the initialization only happens inside the fixture the user selected.
//
// The instance is an isolated product server with its own data directory and
// its own knowledge root. Nothing outside the fixture directory is touched.

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
  return { status: result.status, stdout: String(result.stdout || '').trim(), stderr: String(result.stderr || '').trim() };
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

function findGitDirectories(root, depth = 0) {
  const found = [];
  if (depth > 3) return found;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const absolute = path.join(root, entry.name);
    if (entry.name === '.git') { found.push(absolute); continue; }
    found.push(...findGitDirectories(absolute, depth + 1));
  }
  return found;
}

async function main() {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-prj-gitinit-'));
  const dataDir = path.join(fixture, 'data');
  const knowledgeRoot = path.join(fixture, 'knowledge');
  const selected = path.join(fixture, 'selected-project');
  const neighbour = path.join(fixture, 'neighbour-project');
  fs.mkdirSync(selected); fs.mkdirSync(neighbour);
  fs.writeFileSync(path.join(selected, 'README.md'), '# selected\n');
  fs.writeFileSync(path.join(neighbour, 'README.md'), '# neighbour\n');

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const server = spawnServer({ root: ROOT, port, dataDir, tag: 'project-git-init' });
  const api = async (method, route, body) => {
    const response = await fetch(base + route, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    return { status: response.status, body: await response.json() };
  };
  try {
    await waitForHealth(base);
    assert.equal((await api('PATCH', '/api/settings', { knowledge: { rootPath: knowledgeRoot } })).status, 200);

    // The preflight reports that a Git initialization is planned. The
    // directory itself stays untouched: the preflight never mutates state.
    const preflight = await api('POST', '/api/projects/preflight-import', { localPath: selected, knowledgePath: path.join(knowledgeRoot, 'selected'), displayName: '选定目录' });
    assert.equal(preflight.status, 200, JSON.stringify(preflight.body));
    assert.equal(preflight.body.plannedGitInit, true, 'the preflight must report the planned Git initialization');
    assert.equal(preflight.body.checks.git.status, 'non-git', 'the preflight must report the directory as a non-Git directory');
    assert.equal(fs.existsSync(path.join(selected, '.git')), false, 'the preflight must not initialize the repository');

    // Without the explicit confirmation the import is refused and no Git
    // repository is created anywhere.
    const refused = await api('POST', '/api/projects/import', { localPath: selected, knowledgePath: path.join(knowledgeRoot, 'selected'), displayName: '选定目录' });
    assert.equal(refused.status, 400, JSON.stringify(refused.body));
    assert.equal(refused.body.error.code, 'INVALID_ARGUMENT');
    assert.match(refused.body.error.message, /初始化/, 'the refusal must name the missing Git initialization confirmation');
    assert.equal(fs.existsSync(path.join(selected, '.git')), false, 'a refused import must not run git init');
    assert.deepEqual(findGitDirectories(fixture), [], 'a refused import must not create a Git repository anywhere in the fixture');
    assert.equal((await api('GET', '/api/projects/aggregated')).body.projects.length, 0, 'a refused import must not register a project');

    // With the explicit confirmation the initialization happens inside the
    // selected fixture only.
    const imported = await api('POST', '/api/projects/import', { localPath: selected, knowledgePath: path.join(knowledgeRoot, 'selected'), displayName: '选定目录', confirmGitInit: true });
    assert.equal(imported.status, 201, JSON.stringify(imported.body));
    assert.equal(fs.existsSync(path.join(selected, '.git')), true, 'the confirmed import must initialize the selected directory');
    assert.equal(fs.existsSync(path.join(neighbour, '.git')), false, 'the neighbouring directory must stay untouched');
    assert.deepEqual(findGitDirectories(fixture), [path.join(selected, '.git')], 'exactly the selected fixture may hold a Git repository');
    const inside = git(selected, ['rev-parse', '--is-inside-work-tree']);
    assert.equal(inside.status, 0, inside.stderr);
    assert.equal(inside.stdout, 'true');
    assert.equal(path.resolve(imported.body.project.config.repoPath), path.resolve(selected), 'the registered workspace path is the selected fixture');
    assert.equal((await api('GET', '/api/projects/aggregated')).body.projects.length, 1, 'the confirmed import registers exactly one project');
    console.log('project-git-init-confirm-test PASS (no git init without confirmation; initialization confined to the selected fixture)');
  } finally {
    await server.cleanup();
    fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
