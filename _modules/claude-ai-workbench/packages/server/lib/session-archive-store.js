'use strict';

const path = require('path');
const { readJson, writeJson } = require('./json-file');

const SCHEMA = 'agent-terminal-session-archive/v1';

// Sidecar marking sessions the user archived. Session records themselves stay
// owned by the runner, so archiving never rewrites runner history — it only
// flips visibility in listings and can be undone at any time.
class SessionArchiveStore {
  constructor(options = {}) {
    if (!options.dataDir) throw new Error('SessionArchiveStore dataDir is required');
    this.archiveFile = options.archiveFile || path.join(options.dataDir, 'archived-sessions.v1.json');
  }

  _read() { return readJson(this.archiveFile, { schema: SCHEMA, sessions: {} }); }
  _write(cfg) { writeJson(this.archiveFile, cfg); }

  isArchived(sessionId) { return Boolean(this._read().sessions[sessionId]); }

  archive(sessionId) {
    const cfg = this._read();
    if (!cfg.sessions[sessionId]) {
      cfg.sessions[sessionId] = { archivedAt: new Date().toISOString() };
      this._write(cfg);
    }
    return cfg.sessions[sessionId];
  }

  restore(sessionId) {
    const cfg = this._read();
    if (!cfg.sessions[sessionId]) return false;
    delete cfg.sessions[sessionId];
    this._write(cfg);
    return true;
  }

  forget(sessionId) { this.restore(sessionId); }
}

module.exports = { SessionArchiveStore };
