const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { URL } = require('url');
const { execGit } = require('./git-runner');

const SCHEMA = 'github-team/v1';
const STORE_SCHEMA = 'project-knowledge/team-store/v1';
const DEFAULT_API_BASE_URL = 'https://api.github.com';
const MANIFEST_PATHS = [
  '.project-knowledge/team-store.json',
  'project-knowledge-store.json',
  'team-store.json',
];

function defaultConfig() {
  return {
    schema: SCHEMA,
    apiBaseUrl: DEFAULT_API_BASE_URL,
    token: '',
    login: '',
    updatedAt: null,
  };
}

function normalizeConfig(input) {
  const source = input && typeof input === 'object' ? input : {};
  return {
    schema: SCHEMA,
    apiBaseUrl: typeof source.apiBaseUrl === 'string' && source.apiBaseUrl.trim()
      ? source.apiBaseUrl.trim().replace(/\/+$/, '')
      : DEFAULT_API_BASE_URL,
    token: typeof source.token === 'string' ? source.token.trim() : '',
    login: typeof source.login === 'string' ? source.login : '',
    updatedAt: typeof source.updatedAt === 'string' ? source.updatedAt : null,
  };
}

function readConfig(configPath) {
  if (!fs.existsSync(configPath)) return defaultConfig();
  try {
    return normalizeConfig(JSON.parse(fs.readFileSync(configPath, 'utf-8')));
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
    apiBaseUrl: cfg.apiBaseUrl,
    configured: !!cfg.token,
    login: cfg.login || '',
    updatedAt: cfg.updatedAt,
  };
}

function requestJson({ method = 'GET', url, token = '', body = null, headers = {}, timeoutMs = 20000 }) {
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
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
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

function apiUrl(apiBaseUrl, pathname, query = {}) {
  const url = new URL(pathname.replace(/^\/?/, '/'), normalizeConfig({ apiBaseUrl }).apiBaseUrl);
  for (const [key, value] of Object.entries(query || {})) {
    if (value != null && value !== '') url.searchParams.set(key, String(value));
  }
  return url.toString();
}

async function validateToken({ token, apiBaseUrl = DEFAULT_API_BASE_URL }) {
  if (!token || typeof token !== 'string') return { ok: false, status: 400, error: 'GitHub token is required' };
  const result = await requestJson({ url: apiUrl(apiBaseUrl, '/user'), token });
  if (!result.ok) return { ok: false, status: result.status || 400, error: result.error || 'GitHub token validation failed' };
  return {
    ok: true,
    user: result.data,
    login: result.data && result.data.login || '',
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

async function readManifestFromRepo({ repo, token, apiBaseUrl }) {
  const branch = repo.default_branch || 'main';
  for (const manifestPath of MANIFEST_PATHS) {
    const url = apiUrl(apiBaseUrl, `/repos/${repo.full_name}/contents/${encodeContentPath(manifestPath)}`, { ref: branch });
    const result = await requestJson({ url, token });
    if (!result.ok) continue;
    const raw = decodeContentResponse(result.data);
    if (!raw) continue;
    try {
      const manifest = normalizeManifest(JSON.parse(raw), repo);
      if (manifest.knowledgeBases.length) return { ok: true, manifest, manifestPath };
    } catch {}
  }
  return { ok: false, error: 'manifest not found' };
}

async function listAccessibleRepos({ token, apiBaseUrl = DEFAULT_API_BASE_URL, maxRepos = 200 }) {
  const repos = [];
  let page = 1;
  while (repos.length < maxRepos) {
    const result = await requestJson({
      url: apiUrl(apiBaseUrl, '/user/repos', {
        affiliation: 'owner,collaborator,organization_member',
        sort: 'updated',
        per_page: Math.min(100, maxRepos - repos.length),
        page,
      }),
      token,
    });
    if (!result.ok) return { ok: false, status: result.status, error: result.error, repos };
    const batch = Array.isArray(result.data) ? result.data : [];
    repos.push(...batch);
    if (batch.length < 100) break;
    page += 1;
  }
  return { ok: true, repos };
}

async function discoverStores({ token, apiBaseUrl = DEFAULT_API_BASE_URL, dataDir, maxRepos = 200 }) {
  const repoResult = await listAccessibleRepos({ token, apiBaseUrl, maxRepos });
  if (!repoResult.ok) return repoResult;
  const stores = [];
  for (const repo of repoResult.repos) {
    const manifestResult = await readManifestFromRepo({ repo, token, apiBaseUrl });
    if (!manifestResult.ok) continue;
    stores.push({
      provider: 'github',
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
    });
  }
  return { ok: true, stores, scannedRepoCount: repoResult.repos.length };
}

function authenticatedCloneUrl(cloneUrl, token) {
  if (!token || !/^https:\/\//i.test(cloneUrl || '')) return cloneUrl;
  const url = new URL(cloneUrl);
  url.username = 'x-access-token';
  url.password = token;
  return url.toString();
}

async function checkoutStore({ cloneUrl, branch = 'main', localPath, token = '' }) {
  const target = path.resolve(String(localPath || '').trim());
  if (!target) return { ok: false, status: 400, error: 'localPath is required' };
  if (!cloneUrl || typeof cloneUrl !== 'string') return { ok: false, status: 400, error: 'cloneUrl is required' };
  if (fs.existsSync(target)) {
    const inside = await execGit(target, ['rev-parse', '--is-inside-work-tree']);
    if (!inside.ok) return { ok: false, status: 400, error: `localPath exists but is not a git repository: ${target}` };
    const fetch = await execGit(target, ['fetch', 'origin', branch], 60000);
    if (!fetch.ok) return { ok: false, status: 500, error: fetch.stderr || fetch.error || 'git fetch failed' };
    const pull = await execGit(target, ['pull', '--ff-only', 'origin', branch], 60000);
    if (!pull.ok) return { ok: false, status: 500, error: pull.stderr || pull.error || 'git pull failed' };
    return { ok: true, action: 'pulled', localPath: target };
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const clone = await execGit(path.dirname(target), ['clone', '--branch', branch, authenticatedCloneUrl(cloneUrl, token), target], 120000);
  if (!clone.ok) return { ok: false, status: 500, error: clone.stderr || clone.error || 'git clone failed' };
  return { ok: true, action: 'cloned', localPath: target };
}

module.exports = {
  SCHEMA,
  STORE_SCHEMA,
  MANIFEST_PATHS,
  DEFAULT_API_BASE_URL,
  defaultConfig,
  normalizeConfig,
  readConfig,
  writeConfig,
  publicConfig,
  requestJson,
  validateToken,
  normalizeManifest,
  discoverStores,
  checkoutStore,
  normalizeKbPath,
};
