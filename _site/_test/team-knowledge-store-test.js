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

function startMockGitea(manifest) {
  const repos = [{
    full_name: 'team/knowledge',
    name: 'knowledge',
    private: true,
    html_url: 'http://gitea.local/team/knowledge',
    clone_url: 'http://gitea.local/team/knowledge.git',
    ssh_url: 'git@gitea.local:team/knowledge.git',
    default_branch: 'main',
    owner: { login: 'team' },
  }];
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/login/oauth/access_token' && req.method === 'POST') {
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        const form = new URLSearchParams(Buffer.concat(chunks).toString('utf-8'));
        if (form.get('client_secret') !== 'secret-from-bom-file') {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: 'invalid_client', error_description: 'invalid empty client secret' }));
          return;
        }
        res.end(JSON.stringify({
          access_token: 'gitea-oauth-token',
          token_type: 'bearer',
          scope: 'read:repository',
        }));
      });
      return;
    }
    if (req.url === '/api/v1/user') {
      res.end(JSON.stringify({ login: 'alice' }));
      return;
    }
    if (req.url.startsWith('/api/v1/user/repos')) {
      res.end(JSON.stringify(repos));
      return;
    }
    if (req.url.startsWith('/api/v1/repos/team/knowledge/contents/.project-knowledge/team-store.json')) {
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
      resolve({ server, webBaseUrl: `http://127.0.0.1:${address.port}`, apiBaseUrl: `http://127.0.0.1:${address.port}/api/v1` });
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
  const giteaMock = await startMockGitea(manifest);
  const providerConfigPath = path.join(DATA_DIR, 'team-git-providers.json');
  fs.writeFileSync(providerConfigPath, '\uFEFF' + JSON.stringify({
    schema: 'project-knowledge/git-providers/v1',
    gitea: {
      webBaseUrl: 'http://gitea.example.test:3000',
      oauthClientId: 'client-from-bom-file',
      oauthClientSecret: 'secret-from-bom-file',
    },
  }, null, 2), 'utf-8');
  const providerConfig = githubTeamStore.readProviderFileConfig(providerConfigPath);
  assert(providerConfig.gitea.oauthClientSecret === 'secret-from-bom-file', 'BOM-prefixed provider config should read the Gitea client secret');
  const providerPublic = githubTeamStore.providerPublicConfig(githubTeamStore.defaultConfig(), {}, providerConfig);
  assert(providerPublic.gitea.configured === true, 'BOM-prefixed provider config should configure Gitea');
  assert(providerPublic.gitea.apiBaseUrl === 'http://gitea.example.test:3000/api/v1', 'Gitea API URL should be inferred from BOM config');
  assert(providerPublic.gitea.oauthClientSecret === undefined, 'Gitea client secret should not be exposed in public provider config');
  assert(providerPublic.gitea.oauthClientSecretConfigured === true, 'Gitea public config should expose only whether a client secret exists');

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

    const giteaValidation = await githubTeamStore.validateToken({ token: 'gitea-token', apiBaseUrl: giteaMock.apiBaseUrl, provider: 'gitea' });
    assert(giteaValidation.ok && giteaValidation.login === 'alice', 'mock Gitea token should validate');
    const giteaOAuth = await githubTeamStore.exchangeGiteaOAuthCode({
      config: {
        provider: 'gitea',
        oauthWebBaseUrl: giteaMock.webBaseUrl,
        oauthClientId: 'client-from-bom-file',
        oauthClientSecret: 'secret-from-bom-file',
      },
      code: 'oauth-code',
      codeVerifier: 'verifier',
      redirectUri: 'http://127.0.0.1:5757/api/team/gitea/oauth/callback',
    });
    assert(giteaOAuth.ok && giteaOAuth.token === 'gitea-oauth-token', 'Gitea OAuth exchange should include the configured client secret');
    const giteaDiscovered = await githubTeamStore.discoverStores({ token: 'gitea-token', apiBaseUrl: giteaMock.apiBaseUrl, provider: 'gitea', dataDir: DATA_DIR });
    assert(giteaDiscovered.ok, `Gitea store discovery should succeed: ${JSON.stringify(giteaDiscovered)}`);
    assert(giteaDiscovered.stores.length === 1, 'Gitea discovery should find one manifest-backed store');
    assert(giteaDiscovered.stores[0].provider === 'gitea', 'Gitea discovery should preserve provider');
    assert(giteaDiscovered.stores[0].knowledgeBases.length === 2, 'Gitea manifest knowledge bases should be returned');

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
      const status = await json('GET', '/api/team/github/status');
      assert(status.res.ok, `team status should succeed: ${JSON.stringify(status.data)}`);
      const expectedGiteaRedirect = `${BASE_URL}/api/team/gitea/oauth/callback`;
      assert(status.data.providers.gitea.oauthRedirectUri === expectedGiteaRedirect, 'Gitea status should expose the stable OAuth redirect URI');

      const giteaStart = await json('POST', '/api/team/gitea/oauth/start', {});
      assert(giteaStart.res.ok, `Gitea OAuth start should succeed: ${JSON.stringify(giteaStart.data)}`);
      assert(giteaStart.data.redirectUri === expectedGiteaRedirect, 'Gitea OAuth start should use the stable redirect URI');
      const authUrl = new URL(giteaStart.data.authorizationUrl);
      assert(authUrl.searchParams.get('redirect_uri') === expectedGiteaRedirect, 'Gitea authorization URL should include the stable redirect URI');

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
    try { giteaMock.server.close(); } catch {}
    try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(SOURCE_REPO, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(TEAM_STORE, { recursive: true, force: true }); } catch {}
  }
})();
