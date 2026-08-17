const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { spawnServer } = require('./helpers/spawn-server');
const githubTeamStore = require('../lib/github-team-store');

const ROOT = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.KB_TEAM_KNOWLEDGE_PORT || 7837);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), `kb-team-v2-${process.pid}-`));
const DATA_DIR = path.join(TEMP, 'data');
const SOURCE_ONE = path.join(TEMP, 'source-one');
const SOURCE_TWO = path.join(TEMP, 'source-two');
const SOURCE_BAD = path.join(TEMP, 'source-bad');
const TEAM_STORE = path.join(TEMP, 'team-store');
const TEAM_REMOTE = path.join(TEMP, 'team-remote');
const TEAM_CLONE = path.join(TEMP, 'team-clone');

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function initializeRepo(cwd, title) {
  fs.mkdirSync(cwd, { recursive: true });
  git(cwd, ['init', '--initial-branch=main']);
  git(cwd, ['config', 'user.name', 'Team Test']);
  git(cwd, ['config', 'user.email', 'team@example.test']);
  fs.writeFileSync(path.join(cwd, 'README.md'), `# ${title}\n`, 'utf8');
  git(cwd, ['add', '.']);
  git(cwd, ['commit', '-m', 'baseline']);
}

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
  let spawned;
  try {
    initializeRepo(SOURCE_ONE, 'Source one');
    initializeRepo(SOURCE_TWO, 'Source two');
    initializeRepo(SOURCE_BAD, 'Source bad');
    initializeRepo(TEAM_STORE, 'Team store');
    fs.mkdirSync(path.join(TEAM_STORE, 'acc'), { recursive: true });
    fs.writeFileSync(path.join(TEAM_STORE, 'acc', 'README.md'), '# ACC shared knowledge\n', 'utf8');
    git(TEAM_STORE, ['add', '.']);
    git(TEAM_STORE, ['commit', '-m', 'add team knowledge']);
    git(TEAM_STORE, ['remote', 'add', 'origin', TEAM_STORE]);

    initializeRepo(TEAM_REMOTE, 'Remote team store');
    fs.mkdirSync(path.join(TEAM_REMOTE, 'acc'), { recursive: true });
    fs.writeFileSync(path.join(TEAM_REMOTE, 'acc', 'README.md'), '# ACC from remote\n', 'utf8');
    git(TEAM_REMOTE, ['add', '.']);
    git(TEAM_REMOTE, ['commit', '-m', 'add remote knowledge']);

    const providerConfigPath = path.join(TEMP, 'providers.json');
    fs.writeFileSync(providerConfigPath, `\uFEFF${JSON.stringify({ gitea: { webBaseUrl: 'https://gitea.example.test', oauthClientId: 'client', oauthClientSecret: 'secret' } })}`, 'utf8');
    const providerFile = githubTeamStore.readProviderFileConfig(providerConfigPath);
    const publicProviders = githubTeamStore.providerPublicConfig(githubTeamStore.defaultConfig(), {}, providerFile);
    assert.strictEqual(publicProviders.gitea.configured, true);
    assert.strictEqual(publicProviders.gitea.oauthClientSecret, undefined);
    assert.strictEqual(publicProviders.gitea.oauthClientSecretConfigured, true);
    assert.strictEqual(githubTeamStore.proxyUrlForTarget('http://127.0.0.1:3000/api/v1/user', { KB_GIT_PROXY: 'http://127.0.0.1:7890' }), '');

    const scanned = await githubTeamStore.scanLocalStore({ localPath: TEAM_STORE });
    assert(scanned.ok && scanned.store.knowledgeBases.some(item => item.path === 'acc'), JSON.stringify(scanned));
    const checkedOut = await githubTeamStore.checkoutStore({ cloneUrl: TEAM_REMOTE, branch: 'main', localPath: TEAM_CLONE });
    assert(checkedOut.ok, JSON.stringify(checkedOut));
    assert.match(fs.readFileSync(path.join(TEAM_CLONE, 'acc', 'README.md'), 'utf8'), /from remote/);

    spawned = spawnServer({ root: ROOT, port: PORT, dataDir: DATA_DIR, tag: 'team-kb-v2' });
    let output = '';
    spawned.child.stdout.on('data', chunk => { output += chunk; });
    spawned.child.stderr.on('data', chunk => { output += chunk; });
    await waitForServer();
    let result = await json('PATCH', '/api/settings', { knowledge: { rootPath: path.join(TEMP, 'personal-knowledge') } });
    assert(result.response.ok, JSON.stringify(result.body));

    result = await json('POST', '/api/projects/import', {
      projectId: 'team-project-one', localPath: SOURCE_ONE,
      teamKnowledgeBase: {
        storeLocalPath: TEAM_STORE, storeRemoteUrl: 'https://github.com/org/knowledge.git',
        storeFullName: 'org/knowledge', storeId: 'team-store', kbId: 'kb-acc', kbSlug: 'acc', kbSubdir: 'acc', displayName: 'ACC',
      },
    });
    assert.strictEqual(result.response.status, 201, `${JSON.stringify(result.body)}\n${output}`);
    assert.strictEqual(path.resolve(result.body.config.knowledgePath), path.resolve(TEAM_STORE, 'acc'));
    assert.strictEqual(result.body.config.teamBinding.provider, 'github');
    assert.strictEqual(result.body.config.teamBinding.kbId, 'kb-acc');
    assert.strictEqual(result.body.config.teamBinding.kbSubdir, 'acc');
    const registryText = fs.readFileSync(path.join(DATA_DIR, 'projects.json'), 'utf8');
    assert(!registryText.includes(TEAM_STORE), 'minimal v2 registry must not contain the external team path');

    result = await json('POST', '/api/projects/import', {
      projectId: 'team-project-bad', localPath: SOURCE_BAD,
      teamKnowledgeBase: { storeLocalPath: TEAM_STORE, kbSubdir: '../escape' },
    });
    assert.strictEqual(result.response.status, 403, 'team binding traversal must be rejected');

    result = await json('POST', '/api/projects/import', {
      projectId: 'team-project-two', localPath: SOURCE_TWO,
      teamKnowledgeBase: { storeLocalPath: TEAM_CLONE, storeRemoteUrl: TEAM_REMOTE, storeId: 'clone', kbId: 'kb-acc', kbSubdir: 'acc' },
    });
    assert.strictEqual(result.response.status, 201, JSON.stringify(result.body));
    assert.strictEqual(path.resolve(result.body.config.knowledgePath), path.resolve(TEAM_CLONE, 'acc'));

    result = await json('DELETE', '/api/projects/team-project-one', { deleteKnowledge: true, confirmationToken: 'team-project-one' });
    assert(result.response.ok, JSON.stringify(result.body));
    assert.strictEqual(result.body.removedKnowledge, false, 'team knowledge is externally owned');
    assert(fs.existsSync(path.join(TEAM_STORE, 'acc', 'README.md')), 'team knowledge must survive project deletion');
    console.log('team knowledge store test passed');
  } finally {
    if (spawned) spawned.child.kill();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
