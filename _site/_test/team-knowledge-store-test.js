const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawnServer } = require('./helpers/spawn-server');
const githubTeamStore = require('../lib/github-team-store');

const ROOT = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.KB_TEAM_KNOWLEDGE_PORT || '7837');
const BASE_URL = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), `kb-data-team-kb-${process.pid}-`));
const SOURCE_REPO = fs.mkdtempSync(path.join(os.tmpdir(), `kb-team-source-${process.pid}-`));
const TEAM_STORE = fs.mkdtempSync(path.join(os.tmpdir(), `kb-team-store-${process.pid}-`));

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function waitForServer() {
  const deadline = Date.now() + 15000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE_URL}/api/state`);
      if (res.ok) return;
      lastError = new Error(`HTTP ${res.status}`);
    } catch (e) {
      lastError = e;
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw lastError || new Error('server did not start');
}

async function json(method, url, body) {
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
  return { res, data };
}

function startMockGithub(manifest) {
  const repos = [{
    full_name: 'org/knowledge',
    name: 'knowledge',
    private: true,
    html_url: 'https://github.com/org/knowledge',
    clone_url: 'https://github.com/org/knowledge.git',
    ssh_url: 'git@github.com:org/knowledge.git',
    default_branch: 'main',
    owner: { login: 'org' },
  }];
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/login/device/code' && req.method === 'POST') {
      res.end(JSON.stringify({
        device_code: 'device-123',
        user_code: 'ABCD-1234',
        verification_uri: 'https://github.com/login/device',
        expires_in: 900,
        interval: 1,
      }));
      return;
    }
    if (req.url === '/login/oauth/access_token' && req.method === 'POST') {
      res.end(JSON.stringify({
        access_token: 'oauth-token',
        token_type: 'bearer',
        scope: 'repo,read:org',
      }));
      return;
    }
    if (req.url === '/user') {
      res.end(JSON.stringify({ login: 'alice' }));
      return;
    }
    if (req.url.startsWith('/user/repos')) {
      res.end(JSON.stringify(repos));
      return;
    }
    if (req.url.startsWith('/repos/org/knowledge/contents/.project-knowledge/team-store.json')) {
      res.end(JSON.stringify({
        type: 'file',
        encoding: 'base64',
        content: Buffer.from(JSON.stringify(manifest), 'utf-8').toString('base64'),
      }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ message: 'not found' }));
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({ server, apiBaseUrl: `http://127.0.0.1:${address.port}` });
    });
  });
}

(async () => {
  const manifest = {
    schema: 'project-knowledge/team-store/v1',
    storeId: 'team-store-sanqian',
    displayName: 'SanQian Knowledge',
    knowledgeBases: [
      { kbId: 'kb-acc', slug: 'acc', path: 'acc', displayName: 'ACC' },
      { kbId: 'kb-pro', slug: 'project-knowledge-pro', path: 'project-knowledge-pro', displayName: 'Project Knowledge Pro' },
    ],
  };
  const mock = await startMockGithub(manifest);

  fs.writeFileSync(path.join(DATA_DIR, 'projects.json'), '{}\n', 'utf-8');
  fs.writeFileSync(path.join(DATA_DIR, 'ai-profiles.json'), JSON.stringify({
    schema: 'ai-profiles/v1',
    profiles: [{
      id: 'test-profile',
      name: 'Test Profile',
      enabled: true,
      implementation: 'claude-code-agent',
      baseUrl: 'https://example.test/anthropic',
      apiKey: 'test-key',
      mainModel: 'test-model',
    }],
  }, null, 2) + '\n', 'utf-8');

  try {
    const deviceFlow = await githubTeamStore.startDeviceFlow({ clientId: 'client-id', webBaseUrl: mock.apiBaseUrl });
    assert(deviceFlow.ok && deviceFlow.userCode === 'ABCD-1234', 'mock GitHub OAuth device flow should start');
    const oauth = await githubTeamStore.pollDeviceFlow({ clientId: 'client-id', deviceCode: deviceFlow.deviceCode, webBaseUrl: mock.apiBaseUrl });
    assert(oauth.ok && oauth.token === 'oauth-token', 'mock GitHub OAuth device flow should return a token');

    const validation = await githubTeamStore.validateToken({ token: 'token', apiBaseUrl: mock.apiBaseUrl });
    assert(validation.ok && validation.login === 'alice', 'mock GitHub token should validate');
    const discovered = await githubTeamStore.discoverStores({ token: 'token', apiBaseUrl: mock.apiBaseUrl, dataDir: DATA_DIR });
    assert(discovered.ok, `store discovery should succeed: ${JSON.stringify(discovered)}`);
    assert(discovered.stores.length === 1, 'one manifest-backed store should be discovered');
    assert(discovered.stores[0].knowledgeBases.length === 2, 'manifest knowledge bases should be returned');

    fs.mkdirSync(path.join(TEAM_STORE, 'acc'), { recursive: true });
    fs.writeFileSync(path.join(TEAM_STORE, 'acc', 'README.md'), '# ACC KB\n', 'utf-8');
    fs.writeFileSync(path.join(SOURCE_REPO, 'README.md'), '# BCC source\n', 'utf-8');

    const spawned = spawnServer({
      root: ROOT,
      port: PORT,
      dataDir: DATA_DIR,
      tag: 'team-kb',
      extraEnv: { KB_AUTOMATION_FAKE_CLAUDE: '1' },
    });
    let serverOutput = '';
    spawned.child.stdout.on('data', d => { serverOutput += d.toString(); });
    spawned.child.stderr.on('data', d => { serverOutput += d.toString(); });

    try {
      await waitForServer();
      const imported = await json('POST', '/api/projects/import', {
        localPath: SOURCE_REPO,
        teamKnowledgeBase: {
          storeLocalPath: TEAM_STORE,
          storeRemoteUrl: 'https://github.com/org/knowledge.git',
          storeFullName: 'org/knowledge',
          storeId: 'team-store-sanqian',
          kbId: 'kb-acc',
          kbSlug: 'acc',
          kbSubdir: 'acc',
          displayName: 'ACC',
        },
      });
      assert(imported.res.ok, `team KB import should succeed: ${JSON.stringify(imported.data)}`);
      assert(imported.data.config.knowledgeMode === 'team', 'project should be marked as team mode');
      assert(imported.data.config.teamProvider === 'github', 'team provider should be GitHub');
      assert(imported.data.config.kbId === 'kb-acc', 'kbId should be persisted');
      assert(imported.data.config.kbSubdir === 'acc', 'kbSubdir should be persisted');
      assert(path.resolve(imported.data.config.kbPath) === path.resolve(TEAM_STORE, 'acc'), 'kbPath should point at the team subdirectory');
      assert(imported.data.initAutomation && imported.data.initAutomation.skipped === true, 'existing team KB should reconnect without init automation');

      const projects = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'projects.json'), 'utf-8'));
      const saved = projects[imported.data.slug];
      assert(saved && saved.kbStoreRemoteUrl === 'https://github.com/org/knowledge.git', 'store remote should be saved');
      console.log('team knowledge store test passed');
    } catch (e) {
      console.error('team knowledge store integration failed:', e.message);
      if (serverOutput) console.error(serverOutput);
      process.exitCode = 1;
    } finally {
      try { spawned.cleanup(); } catch {}
    }
  } catch (e) {
    console.error('team knowledge store test failed:', e.message);
    process.exitCode = 1;
  } finally {
    try { mock.server.close(); } catch {}
    try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(SOURCE_REPO, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(TEAM_STORE, { recursive: true, force: true }); } catch {}
  }
})();
