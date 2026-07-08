const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { URL } = require('url');
const { execGit, getGitVersion } = require('./git-runner');

const SCHEMA = 'github-team/v1';
const STORE_SCHEMA = 'project-knowledge/team-store/v1';
const DEFAULT_API_BASE_URL = 'https://api.github.com';
const DEFAULT_WEB_BASE_URL = 'https://github.com';
const DEFAULT_OAUTH_CLIENT_ID = 'Ov23linBbfigq8AyCgxH';
const PROVIDER_CONFIG_SCHEMA = 'project-knowledge/git-providers/v1';
const DEFAULT_GITEA_WEB_BASE_URL = '';
const DEFAULT_GITEA_OAUTH_CLIENT_ID = '';
const MANIFEST_PATHS = [
  '.project-knowledge/team-store.json',
  'project-knowledge-store.json',
  'team-store.json',
];

function defaultConfig() {
  return {
    schema: SCHEMA,
    provider: 'github',
    apiBaseUrl: DEFAULT_API_BASE_URL,
    oauthWebBaseUrl: DEFAULT_WEB_BASE_URL,
    oauthClientId: '',
    token: '',
    login: '',
    updatedAt: null,
  };
}

function normalizeBaseUrl(value, fallback) {
  return String(value || fallback || '').trim().replace(/\/+$/, '');
}

function isDefaultGithubWebBaseUrl(value) {
  return normalizeBaseUrl(value, DEFAULT_WEB_BASE_URL).toLowerCase() === DEFAULT_WEB_BASE_URL;
}

function normalizeProvider(value) {
  return String(value || '').trim().toLowerCase() === 'gitea' ? 'gitea' : 'github';
}

function inferApiBaseUrlFromWebBaseUrl(webBaseUrl, provider = 'github') {
  const web = normalizeBaseUrl(webBaseUrl, DEFAULT_WEB_BASE_URL);
  if (normalizeProvider(provider) === 'gitea') return `${web}/api/v1`;
  if (isDefaultGithubWebBaseUrl(web)) return DEFAULT_API_BASE_URL;
  return `${web}/api/v3`;
}

function inferWebBaseUrlFromApiBaseUrl(apiBaseUrl, provider = 'github') {
  const api = normalizeBaseUrl(apiBaseUrl, DEFAULT_API_BASE_URL);
  if (api.toLowerCase() === DEFAULT_API_BASE_URL) return DEFAULT_WEB_BASE_URL;
  if (normalizeProvider(provider) === 'gitea') return api.replace(/\/api\/v1$/i, '');
  return api.replace(/\/api\/v3$/i, '');
}

function normalizeConfig(input) {
  const source = input && typeof input === 'object' ? input : {};
  const provider = normalizeProvider(source.provider);
  const defaultWebBaseUrl = provider === 'gitea' ? DEFAULT_GITEA_WEB_BASE_URL : DEFAULT_WEB_BASE_URL;
  const defaultApiBaseUrl = provider === 'gitea'
    ? (defaultWebBaseUrl ? inferApiBaseUrlFromWebBaseUrl(defaultWebBaseUrl, 'gitea') : '')
    : DEFAULT_API_BASE_URL;
  const rawWebBaseUrl = typeof source.oauthWebBaseUrl === 'string' && source.oauthWebBaseUrl.trim()
    ? normalizeBaseUrl(source.oauthWebBaseUrl, defaultWebBaseUrl)
    : '';
  const apiBaseUrl = typeof source.apiBaseUrl === 'string' && source.apiBaseUrl.trim()
    ? normalizeBaseUrl(source.apiBaseUrl, defaultApiBaseUrl)
    : (rawWebBaseUrl ? inferApiBaseUrlFromWebBaseUrl(rawWebBaseUrl, provider) : defaultApiBaseUrl);
  const oauthWebBaseUrl = rawWebBaseUrl
    ? rawWebBaseUrl
    : (apiBaseUrl ? inferWebBaseUrlFromApiBaseUrl(apiBaseUrl, provider) : defaultWebBaseUrl);
  return {
    schema: SCHEMA,
    provider,
    apiBaseUrl,
    oauthWebBaseUrl,
    oauthClientId: typeof source.oauthClientId === 'string' ? source.oauthClientId.trim() : '',
    oauthClientSecret: typeof source.oauthClientSecret === 'string' ? source.oauthClientSecret.trim() : '',
    token: typeof source.token === 'string' ? source.token.trim() : '',
    login: typeof source.login === 'string' ? source.login : '',
    updatedAt: typeof source.updatedAt === 'string' ? source.updatedAt : null,
  };
}

function normalizeProviderFileConfig(input) {
  const source = input && typeof input === 'object' ? input : {};
  const gitea = source.gitea && typeof source.gitea === 'object' ? source.gitea : {};
  const giteaWebBaseUrl = normalizeBaseUrl(gitea.webBaseUrl || gitea.oauthWebBaseUrl || source.giteaWebBaseUrl || '', '');
  return {
    schema: PROVIDER_CONFIG_SCHEMA,
    gitea: {
      webBaseUrl: giteaWebBaseUrl,
      apiBaseUrl: normalizeBaseUrl(gitea.apiBaseUrl || source.giteaApiBaseUrl || (giteaWebBaseUrl ? inferApiBaseUrlFromWebBaseUrl(giteaWebBaseUrl, 'gitea') : ''), ''),
      oauthClientId: String(gitea.oauthClientId || gitea.clientId || source.giteaOAuthClientId || '').trim(),
      oauthClientSecret: String(gitea.oauthClientSecret || gitea.clientSecret || source.giteaOAuthClientSecret || '').trim(),
    },
  };
}

function parseJsonText(text) {
  return JSON.parse(String(text || '').replace(/^\uFEFF/, ''));
}

function readJsonFile(filePath) {
  return parseJsonText(fs.readFileSync(filePath, 'utf-8'));
}

function readProviderFileConfig(configPath) {
  if (!configPath || !fs.existsSync(configPath)) return normalizeProviderFileConfig({});
  try {
    return normalizeProviderFileConfig(readJsonFile(configPath));
  } catch {
    return normalizeProviderFileConfig({});
  }
}

function readConfig(configPath) {
  if (!fs.existsSync(configPath)) return defaultConfig();
  try {
    return normalizeConfig(readJsonFile(configPath));
  } catch {
    return defaultConfig();
  }
}

function writeConfig(configPath, config) {
  const normalized = normalizeConfig({
    ...(config || {}),
    updatedAt: new Date().toISOString(),
  });
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(normalized, null, 2) + '\n', 'utf-8');
  return normalized;
}

function publicConfig(config) {
  const cfg = normalizeConfig(config);
  return {
    schema: SCHEMA,
    provider: cfg.provider,
    apiBaseUrl: cfg.apiBaseUrl,
    oauthWebBaseUrl: cfg.oauthWebBaseUrl,
    oauthClientId: cfg.oauthClientId,
    configured: !!cfg.token,
    login: cfg.login || '',
    updatedAt: cfg.updatedAt,
  };
}

function authHeaderForProvider(provider, token) {
  if (!token) return {};
  return normalizeProvider(provider) === 'gitea'
    ? { Authorization: `token ${token}` }
    : { Authorization: `Bearer ${token}` };
}

function requestJson({ method = 'GET', url, token = '', provider = 'github', body = null, headers = {}, timeoutMs = 20000 }) {
  return new Promise((resolve) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (e) {
      resolve({ ok: false, status: 400, error: e.message, data: null, headers: {} });
      return;
    }
    const transport = parsed.protocol === 'http:' ? http : https;
    const payload = body == null ? null : Buffer.from(JSON.stringify(body));
    const req = transport.request({
      method,
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port,
      path: `${parsed.pathname}${parsed.search}`,
      timeout: timeoutMs,
      headers: {
        'User-Agent': 'project-knowledge',
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...authHeaderForProvider(provider, token),
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
        ...headers,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf-8');
        let data = null;
        if (text.trim()) {
          try { data = JSON.parse(text); } catch { data = { raw: text }; }
        }
        const ok = res.statusCode >= 200 && res.statusCode < 300;
        resolve({
          ok,
          status: res.statusCode,
          data,
          headers: res.headers || {},
          error: ok ? null : ((data && (data.message || data.error)) || text || `HTTP ${res.statusCode}`),
        });
      });
    });
    req.on('timeout', () => {
      req.destroy(new Error(`request timed out after ${timeoutMs}ms`));
    });
    req.on('error', e => resolve({ ok: false, status: 0, error: e.message, data: null, headers: {} }));
    if (payload) req.write(payload);
    req.end();
  });
}

function requestFormJson({ method = 'POST', url, form = {}, headers = {}, timeoutMs = 20000 }) {
  return new Promise((resolve) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (e) {
      resolve({ ok: false, status: 400, error: e.message, data: null, headers: {} });
      return;
    }
    const transport = parsed.protocol === 'http:' ? http : https;
    const payload = Buffer.from(new URLSearchParams(form).toString());
    const req = transport.request({
      method,
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port,
      path: `${parsed.pathname}${parsed.search}`,
      timeout: timeoutMs,
      headers: {
        'User-Agent': 'project-knowledge',
        'Accept': 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': payload.length,
        ...headers,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf-8');
        let data = null;
        if (text.trim()) {
          try { data = JSON.parse(text); } catch { data = { raw: text }; }
        }
        const ok = res.statusCode >= 200 && res.statusCode < 300;
        resolve({
          ok,
          status: res.statusCode,
          data,
          headers: res.headers || {},
          error: ok ? null : ((data && (data.error_description || data.message || data.error)) || text || `HTTP ${res.statusCode}`),
        });
      });
    });
    req.on('timeout', () => {
      req.destroy(new Error(`request timed out after ${timeoutMs}ms`));
    });
    req.on('error', e => resolve({ ok: false, status: 0, error: e.message, data: null, headers: {} }));
    req.write(payload);
    req.end();
  });
}

function apiUrl(apiBaseUrl, pathname, query = {}) {
  const base = normalizeConfig({ apiBaseUrl }).apiBaseUrl;
  const url = new URL(base.endsWith('/') ? base : `${base}/`);
  const basePath = url.pathname.replace(/\/+$/, '');
  const relPath = String(pathname || '').replace(/^\/+/, '');
  url.pathname = `${basePath}/${relPath}`.replace(/\/{2,}/g, '/');
  for (const [key, value] of Object.entries(query || {})) {
    if (value != null && value !== '') url.searchParams.set(key, String(value));
  }
  return url.toString();
}

function webUrl(webBaseUrl, pathname) {
  const base = typeof webBaseUrl === 'string' && webBaseUrl.trim()
    ? webBaseUrl.trim().replace(/\/+$/, '')
    : DEFAULT_WEB_BASE_URL;
  return new URL(pathname.replace(/^\/?/, '/'), base).toString();
}

function oauthClientIdFromEnv(env = process.env) {
  return String(env.KB_GITHUB_OAUTH_CLIENT_ID || env.GITHUB_OAUTH_CLIENT_ID || DEFAULT_OAUTH_CLIENT_ID).trim();
}

function oauthClientIdForConfig(config, env = process.env) {
  const cfg = normalizeConfig(config);
  if (cfg.provider === 'gitea') {
    return cfg.oauthClientId || String(env.KB_GITEA_OAUTH_CLIENT_ID || env.GITEA_OAUTH_CLIENT_ID || '').trim();
  }
  if (cfg.oauthClientId) return cfg.oauthClientId;
  const envClientId = String(env.KB_GITHUB_OAUTH_CLIENT_ID || env.GITHUB_OAUTH_CLIENT_ID || '').trim();
  if (envClientId) return envClientId;
  return isDefaultGithubWebBaseUrl(cfg.oauthWebBaseUrl) ? DEFAULT_OAUTH_CLIENT_ID : '';
}

function oauthClientSecretForConfig(config, env = process.env) {
  const cfg = normalizeConfig(config);
  if (cfg.provider !== 'gitea') return '';
  return cfg.oauthClientSecret || String(env.KB_GITEA_OAUTH_CLIENT_SECRET || env.GITEA_OAUTH_CLIENT_SECRET || '').trim();
}

function giteaWebBaseUrlFromEnv(env = process.env) {
  return String(env.KB_GITEA_WEB_BASE_URL || env.GITEA_WEB_BASE_URL || '').trim().replace(/\/+$/, '');
}

function giteaPresetFromEnv(env = process.env, providerFileConfig = {}) {
  const fileConfig = normalizeProviderFileConfig(providerFileConfig);
  const webBaseUrl = giteaWebBaseUrlFromEnv(env) || fileConfig.gitea.webBaseUrl;
  const oauthClientId = String(env.KB_GITEA_OAUTH_CLIENT_ID || env.GITEA_OAUTH_CLIENT_ID || fileConfig.gitea.oauthClientId || '').trim();
  const oauthClientSecret = String(env.KB_GITEA_OAUTH_CLIENT_SECRET || env.GITEA_OAUTH_CLIENT_SECRET || fileConfig.gitea.oauthClientSecret || '').trim();
  const apiBaseUrl = String(env.KB_GITEA_API_BASE_URL || env.GITEA_API_BASE_URL || fileConfig.gitea.apiBaseUrl || '').trim().replace(/\/+$/, '');
  return {
    provider: 'gitea',
    configured: !!(webBaseUrl && oauthClientId),
    webBaseUrl,
    apiBaseUrl: apiBaseUrl || (webBaseUrl ? inferApiBaseUrlFromWebBaseUrl(webBaseUrl, 'gitea') : ''),
    oauthClientId,
    oauthClientSecret,
    oauthClientSecretConfigured: !!oauthClientSecret,
  };
}

function base64Url(buffer) {
  return Buffer.from(buffer)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function randomOAuthString(byteLength = 32) {
  return base64Url(crypto.randomBytes(byteLength));
}

function codeChallengeForVerifier(verifier) {
  return base64Url(crypto.createHash('sha256').update(verifier).digest());
}

function buildAuthorizationUrl({ webBaseUrl, clientId, redirectUri, state, codeChallenge, scope = 'read:repository' }) {
  const url = new URL(webUrl(webBaseUrl, '/login/oauth/authorize'));
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  if (scope) url.searchParams.set('scope', scope);
  return url.toString();
}

function startGiteaOAuth({ config, redirectUri, scope = 'read:repository', env = process.env }) {
  const cfg = normalizeConfig({ ...config, provider: 'gitea' });
  const clientId = oauthClientIdForConfig(cfg, env);
  if (!cfg.oauthWebBaseUrl) return { ok: false, status: 400, error: 'Gitea URL is required' };
  if (!clientId) return { ok: false, status: 501, code: 'oauth_client_missing', error: 'Gitea OAuth Client ID is not configured' };
  const verifier = randomOAuthString(48);
  const state = randomOAuthString(32);
  const authorizationUrl = buildAuthorizationUrl({
    webBaseUrl: cfg.oauthWebBaseUrl,
    clientId,
    redirectUri,
    state,
    codeChallenge: codeChallengeForVerifier(verifier),
    scope,
  });
  return { ok: true, provider: 'gitea', authorizationUrl, state, codeVerifier: verifier, redirectUri, clientId };
}

async function exchangeGiteaOAuthCode({ config, code, codeVerifier, redirectUri, env = process.env }) {
  const cfg = normalizeConfig({ ...config, provider: 'gitea' });
  const clientId = oauthClientIdForConfig(cfg, env);
  const clientSecret = oauthClientSecretForConfig(cfg, env);
  if (!clientId) return { ok: false, status: 501, code: 'oauth_client_missing', error: 'Gitea OAuth Client ID is not configured' };
  const form = {
    client_id: clientId,
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
  };
  if (clientSecret) form.client_secret = clientSecret;
  const result = await requestFormJson({
    url: webUrl(cfg.oauthWebBaseUrl, '/login/oauth/access_token'),
    form,
  });
  if (!result.ok) return { ok: false, status: result.status || 400, error: result.error || 'Gitea OAuth token exchange failed', data: result.data };
  const data = result.data || {};
  if (!data.access_token) return { ok: false, status: 502, error: 'Gitea OAuth response did not include an access token', data };
  return {
    ok: true,
    token: data.access_token,
    tokenType: data.token_type || 'bearer',
    scope: data.scope || '',
  };
}

function oauthWebBaseUrlFromEnv(env = process.env) {
  return String(env.KB_GITHUB_OAUTH_WEB_BASE_URL || env.GITHUB_OAUTH_WEB_BASE_URL || DEFAULT_WEB_BASE_URL).trim().replace(/\/+$/, '') || DEFAULT_WEB_BASE_URL;
}

function oauthPublicConfig(configOrEnv = process.env, maybeEnv = process.env) {
  const looksLikeConfig = configOrEnv && typeof configOrEnv === 'object'
    && (Object.prototype.hasOwnProperty.call(configOrEnv, 'apiBaseUrl') || Object.prototype.hasOwnProperty.call(configOrEnv, 'oauthWebBaseUrl'));
  const cfg = looksLikeConfig ? normalizeConfig(configOrEnv) : normalizeConfig({});
  const env = looksLikeConfig ? maybeEnv : configOrEnv;
  const webBaseUrl = looksLikeConfig ? cfg.oauthWebBaseUrl : oauthWebBaseUrlFromEnv(env);
  const clientId = looksLikeConfig ? oauthClientIdForConfig(cfg, env) : oauthClientIdFromEnv(env);
  return {
    available: !!clientId,
    webBaseUrl,
    clientIdConfigured: !!clientId,
  };
}

function providerPublicConfig(config, env = process.env, providerFileConfig = {}) {
  const cfg = normalizeConfig(config);
  const giteaPreset = giteaPresetFromEnv(env, providerFileConfig);
  return {
    current: cfg.provider,
    github: {
      provider: 'github',
      available: !!oauthClientIdForConfig({ ...cfg, provider: 'github' }, env),
      webBaseUrl: cfg.provider === 'github' ? cfg.oauthWebBaseUrl : DEFAULT_WEB_BASE_URL,
    },
    gitea: {
      provider: giteaPreset.provider,
      configured: giteaPreset.configured,
      webBaseUrl: giteaPreset.webBaseUrl,
      apiBaseUrl: giteaPreset.apiBaseUrl,
      oauthClientId: giteaPreset.oauthClientId,
      oauthClientSecretConfigured: giteaPreset.oauthClientSecretConfigured,
    },
  };
}

async function validateToken({ token, apiBaseUrl = DEFAULT_API_BASE_URL, provider = 'github' }) {
  if (!token || typeof token !== 'string') return { ok: false, status: 400, error: 'Git token is required' };
  const result = await requestJson({ url: apiUrl(apiBaseUrl, '/user'), token, provider });
  if (!result.ok) return { ok: false, status: result.status || 400, error: result.error || 'Git token validation failed' };
  return {
    ok: true,
    user: result.data,
    login: result.data && result.data.login || '',
  };
}

async function startDeviceFlow({ clientId, scope = 'repo read:org', webBaseUrl = DEFAULT_WEB_BASE_URL }) {
  const id = String(clientId || '').trim();
  if (!id) return { ok: false, status: 501, code: 'oauth_client_missing', error: 'GitHub OAuth client is not configured' };
  const result = await requestFormJson({
    url: webUrl(webBaseUrl, '/login/device/code'),
    form: { client_id: id, scope },
  });
  if (!result.ok) return { ok: false, status: result.status || 400, error: result.error || 'GitHub device flow failed' };
  const data = result.data || {};
  if (!data.device_code || !data.user_code || !data.verification_uri) {
    return { ok: false, status: 502, error: 'GitHub device flow response was incomplete', data };
  }
  return {
    ok: true,
    deviceCode: data.device_code,
    userCode: data.user_code,
    verificationUri: data.verification_uri,
    expiresIn: Number(data.expires_in || 900),
    interval: Number(data.interval || 5),
  };
}

async function pollDeviceFlow({ clientId, deviceCode, webBaseUrl = DEFAULT_WEB_BASE_URL }) {
  const id = String(clientId || '').trim();
  if (!id) return { ok: false, status: 501, code: 'oauth_client_missing', error: 'GitHub OAuth client is not configured' };
  const code = String(deviceCode || '').trim();
  if (!code) return { ok: false, status: 400, error: 'deviceCode is required' };
  const result = await requestFormJson({
    url: webUrl(webBaseUrl, '/login/oauth/access_token'),
    form: {
      client_id: id,
      device_code: code,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    },
  });
  const data = result.data || {};
  if (data.error === 'authorization_pending') return { ok: true, pending: true, interval: 5 };
  if (data.error === 'slow_down') return { ok: true, pending: true, interval: 10 };
  if (data.error) {
    return {
      ok: false,
      status: data.error === 'expired_token' ? 410 : 400,
      code: data.error,
      error: data.error_description || data.error,
    };
  }
  if (!result.ok) return { ok: false, status: result.status || 400, error: result.error || 'GitHub OAuth polling failed' };
  if (!data.access_token) return { ok: false, status: 502, error: 'GitHub OAuth response did not include an access token', data };
  return {
    ok: true,
    pending: false,
    token: data.access_token,
    tokenType: data.token_type || 'bearer',
    scope: data.scope || '',
  };
}

function decodeContentResponse(data) {
  if (!data || typeof data !== 'object') return null;
  if (data.type === 'file' && typeof data.content === 'string') {
    const encoding = String(data.encoding || '').toLowerCase();
    if (encoding === 'base64') {
      return Buffer.from(data.content.replace(/\s/g, ''), 'base64').toString('utf-8');
    }
    return data.content;
  }
  return null;
}

function normalizeKbPath(value) {
  const raw = String(value || '').trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!raw || raw.includes('..') || path.isAbsolute(raw)) return '';
  return raw;
}

function normalizeStoreSlug(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\.git$/i, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
}

function parseGithubFullName(remoteUrl) {
  const raw = String(remoteUrl || '').trim();
  if (!raw) return '';
  const httpsMatch = raw.match(/^https?:\/\/[^/]+\/([^/]+)\/([^/#?]+?)(?:\.git)?(?:[#?].*)?$/i);
  if (httpsMatch) return `${httpsMatch[1]}/${httpsMatch[2].replace(/\.git$/i, '')}`;
  const sshMatch = raw.match(/^[^@]+@[^:]+:([^/]+)\/([^/#?]+?)(?:\.git)?$/i);
  if (sshMatch) return `${sshMatch[1]}/${sshMatch[2].replace(/\.git$/i, '')}`;
  return '';
}

function inferProviderFromRemoteUrl(remoteUrl, fallback = '') {
  const preferred = String(fallback || '').trim();
  if (preferred) return normalizeProvider(preferred);
  const raw = String(remoteUrl || '').trim();
  if (/github/i.test(raw)) return 'github';
  if (/gitea/i.test(raw)) return 'gitea';
  return 'github';
}

function buildLocalRepoMeta(root, remoteUrl, branch, provider = '') {
  const fullName = parseGithubFullName(remoteUrl);
  const repoName = fullName ? fullName.split('/').pop() : path.basename(root);
  const storeId = fullName || normalizeStoreSlug(repoName) || 'knowledge-store';
  return {
    provider: inferProviderFromRemoteUrl(remoteUrl, provider),
    fullName,
    name: repoName,
    owner: fullName ? fullName.split('/')[0] : '',
    cloneUrl: remoteUrl || '',
    defaultBranch: branch || 'main',
    storeId,
    displayName: fullName || repoName || storeId,
  };
}

function looksLikeKnowledgeBase(dirPath) {
  return [
    'README.md',
    'GOAL.md',
    'ARCHITECTURE.md',
    path.join('modules', '00-index.md'),
    path.join('changes', '00-index.md'),
  ].some(rel => fs.existsSync(path.join(dirPath, rel)));
}

function scanKnowledgeBaseDirs(root, storeId) {
  const entries = fs.readdirSync(root, { withFileTypes: true });
  const dirs = entries
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .filter(name => !name.startsWith('.') && !['node_modules', '_ai'].includes(name))
    .sort((a, b) => a.localeCompare(b));
  const detected = dirs.filter(name => looksLikeKnowledgeBase(path.join(root, name)));
  const selected = detected.length ? detected : dirs;
  return selected.map((name) => {
    const slug = normalizeKbPath(name);
    return {
      kbId: `${storeId}:${slug}`,
      slug,
      path: slug,
      displayName: name,
    };
  }).filter(item => item.slug);
}

async function inspectLocalStore(localPath, provider = '') {
  const rawPath = String(localPath || '').trim();
  if (!rawPath) return { ok: false, status: 400, error: 'localPath is required' };
  const inputPath = path.resolve(rawPath);
  if (!fs.existsSync(inputPath) || !fs.statSync(inputPath).isDirectory()) {
    return { ok: false, status: 400, error: 'localPath must be an existing directory' };
  }
  const inside = await execGit(inputPath, ['rev-parse', '--is-inside-work-tree']);
  if (!inside.ok || String(inside.stdout).trim() !== 'true') {
    return { ok: false, status: 400, error: `localPath is not a git repository: ${inputPath}` };
  }
  const topLevel = await execGit(inputPath, ['rev-parse', '--show-toplevel']);
  if (!topLevel.ok) return { ok: false, status: 500, error: topLevel.stderr || topLevel.error || 'git rev-parse failed' };
  const root = path.resolve(String(topLevel.stdout || inputPath).trim());
  const remote = await execGit(root, ['remote', 'get-url', 'origin']);
  const remoteUrl = remote.ok ? String(remote.stdout || '').trim() : '';
  if (!remoteUrl) return { ok: false, status: 400, error: 'Git remote "origin" is required for a team knowledge store' };
  const branchResult = await execGit(root, ['branch', '--show-current']);
  const branch = branchResult.ok && String(branchResult.stdout || '').trim() || 'main';
  const status = await execGit(root, ['status', '--porcelain'], 15000);
  const meta = buildLocalRepoMeta(root, remoteUrl, branch, provider);
  return {
    ok: true,
    localPath: root,
    remoteUrl,
    branch,
    dirty: status.ok ? !!String(status.stdout || '').trim() : null,
    statusText: status.ok ? String(status.stdout || '') : '',
    ...meta,
  };
}

async function scanLocalStore({ localPath, provider = '' }) {
  const inspection = await inspectLocalStore(localPath, provider);
  if (!inspection.ok) return inspection;
  const knowledgeBases = scanKnowledgeBaseDirs(inspection.localPath, inspection.storeId);
  const manifest = normalizeManifest({
    schema: STORE_SCHEMA,
    storeId: inspection.storeId,
    displayName: inspection.displayName,
    knowledgeBases,
  }, { full_name: inspection.fullName || inspection.storeId });
  return {
    ok: true,
    store: {
      provider: inspection.provider,
      fullName: inspection.fullName,
      name: inspection.name,
      owner: inspection.owner,
      cloneUrl: inspection.cloneUrl,
      defaultBranch: inspection.defaultBranch,
      localPath: inspection.localPath,
      remoteUrl: inspection.remoteUrl,
      branch: inspection.branch,
      dirty: inspection.dirty,
      manifestPath: MANIFEST_PATHS[0],
      ...manifest,
    },
  };
}

function normalizeKnowledgeBaseInput(items, storeId) {
  const source = Array.isArray(items) ? items : [];
  return source.map((item) => {
    const kb = item && typeof item === 'object' ? item : {};
    const kbPath = normalizeKbPath(kb.path || kb.slug || kb.kbSlug);
    const slug = String(kb.slug || kb.kbSlug || kbPath.split('/').pop() || '').trim();
    if (!kbPath || !slug) return null;
    return {
      kbId: String(kb.kbId || `${storeId}:${slug}`).trim(),
      slug,
      path: kbPath,
      displayName: String(kb.displayName || kb.name || slug),
      description: String(kb.description || ''),
      sourceProjectRemoteUrl: String(kb.sourceProjectRemoteUrl || ''),
      tags: Array.isArray(kb.tags) ? kb.tags.map(String).filter(Boolean) : [],
    };
  }).filter(Boolean);
}

async function syncLocalStoreWithRemote(store, options = {}) {
  const root = store && store.localPath;
  const branch = store && (store.branch || store.defaultBranch) || 'main';
  if (!root) return { ok: false, status: 400, error: 'localPath is required' };
  const cleanSub = normalizeSparseCheckoutPath(options.subdir);
  const wantPartial = !!options.partialClone && !!cleanSub;
  const result = {
    ok: true,
    branch,
    fetched: false,
    pulled: false,
    ahead: false,
    diverged: false,
    remoteMissing: false,
    localHeadBefore: '',
    remoteHeadBefore: '',
    localHeadAfter: '',
    remoteHeadAfter: '',
  };

  const fetch = await execGit(root, ['fetch', 'origin', branch], 60000);
  if (!fetch.ok) {
    const fetchError = String(fetch.stderr || fetch.error || '');
    if (/could(n't| not) find remote ref/i.test(fetchError)) {
      result.remoteMissing = true;
      result.ahead = true;
      return result;
    }
    return {
      ok: false,
      status: 500,
      error: fetchError || 'git fetch failed',
      fetch,
    };
  }
  result.fetched = true;

  const remoteRef = `origin/${branch}`;
  const localHead = await execGit(root, ['rev-parse', 'HEAD'], 15000);
  const remoteHead = await execGit(root, ['rev-parse', remoteRef], 15000);
  result.localHeadBefore = localHead.ok ? localHead.stdout.trim() : '';
  result.remoteHeadBefore = remoteHead.ok ? remoteHead.stdout.trim() : '';

  if (result.localHeadBefore && result.remoteHeadBefore && result.localHeadBefore !== result.remoteHeadBefore) {
    const localContainsRemote = await execGit(root, ['merge-base', '--is-ancestor', remoteRef, 'HEAD'], 15000);
    const remoteContainsLocal = await execGit(root, ['merge-base', '--is-ancestor', 'HEAD', remoteRef], 15000);

    if (remoteContainsLocal.ok && !localContainsRemote.ok) {
      const pull = await execGit(root, ['pull', '--ff-only', 'origin', branch], 120000);
      if (!pull.ok) {
        return {
          ok: false,
          status: 500,
          error: pull.stderr || pull.error || 'git pull --ff-only failed',
          fetch,
          pull,
        };
      }
      result.pulled = true;
    } else if (localContainsRemote.ok && !remoteContainsLocal.ok) {
      result.ahead = true;
    } else {
      result.diverged = true;
      return {
        ok: false,
        status: 409,
        error: 'Local team knowledge repository has diverged from origin. Please resolve it manually, then try again.',
        fetch,
        localHead: result.localHeadBefore,
        remoteHead: result.remoteHeadBefore,
      };
    }
  }

  if (wantPartial) {
    const sparse = await applySparseCheckout(root, cleanSub);
    if (!sparse.ok) {
      return { ok: false, status: 500, error: `failed to apply sparse-checkout: ${sparse.error}`, sparse };
    }
    const mat = await materializeSparseCheckout(root, branch);
    if (!mat.ok) {
      return { ok: false, status: 500, error: `failed to materialize sparse-checkout: ${mat.error}`, mat };
    }
  }

  const finalLocalHead = await execGit(root, ['rev-parse', 'HEAD'], 15000);
  const finalRemoteHead = await execGit(root, ['rev-parse', remoteRef], 15000);
  result.localHeadAfter = finalLocalHead.ok ? finalLocalHead.stdout.trim() : result.localHeadBefore;
  result.remoteHeadAfter = finalRemoteHead.ok ? finalRemoteHead.stdout.trim() : result.remoteHeadBefore;
  if (result.localHeadAfter && result.remoteHeadAfter && result.localHeadAfter !== result.remoteHeadAfter) {
    const localContainsRemote = await execGit(root, ['merge-base', '--is-ancestor', remoteRef, 'HEAD'], 15000);
    result.ahead = localContainsRemote.ok;
  }
  return result;
}

async function configureLocalStore({ localPath, displayName = '', knowledgeBases = null, commit = true, push = true, provider = '' }) {
  const initialScan = await scanLocalStore({ localPath, provider });
  if (!initialScan.ok) return initialScan;
  const syncResult = await syncLocalStoreWithRemote(initialScan.store);
  if (!syncResult.ok) return syncResult;
  const scan = await scanLocalStore({ localPath: initialScan.store.localPath, provider });
  if (!scan.ok) return scan;
  const store = scan.store;
  const selectedKnowledgeBases = normalizeKnowledgeBaseInput(knowledgeBases, store.storeId);
  const manifest = normalizeManifest({
    schema: STORE_SCHEMA,
    storeId: store.storeId,
    displayName: displayName || store.displayName,
    knowledgeBases: selectedKnowledgeBases.length ? selectedKnowledgeBases : store.knowledgeBases,
  }, { full_name: store.fullName || store.storeId });
  if (!manifest.knowledgeBases.length) {
    return { ok: false, status: 400, error: 'No knowledge base directories were found in this repository' };
  }
  const manifestPath = path.join(store.localPath, MANIFEST_PATHS[0]);
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');

  let committed = false;
  let pushed = false;
  let commitResult = null;
  let pushResult = null;
  if (commit) {
    const add = await execGit(store.localPath, ['add', MANIFEST_PATHS[0]], 15000);
    if (!add.ok) return { ok: false, status: 500, error: add.stderr || add.error || 'git add failed', manifest, manifestPath };
    const diff = await execGit(store.localPath, ['diff', '--cached', '--quiet', '--', MANIFEST_PATHS[0]], 15000);
    if (diff.code === 0) {
      commitResult = { ok: true, skipped: true, reason: 'manifest unchanged' };
    } else {
      commitResult = await execGit(store.localPath, ['commit', '-m', 'Configure team knowledge store'], 60000);
      if (!commitResult.ok) {
        return { ok: false, status: 500, error: commitResult.stderr || commitResult.error || 'git commit failed', manifest, manifestPath };
      }
      committed = true;
    }
  }
  if (push && (committed || !commit || syncResult.ahead)) {
    pushResult = await execGit(store.localPath, ['push', 'origin', store.branch || store.defaultBranch || 'main'], 120000);
    if (!pushResult.ok) {
      return { ok: false, status: 500, error: pushResult.stderr || pushResult.error || 'git push failed', manifest, manifestPath, committed, syncResult };
    }
    pushed = true;
  }
  return {
    ok: true,
    store: {
      ...store,
      displayName: manifest.displayName,
      knowledgeBases: manifest.knowledgeBases,
      manifestPath: MANIFEST_PATHS[0],
    },
    manifest,
    manifestPath,
    committed,
    pushed,
    syncResult,
    commitResult,
    pushResult,
  };
}

function normalizeManifest(manifest, repo) {
  const source = manifest && typeof manifest === 'object' ? manifest : {};
  const fullName = repo && repo.full_name || '';
  const storeId = String(source.storeId || fullName || '').trim();
  const items = Array.isArray(source.knowledgeBases) ? source.knowledgeBases : [];
  const knowledgeBases = items.map((item) => {
    const kb = item && typeof item === 'object' ? item : {};
    const kbPath = normalizeKbPath(kb.path || kb.slug || kb.kbSlug);
    const slug = String(kb.slug || kb.kbSlug || kbPath.split('/').pop() || '').trim();
    if (!kbPath || !slug) return null;
    return {
      kbId: String(kb.kbId || `${storeId}:${slug}`).trim(),
      slug,
      path: kbPath,
      displayName: String(kb.displayName || kb.name || slug),
      description: String(kb.description || ''),
      sourceProjectRemoteUrl: String(kb.sourceProjectRemoteUrl || ''),
      tags: Array.isArray(kb.tags) ? kb.tags.map(String).filter(Boolean) : [],
    };
  }).filter(Boolean);
  return {
    schema: STORE_SCHEMA,
    storeId,
    displayName: String(source.displayName || source.name || fullName || storeId),
    description: String(source.description || ''),
    knowledgeBases,
  };
}

function defaultLocalPathForRepo(dataDir, repo) {
  const fullName = String(repo && repo.full_name || repo && repo.name || 'knowledge-store')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'knowledge-store';
  return path.join(dataDir, 'team-stores', fullName);
}

function encodeContentPath(relPath) {
  return String(relPath || '').split('/').map(encodeURIComponent).join('/');
}

async function readManifestFromRepo({ repo, token, apiBaseUrl, provider = 'github' }) {
  const branch = repo.default_branch || 'main';
  for (const manifestPath of MANIFEST_PATHS) {
    const url = apiUrl(apiBaseUrl, `/repos/${repo.full_name}/contents/${encodeContentPath(manifestPath)}`, { ref: branch });
    const result = await requestJson({ url, token, provider });
    if (!result.ok) continue;
    const raw = decodeContentResponse(result.data);
    if (!raw) continue;
    try {
      const manifest = normalizeManifest(parseJsonText(raw), repo);
      if (manifest.knowledgeBases.length) return { ok: true, manifest, manifestPath };
    } catch {}
  }
  return { ok: false, error: 'manifest not found' };
}

async function listAccessibleRepos({ token, apiBaseUrl = DEFAULT_API_BASE_URL, provider = 'github', maxRepos = 200 }) {
  const repos = [];
  let page = 1;
  while (repos.length < maxRepos) {
    const isGitea = normalizeProvider(provider) === 'gitea';
    const result = await requestJson({
      url: apiUrl(apiBaseUrl, '/user/repos', {
        affiliation: 'owner,collaborator,organization_member',
        sort: 'updated',
        ...(isGitea ? { limit: Math.min(50, maxRepos - repos.length) } : { per_page: Math.min(100, maxRepos - repos.length) }),
        page,
      }),
      token,
      provider,
    });
    if (!result.ok) return { ok: false, status: result.status, error: result.error, repos };
    const batch = Array.isArray(result.data) ? result.data : [];
    repos.push(...batch);
    if (batch.length < (isGitea ? 50 : 100)) break;
    page += 1;
  }
  return { ok: true, repos };
}

async function mapWithConcurrency(items, limit, worker) {
  const source = Array.isArray(items) ? items : [];
  const results = new Array(source.length);
  const workerCount = Math.max(1, Math.min(Number(limit) || 1, source.length || 1));
  let nextIndex = 0;
  async function runWorker() {
    while (nextIndex < source.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(source[index], index);
    }
  }
  await Promise.all(Array.from({ length: workerCount }, runWorker));
  return results;
}

async function discoverStores({ token, apiBaseUrl = DEFAULT_API_BASE_URL, provider = 'github', dataDir, maxRepos = 200 }) {
  const repoResult = await listAccessibleRepos({ token, apiBaseUrl, provider, maxRepos });
  if (!repoResult.ok) return repoResult;
  const storeResults = await mapWithConcurrency(repoResult.repos, 8, async (repo) => {
    const manifestResult = await readManifestFromRepo({ repo, token, apiBaseUrl, provider }).catch((error) => ({ ok: false, error: error && error.message || String(error) }));
    if (!manifestResult.ok) return null;
    return {
      provider: normalizeProvider(provider),
      fullName: repo.full_name,
      name: repo.name,
      owner: repo.owner && repo.owner.login || '',
      private: repo.private === true,
      htmlUrl: repo.html_url || '',
      cloneUrl: repo.clone_url || '',
      sshUrl: repo.ssh_url || '',
      defaultBranch: repo.default_branch || 'main',
      manifestPath: manifestResult.manifestPath,
      defaultLocalPath: defaultLocalPathForRepo(dataDir, repo),
      ...manifestResult.manifest,
    };
  });
  const stores = storeResults.filter(Boolean);
  return { ok: true, stores, scannedRepoCount: repoResult.repos.length };
}

function authenticatedCloneUrl(cloneUrl, token, provider = 'github', username = '') {
  if (!token || !/^https:\/\//i.test(cloneUrl || '')) return cloneUrl;
  const url = new URL(cloneUrl);
  if (normalizeProvider(provider) === 'gitea') {
    url.username = username || 'git';
    url.password = token;
  } else {
    url.username = 'x-access-token';
    url.password = token;
  }
  return url.toString();
}

function normalizeSparseCheckoutPath(value) {
  const normalized = String(value || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '');
  if (!normalized || normalized === '.' || normalized.includes('..') || path.isAbsolute(normalized)) return '';
  return normalized;
}

async function readSparseCheckoutEntries(localPath) {
  const list = await execGit(localPath, ['sparse-checkout', 'list'], 30000);
  if (!list.ok) return [];
  return String(list.stdout || '')
    .split(/\r?\n/)
    .map(normalizeSparseCheckoutPath)
    .filter(Boolean);
}

async function applySparseCheckout(localPath, subdir) {
  const target = path.resolve(String(localPath || '').trim());
  const sub = normalizeSparseCheckoutPath(subdir);
  if (!target) return { ok: false, error: 'localPath is required' };
  if (!sub) return { ok: false, error: 'subdir is required' };
  const init = await execGit(target, ['sparse-checkout', 'init', '--cone'], 30000);
  if (!init.ok) return { ok: false, error: init.stderr || init.error || 'sparse-checkout init failed', init };
  const entries = Array.from(new Set([...(await readSparseCheckoutEntries(target)), sub])).sort();
  const set = await execGit(target, ['sparse-checkout', 'set', ...entries], 30000);
  if (!set.ok) return { ok: false, error: set.stderr || set.error || 'sparse-checkout set failed', init, set };
  return { ok: true, entries };
}

async function materializeSparseCheckout(localPath, branch) {
  const checkout = await execGit(localPath, ['checkout', branch], 30000);
  if (!checkout.ok && !/already on/i.test(String(checkout.stderr || ''))) {
    return { ok: false, error: checkout.stderr || checkout.error || 'git checkout failed', checkout };
  }
  const readTree = await execGit(localPath, ['read-tree', '-mu', 'HEAD'], 30000);
  if (!readTree.ok) return { ok: false, error: readTree.stderr || readTree.error || 'git read-tree -mu HEAD failed', readTree };
  return { ok: true };
}

async function checkoutStore({ cloneUrl, branch = 'main', localPath, token = '', provider = 'github', username = '', subdir = '', partialClone = false }) {
  const target = path.resolve(String(localPath || '').trim());
  if (!target) return { ok: false, status: 400, error: 'localPath is required' };
  if (!cloneUrl || typeof cloneUrl !== 'string') return { ok: false, status: 400, error: 'cloneUrl is required' };
  const cleanSub = normalizeSparseCheckoutPath(subdir);
  const wantPartial = !!partialClone && !!cleanSub;

  if (wantPartial) {
    const v = await getGitVersion();
    if (!v.ok || v.major < 2 || (v.major === 2 && v.minor < 25)) {
      const reason = v.ok ? `git version ${v.major}.${v.minor} < 2.25` : `git --version unreadable (${v.raw || 'unknown'})`;
      const fallback = await checkoutStore({ cloneUrl, branch, localPath, token, provider, username });
      if (!fallback.ok) return fallback;
      return { ...fallback, action: 'cloned-fallback', warning: `partial clone requires Git >= 2.25; performed full clone instead. ${reason}` };
    }
  }

  if (fs.existsSync(target)) {
    const inside = await execGit(target, ['rev-parse', '--is-inside-work-tree']);
    if (!inside.ok) return { ok: false, status: 400, error: `localPath exists but is not a git repository: ${target}` };
    let warning = null;
    const fetch = await execGit(target, ['fetch', 'origin', branch], 60000);
    if (!fetch.ok) return { ok: false, status: 500, error: fetch.stderr || fetch.error || 'git fetch failed' };
    const pull = await execGit(target, ['pull', '--ff-only', 'origin', branch], 60000);
    if (!pull.ok) return { ok: false, status: 500, error: pull.stderr || pull.error || 'git pull failed' };
    if (wantPartial) {
      const sparse = await applySparseCheckout(target, cleanSub);
      if (!sparse.ok) return { ok: false, status: 500, error: `failed to apply sparse-checkout: ${sparse.error}` };
      const mat = await materializeSparseCheckout(target, branch);
      if (!mat.ok) return { ok: false, status: 500, error: `failed to materialize sparse-checkout: ${mat.error}` };
    }
    return { ok: true, action: wantPartial ? 'pulled-partial' : 'pulled', localPath: target, sparseCheckedOut: wantPartial, warning };
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  let cloneArgs = ['clone', '--branch', branch, authenticatedCloneUrl(cloneUrl, token, provider, username), target];
  if (wantPartial) cloneArgs.splice(1, 0, '--filter=blob:none', '--sparse', '--no-checkout');
  const clone = await execGit(path.dirname(target), cloneArgs, 120000);
  if (!clone.ok) return { ok: false, status: 500, error: clone.stderr || clone.error || 'git clone failed' };
  if (wantPartial) {
    const sparse = await applySparseCheckout(target, cleanSub);
    if (!sparse.ok) return { ok: false, status: 500, error: `failed to apply sparse-checkout: ${sparse.error}` };
    const mat = await materializeSparseCheckout(target, branch);
    if (!mat.ok) return { ok: false, status: 500, error: `failed to materialize sparse-checkout: ${mat.error}` };
  }
  return { ok: true, action: wantPartial ? 'cloned-partial' : 'cloned', localPath: target, sparseCheckedOut: wantPartial };
}

module.exports = {
  SCHEMA,
  STORE_SCHEMA,
  PROVIDER_CONFIG_SCHEMA,
  MANIFEST_PATHS,
  DEFAULT_API_BASE_URL,
  DEFAULT_WEB_BASE_URL,
  DEFAULT_OAUTH_CLIENT_ID,
  DEFAULT_GITEA_WEB_BASE_URL,
  DEFAULT_GITEA_OAUTH_CLIENT_ID,
  inferApiBaseUrlFromWebBaseUrl,
  inferWebBaseUrlFromApiBaseUrl,
  defaultConfig,
  normalizeConfig,
  normalizeProvider,
  normalizeProviderFileConfig,
  readProviderFileConfig,
  readConfig,
  writeConfig,
  publicConfig,
  requestJson,
  requestFormJson,
  oauthClientIdFromEnv,
  oauthClientIdForConfig,
  oauthClientSecretForConfig,
  oauthWebBaseUrlFromEnv,
  giteaPresetFromEnv,
  oauthPublicConfig,
  providerPublicConfig,
  startGiteaOAuth,
  exchangeGiteaOAuthCode,
  startDeviceFlow,
  pollDeviceFlow,
  validateToken,
  normalizeManifest,
  discoverStores,
  applySparseCheckout,
  materializeSparseCheckout,
  checkoutStore,
  scanLocalStore,
  configureLocalStore,
  normalizeKbPath,
};
