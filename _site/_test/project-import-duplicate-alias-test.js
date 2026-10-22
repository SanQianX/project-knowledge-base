'use strict';
// PRJ-005: importing the same repository twice is refused, and the existing
// project keeps its data.
//
// The platform contract decides what "the same repository" means: a path is
// compared after resolution, after trailing separators are stripped, and on
// Windows after lower-casing. A spelling alias of an imported path must
// therefore be refused as a duplicate as well, while a genuinely different
// repository must still import.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
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

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function makeRepo(root, name) {
  const repo = path.join(root, name);
  fs.mkdirSync(repo, { recursive: true });
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.email', 'duplicate@local.invalid']);
  git(repo, ['config', 'user.name', 'Duplicate Regression']);
  fs.writeFileSync(path.join(repo, 'README.md'), `# ${name}\n`);
  git(repo, ['add', '.']); git(repo, ['commit', '-qm', 'baseline']);
  return repo;
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

async function main() {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-prj-duplicate-'));
  const dataDir = path.join(fixture, 'data');
  const knowledgeRoot = path.join(fixture, 'knowledge');
  const repo = makeRepo(fixture, 'repo-a');
  const otherRepo = makeRepo(fixture, 'repo-b');
  const knowledge = path.join(knowledgeRoot, 'a');
  const otherKnowledge = path.join(knowledgeRoot, 'b');
  fs.mkdirSync(knowledge, { recursive: true }); fs.mkdirSync(otherKnowledge, { recursive: true });

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const server = spawnServer({ root: ROOT, port, dataDir, tag: 'project-import-duplicate' });
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

    const first = await api('POST', '/api/projects/import', { localPath: repo, knowledgePath: knowledge, displayName: '仓库 A' });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    const projectId = first.body.projectId;
    const projectDir = path.join(dataDir, 'projects', projectId);
    const configPath = path.join(projectDir, 'config.json');
    const statePath = path.join(projectDir, 'state.json');
    const configBefore = sha256(configPath);
    const stateBefore = sha256(statePath);
    const knowledgeBefore = fs.readdirSync(knowledge).sort();

    // The same path spelled exactly the same way is refused.
    const exact = await api('POST', '/api/projects/import', { localPath: repo, displayName: '重复' });
    assert.equal(exact.status, 409, 'a repeated import is refused');
    assert.equal(exact.body.error.code, 'INVALID_ARGUMENT');
    assert.match(exact.body.error.message, /already imported/i);

    // Spelling aliases of the same directory are the same path under the
    // platform contract: resolution plus trailing-separator stripping plus
    // lower-casing on Windows.
    const aliases = [
      { name: 'trailing separator', value: repo + path.sep },
      { name: 'separator variant', value: repo.replace(/\\/g, '/') },
    ];
    if (process.platform === 'win32') {
      aliases.push({ name: 'case variant', value: repo.toUpperCase() });
    }
    for (const alias of aliases) {
      const refused = await api('POST', '/api/projects/import', { localPath: alias.value, displayName: '别名' });
      assert.equal(refused.status, 409, `the ${alias.name} alias must be refused as a duplicate`);
      assert.equal(refused.body.error.code, 'INVALID_ARGUMENT');
    }

    // The refused attempts must not touch the registered project.
    assert.equal(sha256(configPath), configBefore, 'the project configuration is unchanged after the refused duplicates');
    assert.equal(sha256(statePath), stateBefore, 'the project state is unchanged after the refused duplicates');
    assert.deepEqual(fs.readdirSync(knowledge).sort(), knowledgeBefore, 'the knowledge directory is unchanged after the refused duplicates');
    const aggregated = await api('GET', '/api/projects/aggregated');
    assert.equal(aggregated.body.projects.length, 1, 'a refused duplicate must not register a second project');
    assert.equal(aggregated.body.projects[0].projectId, projectId);

    // A different repository is still importable: the refusal is about this
    // path, not about importing at all.
    const second = await api('POST', '/api/projects/import', { localPath: otherRepo, knowledgePath: otherKnowledge, displayName: '仓库 B' });
    assert.equal(second.status, 201, JSON.stringify(second.body));
    assert.notEqual(second.body.projectId, projectId);
    assert.equal((await api('GET', '/api/projects/aggregated')).body.projects.length, 2, 'a different repository registers its own project');
    console.log('project-import-duplicate-alias-test PASS (duplicate refused, alias refused by the platform path contract, existing project data intact)');
  } finally {
    await server.cleanup();
    fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
