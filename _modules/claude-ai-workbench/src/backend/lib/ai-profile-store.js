const fs = require('fs');
const path = require('path');
const { getDataDir } = require('./data-dir');
const { completeText } = require('./llm-client');

const SCHEMA = 'ai-profiles/v1';
const DEFAULT_TIMEOUT_MS = 300000;
const DEFAULT_CONTEXT_WINDOW = 200000;

function readJsonOrDefault(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function maskSecret(value) {
  if (!value) return '';
  const text = String(value);
  if (text.length <= 8) return '********';
  return `${text.slice(0, 4)}...${text.slice(-4)}`;
}

function toPositiveInteger(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function normalizeSystemPrompt(value) {
  if (value && typeof value === 'object') return value;
  if (typeof value === 'string' && value.trim()) {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return { type: 'preset', preset: 'claude_code' };
}

function isBlankAiProfileDraft(profile) {
  return ![
    profile.provider,
    profile.baseUrl,
    profile.apiBaseUrl,
    profile.anthropicBaseUrl,
    profile.apiKey,
    profile.authToken,
    profile.anthropicAuthToken,
    profile.mainModel,
    profile.model,
    profile.website,
    profile.notes,
  ].some(value => String(value || '').trim());
}

function profileImplementation(profile) {
  return profile && (profile.implementation || profile.adapter || 'claude-code-agent') || 'claude-code-agent';
}

function normalizeProfilesConfig(profiles, existingCfg = { profiles: [] }, activeAiProfileId = null, options = {}) {
  const existingById = new Map((existingCfg.profiles || []).filter(p => p && p.id).map(p => [p.id, p]));
  const seen = new Set();
  const normalized = [];
  for (const raw of profiles || []) {
    if (!raw || typeof raw !== 'object') continue;
    const id = String(raw.id || '').trim();
    if (id && id !== activeAiProfileId && options.dropBlankDrafts !== false && isBlankAiProfileDraft(raw)) continue;
    if (!id) throw new Error('AI profile is missing id');
    if (seen.has(id)) throw new Error(`duplicate AI profile id: ${id}`);
    seen.add(id);
    const existing = existingById.get(id) || {};
    const provider = String(raw.provider || raw.name || existing.provider || existing.name || id).trim() || id;
    const profile = {
      ...existing,
      ...raw,
      id,
      name: String(raw.name || raw.provider || existing.name || provider || id).trim() || id,
      provider,
      enabled: raw.enabled !== false,
      implementation: 'claude-code-agent',
      baseUrl: String(raw.baseUrl || raw.apiBaseUrl || raw.anthropicBaseUrl || '').trim(),
      notes: String(raw.notes || '').trim(),
      website: String(raw.website || '').trim(),
      mainModel: String(raw.mainModel || raw.model || '').trim(),
      thinkingModel: String(raw.thinkingModel || raw.mainModel || raw.model || '').trim(),
      haikuModel: String(raw.haikuModel || raw.mainModel || raw.model || '').trim(),
      sonnetModel: String(raw.sonnetModel || raw.mainModel || raw.model || '').trim(),
      opusModel: String(raw.opusModel || raw.mainModel || raw.model || '').trim(),
      model: String(raw.model || raw.mainModel || '').trim(),
      timeoutMs: toPositiveInteger(raw.timeoutMs, DEFAULT_TIMEOUT_MS),
      contextWindow: toPositiveInteger(raw.contextWindow, DEFAULT_CONTEXT_WINDOW),
      runner: 'sdk',
      systemPrompt: normalizeSystemPrompt(raw.systemPrompt),
    };
    for (const key of ['apiKey', 'authToken', 'anthropicAuthToken']) {
      profile[key] = raw[key] ? String(raw[key]) : existing[key] || '';
    }
    delete profile.hasApiKey;
    delete profile.apiKeyMasked;
    normalized.push(profile);
  }
  return { schema: SCHEMA, profiles: normalized };
}

function validateProfile(profile, id = profile && profile.id) {
  if (!id) return { ok: false, error: 'AI profile id is required' };
  if (!profile) return { ok: false, error: `AI profile not found: ${id}` };
  if (profile.enabled === false) return { ok: false, error: `AI profile is disabled: ${id}` };
  if (profileImplementation(profile) !== 'claude-code-agent') {
    return { ok: false, error: `unsupported AI implementation: ${profileImplementation(profile)}` };
  }
  if (!(profile.apiKey || profile.authToken || profile.anthropicAuthToken)) {
    return { ok: false, error: `AI profile is missing API key: ${id}` };
  }
  if (!(profile.mainModel || profile.model)) {
    return { ok: false, error: `AI profile is missing model: ${id}` };
  }
  if (!(profile.baseUrl || profile.apiBaseUrl || profile.anthropicBaseUrl)) {
    return { ok: false, error: `AI profile is missing baseUrl: ${id}` };
  }
  return { ok: true, profile, implementation: profileImplementation(profile) };
}

function validateProfileConfig(cfg) {
  const errors = [];
  if (!cfg || typeof cfg !== 'object') return ['config must be an object'];
  if (cfg.schema && cfg.schema !== SCHEMA) errors.push(`schema must be ${SCHEMA}`);
  if (!Array.isArray(cfg.profiles)) errors.push('profiles must be an array');
  const ids = new Set();
  for (const profile of cfg.profiles || []) {
    const id = profile && profile.id;
    if (!id) {
      errors.push('profile id is required');
      continue;
    }
    if (ids.has(id)) errors.push(`duplicate profile id: ${id}`);
    ids.add(id);
    const check = validateProfile(profile, id);
    if (!check.ok) errors.push(check.error);
  }
  return errors;
}

function publicProfile(profile) {
  const secret = profile.apiKey || profile.authToken || profile.anthropicAuthToken || '';
  return {
    ...profile,
    apiKey: '',
    authToken: '',
    anthropicAuthToken: '',
    hasApiKey: !!secret,
    apiKeyMasked: maskSecret(secret),
  };
}

class AiProfileStore {
  constructor(options = {}) {
    this.profilesPath = options.profilesPath || path.join(getDataDir(), 'ai-profiles.json');
    this.activeProfileId = options.activeProfileId || null;
    this.dropBlankDrafts = options.dropBlankDrafts !== false;
  }

  readConfig() {
    const cfg = readJsonOrDefault(this.profilesPath, { schema: SCHEMA, profiles: [] });
    if (cfg && cfg.schema === SCHEMA && Array.isArray(cfg.profiles)) return cfg;
    return { schema: SCHEMA, profiles: [] };
  }

  writeConfig(cfg) {
    const normalized = normalizeProfilesConfig(
      Array.isArray(cfg && cfg.profiles) ? cfg.profiles : [],
      this.readConfig(),
      cfg && (cfg.activeAiProfileId || cfg.defaultProviderId || this.activeProfileId),
      { dropBlankDrafts: this.dropBlankDrafts }
    );
    const errors = validateProfileConfig(normalized);
    if (errors.length) {
      const err = new Error(errors[0]);
      err.errors = errors;
      throw err;
    }
    writeJson(this.profilesPath, normalized);
    return normalized;
  }

  publicConfig() {
    const cfg = this.readConfig();
    const profiles = (cfg.profiles || []).map(publicProfile);
    return {
      ok: true,
      aiProfilesPath: this.profilesPath,
      config: { schema: SCHEMA, profiles },
      profiles,
      activeAiProfileId: this.activeProfileId || (profiles.find(p => p.enabled !== false) || {}).id || null,
    };
  }

  profileById(id) {
    return (this.readConfig().profiles || []).find(profile => profile && profile.id === id) || null;
  }

  firstUsableProfileId() {
    return ((this.readConfig().profiles || []).find(profile => validateProfile(profile).ok) || {}).id || null;
  }

  activeProfile() {
    return this.profileById(this.activeProfileId) || this.profileById(this.firstUsableProfileId());
  }

  validateProfile(idOrProfile) {
    const profile = typeof idOrProfile === 'string' ? this.profileById(idOrProfile) : idOrProfile;
    const id = typeof idOrProfile === 'string' ? idOrProfile : profile && profile.id;
    return validateProfile(profile, id);
  }

  async testProfile({ profileId, profile, prompt = 'what model are you?', maxTokens = 128 } = {}) {
    const resolved = profile || this.profileById(profileId);
    const id = profileId || resolved && resolved.id;
    const check = validateProfile(resolved, id);
    if (!check.ok) {
      const err = new Error(check.error);
      err.status = 400;
      throw err;
    }
    const result = await completeText({
      profileId: id,
      profile: resolved,
      user: prompt,
      maxTokens,
    });
    return {
      ok: true,
      profileId: id,
      model: result.model,
      text: result.text,
      usage: result.usage,
    };
  }
}

module.exports = {
  AiProfileStore,
  SCHEMA,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_CONTEXT_WINDOW,
  maskSecret,
  publicProfile,
  profileImplementation,
  normalizeProfilesConfig,
  validateProfile,
  validateProfileConfig,
};
