// Claude Session Runner — powers the embedded Claude Code terminal in the
// dashboard. Always uses the Claude Agent SDK (the `claude -p` subprocess
// path was removed; the SDK path applies the hardened claude_code system
// prompt and is the only supported mode).
//
// Used by server.js to stream Claude output as SSE events.
//
// Key design:
// - One session per "kickoff" (initial analyze or follow-up). Each session has a
//   server-generated sessionId; claude itself has a separate session_id captured from
//   the system/init event and used for --resume on follow-ups.
// - Listeners are SSE response objects. When an event arrives, it's emitted to all
//   current listeners AND appended to outputBuffer so late subscribers can replay.
// - NDJSON parsing uses a per-process line buffer — stdout chunks may split mid-line.
// - The SDK emits messages via an async iterator (not a child stdout pipe), so the
//   per-line buffer is fed stringified message objects one at a time.

const { spawn, spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { renderPrompt } = require('./prompt-registry');
const aiWorkspace = require('./ai-workspace');
const {
  normalizePermissionMode,
  evaluateAutomationToolUse,
} = require('./automation-config');
const { resolveContextWindow } = require('./model-context-windows');

// ---- session store ----
// Map<sessionId, Session>
const sessions = new Map();
const { getDataDir } = require('./data-dir');
const KB_ROOT = getDataDir();
const WORKBENCH_DIR = 'claude-workbench';

// End-of-session subscribers. Used by the automation queue to learn when an
// automation run finishes so it can promote the next queued run. Fires on
// idle/failed/aborted; non-automation sessions are filtered by subscribers
// themselves via session.metadata.automationRunId.
const sessionEndedCallbacks = new Set();
function onSessionEnded(cb) {
  if (typeof cb !== 'function') return () => {};
  sessionEndedCallbacks.add(cb);
  return () => sessionEndedCallbacks.delete(cb);
}

const TERMINAL_STATES = new Set(['idle', 'failed', 'aborted']);

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeErrorMessage(err) {
  if (!err) return '';
  if (typeof err === 'string') return err;
  if (typeof err.message === 'string' && err.message) return err.message;
  try { return JSON.stringify(err); } catch { return String(err); }
}

function isTransientClaudeError(err) {
  const msg = normalizeErrorMessage(err).toLowerCase();
  if (!msg) return false;
  return [
    '429',
    '502',
    '503',
    '504',
    '529',
    'rate limit',
    'too many requests',
    'overloaded',
    'overload',
    'busy',
    'capacity',
    'traffic',
    'timeout',
    'timed out',
    'etimedout',
    'econnreset',
    'econnrefused',
    'eai_again',
    '\u8bbf\u95ee\u91cf',
    '\u8bbf\u95ee\u592a\u5927',
    '\u9650\u6d41',
    '\u7e41\u5fd9',
    '\u7a0d\u540e',
    '\u8fc7\u8f7d',
  ].some(token => msg.includes(token));
}

function maxSdkRetries() {
  const raw = process.env.KB_CLAUDE_SDK_MAX_RETRIES || process.env.CLAUDE_SDK_MAX_RETRIES;
  const n = raw == null || raw === '' ? 2 : Number(raw);
  if (!Number.isFinite(n)) return 2;
  return Math.max(0, Math.min(5, Math.floor(n)));
}

function sdkRetryDelayMs(attempt) {
  const base = Number(process.env.KB_CLAUDE_SDK_RETRY_BASE_MS) || 1000;
  const delay = base * Math.pow(2, Math.max(0, attempt - 1));
  return Math.min(8000, Math.max(250, delay));
}

function newSessionId() {
  return 'sess-' + crypto.randomBytes(6).toString('hex');
}

function createSession({ projectSlug, projectPath, kbPath, promptKey, source = 'manual', metadata = null }) {
  const sessionId = newSessionId();
  const session = {
    sessionId,
    projectSlug,
    projectPath,
    kbPath: kbPath || path.join(KB_ROOT, 'projects', projectSlug),
    promptKey,
    state: 'idle',
    model: null,
    claudeSessionId: null,
    startedAt: new Date().toISOString(),
    endedAt: null,
    exitCode: null,
    listeners: new Set(),
    outputBuffer: [],
    subprocess: null,
    turns: 0,
    error: null,
    claudeEnv: {},
    pendingPermission: null,
    pendingTurn: null,
    pendingToolApproval: null,
    restored: false,
    source,
    metadata: metadata && typeof metadata === 'object' ? metadata : {},
    automation: !!(metadata && metadata.automation),
    automationRunId: metadata && metadata.automationRunId || null,
    permissionMode: 'default',
    safetyPolicy: null,
  };
  sessions.set(sessionId, session);
  persistSession(session);
  return session;
}

function sessionRecordPath(session) {
  if (!session || !session.projectSlug) return null;
  return path.join(aiWorkspace.ensureProjectAIPath(session.projectSlug), WORKBENCH_DIR, `${session.sessionId}.json`);
}

function toPersistedSession(session) {
  return {
    schema: 'claude-workbench-session/v1',
    sessionId: session.sessionId,
    projectSlug: session.projectSlug,
    projectPath: session.projectPath,
    kbPath: session.kbPath,
    promptKey: session.promptKey,
    runner: session.runner || 'cli',
    state: session.state,
    model: session.model,
    aiProfileId: session.aiProfileId || null,
    claudeSessionId: session.claudeSessionId,
    source: session.source || 'manual',
    automation: !!session.automation,
    automationRunId: session.automationRunId || null,
    metadata: session.metadata || {},
    permissionMode: session.permissionMode || 'default',
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    exitCode: session.exitCode,
    turns: session.turns,
    error: session.error,
    pendingPermission: session.pendingPermission,
    events: session.outputBuffer.slice(-5000),
    updatedAt: new Date().toISOString(),
  };
}

function persistSession(session) {
  const file = sessionRecordPath(session);
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(toPersistedSession(session), null, 2) + '\n', 'utf-8');
  } catch (e) {
    // Persistence should never interrupt the live Claude process.
  }
}

function readPersistedRecord(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (parsed && parsed.schema === 'claude-workbench-session/v1' && parsed.sessionId) return parsed;
  } catch {}
  return null;
}

function scanPersistedRecords(projectSlug = null) {
  let projectDirs = [];
  try {
    const projects = JSON.parse(fs.readFileSync(path.join(KB_ROOT, 'projects.json'), 'utf-8'));
    projectDirs = Object.entries(projects || {})
      .filter(([slug]) => !projectSlug || slug === projectSlug)
      .map(([slug, cfg]) => ({ name: slug, kbPath: cfg.kbPath || path.join(KB_ROOT, 'projects', slug) }));
  } catch {
    const projectsRoot = path.join(KB_ROOT, 'projects');
    try {
      projectDirs = fs.readdirSync(projectsRoot, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .filter(entry => !projectSlug || entry.name === projectSlug)
        .map(entry => ({ name: entry.name, kbPath: path.join(projectsRoot, entry.name) }));
    } catch { return []; }
  }
  const records = [];
  for (const entry of projectDirs) {
    const dirs = [
      path.join(aiWorkspace.projectAIPath(entry.name), WORKBENCH_DIR),
      path.join(entry.kbPath, '_ai', WORKBENCH_DIR),
    ];
    for (const dir of dirs) {
      let files = [];
      try { files = fs.readdirSync(dir); } catch { continue; }
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        const record = readPersistedRecord(path.join(dir, file));
        if (record) records.push(record);
      }
    }
  }
  return records.sort((a, b) => String(b.updatedAt || b.startedAt || '').localeCompare(String(a.updatedAt || a.startedAt || '')));
}

function findPersistedRecord(sessionId) {
  return scanPersistedRecords().find(record => record.sessionId === sessionId) || null;
}

function currentProjectKbPath(projectSlug) {
  try {
    const projects = JSON.parse(fs.readFileSync(path.join(KB_ROOT, 'projects.json'), 'utf-8'));
    const cfg = projects && projects[projectSlug];
    if (cfg && cfg.kbPath) return cfg.kbPath;
  } catch {}
  return null;
}

function restoreSessionFromDisk(sessionId) {
  if (sessions.has(sessionId)) return sessions.get(sessionId);
  const record = findPersistedRecord(sessionId);
  if (!record) return null;
  const liveState = ['running', 'spawning', 'pending-permission'].includes(record.state) ? 'idle' : (record.state || 'idle');
  // Always prefer the project's CURRENT kbPath from projects.json over the
  // value persisted when the session was first created. The KB root is
  // user-configurable (see knowledge-store.json) and projects can move between
  // roots; following the live config means restoring a session after a path
  // change still lands in the right working directory. Falls back to the
  // persisted value only when the project is no longer registered.
  const liveKbPath = currentProjectKbPath(record.projectSlug);
  const kbPath = liveKbPath || record.kbPath || path.join(KB_ROOT, 'projects', record.projectSlug);
  const kbPathChanged = !!liveKbPath && record.kbPath && liveKbPath !== record.kbPath;
  // When the working directory moves, the previous Claude conversation is
  // stored in the OLD cwd's session store and `--resume <id>` cannot find
  // it from the new cwd. Carrying the stale claudeSessionId forward would
  // just produce a "No conversation found" error on the next follow-up —
  // drop it (and the chat history) so the user starts a fresh turn in the
  // new directory.
  const inheritConversation = !kbPathChanged;
  const session = {
    sessionId: record.sessionId,
    projectSlug: record.projectSlug,
    projectPath: record.projectPath,
    kbPath,
    promptKey: record.promptKey,
    runner: record.runner || 'cli',
    state: liveState,
    model: record.model || null,
    aiProfileId: record.aiProfileId || null,
    claudeSessionId: inheritConversation ? (record.claudeSessionId || null) : null,
    startedAt: record.startedAt || new Date().toISOString(),
    endedAt: liveState === record.state ? record.endedAt || null : null,
    exitCode: record.exitCode ?? null,
    listeners: new Set(),
    outputBuffer: inheritConversation && Array.isArray(record.events) ? record.events : [],
    subprocess: null,
    turns: inheritConversation ? (record.turns || 0) : 0,
    error: inheritConversation ? (record.error || null) : null,
    claudeEnv: {},
    pendingPermission: null,
    pendingTurn: null,
    pendingToolApproval: null,
    restored: true,
    historyCleared: !inheritConversation,
    source: record.source || 'manual',
    metadata: record.metadata || {},
    automation: !!record.automation,
    automationRunId: record.automationRunId || null,
    permissionMode: record.permissionMode || 'default',
    safetyPolicy: null,
  };
  sessions.set(sessionId, session);
  if (liveState !== record.state || kbPathChanged) {
    emit(session, { type: 'claude/restored', fromState: record.state, state: liveState });
  }
  // Only broadcast active restorations so server boot doesn't flood the bus
  // with every persisted idle record.
  if (ACTIVE_STATES.has(record.state)) {
    _broadcastSessionChange(session, 'restore');
  }
  if (kbPathChanged) {
    emit(session, {
      type: 'claude/kbpath-updated',
      fromKbPath: record.kbPath,
      toKbPath: kbPath,
      historyCleared: true,
      message: `working directory moved to ${kbPath}; previous conversation history was cleared — send a new message to start a fresh session`,
    });
    persistSession(session);
  }
  return session;
}

function buildClaudeEnvFromProfile(profile) {
  const env = { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
  if (!profile || typeof profile !== 'object') return env;

  const apiKey = profile.apiKey || profile.authToken || profile.anthropicAuthToken || '';
  const baseUrl = profile.baseUrl || profile.apiBaseUrl || profile.anthropicBaseUrl || '';
  // CC-Switch-style per-tier model fields. Each alias falls back to
  // mainModel so an empty optional slot doesn't break the env.
  const mainModel = profile.mainModel || profile.model || '';
  const thinkingModel = profile.thinkingModel || mainModel;
  const haikuModel = profile.haikuModel || mainModel;
  const sonnetModel = profile.sonnetModel || mainModel;
  const opusModel = profile.opusModel || mainModel;
  const timeoutMs = profile.timeoutMs || process.env.API_TIMEOUT_MS || '';

  if (apiKey) env.ANTHROPIC_AUTH_TOKEN = String(apiKey);
  if (baseUrl) env.ANTHROPIC_BASE_URL = String(baseUrl);
  if (mainModel) env.ANTHROPIC_MODEL = String(mainModel);
  if (thinkingModel) env.ANTHROPIC_DEFAULT_THINKING_MODEL = String(thinkingModel);
  if (haikuModel) env.ANTHROPIC_DEFAULT_HAIKU_MODEL = String(haikuModel);
  if (sonnetModel) env.ANTHROPIC_DEFAULT_SONNET_MODEL = String(sonnetModel);
  if (opusModel) env.ANTHROPIC_DEFAULT_OPUS_MODEL = String(opusModel);
  if (timeoutMs) env.API_TIMEOUT_MS = String(timeoutMs);

  return env;
}

function profileMainModel(profile) {
  if (!profile || typeof profile !== 'object') return '';
  return String(profile.mainModel || profile.model || '').trim();
}

function applyAiProfileToSession(session, aiProfile) {
  if (!session) {
    return { resetConversation: false, model: session && session.model || null };
  }
  if (!aiProfile || typeof aiProfile !== 'object') {
    session.claudeEnv = buildClaudeEnvFromProfile(null);
    session.runner = 'sdk';
    return { resetConversation: false, model: session.model || null };
  }
  const previousProfileId = session.aiProfileId || null;
  const previousModel = session.model || null;
  const nextProfileId = aiProfile.id || previousProfileId || null;
  const nextEnv = buildClaudeEnvFromProfile(aiProfile);
  const nextModel = profileMainModel(aiProfile) || nextEnv.ANTHROPIC_MODEL || null;

  const profileChanged = !!(previousProfileId && nextProfileId && previousProfileId !== nextProfileId);
  const modelChanged = !!(previousModel && nextModel && previousModel !== nextModel);
  const resetConversation = !!(session.claudeSessionId && (profileChanged || modelChanged));

  if (resetConversation) {
    emit(session, {
      type: 'claude/conversation-reset',
      reason: profileChanged ? 'ai-profile-changed' : 'model-changed',
      fromAiProfileId: previousProfileId,
      toAiProfileId: nextProfileId,
      fromModel: previousModel,
      toModel: nextModel,
      message: 'AI profile or model changed; previous Claude conversation was cleared before the next turn.',
    });
    session.claudeSessionId = null;
  }

  session.aiProfileId = nextProfileId;
  session.claudeEnv = nextEnv;
  if (nextModel) session.model = nextModel;
  session.runner = 'sdk';
  session.contextWindow = resolveContextWindow({
    profileContextWindow: aiProfile && aiProfile.contextWindow,
    model: session.model || profileMainModel(aiProfile),
  });
  return { resetConversation, model: session.model || null };
}

// Pull the per-call SDK overrides (systemPrompt) from an AI profile.
// The legacy temperature/maxTokens profile fields were removed in the
// CC-Switch migration — they were silently dropped by the CLI path and
// are no longer wired into the SDK path either. Callers that need to
// tune sampling pass temperature/maxTokens at the call site.
function buildSdkOverridesFromProfile(profile) {
  if (!profile || typeof profile !== 'object') return {};
  const out = {};
  // Default to the hardened Claude Code system prompt when the profile
  // doesn't override — that's the whole point of switching to SDK, and it
  // matches what claudecodeui does. The user can override with an object
  // (e.g. {type:'preset',preset:'claude_code'}) or a plain string.
  if (profile.systemPrompt !== undefined) {
    out.systemPrompt = profile.systemPrompt;
  } else {
    out.systemPrompt = { type: 'preset', preset: 'claude_code' };
  }
  return out;
}

function getSession(sessionId) {
  return sessions.get(sessionId) || restoreSessionFromDisk(sessionId);
}

function sessionSummary(s) {
  return {
    sessionId: s.sessionId,
    projectSlug: s.projectSlug,
    promptKey: s.promptKey,
    runner: s.runner || 'cli',
    state: s.state,
    model: s.model,
    aiProfileId: s.aiProfileId || null,
    claudeSessionId: s.claudeSessionId,
    source: s.source || 'manual',
    automation: !!s.automation,
    automationRunId: s.automationRunId || null,
    permissionMode: s.permissionMode || 'default',
    startedAt: s.startedAt,
    endedAt: s.endedAt,
    exitCode: s.exitCode,
    turns: s.turns,
    pendingPermission: s.pendingPermission,
    restored: !!s.restored,
  };
}

function listSessions(filter = {}) {
  const projectSlug = filter.projectSlug || null;
  const byId = new Map();
  for (const record of scanPersistedRecords(projectSlug)) {
    byId.set(record.sessionId, sessionSummary({
      ...record,
      listeners: new Set(),
      outputBuffer: record.events || [],
      subprocess: null,
      pendingPermission: ['running', 'spawning'].includes(record.state) ? null : record.pendingPermission,
      restored: true,
    }));
  }
  for (const s of sessions.values()) {
    if (projectSlug && s.projectSlug !== projectSlug) continue;
    byId.set(s.sessionId, sessionSummary(s));
  }
  return [...byId.values()].sort((a, b) => String(b.startedAt || '').localeCompare(String(a.startedAt || '')));
}

function emit(session, event) {
  session.outputBuffer.push(event);
  if (session.outputBuffer.length > 5000) session.outputBuffer.shift();
  for (const listener of session.listeners) {
    try { listener(event); } catch { /* listener may be a dead SSE */ }
  }
  persistSession(session);
}

function setState(session, state, extra = {}) {
  session.state = state;
  if (state === 'ended' || state === 'failed' || state === 'aborted') {
    session.endedAt = new Date().toISOString();
  }
  emit(session, { type: 'claude/state', state, ...extra });
  _broadcastSessionChange(session, 'state');
  if (TERMINAL_STATES.has(state) && sessionEndedCallbacks.size > 0) {
    const snapshot = session;
    setImmediate(() => {
      for (const cb of sessionEndedCallbacks) {
        try { cb(snapshot); } catch { /* subscriber errors must not corrupt session state */ }
      }
    });
  }
}

const ACTIVE_STATES = new Set(['spawning', 'running', 'pending-permission']);
const listSubscribers = new Set();

function _emitList(event) {
  if (listSubscribers.size === 0) return;
  for (const cb of listSubscribers) {
    try { cb(event); } catch { /* dead subscriber; req.on('close') will clean up */ }
  }
}

function _broadcastSessionChange(session, kind) {
  if (!session) return;
  const summary = sessionSummary(session);
  _emitList({
    kind,
    sessionId: summary.sessionId,
    projectSlug: summary.projectSlug,
    state: summary.state,
    active: ACTIVE_STATES.has(summary.state),
    restored: !!summary.restored,
    startedAt: summary.startedAt,
    endedAt: summary.endedAt,
    exitCode: summary.exitCode,
    promptKey: summary.promptKey,
    source: summary.source,
  });
}

function subscribeList(callback) {
  if (typeof callback !== 'function') throw new Error('callback must be a function');
  listSubscribers.add(callback);
  return () => listSubscribers.delete(callback);
}

function newPermissionId() {
  return 'perm-' + crypto.randomBytes(6).toString('hex');
}

function resolvePermission(sessionId, requestId, decision) {
  const session = getSession(sessionId);
  if (!session) throw new Error(`session not found: ${sessionId}`);
  if (!session.pendingPermission || session.pendingPermission.requestId !== requestId) {
    throw new Error('permission request not found or already resolved');
  }
  const allow = decision && decision.allow === true;
  const resolvedAt = new Date().toISOString();
  emit(session, {
    type: 'claude/permission-resolved',
    requestId,
    allow,
    message: decision && decision.message || '',
    resolvedAt,
  });
  // SDK path: resolve the in-flight tool approval promise that was created
  // inside runSdkTurn's canUseTool hook. The CLI `pendingTurn` mechanism
  // is gone with the spawn path.
  if (session.pendingToolApproval && session.pendingToolApproval.requestId === requestId) {
    const approval = session.pendingToolApproval;
    session.pendingToolApproval = null;
    session.pendingPermission = null;
    setState(session, 'running', { message: allow ? 'tool permission approved' : 'tool permission denied', requestId });
    approval.resolve(allow
      ? { behavior: 'allow', updatedInput: approval.input, toolUseID: approval.toolUseID }
      : { behavior: 'deny', message: decision && decision.message || 'User denied tool use', toolUseID: approval.toolUseID });
    persistSession(session);
    return { ok: true, started: true, toolPermission: true };
  }
  if (!allow) {
    session.pendingPermission = { ...session.pendingPermission, status: 'denied', resolvedAt };
    setState(session, 'idle', { message: 'permission denied', requestId });
    session.pendingPermission = null;
    persistSession(session);
    return { ok: true, started: false };
  }
  // Legacy CLI fallback — kept so old session records on disk don't crash
  // if they're restored after the migration. New sessions never set
  // pendingTurn.
  if (session.pendingTurn) {
    const pending = session.pendingTurn;
    session.pendingTurn = null;
    setState(session, 'idle', { message: 'legacy CLI pending turn — please resend your message', requestId });
    persistSession(session);
    return { ok: true, started: false, legacy: true };
  }
  persistSession(session);
  return { ok: true, started: true };
}

// ---- NDJSON parsing (used by the SDK message stream) ----
function handleNdjsonLine(session, line, toolInputBuffers) {
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    emit(session, { type: 'claude/raw', text: line });
    return;
  }

  const t = parsed.type;

  if (t === 'system' && parsed.subtype === 'init') {
    if (parsed.session_id) session.claudeSessionId = parsed.session_id;
    if (parsed.model) session.model = typeof parsed.model === 'string' ? parsed.model : (parsed.model.id || parsed.model.name || null);
    emit(session, {
      type: 'claude/init',
      claudeSessionId: session.claudeSessionId,
      model: session.model,
      aiProfileId: session.aiProfileId || null,
      tools: parsed.tools || [],
      mcpServers: parsed.mcp_servers || [],
    });
    return;
  }

  if (t === 'stream_event' && parsed.event) {
    const ev = parsed.event;
    if (ev.type === 'message_start' && ev.message) {
      emit(session, { type: 'claude/message-start', role: ev.message.role });
      if (ev.message.usage) {
        emit(session, { type: 'claude/usage', usage: ev.message.usage });
      }
      return;
    }
    if (ev.type === 'content_block_start' && ev.content_block) {
      const cb = ev.content_block;
      if (cb.type === 'tool_use') {
        // Initialize the per-block input accumulator; emit nothing yet (input is empty).
        // The full input arrives via input_json_delta events and is emitted on content_block_stop.
        if (cb.id) toolInputBuffers.set(cb.id, '');
        emit(session, { type: 'claude/tool-use-start', id: cb.id, name: cb.name });
        return;
      }
      if (cb.type === 'thinking') {
        emit(session, { type: 'claude/thinking-start', id: cb.id });
        return;
      }
      return;
    }
    if (ev.type === 'content_block_delta' && ev.delta) {
      const d = ev.delta;
      if (d.type === 'text_delta') {
        emit(session, { type: 'claude/text-delta', text: d.text });
        return;
      }
      if (d.type === 'input_json_delta') {
        // Accumulate into the tool-use block; also emit a low-level delta for live UIs.
        if (ev.index != null && toolInputBuffers) {
          // We don't know block id here; emit raw delta
        }
        emit(session, { type: 'claude/tool-input-delta', text: d.partial_json });
        return;
      }
      if (d.type === 'thinking_delta') {
        emit(session, { type: 'claude/thinking-delta', text: d.thinking });
        return;
      }
      return;
    }
    if (ev.type === 'content_block_stop') {
      // Block ended — but we don't reliably know which block. Tool input emission is
      // best-effort: the assistant message envelope at message_delta carries final tools.
      return;
    }
    if (ev.type === 'message_delta' && ev.delta) {
      if (ev.delta.stop_reason) {
        emit(session, { type: 'claude/message-stop', stopReason: ev.delta.stop_reason });
      }
      if (ev.usage) {
        emit(session, { type: 'claude/usage', usage: ev.usage });
      }
      return;
    }
    if (ev.type === 'message_stop') {
      return;
    }
    return;
  }

  if (t === 'user' || t === 'assistant') {
    // On assistant turn boundaries, the full message (with completed tool_use blocks)
    // appears here. Emit any tool-use blocks we haven't fully captured yet.
    if (t === 'assistant' && parsed.message && Array.isArray(parsed.message.content)) {
      for (const block of parsed.message.content) {
        if (block && block.type === 'tool_use') {
          emit(session, {
            type: 'claude/tool-use',
            id: block.id,
            name: block.name,
            input: block.input || {},
          });
        }
      }
    }
    return;
  }

  if (t === 'result') {
    const event = {
      type: 'claude/result',
      subtype: parsed.subtype || null,
      costUsd: parsed.total_cost_usd,
      durationMs: parsed.duration_ms,
      result: typeof parsed.result === 'string' ? parsed.result : JSON.stringify(parsed.result),
      isError: parsed.is_error === true,
      usage: parsed.usage || null,
    };
    emit(session, event);
    return event;
  }

  emit(session, { type: 'claude/raw', json: parsed });
}

// ---- public API ----

// Start a Claude Code SDK session for the FIRST turn (initial analysis).
// The legacy `claude -p` subprocess path was removed — the SDK is the
// only supported mode and applies the hardened claude_code system prompt.
function startSession({ slug, projectPath, kbPath, promptKey, vars, aiProfile }) {
  const rendered = renderPrompt(promptKey, vars || {});
  if (!rendered) {
    throw new Error(`unknown prompt key: ${promptKey}`);
  }
  const session = createSession({ projectSlug: slug, projectPath, kbPath, promptKey });
  applyAiProfileToSession(session, aiProfile);
  _broadcastSessionChange(session, 'create');
  session.permissionMode = normalizePermissionMode(rendered.permissionMode);
  const sdkOverrides = buildSdkOverridesFromProfile(aiProfile);
  emit(session, {
    type: 'claude/system-prompt',
    text: rendered.systemPrompt,
    promptKey,
    aiProfileId: session.aiProfileId,
  });
  emit(session, {
    type: 'claude/user-prompt',
    text: rendered.userPrompt,
    promptKey,
    isInitial: true,
  });
  const turnOpts = {
    userPrompt: rendered.userPrompt,
    systemPrompt: rendered.systemPrompt,
    ...sdkOverrides,
    model: rendered.model,
    permissionMode: session.permissionMode,
    allowedTools: rendered.allowedTools,
    cwd: session.kbPath,
    env: session.claudeEnv,
    resumeSessionId: null,
  };
  startSdkTurn(session, turnOpts, false);
  return { sessionId: session.sessionId, pendingPermission: null, runner: 'sdk' };
}

function startChatSession({ slug, projectPath, kbPath, aiProfile, permissionMode = 'default' }) {
  if (!slug) throw new Error('slug required');
  if (!projectPath) throw new Error('projectPath required');
  const session = createSession({
    projectSlug: slug,
    projectPath,
    kbPath,
    promptKey: 'terminal-chat',
    source: 'terminal',
  });
  applyAiProfileToSession(session, aiProfile);
  session.permissionMode = normalizePermissionMode(permissionMode);
  emit(session, {
    type: 'claude/session-ready',
    promptKey: session.promptKey,
    aiProfileId: session.aiProfileId,
    permissionMode: session.permissionMode,
    message: 'Claude terminal session is ready. Send a message to start the first turn.',
  });
  _broadcastSessionChange(session, 'create');
  return { sessionId: session.sessionId, pendingPermission: null, runner: 'sdk' };
}

function startAutomationSession({
  slug,
  projectPath,
  kbPath,
  userPrompt,
  systemPrompt,
  aiProfile,
  permissionMode = 'default',
  allowedTools = ['Read', 'Grep', 'Glob'],
  safetyPolicy = null,
  metadata = {},
}) {
  if (!slug) throw new Error('slug required');
  if (typeof userPrompt !== 'string' || !userPrompt.trim()) throw new Error('userPrompt required');
  const session = createSession({
    projectSlug: slug,
    projectPath,
    kbPath,
    promptKey: 'post-commit-automation',
    source: metadata.source || 'git-hook',
    metadata,
  });
  applyAiProfileToSession(session, aiProfile);
  _broadcastSessionChange(session, 'create');
  session.permissionMode = normalizePermissionMode(permissionMode);
  session.safetyPolicy = safetyPolicy || null;
  session.automation = true;
  session.automationRunId = metadata.automationRunId || null;
  const sdkOverrides = buildSdkOverridesFromProfile(aiProfile);
  const effectiveSystemPrompt = systemPrompt || sdkOverrides.systemPrompt || { type: 'preset', preset: 'claude_code' };
  emit(session, {
    type: 'claude/system-prompt',
    text: effectiveSystemPrompt,
    promptKey: session.promptKey,
    aiProfileId: session.aiProfileId,
    automation: true,
  });
  emit(session, {
    type: 'claude/user-prompt',
    text: userPrompt,
    promptKey: session.promptKey,
    isInitial: true,
    automation: true,
  });
  if (process.env.KB_AUTOMATION_FAKE_CLAUDE === '1') {
    emit(session, { type: 'claude/result', result: 'fake automation completed', automation: true });
    setState(session, 'idle', { exitCode: 0, message: 'fake automation complete' });
    return { sessionId: session.sessionId, pendingPermission: null, runner: 'sdk', fake: true };
  }
  startSdkTurn(session, {
    userPrompt,
    systemPrompt: effectiveSystemPrompt,
    model: null,
    permissionMode: session.permissionMode,
    allowedTools,
    cwd: session.kbPath,
    resumeSessionId: null,
    env: session.claudeEnv,
    safetyPolicy,
  }, false);
  return { sessionId: session.sessionId, pendingPermission: null, runner: 'sdk' };
}

// Send a follow-up turn via the SDK. With a non-null claudeSessionId,
// runs as a resume. With a null claudeSessionId (e.g. after a kbPath
// change cleared the stale id), starts a fresh session while reusing
// the same session record.
async function sendInput(sessionId, text, aiProfile = null, opts = {}) {
  const session = getSession(sessionId);
  if (!session) throw new Error(`session not found: ${sessionId}`);
  if (session.subprocess) {
    throw new Error(`a subprocess is already running on session ${sessionId}`);
  }
  if (aiProfile) {
    applyAiProfileToSession(session, aiProfile);
  }
  const isFresh = !session.claudeSessionId;
  emit(session, { type: 'claude/user-prompt', text, isFollowUp: !isFresh, isFresh });
  const sdkOverrides = buildSdkOverridesFromProfile(aiProfile);
  session.permissionMode = normalizePermissionMode(opts.permissionMode || session.permissionMode || 'default');
  const envModel = session.claudeEnv && session.claudeEnv.ANTHROPIC_MODEL
    ? String(session.claudeEnv.ANTHROPIC_MODEL)
    : null;
  const turnOpts = {
    userPrompt: text,
    model: envModel || session.model || null,
    permissionMode: session.permissionMode,
    allowedTools: opts.allowedTools || ['Read', 'Grep', 'Glob', 'Bash', 'Edit'],
    cwd: session.kbPath,
    resumeSessionId: session.claudeSessionId,
    systemPrompt: sdkOverrides.systemPrompt || null,
    env: session.claudeEnv,
  };
  startSdkTurn(session, turnOpts, !isFresh);
  return { started: true, pendingPermission: null, runner: 'sdk' };
}

// Compute accumulated token usage for a session from its persisted
// claude/usage events. Returns { used, total, hasUsage }.
// Uses a max-not-sum strategy because the SDK emits usage on each
// message_start (initial input_tokens) and each message_delta (output
// deltas). Summing would double-count. hasUsage is false when the SDK
// has not yet emitted any usage block — the caller renders "—" in that
// case rather than guessing 0.0%.
function getSessionTokenUsage(sessionId) {
  const session = getSession(sessionId);
  const fallbackTotal = Number(process.env.CLAUDE_CONTEXT_WINDOW) || 200000;
  if (!session) return { used: 0, total: fallbackTotal, hasUsage: false };
  const ctxWin = Number(session.contextWindow);
  const total = Number.isFinite(ctxWin) && ctxWin > 0 ? Math.floor(ctxWin) : fallbackTotal;
  let used = 0;
  let sawUsage = false;
  for (const ev of session.outputBuffer || []) {
    if (ev && ev.type === 'claude/usage' && ev.usage) {
      sawUsage = true;
      const turn = Number(ev.usage.input_tokens || 0)
                 + Number(ev.usage.output_tokens || 0)
                 + Number(ev.usage.cache_creation_input_tokens || 0)
                 + Number(ev.usage.cache_read_input_tokens || 0);
      if (turn > used) used = turn;
    }
  }
  return { used, total, hasUsage: sawUsage };
}

function findClaudeExecutable() {
  // Prefer the .exe path the running Claude Code sets in the env — bypasses cmd.exe shim
  // entirely and avoids Windows shell quoting pitfalls on long prompts.
  if (process.env.CLAUDE_CODE_EXECPATH) {
    return { cmd: process.env.CLAUDE_CODE_EXECPATH, shell: false };
  }
  // Fallbacks
  if (process.platform === 'win32') {
    const npmRoot = process.env.APPDATA && require('path').join(process.env.APPDATA, 'npm');
    if (npmRoot) {
      const candidates = [
        require('path').join(npmRoot, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'),
        require('path').join(npmRoot, 'claude.cmd'),
      ];
      const fs = require('fs');
      for (const c of candidates) {
        if (fs.existsSync(c)) return { cmd: c, shell: c.endsWith('.cmd') };
      }
    }
    return { cmd: 'claude', shell: true };  // last resort
  }
  return { cmd: 'claude', shell: false };
}

function findClaudeExecutableForSdk(options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const exists = options.exists || fs.existsSync;
  const runCommand = options.runCommand || ((command, args) => spawnSync(command, args, {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 3000,
  }));
  const clean = file => String(file || '').trim().replace(/^"|"$/g, '');
  const isWindowsShellShim = file => {
    const candidate = clean(file);
    if (!candidate) return false;
    const extension = path.extname(candidate).toLowerCase();
    return !extension || ['.cmd', '.bat', '.ps1'].includes(extension);
  };
  const isSdkCompatibleWindowsFile = file => {
    const extension = path.extname(clean(file)).toLowerCase();
    return ['.exe', '.js', '.mjs', '.ts', '.tsx', '.jsx'].includes(extension);
  };
  const usable = file => {
    const candidate = clean(file);
    if (!candidate || !exists(candidate)) return null;
    if (platform === 'win32' && !isSdkCompatibleWindowsFile(candidate)) return null;
    return candidate;
  };
  const npmCliForShim = file => {
    const npmRoot = path.dirname(clean(file));
    const candidates = [
      path.join(npmRoot, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'),
      path.join(npmRoot, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js'),
    ];
    return candidates.map(usable).find(Boolean) || null;
  };
  const resolveCandidate = file => {
    const candidate = clean(file);
    if (!candidate) return null;
    if (platform === 'win32' && isWindowsShellShim(candidate)) return npmCliForShim(candidate);
    return usable(candidate);
  };

  const configured = resolveCandidate(env.CLAUDE_CODE_EXECPATH);
  if (configured) return { cmd: configured, shell: false, source: 'CLAUDE_CODE_EXECPATH' };

  if (platform === 'win32') {
    let discovered = [];
    try {
      const result = runCommand('where.exe', ['claude']);
      if (result && result.status === 0) discovered = String(result.stdout || '').split(/\r?\n/).filter(Boolean);
    } catch {}
    for (const found of discovered) {
      const candidate = resolveCandidate(found);
      if (candidate) return { cmd: candidate, shell: false, source: 'PATH' };
    }

    const npmRoot = env.APPDATA && path.join(env.APPDATA, 'npm');
    if (npmRoot) {
      const candidates = [
        path.join(npmRoot, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'),
        path.join(npmRoot, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js'),
      ];
      for (const file of candidates) {
        const candidate = usable(file);
        if (candidate) return { cmd: candidate, shell: false, source: 'npm-global' };
      }
    }
    return {
      cmd: null,
      shell: false,
      reason: 'Claude Code was not found. Install Claude Code on this computer or set CLAUDE_CODE_EXECPATH.',
    };
  }
  return { cmd: clean(env.CLAUDE_CODE_EXECPATH) || 'claude', shell: false, source: 'PATH' };
}

function spawnClaude(session, opts) {
  // Legacy `claude -p` subprocess path was removed in the CC-Switch
  // migration; the SDK is the only supported entry point. This stub is
  // kept only so any stale caller still gets a clear error rather than a
  // silent no-op. New code uses startSdkTurn directly.
  throw new Error('spawnClaude is no longer supported — use the Claude Agent SDK');
}

async function runSdkTurn(session, opts, isResume) {
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  const toolInputBuffers = new Map();
  const sdkPermissionMode = normalizePermissionMode(opts.permissionMode || session.permissionMode || 'default');
  session.permissionMode = sdkPermissionMode;
  const allowedTools = Array.isArray(opts.allowedTools) ? opts.allowedTools : [];
  const claudeBin = findClaudeExecutableForSdk();
  if (!claudeBin.cmd) throw new Error(claudeBin.reason);
  const sdkOptions = {
    cwd: opts.cwd,
    env: { ...process.env, ...(opts.env || {}), FORCE_COLOR: '0', NO_COLOR: '1' },
    model: opts.model,
    tools: { type: 'preset', preset: 'claude_code' },
    allowedTools,
    disallowedTools: [],
    settingSources: ['project', 'user', 'local'],
    includePartialMessages: true,
    systemPrompt: opts.systemPrompt || { type: 'preset', preset: 'claude_code' },
    permissionMode: sdkPermissionMode,
    allowDangerouslySkipPermissions: sdkPermissionMode === 'bypassPermissions' && !opts.safetyPolicy,
    canUseTool: async (toolName, input, context = {}) => {
      const toolUseID = context.toolUseID || null;
      if (opts.safetyPolicy) {
        const decision = evaluateAutomationToolUse(opts.safetyPolicy, toolName, input);
        emit(session, {
          type: 'claude/tool-policy',
          toolName,
          decision: decision.behavior,
          reason: decision.reason,
          automation: !!session.automation,
        });
        if (decision.behavior === 'allow') {
          return { behavior: 'allow', updatedInput: input, toolUseID };
        }
        return { behavior: 'deny', message: decision.reason || 'Denied by automation safety policy', toolUseID };
      }
      if (sdkPermissionMode === 'bypassPermissions') {
        return { behavior: 'allow', updatedInput: input, toolUseID };
      }
      if (sdkPermissionMode === 'acceptEdits' && ['Edit', 'Write', 'MultiEdit'].includes(toolName)) {
        return { behavior: 'allow', updatedInput: input, toolUseID };
      }
      if (sdkPermissionMode === 'plan' && ['Edit', 'Write', 'MultiEdit', 'Bash'].includes(toolName)) {
        return { behavior: 'deny', message: 'Plan mode does not allow file edits or shell commands', toolUseID };
      }
      const requestId = newPermissionId();
      const summary = {
        turnKind: 'tool-use',
        isResume,
        cwd: opts.cwd || '',
        model: opts.model || null,
        permissionMode: sdkOptions.permissionMode,
        allowedTools: [toolName],
        toolName,
        toolUseID,
        title: context.title || context.displayName || toolName,
        description: context.description || context.decisionReason || '',
        promptPreview: JSON.stringify(input || {}).slice(0, 500),
      };
      session.pendingPermission = {
        requestId,
        status: 'pending',
        createdAt: new Date().toISOString(),
        summary,
      };
      setState(session, 'pending-permission', { requestId, toolName, toolUseID: context.toolUseID || null });
      emit(session, { type: 'claude/permission-request', ...session.pendingPermission });
      return await new Promise((resolve) => {
        const cancel = () => {
          if (session.pendingToolApproval && session.pendingToolApproval.requestId === requestId) {
            session.pendingToolApproval = null;
            session.pendingPermission = null;
            resolve({ behavior: 'deny', message: 'Permission request cancelled', toolUseID });
          }
        };
        if (context.signal) {
          if (context.signal.aborted) return cancel();
          context.signal.addEventListener('abort', cancel, { once: true });
        }
        session.pendingToolApproval = {
          requestId,
          resolve,
          input,
          toolUseID,
        };
      });
    },
  };
  sdkOptions.pathToClaudeCodeExecutable = claudeBin.cmd;
  if (opts.resumeSessionId) sdkOptions.resume = opts.resumeSessionId;

  try {
    const retries = maxSdkRetries();
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      let queryInstance;
      const attemptToolInputBuffers = attempt === 0 ? toolInputBuffers : new Map();
      try {
        queryInstance = query({ prompt: opts.userPrompt, options: sdkOptions });
        session.subprocess = { kill: () => queryInstance.close && queryInstance.close() };
        let errorResult = null;
        for await (const message of queryInstance) {
          if (message.session_id) session.claudeSessionId = message.session_id;
          const event = handleNdjsonLine(session, JSON.stringify(message), attemptToolInputBuffers);
          if (event && event.type === 'claude/result' && event.isError) {
            errorResult = event.result || 'Claude Code returned an error result';
          }
        }
        session.subprocess = null;
        if (errorResult) {
          throw new Error(`Claude Code returned an error result: ${errorResult}`);
        }
        if (session.state !== 'aborted' && session.state !== 'failed') {
          setState(session, 'idle', { exitCode: 0, message: isResume ? 'follow-up complete' : 'turn complete, awaiting input or new analysis' });
          emit(session, { type: 'claude/turn-end', exitCode: 0 });
        }
        return;
      } catch (e) {
        session.subprocess = null;
        if (session.state === 'aborted') return;
        if (attempt < retries && isTransientClaudeError(e)) {
          const delayMs = sdkRetryDelayMs(attempt + 1);
          const message = normalizeErrorMessage(e);
          emit(session, {
            type: 'claude/retry',
            attempt: attempt + 1,
            maxRetries: retries,
            delayMs,
            message,
          });
          setState(session, 'running', {
            turn: session.turns,
            runner: 'sdk',
            retryAttempt: attempt + 1,
            maxRetries: retries,
          });
          await sleep(delayMs);
          if (session.state === 'aborted') return;
          continue;
        }
        throw e;
      }
    }
  } catch (e) {
    session.error = e.message;
    emit(session, { type: 'claude/error', message: e.message });
    setState(session, 'failed', { error: e.message });
  } finally {
    session.subprocess = null;
    session.pendingToolApproval = null;
    session.pendingPermission = null;
    persistSession(session);
  }
}

function startSdkTurn(session, opts, isResume) {
  session.pendingPermission = null;
  session.pendingTurn = null;
  setState(session, 'spawning', { turn: session.turns + 1, runner: 'sdk' });
  session.turns += 1;
  setState(session, 'running', { turn: session.turns, runner: 'sdk' });
  runSdkTurn(session, opts, isResume).catch(e => {
    session.error = e.message;
    emit(session, { type: 'claude/error', message: e.message });
    setState(session, 'failed', { error: e.message });
  });
}

function abort(sessionId) {
  const session = getSession(sessionId);
  if (!session) throw new Error(`session not found: ${sessionId}`);
  if (session.subprocess) {
    try {
      session.subprocess.kill();
    } catch {}
    setState(session, 'aborted', { reason: 'user-abort' });
    emit(session, { type: 'claude/aborted', reason: 'user-abort' });
  } else {
    session.pendingPermission = null;
    session.pendingTurn = null;
    setState(session, 'aborted', { reason: 'no-active-subprocess' });
  }
}

// Subscribe to live events. Callback receives each event as it arrives.
// Late subscribers also get replayed outputBuffer.
function subscribe(sessionId, onEvent) {
  const session = getSession(sessionId);
  if (!session) throw new Error(`session not found: ${sessionId}`);
  // replay buffer first
  for (const ev of session.outputBuffer) {
    try { onEvent(ev); } catch {}
  }
  session.listeners.add(onEvent);
  return () => {
    session.listeners.delete(onEvent);
  };
}

function getState(sessionId) {
  const s = getSession(sessionId);
  if (!s) return null;
  return {
    sessionId: s.sessionId,
    projectSlug: s.projectSlug,
    promptKey: s.promptKey,
    runner: s.runner || 'cli',
    state: s.state,
    model: s.model,
    aiProfileId: s.aiProfileId || null,
    claudeSessionId: s.claudeSessionId,
    source: s.source || 'manual',
    automation: !!s.automation,
    automationRunId: s.automationRunId || null,
    permissionMode: s.permissionMode || 'default',
    startedAt: s.startedAt,
    endedAt: s.endedAt,
    exitCode: s.exitCode,
    turns: s.turns,
    error: s.error,
    listenerCount: s.listeners.size,
    bufferedEvents: s.outputBuffer.length,
    pendingPermission: s.pendingPermission,
    restored: !!s.restored,
  };
}

function deleteSession(sessionId) {
  const s = sessions.get(sessionId);
  if (!s) return false;
  if (s.subprocess) {
    try { s.subprocess.kill(); } catch {}
  }
  sessions.delete(sessionId);
  try {
    const file = sessionRecordPath(s);
    if (file) fs.rmSync(file, { force: true });
  } catch {}
  return true;
}

// Periodically clean up old sessions with no listeners (memory hygiene)
function pruneOldSessions(maxAgeMs = 30 * 60 * 1000) {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (s.listeners.size === 0 && s.subprocess === null && s.endedAt) {
      const age = now - new Date(s.endedAt).getTime();
      if (age > maxAgeMs) sessions.delete(id);
    }
  }
}

setInterval(pruneOldSessions, 5 * 60 * 1000).unref();

// Sweep sessions that are still in an ACTIVE state but whose subprocess is
// gone. Without this, three known failure modes strand sessions in
// "running" forever:
//   1. dashboard restart kills the SDK parent query → claude.exe is orphaned
//      and no one calls setState(failed)
//   2. SIGKILL of the dashboard (or OOM) before the SDK's for-await loop
//      emitted its terminal message
//   3. child Claude.exe dies under a permission denial or API outage but the
//      parent query's error path never reaches setState(failed) (e.g. IPC
//      connection drops silently after the dashboard process exits)
//
// Symptom in the UI: a project keeps showing the pulsing "running" badge,
// and the embedded terminal view stays empty because no real subprocess is
// streaming into it. The sweeper demotes these to `failed` with a reason
// and emits a state-change event so subscribers (UI + automation queue)
// stop waiting on a session that will never finish.
//
// Threshold: by default 5 minutes. Tunable via KB_STALE_ACTIVE_MS env var
// for the test fixture to inject shorter windows.
function readStaleThresholdMs() {
  const raw = process.env.KB_STALE_ACTIVE_MS;
  const n = raw == null || raw === '' ? 5 * 60 * 1000 : Number(raw);
  if (!Number.isFinite(n)) return 5 * 60 * 1000;
  return Math.max(1000, Math.floor(n));
}

function lastActivityAt(record) {
  if (!record) return null;
  return record.updatedAt || record.startedAt || null;
}

function isStaleActive(record, thresholdMs, now) {
  if (!record) return false;
  if (!ACTIVE_STATES.has(record.state)) return false;
  const last = lastActivityAt(record);
  if (!last) return false;
  return now - new Date(last).getTime() > thresholdMs;
}

// Demote a session to `failed` with a clear reason. Reuses emit +
// _broadcastSessionChange so the UI sees the same lifecycle shape as a
// normal SDK-error end. Also fires onSessionEnded callbacks because
// automation queue (post-commit dispatcher) treats `failed` as a release
// signal for the next queued run.
function demoteSessionToFailed(session, reason, source) {
  session.state = 'failed';
  session.endedAt = new Date().toISOString();
  session.error = reason;
  session.subprocess = null;
  session.pendingToolApproval = null;
  session.pendingPermission = null;
  emit(session, {
    type: 'claude/state',
    state: 'failed',
    reason,
    source: source || 'stale-active-sweep',
  });
  _broadcastSessionChange(session, 'stale-active-sweep');
  if (sessionEndedCallbacks.size > 0) {
    const snapshot = session;
    setImmediate(() => {
      for (const cb of sessionEndedCallbacks) {
        try { cb(snapshot); } catch {}
      }
    });
  }
  persistSession(session);
}

// Sweep stale ACTIVE sessions from two sources:
//   * In-memory `sessions` Map: subprocess is null AND state stayed ACTIVE
//     past the threshold (e.g. a runtime orphan; in-memory state cannot
//     progress to terminal because the async loop is gone).
//   * Persisted records on disk: state stayed ACTIVE through at least one
//     dashboard restart cycle, and the corresponding live entry is not in
//     the in-memory Map. We rehydrate a minimal session to drive the
//     demotion emit + broadcast so the UI and any post-commit queue
//     subscribers see the transition.
//
// Returns a list of demoted sessionIds and the source ('memory' or
// 'persisted') for observability and for tests.
function demoteStaleActiveSessions(opts = {}) {
  const thresholdMs = opts.thresholdMs || readStaleThresholdMs();
  const now = Date.now();
  const demoted = [];

  // 1. In-memory sweep.
  for (const session of sessions.values()) {
    if (!ACTIVE_STATES.has(session.state)) continue;
    if (session.subprocess !== null) continue;
    const last = lastActivityAt(session);
    if (!last) continue;
    if (now - new Date(last).getTime() <= thresholdMs) continue;
    demoteSessionToFailed(
      session,
      'subprocess exited unexpectedly (subprocess=null while state=active)',
      'memory'
    );
    demoted.push({ sessionId: session.sessionId, source: 'memory' });
  }

  // 2. Persisted records sweep (covers dashboard-restart orphans).
  for (const record of scanPersistedRecords()) {
    if (!isStaleActive(record, thresholdMs, now)) continue;
    if (sessions.has(record.sessionId)) continue;
    const rehydrated = {
      sessionId: record.sessionId,
      projectSlug: record.projectSlug,
      projectPath: record.projectPath || null,
      kbPath: record.kbPath || null,
      promptKey: record.promptKey || null,
      runner: record.runner || 'cli',
      state: record.state,
      model: record.model || null,
      aiProfileId: record.aiProfileId || null,
      claudeSessionId: record.claudeSessionId || null,
      startedAt: record.startedAt || new Date().toISOString(),
      endedAt: null,
      exitCode: null,
      listeners: new Set(),
      outputBuffer: [],
      subprocess: null,
      turns: record.turns || 0,
      error: null,
      claudeEnv: {},
      pendingPermission: null,
      pendingTurn: null,
      pendingToolApproval: null,
      restored: true,
      historyCleared: true,
      source: record.source || 'manual',
      metadata: record.metadata || {},
      automation: !!record.automation,
      automationRunId: record.automationRunId || null,
      permissionMode: record.permissionMode || 'default',
      safetyPolicy: null,
    };
    sessions.set(record.sessionId, rehydrated);
    demoteSessionToFailed(
      rehydrated,
      'subprocess lost (server restart while session active)',
      'persisted'
    );
    demoted.push({ sessionId: record.sessionId, source: 'persisted' });
  }

  if (demoted.length) {
    if (typeof process !== 'undefined' && process.stderr) {
      const summary = demoted
        .map(d => `${d.sessionId}(${d.source})`)
        .slice(0, 20)
        .join(', ');
      process.stderr.write(
        `[claude-cli-runner] stale-active-sweep demoted ${demoted.length} session(s): ${summary}\n`
      );
    }
  }
  return demoted;
}

// Run once at module load (covers boot-time dashboard-restart orphans).
// Don't crash if it throws — a sweeper that takes down the dashboard is
// worse than the orphans it cleans up.
try {
  const bootDemoted = demoteStaleActiveSessions();
  if (bootDemoted.length && typeof process !== 'undefined' && process.stderr) {
    const summary = bootDemoted
      .map(d => `${d.sessionId}(${d.source})`)
      .slice(0, 10)
      .join(', ');
    process.stderr.write(
      `[claude-cli-runner] boot sweep demoted ${bootDemoted.length} stale active session(s): ${summary}\n`
    );
  }
} catch (e) {
  if (typeof process !== 'undefined' && process.stderr) {
    process.stderr.write(`[claude-cli-runner] boot sweep failed: ${e.message}\n`);
  }
}

// Periodic sweep (covers runtime orphans and new starts). 30s gives a
// reasonable tradeoff between responsiveness and noise.
setInterval(() => {
  try { demoteStaleActiveSessions(); }
  catch {}
}, 30 * 1000).unref();

module.exports = {
  createSession,
  startSession,
  startChatSession,
  startAutomationSession,
  buildClaudeEnvFromProfile,
  applyAiProfileToSession,
  buildSdkOverridesFromProfile,
  sendInput,
  resolvePermission,
  abort,
  subscribe,
  subscribeList,
  onSessionEnded,
  getSession,
  getState,
  listSessions,
  deleteSession,
  getSessionTokenUsage,
  findClaudeExecutableForSdk,
  isTransientClaudeError,
  demoteStaleActiveSessions,
  readStaleThresholdMs,
  ACTIVE_STATES,
  TERMINAL_STATES,
};
