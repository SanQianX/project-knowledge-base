// Prompt Registry — reads/writes claude-prompts.json and renders templated prompts.
//
// File location: <KB_ROOT>/claude-prompts.json
// Schema: { schema: 'claude-prompts/v1', prompts: { <key>: { description, model, permissionMode,
//            allowedTools, systemPrompt, userPrompt } } }
//
// Variable interpolation: {{KEY}} placeholders in systemPrompt/userPrompt are replaced
// with values from the `vars` argument. Unknown placeholders are left untouched (so
// incomplete prompts don't crash — they show the raw token for diagnosis).

const fs = require('fs');
const path = require('path');

const { getDataDir } = require('./data-dir');
const KB_ROOT = getDataDir();
const PROMPTS_PATH = path.join(KB_ROOT, 'claude-prompts.json');
const BUNDLED_PROMPTS_PATH = path.resolve(__dirname, '..', '..', 'claude-prompts.json');
const SCHEMA = 'claude-prompts/v1';

const PLACEHOLDER_RE = /\{\{\s*([A-Z_][A-Z0-9_]*)\s*\}\}/g;

function normalizePromptsConfig(cfg) {
  const normalized = cfg && typeof cfg === 'object' ? cfg : {};
  if (!normalized.prompts || typeof normalized.prompts !== 'object') normalized.prompts = {};
  if (!normalized.schema) normalized.schema = SCHEMA;
  return normalized;
}

function readBundledPrompts() {
  if (!fs.existsSync(BUNDLED_PROMPTS_PATH)) return { schema: SCHEMA, prompts: {} };
  try {
    return normalizePromptsConfig(JSON.parse(fs.readFileSync(BUNDLED_PROMPTS_PATH, 'utf-8')));
  } catch {
    return { schema: SCHEMA, prompts: {} };
  }
}

function persistPrompts(cfg) {
  fs.mkdirSync(path.dirname(PROMPTS_PATH), { recursive: true });
  fs.writeFileSync(PROMPTS_PATH, JSON.stringify(cfg, null, 2) + '\n', 'utf-8');
}

function withBundledDefaults(cfg) {
  const current = normalizePromptsConfig(cfg);
  const bundled = readBundledPrompts();
  let changed = false;
  const prompts = { ...current.prompts };
  for (const [key, prompt] of Object.entries(bundled.prompts || {})) {
    if (!Object.prototype.hasOwnProperty.call(prompts, key)) {
      prompts[key] = prompt;
      changed = true;
    }
  }
  return {
    cfg: {
      schema: current.schema || bundled.schema || SCHEMA,
      prompts,
    },
    changed,
  };
}

function readPrompts() {
  if (!fs.existsSync(PROMPTS_PATH)) {
    const seeded = withBundledDefaults({ schema: SCHEMA, prompts: {} }).cfg;
    if (Object.keys(seeded.prompts).length) {
      persistPrompts(seeded);
    }
    return seeded;
  }
  try {
    const result = withBundledDefaults(JSON.parse(fs.readFileSync(PROMPTS_PATH, 'utf-8')));
    if (result.changed) persistPrompts(result.cfg);
    return result.cfg;
  } catch (e) {
    throw new Error(`failed to parse ${PROMPTS_PATH}: ${e.message}`);
  }
}

function writePrompts(cfg) {
  if (!cfg || typeof cfg !== 'object') throw new Error('prompts config must be an object');
  if (cfg.prompts && typeof cfg.prompts !== 'object') throw new Error('prompts field must be an object');
  const normalized = {
    schema: cfg.schema || SCHEMA,
    prompts: cfg.prompts || {},
  };
  for (const [key, val] of Object.entries(normalized.prompts)) {
    if (!key || typeof key !== 'string') throw new Error(`invalid prompt key: ${key}`);
    if (!val || typeof val !== 'object') throw new Error(`prompt "${key}" must be an object`);
    if (typeof val.userPrompt !== 'string' || !val.userPrompt) {
      throw new Error(`prompt "${key}" must have a non-empty userPrompt`);
    }
  }
  persistPrompts(normalized);
  return normalized;
}

function listPromptKeys() {
  return Object.keys(readPrompts().prompts);
}

function getPrompt(key) {
  const cfg = readPrompts();
  const p = cfg.prompts[key];
  if (!p) return null;
  return p;
}

function interpolate(text, vars) {
  if (typeof text !== 'string') return text;
  if (!vars || typeof vars !== 'object') return text;
  return text.replace(PLACEHOLDER_RE, (_, name) => {
    if (Object.prototype.hasOwnProperty.call(vars, name)) {
      const v = vars[name];
      return v == null ? '' : String(v);
    }
    return `{{${name}}}`;
  });
}

// Render the prompt for a given key, returning all fields needed to spawn claude.
// Returns null if key doesn't exist.
function renderPrompt(key, vars) {
  const p = getPrompt(key);
  if (!p) return null;
  const safeVars = vars || {};
  return {
    key,
    description: p.description || '',
    model: p.model || 'sonnet',
    permissionMode: p.permissionMode || 'bypassPermissions',
    allowedTools: Array.isArray(p.allowedTools) ? p.allowedTools.slice() : ['Read', 'Grep', 'Glob'],
    systemPrompt: interpolate(p.systemPrompt || '', safeVars),
    userPrompt: interpolate(p.userPrompt, safeVars),
  };
}

module.exports = {
  PROMPTS_PATH,
  BUNDLED_PROMPTS_PATH,
  SCHEMA,
  readPrompts,
  writePrompts,
  listPromptKeys,
  getPrompt,
  renderPrompt,
  interpolate,
};
