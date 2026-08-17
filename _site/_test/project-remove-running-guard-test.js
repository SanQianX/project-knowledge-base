const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { spawnServer } = require('./helpers/spawn-server');
const hookManager = require('../lib/hook-manager');

const ROOT = path.resolve(__dirname, '..', '..');
const PORT = 7900 + (process.pid % 500);
const BASE = `http://127.0.0.1:${PORT}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkb-remove-v2-'));
const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'pkb-remove-repo-'));

function git(args) {
  const result = spawnSync('git', args, { cwd: repoPath, encoding: 'utf8' });
  assert.strictEqual(result.status, 0, result.stderr);
}

async function json(method, pathname, body) {
  const response = await fetch(`${BASE}${pathname}`, { method, headers: body === undefined ? undefined : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, data: await response.json() };
}

async function waitForServer() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('server did not start');
}

(async () => {
  git(['init', '--initial-branch=main']);
  git(['config', 'user.email', 'remove@example.test']);
  git(['config', 'user.name', 'Remove Test']);
  const spawned = spawnServer({ root: ROOT, port: PORT, dataDir, tag: 'remove-v2', extraEnv: { KB_SKIP_MIGRATION: '1' } });
  try {
    await waitForServer();
    await json('PATCH', '/api/settings', { knowledge: { rootPath: path.join(dataDir, 'knowledge') } });
    const imported = await json('POST', '/api/projects/import', { localPath: repoPath });
    assert.strictEqual(imported.status, 201, JSON.stringify(imported.data));
    const projectId = imported.data.projectId;
    const statePath = path.join(dataDir, 'projects', projectId, 'state.json');
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    state.analysis.activeClaim = { schema: 'commit-claim/v1', projectId, commitSha: 'a'.repeat(40) };
    fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');

    let removed = await json('DELETE', `/api/projects/${projectId}`, { deleteKnowledge: false });
    assert.strictEqual(removed.status, 409);
    assert.strictEqual(removed.data.error.code, 'PROJECT_BUSY');
    let projects = await json('GET', '/api/projects');
    assert(projects.data.projects.some(project => project.projectId === projectId));

    state.analysis.activeClaim = null;
    fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    const hookPath = path.join(repoPath, '.git', 'hooks', 'post-commit');
    fs.writeFileSync(hookPath, '#!/bin/sh\n# third party\n', 'utf8');
    removed = await json('DELETE', `/api/projects/${projectId}`, { deleteKnowledge: false });
    assert.strictEqual(removed.status, 409);
    assert.strictEqual(removed.data.error.code, 'HOOK_CONFLICT');
    projects = await json('GET', '/api/projects');
    assert(projects.data.projects.some(project => project.projectId === projectId), 'Hook failure must preserve registry');

    fs.rmSync(hookPath, { force: true });
    hookManager.installHook({ repoPath, projectId, triggerScriptPath: path.join(ROOT, '_site', 'scripts', 'hook-trigger.js') });
    const knowledgePath = imported.data.project.config.knowledgePath;
    removed = await json('DELETE', `/api/projects/${projectId}`, { deleteKnowledge: false });
    assert.strictEqual(removed.status, 200, JSON.stringify(removed.data));
    assert(fs.existsSync(knowledgePath), 'external knowledge must be preserved by default');
    projects = await json('GET', '/api/projects');
    assert(!projects.data.projects.some(project => project.projectId === projectId));
    console.log('project-remove-running-guard-test PASS');
  } finally {
    spawned.cleanup();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(repoPath, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
