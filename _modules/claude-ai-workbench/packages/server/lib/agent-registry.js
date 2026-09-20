'use strict';

const { AGENT_IDS, normalizeAgentId } = require('../../contracts');

// Routes every WorkbenchRunner call to the driver that owns the session.
// The claude-code driver is whatever runner the host injected (legacy
// claude-cli-runner in production, fake runners in tests); CLI drivers plug
// in beside it with the same interface.
class AgentRegistry {
  constructor(options = {}) {
    this.drivers = new Map();
    this.sessionAgents = new Map();
    for (const [agentId, driver] of Object.entries(options.drivers || {})) {
      this.register(agentId, driver);
    }
  }

  register(agentId, driver) {
    const id = normalizeAgentId(agentId);
    if (!driver) throw new Error(`driver for ${id} is required`);
    this.drivers.set(id, driver);
    return driver;
  }

  driverFor(agentId) {
    const id = normalizeAgentId(agentId);
    const driver = this.drivers.get(id);
    if (!driver) {
      throw Object.assign(new Error(`agent "${id}" has no registered driver`), { status: 501 });
    }
    return driver;
  }

  agentOf(sessionId) {
    return this.sessionAgents.get(sessionId) || 'claude-code';
  }

  _route(sessionId) {
    try {
      return this.driverFor(this.agentOf(sessionId));
    } catch {
      throw Object.assign(new Error('session not found'), { status: 404 });
    }
  }

  asRunner() {
    const registry = this;
    return {
      startChatSession(args = {}) {
        const agentId = normalizeAgentId(args.agentId);
        const driver = registry.driverFor(agentId);
        const started = driver.startChatSession({ ...args, agentId });
        registry.sessionAgents.set(started.sessionId, agentId);
        return started;
      },
      listSessions(filter = {}) {
        const all = [];
        for (const id of AGENT_IDS) {
          const driver = registry.drivers.get(id);
          if (!driver) continue;
          for (const session of driver.listSessions(filter)) {
            registry.sessionAgents.set(session.sessionId, id);
            all.push({ ...session, agentId: registry.agentOf(session.sessionId) });
          }
        }
        return all;
      },
      getState(id) { return registry._route(id).getState(id); },
      getSession(id) { return registry._route(id).getSession(id); },
      getSessionTokenUsage(id) { return registry._route(id).getSessionTokenUsage(id); },
      subscribe(id, listener) { return registry._route(id).subscribe(id, listener); },
      sendInput(id, text, profile, options) { return registry._route(id).sendInput(id, text, profile, options); },
      updateSelection(id, profile, selectedModel) {
        const driver = registry._route(id);
        if (typeof driver.updateSelection === 'function') return driver.updateSelection(id, profile, selectedModel);
        // Bare runners without the method still get rebound so the service
        // fallback and the proxy stay interchangeable.
        const session = driver.getSession && driver.getSession(id);
        if (!session) throw Object.assign(new Error('session not found'), { status: 404 });
        session.aiProfileId = profile && profile.id || null;
        session.selectedModel = selectedModel || null;
        return session;
      },
      resolvePermission(id, requestId, decision) { return registry._route(id).resolvePermission(id, requestId, decision); },
      abort(id) { return registry._route(id).abort(id); },
      deleteSession(id) { return registry._route(id).deleteSession(id); },
      listSupportedCommands(id, profile) { return registry._route(id).listSupportedCommands(id, profile); },
      findClaudeExecutableForSdk() {
        const driver = registry.drivers.get('claude-code');
        return driver && typeof driver.findClaudeExecutableForSdk === 'function'
          ? driver.findClaudeExecutableForSdk()
          : null;
      },
    };
  }
}

module.exports = { AgentRegistry };
