'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { createCliJsonRunner, resolveCliInvocation } = require('./cli-json-runner');
const { createOpenCodeServerBridge } = require('../bridges/opencode-server-bridge');
const {
  appendTextAttachments, normalizeAttachments, resolveOpenAIModel, resolveOpenAIBaseUrl,
} = require('../../../contracts');

const PROVIDER_ID = 'agent-terminal';
const PROVIDER_KEY_ENV = 'AGENT_TERMINAL_PROVIDER_API_KEY';
const ACTIVE_STATES = new Set(['running', 'thinking', 'tool-running']);

// OpenCode driver, two transports (mirrors the codex driver's shape):
//   serve (preferred) — one persistent `opencode serve` child per provider
//     spec speaking HTTP + SSE, giving true token streaming
//     (`message.part.delta`), live tool progress, per-session abort and
//     multi-turn sessions without respawning. Protocol verified live
//     against opencode 1.18.5 (see bridges/opencode-server-bridge.js).
//   cli-json (fallback) — the historical `opencode run --format json`
//     one-shot turns, used automatically when `spawn` is injected (the test
//     double contract), OPENCODE_TRANSPORT=cli is set, or the serve child
//     cannot start / keeps crashing.
//
// Auth is agent-owned (opencode auth) or profile-injected; workbench
// permission modes map to per-session opencode permission rulesets on serve
// (verified live: a denied permission removes the tool from the model's
// toolset) and to OPENCODE_CONFIG_CONTENT permission objects on the CLI.

function createOpenCodeDriver(options = {}) {
  // Test doubles inject `spawn` and script CLI subprocess behavior; honoring
  // that injection with the CLI path keeps the legacy contract intact.
  const forcedCli = options.bridge === false
    || process.env.OPENCODE_TRANSPORT === 'cli'
    || Boolean(options.spawn);
  if (!forcedCli && (options.serveSpawn || options.serveFetch || opencodeCommandExists(options.command || 'opencode'))) {
    return createServeOpenCodeDriver(options);
  }
  return createCliOpenCodeRunner(options);
}

// ---------------------------------------------------------------------------
// CLI transport (previous behavior, kept verbatim as the fallback)
// ---------------------------------------------------------------------------

function createCliOpenCodeRunner(options = {}) {
  return createCliJsonRunner({
    agentId: 'opencode',
    command: options.command || 'opencode',
    spawn: options.spawn,
    promptViaStdin: true,
    ...(options.persistence !== undefined ? { persistence: options.persistence } : {}),

    modelFor(profile) {
      const model = resolveOpenAIModel(profile);
      if (!model) return null;
      return /^[A-Za-z0-9._:/-]+$/.test(model) ? `${isInjected(profile) ? `${PROVIDER_ID}/` : ''}${model}` : null;
    },

    envFor(profile, session) {
      const env = {};
      if (isInjected(profile)) {
        env[PROVIDER_KEY_ENV] = profile.apiKey;
        env.OPENCODE_CONFIG_CONTENT = JSON.stringify(openCodeConfigFor(profile, session));
        return env;
      }
      env.OPENCODE_CONFIG_CONTENT = JSON.stringify(openCodeConfigFor(profile, session));
      return env;
    },

    spawnArgs({ projectPath, model, threadId, imagePaths, permissionMode }) {
      const args = ['run', '--format', 'json'];
      // The native exe ignores spawn cwd when driven over stdin on Windows and
      // resolves its project root from the parent process instead; --dir pins
      // the workspace explicitly for every platform.
      args.push('--dir', projectPath);
      if (model) args.push('-m', model);
      if (threadId) args.push('--session', threadId);
      if (permissionMode === 'plan') args.push('--agent', 'plan');
      // No effort flag: opencode's --variant selects agent variants, not
      // reasoning effort, so passing effort levels there would be a lie.
      for (const file of imagePaths || []) args.push('-f', file);
      return args;
    },

    parseLine: parseOpenCodeLine,
  });
}

// Shared config body for the CLI transport: permission object (per turn,
// because every turn respawns with fresh env) plus the injected provider.
function openCodeConfigFor(profile, session) {
  const unrestricted = session.permissionMode === 'bypassPermissions';
  const editable = unrestricted || session.permissionMode === 'acceptEdits';
  const config = { permission: {
    '*': 'allow', edit: editable ? 'allow' : 'deny', bash: editable ? 'allow' : 'deny',
    external_directory: unrestricted ? 'allow' : 'deny', question: 'deny',
  } };
  if (isInjected(profile)) {
    const endpoint = resolveOpenAIBaseUrl(profile);
    if (!endpoint) throw new Error('the selected provider needs an OpenAI base URL for OpenCode');
    config.provider = injectedProviderConfig(profile, endpoint);
  }
  return config;
}

function injectedProviderConfig(profile, endpoint) {
  const model = resolveOpenAIModel(profile);
  const entry = profile.models && Array.isArray(profile.models.list)
    ? profile.models.list.find(item => item.id === profile.models.default) : null;
  return { [PROVIDER_ID]: {
    npm: '@ai-sdk/openai-compatible', name: profile.name || 'Agent Terminal',
    options: { baseURL: endpoint, apiKey: `{env:${PROVIDER_KEY_ENV}}` },
    models: { [model]: { name: model, tool_call: true,
      // A custom provider has no models.dev capability entry. Permit
      // image transport; the selected endpoint validates model support.
      attachment: true, modalities: { input: ['text', 'image'], output: ['text'] },
      ...(entry && entry.contextWindow ? { limit: { context: entry.contextWindow, output: 8192 } } : {}),
    } },
  } };
}

// ---------------------------------------------------------------------------
// serve transport
// ---------------------------------------------------------------------------

function createServeOpenCodeDriver(options = {}) {
  const command = options.command || 'opencode';
  const log = typeof options.log === 'function' ? options.log : () => {};
  const sessions = new Map();
  const opencodeIds = new Map(); // opencode session id (ses_...) -> driver sessionId
  // The CLI fallback runner: `cliSpawn` lets tests script fallback turns
  // without `spawn`, which would itself force the CLI transport.
  const cliRunner = createCliOpenCodeRunner({ ...options, spawn: options.cliSpawn });
  const persist = resolveServePersistence(options);
  let serveDiskIndex = null;
  let nextId = 1;
  let mode = 'serve';
  let bridge = null;
  let bridgeSpecKey = null;
  let bridgeFailures = 0;

  function summary(session) {
    return {
      sessionId: session.sessionId,
      projectSlug: session.projectSlug,
      state: session.state,
      model: session.model,
      selectedModel: session.selectedModel,
      aiProfileId: session.aiProfileId,
      permissionMode: session.permissionMode,
      turns: session.turns,
      startedAt: session.startedAt,
      endedAt: session.endedAt,
      pendingPermission: session.pendingPermission,
    };
  }

  function emit(session, event) {
    session.outputBuffer.push(event);
    if (session.outputBuffer.length > MAX_SERVE_PERSISTED_EVENTS) session.outputBuffer.shift();
    for (const listener of session.listeners) {
      try { listener(event); } catch { /* listener errors never break the turn */ }
    }
  }

  function setState(session, state) {
    session.state = state;
    emit(session, { type: 'claude/state', state, turn: session.turns });
  }

  function emitDiag(session, event) {
    const text = event.text != null ? event.text : event.message;
    if (text === session.lastDiag) return;
    session.lastDiag = String(text == null ? '' : text);
    emit(session, event);
  }

  function addUsage(session, usage) {
    if (!usage) return;
    const input = Number(usage.inputTokens || usage.input || 0) || 0;
    const output = Number(usage.outputTokens || usage.output || 0) || 0;
    const cached = Number(usage.cachedTokens || (usage.cache && usage.cache.read) || 0) || 0;
    session.usage.inputTokens += input;
    session.usage.outputTokens += output;
    session.usage.cachedTokens += cached;
    if (session.turnUsage) {
      session.turnUsage.inputTokens += input;
      session.turnUsage.outputTokens += output;
      session.turnUsage.cachedTokens += cached;
      const turnTotal = session.turnUsage.inputTokens + session.turnUsage.outputTokens + session.turnUsage.cachedTokens;
      session.peakTurnTokens = Math.max(session.peakTurnTokens || 0, turnTotal);
    }
  }

  // ---- serve session persistence (shared cli-sessions directory) -----------
  // Pure serve sessions never touch the CLI runner, so without this store a
  // restart wiped them from the sidebar. Records live beside the CLI ones but
  // carry their own schema; the opencode session id (ses_...) is stored as
  // threadId so the next turn continues the server-side conversation.

  function serveRecordFile(sessionId) {
    return path.join(persist.dir, `${safeFileStem(sessionId)}.json`);
  }

  function readServeRecord(file) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (parsed && parsed.schema === SERVE_PERSIST_SCHEMA && parsed.agentId === 'opencode'
        && parsed.transport === 'serve' && typeof parsed.sessionId === 'string' && parsed.sessionId) return parsed;
    } catch { /* corrupt or foreign records are skipped, never fatal */ }
    return null;
  }

  function syncServeDiskIndex() {
    if (!persist.enabled) return null;
    if (!serveDiskIndex) serveDiskIndex = new Map();
    else serveDiskIndex.clear();
    let names = [];
    try { names = fs.readdirSync(persist.dir).filter(name => name.endsWith('.json')); } catch { return serveDiskIndex; }
    for (const name of names) {
      const file = path.join(persist.dir, name);
      const record = readServeRecord(file);
      if (record) serveDiskIndex.set(record.sessionId, { file, summary: persistedServeSummary(record) });
    }
    return serveDiskIndex;
  }

  function persistedServeSummary(record) {
    return {
      sessionId: record.sessionId,
      projectSlug: record.projectSlug,
      state: 'idle', // a restart killed any live turn
      model: record.model || null,
      selectedModel: record.selectedModel || null,
      aiProfileId: record.aiProfileId || null,
      permissionMode: record.permissionMode || 'default',
      turns: Number(record.turns) || 0,
      startedAt: record.startedAt || '',
      endedAt: record.endedAt || null,
      pendingPermission: null,
    };
  }

  function persistServeSession(session) {
    if (!persist.enabled) return;
    try {
      const file = serveRecordFile(session.sessionId);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `${JSON.stringify({
        schema: SERVE_PERSIST_SCHEMA,
        agentId: 'opencode',
        transport: 'serve',
        sessionId: session.sessionId,
        projectSlug: session.projectSlug,
        projectPath: session.projectPath,
        state: session.state,
        model: session.model,
        selectedModel: session.selectedModel,
        aiProfileId: session.aiProfileId,
        permissionMode: session.permissionMode,
        effort: session.effort || null,
        title: session.title || null,
        turns: session.turns,
        startedAt: session.startedAt,
        endedAt: session.endedAt,
        // The opencode session id (ses_...): prompting it again resumes the
        // server-side conversation after a restart.
        threadId: session.opencodeSessionId || null,
        lastResult: session.lastResult || '',
        usage: { ...session.usage },
        peakTurnTokens: session.peakTurnTokens || 0,
        events: session.outputBuffer.slice(-MAX_SERVE_PERSISTED_EVENTS),
        updatedAt: new Date().toISOString(),
      })}\n`, 'utf8');
      if (serveDiskIndex) serveDiskIndex.set(session.sessionId, { file: serveRecordFile(session.sessionId), summary: summary(session) });
    } catch {
      // Read-only home or full disk degrades to memory-only behavior.
      persist.enabled = false;
      serveDiskIndex = null;
    }
  }

  // Only ever removes OUR record: a CLI mirror may take over the session id.
  function removeServeRecord(sessionId) {
    if (serveDiskIndex) serveDiskIndex.delete(sessionId);
    if (!persist.enabled) return;
    try {
      const file = serveRecordFile(sessionId);
      if (fs.existsSync(file) && readServeRecord(file)) fs.rmSync(file, { force: true });
    } catch { /* already gone */ }
  }

  function restoreServeSession(id) {
    if (!persist.enabled) return null;
    const index = syncServeDiskIndex();
    const entry = index && index.get(id);
    if (!entry) return null;
    const record = readServeRecord(entry.file);
    if (!record || record.sessionId !== id) { index.delete(id); return null; }
    const session = {
      sessionId: record.sessionId,
      projectSlug: record.projectSlug,
      projectPath: record.projectPath,
      state: 'idle',
      model: record.model || null,
      selectedModel: record.selectedModel || null,
      aiProfileId: record.aiProfileId || null,
      permissionMode: record.permissionMode || 'default',
      effort: record.effort || null,
      title: record.title || null,
      turns: Number(record.turns) || 0,
      startedAt: record.startedAt || new Date().toISOString(),
      endedAt: record.endedAt || null,
      pendingPermission: null,
      outputBuffer: Array.isArray(record.events) ? record.events.slice(-MAX_SERVE_PERSISTED_EVENTS) : [],
      listeners: new Set(),
      opencodeSessionId: record.threadId || null,
      currentTurn: null,
      lastResult: record.lastResult || '',
      lastDiag: '',
      usage: {
        inputTokens: Number(record.usage && record.usage.inputTokens) || 0,
        outputTokens: Number(record.usage && record.usage.outputTokens) || 0,
        cachedTokens: Number(record.usage && record.usage.cachedTokens) || 0,
      },
      peakTurnTokens: Number(record.peakTurnTokens) || 0,
      turnUsage: null,
      cliMirrorId: null,
      pinnedCli: false,
      turnPromise: Promise.resolve(),
    };
    sessions.set(id, session);
    return session;
  }

  const runner = {
    agentId: 'opencode',

    startChatSession({ slug, projectPath, aiProfile, permissionMode, effort, title }) {
      if (!slug) throw new Error('slug required');
      if (!projectPath) throw new Error('projectPath required');
      const sessionId = nextDriverSessionId();
      const session = {
        sessionId,
        projectSlug: slug,
        projectPath,
        state: 'idle',
        model: cliModelFor(aiProfile),
        selectedModel: aiProfile && (aiProfile.mainModel || aiProfile.models && aiProfile.models.default) || '',
        aiProfileId: aiProfile && aiProfile.id,
        permissionMode: permissionMode || 'default',
        effort: effort || null,
        title: title || null,
        turns: 0,
        startedAt: new Date().toISOString(),
        endedAt: null,
        pendingPermission: null,
        outputBuffer: [],
        listeners: new Set(),
        opencodeSessionId: null,
        currentTurn: null,
        lastResult: '',
        lastDiag: '',
        usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
        peakTurnTokens: 0,
        turnUsage: null,
        cliMirrorId: null,
        turnPromise: Promise.resolve(),
      };
      sessions.set(sessionId, session);
      emit(session, {
        type: 'claude/session-ready',
        model: session.model,
        aiProfileId: session.aiProfileId,
        permissionMode: session.permissionMode,
        message: 'opencode session is ready. Send a message to start the first turn.',
      });
      persistServeSession(session);
      return { sessionId };
    },

    listSessions(filter = {}) {
      const byId = new Map();
      const boundMirrors = new Set();
      for (const session of sessions.values()) {
        if (filter.projectSlug && session.projectSlug !== filter.projectSlug) continue;
        byId.set(session.sessionId, summary(session));
        if (session.cliMirrorId) boundMirrors.add(session.cliMirrorId);
      }
      const extraSources = [cliRunner.listSessions(filter)];
      const serveIndex = syncServeDiskIndex();
      if (serveIndex) {
        extraSources.push([...serveIndex.values()]
          .map(entry => entry.summary)
          .filter(item => !filter.projectSlug || item.projectSlug === filter.projectSlug));
      }
      for (const source of extraSources) {
        for (const item of source) {
          if (byId.has(item.sessionId) || boundMirrors.has(item.sessionId)) continue;
          byId.set(item.sessionId, item);
        }
      }
      return [...byId.values()];
    },

    getState(id) {
      const session = sessions.get(id) || restoreServeSession(id);
      if (!session) return cliRunner.getState(id);
      return {
        ...summary(session),
        listenerCount: session.listeners.size,
        bufferedEvents: session.outputBuffer.length,
      };
    },

    getSession(id) { return sessions.get(id) || restoreServeSession(id) || cliRunner.getSession(id); },

    getSessionTokenUsage(id) {
      const session = sessions.get(id) || restoreServeSession(id);
      if (!session) return cliRunner.getSessionTokenUsage(id);
      if (session.cliMirrorId) return cliRunner.getSessionTokenUsage(session.cliMirrorId);
      const { inputTokens, outputTokens } = session.usage;
      const used = session.peakTurnTokens || 0;
      return {
        used,
        inputTokens,
        outputTokens,
        hasUsage: Boolean(used || inputTokens || outputTokens),
      };
    },

    subscribe(id, listener) {
      const session = sessions.get(id) || restoreServeSession(id);
      if (!session) return cliRunner.subscribe(id, listener);
      for (const event of session.outputBuffer) listener(event);
      session.listeners.add(listener);
      return () => session.listeners.delete(listener);
    },

    async sendInput(id, text, profile, sendOptions = {}) {
      const session = sessions.get(id) || restoreServeSession(id) || adoptDiskSession(id);
      if (!session) throw Object.assign(new Error('session not found'), { status: 404 });
      if (ACTIVE_STATES.has(session.state)) {
        throw Object.assign(new Error('session already has an active turn'), { status: 409 });
      }
      const value = String(text || '').trim();
      const attachments = normalizeAttachments(sendOptions.attachments || []);
      if (!value && !attachments.length) throw Object.assign(new Error('text or attachments are required'), { status: 400 });
      if (profile) {
        session.model = cliModelFor(profile);
        session.selectedModel = profile.mainModel || profile.models && profile.models.default || '';
      }
      if (sendOptions.permissionMode) session.permissionMode = sendOptions.permissionMode;
      if (sendOptions.effort) session.effort = sendOptions.effort;
      session.lastPromptText = value;

      if (mode === 'cli' || session.pinnedCli) {
        return runCliTurn(session, value, profile, sendOptions, attachments, { emitPrompt: true });
      }

      let prepared = null;
      try {
        await ensureBridge(profile);
        prepared = prepareImages(session.projectPath, attachments);
        await ensureOpenCodeSession(session);
      } catch (error) {
        if (prepared) prepared.cleanup();
        if (shouldFallbackToCli(error)) {
          switchToCli(error);
          return runCliTurn(session, value, profile, sendOptions, attachments, { emitPrompt: true });
        }
        emit(session, { type: 'claude/error', message: `opencode serve unavailable: ${error.message}`.slice(0, 500) });
        setState(session, 'idle');
        return { started: false };
      }

      emit(session, {
        type: 'claude/user-prompt',
        text: value,
        attachments: (sendOptions.displayAttachments || []).map(({ id, name, mediaType, size, width, height, url }) => ({ id, name, mediaType, size, width, height, url })),
      });
      setState(session, 'running');
      // Until the first serve event lands the UI would show dead air (reasoning
      // models think for tens of seconds first) — announce it.
      setState(session, 'thinking');
      // The turn context must exist BEFORE the prompt POST resolves: the SSE
      // stream may already deliver the first events while prompt_async's 204
      // is still in flight.
      session.lastResult = '';
      session.currentTurn = {
        assistantMessageID: null,
        userMessageIDs: new Set(), // echoed prompts never stream as output
        parts: new Map(), // partID -> tracking state
        sawEvent: false,
        usageSeen: false,
        turnFailed: false,
        startedAt: Date.now(),
      };
      session.turnUsage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
      session.turnPromise = new Promise(resolve => { session.currentTurn.resolve = resolve; });
      try {
        const parts = [
          { type: 'text', text: appendTextAttachments(value, attachments) },
          ...prepared.imagePaths.map(item => item.part),
        ];
        await promptAsync(session, parts, profile);
        // Images live only for the turn; the serve API reads them eagerly.
        {
          const turn = session.currentTurn;
          const originalResolve = turn.resolve;
          turn.resolve = () => { prepared.cleanup(); originalResolve(); };
        }
        return { started: true };
      } catch (error) {
        prepared.cleanup();
        const turn = session.currentTurn;
        session.currentTurn = null;
        session.turnUsage = null;
        if (turn && turn.resolve) turn.resolve();
        if (shouldFallbackToCli(error)) {
          switchToCli(error);
          return runCliTurn(session, value, profile, sendOptions, attachments, { emitPrompt: false });
        }
        emit(session, { type: 'claude/error', message: `opencode turn failed to start: ${error.message}`.slice(0, 500) });
        setState(session, 'idle');
        return { started: false };
      }
    },

    resolvePermission(id, requestId, decision) {
      const session = sessions.get(id) || restoreServeSession(id);
      // Neither transport maps opencode permission.asked events; the shared
      // CLI runner answers with an honest 501.
      return cliRunner.resolvePermission(
        session && session.cliMirrorId ? session.cliMirrorId : id, requestId, decision);
    },

    updateSelection(id, profile, selectedModel) {
      const session = sessions.get(id) || restoreServeSession(id);
      if (!session) {
        if (cliRunner.getState(id)) return cliRunner.updateSelection(id, profile, selectedModel);
        throw Object.assign(new Error('session not found'), { status: 404 });
      }
      if (ACTIVE_STATES.has(session.state)) {
        throw Object.assign(new Error('session already has an active turn'), { status: 409 });
      }
      const fromAiProfileId = session.aiProfileId || null;
      const fromModel = session.selectedModel || session.model || null;
      session.aiProfileId = profile && profile.id || null;
      session.selectedModel = selectedModel || (profile && (profile.mainModel || profile.models && profile.models.default)) || null;
      session.model = cliModelFor(profile);
      if (!session.cliMirrorId) {
        emit(session, {
          type: 'claude/selection-changed',
          fromAiProfileId,
          toAiProfileId: session.aiProfileId,
          fromModel,
          toModel: session.selectedModel,
        });
      }
      if (session.cliMirrorId) {
        try { cliRunner.updateSelection(session.cliMirrorId, profile, selectedModel); } catch { /* mirror may be mid-turn */ }
      } else {
        persistServeSession(session);
      }
      return summary(session);
    },

    abort(id) {
      const session = sessions.get(id) || restoreServeSession(id);
      if (!session) return cliRunner.abort(id);
      session.abortedByUser = true;
      if (mode === 'serve' && session.currentTurn && session.opencodeSessionId && bridge && bridge.state === 'ready') {
        // Preferred path: per-session abort on the shared serve instance
        // (verified: POST /session/{id}/abort interrupts only that session).
        bridge.request('POST', `/session/${session.opencodeSessionId}/abort`, { timeoutMs: 5000 })
          .catch(() => log(`opencode abort endpoint failed for ${session.opencodeSessionId}`));
      }
      if (session.currentTurn) {
        session.state = 'aborted';
        emit(session, { type: 'claude/aborted' });
        finishServeTurn(session, {});
      }
      if (session.cliMirrorId) cliRunner.abort(session.cliMirrorId);
      if (!['idle', 'ended'].includes(session.state)) {
        session.state = 'aborted';
        emit(session, { type: 'claude/aborted' });
        setState(session, 'idle');
      }
      if (!session.cliMirrorId) persistServeSession(session);
    },

    deleteSession(id) {
      const session = sessions.get(id) || restoreServeSession(id);
      if (!session) {
        const index = syncServeDiskIndex();
        if (index && index.has(id)) { removeServeRecord(id); return true; }
        return cliRunner.deleteSession(id);
      }
      if (ACTIVE_STATES.has(session.state)) runner.abort(id);
      if (session.opencodeSessionId) {
        opencodeIds.delete(session.opencodeSessionId);
        if (mode === 'serve' && bridge && bridge.state === 'ready') {
          bridge.request('DELETE', `/session/${session.opencodeSessionId}`).catch(() => {});
        }
      }
      const deleted = sessions.delete(id);
      if (session.cliMirrorId) cliRunner.deleteSession(session.cliMirrorId);
      removeServeRecord(id);
      return deleted;
    },

    async listSupportedCommands() { return []; },

    findClaudeExecutableForSdk() { return null; },

    // Test seams.
    get transportMode() { return mode; },
    get bridgeState() { return bridge ? bridge.state : 'uncreated'; },
  };

  // -- bridge lifecycle ----------------------------------------------------

  function bridgeSpecFor(profile) {
    if (!isInjected(profile)) return { key: 'agent-owned', env: {} };
    const endpoint = resolveOpenAIBaseUrl(profile); // throws without a base URL
    const model = resolveOpenAIModel(profile);
    return {
      key: `injected:${endpoint}`,
      env: {
        OPENCODE_CONFIG_CONTENT: JSON.stringify({ provider: injectedProviderConfig(profile, endpoint) }),
        [PROVIDER_KEY_ENV]: profile.apiKey,
      },
    };
  }

  async function ensureBridge(profile) {
    const spec = bridgeSpecFor(profile); // invalid profiles throw here (no fallback)
    if (bridge && bridge.state === 'closed') { bridge = null; bridgeSpecKey = null; }
    if (bridge && bridge.state === 'crashed') recycleBridge('bridge exhausted its restart budget');
    if (bridge && bridgeSpecKey !== spec.key) recycleBridge('provider spec changed');
    if (!bridge) {
      bridge = createOpenCodeServerBridge({
        command,
        env: spec.env,
        spawn: options.serveSpawn,
        fetch: options.serveFetch,
        ...(options.allocatePort !== undefined ? { allocatePort: options.allocatePort } : {}),
        onEvent: handleServeEvent,
        onSseGap: reconcileSseGap,
        onUnexpectedExit: handleBridgeCrash,
        onReady: () => { bridgeFailures = 0; },
        healthTimeoutMs: options.healthTimeoutMs,
        idleTimeoutMs: options.idleTimeoutMs !== undefined ? options.idleTimeoutMs : 10 * 60 * 1000,
        requestTimeoutMs: options.requestTimeoutMs,
        restartBackoffMs: options.restartBackoffMs,
        sseReconnectMs: options.sseReconnectMs,
        heartbeatTimeoutMs: options.heartbeatTimeoutMs,
        log,
      });
      bridgeSpecKey = spec.key;
    }
    await bridge.start();
    return bridge;
  }

  // The bridge is going away (crash, recycle, transport switch): every live
  // turn finishes with an error because its end signal will never arrive.
  // (finishServeTurn owns nulling currentTurn and resolving the turn promise.)
  function failoverSessions(reason) {
    for (const session of sessions.values()) {
      if (!session.currentTurn) continue;
      finishServeTurn(session, { error: String(reason).slice(0, 500) });
    }
  }

  function recycleBridge(reason) {
    log(`recycling opencode serve bridge: ${reason}`);
    if (bridge) bridge.close().catch(() => {});
    bridge = null;
    bridgeSpecKey = null;
    failoverSessions(`opencode serve exited: ${reason}`);
  }

  function handleBridgeCrash(error) {
    if (mode !== 'serve') return;
    failoverSessions(`opencode serve exited unexpectedly: ${error && error.message || 'crashed'}`);
    bridgeFailures += 1;
    if (bridgeFailures >= 2) switchToCli(error);
  }

  function switchToCli(error) {
    if (mode === 'cli') return;
    mode = 'cli';
    recycleBridge(`falling back to opencode CLI: ${error && error.message}`);
    for (const session of sessions.values()) {
      emitDiag(session, {
        type: 'claude/stderr',
        text: `opencode serve unavailable (${String(error && error.message || error).slice(0, 200)}); using opencode run fallback`,
      });
    }
  }

  function shouldFallbackToCli(error) {
    if (!error) return false;
    if (error.code === 'BRIDGE_SPAWN_FAILED') return true; // ENOENT / early exit
    if (error.code === 'BRIDGE_HEALTH_TIMEOUT') return true; // handshake failed
    if (error.code === 'BRIDGE_CRASHED' || error.code === 'BRIDGE_CLOSED') return true;
    if (error.code === 'BRIDGE_REQUEST_FAILED') return true; // connection refused: child gone
    return false;
  }

  // -- serve session lifecycle ----------------------------------------------

  // A model ref for prompt_async: injected profiles address the custom
  // provider; agent-owned models use the 'provider/model' convention when the
  // profile carries one, otherwise the server default applies.
  function modelRefFor(session, profile) {
    if (isInjected(profile)) {
      const model = resolveOpenAIModel(profile);
      return model ? { providerID: PROVIDER_ID, modelID: model } : null;
    }
    const model = session.model;
    if (!model || !model.includes('/')) return null;
    const slash = model.indexOf('/');
    const providerID = model.slice(0, slash);
    const modelID = model.slice(slash + 1);
    return providerID && modelID ? { providerID, modelID } : null;
  }

  async function ensureOpenCodeSession(session) {
    if (session.opencodeSessionId) {
      // Restored records carry their id but not the routing entry (the map
      // died with the previous process); rebind before the turn starts.
      opencodeIds.set(session.opencodeSessionId, session.sessionId);
      return;
    }
    const created = await bridge.request('POST', `/session?directory=${encodeURIComponent(session.projectPath)}`, {
      body: { permission: permissionRulesetFor(session.permissionMode) },
      timeoutMs: 30000,
    });
    const id = created && created.id;
    if (!id) throw new Error('opencode serve did not return a session id');
    session.opencodeSessionId = id;
    opencodeIds.set(id, session.sessionId);
    if (created.title && !session.title) session.title = String(created.title).slice(0, 200);
    persistServeSession(session);
  }

  async function promptAsync(session, parts, profile) {
    const body = {
      parts,
      ...(modelRefFor(session, profile) ? { model: modelRefFor(session, profile) } : {}),
      ...(session.permissionMode === 'plan' ? { agent: 'plan' } : {}),
    };
    try {
      await bridge.request('POST', `/session/${session.opencodeSessionId}/prompt_async`, {
        body, timeoutMs: 30000,
      });
    } catch (error) {
      if (error && error.code === 'BRIDGE_HTTP_ERROR' && error.httpStatus === 404) {
        // The opencode session was rolled away (server db prune); continue in
        // a fresh one rather than failing the turn.
        log(`opencode session ${session.opencodeSessionId} vanished; creating a new one`);
        opencodeIds.delete(session.opencodeSessionId);
        session.opencodeSessionId = null;
        await ensureOpenCodeSession(session);
        await bridge.request('POST', `/session/${session.opencodeSessionId}/prompt_async`, {
          body, timeoutMs: 30000,
        });
        return;
      }
      throw error;
    }
  }

  // -- serve event mapping ---------------------------------------------------

  function routeServeSession(opencodeSessionId) {
    if (!opencodeSessionId) return null;
    const driverId = opencodeIds.get(opencodeSessionId);
    return driverId ? sessions.get(driverId) : null;
  }

  function markActivity(session) {
    const turn = session.currentTurn;
    if (!turn) return;
    if (!turn.sawEvent) {
      turn.sawEvent = true;
      if (session.state === 'thinking') setState(session, 'running');
    }
  }

  function partTracker(session, partID) {
    const turn = session.currentTurn;
    if (!turn || !partID) return null;
    if (!turn.parts.has(partID)) {
      turn.parts.set(partID, { type: null, rawLen: 0, emittedText: '', announced: false, toolDone: false, counted: false });
    }
    return turn.parts.get(partID);
  }

  function handleServeEvent(payload) {
    const type = payload && payload.type;
    const properties = (payload && payload.properties) || {};
    const session = routeServeSession(properties.sessionID);
    if (!session) return; // events for unknown sessions are ignored
    switch (type) {
      case 'session.created':
      case 'session.updated': return onSessionUpdated(session, properties);
      case 'session.status': return onSessionStatus(session, properties);
      case 'session.idle': return onSessionIdle(session);
      case 'session.error': return onSessionError(session, properties);
      case 'message.updated': return onMessageUpdated(session, properties);
      case 'message.part.updated': return onMessagePartUpdated(session, properties);
      case 'message.part.delta': return onMessagePartDelta(session, properties);
      default: return; // sync, message.removed, session.diff, permission.asked, ...
    }
  }

  function onSessionUpdated(session, { info }) {
    if (info && info.title && !session.title) {
      session.title = String(info.title).slice(0, 200);
      if (!session.cliMirrorId) persistServeSession(session);
    }
  }

  function onSessionStatus(session, { status }) {
    if (status && status.type === 'busy') markActivity(session);
  }

  function onSessionError(session, { error }) {
    markActivity(session);
    const message = String((error && (error.message || error.name)) || error || 'opencode session error').slice(0, 500);
    emitDiag(session, { type: 'claude/error', message });
    if (session.currentTurn) session.currentTurn.turnFailed = true;
  }

  function onMessageUpdated(session, { info }) {
    if (!info || !session.currentTurn) return;
    if (info.role === 'user') {
      // Echoed user messages (this turn's prompt and trailing re-updates of
      // previous ones) must never stream as assistant output.
      if (info.id) session.currentTurn.userMessageIDs.add(info.id);
      return;
    }
    if (info.role !== 'assistant') return;
    markActivity(session);
    if (!session.currentTurn.assistantMessageID && info.id) session.currentTurn.assistantMessageID = info.id;
    // Completed assistant messages carry the final token totals; they back
    // up the per-step-finish usage when a turn had no step-finish parts.
    if (info.time && info.time.completed && info.tokens && info.tokens.total != null) {
      session.currentTurn.messageTokens = info.tokens;
    }
  }

  // Parts of echoed user prompts (or stale messages) must not leak into the
  // assistant stream; the turn tracks every user message id it has seen and
  // the assistant message this turn belongs to.
  function partBelongsToTurn(turn, messageID) {
    if (messageID && turn.userMessageIDs.has(messageID)) return false;
    if (turn.assistantMessageID && messageID && messageID !== turn.assistantMessageID) return false;
    return true;
  }

  function onMessagePartUpdated(session, { part }) {
    if (!part || !session.currentTurn) return;
    if (!partBelongsToTurn(session.currentTurn, part.messageID)) return;
    if (!session.currentTurn.assistantMessageID && part.messageID) {
      session.currentTurn.assistantMessageID = part.messageID;
    }
    markActivity(session);
    if (part.type === 'step-start') {
      partTracker(session, part.id); // mark seen: reconcile must not replay it
      // Step boundaries flush any carried partial think tag as literal text
      // and reset the parse context — identical to the CLI transport.
      for (const piece of flushThinkCarry(session)) emitServeThinkPiece(session, piece, part);
      resetThinkState(session);
      return;
    }
    if (part.type === 'step-finish') {
      const tracker = partTracker(session, part.id);
      if (tracker && tracker.counted) return; // reconciled replay: usage counted once
      if (tracker) tracker.counted = true;
      const tokens = part.tokens || {};
      addUsage(session, { inputTokens: tokens.input, outputTokens: tokens.output, cachedTokens: tokens.cache && tokens.cache.read });
      session.currentTurn.usageSeen = true;
      emit(session, {
        type: 'claude/usage',
        usage: { input_tokens: Number(tokens.input || 0), output_tokens: Number(tokens.output || 0) },
      });
      return;
    }
    if (part.type === 'text') {
      const tracker = partTracker(session, part.id);
      if (!tracker) return;
      tracker.type = 'text';
      emitServeTextSuffix(session, tracker, part, String(part.text || ''));
      return;
    }
    if (part.type === 'reasoning') {
      const tracker = partTracker(session, part.id);
      if (!tracker) return;
      tracker.type = 'reasoning';
      const text = String(part.text || '');
      if (text.length > tracker.emittedText.length) {
        const suffix = text.slice(tracker.emittedText.length);
        tracker.emittedText = text;
        if (!tracker.announced) {
          tracker.announced = true;
          emit(session, { type: 'claude/thinking-start', id: part.id || part.messageID });
        }
        emit(session, { type: 'claude/thinking-delta', id: part.id || part.messageID, text: suffix });
      }
      return;
    }
    if (part.type === 'tool') return onToolPart(session, part);
  }

  // Tool parts arrive as state snapshots pending -> running -> completed; the
  // first snapshot with input announces the tool-use, the terminal status
  // emits the result. Live output grows on the running snapshots.
  function onToolPart(session, part) {
    const tracker = partTracker(session, part.id || part.callID);
    if (!tracker) return;
    const state = part.state || {};
    const id = part.callID || part.id;
    if (!tracker.announced && (state.input && Object.keys(state.input).length || state.status === 'running' || state.status === 'completed')) {
      tracker.announced = true;
      setState(session, 'tool-running');
      emit(session, {
        type: 'claude/tool-use',
        id,
        name: part.tool || 'tool',
        input: state.input || {},
      });
    }
    if (!tracker.toolDone && (state.status === 'completed' || state.status === 'error')) {
      tracker.toolDone = true;
      setState(session, 'running');
      const output = state.status === 'error'
        ? String(state.error || state.output || 'tool failed')
        : String(state.output != null ? state.output : '');
      emit(session, {
        type: 'claude/tool-result',
        id,
        output: output.slice(0, 4000),
        isError: state.status === 'error',
        ...(state.metadata && state.metadata.diff !== undefined ? { diff: state.metadata.diff } : {}),
      });
    }
  }

  // True streaming deltas (field 'text' on text parts). The delta runs
  // through the same <think> stripping state machine as the CLI transport.
  function onMessagePartDelta(session, { partID, messageID, field, delta }) {
    const turn = session.currentTurn;
    if (!turn || field !== 'text' || !partID) return;
    if (!partBelongsToTurn(turn, messageID)) return;
    if (!turn.assistantMessageID && messageID) turn.assistantMessageID = messageID;
    markActivity(session);
    const tracker = partTracker(session, partID);
    if (!tracker) return;
    if (tracker.type === null) tracker.type = 'text'; // deltas precede the snapshot sometimes
    if (tracker.type === 'reasoning') {
      if (!tracker.announced) {
        tracker.announced = true;
        emit(session, { type: 'claude/thinking-start', id: partID });
      }
      tracker.emittedText += String(delta || '');
      emit(session, { type: 'claude/thinking-delta', id: partID, text: String(delta || '') });
      return;
    }
    emitServeTextDelta(session, tracker, partID, String(delta || ''));
  }

  // Feeds one text delta through the think-strip state machine and emits the
  // ordered thinking/text events (mirror of the CLI parseOpenCodeLine path).
  // `rawLen` counts the RAW characters consumed (deltas and snapshots speak
  // the same raw text; only the emitted pieces are stripped).
  function emitServeTextDelta(session, tracker, partID, delta) {
    tracker.rawLen += delta.length;
    const pieces = parseThinkPieces(delta, thinkStateOf(session));
    for (const piece of pieces) {
      if (!piece.text) continue;
      if (piece.think) {
        if (thinkStateOf(session).emittedBlock !== piece.block) {
          emit(session, { type: 'claude/thinking-start', id: partID });
          thinkStateOf(session).emittedBlock = piece.block;
        }
        emit(session, { type: 'claude/thinking-delta', id: partID, text: piece.text });
        continue;
      }
      if (!tracker.announced) {
        tracker.announced = true;
        emit(session, { type: 'claude/text-start', id: partID });
      }
      emit(session, { type: 'claude/text-delta', id: partID, text: piece.text });
      session.lastResult += piece.text;
    }
  }

  function emitServeThinkPiece(session, piece, part) {
    if (!piece || !piece.text) return;
    if (piece.think) {
      emit(session, { type: 'claude/thinking-start', id: part.messageID || 'think' });
      emit(session, { type: 'claude/thinking-delta', id: part.messageID || 'think', text: piece.text });
      return;
    }
    emit(session, { type: 'claude/text-start', id: part.messageID || 'text' });
    emit(session, { type: 'claude/text-delta', id: part.messageID || 'text', text: piece.text });
    session.lastResult += piece.text;
  }

  // Snapshot recovery: emits the not-yet-emitted suffix of a text part. With
  // healthy deltas this is a no-op; after an SSE gap (or on servers that only
  // send snapshots) it fills the hole with the accumulated text.
  function emitServeTextSuffix(session, tracker, part, snapshotText) {
    if (snapshotText.length <= tracker.rawLen) return;
    const suffix = snapshotText.slice(tracker.rawLen);
    emitServeTextDelta(session, tracker, part.id, suffix);
  }

  function onSessionIdle(session) {
    const turn = session.currentTurn;
    if (!turn) return;
    const failed = turn.turnFailed;
    if (!turn.usageSeen && turn.messageTokens) {
      // Step-finish usage never arrived; the assistant message carries it.
      const tokens = turn.messageTokens;
      addUsage(session, { inputTokens: tokens.input, outputTokens: tokens.output, cachedTokens: tokens.cache && tokens.cache.read });
      turn.usageSeen = true;
      emit(session, {
        type: 'claude/usage',
        usage: { input_tokens: Number(tokens.input || 0), output_tokens: Number(tokens.output || 0) },
      });
    }
    finishServeTurn(session, { error: failed ? 'opencode turn failed' : null });
  }

  function finishServeTurn(session, { error = null } = {}) {
    const turn = session.currentTurn;
    session.currentTurn = null;
    session.turns += 1;
    if (error) {
      emitDiag(session, { type: 'claude/error', message: String(error).slice(0, 500) });
    }
    emit(session, {
      type: 'claude/result',
      result: error ? '' : session.lastResult,
      model: session.model,
      isError: Boolean(error),
    });
    session.abortedByUser = false;
    session.turnUsage = null;
    if (!session.endedAt) session.state = 'idle';
    emit(session, { type: 'claude/state', state: 'idle', turn: session.turns });
    if (!session.cliMirrorId) persistServeSession(session);
    // A completed turn proves the bridge is healthy again.
    if (!error) bridgeFailures = 0;
    if (turn && turn.resolve) turn.resolve();
  }

  // The SSE stream dropped mid-flight: missed deltas are backfilled by the
  // snapshot-diff on the next part updates; a turn whose END fell into the
  // gap is detected by refetching the message list (a completed assistant
  // message newer than the turn start finishes the turn).
  function reconcileSseGap() {
    if (mode !== 'serve' || !bridge || bridge.state !== 'ready') return;
    for (const session of sessions.values()) {
      const turn = session.currentTurn;
      if (!turn || !session.opencodeSessionId) continue;
      bridge.request('GET', `/session/${session.opencodeSessionId}/message`, { timeoutMs: 15000 })
        .then(messages => {
          if (!Array.isArray(messages) || !session.currentTurn || session.currentTurn !== turn) return;
          let completed = null;
          for (const message of messages) {
            const info = message && message.info;
            if (!info || info.role !== 'assistant' || !info.time || !info.time.completed) continue;
            if (info.time.completed < turn.startedAt - 5000) continue;
            if (!completed || info.time.completed > completed.info.time.completed) completed = message;
          }
          if (!completed) return;
          // Re-feed the parts through the snapshot handlers. Text and tool
          // parts are idempotent through the emitted-length/status trackers;
          // step boundaries already seen are skipped so their usage is never
          // counted twice and the think state is not reset mid-block.
          for (const part of completed.parts || []) {
            if (!part || !part.id) continue;
            const known = turn.parts.has(part.id);
            if (known && (part.type === 'step-start' || part.type === 'step-finish')) continue;
            onMessagePartUpdated(session, { part });
          }
          if (session.currentTurn === turn) onSessionIdle(session);
        })
        .catch(error => log(`opencode gap reconciliation failed: ${error.message}`));
    }
  }

  // -- CLI fallback plumbing ------------------------------------------------

  // The CLI fallback runs inside a mirror session of the internal CLI runner;
  // its events are re-emitted on the owning serve session (see codex-driver).
  function attachMirror(session) {
    if (session.mirrorAttached) return;
    session.mirrorAttached = true;
    cliRunner.subscribe(session.cliMirrorId, event => {
      if (event.type === 'claude/session-ready'
        && session.outputBuffer.some(item => item.type === 'claude/session-ready')) return;
      if (event.type === 'claude/user-prompt' && session.skipNextMirrorPrompt) {
        session.skipNextMirrorPrompt = false;
        return;
      }
      if (event.type === 'claude/state') {
        session.state = event.state;
        if (typeof event.turn === 'number') session.turns = event.turn;
      }
      emit(session, event);
    });
  }

  async function runCliTurn(session, value, profile, sendOptions, attachments, { emitPrompt }) {
    attachments = attachments || [];
    if (!session.cliMirrorId) {
      removeServeRecord(session.sessionId);
      const { sessionId: mirrorId } = cliRunner.startChatSession({
        slug: session.projectSlug,
        projectPath: session.projectPath,
        aiProfile: { id: session.aiProfileId, models: { default: session.selectedModel || '' } },
        permissionMode: session.permissionMode,
        effort: session.effort,
        title: session.title,
      });
      session.cliMirrorId = mirrorId;
      // An opencode session id (from live turns or a restored record) is the
      // same id `opencode run --session` resumes, so the mirror inherits it.
      if (session.opencodeSessionId) {
        const mirror = cliRunner.getSession(mirrorId);
        if (mirror && !mirror.threadId) mirror.threadId = session.opencodeSessionId;
      }
      session.skipNextMirrorPrompt = !emitPrompt;
      attachMirror(session);
    } else if (!emitPrompt) {
      session.skipNextMirrorPrompt = true;
    }
    const result = await cliRunner.sendInput(session.cliMirrorId, value, profile, {
      ...sendOptions,
      attachments: sendOptions.attachments,
    });
    const mirror = cliRunner.getSession(session.cliMirrorId);
    if (mirror) session.turnPromise = mirror.turnPromise;
    return result;
  }

  // Adopt a session that only exists in the CLI runner's store: the driver
  // session takes the SAME id so the sidebar handle stays stable and every
  // future turn stays pinned to the CLI transport.
  function adoptDiskSession(id) {
    const mirror = cliRunner.getSession(id);
    if (!mirror) return null;
    const session = {
      sessionId: id,
      projectSlug: mirror.projectSlug,
      projectPath: mirror.projectPath,
      state: 'idle',
      model: mirror.model || null,
      selectedModel: mirror.selectedModel || null,
      aiProfileId: mirror.aiProfileId || null,
      permissionMode: mirror.permissionMode || 'default',
      effort: mirror.effort || null,
      title: mirror.title || null,
      turns: Number(mirror.turns) || 0,
      startedAt: mirror.startedAt || new Date().toISOString(),
      endedAt: mirror.endedAt || null,
      pendingPermission: null,
      outputBuffer: [],
      listeners: new Set(),
      opencodeSessionId: null, // the CLI thread id lives on the mirror
      currentTurn: null,
      lastResult: mirror.lastResult || '',
      lastDiag: '',
      usage: {
        inputTokens: mirror.usage ? mirror.usage.inputTokens : 0,
        outputTokens: mirror.usage ? mirror.usage.outputTokens : 0,
        cachedTokens: mirror.usage ? mirror.usage.cachedTokens : 0,
      },
      peakTurnTokens: mirror.peakTurnTokens || 0,
      turnUsage: null,
      cliMirrorId: id,
      mirrorAttached: false,
      pinnedCli: true,
      turnPromise: Promise.resolve(),
    };
    sessions.set(id, session);
    attachMirror(session);
    return session;
  }

  function nextDriverSessionId() {
    const taken = new Set(sessions.keys());
    for (const item of cliRunner.listSessions()) taken.add(item.sessionId);
    const index = syncServeDiskIndex();
    if (index) for (const id of index.keys()) taken.add(id);
    let id = `opencode-${nextId++}`;
    while (taken.has(id)) id = `opencode-${nextId++}`;
    return id;
  }

  return runner;
}

function cliModelFor(profile) {
  const model = resolveOpenAIModel(profile);
  if (!model) return null;
  return /^[A-Za-z0-9._:/-]+$/.test(model) ? `${isInjected(profile) ? `${PROVIDER_ID}/` : ''}${model}` : null;
}

// Workbench permission modes -> opencode per-session permission ruleset
// (verified live against 1.18.5: a denied permission removes the tool from
// the model's toolset, an allowed one permits it without asking).
function permissionRulesetFor(permissionMode) {
  const unrestricted = permissionMode === 'bypassPermissions';
  const editable = unrestricted || permissionMode === 'acceptEdits';
  return [
    { permission: '*', pattern: '*', action: 'allow' },
    { permission: 'edit', pattern: '*', action: editable ? 'allow' : 'deny' },
    { permission: 'bash', pattern: '*', action: editable ? 'allow' : 'deny' },
    { permission: 'external_directory', pattern: '*', action: unrestricted ? 'allow' : 'deny' },
    { permission: 'question', pattern: '*', action: 'deny' },
  ];
}

function parseOpenCodeLine(event, session, helpers) {
  const out = [];
  const type = event && event.type;
  const part = (event && event.part) || {};
  if (event && event.sessionID) helpers.setThreadId(event.sessionID);
  // Step boundaries flush any carried partial tag as literal text and start a
  // fresh parse context: a think block left open by a previous step (or turn)
  // must never swallow this step's text.
  if (type === 'step_start' || type === 'step_finish') {
    emitThinkTextPieces(flushThinkCarry(session), part, session, helpers, out);
    if (type === 'step_start') {
      resetThinkState(session);
      return out;
    }
  }

  if (type === 'text' && part.text) {
    emitThinkTextPieces(parseThinkPieces(part.text, thinkStateOf(session)), part, session, helpers, out);
    return out;
  }
  if (type === 'reasoning' && part.text) {
    out.push({ type: 'claude/thinking-start', id: part.messageID || `think-${session.turns}` });
    out.push({ type: 'claude/thinking-delta', id: part.messageID || `think-${session.turns}`, text: part.text });
    return out;
  }
  if (type === 'tool_start' || type === 'tool_start.begin') {
    helpers.setState(session, 'tool-running');
    out.push({
      type: 'claude/tool-use',
      id: part.id || part.toolCallID || `tool-${session.outputBuffer.length}`,
      name: part.tool || 'tool',
      input: (part.state && part.state.input) || part.input || {},
    });
    return out;
  }
  if (type === 'tool_end' || type === 'tool_end.finish') {
    const output = (part.state && part.state.output) || part.output || '';
    out.push({
      type: 'claude/tool-result',
      id: part.id || part.toolCallID || `tool-${session.outputBuffer.length}`,
      output: String(output).slice(0, 4000),
      ...(part.state && part.state.metadata ? { metadata: part.state.metadata, diff: part.state.metadata.diff } : {}),
    });
    return out;
  }
  // opencode 1.18 emits one completed `tool_use` record per tool call.
  if (type === 'tool_use') {
    const state = part.state || {};
    const id = part.callID || part.id || `tool-${session.outputBuffer.length}`;
    helpers.setState(session, 'tool-running');
    out.push({ type: 'claude/tool-use', id, name: part.tool || 'tool', input: state.input || part.input || {} });
    if (state.status === 'completed' || state.status === 'error' || state.output != null) {
      out.push({ type: 'claude/tool-result', id, output: String(state.output || state.error || '').slice(0, 4000),
        isError: state.status === 'error', metadata: state.metadata, diff: state.metadata && state.metadata.diff });
    }
    return out;
  }
  if (type === 'step_finish') {
    const tokens = part.tokens || {};
    helpers.addUsage({ inputTokens: tokens.input, outputTokens: tokens.output, cachedTokens: tokens.cache && tokens.cache.read });
    // Step boundaries are not turn boundaries: the runner synthesizes the
    // single turn-level claude/result at process close.
    out.push({
      type: 'claude/usage',
      usage: { input_tokens: Number(tokens.input || 0), output_tokens: Number(tokens.output || 0) },
    });
    return out;
  }
  if (type === 'error') {
    const error = event.error || part.error;
    out.push({ type: 'claude/error', message: String(event.message || (error && error.data && error.data.message) || (error && error.message) || error || 'opencode error').slice(0, 500) });
    return out;
  }
  return out; // step_start and unknown types are ignored
}

function isInjected(profile) { return Boolean(profile && profile.apiKey); }

// --- <think> stripping ------------------------------------------------------
// OpenAI-compatible models routed through opencode (MiniMax and friends) wrap
// their chain-of-thought in literal <think>…</think> inside text parts, which
// used to land raw in the reply. Strip it session-wide: a think block can span
// several parts, so the in/out state lives on the session; think content is
// re-emitted as thinking events (the UI already folds those) and everything
// outside flows through the normal text path.
//
// Text parts are incremental deltas, so a tag can be SPLIT across parts
// ('</thi' + 'nk>'): a trailing partial tag is held back in state.carry and
// re-joined with the next part. Step boundaries flush an unresolved carry as
// literal text instead of dropping it. The serve transport feeds
// message.part.delta events through the exact same state machine.
const THINK_OPEN_TEXT = '<think>';
const THINK_CLOSE_TEXT = '</think>';
// Tolerate whitespace inside the tag ('</think >') — models emit it.
const THINK_CLOSE_TAG = /<\/think\s*>/;
const THINK_ANY_TAG = /<\/?think\s*>/;
// Longest tail we may hold back: the tag name plus a few whitespace chars.
const THINK_CARRY_LIMIT = 16;

function thinkStateOf(session) {
  if (!session._thinkState) {
    session._thinkState = { inThink: false, pendingStrip: false, carry: '', thinkBlock: 0, emittedBlock: 0 };
  }
  return session._thinkState;
}

function resetThinkState(session) {
  const state = thinkStateOf(session);
  state.inThink = false;
  state.pendingStrip = false;
  state.carry = '';
  state.thinkBlock = 0;
  state.emittedBlock = 0;
}

// Could `value` still grow into a complete tag once more deltas arrive?
function couldGrowIntoThinkTag(value) {
  if (!value.startsWith('<')) return false;
  if (THINK_OPEN_TEXT.startsWith(value) || THINK_CLOSE_TEXT.startsWith(value)) return true;
  // Name complete, tag still waiting on '>' after whitespace: '<think  '.
  return /^(<\/?think)\s*$/.test(value);
}

// Longest suffix of `text` that could still grow into a tag.
function thinkCarrySuffix(text) {
  for (let length = Math.min(text.length, THINK_CARRY_LIMIT); length >= 1; length -= 1) {
    const tail = text.slice(-length);
    if (couldGrowIntoThinkTag(tail)) return tail;
  }
  return '';
}

// Splits one text part into ordered {think, text} pieces while mutating the
// session state. `pendingStrip` removes the first whitespace run after a
// closing tag — models open their reply with a blank line, which would
// otherwise lead every answer with dead space.
function parseThinkPieces(text, state, options = {}) {
  const holdPartialTag = options.holdPartialTag !== false;
  const pieces = [];
  let rest = state.carry + String(text);
  state.carry = '';
  const pushText = value => {
    if (!value) return;
    if (state.pendingStrip) {
      const stripped = value.replace(/^\s+/, '');
      if (!stripped) return; // whitespace-only run continues into the next part
      state.pendingStrip = false;
      pieces.push({ think: false, text: stripped });
      return;
    }
    pieces.push({ think: false, text: value });
  };
  const emitRun = value => {
    if (!value) return;
    if (state.inThink) pieces.push({ think: true, text: value, block: state.thinkBlock });
    else pushText(value);
  };
  while (rest) {
    const pattern = state.inThink ? THINK_CLOSE_TAG : THINK_ANY_TAG;
    const match = rest.match(pattern);
    if (!match) {
      const carry = holdPartialTag ? thinkCarrySuffix(rest) : '';
      emitRun(rest.slice(0, rest.length - carry.length));
      state.carry = carry;
      return pieces;
    }
    emitRun(rest.slice(0, match.index));
    if (state.inThink) {
      state.inThink = false;
      state.pendingStrip = true;
    } else if (match[0][1] === '/') {
      state.pendingStrip = true; // stray close without an open: swallow it
    } else {
      state.inThink = true;
      state.thinkBlock += 1; // a fresh block gets its own thinking-start
    }
    rest = rest.slice(match.index + match[0].length);
  }
  return pieces;
}

// Emits parsed pieces in order. Each think BLOCK emits exactly one
// thinking-start (piece granularity: two blocks inside one part both start);
// a block continued across parts does not restart.
function emitThinkTextPieces(pieces, part, session, helpers, out) {
  const state = thinkStateOf(session);
  let resultText = '';
  for (const piece of pieces) {
    if (!piece.text) continue;
    if (piece.think) {
      const id = part.messageID || `think-${session.turns}`;
      if (state.emittedBlock !== piece.block) {
        out.push({ type: 'claude/thinking-start', id });
        state.emittedBlock = piece.block;
      }
      out.push({ type: 'claude/thinking-delta', id, text: piece.text });
      continue;
    }
    const id = part.messageID || `text-${session.turns}`;
    out.push({ type: 'claude/text-start', id });
    out.push({ type: 'claude/text-delta', id, text: piece.text });
    resultText += piece.text;
  }
  // The turn result is the visible reply only; pure-thinking parts leave the
  // previous result untouched instead of overwriting it with ''.
  if (resultText) helpers.setResult(resultText);
}

// No more deltas will arrive for this step: whatever partial tag is still
// carried is literal text (or literal thinking), never a dropped character.
function flushThinkCarry(session) {
  const state = thinkStateOf(session);
  if (!state.carry) return [];
  return parseThinkPieces('', state, { holdPartialTag: false });
}

// ---- serve record persistence helpers (module level) ----------------------
const SERVE_PERSIST_SCHEMA = 'opencode-serve-session/v1';
const MAX_SERVE_PERSISTED_EVENTS = 5000;

function safeFileStem(value) {
  return String(value).replace(/[^A-Za-z0-9._-]/g, '_');
}

// Mirrors the CLI runner's resolution rules: explicit config always wins;
// otherwise persistence is suppressed under the node:test runner. Injected
// serve doubles (spawn/fetch) do NOT suppress persistence.
function resolveServePersistence(options) {
  const configured = options.persistence && typeof options.persistence === 'object' ? options.persistence : {};
  const explicitlyConfigured = options.persistence != null;
  const ephemeralTestContext = Boolean(process.env.NODE_TEST_CONTEXT);
  const enabled = options.persistence !== null
    && configured.enabled !== false
    && (explicitlyConfigured || !ephemeralTestContext);
  const dir = path.resolve(configured.dir || path.join(os.homedir(), '.agent-terminal', 'cli-sessions'));
  return { enabled, dir };
}

function opencodeCommandExists(command) {
  try {
    if (process.platform === 'win32') {
      const invocation = resolveCliInvocation(command, ['serve']);
      return path.isAbsolute(invocation.command);
    }
    if (path.isAbsolute(command)) return fs.existsSync(command);
    const dirs = (process.env.PATH || '').split(path.delimiter);
    return dirs.some(dir => {
      try { fs.accessSync(path.join(dir, command)); return true; } catch { return false; }
    });
  } catch {
    return false;
  }
}

// Image materialization for the serve transport (file parts reference local
// files; same on-disk discipline as the CLI runner: files exist only for the
// duration of the turn).
function prepareImages(projectPath, attachments = []) {
  const images = attachments.filter(item => item.mediaType && item.mediaType.startsWith('image/'));
  if (!images.length) return { imagePaths: [], cleanup() {} };
  const root = path.join(path.resolve(projectPath), '.agent-terminal-attachments');
  fs.mkdirSync(root, { recursive: true });
  // Refuse a workspace symlink/junction that would write attachments elsewhere.
  if (fs.lstatSync(root).isSymbolicLink()) throw new Error('attachment directory must not be a symbolic link');
  const turnDir = path.join(root, crypto.randomUUID());
  fs.mkdirSync(turnDir);
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    fs.rmSync(turnDir, { recursive: true, force: true });
    try { fs.rmdirSync(root); } catch (error) {
      if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error;
    }
    cleaned = true;
  };
  try {
    const imagePaths = images.map((item, index) => {
      const extension = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' }[item.mediaType];
      const file = path.join(turnDir, `${index}${extension}`);
      fs.writeFileSync(file, Buffer.from(item.data, 'base64'), { mode: 0o600 });
      return {
        path: file,
        // opencode file parts take a URL; local files use the file:// scheme.
        part: { type: 'file', mime: item.mediaType, filename: item.name || `image-${index}${extension}`, url: `file:///${file.replace(/\\/g, '/')}` },
      };
    });
    return { imagePaths, cleanup };
  } catch (error) { cleanup(); throw error; }
}

module.exports = { createOpenCodeDriver, parseOpenCodeLine, permissionRulesetFor };
