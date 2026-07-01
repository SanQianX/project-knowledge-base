// Per-family context window sizes (in tokens) for common models.
// Match strategy: lowercase the model name, then prefix-match — first hit wins.
// Entry order matters: more specific prefixes (e.g. 'claude-opus-4') precede
// broader ones (e.g. 'claude'). Keep specific entries above generic ones.
const MODEL_CONTEXT_WINDOWS = [
  // Anthropic Claude — full family 200K
  ['claude-opus-4', 200000],
  ['claude-sonnet-4', 200000],
  ['claude-haiku-4', 200000],
  ['claude-3-7', 200000],
  ['claude-3-5', 200000],
  ['claude-3', 200000],
  ['claude', 200000],

  // MiniMax
  ['minimax-m3', 1048576],
  ['minimax-m2', 1048576],
  ['minimax', 1048576],

  // Zhipu GLM
  ['glm-5', 1048576],
  ['glm-4.6', 1048576],
  ['glm-4.5', 128000],
  ['glm-4-plus', 128000],
  ['glm-4', 128000],
  ['glm', 128000],

  // DeepSeek
  ['deepseek-v3', 128000],
  ['deepseek-r1', 128000],
  ['deepseek', 64000],

  // OpenAI
  ['gpt-5', 200000],
  ['gpt-4.1', 1047576],
  ['gpt-4o', 128000],
  ['gpt-4-turbo', 128000],
  ['gpt-4', 8192],
  ['o3', 200000],
  ['o4-mini', 200000],
  ['o1', 200000],

  // Qwen
  ['qwen3', 131072],
  ['qwen-max', 32768],
  ['qwen', 32768],

  // Google Gemini
  ['gemini-2.5', 1048576],
  ['gemini-1.5', 1048576],
  ['gemini', 32768],
];

function normalizeModelName(model) {
  return String(model || '').trim().toLowerCase();
}

function lookupContextWindow(modelName) {
  const name = normalizeModelName(modelName);
  if (!name) return null;
  for (const [prefix, size] of MODEL_CONTEXT_WINDOWS) {
    if (name.startsWith(prefix)) return size;
  }
  return null;
}

// Resolution order: explicit profile override → model table → env var → fallback.
function resolveContextWindow({ profileContextWindow, model, env = process.env, fallback = 200000 } = {}) {
  const explicit = Number(profileContextWindow);
  if (Number.isFinite(explicit) && explicit > 0) return Math.floor(explicit);
  const tableHit = lookupContextWindow(model);
  if (tableHit) return tableHit;
  const envValue = Number(env && env.CLAUDE_CONTEXT_WINDOW);
  if (Number.isFinite(envValue) && envValue > 0) return Math.floor(envValue);
  return fallback;
}

module.exports = {
  MODEL_CONTEXT_WINDOWS,
  lookupContextWindow,
  resolveContextWindow,
};
