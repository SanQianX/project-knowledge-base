(function (global, factory) {
  const exported = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
  global.ClaudeWorkbenchCore = exported;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  function createState() {
    return {
      context: null, contextGeneration: 0, sessionId: '', sessions: [],
      session: { state: 'idle', model: null, aiProfileId: null, turns: 0, connectionState: 'offline' },
      lines: [], commands: [], permission: null, permissionMode: 'default',
      tokenUsage: { used: 0, total: 200000, hasUsage: false },
      requestPending: false, turnRunning: false, lastSequence: 0, error: null,
    };
  }

  function text(value) {
    if (value == null) return '';
    if (typeof value === 'string') return value;
    try { return JSON.stringify(value, null, 2); } catch { return String(value); }
  }
  function id(prefix) { return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`; }
  function append(state, line) {
    const next = { id: line.id || id(line.kind || 'line'), at: line.at || new Date().toISOString(), ...line };
    state.lines.push(next);
    if (state.lines.length > 3000) state.lines.splice(0, 300);
    return next;
  }
  function find(state, lineId, kind) { return state.lines.find(item => item.id === lineId && (!kind || item.kind === kind)); }

  function reduceEvent(state, event) {
    if (!event || !event.type) return false;
    if (event.contextId && state.context && event.contextId !== state.context.contextId) return false;
    const sequence = Number(event.sequence || 0);
    if (sequence && sequence <= state.lastSequence) return false;
    if (sequence) state.lastSequence = sequence;
    switch (event.type) {
      case 'workbench/context-loading': state.session.connectionState = 'connecting'; state.error = null; break;
      case 'workbench/context-ready': state.session.connectionState = 'connected'; break;
      case 'workbench/stream-open': state.session.connectionState = 'connected'; break;
      case 'workbench/stream-reconnecting': state.session.connectionState = 'reconnecting'; break;
      case 'workbench/context-error':
        state.session.connectionState = 'offline'; state.error = text(event.error || event.message);
        append(state, { kind: 'error', text: state.error }); break;
      case 'claude/init':
        state.session = { ...state.session, model: event.model || state.session.model, aiProfileId: event.aiProfileId || state.session.aiProfileId, connectionState: 'connected' }; break;
      case 'claude/state':
        state.session.state = event.state || state.session.state;
        state.session.turns = Number(event.turn ?? event.turns ?? state.session.turns);
        state.turnRunning = ['running', 'thinking', 'tool-running', 'spawning'].includes(event.state); break;
      case 'claude/session-ready':
        state.session = { ...state.session, state: 'idle', model: event.model || state.session.model, aiProfileId: event.aiProfileId || state.session.aiProfileId, connectionState: 'connected' };
        state.permissionMode = event.permissionMode || state.permissionMode; state.turnRunning = false; break;
      case 'claude/user-prompt': append(state, { id: event.id, kind: 'user', text: text(event.text), attachments: Array.isArray(event.attachments) ? event.attachments : [], at: event.at }); state.turnRunning = true; break;
      case 'claude/system-prompt': append(state, { id: event.id, kind: 'system', text: text(event.text), at: event.at }); break;
      case 'claude/text-start': append(state, { id: event.id || event.messageId, kind: 'assistant', text: '', at: event.at }); break;
      case 'claude/text-delta': {
        const lineId = event.id || event.messageId; const line = find(state, lineId, 'assistant') || append(state, { id: lineId, kind: 'assistant', text: '', at: event.at });
        line.text += text(event.text ?? event.delta); break;
      }
      case 'claude/result': {
        if (!event.isError) {
          const lineId = event.id || event.messageId; const line = find(state, lineId, 'assistant') || append(state, { id: lineId, kind: 'assistant', text: '', at: event.at });
          line.text = text(event.result ?? event.text); state.session.turns += 1;
        }
        state.turnRunning = false; state.session.state = event.isError ? 'error' : 'idle'; break;
      }
      case 'claude/thinking-start': append(state, { id: event.id || event.messageId, kind: 'thinking', text: text(event.text || 'Thinking…'), at: event.at }); break;
      case 'claude/thinking-delta': {
        const lineId = event.id || event.messageId; const line = find(state, lineId, 'thinking') || append(state, { id: lineId, kind: 'thinking', text: '', at: event.at });
        line.text += text(event.text ?? event.delta); break;
      }
      case 'claude/tool-use':
        append(state, { id: event.id || event.toolUseId, kind: 'tool', name: event.name || event.toolName || 'tool', input: event.input || event.toolInput || {}, result: null, status: 'running', at: event.at });
        state.turnRunning = true; state.session.state = 'tool-running'; break;
      case 'claude/tool-result': {
        const lineId = event.toolUseId || event.id; const line = find(state, lineId, 'tool');
        if (line) { line.result = text(event.result ?? event.text ?? event.content); line.status = event.isError ? 'error' : 'done'; }
        else append(state, { kind: 'tool-result', toolUseId: lineId, text: text(event.result ?? event.text ?? event.content), at: event.at });
        break;
      }
      case 'claude/permission-request':
        state.permission = { requestId: event.requestId || event.id, toolName: event.toolName || event.name || 'tool', input: event.input || event.toolInput || {}, message: event.message || '' };
        append(state, { id: state.permission.requestId, kind: 'permission', name: state.permission.toolName, input: state.permission.input, text: state.permission.message, at: event.at });
        state.turnRunning = false; state.session.state = 'pending-permission'; break;
      case 'claude/permission-resolved': state.permission = null; state.turnRunning = Boolean(event.allow); state.session.state = event.allow ? 'running' : 'idle'; break;
      case 'claude/usage': {
        const usage = event.usage || event; const used = Number(event.used ?? usage.input_tokens ?? 0) + Number(usage.output_tokens || 0) + Number(usage.cache_creation_input_tokens || 0) + Number(usage.cache_read_input_tokens || 0);
        state.tokenUsage = { used, total: Number(event.total || state.tokenUsage.total || 200000), hasUsage: true }; break;
      }
      case 'claude/commands': state.commands = Array.isArray(event.commands) ? event.commands : []; break;
      case 'claude/image': append(state, { id: event.id, kind: 'image', name: event.name || 'image', mediaType: event.mediaType, url: event.url, data: event.data, at: event.at }); break;
      case 'claude/retry': append(state, { kind: 'status', text: `Runtime retry ${event.attempt || 1}/${event.maxRetries || 3}`, at: event.at }); break;
      case 'claude/error': case 'claude/stderr':
        state.error = text(event.message || event.error || event.text); if (state.error) append(state, { kind: 'error', text: state.error, at: event.at });
        state.turnRunning = false; state.session.state = 'error'; break;
      case 'claude/aborted': append(state, { kind: 'status', text: event.message || 'Current turn aborted.', at: event.at }); state.turnRunning = false; state.session.state = 'aborted'; break;
      default: return false;
    }
    return true;
  }

  function createController(options = {}) {
    const state = options.state || createState();
    let adapter = options.adapter || null;
    let streamClose = null;
    let requestController = null;
    let destroyed = false;
    const listeners = new Set(options.onChange ? [options.onChange] : []);

    const notify = () => { if (!destroyed) for (const listener of listeners) try { listener(state); } catch {} };
    const emit = event => { const changed = reduceEvent(state, event); if (changed) notify(); };
    const closeStream = () => { if (streamClose) try { streamClose(); } catch {} streamClose = null; };
    const cancelRequest = () => { if (requestController) requestController.abort(); requestController = null; };
    function reset() {
      state.sessionId = ''; state.sessions = []; state.lines = []; state.commands = []; state.permission = null;
      state.tokenUsage = { used: 0, total: 200000, hasUsage: false };
      state.session = { state: 'idle', model: null, aiProfileId: state.context && state.context.aiProfileId || null, turns: 0, connectionState: 'offline' };
      state.requestPending = false; state.turnRunning = false; state.lastSequence = 0; state.error = null;
    }
    function subscribe(sessionId, generation) {
      closeStream();
      streamClose = adapter.subscribe(sessionId, event => {
        if (destroyed || generation !== state.contextGeneration || sessionId !== state.sessionId) return;
        emit(event);
      }, () => {
        if (!destroyed && generation === state.contextGeneration) emit({ type: 'workbench/stream-reconnecting' });
      }, { afterSequence: state.lastSequence });
    }
    async function loadSession(sessionId, generation, signal) {
      const snapshot = await adapter.loadSession(sessionId, { signal });
      if (destroyed || generation !== state.contextGeneration) return;
      state.sessionId = sessionId;
      state.session = { ...state.session, ...(snapshot.session || {}), connectionState: 'connected' };
      state.lines = []; state.lastSequence = 0;
      for (const event of snapshot.events || []) reduceEvent(state, event);
      state.permission = snapshot.permission || null;
      state.permissionMode = snapshot.permissionMode || state.permissionMode;
      state.tokenUsage = snapshot.tokenUsage || state.tokenUsage;
      subscribe(sessionId, generation); notify();
      if (typeof adapter.listCommands === 'function') {
        try {
          const commands = await adapter.listCommands(sessionId, { signal });
          if (!destroyed && generation === state.contextGeneration && sessionId === state.sessionId) {
            state.commands = Array.isArray(commands) ? commands : [];
            notify();
          }
        } catch (error) {
          if (!(error && error.name === 'AbortError') && generation === state.contextGeneration) {
            state.commandError = text(error);
            notify();
          }
        }
      }
    }
    async function setContext(input) {
      if (destroyed) return;
      const next = input ? { ...input, contextId: input.contextId || input.projectId } : null;
      if (state.context && next && state.context.contextId === next.contextId) { state.context = { ...state.context, ...next }; notify(); return; }
      state.contextGeneration += 1;
      const generation = state.contextGeneration;
      closeStream(); cancelRequest(); requestController = new AbortController();
      state.context = next; reset(); emit({ type: 'workbench/context-loading' });
      if (!next || !next.contextId) { emit({ type: 'workbench/context-ready' }); return; }
      if (!adapter) { emit({ type: 'workbench/context-error', error: 'Claude Workbench client is not configured.' }); return; }
      try {
        state.sessions = await adapter.listSessions(next, { signal: requestController.signal });
        if (destroyed || generation !== state.contextGeneration) return;
        let active = state.sessions.find(item => item.active) || state.sessions[0];
        if (!active) { active = await adapter.startSession(next, { signal: requestController.signal, permissionMode: state.permissionMode }); state.sessions.unshift(active); }
        await loadSession(active.sessionId, generation, requestController.signal);
        emit({ type: 'workbench/context-ready' });
      } catch (error) {
        if (error && error.name === 'AbortError') return;
        if (generation === state.contextGeneration) emit({ type: 'workbench/context-error', error });
      }
    }
    async function newSession() {
      if (!adapter || !state.context) throw new Error('No active context');
      const session = await adapter.startSession(state.context, { permissionMode: state.permissionMode });
      state.sessions = [session, ...state.sessions.filter(item => item.sessionId !== session.sessionId)];
      await loadSession(session.sessionId, state.contextGeneration); return session;
    }
    async function restoreSession(sessionId) { await loadSession(sessionId, state.contextGeneration); }
    async function send(value, options) {
      const message = String(value || '').trim();
      const attachments = options && Array.isArray(options.attachments) ? options.attachments : [];
      if (!message && !attachments.length) return;
      if (!state.sessionId) await newSession();
      state.requestPending = true; notify();
      try {
        const sendOptions = { ...(options || {}) }; delete sendOptions.attachments;
        return await adapter.send({ sessionId: state.sessionId, context: state.context, text: message, attachments, options: sendOptions });
      }
      finally { state.requestPending = false; notify(); }
    }
    async function resolvePermission(allow, message) {
      if (!state.permission) return;
      return adapter.resolvePermission({ sessionId: state.sessionId, requestId: state.permission.requestId, allow: allow === true, message: message || '' });
    }
    async function abort() { if (state.sessionId) return adapter.abort({ sessionId: state.sessionId }); }
    async function setPermissionMode(mode) { state.permissionMode = mode || 'default'; notify(); if (state.sessionId) return adapter.setPermissionMode({ sessionId: state.sessionId, mode: state.permissionMode }); }
    function destroy() { destroyed = true; closeStream(); cancelRequest(); listeners.clear(); if (options.destroyAdapter && adapter && adapter.destroy) adapter.destroy(); }
    return {
      state, setContext, newSession, restoreSession, send, resolvePermission, abort, setPermissionMode,
      setAdapter(value) { adapter = value; }, handleEvent: emit,
      subscribeState(listener) { listeners.add(listener); listener(state); return () => listeners.delete(listener); },
      destroy,
    };
  }

  return { createState, reduceEvent, createController };
});
