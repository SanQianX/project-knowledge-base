'use strict';

const fs = require('fs');
const path = require('path');
const {
  normalizeContext, normalizeAttachments, normalizeAgentId, normalizeEffort, cleanId, PERMISSION_MODES, AGENTS,
} = require('../../contracts');
const { snapshotEvents, subscribeNormalized } = require('./event-stream');

const ACTIVE_STATES = new Set(['created', 'spawning', 'running', 'thinking', 'tool-running', 'pending-permission']);

class WorkbenchService {
  constructor(options) {
    this.runner = options.runner;
    this.profiles = options.profiles;
    this.contexts = options.contexts;
    this.attachments = options.attachments;
    this.projects = options.projects || null;
    this.sessionArchive = options.sessionArchive || null;
    this.captureSettings = options.captureSettings || null;
    this.onCaptureSettingsSaved = options.onCaptureSettingsSaved || null;
    this.agentDiscovery = options.agentDiscovery || null;
    this.modelContextWindows = options.modelContextWindows || null;
    this.modelDetection = options.modelDetection || null;
    this.apiPrefix = String(options.apiPrefix || '/api/claude-workbench/v1').replace(/\/$/, '');
    this.version = options.version || '0.3.0';
    this.maxSessions = Number(options.maxSessions || 50);
    this.maxConcurrentRuns = Number(options.maxConcurrentRuns || 4);
    this.testWorkspace = path.resolve(options.testWorkspace);
    this.auditFile = options.auditFile;
    this.timers = new Map();
    this.turnMonitors = new Map();
    this.sessionAgents = new Map();
    fs.mkdirSync(this.testWorkspace, { recursive: true });
  }

  health() {
    return {
      status: 'ok', version: this.version, apiVersion: 'v1',
      activeProcesses: this._activeCount(), sessions: this.runner.listSessions({}).length,
      time: new Date().toISOString(),
    };
  }

  runtime() {
    let executable = null;
    try { executable = this.runner.findClaudeExecutableForSdk(); } catch {}
    const command = executable && (executable.cmd || executable);
    return { runtime: 'claude-code', available: Boolean(executable), executable: command ? path.basename(String(command)) : null, transport: 'agent-sdk' };
  }

  // Live availability probing when a discovery provider is wired in,
  // otherwise fall back to what the injected runner can see.
  listAgents() {
    if (this.agentDiscovery) {
      return { agents: Object.values(this.agentDiscovery()) };
    }
    let claudeAvailable = false;
    try { claudeAvailable = Boolean(this.runner.findClaudeExecutableForSdk()); } catch {}
    return {
      agents: Object.keys(AGENTS).map(id => {
        const agent = AGENTS[id];
        return {
          id: agent.id, label: agent.label, transport: agent.transport,
          authModes: [...agent.authModes],
          capabilities: { ...agent.capabilities, generationParams: [...agent.capabilities.generationParams] },
          available: id === 'claude-code' ? claudeAvailable : false,
          version: null, reason: '',
        };
      }),
    };
  }

  listProfiles() { return { profiles: this.profiles.list() }; }
  getProfile(id) { return this.profiles.get(id); }
  saveProfile(input, id) { return this.profiles.save(input, id); }
  deleteProfile(id) { return this.profiles.delete(id); }
  setCredential(id, credential) { return this.profiles.setCredential(id, credential); }

  getCaptureSettings() {
    if (!this.captureSettings) return { schema: 'capture-settings/v1', terminalConversations: false };
    return this.captureSettings.read();
  }

  saveCaptureSettings(input = {}) {
    if (!this.captureSettings) {
      throw Object.assign(new Error('capture settings are not wired into this service'), { status: 501 });
    }
    const saved = this.captureSettings.save(input);
    // Push the new scope into the driver immediately: sessions started after
    // this call carry the matching AI_CODING_EVENT_BRIDGE_CAPTURE env.
    if (typeof this.onCaptureSettingsSaved === 'function') this.onCaptureSettingsSaved(saved.terminalConversations);
    return saved;
  }

  // ---- projects ----
  listProjects() {
    this._requireProjects();
    return { projects: this.projects.list() };
  }

  getProject(id) {
    this._requireProjects();
    const projectId = cleanId(id, 'projectId');
    const project = this.projects.get(projectId);
    if (!project) throw Object.assign(new Error('project not found'), { status: 404 });
    return project;
  }

  createProject(input = {}) {
    this._requireProjects();
    const project = this.projects.create(input);
    this.contexts.register(project.id, project.rootPath);
    this._audit('project-create', { projectId: project.id, rootPath: project.rootPath });
    return project;
  }

  renameProject(id, input = {}) {
    this._requireProjects();
    const projectId = cleanId(id, 'projectId');
    if (input.defaultAiProfileId) this.profiles.runtimeProfile(input.defaultAiProfileId);
    const project = this.projects.update(projectId, input);
    this._audit('project-rename', { projectId, name: project.name });
    return project;
  }

  removeProject(id, options = {}) {
    this._requireProjects();
    const projectId = cleanId(id, 'projectId');
    if (!this.projects.get(projectId)) throw Object.assign(new Error('project not found'), { status: 404 });
    const keepSessions = options.keepSessions === true;
    for (const session of this.runner.listSessions({ projectSlug: projectId })) {
      if (ACTIVE_STATES.has(session.state)) try { this.runner.abort(session.sessionId); } catch {}
      if (!keepSessions) {
        if (typeof this.runner.deleteSession === 'function') {
          try { this.runner.deleteSession(session.sessionId); } catch {}
        }
        this.sessionArchive && this.sessionArchive.forget(session.sessionId);
      }
      this.sessionAgents.delete(session.sessionId);
    }
    this.projects.remove(projectId);
    this.contexts.unregister && this.contexts.unregister(projectId);
    this._audit('project-remove', { projectId, keepSessions });
    return true;
  }

  _requireProjects() {
    if (!this.projects) throw Object.assign(new Error('project workspace support is not enabled'), { status: 501 });
  }

  // ---- session archive ----
  archiveSession(sessionId) {
    this._requireArchive();
    const id = cleanId(sessionId, 'sessionId');
    if (!this.runner.getState(id)) throw Object.assign(new Error('session not found'), { status: 404 });
    const record = this.sessionArchive.archive(id);
    this._audit('session-archive', { sessionId: id });
    return { sessionId: id, ...record };
  }

  restoreSession(sessionId) {
    this._requireArchive();
    const id = cleanId(sessionId, 'sessionId');
    if (!this.runner.getState(id)) throw Object.assign(new Error('session not found'), { status: 404 });
    const restored = this.sessionArchive.restore(id);
    this._audit('session-restore', { sessionId: id });
    return { sessionId: id, restored };
  }

  _requireArchive() {
    if (!this.sessionArchive) throw Object.assign(new Error('session archive support is not enabled'), { status: 501 });
  }

  listSessions(contextId, options = {}) {
    const id = cleanId(contextId, 'contextId');
    const includeArchived = Boolean(options.includeArchived);
    const all = this.runner.listSessions({ projectSlug: id });
    const visible = includeArchived || !this.sessionArchive
      ? all
      : all.filter(session => !this.sessionArchive.isArchived(session.sessionId));
    return visible.map((session, index) => this._summary(session, index === 0));
  }

  startSession(contextInput, aiProfileId, options = {}) {
    const context = normalizeContext(contextInput);
    if (this.runner.listSessions({}).length >= this.maxSessions) {
      throw Object.assign(new Error('session limit reached'), { status: 429 });
    }
    const resolved = this.contexts.resolve(context);
    const project = this.projects && this.projects.get(context.workspaceRef);
    const agentId = normalizeAgentId(options.agentId || context.agentId || project && project.defaultAgentId);
    const effort = normalizeEffort(options.effort);
    // null explicitly selects the agent's login; omission inherits the project.
    const profileChoice = aiProfileId !== undefined ? aiProfileId
      : context.aiProfileId !== undefined ? context.aiProfileId : project && project.defaultAiProfileId;
    const profileId = profileChoice ? cleanId(profileChoice, 'aiProfileId') : null;
    const inheritsProject = aiProfileId === undefined && context.aiProfileId === undefined;
    const selectedModel = options.model !== undefined ? options.model
      : context.model !== undefined ? context.model : inheritsProject && project ? project.defaultModel : undefined;
    const profile = this._runtimeProfile(profileId, selectedModel);
    const started = this.runner.startChatSession({
      slug: context.contextId,
      projectPath: resolved.workspacePath,
      kbPath: resolved.workspacePath,
      aiProfile: profile,
      permissionMode: options.permissionMode || profile.permissionMode || 'default',
      agentId,
      effort,
    });
    // CLI drivers recycle numeric ids after a restart; a fresh session must
    // not inherit the archived flag of an unrelated predecessor that happened
    // to hold the same id.
    if (this.sessionArchive && this.sessionArchive.isArchived(started.sessionId)) {
      this.sessionArchive.forget(started.sessionId);
    }
    this.sessionAgents.set(started.sessionId, agentId);
    const session = this.runner.getSession(started.sessionId);
    if (session) session.selectedModel = profile.mainModel || null;
    this._audit('session-start', { sessionId: started.sessionId, contextId: context.contextId, profileId, agentId });
    return this._summary(this.runner.getState(started.sessionId), true);
  }

  loadSession(sessionId) {
    const id = cleanId(sessionId, 'sessionId');
    const state = this.runner.getState(id);
    if (!state) throw Object.assign(new Error('session not found'), { status: 404 });
    const usage = this.runner.getSessionTokenUsage(id);
    return {
      session: this._summary(state, true),
      events: snapshotEvents(this.runner, id),
      permission: state.pendingPermission || null,
      permissionMode: state.permissionMode || 'default',
      tokenUsage: { ...usage, hasUsage: Boolean(usage && (usage.used || usage.inputTokens || usage.outputTokens)) },
    };
  }

  subscribe(sessionId, afterSequence, onEvent) {
    return subscribeNormalized(this.runner, cleanId(sessionId, 'sessionId'), Number(afterSequence || 0), onEvent);
  }

  async listCommands(sessionId) {
    const id = cleanId(sessionId, 'sessionId');
    const state = this.runner.getState(id);
    if (!state) throw Object.assign(new Error('session not found'), { status: 404 });
    if (typeof this.runner.listSupportedCommands !== 'function') return { commands: [] };
    const profile = this._profileForSession(id, state);
    const commands = await this.runner.listSupportedCommands(id, profile);
    return { commands: Array.isArray(commands) ? commands : [] };
  }

  readAttachment(sessionId, attachmentId) {
    const id = cleanId(sessionId, 'sessionId');
    if (!this.runner.getState(id)) throw Object.assign(new Error('session not found'), { status: 404 });
    const result = this.attachments && this.attachments.read(id, attachmentId);
    if (!result) throw Object.assign(new Error('attachment not found'), { status: 404 });
    return result;
  }

  async send(sessionId, text, options = {}, attachmentInput = []) {
    const id = cleanId(sessionId, 'sessionId');
    const state = this.runner.getState(id);
    if (!state) throw Object.assign(new Error('session not found'), { status: 404 });
    if (ACTIVE_STATES.has(state.state)) {
      throw Object.assign(new Error('session already has an active turn'), { status: 409 });
    }
    if (this._activeCount() >= this.maxConcurrentRuns) {
      throw Object.assign(new Error('runtime concurrency limit reached'), { status: 429 });
    }
    const value = String(text || '').trim();
    const attachments = normalizeAttachments(attachmentInput);
    if (!value && !attachments.length) throw Object.assign(new Error('text or attachments are required'), { status: 400 });
    if (value.length > 200000) throw Object.assign(new Error('input exceeds 200000 characters'), { status: 413 });
    const profile = this._profileForSession(id, state);
    const session = this.runner.getSession(id);
    const previousEventCount = session && session.outputBuffer ? session.outputBuffer.length : 0;
    const stored = this.attachments ? this.attachments.saveMany(id, attachments) : attachments;
    const displayAttachments = stored.map(item => ({
      id: item.id, name: item.name, mediaType: item.mediaType, size: item.size,
      width: item.width, height: item.height,
      url: `${this.apiPrefix}/sessions/${encodeURIComponent(id)}/attachments/${encodeURIComponent(item.id)}`,
    }));
    const runtimeAttachments = attachments.map((item, index) => ({ ...displayAttachments[index], data: item.data }));
    await this.runner.sendInput(id, value, profile, { ...(options || {}), attachments: runtimeAttachments, displayAttachments });
    this._armTimeout(id, profile.timeoutMs);
    this._watchTurn(id, previousEventCount);
    this._audit('input', { sessionId: id, contextId: state.projectSlug, characters: value.length, attachments: attachments.length, attachmentBytes: attachments.reduce((sum, item) => sum + item.size, 0) });
    return { accepted: true, sessionId: id };
  }

  resolvePermission(sessionId, requestId, decision) {
    const id = cleanId(sessionId, 'sessionId');
    const rid = cleanId(requestId, 'requestId');
    const result = this.runner.resolvePermission(id, rid, decision || {});
    this._audit('permission-resolve', { sessionId: id, requestId: rid, allow: decision && decision.allow === true });
    return result;
  }

  abort(sessionId, reason = 'user-abort') {
    const id = cleanId(sessionId, 'sessionId');
    if (!this.runner.getState(id)) throw Object.assign(new Error('session not found'), { status: 404 });
    this._clearTimeout(id);
    this._clearTurnMonitor(id);
    this.runner.abort(id);
    this._audit('abort', { sessionId: id, reason });
    return { accepted: true, sessionId: id };
  }

  setPermissionMode(sessionId, mode) {
    const id = cleanId(sessionId, 'sessionId');
    if (!PERMISSION_MODES.includes(mode)) throw Object.assign(new Error('invalid permission mode'), { status: 400 });
    const session = this.runner.getSession(id);
    if (!session) throw Object.assign(new Error('session not found'), { status: 404 });
    session.permissionMode = mode;
    this._audit('permission-mode', { sessionId: id, mode });
    return { sessionId: id, permissionMode: mode };
  }

  // Rebind an existing session to another AI profile/model (or back to the
  // agent's own login with aiProfileId null). The session and its history
  // survive; the next turn simply runs under the new selection.
  updateSessionSelection(sessionId, aiProfileId, model) {
    const id = cleanId(sessionId, 'sessionId');
    const state = this.runner.getState(id);
    if (!state) throw Object.assign(new Error('session not found'), { status: 404 });
    if (ACTIVE_STATES.has(state.state)) {
      throw Object.assign(new Error('session already has an active turn'), { status: 409 });
    }
    // _runtimeProfile resolves and validates the profile (404 unknown id,
    // 400 disabled/missing credential/invalid model) exactly like startSession.
    const profileId = aiProfileId ? cleanId(aiProfileId, 'aiProfileId') : null;
    const profile = this._runtimeProfile(profileId, model === undefined ? undefined : model);
    if (typeof this.runner.updateSelection === 'function') {
      this.runner.updateSelection(id, profile, profile.mainModel || null);
    } else {
      const session = this.runner.getSession(id);
      if (!session) throw Object.assign(new Error('session not found'), { status: 404 });
      session.aiProfileId = profileId;
      session.selectedModel = profile.mainModel || null;
    }
    this._audit('selection-update', { sessionId: id, contextId: state.projectSlug, profileId, model: profile.mainModel || null });
    return this._summary(this.runner.getState(id), true);
  }

  async testProfile(profileId) {
    const id = cleanId(profileId, 'profileId');
    const profile = this.profiles.runtimeProfile(id);
    return this._runProfileTest(profile, id);
  }

  async testProfileDraft(input = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || !input.profile) {
      throw Object.assign(new Error('profile is required'), { status: 400 });
    }
    const profile = this.profiles.runtimeDraft(input.profile, input.credential);
    return this._runProfileTest(profile, profile.id);
  }

  // Detect the models a provider draft can actually use (endpoint model list
  // joined with models.dev capability metadata). Uses the same draft+credential
  // resolution as testProfileDraft, so a blank credential falls back to the
  // stored secret of an already-saved profile.
  async detectProfileModels(input = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || !input.profile) {
      throw Object.assign(new Error('profile is required'), { status: 400 });
    }
    if (!this.modelDetection) {
      throw Object.assign(new Error('model detection is unavailable'), { status: 501 });
    }
    // Detection precedes model configuration, so an empty model list is fine here.
    const profile = this.profiles.runtimeDraft(input.profile, input.credential, { requireModel: false });
    const result = await this.modelDetection.detectModels({ profile });
    this._audit('profile-detect-models', { profileId: profile.id, count: result.models.length, sources: Object.keys(result.sources) });
    return result;
  }

  async _runProfileTest(profile, profileId) {
    const id = cleanId(profileId, 'profileId');
    const contextId = `profile-test-${Date.now().toString(36)}`;
    const startedAt = Date.now();
    const started = this.runner.startChatSession({
      slug: contextId, projectPath: this.testWorkspace, kbPath: this.testWorkspace,
      aiProfile: profile, permissionMode: 'default',
    });
    let firstEventMs = null;
    let preview = '';
    let unsubscribe = null;
    try {
      const outcome = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Claude Code profile test timed out')), Math.min(profile.timeoutMs, 300000));
        unsubscribe = this.runner.subscribe(started.sessionId, event => {
          if (firstEventMs == null && event.type !== 'claude/session-ready') firstEventMs = Date.now() - startedAt;
          if (event.type === 'claude/result') {
            clearTimeout(timeout);
            if (event.isError) {
              reject(new Error(String(event.result || event.message || event.error || 'Claude Code returned an error result')));
            } else {
              preview = String(event.result || event.text || '').slice(0, 500);
              resolve(event);
            }
          } else if (event.type === 'claude/error') {
            clearTimeout(timeout); reject(new Error(String(event.message || event.error || 'Claude Code runtime error')));
          } else if (event.type === 'claude/aborted') {
            clearTimeout(timeout); reject(new Error('Claude Code profile test was aborted'));
          }
        });
        this.runner.sendInput(started.sessionId, 'Reply with exactly: WORKBENCH_RUNTIME_OK', profile, { permissionMode: 'default' }).catch(error => {
          clearTimeout(timeout); reject(error);
        });
      });
      const state = this.runner.getState(started.sessionId);
      return {
        ok: true, runtime: 'claude-code', runtimeVerified: true, profileId: id,
        model: outcome.model || state && state.model || profile.models.default,
        firstEventMs: firstEventMs == null ? Date.now() - startedAt : firstEventMs,
        durationMs: Date.now() - startedAt, resultPreview: redact(preview),
      };
    } finally {
      try { unsubscribe && unsubscribe(); } catch {}
      try { this.runner.abort(started.sessionId); } catch {}
      try { this.runner.deleteSession(started.sessionId); } catch {}
    }
  }

  destroy() {
    for (const sessionId of this.timers.keys()) this._clearTimeout(sessionId);
    for (const sessionId of this.turnMonitors.keys()) this._clearTurnMonitor(sessionId);
    for (const session of this.runner.listSessions({})) {
      if (ACTIVE_STATES.has(session.state)) try { this.runner.abort(session.sessionId); } catch {}
    }
  }

  _runtimeProfile(profileId, selectedModel) {
    const profile = profileId ? this.profiles.runtimeProfile(profileId)
      : { id: null, models: { default: '' }, timeoutMs: 300000 };
    const model = selectedModel == null ? profile.models.default : String(selectedModel).trim();
    if (model.length > 128 || /[\r\n\x00]/.test(model)) throw Object.assign(new Error('model is invalid'), { status: 400 });
    return { ...profile, models: { ...profile.models, default: model }, mainModel: model };
  }

  _profileForSession(id, state) {
    const session = this.runner.getSession(id);
    const model = session && Object.prototype.hasOwnProperty.call(session, 'selectedModel')
      ? session.selectedModel : state.selectedModel || state.model;
    return this._runtimeProfile(state.aiProfileId, model);
  }

  _summary(session, active) {
    const agentId = session.agentId
      || (typeof this.runner.agentOf === 'function' ? this.runner.agentOf(session.sessionId) : null)
      || this.sessionAgents.get(session.sessionId)
      || 'claude-code';
    return {
      sessionId: session.sessionId,
      contextId: session.projectSlug,
      projectId: session.projectSlug,
      agentId,
      title: session.title || `Session ${String(session.sessionId).slice(-8)}`,
      active: Boolean(active), state: session.state, model: session.model || null,
      aiProfileId: session.aiProfileId || null, permissionMode: session.permissionMode || 'default',
      selectedModel: session.selectedModel || this.runner.getSession(session.sessionId)?.selectedModel || null,
      authSource: session.aiProfileId ? 'profile-injected' : 'agent-owned',
      providerName: session.aiProfileId ? this.profiles.get(session.aiProfileId)?.name || 'Unavailable provider' : AGENTS[agentId].label,
      archived: Boolean(this.sessionArchive && this.sessionArchive.isArchived(session.sessionId)),
      turns: Number(session.turns || 0), startedAt: session.startedAt,
      updatedAt: session.endedAt || session.startedAt, connectionState: 'connected',
    };
  }

  // Approximate context occupancy for the capacity bubble. Token totals come
  // from the driver; the per-category split is a characters/4 estimate over
  // the session event log and is explicitly flagged as such.
  contextUsage(sessionId) {
    const id = cleanId(sessionId, 'sessionId');
    const state = this.runner.getState(id);
    if (!state) throw Object.assign(new Error('session not found'), { status: 404 });
    const usage = this.runner.getSessionTokenUsage(id) || {};
    const contextWindow = this._contextWindowFor(state.model, this._sessionProfileContextWindow(id, state));
    const breakdown = this._estimateBreakdown(id);
    const used = Number(usage.used || usage.inputTokens || 0) || 0;
    return {
      sessionId: id,
      agentId: this._summary(state, false).agentId,
      model: state.model || null,
      contextWindow,
      used,
      percent: contextWindow ? Math.round((used / contextWindow) * 1000) / 10 : null,
      inputTokens: Number(usage.inputTokens || 0) || 0,
      outputTokens: Number(usage.outputTokens || 0) || 0,
      breakdown,
      estimated: true,
    };
  }

  _sessionProfileContextWindow(sessionId, state) {
    try {
      const profile = this._profileForSession(sessionId, state);
      return profile ? Number(profile.contextWindow) || 0 : 0;
    } catch { return 0; }
  }

  _contextWindowFor(model, profileContextWindow) {
    if (!model && !profileContextWindow) return 200000;
    if (this.modelContextWindows && typeof this.modelContextWindows.resolveContextWindow === 'function') {
      try {
        // The profile store defaults contextWindow to 200000; that default must
        // not shadow the recognition table (e.g. MiniMax → 1M). Only an explicit
        // non-default override wins over auto-detection.
        const explicit = Number(profileContextWindow) > 0 && Number(profileContextWindow) !== 200000 ? Number(profileContextWindow) : undefined;
        const resolved = this.modelContextWindows.resolveContextWindow({ profileContextWindow: explicit, model, fallback: 200000 });
        if (resolved) return resolved;
      } catch { /* fall through to the default */ }
    }
    return Number(profileContextWindow) > 0 ? Number(profileContextWindow) : 200000;
  }

  _estimateBreakdown(sessionId) {
    const session = this.runner.getSession(sessionId);
    const buckets = { messages: 0, tools: 0, other: 0 };
    if (!session || !Array.isArray(session.outputBuffer)) return buckets;
    for (const event of session.outputBuffer) {
      const text = String(event.text || event.result || event.output || '');
      const tokens = Math.ceil(text.length / 4);
      if (event.type === 'claude/user-prompt' || event.type === 'claude/text-delta') buckets.messages += tokens;
      else if (event.type === 'claude/tool-use' || event.type === 'claude/tool-result') buckets.tools += tokens;
      else buckets.other += tokens;
    }
    return buckets;
  }

  _activeCount() { return this.runner.listSessions({}).filter(item => ACTIVE_STATES.has(item.state)).length; }
  _armTimeout(sessionId, timeoutMs) {
    this._clearTimeout(sessionId);
    const timer = setTimeout(() => { try { this.abort(sessionId, 'runtime-timeout'); } catch {} }, Math.min(Number(timeoutMs) || 300000, 30 * 60 * 1000));
    timer.unref && timer.unref();
    this.timers.set(sessionId, timer);
  }
  _clearTimeout(sessionId) { const timer = this.timers.get(sessionId); if (timer) clearTimeout(timer); this.timers.delete(sessionId); }
  _watchTurn(sessionId, previousEventCount) {
    this._clearTurnMonitor(sessionId);
    let seen = 0;
    let unsubscribe = null;
    unsubscribe = this.runner.subscribe(sessionId, event => {
      seen += 1;
      if (seen <= previousEventCount) return;
      if (['claude/result', 'claude/error', 'claude/aborted'].includes(event && event.type)) {
        this._clearTimeout(sessionId);
        if (unsubscribe) { unsubscribe(); this.turnMonitors.delete(sessionId); }
      }
    });
    if (this.timers.has(sessionId)) this.turnMonitors.set(sessionId, unsubscribe);
    else try { unsubscribe(); } catch {}
  }
  _clearTurnMonitor(sessionId) {
    const unsubscribe = this.turnMonitors.get(sessionId);
    if (unsubscribe) try { unsubscribe(); } catch {}
    this.turnMonitors.delete(sessionId);
  }
  _audit(action, detail) {
    if (!this.auditFile) return;
    fs.mkdirSync(path.dirname(this.auditFile), { recursive: true });
    fs.appendFileSync(this.auditFile, `${JSON.stringify({ at: new Date().toISOString(), action, ...detail })}\n`, 'utf8');
  }
}

function redact(value) {
  return String(value || '').replace(/(?:sk|key|token)-[a-zA-Z0-9._-]{8,}/gi, '[REDACTED]');
}

module.exports = { WorkbenchService, ACTIVE_STATES, redact };
