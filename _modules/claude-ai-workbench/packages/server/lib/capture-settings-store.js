'use strict';

const path = require('path');
const { readJson, writeJson } = require('./json-file');

const SCHEMA = 'capture-settings/v1';

// Terminal capture scope. When terminalConversations is true, new Agent
// Terminal SDK sessions stop flagging themselves as internal-runtime-only and
// their hooks reach the Bridge journal (Development Conversation / 会话浏览).
// Default false: the terminal is the system talking to itself, not the
// developer's CLI conversation record.
class CaptureSettingsStore {
  constructor(options = {}) {
    if (!options.dataDir) throw new Error('CaptureSettingsStore dataDir is required');
    this.settingsFile = options.settingsFile || path.join(options.dataDir, 'capture-settings.v1.json');
  }

  read() {
    const cfg = readJson(this.settingsFile, { schema: SCHEMA, terminalConversations: false });
    return { schema: SCHEMA, terminalConversations: cfg.terminalConversations === true };
  }

  save(input = {}) {
    if (typeof input.terminalConversations !== 'boolean') {
      throw Object.assign(new Error('terminalConversations must be a boolean'), { status: 400 });
    }
    const cfg = { schema: SCHEMA, terminalConversations: input.terminalConversations, updatedAt: new Date().toISOString() };
    writeJson(this.settingsFile, cfg);
    return cfg;
  }
}

module.exports = { CaptureSettingsStore, SCHEMA };
