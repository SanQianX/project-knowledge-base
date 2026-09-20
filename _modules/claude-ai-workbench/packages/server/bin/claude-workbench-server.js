#!/usr/bin/env node
'use strict';

const path = require('path');
const fs = require('fs');
const { createWorkbenchServer } = require('..');

function configuredWorkspaces() {
  if (!process.env.CLAUDE_WORKBENCH_WORKSPACES) return {};
  const parsed = JSON.parse(process.env.CLAUDE_WORKBENCH_WORKSPACES);
  return Object.fromEntries(Object.entries(parsed).map(([key, value]) => [key, path.resolve(String(value))]));
}

const port = Number(process.env.CLAUDE_WORKBENCH_PORT || 5760);
const host = process.env.CLAUDE_WORKBENCH_HOST || '127.0.0.1';
const repositoryHosts = fs.existsSync(path.resolve(__dirname, '..', '..', '..', 'apps', 'ai-profile-settings-host'));
const serveHost = process.env.CLAUDE_WORKBENCH_SERVE_HOST === '1'
  || (process.env.CLAUDE_WORKBENCH_SERVE_HOST !== '0' && repositoryHosts);
const app = createWorkbenchServer({
  dataDir: process.env.CLAUDE_AI_WORKBENCH_DATA_DIR,
  workspaces: configuredWorkspaces(),
  serveHost,
});

app.server.listen(port, host, () => {
  process.stdout.write(`Claude AI Workbench Server ${app.service.version} listening at http://${host}:${port}${app.apiPrefix}\n`);
  if (serveHost) {
    process.stdout.write(`Claude Code terminal: http://${host}:${port}/terminal/\n`);
    process.stdout.write(`Minimal test host: http://${host}:${port}/test-host/\n`);
    process.stdout.write(`AI Profile settings: http://${host}:${port}/profile-settings/\n`);
  }
});

function shutdown() { app.server.close(() => process.exit(0)); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
