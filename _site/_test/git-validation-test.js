// Git status remains a read-only v2 API; manual validation/state mutation is removed.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { spawnServer } = require('./helpers/spawn-server');
const { makeRepo } = require('./fixtures/make-git-repos');

const ROOT = path.resolve(__dirname, '..', '..');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), `kb-data-git-validation-${process.pid}-`));
const PORT = Number(process.env.KB_GIT_TEST_PORT || 7792);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const PROJECT_ID = 'task-002-temp';

async function waitForServer() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { if ((await fetch(`${BASE_URL}/api/health`)).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('server did not start');
}

async function json(method, route, body) {
  const response = await fetch(`${BASE_URL}${route}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { response, body: await response.json() };
}

(async () => {
  const repo = makeRepo({ kind: 'one-commit' });
  const spawned = spawnServer({ root: ROOT, port: PORT, dataDir: DATA_DIR, tag: 'git-validation' });
  let output = '';
  spawned.child.stdout.on('data', chunk => { output += chunk; });
  spawned.child.stderr.on('data', chunk => { output += chunk; });
  try {
    await waitForServer();
    let result = await json('PATCH', '/api/settings', { knowledge: { rootPath: path.join(DATA_DIR, 'knowledge') } });
    assert(result.response.ok, JSON.stringify(result.body));
    result = await json('POST', '/api/projects/import', { projectId: PROJECT_ID, localPath: repo.path, displayName: 'Git status fixture' });
    assert(result.response.status === 201, JSON.stringify(result.body));

    const statePath = path.join(DATA_DIR, 'projects', PROJECT_ID, 'state.json');
    const stateBefore = fs.readFileSync(statePath, 'utf8');
    result = await json('GET', `/api/projects/${PROJECT_ID}/git-status`);
    assert(result.response.ok, JSON.stringify(result.body));
    assert.strictEqual(result.body.repoStatus, 'ok');
    assert.strictEqual(result.body.branch, 'main');
    assert.strictEqual(result.body.dirty, false);
    assert.match(result.body.headCommit, /^[a-f0-9]{40}$/i);
    assert.strictEqual(fs.readFileSync(statePath, 'utf8'), stateBefore, 'read-only status must not mutate project state');

    fs.writeFileSync(path.join(repo.path, 'untracked.txt'), 'working tree change\n', 'utf8');
    result = await json('GET', `/api/projects/${PROJECT_ID}/git-status`);
    assert.strictEqual(result.body.dirty, true);
    assert(result.body.changes.some(line => line.includes('untracked.txt')));

    execFileSync('git', ['add', 'untracked.txt'], { cwd: repo.path });
    execFileSync('git', ['commit', '-m', 'status fixture'], { cwd: repo.path });
    result = await json('GET', `/api/projects/${PROJECT_ID}/git-status`);
    assert.strictEqual(result.body.repoStatus, 'ok');
    assert.strictEqual(result.body.dirty, false);

    result = await json('POST', `/api/projects/${PROJECT_ID}/validate-git`, {});
    assert.strictEqual(result.response.status, 404, 'manual validation route must remain deleted');
    result = await json('GET', '/api/projects/%5Ebad/git-status');
    assert.strictEqual(result.response.status, 400);
    result = await json('GET', '/api/projects/project-missing/git-status');
    assert.strictEqual(result.response.status, 404);
    console.log('TASK-002 git validation test passed');
  } catch (error) {
    if (output) process.stderr.write(output);
    throw error;
  } finally {
    spawned.child.kill();
    repo.cleanup();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
