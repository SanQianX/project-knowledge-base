(function (global, factory) {
  const exported = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
  global.createClaudeWorkbenchClient = exported.createClaudeWorkbenchClient;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  const EVENT_TYPES = [
    'workbench/stream-open', 'workbench/stream-reconnecting', 'claude/init', 'claude/state',
    'claude/session-ready', 'claude/user-prompt', 'claude/system-prompt', 'claude/text-start',
    'claude/text-delta', 'claude/result', 'claude/thinking-start', 'claude/thinking-delta',
    'claude/tool-use', 'claude/tool-result', 'claude/permission-request', 'claude/permission-resolved',
    'claude/usage', 'claude/commands', 'claude/image', 'claude/retry', 'claude/error', 'claude/stderr', 'claude/aborted',
    'claude/selection-changed',
  ];

  function createClaudeWorkbenchClient(options = {}) {
    const apiBase = String(options.apiBase || '/api/claude-workbench/v1').replace(/\/$/, '');
    const fetchImpl = options.fetch || globalThis.fetch;
    const EventSourceImpl = options.EventSource || globalThis.EventSource;
    if (typeof fetchImpl !== 'function') throw new Error('fetch is required');
    const streams = new Set();
    const controllers = new Set();
    let destroyed = false;
    let reconnects = 0;

    async function request(path, init = {}) {
      if (destroyed) throw new Error('ClaudeWorkbenchClient is destroyed');
      const controller = new AbortController();
      const external = init.signal;
      const abort = () => controller.abort();
      if (external) {
        if (external.aborted) controller.abort();
        else external.addEventListener('abort', abort, { once: true });
      }
      controllers.add(controller);
      try {
        const response = await fetchImpl(`${apiBase}${path}`, {
          ...init,
          headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
          signal: controller.signal,
        });
        const text = await response.text();
        const data = text ? JSON.parse(text) : null;
        if (!response.ok) {
          const error = new Error(data && data.error || `HTTP ${response.status}`);
          error.status = response.status; error.body = data; throw error;
        }
        return data;
      } finally {
        controllers.delete(controller);
        if (external) external.removeEventListener('abort', abort);
      }
    }

    function subscribe(sessionId, handlers, onError, subscribeOptions = {}) {
      if (destroyed) throw new Error('ClaudeWorkbenchClient is destroyed');
      if (typeof EventSourceImpl !== 'function') throw new Error('EventSource is required');
      const callback = typeof handlers === 'function' ? handlers : handlers && handlers.onEvent;
      const errorCallback = typeof onError === 'function' ? onError : handlers && handlers.onError;
      const openCallback = handlers && typeof handlers === 'object' && handlers.onOpen;
      const after = Number(subscribeOptions.afterSequence || handlers && handlers.afterSequence || 0);
      const suffix = after > 0 ? `?after=${encodeURIComponent(after)}` : '';
      const stream = new EventSourceImpl(`${apiBase}/sessions/${encodeURIComponent(sessionId)}/events${suffix}`);
      streams.add(stream);
      let closed = false;
      const deliver = message => {
        try { callback && callback(JSON.parse(message.data)); }
        catch (error) { errorCallback && errorCallback(error); }
      };
      EVENT_TYPES.forEach(type => stream.addEventListener && stream.addEventListener(type, deliver));
      stream.onmessage = deliver;
      stream.onopen = () => { openCallback && openCallback(); };
      stream.onerror = () => {
        reconnects += 1;
        errorCallback && errorCallback(new Error('SSE connection interrupted; EventSource will reconnect'));
      };
      const close = () => {
        if (closed) return; closed = true; streams.delete(stream); stream.close();
      };
      return close;
    }

    const client = {
      health: () => request('/health'),
      runtime: () => request('/runtime'),
      async listAgents() { const result = await request('/agents'); return result.agents || result || []; },
      async listProjects() { const result = await request('/projects'); return result.projects || result || []; },
      createProject(project) {
        return request('/projects', { method: 'POST', body: JSON.stringify(project) });
      },
      getProject(id) { return request(`/projects/${encodeURIComponent(id)}`); },
      renameProject(id, name) {
        return request(`/projects/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ name }) });
      },
      updateProject(id, patch) {
        return request(`/projects/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) });
      },
      removeProject(id, opts = {}) {
        const qs = opts.keepSessions ? '?keepSessions=1' : '';
        return request(`/projects/${encodeURIComponent(id)}${qs}`, { method: 'DELETE' });
      },
      async listProfiles() { const result = await request('/profiles'); return result.profiles || result || []; },
      saveProfile(profile) {
        const id = encodeURIComponent(profile.id);
        return request(`/profiles/${id}`, { method: 'PUT', body: JSON.stringify(profile) });
      },
      deleteProfile(id) { return request(`/profiles/${encodeURIComponent(id)}`, { method: 'DELETE' }); },
      setCredential(id, credential) {
        const payload = typeof credential === 'string' ? { secret: credential } : credential;
        return request(`/profiles/${encodeURIComponent(id)}/credential`, { method: 'PUT', body: JSON.stringify(payload) });
      },
      testProfile(id) { return request(`/profiles/${encodeURIComponent(id)}/test`, { method: 'POST', body: '{}' }); },
      testProfileDraft(profile, credential = '') {
        return request('/profiles/test', { method: 'POST', body: JSON.stringify({ profile, credential }) });
      },
      detectProfileModels(profile, credential = '') {
        return request('/profiles/detect-models', { method: 'POST', body: JSON.stringify({ profile, credential }) });
      },
      async listSessions(context, opts = {}) {
        const contextId = context && (context.contextId || context.projectId) || context;
        const archived = opts.archived === true ? '&archived=1' : '';
        const result = await request(`/sessions?contextId=${encodeURIComponent(contextId)}${archived}`, opts);
        return result.sessions || result || [];
      },
      startSession(context, opts = {}) {
        const payloadContext = { ...context, contextId: context.contextId || context.projectId };
        const result = request('/sessions', {
          method: 'POST',
          body: JSON.stringify({
            context: payloadContext,
            aiProfileId: opts.aiProfileId !== undefined ? opts.aiProfileId : context.aiProfileId,
            model: opts.model !== undefined ? opts.model : context.model,
            permissionMode: opts.permissionMode || 'default',
            agentId: opts.agentId || undefined,
            effort: opts.effort || undefined,
          }),
          signal: opts.signal,
        });
        return result.then(r => r.session || r);
      },
      loadSession(id, opts = {}) { return request(`/sessions/${encodeURIComponent(id)}`, opts); },
      async listCommands(id, opts = {}) {
        const result = await request(`/sessions/${encodeURIComponent(id)}/commands`, opts);
        return result.commands || result || [];
      },
      subscribe,
      send(sessionOrArgs, text, opts = {}) {
        const args = typeof sessionOrArgs === 'object' ? sessionOrArgs : { sessionId: sessionOrArgs, text, options: opts };
        return request(`/sessions/${encodeURIComponent(args.sessionId)}/input`, {
          method: 'POST', body: JSON.stringify({ text: args.text || '', attachments: args.attachments || [], options: args.options || {} }),
        });
      },
      resolvePermission(sessionOrArgs, requestId, allow, message) {
        const args = typeof sessionOrArgs === 'object' ? sessionOrArgs : { sessionId: sessionOrArgs, requestId, allow, message };
        return request(`/sessions/${encodeURIComponent(args.sessionId)}/permissions/${encodeURIComponent(args.requestId)}/resolve`, {
          method: 'POST', body: JSON.stringify({ allow: args.allow === true, message: args.message || '' }),
        });
      },
      abort(sessionOrArgs) {
        const id = typeof sessionOrArgs === 'object' ? sessionOrArgs.sessionId : sessionOrArgs;
        return request(`/sessions/${encodeURIComponent(id)}/abort`, { method: 'POST', body: '{}' });
      },
      setPermissionMode(sessionOrArgs, mode) {
        const args = typeof sessionOrArgs === 'object' ? sessionOrArgs : { sessionId: sessionOrArgs, mode };
        return request(`/sessions/${encodeURIComponent(args.sessionId)}/permission-mode`, {
          method: 'PUT', body: JSON.stringify({ mode: args.mode }),
        });
      },
      updateSessionSelection(sessionOrArgs, selection = {}) {
        const args = typeof sessionOrArgs === 'object' ? sessionOrArgs : { sessionId: sessionOrArgs, ...selection };
        return request(`/sessions/${encodeURIComponent(args.sessionId)}/selection`, {
          method: 'PUT',
          body: JSON.stringify({ aiProfileId: args.aiProfileId !== undefined ? args.aiProfileId : selection.aiProfileId, model: args.model !== undefined ? args.model : selection.model }),
        });
      },
      archiveSession(sessionOrArgs) {
        const id = typeof sessionOrArgs === 'object' ? sessionOrArgs.sessionId : sessionOrArgs;
        return request(`/sessions/${encodeURIComponent(id)}/archive`, { method: 'PUT', body: '{}' });
      },
      restoreSession(sessionOrArgs) {
        const id = typeof sessionOrArgs === 'object' ? sessionOrArgs.sessionId : sessionOrArgs;
        return request(`/sessions/${encodeURIComponent(id)}/archive`, { method: 'DELETE' });
      },
      resourceCounts() { return { streams: streams.size, requests: controllers.size, reconnects }; },
      destroy() {
        destroyed = true;
        for (const stream of streams) try { stream.close(); } catch {}
        streams.clear();
        for (const controller of controllers) controller.abort();
        controllers.clear();
      },
    };
    return client;
  }

  return { createClaudeWorkbenchClient, EVENT_TYPES };
});
