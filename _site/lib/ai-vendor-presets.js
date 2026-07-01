// Built-in vendor presets for common Anthropic-compatible providers.
// baseUrl and model names verified against each vendor's public docs (2026-06).
// When a user picks one of these vendor names in the profile form, all fields
// below are auto-filled — they only need to supply an API key.
//
// baseUrl MUST be the /anthropic-compatible endpoint, not the OpenAI-compatible
// one, because the runner speaks the Anthropic Messages API. Wrong path → 404.
const AI_VENDOR_PRESETS = [
  {
    id: 'anthropic',
    name: 'Anthropic Claude',
    baseUrl: 'https://api.anthropic.com',
    mainModel: 'claude-sonnet-4-5',
    thinkingModel: 'claude-opus-4-7',
    haikuModel: 'claude-haiku-4-5',
    sonnetModel: 'claude-sonnet-4-5',
    opusModel: 'claude-opus-4-7',
    contextWindow: 200000,
    website: 'https://www.anthropic.com',
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    // Domestic (China) endpoint. minimax.io is the overseas domain with a
    // separate account system — API keys are NOT interchangeable. Domestic
    // users register at minimaxi.com, so we default to that.
    baseUrl: 'https://api.minimaxi.com/anthropic',
    mainModel: 'MiniMax-M3',
    thinkingModel: 'MiniMax-M3',
    haikuModel: 'MiniMax-M3',
    sonnetModel: 'MiniMax-M3',
    opusModel: 'MiniMax-M3',
    contextWindow: 1048576,
    website: 'https://platform.minimaxi.com',
  },
  {
    id: 'zhipu',
    name: '智谱 GLM',
    // Anthropic-compatible endpoint, not the OpenAI-style /api/paas/v4.
    baseUrl: 'https://open.bigmodel.cn/api/anthropic',
    mainModel: 'glm-4.6',
    thinkingModel: 'glm-4.6',
    haikuModel: 'glm-4.5-air',
    sonnetModel: 'glm-4.6',
    opusModel: 'glm-4.6',
    contextWindow: 1048576,
    website: 'https://open.bigmodel.cn',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    // Anthropic-compatible endpoint at /anthropic, not the bare domain.
    baseUrl: 'https://api.deepseek.com/anthropic',
    mainModel: 'deepseek-chat',
    thinkingModel: 'deepseek-reasoner',
    haikuModel: 'deepseek-chat',
    sonnetModel: 'deepseek-chat',
    opusModel: 'deepseek-reasoner',
    contextWindow: 128000,
    website: 'https://platform.deepseek.com',
  },
];

function listVendorPresetNames() {
  return AI_VENDOR_PRESETS.map(v => v.name);
}

// Match by name (case-insensitive) or id (case-insensitive). Returns the
// preset object or null. Custom vendor names that don't match return null —
// the caller then leaves the user-typed value alone.
function findVendorPresetByName(name) {
  const norm = String(name || '').trim().toLowerCase();
  if (!norm) return null;
  return AI_VENDOR_PRESETS.find(v =>
    v.name.toLowerCase() === norm || v.id.toLowerCase() === norm
  ) || null;
}

module.exports = {
  AI_VENDOR_PRESETS,
  listVendorPresetNames,
  findVendorPresetByName,
};
