'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { createCliJsonRunner, resolveCliInvocation } = require('./cli-json-runner');
const { createAppServerBridge } = require('../bridges/app-server-bridge');
const {
  appendTextAttachments, normalizeAttachments, resolveOpenAIModel, resolveOpenAIBaseUrl,
} = require('../../../contracts');

const PROVIDER_ID = 'agent_terminal';
const PROVIDER_KEY_ENV = 'AGENT_TERMINAL_PROVIDER_API_KEY';
const ACTIVE_STATES = new Set(['running', 'thinking', 'tool-running']);

// Codex driver, two transports:
//   app-server (preferred) — one persistent `codex app-server` child speaking
//     line-delimited JSON-RPC over stdio, giving true token streaming
//     (`item/agentMessage/delta`), live reasoning deltas, token usage and
//     interactive approvals. Protocol verified against codex-cli 0.137.0.
//   cli-json (fallback) — the historical `codex exec --json` one-shot turns,
//     used automatically whenever the app-server path is unavailable,
//     unsupported by the installed CLI, or fails its handshake.
//
// Auth is agent-owned (codex login) or profile-injected; permission modes map
// to app-server sandboxes / approval policies, or exec sandboxes on the CLI.
const SANDBOX_FOR_PERMISSION = {
  default: 'read-only',
  plan: 'read-only',
  acceptEdits: 'workspace-write',
  bypassPermissions: 'danger-full-access',
};

const APPROVAL_POLICY_FOR_PERMISSION = {
  default: 'on-request',
  plan: 'untrusted',
  acceptEdits: 'on-request',
  bypassPermissions: 'never',
};

function createCodexDriver(options = {}) {
  // Test doubles inject `spawn` and script CLI subprocess behavior; honoring
  // that injection with the CLI path keeps the legacy contract intact.
  const forcedCli = options.bridge === false
    || process.env.CLAUDE_WORKBENCH_CODEX_TRANSPORT === 'cli'
    || Boolean(options.spawn);
  if (!forcedCli && (options.appServerSpawn || codexCommandExists(options.command || 'codex'))) {
    return createAppServerCodexDriver(options);
  }
  return createCliCodexRunner(options);
}

// ---------------------------------------------------------------------------
// CLI transport (previous behavior, kept verbatim as the fallback)
// ---------------------------------------------------------------------------

function createCliCodexRunner(options = {}) {
  const ignoreUserConfig = options.ignoreUserConfig !== false;
  return createCliJsonRunner({
    agentId: 'codex',
    command: options.command || 'codex',
    spawn: options.spawn,
    promptViaStdin: true,
    // Disk session persistence flows through both transports so fallback
    // mirrors and pure-CLI runners share one store (undefined = B's default).
    ...(options.persistence !== undefined ? { persistence: options.persistence } : {}),

    modelFor(profile) {
      const model = resolveOpenAIModel(profile);
      return model && isSafeToken(model) ? model : null;
    },

    sandboxFor(permissionMode) { return SANDBOX_FOR_PERMISSION[permissionMode] || 'read-only'; },

    envFor(profile) {
      return isInjected(profile) ? { [PROVIDER_KEY_ENV]: profile.apiKey } : {};
    },

    spawnArgs({ projectPath, model, sandbox, threadId, profile, imagePaths, effort }) {
      const args = ['exec', '--json', '--skip-git-repo-check', '--color', 'never', '-C', projectPath];
      // A broken user config.toml must not take the terminal down with it;
      // auth still flows through CODEX_HOME when the config is ignored.
      if (ignoreUserConfig || isInjected(profile)) args.push('--ignore-user-config');
      if (isInjected(profile)) args.push(...injectedProviderArgs(profile));
      if (effort) args.push('-c', `model_reasoning_effort=${JSON.stringify(effortFor(effort))}`);
      if (model) args.push('-m', model);
      // codex 0.137 on Windows silently downgrades `-s workspace-write` to a
      // read-only policy; the dedicated bypass flag is the only working write
      // channel there. Read-only modes keep the regular sandbox flag.
      const writeMode = sandbox === 'workspace-write' || sandbox === 'danger-full-access';
      if (writeMode && process.platform === 'win32') {
        args.push('--dangerously-bypass-approvals-and-sandbox');
      } else if (sandbox) {
        args.push('-s', sandbox);
      }
      // The prompt itself is written to stdin; "-" tells codex to read it there.
      if (threadId) args.push('resume', threadId);
      for (const file of imagePaths || []) args.push('-i', file);
      args.push('-');
      return args;
    },

    parseLine: parseCodexLine,
  });
}

function injectedProviderArgs(profile) {
  const endpoint = resolveOpenAIBaseUrl(profile);
  if (!endpoint) throw new Error('the selected provider needs an OpenAI base URL for Codex');
  const config = {
    model_provider: PROVIDER_ID,
    [`model_providers.${PROVIDER_ID}.name`]: 'Agent Terminal',
    [`model_providers.${PROVIDER_ID}.base_url`]: endpoint,
    [`model_providers.${PROVIDER_ID}.env_key`]: PROVIDER_KEY_ENV,
    [`model_providers.${PROVIDER_ID}.wire_api`]: 'responses',
    [`model_providers.${PROVIDER_ID}.requires_openai_auth`]: false,
    [`model_providers.${PROVIDER_ID}.supports_websockets`]: false,
  };
  const args = [];
  for (const [key, value] of Object.entries(config)) args.push('-c', `${key}=${JSON.stringify(value)}`);
  return args;
}

function parseCodexLine(event, session, helpers) {
  const out = [];
  const type = event && event.type;
  if (type === 'thread.started') {
    helpers.setThreadId(event.thread_id || event.threadId);
    return out;
  }
  if (type === 'turn.started' || type === 'turn.delta') return out;
  if (type === 'item.started') {
    const item = event.item || {};
    if (item.type === 'command_execution') {
      helpers.setState(session, 'tool-running');
      out.push({
        type: 'claude/tool-use',
        id: item.id || `cmd-${session.turns}-${session.outputBuffer.length}`,
        name: 'Bash',
        input: { command: displayCommand(item.command) },
      });
    }
    return out;
  }
  if (type === 'item.completed' || type === 'item.updated') {
    const item = event.item || {};
    if (item.type === 'agent_message' && item.text) {
      helpers.setResult(item.text);
      out.push({ type: 'claude/text-start', id: item.id || `text-${session.turns}` });
      out.push({ type: 'claude/text-delta', id: item.id || `text-${session.turns}`, text: item.text });
    } else if (item.type === 'reasoning' && item.text) {
      out.push({ type: 'claude/thinking-start', id: item.id || `think-${session.turns}` });
      out.push({ type: 'claude/thinking-delta', id: item.id || `think-${session.turns}`, text: item.text });
    } else if (item.type === 'command_execution') {
      out.push({
        type: 'claude/tool-result',
        id: item.id || `cmd-${session.turns}-${session.outputBuffer.length}`,
        output: `exit ${item.exit_code != null ? item.exit_code : '?'}: ${item.aggregated_output || item.last_agent_message || displayCommand(item.command) || ''}`.slice(0, 4000),
      });
    } else if (item.type === 'file_change') {
      const files = Array.isArray(item.changes)
        ? item.changes.map(change => change.path || '').filter(Boolean).join(', ')
        : '';
      out.push({
        type: 'claude/tool-use',
        id: item.id || `file-${session.turns}-${session.outputBuffer.length}`,
        name: 'Edit',
        input: { files, changes: item.changes || [] },
      });
      out.push({
        type: 'claude/tool-result',
        id: item.id || `file-${session.turns}-${session.outputBuffer.length}`,
        output: files.slice(0, 4000),
        changes: item.changes || [],
      });
    } else if (item.type === 'error') {
      // Codex surfaces non-fatal notices (requirements.toml warnings) as
      // error items; keep them visible without failing the turn.
      out.push({ type: 'claude/stderr', text: String(item.message || 'codex notice').slice(0, 2000) });
    }
    return out;
  }
  if (type === 'turn.completed') {
    helpers.addUsage(event.usage);
    if (event.model) helpers.setModel(event.model);
    out.push({
      type: 'claude/usage',
      usage: {
        input_tokens: Number(event.usage && event.usage.input_tokens || 0),
        output_tokens: Number(event.usage && event.usage.output_tokens || 0),
      },
    });
    out.push({
      type: 'claude/result',
      result: session.lastResult,
      model: session.model,
      isError: false,
    });
    return out;
  }
  if (type === 'turn.failed') {
    out.push({
      type: 'claude/error',
      message: String((event.error && (event.error.message || event.error)) || 'codex turn failed').slice(0, 500),
    });
    return out;
  }
  if (type === 'error') {
    const message = String(event.message || 'codex error');
    // "Reconnecting..." is codex retrying the stream, not a failed turn.
    if (/reconnect/i.test(message)) {
      out.push({ type: 'claude/retry', message: message.slice(0, 500) });
      return out;
    }
    out.push({ type: 'claude/error', message: message.slice(0, 500) });
    return out;
  }
  return out; // unknown event types are ignored, never fatal
}

// ---------------------------------------------------------------------------
// app-server transport
// ---------------------------------------------------------------------------

function createAppServerCodexDriver(options = {}) {
  const command = options.command || 'codex';
  const log = typeof options.log === 'function' ? options.log : () => {};
  const sessions = new Map();
  const threads = new Map(); // threadId -> sessionId
  // The CLI fallback runner: `cliSpawn` lets tests script fallback turns
  // without `spawn`, which would itself force the CLI transport.
  const cliRunner = createCliCodexRunner({ ...options, spawn: options.cliSpawn });
  const appServerPersist = resolveAppServerPersistence(options);
  // sessionId -> file for app-server records in the shared cli-sessions dir.
  // Kept lazily like the CLI runner's disk index; records written by another
  // process (a restart) become listable without loading their events.
  let appServerDiskIndex = null;
  let nextId = 1;
  let nextPermissionId = 1;
  let mode = 'app-server';
  let bridge = null;
  let bridgeSpecKey = null;
  let bridgeFailures = 0;
  let initializedGeneration = 0; // bridge generation that completed the handshake

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

  // ---- app-server session persistence (shared cli-sessions directory) -----
  // Pure app-server sessions never touch the CLI runner, so without this
  // store a restart wiped them from the sidebar. Records live beside the CLI
  // ones but carry their own schema; the CLI runner ignores foreign schemas,
  // and this driver only claims records it wrote itself.

  function appServerRecordFile(sessionId) {
    return path.join(appServerPersist.dir, `${safeFileStem(sessionId)}.json`);
  }

  function readAppServerRecord(file) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (parsed && parsed.schema === APP_SERVER_PERSIST_SCHEMA
        && parsed.transport === 'app-server' && typeof parsed.sessionId === 'string' && parsed.sessionId) return parsed;
    } catch { /* corrupt or foreign records are skipped, never fatal */ }
    return null;
  }

  function syncAppServerDiskIndex() {
    if (!appServerPersist.enabled) return null;
    if (!appServerDiskIndex) {
      appServerDiskIndex = new Map();
    } else {
      appServerDiskIndex.clear();
    }
    let names = [];
    try { names = fs.readdirSync(appServerPersist.dir).filter(name => name.endsWith('.json')); } catch { return appServerDiskIndex; }
    for (const name of names) {
      const file = path.join(appServerPersist.dir, name);
      const record = readAppServerRecord(file);
      if (record) appServerDiskIndex.set(record.sessionId, { file, summary: persistedAppServerSummary(record) });
    }
    return appServerDiskIndex;
  }

  function persistedAppServerSummary(record) {
    return {
      sessionId: record.sessionId,
      projectSlug: record.projectSlug,
      state: 'idle',
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

  function persistAppServerSession(session) {
    if (!appServerPersist.enabled) return;
    try {
      const file = appServerRecordFile(session.sessionId);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `${JSON.stringify({
        schema: APP_SERVER_PERSIST_SCHEMA,
        agentId: 'codex',
        transport: 'app-server',
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
        // The app-server thread id: thread/resume needs it after a restart.
        threadId: session.threadId || null,
        lastResult: session.lastResult || '',
        usage: { ...session.usage },
        peakTurnTokens: session.peakTurnTokens || 0,
        events: session.outputBuffer.slice(-MAX_APP_SERVER_PERSISTED_EVENTS),
        updatedAt: new Date().toISOString(),
      })}\n`, 'utf8');
      if (appServerDiskIndex) appServerDiskIndex.set(session.sessionId, { file: appServerRecordFile(session.sessionId), summary: summary(session) });
    } catch {
      // Read-only home or full disk degrades to memory-only behavior.
      appServerPersist.enabled = false;
      appServerDiskIndex = null;
    }
  }

  // Only ever removes OUR record: when a CLI mirror takes over a session the
  // mirror id can equal the driver id, and the CLI runner will have replaced
  // the file contents with its own schema by then.
  function removeAppServerRecord(sessionId) {
    if (appServerDiskIndex) appServerDiskIndex.delete(sessionId);
    if (!appServerPersist.enabled) return;
    try {
      const file = appServerRecordFile(sessionId);
      if (fs.existsSync(file) && readAppServerRecord(file)) fs.rmSync(file, { force: true });
    } catch { /* already gone */ }
  }

  // Restore an app-server record into the live map (lazy, on first lookup).
  // The restored session keeps its threadId so the next turn resumes the
  // app-server conversation instead of starting a new thread.
  function restoreAppServerSession(id) {
    if (!appServerPersist.enabled) return null;
    const index = syncAppServerDiskIndex();
    const entry = index && index.get(id);
    if (!entry) return null;
    const record = readAppServerRecord(entry.file);
    if (!record || record.sessionId !== id) { index.delete(id); return null; }
    const session = {
      sessionId: record.sessionId,
      projectSlug: record.projectSlug,
      projectPath: record.projectPath,
      state: 'idle', // a restart killed any live turn
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
      pendingApproval: null,
      outputBuffer: Array.isArray(record.events) ? record.events.slice(-MAX_APP_SERVER_PERSISTED_EVENTS) : [],
      listeners: new Set(),
      threadId: record.threadId || null,
      currentTurn: null,
      lastResult: record.lastResult || '',
      lastDiag: '',
      usage: {
        inputTokens: Number(record.usage && record.usage.inputTokens) || 0,
        outputTokens: Number(record.usage && record.usage.outputTokens) || 0,
        cachedTokens: Number(record.usage && record.usage.cachedTokens) || 0,
      },
      peakTurnTokens: Number(record.peakTurnTokens) || 0,
      turnTokenUsage: null,
      cliMirrorId: null,
      pinnedCli: false,
      turnPromise: Promise.resolve(),
    };
    sessions.set(id, session);
    return session;
  }

  const runner = {
    agentId: 'codex',

    startChatSession({ slug, projectPath, aiProfile, permissionMode, effort, title }) {
      if (!slug) throw new Error('slug required');
      if (!projectPath) throw new Error('projectPath required');
      const sessionId = nextDriverSessionId();
      const session = {
        sessionId,
        projectSlug: slug,
        projectPath,
        state: 'idle',
        model: modelForProfile(aiProfile),
        selectedModel: aiProfile && (aiProfile.mainModel || aiProfile.models && aiProfile.models.default) || '',
        aiProfileId: aiProfile && aiProfile.id,
        permissionMode: permissionMode || 'default',
        effort: effort || null,
        title: title || null,
        turns: 0,
        startedAt: new Date().toISOString(),
        endedAt: null,
        pendingPermission: null,
        pendingApproval: null,
        outputBuffer: [],
        listeners: new Set(),
        threadId: null,
        currentTurn: null,
        lastResult: '',
        lastDiag: '',
        usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
        peakTurnTokens: 0,
        turnTokenUsage: null,
        cliMirrorId: null,
        turnPromise: Promise.resolve(),
      };
      sessions.set(sessionId, session);
      emit(session, {
        type: 'claude/session-ready',
        model: session.model,
        aiProfileId: session.aiProfileId,
        permissionMode: session.permissionMode,
        message: 'codex session is ready. Send a message to start the first turn.',
      });
      // Write the record immediately so a session with no turns yet still
      // shows up in the sidebar after a restart.
      persistAppServerSession(session);
      return { sessionId };
    },

    // Live driver sessions ∪ CLI-runner sessions (disk-restored + mirrors)
    // ∪ this driver's persisted app-server records, deduped by id with memory
    // winning. A mirror that a live driver session already fronts is hidden:
    // its events flow through the owning session, so listing both would
    // duplicate the logical session. After a restart the memory side is empty
    // and the disk records surface.
    listSessions(filter = {}) {
      const byId = new Map();
      const boundMirrors = new Set();
      for (const session of sessions.values()) {
        if (filter.projectSlug && session.projectSlug !== filter.projectSlug) continue;
        byId.set(session.sessionId, summary(session));
        if (session.cliMirrorId) boundMirrors.add(session.cliMirrorId);
      }
      const extraSources = [cliRunner.listSessions(filter)];
      const appServerIndex = syncAppServerDiskIndex();
      if (appServerIndex) {
        extraSources.push([...appServerIndex.values()]
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
      const session = sessions.get(id) || restoreAppServerSession(id);
      if (!session) return cliRunner.getState(id); // disk-restored fallback session
      return {
        ...summary(session),
        listenerCount: session.listeners.size,
        bufferedEvents: session.outputBuffer.length,
      };
    },

    getSession(id) { return sessions.get(id) || restoreAppServerSession(id) || cliRunner.getSession(id); },

    getSessionTokenUsage(id) {
      const session = sessions.get(id) || restoreAppServerSession(id);
      if (!session) return cliRunner.getSessionTokenUsage(id);
      // CLI-pinned sessions account usage on their mirror; it is the source
      // of truth for both live and restored records.
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
      const session = sessions.get(id) || restoreAppServerSession(id);
      if (!session) return cliRunner.subscribe(id, listener); // replays the restored stream
      for (const event of session.outputBuffer) listener(event);
      session.listeners.add(listener);
      return () => session.listeners.delete(listener);
    },

    async sendInput(id, text, profile, sendOptions = {}) {
      // Lookup order: live memory, then this driver's persisted app-server
      // records (restored with their threadId so the turn resumes the same
      // conversation), then the CLI runner's store (persisted fallback
      // mirrors, adopted under the same id and pinned to the CLI transport).
      const session = sessions.get(id) || restoreAppServerSession(id) || adoptDiskSession(id);
      if (!session) throw Object.assign(new Error('session not found'), { status: 404 });
      if (ACTIVE_STATES.has(session.state)) {
        throw Object.assign(new Error('session already has an active turn'), { status: 409 });
      }
      const value = String(text || '').trim();
      const attachments = normalizeAttachments(sendOptions.attachments || []);
      if (!value && !attachments.length) throw Object.assign(new Error('text or attachments are required'), { status: 400 });
      if (profile) {
        session.model = modelForProfile(profile);
        session.selectedModel = profile.mainModel || profile.models && profile.models.default || '';
      }
      if (sendOptions.permissionMode) session.permissionMode = sendOptions.permissionMode;
      if (sendOptions.effort) session.effort = sendOptions.effort;
      session.lastPromptText = value;

      if (mode === 'cli' || session.pinnedCli) return runCliTurn(session, value, profile, sendOptions, attachments, { emitPrompt: true });

      try {
        await ensureBridge(profile);
        await ensureThread(session);
      } catch (error) {
        if (shouldFallbackToCli(error)) {
          switchToCli(error);
          return runCliTurn(session, value, profile, sendOptions, attachments, { emitPrompt: true });
        }
        emit(session, { type: 'claude/error', message: `codex app-server unavailable: ${error.message}`.slice(0, 500) });
        setState(session, 'idle');
        return { started: false };
      }

      emit(session, {
        type: 'claude/user-prompt',
        text: value,
        attachments: (sendOptions.displayAttachments || []).map(({ id, name, mediaType, size, width, height, url }) => ({ id, name, mediaType, size, width, height, url })),
      });
      setState(session, 'running');
      // Until the first app-server event lands the UI would show dead air
      // (reasoning models think for tens of seconds first) — announce it.
      setState(session, 'thinking');
      let prepared = null;
      try {
        prepared = prepareImages(session.projectPath, attachments);
        const input = [
          { type: 'text', text: appendTextAttachments(value, attachments) },
          ...prepared.imagePaths.map(imagePath => ({ type: 'image', url: imagePath })),
        ];
        const turn = await bridge.request('turn/start', {
          threadId: session.threadId,
          input,
          ...(session.model ? { model: session.model } : {}),
          ...(session.effort ? { effort: effortFor(session.effort) } : {}),
        }, { timeoutMs: 30000 });
        session.currentTurn = {
          turnId: turn && turn.turn && turn.turn.id || `turn-${session.turns + 1}`,
          announcedText: new Set(),
          streamedText: new Set(),
          announcedThinking: new Set(),
          streamedThinking: new Set(),
          sawEvent: false,
        };
        session.turnPromise = new Promise(resolve => { session.currentTurn.resolve = resolve; });
        return { started: true };
      } catch (error) {
        if (prepared) prepared.cleanup();
        if (shouldFallbackToCli(error)) {
          switchToCli(error);
          return runCliTurn(session, value, profile, sendOptions, attachments, { emitPrompt: false });
        }
        emit(session, { type: 'claude/error', message: `codex turn failed to start: ${error.message}`.slice(0, 500) });
        session.currentTurn = null;
        setState(session, 'idle');
        return { started: false };
      } finally {
        // Images live only for the turn; the app-server reads them eagerly.
        if (prepared && session.currentTurn) {
          const turn = session.currentTurn;
          const originalResolve = turn.resolve;
          turn.resolve = () => { prepared.cleanup(); originalResolve(); };
        }
      }
    },

    resolvePermission(id, requestId, decision) {
      const session = sessions.get(id);
      if (!session) return cliRunner.resolvePermission(id, requestId, decision); // 501 from the CLI runner
      if (!session.pendingApproval || session.pendingApproval.requestId !== requestId) {
        if (session.cliMirrorId) return cliRunner.resolvePermission(session.cliMirrorId, requestId, decision);
        throw Object.assign(new Error('permission request not found or already resolved'), { status: 409 });
      }
      const allow = decision && decision.allow === true;
      const approval = session.pendingApproval;
      session.pendingApproval = null;
      session.pendingPermission = null;
      const rpcDecision = approvalDecisionFor(approval.method, allow);
      emit(session, {
        type: 'claude/permission-resolved',
        requestId,
        allow,
        decision: rpcDecision,
        resolvedAt: new Date().toISOString(),
      });
      setState(session, 'running');
      approval.resolve({ decision: rpcDecision });
      return { ok: true, started: true, decision: rpcDecision };
    },

    updateSelection(id, profile, selectedModel) {
      const session = sessions.get(id) || restoreAppServerSession(id);
      if (!session) {
        // Disk-restored fallback session: delegate so the persisted record
        // carries the new selection into the next process.
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
      session.model = modelForProfile(profile);
      // For mirrored sessions the selection-changed event comes from the
      // mirror (forwarded below); emitting our own would duplicate it.
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
        persistAppServerSession(session);
      }
      return summary(session);
    },

    abort(id) {
      const session = sessions.get(id);
      if (!session) return cliRunner.abort(id); // disk-restored sessions restore as idle
      session.abortedByUser = true;
      denyPendingApproval(session, 'aborted');
      const currentTurn = session.currentTurn;
      session.currentTurn = null;
      if (currentTurn && currentTurn.resolve) currentTurn.resolve();
      if (mode === 'app-server' && currentTurn && bridge && bridge.state === 'ready' && session.threadId) {
        // Preferred path: ask the app-server to interrupt the live turn. If
        // that fails the bridge is recycled (killed and relaunched lazily).
        bridge.request('turn/interrupt', { threadId: session.threadId, turnId: currentTurn.turnId }, { timeoutMs: 5000 })
          .catch(() => recycleBridge('interrupt failed'));
      }
      if (session.cliMirrorId) cliRunner.abort(session.cliMirrorId);
      if (!['idle', 'ended'].includes(session.state)) {
        session.state = 'aborted';
        emit(session, { type: 'claude/aborted' });
        setState(session, 'idle');
      }
      if (!session.cliMirrorId) persistAppServerSession(session);
    },

    deleteSession(id) {
      const session = sessions.get(id) || restoreAppServerSession(id);
      if (!session) {
        // Disk-only record from a previous process: ours or the CLI runner's.
        const index = syncAppServerDiskIndex();
        if (index && index.has(id)) { removeAppServerRecord(id); return true; }
        return cliRunner.deleteSession(id);
      }
      if (ACTIVE_STATES.has(session.state)) runner.abort(id);
      denyPendingApproval(session, 'deleted');
      if (session.threadId) threads.delete(session.threadId);
      const deleted = sessions.delete(id);
      // The mirror and its persisted record must not outlive the driver
      // session they front, otherwise the restart path would resurrect a
      // session the user just deleted.
      if (session.cliMirrorId) cliRunner.deleteSession(session.cliMirrorId);
      removeAppServerRecord(id);
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
    if (!isInjected(profile)) return { key: 'agent-owned', args: ['app-server'], env: {} };
    const providerArgs = injectedProviderArgs(profile); // throws without a base URL
    return {
      key: `injected:${resolveOpenAIBaseUrl(profile)}`,
      args: ['app-server', ...providerArgs],
      env: { [PROVIDER_KEY_ENV]: profile.apiKey },
    };
  }

  async function ensureBridge(profile) {
    const spec = bridgeSpecFor(profile); // invalid profiles throw here (no fallback)
    if (bridge && bridge.state === 'closed') { bridge = null; bridgeSpecKey = null; }
    if (bridge && bridge.state === 'crashed') { recycleBridge('bridge exhausted its restart budget'); }
    if (bridge && bridgeSpecKey !== spec.key) {
      recycleBridge('provider spec changed');
    }
    if (!bridge) {
      bridge = createAppServerBridge({
        command,
        args: spec.args,
        env: spec.env,
        spawn: options.appServerSpawn,
        onEvent: handleNotification,
        onServerRequest: handleServerRequest,
        onUnexpectedExit: handleBridgeCrash,
        // A bridge that (re)starts a healthy child proves earlier crashes
        // were transient: the failure counter must not outlive recovery.
        onReady: () => { bridgeFailures = 0; },
        idleTimeoutMs: options.idleTimeoutMs !== undefined ? options.idleTimeoutMs : 10 * 60 * 1000,
        requestTimeoutMs: options.requestTimeoutMs !== undefined ? options.requestTimeoutMs : 120000,
        restartBackoffMs: options.restartBackoffMs,
        log,
      });
      bridgeSpecKey = spec.key;
    }
    // A crash-restarted bridge spawns a fresh child that has never seen the
    // initialize handshake. start() resolves on the current child, THEN the
    // generation comparison tells whether this child still needs the
    // handshake (a brand-new bridge is generation 1 against 0 here).
    if (bridge) {
      await bridge.start();
      if (initializedGeneration !== bridge.generation) {
        try {
          await bridge.request('initialize', {
            clientInfo: { name: 'claude-ai-workbench', title: 'Claude AI Workbench', version: '0.3.0' },
          }, { timeoutMs: options.initializeTimeoutMs || 20000 });
          bridge.notify('initialized').catch(() => {}); // notification; failure surfaces later if real
        } catch (error) {
          error.phase = 'initialize';
          await discardBridge(error);
          throw error;
        }
        initializedGeneration = bridge.generation;
        // A healthy handshake proves the previous failures were transient.
        bridgeFailures = 0;
      }
    }
    return bridge;
  }

  async function discardBridge(error) {
    recycleBridge(`bridge discarded: ${error && error.message}`);
    if (error && shouldFallbackToCli(error)) return;
    bridgeFailures += 1;
    if (bridgeFailures >= 2) switchToCli(error || new Error('bridge kept failing'));
  }

  // The bridge is going away (crash, recycle, transport switch): nothing it
  // owed can still arrive. Unanswered approvals are denied so the UI never
  // sticks on "pending", in-flight turns finish with an error, and the
  // resulting state is persisted for the restart path.
  function failoverSessions(reason) {
    for (const session of sessions.values()) {
      denyPendingApproval(session, reason);
      const turn = session.currentTurn;
      if (!turn) continue;
      session.currentTurn = null;
      session.turns += 1;
      emit(session, { type: 'claude/error', message: String(reason).slice(0, 500) });
      emit(session, { type: 'claude/result', result: '', model: session.model, isError: true });
      if (!session.endedAt) session.state = 'idle';
      emit(session, { type: 'claude/state', state: 'idle', turn: session.turns });
      if (!session.cliMirrorId) persistAppServerSession(session);
      if (turn.resolve) turn.resolve();
    }
  }

  function recycleBridge(reason) {
    log(`recycling codex app-server bridge: ${reason}`);
    if (bridge) bridge.close().catch(() => {});
    bridge = null;
    bridgeSpecKey = null;
    failoverSessions(`codex app-server exited: ${reason}`);
  }

  // The app-server died mid-flight: turn/completed will never arrive, so
  // every live turn is finished with an error here (the bridge restarts
  // itself and the next turn retries it, or falls back once failures
  // accumulate).
  function handleBridgeCrash(error) {
    if (mode !== 'app-server') return;
    failoverSessions(`codex app-server exited unexpectedly: ${error && error.message || 'crashed'}`);
    bridgeFailures += 1;
    if (bridgeFailures >= 2) switchToCli(error);
  }

  function switchToCli(error) {
    if (mode === 'cli') return;
    mode = 'cli';
    recycleBridge(`falling back to codex CLI: ${error && error.message}`);
    for (const session of sessions.values()) {
      emitDiag(session, {
        type: 'claude/stderr',
        text: `codex app-server unavailable (${String(error && error.message || error).slice(0, 200)}); using codex exec fallback`,
      });
    }
  }

  function shouldFallbackToCli(error) {
    if (!error) return false;
    if (error.code === 'BRIDGE_SPAWN_FAILED') return true; // ENOENT / early exit
    if (error.code === 'BRIDGE_CRASHED' || error.code === 'BRIDGE_CLOSED') return true;
    if (error.code === 'BRIDGE_TIMEOUT' && error.phase === 'initialize') return true;
    // A config.toml the installed app-server cannot parse hard-fails every
    // thread/start with -32600; the CLI honors --ignore-user-config instead.
    if (error.code === 'BRIDGE_RPC_ERROR' && isConfigLoadError(error.message)) return true;
    return false;
  }

  function isConfigLoadError(message) {
    return /failed to load configuration|error loading configuration/i.test(String(message || ''));
  }

  async function ensureThread(session) {
    // A threadId from a live turn or a restored record always resumes first;
    // the threads map (event routing) is (re)populated on success — after a
    // restart it is empty even though the conversation lives on at the server.
    if (session.threadId) {
      try {
        await bridge.request('thread/resume', { threadId: session.threadId }, { timeoutMs: 30000 });
        threads.set(session.threadId, session.sessionId);
        return;
      } catch (error) {
        if (shouldFallbackToCli(error)) throw error;
        // The thread may have been rolled away; fall through to a fresh one.
        threads.delete(session.threadId);
        session.threadId = null;
        log(`codex thread resume failed, starting a new thread: ${error.message}`);
      }
    }
    const result = await bridge.request('thread/start', {
      cwd: session.projectPath,
      model: session.model || null,
      sandbox: SANDBOX_FOR_PERMISSION[session.permissionMode] || 'read-only',
      approvalPolicy: APPROVAL_POLICY_FOR_PERMISSION[session.permissionMode] || 'on-request',
    }, { timeoutMs: 30000 });
    const thread = result && result.thread;
    if (!thread || !thread.id) throw new Error('codex app-server did not return a thread');
    session.threadId = thread.id;
    threads.set(thread.id, session.sessionId);
  }

  // -- app-server event mapping ---------------------------------------------

  function handleNotification({ method, params }) {
    const session = params && threads.get(params.threadId) && sessions.get(threads.get(params.threadId));
    if (!session) return; // notifications for unknown threads are ignored
    switch (method) {
      case 'turn/completed': return onTurnCompleted(session, params);
      case 'item/started': return onItemStarted(session, params);
      case 'item/completed': return onItemCompleted(session, params);
      case 'item/agentMessage/delta': return onAgentMessageDelta(session, params);
      case 'item/reasoning/summaryTextDelta':
      case 'item/reasoning/textDelta': return onReasoningDelta(session, params);
      case 'thread/tokenUsage/updated': return onTokenUsageUpdated(session, params);
      case 'error': return onTurnErrorNotification(session, params);
      case 'warning':
      case 'configWarning': {
        const text = params && (params.message || params.summary);
        if (text) emitDiag(session, { type: 'claude/stderr', text: String(text).slice(0, 2000) });
        return;
      }
      default: return; // thread/started, thread/status/changed, mcpServer/*, account/*, ...
    }
  }

  function markActivity(session) {
    const turn = session.currentTurn;
    if (!turn) return;
    if (!turn.sawEvent) {
      turn.sawEvent = true;
      if (session.state === 'thinking') setState(session, 'running');
    }
  }

  function onItemStarted(session, { item }) {
    markActivity(session);
    const turn = session.currentTurn;
    if (!item) return;
    if (item.type === 'agentMessage') {
      if (turn) turn.announcedText.add(item.id); // deltas must not re-announce
      emit(session, { type: 'claude/text-start', id: item.id });
    } else if (item.type === 'reasoning') {
      if (turn) turn.announcedThinking.add(item.id);
      emit(session, { type: 'claude/thinking-start', id: item.id });
    } else if (item.type === 'commandExecution') {
      setState(session, 'tool-running');
      emit(session, {
        type: 'claude/tool-use',
        id: item.id,
        name: 'Bash',
        input: { command: displayCommand(item.command) },
      });
    }
  }

  function onAgentMessageDelta(session, params) {
    markActivity(session);
    const turn = session.currentTurn;
    if (!turn) return;
    const id = params.itemId || `text-${session.turns}`;
    if (!turn.announcedText.has(id)) {
      turn.announcedText.add(id);
      emit(session, { type: 'claude/text-start', id });
    }
    turn.streamedText.add(id);
    // The whole point of the app-server transport: real token deltas.
    emit(session, { type: 'claude/text-delta', id, text: String(params.delta || '') });
  }

  function onReasoningDelta(session, params) {
    markActivity(session);
    const turn = session.currentTurn;
    if (!turn) return;
    const id = params.itemId || `think-${session.turns}`;
    if (!turn.announcedThinking.has(id)) {
      turn.announcedThinking.add(id);
      emit(session, { type: 'claude/thinking-start', id });
    }
    turn.streamedThinking.add(id);
    emit(session, { type: 'claude/thinking-delta', id, text: String(params.delta || '') });
  }

  function onItemCompleted(session, { item }) {
    markActivity(session);
    const turn = session.currentTurn;
    if (!item) return;
    if (item.type === 'agentMessage') {
      if (item.text) session.lastResult = String(item.text);
      if (turn && !turn.streamedText.has(item.id)) {
        // No deltas arrived (e.g. a tool-less fast path); emit the full text.
        if (!turn.announcedText.has(item.id)) {
          turn.announcedText.add(item.id);
          emit(session, { type: 'claude/text-start', id: item.id });
        }
        turn.streamedText.add(item.id);
        emit(session, { type: 'claude/text-delta', id: item.id, text: String(item.text || '') });
      }
    } else if (item.type === 'reasoning') {
      const text = [...(item.summary || []), ...(item.content || [])].filter(Boolean).join('\n\n');
      if (text && turn && !turn.streamedThinking.has(item.id)) {
        if (!turn.announcedThinking.has(item.id)) {
          turn.announcedThinking.add(item.id);
          emit(session, { type: 'claude/thinking-start', id: item.id });
        }
        turn.streamedThinking.add(item.id);
        emit(session, { type: 'claude/thinking-delta', id: item.id, text });
      }
    } else if (item.type === 'commandExecution') {
      setState(session, 'running');
      emit(session, {
        type: 'claude/tool-result',
        id: item.id,
        output: `exit ${item.exitCode != null ? item.exitCode : '?'}: ${item.aggregatedOutput || displayCommand(item.command) || ''}`.slice(0, 4000),
      });
    } else if (item.type === 'fileChange') {
      const files = Array.isArray(item.changes)
        ? item.changes.map(change => change.path || '').filter(Boolean).join(', ')
        : '';
      emit(session, {
        type: 'claude/tool-use',
        id: item.id,
        name: 'Edit',
        input: { files, changes: item.changes || [] },
      });
      emit(session, {
        type: 'claude/tool-result',
        id: item.id,
        output: files.slice(0, 4000),
        changes: item.changes || [],
      });
    }
    // userMessage and unknown item types are ignored.
  }

  function onTokenUsageUpdated(session, params) {
    const usage = params && params.tokenUsage;
    if (!usage) return;
    session.turnTokenUsage = usage; // the turn end emits the normalized event
  }

  function onTurnErrorNotification(session, params) {
    const message = String(params && params.error && params.error.message || 'codex error');
    if (params && params.willRetry) {
      emit(session, { type: 'claude/retry', message: message.slice(0, 500) });
      return;
    }
    emitDiag(session, { type: 'claude/error', message: message.slice(0, 500) });
    session.turnHadError = true;
  }

  function onTurnCompleted(session, params) {
    const turn = params && params.turn;
    const current = session.currentTurn;
    if (!current || (turn && turn.id && turn.id !== current.turnId)) return; // stale turn
    session.currentTurn = null;
    denyPendingApproval(session, 'turn completed'); // codex cancels unanswered approvals
    session.turns += 1;
    const usage = session.turnTokenUsage && session.turnTokenUsage.last;
    if (usage) {
      const input = Number(usage.inputTokens || 0);
      const output = Number(usage.outputTokens || 0);
      const cached = Number(usage.cachedInputTokens || 0);
      session.usage.inputTokens += input;
      session.usage.outputTokens += output;
      session.usage.cachedTokens += cached;
      session.peakTurnTokens = Math.max(session.peakTurnTokens || 0, input + output + cached);
      emit(session, { type: 'claude/usage', usage: { input_tokens: input, output_tokens: output } });
    }
    session.turnTokenUsage = null;
    const failed = turn && turn.status === 'failed';
    const interrupted = turn && turn.status === 'interrupted';
    if (failed) {
      const message = String(turn && turn.error && turn.error.message || 'codex turn failed').slice(0, 500);
      emitDiag(session, { type: 'claude/error', message });
      session.turnHadError = true;
    }
    emit(session, {
      type: 'claude/result',
      result: failed ? '' : session.lastResult,
      model: session.model,
      isError: Boolean(failed),
    });
    if (interrupted && !session.abortedByUser) emit(session, { type: 'claude/aborted' });
    session.abortedByUser = false;
    session.turnHadError = false;
    if (!session.endedAt) session.state = 'idle';
    emit(session, { type: 'claude/state', state: 'idle', turn: session.turns });
    // CLI-pinned sessions persist through their mirror; pure app-server ones
    // through this driver's own record store.
    if (!session.cliMirrorId) persistAppServerSession(session);
    // A completed turn proves the bridge is healthy again: transient crash
    // counters must not accumulate across self-healed bridges (P2-1).
    bridgeFailures = 0;
    if (current.resolve) current.resolve();
  }

  // -- server-initiated requests (approvals) --------------------------------

  async function handleServerRequest(method, params) {
    if (isApprovalMethod(method)) {
      const session = params && threads.get(params.threadId) && sessions.get(threads.get(params.threadId));
      if (!session) throw Object.assign(new Error('codex approval for an unknown thread'), { status: 404 });
      return await new Promise(resolve => {
        const requestId = `codex-perm-${nextPermissionId++}`;
        const described = describeApproval(method, params);
        session.pendingApproval = { requestId, method, params, resolve };
        session.pendingPermission = {
          requestId,
          status: 'pending',
          createdAt: new Date().toISOString(),
          summary: described.summary,
        };
        setState(session, 'tool-running');
        emit(session, { type: 'claude/permission-request', requestId, ...described, status: 'pending', createdAt: session.pendingPermission.createdAt });
      });
    }
    throw Object.assign(new Error(`codex app-server request ${method} is not supported`), { status: 501 });
  }

  function isApprovalMethod(method) {
    return /requestApproval$/i.test(String(method)) || /^(applyPatchApproval|execCommandApproval)$/.test(String(method));
  }

  function approvalDecisionFor(method, allow) {
    // Legacy v1 methods use approved/denied; the thread-item API uses accept/decline.
    if (/^(applyPatchApproval|execCommandApproval)$/.test(method)) return allow ? 'approved' : 'denied';
    return allow ? 'accept' : 'decline';
  }

  function describeApproval(method, params) {
    const command = params && (params.command || '');
    const isLegacy = /^(applyPatchApproval|execCommandApproval)$/.test(method);
    const toolName = /file/i.test(method) ? 'Edit' : 'Bash';
    const title = isLegacy
      ? `Codex wants to run a command`
      : toolName === 'Edit' ? 'Codex wants to modify files' : 'Codex wants to run a command';
    const commandText = Array.isArray(command) ? command.join(' ') : String(command || '');
    return {
      toolName,
      title,
      description: toolName === 'Edit'
        ? `File changes requested (${(params && params.changes || []).length} files)`
        : commandText.slice(0, 200),
      promptPreview: JSON.stringify({ method, command: commandText, cwd: params && params.cwd || '' }).slice(0, 500),
      summary: {
        toolName,
        title,
        description: toolName === 'Edit' ? 'Codex file change approval' : commandText.slice(0, 200),
        promptPreview: commandText.slice(0, 500),
      },
    };
  }

  function denyPendingApproval(session, reason) {
    if (!session.pendingApproval) return;
    const approval = session.pendingApproval;
    session.pendingApproval = null;
    session.pendingPermission = null;
    emit(session, {
      type: 'claude/permission-resolved',
      requestId: approval.requestId,
      allow: false,
      decision: approvalDecisionFor(approval.method, false),
      message: reason,
      resolvedAt: new Date().toISOString(),
    });
    approval.resolve({ decision: approvalDecisionFor(approval.method, false) });
  }

  // -- CLI fallback plumbing ------------------------------------------------

  // The CLI fallback runs inside a mirror session of the internal CLI runner;
  // its events are re-emitted on the owning app-server session. The mirror's
  // session-ready is suppressed while the driver session already announced
  // one, and (when the app-server already echoed the prompt) the mirror's
  // user-prompt is skipped to avoid duplicates.
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
      // Keep the driver view in sync with the mirror it fronts: state events
      // carry the authoritative state/turn counters, usage stays on the mirror.
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
      // From now on the mirror's CLI record is this session's source of
      // truth; this driver's app-server record must step aside (the CLI
      // runner may write its own record under the same file name).
      removeAppServerRecord(session.sessionId);
      const { sessionId: mirrorId } = cliRunner.startChatSession({
        slug: session.projectSlug,
        projectPath: session.projectPath,
        aiProfile: { id: session.aiProfileId, models: { default: session.selectedModel || '' } },
        permissionMode: session.permissionMode,
        effort: session.effort,
        title: session.title,
      });
      session.cliMirrorId = mirrorId;
      // An app-server thread (from live turns or a restored record) lives in
      // the same rollout store the CLI resumes, so the mirror inherits it and
      // `codex exec resume` continues the same conversation.
      if (session.threadId) {
        const mirror = cliRunner.getSession(mirrorId);
        if (mirror && !mirror.threadId) mirror.threadId = session.threadId;
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

  // Adopt a session that only exists in the CLI runner's store (persisted by
  // a previous process whose app-server handshake fell back): the driver
  // session takes the SAME id so the sidebar handle stays stable, replays the
  // restored history through the mirror subscription, and pins every future
  // turn to the CLI transport so `codex resume <threadId>` keeps working.
  function adoptDiskSession(id) {
    const mirror = cliRunner.getSession(id); // lazily restores the record + events
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
      pendingApproval: null,
      outputBuffer: [],
      listeners: new Set(),
      threadId: null, // the CLI thread id lives on the mirror
      currentTurn: null,
      lastResult: mirror.lastResult || '',
      lastDiag: '',
      usage: {
        inputTokens: mirror.usage ? mirror.usage.inputTokens : 0,
        outputTokens: mirror.usage ? mirror.usage.outputTokens : 0,
        cachedTokens: mirror.usage ? mirror.usage.cachedTokens : 0,
      },
      peakTurnTokens: mirror.peakTurnTokens || 0,
      turnTokenUsage: null,
      cliMirrorId: id,
      mirrorAttached: false,
      pinnedCli: true,
      turnPromise: Promise.resolve(),
    };
    sessions.set(id, session);
    // The subscription replays the restored history into the driver session,
    // exactly as if the events had streamed live.
    attachMirror(session);
    return session;
  }

  // Driver session ids must never collide with anything the persistence
  // stores know (live mirrors, CLI records or app-server records from
  // previous processes): a collision would shadow a restartable session
  // behind an empty one.
  function nextDriverSessionId() {
    const taken = new Set(sessions.keys());
    for (const item of cliRunner.listSessions()) taken.add(item.sessionId);
    const appServerIndex = syncAppServerDiskIndex();
    if (appServerIndex) for (const id of appServerIndex.keys()) taken.add(id);
    let id = `codex-${nextId++}`;
    while (taken.has(id)) id = `codex-${nextId++}`;
    return id;
  }

  return runner;
}

function modelForProfile(profile) {
  const model = resolveOpenAIModel(profile);
  return model && isSafeToken(model) ? model : null;
}

// ---- app-server record persistence helpers (module level) -----------------
// Records share the CLI runner's directory (~/.agent-terminal/cli-sessions)
// but use their own schema so each store only ever claims its own files.
const APP_SERVER_PERSIST_SCHEMA = 'codex-appserver-session/v1';
const MAX_APP_SERVER_PERSISTED_EVENTS = 5000;

function safeFileStem(value) {
  return String(value).replace(/[^A-Za-z0-9._-]/g, '_');
}

// Mirrors the CLI runner's resolution rules: explicit config always wins;
// otherwise persistence is suppressed under the node:test runner so test
// runs never touch the real session store. An injected bridge spawn does
// NOT suppress persistence (it doubles the app-server child, not the CLI
// subprocess the ephemeral rule was designed for).
function resolveAppServerPersistence(options) {
  const configured = options.persistence && typeof options.persistence === 'object' ? options.persistence : {};
  const explicitlyConfigured = options.persistence != null;
  const ephemeralTestContext = Boolean(process.env.NODE_TEST_CONTEXT);
  const enabled = options.persistence !== null
    && configured.enabled !== false
    && (explicitlyConfigured || !ephemeralTestContext);
  const dir = path.resolve(configured.dir || path.join(os.homedir(), '.agent-terminal', 'cli-sessions'));
  return { enabled, dir };
}

function effortFor(effort) {
  return ({ max: 'xhigh' })[effort] || effort;
}

function codexCommandExists(command) {
  try {
    const invocation = resolveCliInvocation(command, ['app-server']);
    if (process.platform === 'win32') return path.isAbsolute(invocation.command);
    if (path.isAbsolute(command)) return fs.existsSync(command);
    const dirs = (process.env.PATH || '').split(path.delimiter);
    return dirs.some(dir => {
      try { fs.accessSync(path.join(dir, command)); return true; } catch { return false; }
    });
  } catch {
    return false;
  }
}

function isSafeToken(value) {
  return /^[A-Za-z0-9._:/\[\]-]+$/.test(String(value));
}

function isInjected(profile) { return Boolean(profile && profile.apiKey); }

// codex wraps shell commands as powershell.exe -Command '<cmd>' on Windows;
// surface the inner command the user actually asked for, not the wrapper.
function displayCommand(command) {
  const raw = String(command || '').trim();
  if (!raw) return '';
  const inner = raw.match(/-Command\s+'([\s\S]*)'\s*$/i) || raw.match(/-Command\s+"([\s\S]*)"\s*$/i);
  if (!inner) return raw;
  return inner[1].replace(/''/g, "'").trim() || raw;
}

// Image materialization for the app-server transport (input items reference
// local files; same on-disk discipline as the CLI runner: files exist only
// for the duration of the turn).
function prepareImages(projectPath, attachments = []) {
  const images = attachments.filter(item => item.mediaType.startsWith('image/'));
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
      return file;
    });
    return { imagePaths, cleanup };
  } catch (error) { cleanup(); throw error; }
}

module.exports = { createCodexDriver, parseCodexLine, displayCommand, SANDBOX_FOR_PERMISSION };
