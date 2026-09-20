'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { createAppServerBridge } = require('../bridges/app-server-bridge');
const {
  appendTextAttachments, normalizeAttachments, resolveOpenAIBaseUrl, resolveOpenAIModel,
} = require('../../../contracts');

// ZCode driver — speaks the "ZCode Protocol" app-server bundled with the
// ZCode desktop install (`resources/glm/zcode.cjs`, `app-server --stdio`).
// Protocol verified live against zcode CLI 0.16.5 / desktop 3.11.2:
//
//   - Line-delimited JSON-RPC over stdio WITHOUT the `jsonrpc` envelope field
//     (the same dialect as `codex app-server`, so the shared app-server bridge
//     drives it as-is). Server-initiated request ids are strings ("server-N").
//   - No initialize handshake. The first request is usually `session/create`:
//       { workspace: { workspacePath, workspaceKey }, mode, runtimeModel? }
//     and it BLOCKS on a server-initiated `session/requestRuntimePreferences`
//     request that must be answered before the create response arrives.
//   - Sessions, not threads: `session/create` -> `session/resume` ->
//     `session/subscribe` { deliveryKind: 'desktop-continuous' } ->
//     `session/send` { content } -> `session/stop` to abort. Turn lifecycle
//     and token deltas ride `session/event` notifications (types: turn.started,
//     model.streaming, tool.updated, permission.requested/resolved,
//     turn.completed, session.updated, session.titleUpdated, ...).
//   - Approvals are server-initiated `interaction/requestPermission` requests
//     whose params carry an `options[]` array; the response must echo one of
//     `options[].response` (allow_once / allow_project / deny).
//   - Models come from `runtimeModel` on create/resume/send (provider kind
//     anthropic | openai | openai-compatible, inline api keys supported).
//     Without one the app-server requires ~/.zcode/cli/config.json to define a
//     provider; agent-owned turns bridge the desktop's ~/.zcode/v2/config.json
//     providers instead (see desktopRuntimeModelFor).
//
// The driver deliberately has NO CLI one-shot fallback: the bundled CLI's
// headless `--prompt` mode has no verified JSON event stream, so an unusable
// app-server surfaces honest errors instead of a fake fallback transport.

const ACTIVE_STATES = new Set(['running', 'thinking', 'tool-running']);
// Workbench permission modes -> ZCode session modes
// (default/plan/acceptEdits/bypassPermissions -> build/plan/edit/yolo).
const MODE_FOR_PERMISSION = {
  default: 'build',
  plan: 'plan',
  acceptEdits: 'edit',
  bypassPermissions: 'yolo',
};

const RUNTIME_PREFERENCES = Object.freeze({
  nativeSearchEnhancementsEnabled: false,
  memoryEnabled: false,
  askUserQuestionAutoResolutionEnabled: false,
  modelContextBudgetStrategy: 'preflight-v1',
});

const APP_SERVER_PERSIST_SCHEMA = 'zcode-appserver-session/v1';
const MAX_PERSISTED_EVENTS = 5000;

// ---------------------------------------------------------------------------
// CLI discovery
// ---------------------------------------------------------------------------

function defaultRegQuery(key) {
  try {
    const result = spawnSync('reg', ['query', key], { windowsHide: true, encoding: 'utf8', timeout: 5000 });
    if (result.error || result.status !== 0) return null;
    return String(result.stdout || '');
  } catch {
    return null;
  }
}

function safeExists(target) {
  try { return fs.existsSync(target); } catch { return false; }
}

function safeReaddir(dir) {
  try { return fs.readdirSync(dir); } catch { return []; }
}

// Discovery chain for the bundled zcode CLI:
//   1. ZCODE_CLI_PATH env override (the .cjs itself or the install root);
//   2. common Windows install roots (%LOCALAPPDATA%\Programs, Program Files,
//      Program Files (x86) on every configured drive) scanning for
//      <root>/*[Zz][Cc]ode*/resources/glm/zcode.cjs;
//   3. registry App Paths (HKCU/HKLM ZCode.exe) via `reg query`;
//   4. ~/.zcode neighbors (last resort).
// Purely filesystem-based (no subprocess) so driver construction stays cheap;
// everything is injectable for tests (env/existsSync/readdirSync/regQuery).
function discoverZCodeCli(options = {}) {
  const env = options.env || process.env;
  const exists = options.existsSync || safeExists;
  const readdir = options.readdirSync || safeReaddir;
  const regQuery = options.regQuery || defaultRegQuery;
  const home = options.homedir || os.homedir();

  const candidates = [];
  const envPath = String(env.ZCODE_CLI_PATH || '').trim();
  if (envPath) {
    candidates.push(envPath, path.join(envPath, 'resources', 'glm', 'zcode.cjs'));
  }
  const rootExprs = [
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs'),
    env.ProgramFiles,
    env['ProgramFiles(x86)'],
    'C:\\Program Files',
    'C:\\Program Files (x86)',
    'D:\\Program Files',
    'D:\\Program Files (x86)',
  ].filter(Boolean);
  for (const root of rootExprs) {
    candidates.push(path.join(root, 'ZCode', 'resources', 'glm', 'zcode.cjs'));
    for (const name of readdir(root)) {
      if (/^zcode/i.test(name) || /zcode$/i.test(name)) {
        candidates.push(path.join(root, name, 'resources', 'glm', 'zcode.cjs'));
      }
    }
  }
  // macOS desktop layout (cheap extra candidate, harmless elsewhere).
  candidates.push('/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs');
  // Registry App Paths: the desktop registers ZCode.exe there on install.
  for (const hive of ['HKCU', 'HKLM']) {
    const output = regQuery(`${hive}\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\ZCode.exe`);
    const match = output && output.match(/REG_SZ\s+(\S*ZCode\.exe)/i);
    if (match) candidates.push(path.join(path.dirname(match[1]), 'resources', 'glm', 'zcode.cjs'));
  }
  candidates.push(
    path.join(home, '.zcode', 'cli', 'zcode.cjs'),
    path.join(home, '.zcode', 'zcode.cjs'),
  );

  const seen = new Set();
  for (const candidate of candidates) {
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    if (exists(candidate)) return { path: candidate, source: 'discovered' };
  }
  return null;
}

// Version probe for /agents: spawns `node <zcode.cjs> --version`. Skipped under
// the node:test runner so unit/integration suites never spawn a real 12MB CLI
// bundle; production gets a real version string (cached by agent-discovery).
function probeZCodeVersion(cliPath) {
  if (process.env.NODE_TEST_CONTEXT) return null;
  try {
    const result = spawnSync(process.execPath, [cliPath, '--version'], {
      timeout: 10000, windowsHide: true, encoding: 'utf8',
    });
    if (result.error || result.status !== 0) return null;
    const match = String(result.stdout || result.stderr || '').match(/(\d+\.\d+[\w.-]*)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Driver factory
// ---------------------------------------------------------------------------

function createZCodeDriver(options = {}) {
  const injected = Boolean(options.appServerSpawn);
  // Under the node:test runner an un-injected driver must stay a deterministic
  // 501 placeholder (agent-drivers.test.js): discovery on a dev machine with
  // ZCode installed would otherwise spawn real app-server children in tests.
  const testContext = Boolean(process.env.NODE_TEST_CONTEXT);
  let cli = null;
  if (injected) {
    cli = { path: options.cliPath || '<injected app-server>', source: 'injected' };
  } else if (!testContext) {
    cli = options.cli || discoverZCodeCli({ env: options.env });
  }
  if (!cli) {
    const reason = testContext
      ? 'ZCode app-server transport is not scripted in this test context; inject an appServerSpawn double to drive it'
      : 'ZCode was not found on this machine; the bundled zcode CLI (app-server --stdio) is required';
    return createUnavailableZCodeDriver(reason);
  }
  return createAppServerZCodeDriver(options, cli);
}

// Honest 501 shell (the pre-driver behavior, kept for missing installs and
// unscripted test contexts).
function createUnavailableZCodeDriver(reason) {
  return {
    agentId: 'zcode',
    unavailableReason: reason,
    startChatSession() {
      throw Object.assign(new Error(this.unavailableReason), { status: 501 });
    },
    listSessions() { return []; },
    getState() { return null; },
    getSession() { return null; },
    getSessionTokenUsage() { return { used: 0, hasUsage: false }; },
    subscribe() { throw Object.assign(new Error('session not found'), { status: 404 }); },
    async sendInput() { throw Object.assign(new Error(this.unavailableReason), { status: 501 }); },
    resolvePermission() { throw Object.assign(new Error(this.unavailableReason), { status: 501 }); },
    abort() {},
    deleteSession() { return false; },
    async listSupportedCommands() { return []; },
    findClaudeExecutableForSdk() { return null; },
  };
}

// ---------------------------------------------------------------------------
// app-server transport
// ---------------------------------------------------------------------------

function createAppServerZCodeDriver(options, cli) {
  const log = typeof options.log === 'function' ? options.log : () => {};
  const sessions = new Map();
  const zcodeSessions = new Map(); // zcode sessionId (sess_...) -> driver sessionId
  const persist = resolvePersistence(options);
  let diskIndex = null;
  let nextId = 1;
  let nextPermissionId = 1;
  let bridge = null;
  let desktopProviderCache; // lazily-read ~/.zcode/v2 providers (agent-owned auth)

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
    if (session.outputBuffer.length > MAX_PERSISTED_EVENTS) session.outputBuffer.shift();
    for (const listener of session.listeners) {
      try { listener(event); } catch { /* listener errors never break the turn */ }
    }
  }

  function setState(session, state) {
    session.state = state;
    emit(session, { type: 'claude/state', state, turn: session.turns });
  }

  // ---- persistence (records share ~/.agent-terminal/cli-sessions with the
  // other CLI drivers but carry their own schema; only this driver claims
  // them). The zcode session id (sess_...) is stored as threadId so a restart
  // resumes the server-side conversation instead of starting a new one. ----

  function recordFile(sessionId) {
    return path.join(persist.dir, `${safeFileStem(sessionId)}.json`);
  }

  function readRecord(file) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (parsed && parsed.schema === APP_SERVER_PERSIST_SCHEMA && parsed.agentId === 'zcode'
        && parsed.transport === 'app-server' && typeof parsed.sessionId === 'string' && parsed.sessionId) return parsed;
    } catch { /* corrupt or foreign records are skipped, never fatal */ }
    return null;
  }

  function syncDiskIndex() {
    if (!persist.enabled) return null;
    if (!diskIndex) diskIndex = new Map();
    else diskIndex.clear();
    let names = [];
    try { names = fs.readdirSync(persist.dir).filter(name => name.endsWith('.json')); } catch { return diskIndex; }
    for (const name of names) {
      const file = path.join(persist.dir, name);
      const record = readRecord(file);
      if (record) diskIndex.set(record.sessionId, { file, summary: persistedSummary(record) });
    }
    return diskIndex;
  }

  function persistedSummary(record) {
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

  function persistSession(session) {
    if (!persist.enabled) return;
    try {
      const file = recordFile(session.sessionId);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `${JSON.stringify({
        schema: APP_SERVER_PERSIST_SCHEMA,
        agentId: 'zcode',
        transport: 'app-server',
        sessionId: session.sessionId,
        projectSlug: session.projectSlug,
        projectPath: session.projectPath,
        state: session.state,
        model: session.model,
        selectedModel: session.selectedModel,
        aiProfileId: session.aiProfileId,
        permissionMode: session.permissionMode,
        title: session.title || null,
        turns: session.turns,
        startedAt: session.startedAt,
        endedAt: session.endedAt,
        // The ZCode Protocol session id: session/resume needs it after a restart.
        threadId: session.zcodeSessionId || null,
        lastResult: session.lastResult || '',
        usage: { ...session.usage },
        peakTurnTokens: session.peakTurnTokens || 0,
        events: session.outputBuffer.slice(-MAX_PERSISTED_EVENTS),
        updatedAt: new Date().toISOString(),
      })}\n`, 'utf8');
      if (diskIndex) diskIndex.set(session.sessionId, { file: recordFile(session.sessionId), summary: summary(session) });
    } catch {
      // Read-only home or full disk degrades to memory-only behavior.
      persist.enabled = false;
      diskIndex = null;
    }
  }

  function removeRecord(sessionId) {
    if (diskIndex) diskIndex.delete(sessionId);
    if (!persist.enabled) return;
    try {
      const file = recordFile(sessionId);
      if (fs.existsSync(file) && readRecord(file)) fs.rmSync(file, { force: true });
    } catch { /* already gone */ }
  }

  function restoreSession(id) {
    if (!persist.enabled) return null;
    const index = syncDiskIndex();
    const entry = index && index.get(id);
    if (!entry) return null;
    const record = readRecord(entry.file);
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
      effort: null,
      title: record.title || null,
      turns: Number(record.turns) || 0,
      startedAt: record.startedAt || new Date().toISOString(),
      endedAt: record.endedAt || null,
      pendingPermission: null,
      pendingApproval: null,
      outputBuffer: Array.isArray(record.events) ? record.events.slice(-MAX_PERSISTED_EVENTS) : [],
      listeners: new Set(),
      zcodeSessionId: record.threadId || null,
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
      turnPromise: Promise.resolve(),
    };
    sessions.set(id, session);
    return session;
  }

  const runner = {
    agentId: 'zcode',

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
        zcodeSessionId: null,
        currentTurn: null,
        lastResult: '',
        lastDiag: '',
        usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
        peakTurnTokens: 0,
        turnTokenUsage: null,
        turnPromise: Promise.resolve(),
      };
      sessions.set(sessionId, session);
      emit(session, {
        type: 'claude/session-ready',
        model: session.model,
        aiProfileId: session.aiProfileId,
        permissionMode: session.permissionMode,
        message: 'zcode session is ready. Send a message to start the first turn.',
      });
      // Write the record immediately so a session with no turns yet still
      // shows up in the sidebar after a restart.
      persistSession(session);
      return { sessionId };
    },

    listSessions(filter = {}) {
      const byId = new Map();
      const index = syncDiskIndex();
      if (index) {
        for (const entry of index.values()) {
          if (filter.projectSlug && entry.summary.projectSlug !== filter.projectSlug) continue;
          byId.set(entry.summary.sessionId, entry.summary);
        }
      }
      for (const session of sessions.values()) {
        if (filter.projectSlug && session.projectSlug !== filter.projectSlug) continue;
        byId.set(session.sessionId, summary(session));
      }
      return [...byId.values()];
    },

    getState(id) {
      const session = sessions.get(id) || restoreSession(id);
      if (!session) return null;
      return {
        ...summary(session),
        listenerCount: session.listeners.size,
        bufferedEvents: session.outputBuffer.length,
      };
    },

    getSession(id) { return sessions.get(id) || restoreSession(id); },

    getSessionTokenUsage(id) {
      const session = sessions.get(id) || restoreSession(id);
      if (!session) return { used: 0, hasUsage: false };
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
      const session = sessions.get(id) || restoreSession(id);
      if (!session) throw Object.assign(new Error('session not found'), { status: 404 });
      for (const event of session.outputBuffer) listener(event);
      session.listeners.add(listener);
      return () => session.listeners.delete(listener);
    },

    async sendInput(id, text, profile, sendOptions = {}) {
      const session = sessions.get(id) || restoreSession(id);
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
      session.lastPromptText = value;

      let runtimeModel = null;
      try {
        // Invalid injected profiles (no base URL) throw here and surface as a
        // turn error, mirroring the codex driver's bridgeSpecFor contract.
        runtimeModel = runtimeModelFor(profile);
        await ensureBridge();
        await ensureZcodeSession(session, runtimeModel);
      } catch (error) {
        emit(session, { type: 'claude/error', message: `zcode app-server unavailable: ${error.message}`.slice(0, 500) });
        setState(session, 'idle');
        return { started: false };
      }

      emit(session, {
        type: 'claude/user-prompt',
        text: value,
        attachments: (sendOptions.displayAttachments || []).map(({ id: attachmentId, name, mediaType, size, width, height, url }) => ({ id: attachmentId, name, mediaType, size, width, height, url })),
      });
      setState(session, 'running');
      // Until the first session/event lands the UI would show dead air
      // (reasoning models think for tens of seconds first) — announce it.
      setState(session, 'thinking');
      try {
        // Image attachments have no verified ZCode Protocol wire shape yet
        // (session/send attachments are an opaque record); text attachments
        // ride the prompt text, images are refused with an honest notice.
        const images = attachments.filter(item => item.mediaType.startsWith('image/'));
        if (images.length) {
          emitDiag(session, { type: 'claude/stderr', text: 'the zcode app-server driver does not support image attachments yet' });
        }
        await bridge.request('session/send', {
          sessionId: session.zcodeSessionId,
          content: appendTextAttachments(value, attachments),
          ...(runtimeModel ? { runtimeModel } : {}),
        }, { timeoutMs: 30000 });
        session.currentTurn = {
          turnId: null,
          announcedText: new Set(),
          streamedText: new Set(),
          announcedThinking: new Set(),
          streamedThinking: new Set(),
          sawEvent: false,
        };
        session.turnPromise = new Promise(resolve => { session.currentTurn.resolve = resolve; });
        return { started: true };
      } catch (error) {
        emit(session, { type: 'claude/error', message: `zcode turn failed to start: ${error.message}`.slice(0, 500) });
        session.currentTurn = null;
        setState(session, 'idle');
        return { started: false };
      }
    },

    resolvePermission(id, requestId, decision) {
      const session = sessions.get(id) || restoreSession(id);
      if (!session || !session.pendingApproval || session.pendingApproval.requestId !== requestId) {
        throw Object.assign(new Error('permission request not found or already resolved'), { status: 409 });
      }
      const allow = decision && decision.allow === true;
      const approval = session.pendingApproval;
      session.pendingApproval = null;
      session.pendingPermission = null;
      const response = allow ? approval.allowResponse : approval.denyResponse;
      emit(session, {
        type: 'claude/permission-resolved',
        requestId,
        allow,
        decision: response && response.decision,
        resolvedAt: new Date().toISOString(),
      });
      setState(session, 'running');
      approval.resolve(response);
      return { ok: true, started: true, decision: response && response.decision };
    },

    updateSelection(id, profile, selectedModel) {
      const session = sessions.get(id) || restoreSession(id);
      if (!session) throw Object.assign(new Error('session not found'), { status: 404 });
      if (ACTIVE_STATES.has(session.state)) {
        throw Object.assign(new Error('session already has an active turn'), { status: 409 });
      }
      const fromAiProfileId = session.aiProfileId || null;
      const fromModel = session.selectedModel || session.model || null;
      session.aiProfileId = profile && profile.id || null;
      session.selectedModel = selectedModel || (profile && (profile.mainModel || profile.models && profile.models.default)) || null;
      session.model = modelForProfile(profile);
      emit(session, {
        type: 'claude/selection-changed',
        fromAiProfileId,
        toAiProfileId: session.aiProfileId,
        fromModel,
        toModel: session.selectedModel,
      });
      persistSession(session);
      return summary(session);
    },

    abort(id) {
      const session = sessions.get(id) || restoreSession(id);
      if (!session) return;
      session.abortedByUser = true;
      denyPendingApproval(session, 'aborted');
      const currentTurn = session.currentTurn;
      if (currentTurn && bridge && bridge.state === 'ready' && session.zcodeSessionId) {
        // Ask the app-server to interrupt the live turn; a failure falls back
        // to the local turn teardown below (the bridge recycles lazily).
        bridge.request('session/stop', { sessionId: session.zcodeSessionId }, { timeoutMs: 5000 })
          .catch(() => recycleBridge('session/stop failed'));
      }
      if (!['idle', 'ended'].includes(session.state)) {
        session.state = 'aborted';
        emit(session, { type: 'claude/aborted' });
        finishTurn(session, { resultType: 'cancelled', response: '' });
      }
      persistSession(session);
    },

    deleteSession(id) {
      const session = sessions.get(id) || restoreSession(id);
      if (!session) {
        const index = syncDiskIndex();
        if (index && index.has(id)) { removeRecord(id); return true; }
        return false;
      }
      if (ACTIVE_STATES.has(session.state)) runner.abort(id);
      denyPendingApproval(session, 'deleted');
      if (session.zcodeSessionId) zcodeSessions.delete(session.zcodeSessionId);
      const deleted = sessions.delete(id);
      removeRecord(id);
      return deleted;
    },

    async listSupportedCommands() { return []; },

    findClaudeExecutableForSdk() { return null; },

    // Test seams.
    get transportMode() { return 'app-server'; },
    get bridgeState() { return bridge ? bridge.state : 'uncreated'; },
    get cliPath() { return cli.path; },
  };

  // -- bridge lifecycle ----------------------------------------------------

  function ensureBridge() {
    if (bridge && bridge.state === 'closed') { bridge = null; }
    if (bridge && bridge.state === 'crashed') { recycleBridge('bridge exhausted its restart budget'); }
    if (!bridge) {
      bridge = createAppServerBridge({
        // The bundled CLI is a node bundle: spawn it through the running node
        // runtime with the app-server stdio subcommand.
        command: options.nodePath || process.execPath,
        args: [cli.path, 'app-server', '--stdio'],
        spawn: options.appServerSpawn,
        onEvent: handleNotification,
        onServerRequest: handleServerRequest,
        onUnexpectedExit: handleBridgeCrash,
        idleTimeoutMs: options.idleTimeoutMs !== undefined ? options.idleTimeoutMs : 10 * 60 * 1000,
        requestTimeoutMs: options.requestTimeoutMs !== undefined ? options.requestTimeoutMs : 120000,
        restartBackoffMs: options.restartBackoffMs,
        log,
      });
    }
    return bridge.start();
  }

  function recycleBridge(reason) {
    log(`recycling zcode app-server bridge: ${reason}`);
    if (bridge) bridge.close().catch(() => {});
    bridge = null;
    failoverSessions(`zcode app-server exited: ${reason}`);
  }

  // The app-server died mid-flight: turn.completed will never arrive, so
  // every live turn is finished with an error here (the bridge restarts
  // itself and the next turn retries with a fresh session/resume).
  function handleBridgeCrash(error) {
    failoverSessions(`zcode app-server exited unexpectedly: ${error && error.message || 'crashed'}`);
  }

  function failoverSessions(reason) {
    for (const session of sessions.values()) {
      denyPendingApproval(session, reason);
      if (!session.currentTurn) continue;
      finishTurn(session, { resultType: 'error', response: '' }, String(reason).slice(0, 500));
    }
  }

  // -- zcode session lifecycle ----------------------------------------------

  async function ensureZcodeSession(session, runtimeModel) {
    if (session.zcodeSessionId) {
      try {
        await bridge.request('session/resume', {
          sessionId: session.zcodeSessionId,
          ...(runtimeModel ? { runtimeModel } : {}),
        }, { timeoutMs: 30000 });
        zcodeSessions.set(session.zcodeSessionId, session.sessionId);
        await subscribeZcodeSession(session);
        return;
      } catch (error) {
        // The app-server child restarted or rolled the session away; fall
        // through to a fresh one (the client-side history stays).
        zcodeSessions.delete(session.zcodeSessionId);
        session.zcodeSessionId = null;
        log(`zcode session resume failed, creating a new one: ${error.message}`);
      }
    }
    const result = await bridge.request('session/create', {
      workspace: { workspacePath: session.projectPath, workspaceKey: session.projectPath },
      mode: MODE_FOR_PERMISSION[session.permissionMode] || 'build',
      ...(runtimeModel ? { runtimeModel } : {}),
    }, { timeoutMs: 60000 });
    const zcodeId = result && result.session && (result.session.sessionId || result.session.id);
    if (!zcodeId) throw new Error('zcode app-server did not return a session');
    session.zcodeSessionId = zcodeId;
    zcodeSessions.set(zcodeId, session.sessionId);
    if (result.session && result.session.title && !session.title) session.title = result.session.title;
    await subscribeZcodeSession(session);
    persistSession(session);
  }

  async function subscribeZcodeSession(session) {
    await bridge.request('session/subscribe', {
      sessionId: session.zcodeSessionId,
      deliveryKind: 'desktop-continuous',
    }, { timeoutMs: 30000 });
  }

  // -- notifications ---------------------------------------------------------

  function handleNotification({ method, params }) {
    if (!params) return;
    const session = routeZcodeSession(params.sessionId);
    if (!session) return; // notifications for unknown sessions are ignored
    if (method === 'session/event') return onSessionEvent(session, params);
    if (method === 'state.updated') {
      // status patches (running/idle) only mark liveness here; turn completion
      // is authoritative on the session/event stream.
      markActivity(session);
      return;
    }
    // computer-use/operation-event, v4/telemetry/event, process/*, ... are noise.
  }

  function routeZcodeSession(zcodeSessionId) {
    if (!zcodeSessionId) return null;
    const driverId = zcodeSessions.get(zcodeSessionId);
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

  function onSessionEvent(session, params) {
    markActivity(session);
    const turn = session.currentTurn;
    if (!turn) return; // events outside a driver-tracked turn (e.g. background) are ignored
    const { type, payload } = params;
    if (params.turnId && !turn.turnId) turn.turnId = params.turnId;
    if (turn.turnId && params.turnId && params.turnId !== turn.turnId) return; // stale turn

    switch (type) {
      case 'turn.started': return; // announced locally at send time
      case 'model.streaming': return onModelStreaming(session, payload || {});
      case 'tool.updated': return onToolUpdated(session, payload || {});
      case 'turn.completed': return finishTurn(session, payload || {});
      case 'session.titleUpdated': {
        if (payload && payload.title) session.title = String(payload.title).slice(0, 200);
        return;
      }
      case 'permission.requested':
      case 'permission.resolved':
        return; // approvals are driven by the interaction/requestPermission RPC
      default: return; // session.updated, checkpoint.*, streamRecovery.*, ...
    }
  }

  function onModelStreaming(session, payload) {
    const turn = session.currentTurn;
    if (!turn) return;
    const { kind } = payload;
    const messageId = payload.assistantMessageId || `text-${session.turns}`;
    if (kind === 'text_start') {
      turn.announcedText.add(messageId);
      emit(session, { type: 'claude/text-start', id: messageId });
    } else if (kind === 'text_delta') {
      if (!turn.announcedText.has(messageId)) {
        turn.announcedText.add(messageId);
        emit(session, { type: 'claude/text-start', id: messageId });
      }
      turn.streamedText.add(messageId);
      emit(session, { type: 'claude/text-delta', id: messageId, text: String(payload.delta || '') });
    } else if (kind === 'reasoning_start') {
      turn.announcedThinking.add(messageId);
      emit(session, { type: 'claude/thinking-start', id: messageId });
    } else if (kind === 'reasoning_delta') {
      if (!turn.announcedThinking.has(messageId)) {
        turn.announcedThinking.add(messageId);
        emit(session, { type: 'claude/thinking-start', id: messageId });
      }
      turn.streamedThinking.add(messageId);
      emit(session, { type: 'claude/thinking-delta', id: messageId, text: String(payload.delta || '') });
    } else if (kind === 'tool_call') {
      setState(session, 'tool-running');
      emit(session, {
        type: 'claude/tool-use',
        id: payload.toolCallId || `tool-${session.turns}-${session.outputBuffer.length}`,
        name: payload.toolName || 'Tool',
        input: payload.input && typeof payload.input === 'object' ? payload.input : { input: payload.input },
      });
    } else if (kind === 'tool_error') {
      emit(session, {
        type: 'claude/tool-result',
        id: payload.toolCallId || `tool-${session.turns}-${session.outputBuffer.length}`,
        output: String(payload.delta || payload.error || 'tool failed').slice(0, 4000),
        isError: true,
      });
    }
    // text_end / reasoning_end / tool_input_* deltas need no normalized event;
    // the tool_use input arrives complete on the tool_call kind.
  }

  function onToolUpdated(session, payload) {
    if (!payload.result || !payload.toolCallId) return; // scheduling metadata only
    setState(session, 'running');
    emit(session, {
      type: 'claude/tool-result',
      id: payload.toolCallId,
      output: toolResultText(payload.result).slice(0, 4000),
      isError: payload.result.success === false,
    });
  }

  function finishTurn(session, payload, forcedError) {
    const current = session.currentTurn;
    if (!current) return;
    session.currentTurn = null;
    denyPendingApproval(session, 'turn completed'); // the server cancels unanswered approvals
    session.turns += 1;
    const usage = payload.usage || {};
    const input = Number(usage.inputTokens || 0);
    const output = Number(usage.outputTokens || 0);
    const cached = Number(usage.cacheReadTokens || 0);
    if (input || output || cached) {
      session.usage.inputTokens += input;
      session.usage.outputTokens += output;
      session.usage.cachedTokens += cached;
      session.peakTurnTokens = Math.max(session.peakTurnTokens || 0, input + output + cached);
      emit(session, { type: 'claude/usage', usage: { input_tokens: input, output_tokens: output } });
    }
    const resultType = String(payload.resultType || 'success');
    const response = String(payload.response != null ? payload.response : session.lastResult || '');
    if (response) session.lastResult = response;
    const failed = resultType === 'error' || resultType === 'failed' || Boolean(forcedError);
    if (failed) {
      emitDiag(session, { type: 'claude/error', message: String(forcedError || `zcode turn ${resultType}`).slice(0, 500) });
    }
    if (resultType === 'cancelled' && !session.abortedByUser) {
      emit(session, { type: 'claude/aborted' });
    }
    emit(session, {
      type: 'claude/result',
      result: failed ? '' : response,
      model: session.model,
      isError: failed,
    });
    session.abortedByUser = false;
    if (!session.endedAt) session.state = 'idle';
    emit(session, { type: 'claude/state', state: 'idle', turn: session.turns });
    persistSession(session);
    if (current.resolve) current.resolve();
  }

  function emitDiag(session, event) {
    const text = event.text != null ? event.text : event.message;
    if (text === session.lastDiag) return;
    session.lastDiag = String(text == null ? '' : text);
    emit(session, event);
  }

  // -- server-initiated requests (preferences + approvals) ------------------

  async function handleServerRequest(method, params) {
    if (method === 'session/requestRuntimePreferences') {
      // Defaults verified live: native search off, memory off, question
      // auto-resolution off; answering unblocks session/create and session/send.
      return RUNTIME_PREFERENCES;
    }
    if (method === 'interaction/requestPermission') {
      const session = routeZcodeSession(params && params.sessionId);
      if (!session) throw Object.assign(new Error('zcode approval for an unknown session'), { status: 404 });
      return await waitForApproval(session, method, params || {});
    }
    // Official MCP plugin auth (image_search & friends) and user-input
    // interactions have no terminal surface yet: rejecting them is verified
    // harmless (the session continues; affected tools report a failure).
    throw Object.assign(new Error(`zcode app-server request ${method} is not supported`), { status: 501 });
  }

  function waitForApproval(session, method, params) {
    const choices = Array.isArray(params.options) ? params.options.filter(Boolean) : [];
    const allowChoice = choices.find(choice => choice.kind === 'allow_once' || choice.kind === 'allow_always');
    const denyChoice = choices.find(choice => choice.kind === 'deny');
    const described = describeApproval(params);
    return new Promise(resolve => {
      const requestId = params.requestId || `zcode-perm-${nextPermissionId++}`;
      session.pendingApproval = {
        requestId,
        allowResponse: allowChoice && allowChoice.response || { decision: 'allow', reason: 'Approved by the terminal user' },
        denyResponse: denyChoice && denyChoice.response || { decision: 'deny', reason: 'Denied' },
        resolve,
      };
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

  function describeApproval(params) {
    const input = params.input && typeof params.input === 'object' ? params.input : {};
    const commandText = String(input.command || input.path || input.file || '');
    const toolName = String(params.toolName || (/file|edit|patch/i.test(commandText) ? 'Edit' : 'Bash'));
    const title = toolName === 'Edit' ? 'ZCode wants to modify files' : 'ZCode wants to run a command';
    return {
      toolName,
      title,
      description: commandText.slice(0, 200) || String(params.reason || 'tool approval').slice(0, 200),
      promptPreview: JSON.stringify({ toolName, command: commandText, riskLevel: params.riskLevel || '' }).slice(0, 500),
      summary: {
        toolName,
        title,
        description: commandText.slice(0, 200) || String(params.reason || '').slice(0, 200),
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
      decision: approval.denyResponse && approval.denyResponse.decision,
      message: reason,
      resolvedAt: new Date().toISOString(),
    });
    approval.resolve(approval.denyResponse);
  }

  // -- model runtime ----------------------------------------------------------

  // Profile-injected providers become inline runtimeModel configs; agent-owned
  // auth bridges the desktop's own provider store so a logged-in ZCode desktop
  // works with zero terminal-side configuration. Returns null when the
  // app-server should use its own ~/.zcode/cli/config.json. The desktop store
  // is never read under the test runner without an explicit zcodeHome, so
  // injected-double tests stay machine-independent.
  function runtimeModelFor(profile) {
    if (profile && profile.apiKey) return injectedRuntimeModel(profile);
    if (desktopProviderCache === undefined) {
      desktopProviderCache = options.zcodeHome || !process.env.NODE_TEST_CONTEXT
        ? readDesktopRuntimeModel(cli, options)
        : null;
    }
    return desktopProviderCache;
  }

  // Driver session ids must never collide with persisted records from a
  // previous process: a collision would shadow a restartable session behind
  // an empty one.
  function nextDriverSessionId() {
    const taken = new Set(sessions.keys());
    const index = syncDiskIndex();
    if (index) for (const id of index.keys()) taken.add(id);
    let id = `zcode-${nextId++}`;
    while (taken.has(id)) id = `zcode-${nextId++}`;
    return id;
  }

  return runner;
}

// ---------------------------------------------------------------------------
// module helpers
// ---------------------------------------------------------------------------

function modelForProfile(profile) {
  if (!profile) return null;
  const model = resolveOpenAIModel(profile);
  return model ? String(model) : null;
}

function runtimeModelRevision(spec) {
  return `wb-${crypto.createHash('sha1').update(JSON.stringify(spec)).digest('hex').slice(0, 16)}`;
}

// Workbench profile -> ZCode runtimeModel. Anthropic-compatible base URLs
// (the profile default) map to the anthropic provider kind; everything else
// falls back to the resolved OpenAI-compatible endpoint.
function injectedRuntimeModel(profile) {
  const anthropicBase = String(profile.baseUrl || '').trim();
  const openaiBase = resolveOpenAIBaseUrl(profile);
  const useAnthropic = Boolean(anthropicBase) && profile.protocol !== 'openai-compatible';
  if (!useAnthropic && !openaiBase) {
    throw new Error('the selected provider needs a base URL for ZCode');
  }
  const modelId = resolveOpenAIModel(profile) || 'default';
  const providerId = 'agent-terminal';
  const spec = {
    providerId, modelId,
    kind: useAnthropic ? 'anthropic' : 'openai-compatible',
    baseURL: useAnthropic ? anthropicBase : openaiBase,
    apiKey: profile.apiKey,
  };
  return {
    revision: runtimeModelRevision(spec),
    generatedAt: Date.now(),
    model: { providerId, modelId },
    provider: {
      providerId,
      kind: spec.kind,
      label: 'Agent Terminal',
      source: 'ephemeral',
      baseURL: spec.baseURL,
      apiKey: { source: 'inline', value: spec.apiKey },
      models: [{
        modelId,
        ...(Number(profile.contextWindow) > 0 ? { contextWindow: profile.contextWindow } : {}),
        supportsTools: true,
      }],
    },
  };
}

// Agent-owned auth: mirror what the ZCode desktop itself does — its provider
// selection lives in ~/.zcode/v2/config.json (keyed like "builtin:bigmodel"),
// and model catalogs ship beside the CLI in resources/model-providers. Any
// read/parse failure degrades to null (the app-server then applies its own
// config or reports an actionable model_config_missing error).
function readDesktopRuntimeModel(cli, options) {
  try {
    const home = options.zcodeHome || path.join(os.homedir(), '.zcode');
    const configPath = path.join(home, 'v2', 'config.json');
    if (!fs.existsSync(configPath)) return null;
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const providers = config && config.provider && typeof config.provider === 'object' ? config.provider : {};
    let chosen = null;
    let chosenScore = -1;
    for (const [key, value] of Object.entries(providers)) {
      if (!value || typeof value !== 'object') continue;
      if (value.enabled === false || value.enabled === 'false') continue;
      const options2 = value.options && typeof value.options === 'object' ? value.options : {};
      if (!options2.apiKey || !options2.baseURL) continue;
      const providerId = String(key).split(':').pop() || key;
      let score = 1;
      if (/coding-plan/i.test(providerId)) score += 2;
      if (/bigmodel|zai|glm/i.test(providerId)) score += 1;
      if (score > chosenScore) { chosenScore = score; chosen = { providerId, value, options: options2 }; }
    }
    if (!chosen) return null;
    const modelId = desktopDefaultModel(cli, chosen.providerId, chosen.value);
    if (!modelId) return null;
    const spec = { providerId: chosen.providerId, modelId, baseURL: chosen.options.baseURL };
    return {
      revision: runtimeModelRevision(spec),
      generatedAt: Date.now(),
      model: { providerId: chosen.providerId, modelId },
      provider: {
        providerId: chosen.providerId,
        kind: chosen.value.kind === 'openai' || chosen.value.kind === 'openai-compatible' ? chosen.value.kind : 'anthropic',
        label: String(chosen.value.name || chosen.providerId).slice(0, 100),
        source: 'ephemeral',
        baseURL: chosen.options.baseURL,
        apiKey: { source: 'inline', value: String(chosen.options.apiKey) },
        models: [{ modelId }],
      },
    };
  } catch {
    return null;
  }
}

// Model catalog lookup: resources/model-providers/*.json next to the CLI
// bundle; falls back to the provider's own models list, then 'glm-4.7'.
function desktopDefaultModel(cli, providerId, providerValue) {
  try {
    if (Array.isArray(providerValue.models) && providerValue.models.length) {
      const first = providerValue.models[0];
      return String(first.modelId || first.id || first).slice(0, 128);
    }
    const catalogDir = path.resolve(cli.path, '..', '..', 'model-providers');
    for (const name of fs.readdirSync(catalogDir).filter(item => item.endsWith('.json')).sort().reverse()) {
      const catalog = JSON.parse(fs.readFileSync(path.join(catalogDir, name), 'utf8'));
      const entry = Array.isArray(catalog && catalog.providers)
        && catalog.providers.find(item => item && (item.id === providerId || item.id === `builtin:${providerId}`));
      const models = entry && Array.isArray(entry.models) ? entry.models : [];
      const model = models.find(item => item && item.default) || models[0];
      if (model && (model.id || model.modelId)) return String(model.id || model.modelId).slice(0, 128);
    }
  } catch { /* catalog is best-effort */ }
  return 'glm-4.7';
}

// Tool results arrive as { success, content, display } where content may be a
// string or an array of parts; normalize to displayable text.
function toolResultText(result) {
  if (result == null) return '';
  if (typeof result.display === 'string' && result.display) return result.display;
  const content = result.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(part => {
      if (typeof part === 'string') return part;
      if (part && typeof part.text === 'string') return part.text;
      return '';
    }).filter(Boolean).join('\n');
  }
  if (result.success === false && result.error) return String(result.error);
  return '';
}

function safeFileStem(value) {
  return String(value).replace(/[^A-Za-z0-9._-]/g, '_');
}

// Mirrors the CLI runners' resolution: explicit config always wins; otherwise
// persistence is suppressed under the node:test runner so test runs never
// touch the real session store. An injected app-server spawn doubles the
// app-server child only and does NOT suppress persistence.
function resolvePersistence(options) {
  const configured = options.persistence && typeof options.persistence === 'object' ? options.persistence : {};
  const explicitlyConfigured = options.persistence != null;
  const ephemeralTestContext = Boolean(process.env.NODE_TEST_CONTEXT);
  const enabled = options.persistence !== null
    && configured.enabled !== false
    && (explicitlyConfigured || !ephemeralTestContext);
  const dir = path.resolve(configured.dir || path.join(os.homedir(), '.agent-terminal', 'cli-sessions'));
  return { enabled, dir };
}

module.exports = {
  createZCodeDriver,
  discoverZCodeCli,
  probeZCodeVersion,
  runtimeModelForProfile: injectedRuntimeModel,
  toolResultText,
  MODE_FOR_PERMISSION,
  APP_SERVER_PERSIST_SCHEMA,
};
