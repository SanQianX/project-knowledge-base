const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { spawnServer } = require('./helpers/spawn-server');

const ROOT = path.resolve(__dirname, '..', '..');
const PORT = 7824;
const BASE = `http://127.0.0.1:${PORT}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkb-import-v2-'));
const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'pkb-import-repo-'));
const knowledgeRoot = path.join(dataDir, 'knowledge');

function git(args) {
  const result = spawnSync('git', args, { cwd: repoPath, encoding: 'utf8' });
  assert.strictEqual(result.status, 0, result.stderr);
  return String(result.stdout || '').trim();
}

async function request(method, pathname, body) {
  const response = await fetch(`${BASE}${pathname}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
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
  git(['config', 'user.email', 'import@example.test']);
  git(['config', 'user.name', 'Import Test']);
  fs.writeFileSync(path.join(repoPath, 'README.md'), '# source\n', 'utf8');
  git(['add', 'README.md']);
  git(['commit', '-m', 'baseline']);
  const baseline = git(['rev-parse', 'HEAD']);

  const spawned = spawnServer({ root: ROOT, port: PORT, dataDir, tag: 'simple-import-v2', extraEnv: { KB_SKIP_MIGRATION: '1' } });
  let output = '';
  spawned.child.stdout.on('data', chunk => { output += chunk; });
  spawned.child.stderr.on('data', chunk => { output += chunk; });
  try {
    await waitForServer();
    let result = await request('PATCH', '/api/settings', { knowledge: { rootPath: knowledgeRoot } });
    assert.strictEqual(result.status, 200, JSON.stringify(result.data));

    result = await request('POST', '/api/projects/import', { localPath: repoPath, displayName: 'Imported v2' });
    assert.strictEqual(result.status, 201, JSON.stringify(result.data));
    assert.match(result.data.projectId, /^project-/);
    assert.strictEqual(result.data.project.config.projectId, result.data.projectId);
    assert.strictEqual(result.data.project.state.trackingStartCommit, baseline);
    assert.strictEqual(result.data.project.state.lastAnalyzedCommit, null);
    assert.strictEqual(result.data.project.state.analysis.status, 'idle');
    assert.strictEqual(result.data.hook.ok, true);
    assert.strictEqual(result.data.project.state.hook.managedVersion, 2);
    assert.deepStrictEqual(fs.readdirSync(result.data.project.config.knowledgePath), [], 'import must not create speculative knowledge');
    assert(!fs.existsSync(path.join(dataDir, 'projects', result.data.projectId, 'requirements.jsonl')));

    const projectId = result.data.projectId;
    result = await request('PATCH', `/api/projects/${projectId}`, { displayName: 'Renamed safely', knowledgeLanguage: 'en-US' });
    assert.strictEqual(result.status, 200, JSON.stringify(result.data));
    assert.strictEqual(result.data.config.displayName, 'Renamed safely');
    result = await request('PATCH', `/api/projects/${projectId}`, { repoPath: path.join(repoPath, 'unverified') });
    assert.strictEqual(result.status, 400, 'generic PATCH must not bypass Hook-verified repo relocation');
    assert.strictEqual(result.data.error.code, 'INVALID_ARGUMENT');
    result = await request('PATCH', `/api/projects/${projectId}`, { teamBinding: { provider: 'github' } });
    assert.strictEqual(result.status, 400, 'generic PATCH must not change a fixed team binding');

    const hookPath = path.join(repoPath, '.git', 'hooks', 'post-commit');
    assert(fs.existsSync(hookPath), 'managed Hook was not installed');
    const hook = fs.readFileSync(hookPath, 'utf8');
    assert(hook.includes('PROJECT-KNOWLEDGE-HOOK'));
    assert(hook.includes(projectId));

    result = await request('GET', '/api/projects');
    assert.strictEqual(result.status, 200);
    assert.strictEqual(result.data.projects.length, 1);
    assert.strictEqual(result.data.projects[0].projectId, result.data.projects[0].config.projectId);
    assert(!fs.existsSync(path.join(dataDir, 'runtime', 'staging')), 'import must not dispatch analysis');
    console.log('simple-import-test PASS');
  } catch (error) {
    console.error(output);
    throw error;
  } finally {
    spawned.cleanup();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(repoPath, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
