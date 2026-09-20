'use strict';

const path = require('path');
const { normalizeProfile, cleanId } = require('../../contracts');
const { readJson, writeJson } = require('./json-file');

class ProfileStore {
  constructor(options = {}) {
    if (!options.dataDir) throw new Error('ProfileStore dataDir is required');
    this.profileFile = options.profileFile || path.join(options.dataDir, 'profiles.v2.json');
    this.credentialFile = options.credentialFile || path.join(options.dataDir, 'credentials.v1.json');
  }

  _profiles() { return readJson(this.profileFile, { schema: 'claude-workbench-profiles/v2', profiles: [] }); }
  _credentials() { return readJson(this.credentialFile, { schema: 'claude-workbench-credentials/v1', credentials: {} }); }

  _configured(profile) {
    return Boolean(this._credentials().credentials[profile.credentialRef]);
  }

  publicProfile(profile) {
    profile = normalizeProfile(profile);
    const secret = this._credentials().credentials[profile.credentialRef] || '';
    const clean = {
      ...profile,
      credentialConfigured: Boolean(secret),
      credentialMasked: maskCredential(secret),
    };
    delete clean.apiKey;
    delete clean.authToken;
    delete clean.anthropicAuthToken;
    delete clean.secret;
    return clean;
  }

  list() { return this._profiles().profiles.map(profile => this.publicProfile(profile)); }

  get(id) {
    const profileId = cleanId(id, 'profileId');
    const profile = this._profiles().profiles.find(item => item.id === profileId);
    return profile ? this.publicProfile(profile) : null;
  }

  save(input, idOverride) {
    const profile = normalizeProfile(input, idOverride);
    validateProfile(profile);
    const cfg = this._profiles();
    const index = cfg.profiles.findIndex(item => item.id === profile.id);
    if (index >= 0) cfg.profiles[index] = profile;
    else cfg.profiles.push(profile);
    writeJson(this.profileFile, cfg);
    return this.publicProfile(profile);
  }

  delete(id) {
    const profileId = cleanId(id, 'profileId');
    const cfg = this._profiles();
    const profile = cfg.profiles.find(item => item.id === profileId);
    if (!profile) return false;
    cfg.profiles = cfg.profiles.filter(item => item.id !== profileId);
    writeJson(this.profileFile, cfg);
    const secrets = this._credentials();
    delete secrets.credentials[profile.credentialRef];
    writeJson(this.credentialFile, secrets);
    return true;
  }

  setCredential(id, credential) {
    const profileId = cleanId(id, 'profileId');
    const cfg = this._profiles();
    const profile = cfg.profiles.find(item => item.id === profileId);
    if (!profile) throw Object.assign(new Error('profile not found'), { status: 404 });
    const secret = typeof credential === 'string' ? credential : credential && credential.secret;
    if (!secret || typeof secret !== 'string') {
      throw Object.assign(new Error('credential secret is required'), { status: 400 });
    }
    const secrets = this._credentials();
    secrets.credentials[profile.credentialRef] = String(secret);
    writeJson(this.credentialFile, secrets);
  }

  runtimeProfile(id) {
    const profileId = cleanId(id, 'profileId');
    const profile = this._profiles().profiles.find(item => item.id === profileId);
    if (!profile) throw Object.assign(new Error('profile not found'), { status: 404 });
    if (!profile.enabled) throw Object.assign(new Error('profile is disabled'), { status: 400 });
    const secret = this._credentials().credentials[profile.credentialRef];
    if (!secret) throw Object.assign(new Error('profile credential is not configured'), { status: 400 });
    return runtimeShape(profile, secret);
  }

  runtimeDraft(input, credential, options = {}) {
    const profile = normalizeProfile(input);
    validateProfile(profile, options);
    if (!profile.enabled) throw Object.assign(new Error('profile is disabled'), { status: 400 });
    let secret = typeof credential === 'string' ? credential : credential && credential.secret;
    if (!secret) {
      const saved = this._profiles().profiles.find(item => item.id === profile.id);
      if (saved) secret = this._credentials().credentials[saved.credentialRef];
    }
    if (!secret) throw Object.assign(new Error('profile credential is not configured'), { status: 400 });
    return runtimeShape(profile, String(secret));
  }
}

function runtimeShape(profile, secret) {
  profile = normalizeProfile(profile);
  return {
    ...profile,
    apiKey: secret,
    mainModel: profile.models.default,
    thinkingModel: profile.models.reasoning || profile.models.default,
    haikuModel: profile.models.fast || profile.models.default,
    sonnetModel: profile.models.coding || profile.models.default,
    opusModel: profile.models.largeContext || profile.models.default,
  };
}

function maskCredential(secret) {
  const value = String(secret || '');
  if (!value) return '';
  if (value.length <= 12) return `${value.slice(0, 2)}****${value.slice(-2)}`;
  return `${value.slice(0, 6)}****${value.slice(-6)}`;
}

function validateProfile(profile, options = {}) {
  if (profile.runtime !== 'claude-code') throw Object.assign(new Error('runtime must be claude-code'), { status: 400 });
  if (!profile.provider) throw Object.assign(new Error('provider is required'), { status: 400 });
  // One protocol endpoint is enough: single-protocol providers are valid;
  // the agents that speak the missing protocol simply can't use it.
  if (!profile.baseUrl && !profile.openaiBaseUrl) {
    throw Object.assign(new Error('baseUrl is required'), { status: 400 });
  }
  for (const field of ['baseUrl', 'openaiBaseUrl']) {
    if (!profile[field]) continue;
    let url;
    try { url = new URL(profile[field]); } catch {}
    if (!url || !['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw Object.assign(new Error(`${field} must be an HTTP(S) endpoint without credentials, query, or fragment`), { status: 400 });
    }
  }
  // Detection runs before any model is configured; every other path needs one.
  if (!profile.models.default && options.requireModel !== false) {
    throw Object.assign(new Error('models.default is required'), { status: 400 });
  }
  return profile;
}

module.exports = { ProfileStore, validateProfile, maskCredential };
