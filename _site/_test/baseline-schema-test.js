const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnServer } = require('./helpers/spawn-server');
const { makeRepo } = require('./fixtures/make-git-repos');

const ROOT = path.resolve(__dirname, '..', '..');
const PORT = 7791;
const BASE = 'http://127.0.0.1:' + PORT;

async function json(method, pathname, body) {
  const response = await fetch(BASE + pathname, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { response, body: await response.json() };
}

async function waitForServer() {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    try { if ((await fetch(BASE + '/api/health')).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('v2 baseline server did not start');
}

(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-baseline-v2-'));
  const knowledgeRoot = path.join(dataDir, 'knowledge-root');
  const repo = makeRepo({ kind: 'one-commit' });
  const spawned = spawnServer({ root: ROOT, port: PORT, dataDir, tag: 'baseline-v2', stdio: 'ignore' });
  try {
    await waitForServer();
    let result = await json('GET', '/api/state');
    assert.strictEqual(result.response.status, 200);
    assert.strictEqual(result.body.schema, 'server-state/v2');
    assert.strictEqual(result.body.settings.schema, 'settings/v2');
    assert.deepStrictEqual(result.body.projects, []);

    result = await json('PATCH', '/api/settings', { knowledge: { rootPath: knowledgeRoot } });
    assert.strictEqual(result.response.status, 200);

    result = await json('POST', '/api/projects/import', { localPath: repo.path, displayName: 'Baseline v2' });
    assert.strictEqual(result.response.status, 201, JSON.stringify(result.body));
    const projectId = result.body.projectId;
    const project = result.body.project;
    assert.strictEqual(project.config.schema, 'project-config/v2');
    assert.strictEqual(project.state.schema, 'project-state/v2');
    assert.strictEqual(project.config.projectId, projectId);
    assert.strictEqual(project.state.trackingStartCommit, repo.headCommit);
    assert.strictEqual(project.state.lastAnalyzedCommit, null);
    assert.strictEqual(project.state.analysis.status, 'idle');
    assert.strictEqual(project.state.hook.managedVersion, 2);
    assert(path.isAbsolute(project.config.repoPath) && path.isAbsolute(project.config.knowledgePath));
    assert(project.config.knowledgePath.startsWith(path.resolve(knowledgeRoot)));
    assert.deepStrictEqual(fs.readdirSync(project.config.knowledgePath), []);

    const registry = JSON.parse(fs.readFileSync(path.join(dataDir, 'projects.json'), 'utf8'));
    assert.strictEqual(registry.schema, 'project-registry/v2');
    assert.deepStrictEqual(registry.projectOrder, [projectId]);
    assert.deepStrictEqual(Object.keys(registry.projects), [projectId]);
    assert(!Object.prototype.hasOwnProperty.call(registry.projects[projectId], 'lastAnalyzedCommit'));

    result = await json('GET', '/api/projects');
    assert.strictEqual(result.response.status, 200);
    assert.strictEqual(result.body.projects.length, 1);
    assert.strictEqual(result.body.projects[0].projectId, projectId);

    const htmlResponse = await fetch(BASE + '/');
    const html = await htmlResponse.text();
    assert.strictEqual(htmlResponse.status, 200);
    assert.strictEqual((html.match(/class="shell"/g) || []).length, 1);
    assert.strictEqual((html.match(/id="settings-logs"/g) || []).length, 1);
    assert(!html.includes('vue.global.prod.js'));

    result = await json('DELETE', '/api/projects/' + encodeURIComponent(projectId), { deleteKnowledge: false });
    assert.strictEqual(result.response.status, 200);
    assert.strictEqual(fs.existsSync(project.config.knowledgePath), true, 'default delete must preserve external knowledge');
    assert.strictEqual(fs.existsSync(path.join(repo.path, '.git', 'hooks', 'post-commit')), false);

    console.log('baseline schema test PASS');
  } finally {
    spawned.cleanup();
    repo.cleanup();
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
  }
})().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
