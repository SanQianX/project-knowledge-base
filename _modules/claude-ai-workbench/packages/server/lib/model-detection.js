'use strict';

// Auto-detection of a provider's usable models, modeled after all-api-hub:
//   1. The provider's own models endpoint yields the ids the key can use —
//      Anthropic-style (x-api-key, /v1/models with cursor pagination and a
//      Bearer retry on 401) and OpenAI-style (Bearer, /v1/models with a
//      /models fallback only for missing-route 404/405).
//   2. Capability metadata (context window, input modalities, reasoning,
//      tool calls) comes from the models.dev catalog, cached in memory for
//      24h and degrading to "unavailable" when it cannot be fetched.
// The two sides are joined with a forgiving id match chain so relay-station
// ids like claude-3-5-sonnet-20241022-latest still find their metadata.

const MODELS_DEV_URL = 'https://models.dev/models.json';
const METADATA_TTL_MS = 24 * 60 * 60 * 1000;
const ANTHROPIC_VERSION = '2023-06-01';
const PAGE_LIMIT = 1000;
const MAX_PAGES = 5;
const MAX_MODELS = 2000;
const REQUEST_TIMEOUT_MS = 15000;
const DATE_SUFFIX = /-(?:latest|preview|stable|\d{4}-?\d{2}-?\d{2}|\d{8,10})(?:-\d+)?$/i;

function createModelDetection(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('fetch is required for model detection');
  const contextLookup = typeof options.contextLookup === 'function' ? options.contextLookup : () => null;
  const modelsDevUrl = options.modelsDevUrl || MODELS_DEV_URL;
  let cache = null; // { entries, exact, tokenKeys, fetchedAt }
  let inFlight = null;

  async function fetchJson(url, headers) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetchImpl(url, { headers, signal: controller.signal });
      const text = await response.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON error bodies stay raw */ }
      return { response, data, text };
    } finally {
      clearTimeout(timer);
    }
  }

  function endpointError(label, url, response, text) {
    const snippet = String(text || '').replace(/\s+/g, ' ').slice(0, 200);
    return Object.assign(
      new Error(`${label} request failed: HTTP ${response.status}${snippet ? ` — ${snippet}` : ''}`),
      { status: 400, upstreamStatus: response.status, url },
    );
  }

  // "https://x.test/v1" and "https://x.test/v1/" both normalize to
  // "https://x.test" so /v1/models is never doubled.
  function stripVersionSuffix(baseUrl) {
    return String(baseUrl || '').trim().replace(/\/+$/, '').replace(/\/v1(?:beta)?$/i, '');
  }

  function collectIds(data) {
    const rows = data && Array.isArray(data.data) ? data.data : Array.isArray(data) ? data : null;
    if (!rows) return null;
    const ids = [];
    for (const row of rows) {
      const id = row && typeof row === 'object' ? String(row.id || '').trim() : '';
      if (id) ids.push(id);
    }
    return ids;
  }

  async function fetchAnthropicModels(baseUrl, apiKey) {
    const root = stripVersionSuffix(baseUrl);
    const seen = new Set();
    const ids = [];
    let afterId = '';
    for (let page = 0; page < MAX_PAGES && ids.length < MAX_MODELS; page++) {
      const query = `limit=${PAGE_LIMIT}${afterId ? `&after_id=${encodeURIComponent(afterId)}` : ''}`;
      const url = `${root}/v1/models?${query}`;
      let result = await fetchJson(url, { 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION });
      if (result.response.status === 401) {
        // Some relays only accept Bearer auth; retry once before failing.
        result = await fetchJson(url, { Authorization: `Bearer ${apiKey}`, 'anthropic-version': ANTHROPIC_VERSION });
      }
      if (!result.response.ok) throw endpointError('Anthropic models', url, result.response, result.text);
      const pageIds = collectIds(result.data);
      if (!pageIds) throw Object.assign(new Error(`Anthropic models response has no model list: ${url}`), { status: 400 });
      for (const id of pageIds) { if (!seen.has(id)) { seen.add(id); ids.push(id); } }
      const last = pageIds.length ? pageIds[pageIds.length - 1] : '';
      if (result.data.has_more !== true || !last || last === afterId) break;
      afterId = last;
    }
    return ids.slice(0, MAX_MODELS);
  }

  async function fetchOpenAiModels(baseUrl, apiKey) {
    const root = stripVersionSuffix(baseUrl);
    const auth = { Authorization: `Bearer ${apiKey}` };
    let result = await fetchJson(`${root}/v1/models`, auth);
    // Volcengine-style hosts expose /models on an already-prefixed base URL;
    // only a missing route falls through — auth and server errors fail fast.
    if (result.response.status === 404 || result.response.status === 405) {
      result = await fetchJson(`${String(baseUrl).trim().replace(/\/+$/, '')}/models`, auth);
    }
    if (!result.response.ok) throw endpointError('OpenAI models', root, result.response, result.text);
    const ids = collectIds(result.data);
    if (!ids) throw Object.assign(new Error(`OpenAI models response has no model list: ${root}/v1/models`), { status: 400 });
    return ids.slice(0, MAX_MODELS);
  }

  // ---- models.dev capability catalog ----

  function normalizeCatalog(payload) {
    const entries = [];
    const source = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
    for (const [key, raw] of Object.entries(source)) {
      if (!raw || typeof raw !== 'object') continue;
      // The map key "provider/model-id" is authoritative; entry.id may be bare.
      const bareId = String(key.includes('/') ? key.slice(key.lastIndexOf('/') + 1) : raw.id || key).trim();
      if (!bareId) continue;
      const modalities = raw.modalities && typeof raw.modalities === 'object' ? raw.modalities : {};
      const limit = raw.limit && typeof raw.limit === 'object' ? raw.limit : {};
      const context = Number(limit.context);
      const maxOutput = Number(limit.output);
      entries.push({
        id: bareId,
        name: String(raw.name || bareId).trim(),
        provider: String(key.includes('/') ? key.slice(0, key.indexOf('/')) : raw.provider_id || '').trim(),
        reasoning: raw.reasoning === true,
        toolCall: raw.tool_call === true,
        attachment: raw.attachment === true,
        input: Array.isArray(modalities.input) ? modalities.input.map(String) : [],
        output: Array.isArray(modalities.output) ? modalities.output.map(String) : [],
        context: Number.isFinite(context) && context > 0 ? Math.floor(context) : null,
        maxOutput: Number.isFinite(maxOutput) && maxOutput > 0 ? Math.floor(maxOutput) : null,
      });
    }
    const exact = new Map();
    for (const entry of entries) {
      const key = entry.id.toLowerCase();
      if (exact.has(key)) exact.set(key, null); // ambiguous: never match silently
      else exact.set(key, entry);
    }
    const tokenKeys = new Map();
    for (const entry of entries) {
      const key = tokenKey(entry.id);
      if (tokenKeys.has(key)) tokenKeys.set(key, null);
      else tokenKeys.set(key, entry);
    }
    return { entries, exact, tokenKeys, fetchedAt: Date.now() };
  }

  function tokenKey(id) {
    const base = String(id || '').toLowerCase().replace(/[._]/g, '-');
    const tokens = base.split('-').filter(token => token && !DATE_SUFFIX.test(`-${token}`) && token !== 'latest' && token !== 'preview');
    if (!tokens.length) return base;
    const [first, ...rest] = tokens;
    return `${first}:${[...rest].sort().join('-')}`;
  }

  function matchModel(catalog, modelId) {
    if (!catalog || !modelId) return null;
    const bare = String(modelId).toLowerCase();
    const direct = catalog.exact.get(bare);
    if (direct) return direct;
    // Fetched ids sometimes carry a provider prefix (openai/gpt-4o).
    const suffix = bare.includes('/') ? bare.slice(bare.lastIndexOf('/') + 1) : bare;
    if (suffix !== bare) {
      const prefixed = catalog.exact.get(suffix);
      if (prefixed) return prefixed;
    }
    let stripped = suffix;
    while (true) {
      const next = stripped.replace(DATE_SUFFIX, '');
      if (next === stripped) break;
      stripped = next;
      const hit = catalog.exact.get(stripped);
      if (hit) return hit;
    }
    const fuzzy = catalog.tokenKeys.get(tokenKey(suffix));
    return fuzzy || null;
  }

  async function loadCatalog() {
    if (cache && Date.now() - cache.fetchedAt < METADATA_TTL_MS) return cache;
    if (!inFlight) {
      inFlight = (async () => {
        try {
          const result = await fetchJson(modelsDevUrl, {});
          if (!result.response.ok) return null;
          const next = normalizeCatalog(result.data);
          cache = next;
          return next;
        } catch {
          return null; // offline/blocked: detection continues without capabilities
        } finally {
          inFlight = null;
        }
      })();
    }
    return inFlight;
  }

  function capabilityTags(entry) {
    if (!entry) return [];
    const tags = [];
    if (entry.reasoning) tags.push('思考');
    if (entry.input.includes('image')) tags.push('图片');
    if (entry.input.includes('audio')) tags.push('音频');
    if (entry.input.includes('pdf')) tags.push('PDF');
    if (entry.toolCall) tags.push('工具');
    return tags.slice(0, 8);
  }

  // Dual-protocol relays usually expose both routes on one origin: the OpenAI
  // api at /v1 and the Anthropic api at /anthropic.
  function sameOriginPath(baseUrl, segment) {
    try { return `${new URL(baseUrl).origin}${segment}`; } catch { return ''; }
  }

  async function detectModels({ profile } = {}) {
    if (!profile || typeof profile !== 'object') {
      throw Object.assign(new Error('profile is required'), { status: 400 });
    }
    const apiKey = String(profile.apiKey || '');
    // Explicit slots first; an empty slot falls back to probing the same
    // origin of the filled one, and a verified hit is reported so the caller
    // can pin it.
    const anthropicBase = String(profile.baseUrl || '').trim()
      || sameOriginPath(String(profile.openaiBaseUrl || '').trim(), '/anthropic');
    const openaiBase = String(profile.openaiBaseUrl || '').trim()
      || sameOriginPath(String(profile.baseUrl || '').trim(), '/v1');
    if (!anthropicBase && !openaiBase) {
      throw Object.assign(new Error('a base URL is required to detect models'), { status: 400 });
    }
    if (!apiKey) {
      throw Object.assign(new Error('an API key is required to detect models'), { status: 400 });
    }

    const attempts = [];
    if (anthropicBase) {
      attempts.push({ label: 'anthropic', base: anthropicBase, run: () => fetchAnthropicModels(anthropicBase, apiKey) });
    }
    if (openaiBase) {
      attempts.push({ label: 'openai', base: openaiBase, run: () => fetchOpenAiModels(openaiBase, apiKey) });
    }

    const sources = {};
    const failures = [];
    const ordered = []; // canonical first-seen order: anthropic side wins
    const seen = new Set();
    for (const attempt of attempts) {
      try {
        const ids = await attempt.run();
        sources[attempt.label] = { ok: true, baseUrl: attempt.base, count: ids.length };
        for (const id of ids) {
          const bare = id.includes('/') ? id.slice(id.lastIndexOf('/') + 1) : id;
          if (!seen.has(bare)) { seen.add(bare); ordered.push(bare); }
        }
      } catch (error) {
        sources[attempt.label] = { ok: false, baseUrl: attempt.base, error: error.message };
        failures.push(error.message);
      }
    }
    if (!ordered.length) {
      throw Object.assign(new Error(failures.join(' ; ') || 'no models detected'), { status: 400 });
    }

    const catalog = await loadCatalog();
    const models = ordered.slice(0, MAX_MODELS).map(id => {
      const meta = matchModel(catalog, id);
      const contextWindow = meta && meta.context || contextLookup(id) || null;
      return {
        id,
        openaiId: id.replace(/\[1m\]$/i, ''),
        label: meta && meta.name || id,
        contextWindow,
        tags: capabilityTags(meta),
        reasoning: meta ? meta.reasoning : null,
        toolCall: meta ? meta.toolCall : null,
        input: meta ? meta.input : null,
        output: meta ? meta.output : null,
        maxOutput: meta ? meta.maxOutput : null,
      };
    });
    return {
      ok: true,
      models,
      sources,
      metadataSource: catalog ? 'models.dev' : 'unavailable',
    };
  }

  return { detectModels, matchModel, normalizeCatalog, stripVersionSuffix, tokenKey };
}

module.exports = { createModelDetection, MODELS_DEV_URL, METADATA_TTL_MS };
