'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { appendTextAttachments, normalizeAttachments } = require('../../../contracts');

// Shared subprocess runner for CLI agents that can stream normalized JSON
// events (codex exec --json, opencode run --format json). Implements the same
// WorkbenchRunner surface as the Claude Code SDK runner so AgentRegistry can
// route to it transparently.
//
// config:
//   agentId         contracts agent id
//   command         executable name on PATH (spawned with shell on Windows)
//   promptViaStdin  true -> prompt is written to stdin (codex "-"); false ->
//                   prompt comes back from spawnArgs as a normal argv element
//   spawnArgs       ({ projectPath, model, sandbox, threadId, prompt }) -> string[]
//   parseLine       (parsedJson, session, helpers) -> normalized events[]
//   sandboxFor      (permissionMode) -> string|undefined
//   modelFor        (runtimeProfile) -> string|null
//   envFor          (runtimeProfile) -> object  (profile-injected agents only)
const ACTIVE_STATES = new Set(['running', 'thinking', 'tool-running']);

// ---- session disk persistence ----
// Session records survive server restarts the same way the claude-code
// runner's per-project records do: every completed turn is flushed to a JSON
// sidecar file and lazily restored when a lookup misses the live map. Without
// this, a server restart wiped every codex/opencode session from the sidebar.
const PERSIST_SCHEMA = 'cli-json-runner-session/v1';
const MAX_PERSISTED_EVENTS = 5000;
const PERSIST_DEBOUNCE_MS = 250;
// Consecutive failed write rounds (atomic rename attempts included) before
// persistence degrades to memory-only. One-off failures — a Windows AV/EBUSY
// lock, a transient indexer handle — must not disable the feature.
const PERSIST_FAILURE_LIMIT = 3;
// Listing only needs the scalar header of a record; every header field is
// written before "events" (see toPersistedSession), so a bounded head read
// plus an early-terminated JSON parse suffices. A restart's first
// listSessions therefore never parses every session's full (up to
// 5000-event) payload.
const PERSIST_HEAD_BYTES = 8192;

// Default on-disk home for CLI driver sessions. Sits under the agent-terminal
// data root (~/.agent-terminal, beside profiles/projects/attachments) so the
// directory's lifetime matches the rest of the app's persisted state.
function defaultPersistDir() {
  return path.join(os.homedir(), '.agent-terminal', 'cli-sessions');
}

function safeFileStem(value) {
  return String(value).replace(/[^A-Za-z0-9._-]/g, '_');
}

function resolvePersistenceConfig(config) {
  // config.persistence: { dir?, enabled? } — the preferred shape (tests inject
  // an isolated temp dir here). config.persistDir is accepted as a thin alias:
  // a string selects the directory, null opts out entirely. Default: enabled
  // with ~/.agent-terminal/cli-sessions, so the production wiring (which just
  // calls createCodexDriver()/createOpenCodeDriver()) persists for free.
  // The default is suppressed in test contexts — an injected spawn double or
  // the node:test runner env — so test runs never write to (or read) the
  // user's real session store; an explicit persistence config always wins.
  const options = config.persistence && typeof config.persistence === 'object' ? config.persistence : {};
  const explicitlyConfigured = config.persistence != null || config.persistDir !== undefined;
  const ephemeralTestContext = Boolean(config.spawn) || Boolean(process.env.NODE_TEST_CONTEXT);
  const enabled = config.persistence !== null
    && options.enabled !== false
    && config.persistDir !== null
    && (explicitlyConfigured || !ephemeralTestContext);
  const dir = options.dir
    || (typeof config.persistDir === 'string' && config.persistDir)
    || defaultPersistDir();
  return { enabled, dir: path.resolve(dir) };
}

// Restored sessions can never be mid-subprocess: a restart killed it. ACTIVE
// persisted states therefore come back idle instead of dangling forever.
function restoredState(state) {
  return ACTIVE_STATES.has(state) ? 'idle' : (state || 'idle');
}

function persistedSummary(record) {
  return {
    sessionId: record.sessionId,
    projectSlug: record.projectSlug,
    state: restoredState(record.state),
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

function validPersistedHead(parsed, agentId) {
  return Boolean(parsed && parsed.schema === PERSIST_SCHEMA && parsed.agentId === agentId
    && typeof parsed.sessionId === 'string' && parsed.sessionId);
}

function readPersistedRecord(file, agentId) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    // The persist directory is shared by every CLI driver (codex, opencode,
    // ...): a runner must only ever claim records it wrote itself, otherwise
    // it would restore another agent's thread under the wrong parser/flags.
    if (parsed && parsed.schema === PERSIST_SCHEMA && typeof parsed.sessionId === 'string' && parsed.sessionId
      && (agentId === undefined || parsed.agentId === agentId)) return parsed;
  } catch { /* corrupt or partially written records are skipped, never fatal */ }
  return null;
}

// Summary-only read for the scan paths: header fields (validated shape) +
// a cheap completeness check that the record terminates like a finished
// write (every record ends with a closing brace), so a truncated/foreign
// file is skipped the same way a full parse would skip it.
function readPersistedHead(file) {
  let headText = '';
  let tailText = '';
  let size = 0;
  let headRead = 0;
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const head = Buffer.alloc(PERSIST_HEAD_BYTES);
      headRead = fs.readSync(fd, head, 0, PERSIST_HEAD_BYTES, 0);
      headText = head.toString('utf8', 0, headRead);
      ({ size } = fs.fstatSync(fd));
      if (size > headRead) {
        const tail = Buffer.alloc(16);
        const tailRead = fs.readSync(fd, tail, 0, tail.length, size - tail.length);
        tailText = tail.toString('utf8', 0, tailRead);
      }
    } finally { fs.closeSync(fd); }
  } catch { return null; }
  // A half-written (in-place truncated) record must be skipped, not listed.
  const complete = size > headRead ? /\}\s*$/.test(tailText) : /\}\s*$/.test(headText);
  if (!complete) return null;
  const marker = headText.indexOf('"events":');
  if (marker < 0) return readPersistedRecord(file); // tiny or oversized header: full read
  try {
    const parsed = JSON.parse(`${headText.slice(0, marker).replace(/,\s*$/, '')}}`);
    if (parsed && parsed.schema === PERSIST_SCHEMA) return parsed;
  } catch { /* header cut mid-token */ }
  return readPersistedRecord(file);
}

function indexRecordFromFile(file, agentId) {
  const head = readPersistedHead(file);
  if (!head || !validPersistedHead(head, agentId)) return null;
  return { file, summary: persistedSummary(head) };
}

function scanPersistDir(dir, agentId) {
  const index = new Map();
  let names = [];
  try { names = fs.readdirSync(dir).filter(name => name.endsWith('.json')); } catch { return index; }
  for (const name of names) {
    const file = path.join(dir, name);
    const entry = indexRecordFromFile(file, agentId);
    if (entry) index.set(entry.summary.sessionId, entry);
  }
  return index;
}

// Placeholder written the instant a session id is claimed (exclusive create)
// so a concurrently-running sibling runner can never take the same id.
function reservedRecord(agentId, sessionId, slug, projectPath) {
  return {
    schema: PERSIST_SCHEMA,
    agentId,
    sessionId,
    projectSlug: slug,
    projectPath,
    state: 'idle',
    model: null,
    selectedModel: null,
    aiProfileId: null,
    permissionMode: 'default',
    effort: null,
    title: null,
    turns: 0,
    startedAt: new Date().toISOString(),
    endedAt: null,
    threadId: null,
    lastResult: '',
    usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
    peakTurnTokens: 0,
    updatedAt: new Date().toISOString(),
    events: [],
  };
}

function createCliJsonRunner(config) {
  const sessions = new Map();
  let nextId = 1;
  const persistence = resolvePersistenceConfig(config);
  // sessionId -> { file, summary } for every readable record in the persist
  // directory. Built lazily on first use and refreshed with a cheap readdir
  // diff, so records written by a previous process become visible without
  // loading their event streams into memory.
  let diskIndex = null;
  const persistTimers = new Map();

  function sessionFile(sessionId) {
    return path.join(persistence.dir, `${safeFileStem(sessionId)}.json`);
  }

  function ensureDiskIndex() {
    if (!persistence.enabled) return null;
    if (!diskIndex) diskIndex = scanPersistDir(persistence.dir, config.agentId);
    return diskIndex;
  }

  function syncDiskIndex() {
    const index = ensureDiskIndex();
    if (!index) return null;
    let names = [];
    try { names = fs.readdirSync(persistence.dir).filter(name => name.endsWith('.json')); } catch { return index; }
    const present = new Set(names);
    const known = new Set();
    for (const entry of index.values()) known.add(path.basename(entry.file));
    for (const name of names) {
      if (known.has(name)) continue;
      const entry = indexRecordFromFile(path.join(persistence.dir, name), config.agentId);
      if (entry) index.set(entry.summary.sessionId, entry);
    }
    for (const [sessionId, entry] of index) {
      if (!present.has(path.basename(entry.file))) index.delete(sessionId);
    }
    return index;
  }

  function toPersistedSession(session) {
    // Field order matters: every scalar the listing/summary paths need is
    // written BEFORE "events" so scanPersistDir can read a bounded head
    // instead of parsing the whole (up to 5000-event) payload.
    return {
      schema: PERSIST_SCHEMA,
      agentId: config.agentId,
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
      // The underlying agent conversation id: codex `resume <id>` /
      // opencode `--session <id>` need it to continue the thread after a
      // restart.
      threadId: session.threadId || null,
      lastResult: session.lastResult || '',
      usage: { ...session.usage },
      peakTurnTokens: session.peakTurnTokens || 0,
      updatedAt: new Date().toISOString(),
      events: session.outputBuffer.slice(-MAX_PERSISTED_EVENTS),
    };
  }

  let persistFailures = 0;
  let tmpFileCounter = 0;

  function notePersistFailure() {
    // Transient write failures (AV locks, EBUSY, a yanked directory) must not
    // kill persistence for the whole process; only a run of consecutive
    // failed write rounds degrades to the memory-only behavior.
    persistFailures += 1;
    if (persistFailures >= PERSIST_FAILURE_LIMIT) disablePersistence();
  }

  function persistSession(session) {
    if (!persistence.enabled) return;
    const file = sessionFile(session.sessionId);
    const payload = `${JSON.stringify(toPersistedSession(session))}\n`;
    // Atomic replace: the complete new record is written to a sibling temp
    // file first and then renamed over the destination, so a crash mid-write
    // can only ever leave an unread .tmp leftover — the previous complete
    // record on disk is never destroyed by a half write.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const tmp = `${file}.${process.pid}-${++tmpFileCounter}.tmp`;
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(tmp, payload, 'utf8');
        try {
          fs.renameSync(tmp, file); // same-volume atomic replace
        } catch {
          // Windows can refuse to replace a destination an AV scanner or
          // indexer still holds open: drop the old copy and retry the move.
          // The temp file always carries the complete new version, so the
          // destination is only ever missing for one rename call.
          try { fs.unlinkSync(file); } catch { /* nothing to drop */ }
          fs.renameSync(tmp, file);
        }
        persistFailures = 0;
        if (diskIndex) diskIndex.set(session.sessionId, { file, summary: summary(session) });
        return;
      } catch {
        try { fs.unlinkSync(tmp); } catch { /* nothing to clean up */ }
      }
    }
    notePersistFailure();
  }

  function disablePersistence() {
    persistence.enabled = false;
    diskIndex = null;
    for (const timer of persistTimers.values()) clearTimeout(timer);
    persistTimers.clear();
  }

  // Events stream fast during a turn; coalesce disk writes instead of
  // rewriting the record on every emit. Turn boundaries (finish, abort,
  // selection changes, creation) always flush synchronously, so a process
  // exit can only ever lose the still-running turn.
  function schedulePersist(session) {
    if (!persistence.enabled) return;
    if (persistTimers.has(session.sessionId)) return;
    const timer = setTimeout(() => {
      persistTimers.delete(session.sessionId);
      persistSession(session);
    }, PERSIST_DEBOUNCE_MS);
    if (timer.unref) timer.unref();
    persistTimers.set(session.sessionId, timer);
  }

  function flushPersist(session) {
    if (!persistence.enabled) return;
    const timer = persistTimers.get(session.sessionId);
    if (timer) { clearTimeout(timer); persistTimers.delete(session.sessionId); }
    persistSession(session);
  }

  function removePersistedRecord(sessionId, file) {
    const timer = persistTimers.get(sessionId);
    if (timer) { clearTimeout(timer); persistTimers.delete(sessionId); }
    if (diskIndex) diskIndex.delete(sessionId);
    try { fs.rmSync(file || sessionFile(sessionId), { force: true }); } catch { /* already gone */ }
  }

  function restoreSessionFromDisk(sessionId) {
    const index = syncDiskIndex();
    const entry = index && index.get(sessionId);
    if (!entry) return null;
    const record = readPersistedRecord(entry.file, config.agentId);
    if (!record || record.sessionId !== sessionId) {
      index.delete(sessionId);
      return null;
    }
    const session = {
      sessionId: record.sessionId,
      projectSlug: record.projectSlug,
      projectPath: record.projectPath,
      state: restoredState(record.state),
      model: record.model || null,
      selectedModel: record.selectedModel || null,
      aiProfileId: record.aiProfileId || null,
      permissionMode: record.permissionMode || 'default',
      effort: record.effort || null,
      title: record.title || null,
      turns: Number(record.turns) || 0,
      startedAt: record.startedAt || new Date().toISOString(),
      endedAt: ACTIVE_STATES.has(record.state) ? null : (record.endedAt || null),
      pendingPermission: null,
      outputBuffer: Array.isArray(record.events) ? record.events.slice(-MAX_PERSISTED_EVENTS) : [],
      listeners: new Set(),
      child: null,
      threadId: record.threadId || null,
      lastResult: record.lastResult || '',
      usage: {
        inputTokens: Number(record.usage && record.usage.inputTokens) || 0,
        outputTokens: Number(record.usage && record.usage.outputTokens) || 0,
        cachedTokens: Number(record.usage && record.usage.cachedTokens) || 0,
      },
      peakTurnTokens: Number(record.peakTurnTokens) || 0,
      restored: true,
    };
    sessions.set(sessionId, session);
    return session;
  }

  function resolveSession(id) {
    return sessions.get(id) || restoreSessionFromDisk(id);
  }

  function reserveSessionId({ slug, projectPath }) {
    let index = ensureDiskIndex();
    for (let attempt = 0; attempt < 200; attempt += 1) {
      let id = `${config.agentId}-${nextId++}`;
      while (sessions.has(id) || (index && index.has(id))) id = `${config.agentId}-${nextId++}`;
      if (!persistence.enabled) return id;
      // Claim the record file exclusively the moment the id is chosen: a
      // sibling runner instance sharing this directory (whose cached index
      // predates our write — e.g. a sidebar poll at startup) cannot take the
      // same id, so its flush can never overwrite our session's record.
      // Keeping the plain `${agentId}-${n}` shape also preserves external
      // assertions on the id format.
      const file = sessionFile(id);
      const record = reservedRecord(config.agentId, id, slug, projectPath);
      try {
        fs.mkdirSync(persistence.dir, { recursive: true });
      } catch {
        notePersistFailure(); // unusable directory: session stays memory-only
        return id;
      }
      try {
        fs.writeFileSync(file, `${JSON.stringify(record)}\n`, { flag: 'wx' });
        if (diskIndex) diskIndex.set(id, { file, summary: persistedSummary(record) });
        return id;
      } catch (error) {
        if (error && error.code === 'EEXIST') {
          index = syncDiskIndex() || index; // another instance won the race
          continue;
        }
        notePersistFailure();
        return id;
      }
    }
    return `${config.agentId}-${nextId++}`;
  }

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
    schedulePersist(session);
  }

  function setState(session, state) {
    session.state = state;
    emit(session, { type: 'claude/state', state, turn: session.turns });
  }

  const runner = {
    agentId: config.agentId,

    startChatSession({ slug, projectPath, aiProfile, permissionMode, effort, title }) {
      if (!slug) throw new Error('slug required');
      if (!projectPath) throw new Error('projectPath required');
      const sessionId = reserveSessionId({ slug, projectPath });
      const session = {
        sessionId,
        projectSlug: slug,
        projectPath,
        state: 'idle',
        model: config.modelFor ? config.modelFor(aiProfile) : null,
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
        child: null,
        threadId: null,
        lastResult: '',
        usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
      };
      sessions.set(sessionId, session);
      emit(session, {
        type: 'claude/session-ready',
        model: session.model,
        aiProfileId: session.aiProfileId,
        permissionMode: session.permissionMode,
        message: `${config.agentId} session is ready. Send a message to start the first turn.`,
      });
      // Write the record immediately so a session with no turns yet still
      // shows up in the sidebar after a restart.
      flushPersist(session);
      return { sessionId };
    },

    listSessions(filter = {}) {
      const byId = new Map();
      const index = syncDiskIndex();
      if (index) {
        // Lightweight summaries (no events) for sessions a previous process
        // persisted, newest first; live sessions below override by id.
        const restored = [...index.values()]
          .map(entry => entry.summary)
          .filter(item => !filter.projectSlug || item.projectSlug === filter.projectSlug)
          .sort((a, b) => String(b.startedAt || '').localeCompare(String(a.startedAt || '')));
        for (const item of restored) byId.set(item.sessionId, item);
      }
      for (const session of sessions.values()) {
        if (filter.projectSlug && session.projectSlug !== filter.projectSlug) continue;
        byId.set(session.sessionId, summary(session));
      }
      return [...byId.values()];
    },

    getState(id) {
      const session = resolveSession(id);
      if (!session) return null;
      return {
        ...summary(session),
        listenerCount: session.listeners.size,
        bufferedEvents: session.outputBuffer.length,
      };
    },

    getSession(id) { return resolveSession(id); },

    getSessionTokenUsage(id) {
      const session = resolveSession(id);
      if (!session) return { used: 0, hasUsage: false };
      const { inputTokens, outputTokens } = session.usage;
      // Context occupancy ≈ the largest single turn, not the running sum:
      // resumed turns re-send the whole history each time (same semantics as
      // the claude-cli-runner's max-not-sum strategy). peakTurnTokens is
      // persisted, so restored sessions keep their occupancy metric.
      const used = session.peakTurnTokens || 0;
      return {
        used,
        inputTokens,
        outputTokens,
        hasUsage: Boolean(used || inputTokens || outputTokens),
      };
    },

    subscribe(id, listener) {
      const session = resolveSession(id);
      if (!session) throw new Error('session not found');
      for (const event of session.outputBuffer) listener(event);
      session.listeners.add(listener);
      return () => session.listeners.delete(listener);
    },

    async sendInput(id, text, profile, options = {}) {
      const session = resolveSession(id);
      if (!session) throw Object.assign(new Error('session not found'), { status: 404 });
      if (ACTIVE_STATES.has(session.state) || session.child) {
        throw Object.assign(new Error('session already has an active turn'), { status: 409 });
      }
      const value = String(text || '').trim();
      const attachments = normalizeAttachments(options.attachments || []);
      if (!value && !attachments.length) throw Object.assign(new Error('text or attachments are required'), { status: 400 });
      if (config.modelFor && profile) {
        session.model = config.modelFor(profile);
        session.selectedModel = profile.mainModel || profile.models && profile.models.default || '';
      }
      if (options.permissionMode) session.permissionMode = options.permissionMode;
      if (options.effort) session.effort = options.effort;
      emit(session, {
        type: 'claude/user-prompt',
        text: value,
        attachments: (options.displayAttachments || []).map(({ id, name, mediaType, size, width, height, url }) => ({ id, name, mediaType, size, width, height, url })),
      });
      // runTurn marks running synchronously; HTTP callers get 202 while the
      // subprocess runs and observe completion through the event stream.
      // Restored sessions carry their threadId, so the spawn below resumes
      // the persisted agent conversation (codex resume / opencode --session).
      session.turnPromise = runTurn(session, appendTextAttachments(value, attachments), profile, attachments).catch(error => {
        emit(session, { type: 'claude/error', message: `${config.agentId} turn cleanup failed: ${error.message}` });
        setState(session, 'idle');
        flushPersist(session);
      });
      return { started: true };
    },

    resolvePermission() {
      throw Object.assign(new Error(`${config.agentId} driver does not support interactive permissions`), { status: 501 });
    },

    // Rebind the session to another profile/model (or agent-owned auth with
    // a null profile). Each turn spawns fresh with `-m` + the thread id, so
    // only the per-turn model source needs updating; history continues.
    updateSelection(id, profile, selectedModel) {
      const session = resolveSession(id);
      if (!session) throw Object.assign(new Error('session not found'), { status: 404 });
      if (ACTIVE_STATES.has(session.state) || session.child) {
        throw Object.assign(new Error('session already has an active turn'), { status: 409 });
      }
      const fromAiProfileId = session.aiProfileId || null;
      const fromModel = session.selectedModel || session.model || null;
      session.aiProfileId = profile && profile.id || null;
      session.selectedModel = selectedModel || (profile && (profile.mainModel || profile.models && profile.models.default)) || null;
      session.model = config.modelFor ? config.modelFor(profile) : null;
      emit(session, {
        type: 'claude/selection-changed',
        fromAiProfileId,
        toAiProfileId: session.aiProfileId,
        fromModel,
        toModel: session.selectedModel,
      });
      flushPersist(session);
      return summary(session);
    },

    abort(id) {
      const session = resolveSession(id);
      if (!session) return;
      // A user-initiated kill is not a failure: the nonzero exit code it
      // produces must not surface as an error event.
      session.abortedByUser = true;
      killChild(session);
      if (!['idle', 'ended'].includes(session.state)) {
        session.state = 'aborted';
        emit(session, { type: 'claude/aborted' });
        setState(session, 'idle');
      }
      flushPersist(session);
    },

    deleteSession(id) {
      const session = sessions.get(id);
      if (session) {
        killChild(session);
        sessions.delete(id);
        removePersistedRecord(id);
        return true;
      }
      // The session may exist only on disk (created by a previous process).
      const index = syncDiskIndex();
      const entry = index && index.get(id);
      if (entry) {
        removePersistedRecord(id, entry.file);
        return true;
      }
      return false;
    },

    async listSupportedCommands() { return []; },

    findClaudeExecutableForSdk() { return null; },
  };

  function killChild(session) {
    if (!session.child) return;
    try {
      if (process.platform === 'win32') {
        // npm shims spawn a node child; killing the shell alone orphans it.
        spawn('taskkill', ['/pid', String(session.child.pid), '/T', '/F'], { windowsHide: true });
      } else {
        session.child.kill('SIGTERM');
      }
    } catch { /* already gone */ }
    // Direct kill too: taskkill covers the npm-shim tree, this also reaches
    // injected test doubles and already-orphaned shells.
    try { session.child.kill(); } catch { /* already gone */ }
    // Retain the handle until close so a new turn cannot race the dying child.
  }

  async function runTurn(session, text, profile, attachments) {
    setState(session, 'running');
    session.lastResult = '';
    session.turnUsage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
    let prepared;
    try {
      prepared = prepareImages(session.projectPath, attachments);
      return await new Promise(resolve => {
      const model = session.model;
      const sandbox = config.sandboxFor ? config.sandboxFor(session.permissionMode) : undefined;
      let args = config.spawnArgs({
        projectPath: session.projectPath,
        model,
        sandbox,
        threadId: session.threadId,
        prompt: text,
        profile,
        permissionMode: session.permissionMode,
        effort: session.effort,
        imagePaths: prepared.imagePaths,
      });
      const spawnOptions = {
        cwd: session.projectPath,
        windowsHide: true,
        env: { ...process.env, ...(config.envFor ? config.envFor(profile, session) : {}) },
      };
      let child;
      try {
        // Launch executables/npm entry points directly. shell:true corrupts
        // TOML quotes and lets prompt/file metacharacters become cmd syntax.
        const invocation = config.spawn ? { command: config.command, args } : resolveCliInvocation(config.command, args);
        child = (config.spawn || spawn)(invocation.command, invocation.args, spawnOptions);
      } catch (error) {
        emit(session, { type: 'claude/error', message: `failed to start ${config.agentId}: ${error.message}` });
        prepared.cleanup();
        setState(session, 'idle');
        resolve();
        return;
      }
      session.child = child;
      let buffer = '';
      let settled = false;
      let sawResult = false;
      let emittedResult = false;
      let emittedError = false;
      // Until the CLI's first JSON event lands the UI would show dead air
      // (reasoning models think for tens of seconds first) — announce it.
      setState(session, 'thinking');
      const helpers = {
        setResult(value) { session.lastResult = String(value || ''); sawResult = true; },
        setThreadId(threadId) { if (threadId && !session.threadId) session.threadId = String(threadId); },
        setModel(model2) { if (model2) session.model = String(model2); },
        addUsage(usage) {
          if (!usage) return;
          const input = Number(usage.inputTokens || usage.input_tokens || 0) || 0;
          const output = Number(usage.outputTokens || usage.output_tokens || 0) || 0;
          const cached = Number(usage.cachedTokens || usage.cached_input_tokens || 0) || 0;
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
        },
        setState,
      };
      // The same upstream failure often arrives twice (stderr chunk + error
      // item + nonzero exit); collapse consecutive identical diagnostics so
      // the UI never stacks duplicate warnings.
      let lastDiag = '';
      const emitDiag = event => {
        const text = event.text != null ? event.text : event.message;
        if (text === lastDiag) return;
        lastDiag = String(text == null ? '' : text);
        emit(session, event);
      };
      const parse = line => {
        if (!line.trim()) return;
        let parsed;
        try { parsed = JSON.parse(line); } catch {
          emitDiag({ type: 'claude/stderr', text: line.slice(0, 2000) });
          return;
        }
        try {
          if (session.state === 'thinking') setState(session, 'running');
          const events = config.parseLine(parsed, session, helpers);
          for (const event of events) {
            if (event.type === 'claude/result') emittedResult = true;
            if (event.type === 'claude/error') emittedError = true;
            if (event.type === 'claude/error' || event.type === 'claude/stderr') emitDiag(event);
            else emit(session, event);
          }
        } catch (error) {
          emitDiag({ type: 'claude/stderr', text: `parser: ${error.message}`.slice(0, 2000) });
        }
      };
      const finish = () => {
        if (settled) return;
        settled = true;
        session.child = null;
        session.turns += 1;
        prepared.cleanup();
        if (!session.endedAt) session.state = 'idle';
        // Drivers that stream step-level records (opencode) never know which
        // step is last; the turn result is synthesized once at process close
        // unless the driver already emitted one or failed.
        if (!emittedResult && !emittedError && sawResult) {
          emit(session, { type: 'claude/result', result: session.lastResult, model: session.model, isError: false });
        }
        emit(session, { type: 'claude/state', state: 'idle', turn: session.turns });
        // The turn is complete: write the record now so a process exit after
        // this point can never lose the finished conversation.
        flushPersist(session);
        resolve();
      };
      child.stdout.on('data', chunk => {
        buffer += chunk.toString('utf8');
        let index;
        while ((index = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, index).trim();
          buffer = buffer.slice(index + 1);
          parse(line);
        }
      });
      child.stderr.on('data', chunk => {
        const text = chunk.toString('utf8');
        if (text.trim()) emitDiag({ type: 'claude/stderr', text: text.slice(0, 2000) });
      });
      child.on('error', error => {
        emit(session, { type: 'claude/error', message: `${config.agentId} process error: ${error.message}` });
        finish();
      });
      child.on('close', code => {
        if (buffer.trim()) parse(buffer);
        if (code !== 0 && !sawResult && !session.abortedByUser && !emittedError) {
          emitDiag({
            type: 'claude/error',
            message: `${config.agentId} exited with code ${code}`.slice(0, 500),
          });
        }
        session.abortedByUser = false;
        finish();
      });
      try {
        if (config.promptViaStdin) {
          child.stdin.write(text);
        }
        child.stdin.end();
      } catch { /* stdin closed early; close handler will settle the turn */ }
      });
    } catch (error) {
      emit(session, { type: 'claude/error', message: `failed to prepare ${config.agentId} turn: ${error.message}` });
      setState(session, 'idle');
      flushPersist(session);
    } finally {
      if (prepared) prepared.cleanup();
    }
  }

  return runner;
}

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

function resolveCliInvocation(command, args) {
  if (process.platform !== 'win32') return { command, args };
  const searchDirs = path.isAbsolute(command) ? [''] : (process.env.PATH || '').split(path.delimiter);
  const extensions = path.extname(command) ? [''] : ['.exe', '.com', '.cmd', '.bat'];
  for (const dir of searchDirs) {
    for (const extension of extensions) {
      const file = path.resolve(dir, `${command}${extension}`);
      if (!fs.existsSync(file)) continue;
      if (!/\.(cmd|bat)$/i.test(file)) return { command: file, args };
      const script = fs.readFileSync(file, 'utf8');
      for (const match of script.matchAll(/"%dp0%[\\/]([^"\r\n]+\.(?:exe|[cm]?js))"/gi)) {
        const entry = path.resolve(path.dirname(file), match[1]);
        if (fs.existsSync(entry)) return /\.exe$/i.test(entry)
          ? { command: entry, args }
          : { command: process.execPath, args: [entry, ...args] };
      }
      throw new Error(`cannot safely launch ${path.basename(file)}; configure its executable or Node entry point`);
    }
  }
  return { command, args }; // spawn reports the normal ENOENT diagnostic.
}

module.exports = { createCliJsonRunner, resolveCliInvocation };
