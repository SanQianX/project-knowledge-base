'use strict';

const API_VERSION = 'v1';
const DEFAULT_API_PREFIX = `/api/claude-workbench/${API_VERSION}`;
const RUNTIME = 'claude-code';
const DEFAULT_AGENT = 'claude-code';
const EFFORT_LEVELS = Object.freeze(['low', 'medium', 'high', 'max']);
const PERMISSION_MODES = Object.freeze(['default', 'acceptEdits', 'plan', 'bypassPermissions']);
const IMAGE_MEDIA_TYPES = Object.freeze(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_IMAGES_PER_MESSAGE = 20;
const MAX_IMAGE_MESSAGE_BYTES = 20 * 1024 * 1024;
const TEXT_MEDIA_TYPES = Object.freeze(['text/plain', 'text/markdown', 'application/json', 'text/csv']);
const TEXT_FILE_TYPES = Object.freeze({ '.txt': 'text/plain', '.md': 'text/markdown', '.json': 'application/json', '.csv': 'text/csv' });
const MAX_TEXT_BYTES = 512 * 1024;
const MAX_ATTACHMENTS_PER_MESSAGE = MAX_IMAGES_PER_MESSAGE;
const MAX_ATTACHMENT_MESSAGE_BYTES = MAX_IMAGE_MESSAGE_BYTES;

// Capability matrix for every agent the terminal knows about. Drivers must
// declare the same shape; the UI hides controls the active agent does not
// support instead of failing.
const AGENTS = Object.freeze({
  'claude-code': Object.freeze({
    id: 'claude-code', label: 'Claude Code', transport: 'agent-sdk',
    authModes: Object.freeze(['profile-injected']),
    capabilities: Object.freeze({
      thinking: true, permissions: true, toolStream: true, images: true,
      resume: true, modelOverride: true, generationParams: Object.freeze(['effort']),
    }),
  }),
  codex: Object.freeze({
    id: 'codex', label: 'Codex', transport: 'cli-json',
    authModes: Object.freeze(['agent-owned', 'profile-injected']),
    capabilities: Object.freeze({
      thinking: false,
      // Permission modes map to exec sandboxes (read-only/workspace-write/danger).
      permissions: true,
      toolStream: true, images: true,
      resume: true, modelOverride: true,
      // The driver maps effort to `model_reasoning_effort` (low/medium/high/xhigh).
      generationParams: Object.freeze(['effort']),
    }),
  }),
  opencode: Object.freeze({
    id: 'opencode', label: 'OpenCode', transport: 'cli',
    authModes: Object.freeze(['agent-owned', 'profile-injected']),
    capabilities: Object.freeze({
      // The CLI streams reasoning parts; the driver maps them to thinking events.
      thinking: true,
      permissions: true, toolStream: true, images: true,
      resume: true, modelOverride: true, generationParams: Object.freeze([]),
    }),
  }),
  zcode: Object.freeze({
    id: 'zcode', label: 'ZCode', transport: 'cli',
    authModes: Object.freeze(['agent-owned', 'profile-injected']),
    capabilities: Object.freeze({
      // The bundled zcode CLI (app-server --stdio) exists, but the terminal has
      // no bridge driver yet; every capability stays off until one ships.
      thinking: false, permissions: false, toolStream: false, images: false,
      resume: false, modelOverride: false, generationParams: Object.freeze([]),
    }),
  }),
});
const AGENT_IDS = Object.freeze(Object.keys(AGENTS));

const EVENT_TYPES = Object.freeze([
  'workbench/stream-open', 'workbench/stream-reconnecting',
  'claude/init', 'claude/state', 'claude/session-ready', 'claude/user-prompt',
  'claude/system-prompt', 'claude/text-start', 'claude/text-delta', 'claude/result',
  'claude/thinking-start', 'claude/thinking-delta', 'claude/tool-use', 'claude/tool-result',
  'claude/permission-request', 'claude/permission-resolved', 'claude/usage',
  'claude/commands', 'claude/image', 'claude/retry', 'claude/error', 'claude/stderr', 'claude/aborted',
  'claude/selection-changed',
]);

function cleanId(value, field = 'id') {
  const id = String(value || '').trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(id)) {
    throw Object.assign(new Error(`${field} is invalid`), { status: 400 });
  }
  return id;
}

function normalizeContext(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw Object.assign(new Error('context must be an object'), { status: 400 });
  }
  return {
    contextId: cleanId(input.contextId, 'contextId'),
    contextType: input.contextType ? String(input.contextType).slice(0, 64) : undefined,
    displayName: input.displayName ? String(input.displayName).slice(0, 256) : undefined,
    workspaceRef: input.workspaceRef ? cleanId(input.workspaceRef, 'workspaceRef') : undefined,
    aiProfileId: input.aiProfileId === null ? null : input.aiProfileId ? cleanId(input.aiProfileId, 'aiProfileId') : undefined,
    model: input.model === null ? null : input.model ? String(input.model).trim().slice(0, 128) : undefined,
    metadata: input.metadata && typeof input.metadata === 'object' && !Array.isArray(input.metadata)
      ? input.metadata : undefined,
  };
}

function normalizeAgentId(value) {
  const id = String(value || DEFAULT_AGENT).trim();
  if (!AGENTS[id]) throw Object.assign(new Error(`unknown agent: ${id}`), { status: 400 });
  return id;
}

function normalizeEffort(value) {
  if (value == null || value === '') return undefined;
  const effort = String(value).trim();
  if (!EFFORT_LEVELS.includes(effort)) {
    throw Object.assign(new Error(`effort must be one of ${EFFORT_LEVELS.join(', ')}`), { status: 400 });
  }
  return effort;
}

function isAbsoluteLikePath(value) {
  return /^([a-zA-Z]:[\\/]|\\\\|\/)/.test(String(value || ''));
}

function normalizeProject(input = {}, idOverride) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw Object.assign(new Error('project must be an object'), { status: 400 });
  }
  const id = cleanId(idOverride || input.id, 'projectId');
  const name = String(input.name || '').trim().slice(0, 128);
  if (!name) throw Object.assign(new Error('project name is required'), { status: 400 });
  const rootPath = String(input.rootPath || '').trim();
  if (!isAbsoluteLikePath(rootPath)) {
    throw Object.assign(new Error('project rootPath must be an absolute local directory'), { status: 400 });
  }
  return {
    id, name, rootPath,
    ...(input.defaultAiProfileId !== undefined ? { defaultAiProfileId: input.defaultAiProfileId === null ? null : cleanId(input.defaultAiProfileId, 'defaultAiProfileId') } : {}),
    ...(input.defaultModel !== undefined ? { defaultModel: input.defaultModel === null ? null : String(input.defaultModel).trim().slice(0, 128) || null } : {}),
    ...(input.defaultAgentId !== undefined ? { defaultAgentId: normalizeAgentId(input.defaultAgentId) } : {}),
    createdAt: input.createdAt || new Date().toISOString(),
    updatedAt: input.updatedAt || input.createdAt || new Date().toISOString(),
  };
}

function normalizeModelEntries(input) {
  if (input == null) return [];
  if (!Array.isArray(input)) throw Object.assign(new Error('models.list must be an array'), { status: 400 });
  if (input.length > 100) throw Object.assign(new Error('models.list exceeds 100 entries'), { status: 400 });
  const seen = new Set();
  const entries = [];
  for (const item of input) {
    const raw = item && typeof item === 'object' && !Array.isArray(item) ? item : { id: item };
    const id = String(raw.id || raw.model || '').trim().slice(0, 128);
    if (!id) throw Object.assign(new Error('model entry id is required'), { status: 400 });
    if (seen.has(id)) continue;
    seen.add(id);
    const tags = Array.isArray(raw.tags)
      ? raw.tags.map(tag => String(tag).trim().slice(0, 32)).filter(Boolean).slice(0, 8)
      : [];
    // Detected context windows ride along so drivers (opencode limit.context)
    // and the capacity bubble can use them; invalid values are dropped.
    const contextWindow = Number(raw.contextWindow);
    const limits = Number.isFinite(contextWindow) && contextWindow > 0 && contextWindow <= 10_000_000
      ? { contextWindow: Math.floor(contextWindow) }
      : {};
    entries.push({ id, openaiId: String(raw.openaiId || id.replace(/\[1m\]$/i, '')).trim().slice(0, 128), label: String(raw.label || id).slice(0, 128), tags, ...limits });
  }
  return entries;
}

function normalizeProfile(input = {}, idOverride) {
  const id = cleanId(idOverride || input.id, 'profileId');
  const models = input.models && typeof input.models === 'object' ? input.models : {};
  const list = normalizeModelEntries(models.list);
  const fallbackModel = list.length ? list[0].id : '';
  const defaultModel = String(models.default || input.mainModel || input.model || fallbackModel).trim();
  return {
    id,
    name: String(input.name || id).trim().slice(0, 256),
    provider: String(input.provider || '').trim().slice(0, 128),
    protocol: String(input.protocol || 'anthropic-compatible').trim(),
    runtime: RUNTIME,
    baseUrl: String(input.baseUrl || '').trim().replace(/\/+$/, ''),
    openaiBaseUrl: resolveOpenAIBaseUrl(input),
    credentialRef: String(input.credentialRef || input.secretId || `credential:${id}`).trim(),
    models: {
      default: defaultModel,
      fast: String(models.fast || defaultModel).trim(),
      reasoning: String(models.reasoning || defaultModel).trim(),
      coding: String(models.coding || defaultModel).trim(),
      largeContext: String(models.largeContext || defaultModel).trim(),
      list,
    },
    contextWindow: positiveInt(input.contextWindow, 200000),
    timeoutMs: positiveInt(input.timeoutMs, 300000),
    permissionMode: PERMISSION_MODES.includes(input.permissionMode) ? input.permissionMode : 'default',
    systemPrompt: normalizeSystemPrompt(input.systemPrompt),
    enabled: input.enabled !== false,
  };
}

function positiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function resolveOpenAIBaseUrl(profile = {}) {
  const explicit = String(profile.openaiBaseUrl || '').trim().replace(/\/+$/, '');
  if (explicit) return explicit;
  const baseUrl = String(profile.baseUrl || '').trim().replace(/\/+$/, '');
  if (profile.protocol === 'openai-compatible') return baseUrl;
  let hostname = '';
  try { hostname = new URL(baseUrl).hostname; } catch {}
  if (hostname === 'api.minimax.io') return 'https://api.minimax.io/v1';
  if (hostname === 'api.minimaxi.com' || /minimax/i.test(String(profile.provider || ''))) return 'https://api.minimaxi.com/v1';
  return '';
}

function resolveOpenAIModel(profile = {}, model) {
  const id = String(model || profile.mainModel || profile.models && profile.models.default || '').trim();
  const entries = profile.models && profile.models.list;
  const entry = Array.isArray(entries) && entries.find(item => item.id === id);
  return String(entry && entry.openaiId || id.replace(/\[1m\]$/i, '')).trim();
}

function normalizeAttachments(input) {
  if (input == null) return [];
  if (!Array.isArray(input)) throw Object.assign(new Error('attachments must be an array'), { status: 400 });
  if (input.length > MAX_ATTACHMENTS_PER_MESSAGE) throw Object.assign(new Error(`at most ${MAX_ATTACHMENTS_PER_MESSAGE} attachments are allowed`), { status: 413 });
  let totalBytes = 0;
  return input.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw Object.assign(new Error(`attachment ${index + 1} is invalid`), { status: 400 });
    const name = String(item.name || `image-${index + 1}`).replace(/[\u0000-\u001f]/g, '').slice(0, 255);
    let mediaType = String(item.mediaType || item.mimeType || '').toLowerCase().split(';')[0].trim();
    const isImage = IMAGE_MEDIA_TYPES.includes(mediaType);
    if (!isImage) {
      const extension = (name.match(/\.[^.\\/]+$/) || [''])[0].toLowerCase();
      const textType = TEXT_FILE_TYPES[extension];
      if (!textType || !['', 'application/octet-stream', 'text/plain', textType].includes(mediaType)) {
        throw Object.assign(new Error(`attachment ${index + 1} has an unsupported type; use images or .txt, .md, .json, .csv files`), { status: 415 });
      }
      mediaType = textType;
    }
    const data = String(item.data || '').replace(/^data:[^;]+;base64,/, '').replace(/\s+/g, '');
    if (!data || !/^[a-zA-Z0-9+/]+={0,2}$/.test(data) || data.length % 4 === 1 || (data.includes('=') && data.length % 4 !== 0)) throw Object.assign(new Error(`attachment ${index + 1} has invalid base64 data`), { status: 400 });
    const size = Math.floor((data.length * 3) / 4) - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0);
    const maxBytes = isImage ? MAX_IMAGE_BYTES : MAX_TEXT_BYTES;
    if (size <= 0 || size > maxBytes) throw Object.assign(new Error(`attachment ${index + 1} exceeds ${maxBytes} bytes`), { status: 413 });
    const bytes = Buffer.from(data, 'base64');
    if (bytes.toString('base64').replace(/=+$/, '') !== data.replace(/=+$/, '')) throw Object.assign(new Error(`attachment ${index + 1} has invalid base64 data`), { status: 400 });
    if (!isImage) {
      try {
        const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        if (content.includes('\u0000')) throw new Error('binary content');
      } catch { throw Object.assign(new Error(`attachment ${index + 1} must contain UTF-8 text`), { status: 415 }); }
    }
    totalBytes += size;
    if (totalBytes > MAX_ATTACHMENT_MESSAGE_BYTES) throw Object.assign(new Error(`attachment payload exceeds ${MAX_ATTACHMENT_MESSAGE_BYTES} bytes`), { status: 413 });
    return {
      id: item.id ? cleanId(item.id, 'attachmentId') : undefined,
      name,
      mediaType,
      size,
      width: positiveInt(item.width, 0) || undefined,
      height: positiveInt(item.height, 0) || undefined,
      data,
    };
  });
}

function normalizeImageAttachments(input) {
  const attachments = normalizeAttachments(input);
  if (attachments.some(item => !IMAGE_MEDIA_TYPES.includes(item.mediaType))) throw Object.assign(new Error('unsupported image type'), { status: 415 });
  return attachments;
}

function appendTextAttachments(text, attachments = []) {
  const blocks = attachments.filter(item => TEXT_MEDIA_TYPES.includes(item.mediaType)).map(item => {
    const name = String(item.name).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `<attachment name="${name}">\n${Buffer.from(item.data, 'base64').toString('utf8')}\n</attachment>`;
  });
  return [String(text || ''), ...blocks].filter(Boolean).join('\n\n');
}

function normalizeSystemPrompt(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string' && value.trim()) return { type: 'custom', content: value };
  return { type: 'preset', preset: 'claude_code', content: '' };
}

module.exports = {
  API_VERSION, DEFAULT_API_PREFIX, RUNTIME, DEFAULT_AGENT, AGENTS, AGENT_IDS, EFFORT_LEVELS,
  PERMISSION_MODES, IMAGE_MEDIA_TYPES, TEXT_MEDIA_TYPES, TEXT_FILE_TYPES,
  MAX_IMAGE_BYTES, MAX_IMAGES_PER_MESSAGE, MAX_IMAGE_MESSAGE_BYTES, EVENT_TYPES,
  MAX_TEXT_BYTES, MAX_ATTACHMENTS_PER_MESSAGE, MAX_ATTACHMENT_MESSAGE_BYTES,
  cleanId, normalizeContext, normalizeProfile, normalizeProject, normalizeAgentId, normalizeEffort,
  normalizeModelEntries, normalizeImageAttachments, normalizeAttachments, appendTextAttachments,
  resolveOpenAIBaseUrl, resolveOpenAIModel, positiveInt,
};
