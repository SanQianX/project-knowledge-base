// _site/lib/llm-client.js
//
// Tiny Anthropic Messages API client. Zero npm deps; supports HTTPS and HTTP
// Anthropic-compatible endpoints. Connection settings are resolved from an AI
// profile first, then environment variables as fallback:
//
//   profile.baseUrl       or ANTHROPIC_BASE_URL
//   profile.apiKey        or ANTHROPIC_AUTH_TOKEN
//   profile.mainModel     or ANTHROPIC_MODEL
//   profile.timeoutMs     or API_TIMEOUT_MS
//
// This lets the local UI persist model settings in ai-profiles.json while still
// keeping env vars useful for scripts and temporary overrides.

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { URL } = require('url');

const DEFAULT_BASE = 'https://api.anthropic.com';
const DEFAULT_VERSION = '2023-06-01';
const DEFAULT_MODEL = 'claude-haiku-4-5';
const { getDataDir } = require('./data-dir');
const DATA_DIR = getDataDir();
const AI_PROFILES_PATH = path.join(DATA_DIR, 'ai-profiles.json');

function readProfilesFile() {
  try {
    const cfg = JSON.parse(fs.readFileSync(AI_PROFILES_PATH, 'utf-8'));
    return Array.isArray(cfg.profiles) ? cfg.profiles : [];
  } catch {
    return [];
  }
}

function findProfile(profileId) {
  if (!profileId) return null;
  return readProfilesFile().find(profile => profile && profile.id === profileId) || null;
}

function readConfig(options = {}) {
  const profileId = typeof options === 'string' ? options : options.profileId;
  const inlineProfile = options && typeof options === 'object' && options.profile && typeof options.profile === 'object'
    ? options.profile
    : null;
  const profile = inlineProfile || findProfile(profileId) || {};
  const timeoutMs = Number(profile.timeoutMs || process.env.API_TIMEOUT_MS || 60_000);
  return {
    profileId: profile.id || profileId || null,
    baseUrl: profile.baseUrl || profile.apiBaseUrl || profile.anthropicBaseUrl || process.env.ANTHROPIC_BASE_URL || DEFAULT_BASE,
    apiKey: profile.apiKey || profile.authToken || profile.anthropicAuthToken || process.env.ANTHROPIC_AUTH_TOKEN || '',
    model: profile.mainModel || profile.model || process.env.ANTHROPIC_MODEL || DEFAULT_MODEL,
    version: DEFAULT_VERSION,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 60_000,
  };
}

function buildRequestPath(base, p) {
  if (!p.startsWith('/')) return p;
  const basePath = base.pathname.endsWith('/') ? base.pathname.slice(0, -1) : base.pathname;
  return basePath + p;
}

function postJson({ baseUrl, path: p, body, apiKey, version, timeoutMs = 60_000 }) {
  return new Promise((resolve, reject) => {
    try {
      const base = new URL(baseUrl);
      const transport = base.protocol === 'http:' ? http : https;
      const data = JSON.stringify(body);
      const req = transport.request({
        host: base.hostname,
        port: base.port || (base.protocol === 'http:' ? 80 : 443),
        path: buildRequestPath(base, p),
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': version,
          'Content-Length': Buffer.byteLength(data),
        },
        timeout: timeoutMs,
      }, res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf-8');
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(new Error(`HTTP ${res.statusCode}: ${text.slice(0, 500)}`));
          }
          try { resolve(JSON.parse(text)); }
          catch (e) { reject(new Error(`bad JSON: ${e.message}; body head: ${text.slice(0, 200)}`)); }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => req.destroy(new Error(`timeout after ${timeoutMs}ms`)));
      req.write(data);
      req.end();
    } catch (e) {
      reject(new Error(`bad baseUrl: ${baseUrl}: ${e.message}`));
    }
  });
}

async function completeText({ system, user, maxTokens = 512, model, profileId, profile }) {
  const cfg = readConfig({ profileId, profile });
  if (!cfg.apiKey) {
    const id = profileId ? ` for profile ${profileId}` : '';
    throw new Error(`API key not set${id}`);
  }
  const body = {
    model: model || cfg.model,
    max_tokens: maxTokens,
    messages: [{ role: 'user', content: user }],
  };
  if (system) body.system = system;

  const raw = await postJson({
    baseUrl: cfg.baseUrl,
    path: '/v1/messages',
    body,
    apiKey: cfg.apiKey,
    version: cfg.version,
    timeoutMs: cfg.timeoutMs,
  });

  const text = (raw.content || [])
    .filter(block => block && block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
    .trim();

  return {
    text,
    raw,
    usage: raw.usage || null,
    model: raw.model || body.model,
    profileId: cfg.profileId,
  };
}

async function completeJson({ system, user, schema, maxTokens = 2048, model, profileId, profile }) {
  const schemaHint = schema ? `\n\nThe output MUST be a JSON object matching this schema:\n${schema}\n` : '';
  const finalUser = `${user}${schemaHint}\n\nRespond with ONLY the JSON object, no prose, no markdown fences.`;
  const result = await completeText({ system, user: finalUser, maxTokens, model, profileId, profile });
  const text = result.text;

  let parsed = null;
  let parseError = null;
  const candidates = [
    text,
    text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, ''),
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      parsed = JSON.parse(candidate);
      parseError = null;
      break;
    } catch (e) {
      parseError = e;
    }
  }

  return { ...result, parsed, parseError };
}

module.exports = {
  completeJson,
  completeText,
  readConfig,
  findProfile,
};
