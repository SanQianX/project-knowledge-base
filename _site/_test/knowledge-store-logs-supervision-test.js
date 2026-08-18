const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnServer } = require('./helpers/spawn-server');
const { makeRepo } = require('./fixtures/make-git-repos');

const ROOT = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.KB_TASK_012_013_TEST_PORT || 7814);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), `kb-store-logs-v2-${process.pid}-`));

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
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) : {} };
}

(async () => {
  const repoOne = makeRepo({ kind: 'multi-commit' });
  const repoTwo = makeRepo({ kind: 'one-commit' });
  const spawned = spawnServer({ root: ROOT, port: PORT, dataDir: DATA_DIR, tag: 'knowledge-store-logs-v2', extraEnv: { KB_EMBEDDING_FAKE: '1' } });
  let output = '';
  spawned.child.stdout.on('data', chunk => { output += chunk; });
  spawned.child.stderr.on('data', chunk => { output += chunk; });
  try {
    await waitForServer();
    const rootOne = path.join(DATA_DIR, 'knowledge-one');
    let result = await json('PATCH', '/api/settings', { knowledge: { rootPath: rootOne } });
    assert(result.response.ok, JSON.stringify(result.body));
    result = await json('POST', '/api/projects/import', { projectId: 'store-project-one', localPath: repoOne.path, displayName: 'Store one' });
    assert.strictEqual(result.response.status, 201, JSON.stringify(result.body));
    const fixedPath = result.body.config.knowledgePath;
    assert(path.resolve(fixedPath).startsWith(`${path.resolve(rootOne)}${path.sep}`));
    assert.deepStrictEqual(fs.readdirSync(fixedPath), [], 'import must not generate TODO or initialization knowledge');

    const rootTwo = path.join(DATA_DIR, 'knowledge-two');
    result = await json('PATCH', '/api/settings', { knowledge: { rootPath: rootTwo } });
    assert(result.response.ok);
    result = await json('POST', '/api/projects/import', { projectId: 'store-project-two', localPath: repoTwo.path, displayName: 'Store two' });
    assert.strictEqual(result.response.status, 201, JSON.stringify(result.body));
    assert(path.resolve(result.body.config.knowledgePath).startsWith(`${path.resolve(rootTwo)}${path.sep}`));
    result = await json('GET', '/api/projects/store-project-one');
    assert.strictEqual(result.body.project.config.knowledgePath, fixedPath, 'global root changes affect only future imports');

    result = await json('PATCH', '/api/settings', { logging: { levels: ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] } });
    assert.strictEqual(result.response.status, 409, 'logging capture policy must not be a mutable product setting');
    const publicSettings = await json('GET', '/api/settings');
    assert.strictEqual(Object.prototype.hasOwnProperty.call(publicSettings.body.settings.logging, 'retentionDays'), false);
    result = await json('PATCH', '/api/settings', { logging: { retentionDays: 0 } });
    assert.strictEqual(result.response.status, 409, 'automatic retention settings must be removed');
    result = await json('PATCH', '/api/settings', { logging: { rootPath: path.join(DATA_DIR, 'external-logs') } });
    assert.strictEqual(result.response.status, 409, 'logging root must not be configurable');
    assert(!fs.existsSync(path.join(DATA_DIR, 'external-logs')));

    result = await json('GET', '/api/logs?levels=info,error&pageSize=100');
    assert(result.response.ok, JSON.stringify(result.body));
    assert(result.body.entries.some(log => log.event === 'project.import.completed' && log.projectId === 'store-project-one'));
    assert(result.body.health && ['ok', 'degraded'].includes(result.body.health.status));
    const state = await json('GET', '/api/state');
    const one = state.body.projects.find(project => project.projectId === 'store-project-one');
    assert(one && one.state.trackingStartCommit, 'v2 state should expose the import tracking baseline');
    assert.strictEqual(one.state.analysis.status, 'idle');
    assert.strictEqual(one.state.hook.managedVersion, 2);

    result = await json('POST', '/api/knowledge-store/migrate', { execute: false });
    assert.strictEqual(result.response.status, 404, 'the old storage relocation API must remain removed');
    console.log('TASK-012/TASK-013 knowledge store, logs, supervision test passed');
  } catch (error) {
    if (output) process.stderr.write(output);
    throw error;
  } finally {
    spawned.child.kill();
    repoOne.cleanup();
    repoTwo.cleanup();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
