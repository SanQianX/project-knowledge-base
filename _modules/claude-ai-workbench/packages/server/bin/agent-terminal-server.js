#!/usr/bin/env node
'use strict';
// Standalone Agent Terminal entry point. Fresh data directory (~/.agent-terminal
// by default, AGENT_TERMINAL_DATA_DIR overrides) so the terminal product starts
// independently from any legacy workbench data.
const os = require('os');
const path = require('path');
const fs = require('fs');
const { createWorkbenchServer } = require('..');

const port = Number(process.env.AGENT_TERMINAL_PORT || process.env.CLAUDE_WORKBENCH_PORT || 5760);
const host = process.env.AGENT_TERMINAL_HOST || '127.0.0.1';
const dataDir = process.env.AGENT_TERMINAL_DATA_DIR || path.join(os.homedir(), '.agent-terminal');
fs.mkdirSync(dataDir, { recursive: true });

const app = createWorkbenchServer({ dataDir });
app.server.listen(port, host, () => {
  process.stdout.write(`Agent Terminal listening on http://${host}:${port}/agent-terminal/ (data: ${dataDir})\n`);
});

function shutdown() {
  app.server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
