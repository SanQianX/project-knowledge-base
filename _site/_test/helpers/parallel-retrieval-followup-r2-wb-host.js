'use strict';
// Lane-owned child process that hosts the REAL claude-ai-workbench module
// (0.13.6, the copy the installed product ships) for the P-MEMORY-INJECTION-02
// lane. It speaks the module's real HTTP contract and is started by the lane
// probes.
//
// The shape of this child is a READ-ONLY SNAPSHOT of
// _site/_test/helpers/parallel-memory-injection-wb-host.js (P-MEMORY-INJECTION-02
// lane) which is itself a snapshot of _site/_test/helpers/parallel-workbench-host.js
// (Workbench provenance lane). No source file is modified or imported: this
// lane never depends on another lane's unfrozen file. The SHA-256 of every
// source is recorded in the lane report.
//
// Environment (all set by the parent):
//   PK_WB_MODULE_ROOT     the claude-ai-workbench package root to host
//   PK_WB_HOST_PORT       port to listen on (127.0.0.1)
//   PK_WB_HOST_DATA_DIR   isolated workbench data directory
//   PK_WB_HOST_WORKSPACES JSON map of workspaceRef -> absolute directory
//   PK_WB_ENGINE_URL      the knowledge engine URL (a recording proxy)
//   PK_WB_PROFILE_SOURCE  none | real-readonly
//   PK_WB_BRIDGE_URL      optional event-bridge console URL (enables capture)
//   PK_WB_BRIDGE_TOKEN    optional event-bridge runtime token (memory only)
const path = require('node:path');
const fs = require('node:fs');

const moduleRoot = String(process.env.PK_WB_MODULE_ROOT || '').trim();
const port = Number(process.env.PK_WB_HOST_PORT || 0);
const dataDir = String(process.env.PK_WB_HOST_DATA_DIR || '').trim();
const workspaces = JSON.parse(String(process.env.PK_WB_HOST_WORKSPACES || '{}'));
const engineUrl = String(process.env.PK_WB_ENGINE_URL || '').trim();
const profileSource = String(process.env.PK_WB_PROFILE_SOURCE || 'none');
const bridgeUrl = String(process.env.PK_WB_BRIDGE_URL || '').trim();
const bridgeToken = String(process.env.PK_WB_BRIDGE_TOKEN || '').trim();

if (!moduleRoot || !port || !dataDir || !Object.keys(workspaces).length) {
  console.error('parallel-retrieval-followup-r2-wb-host: PK_WB_MODULE_ROOT, PK_WB_HOST_PORT, PK_WB_HOST_DATA_DIR and PK_WB_HOST_WORKSPACES are required');
  process.exit(2);
}

// Same contract as the module's own bin: the runtime resolves its data
// directory from these.
process.env.CLAUDE_AI_WORKBENCH_DATA_DIR = dataDir;
process.env.KB_DATA_DIR = dataDir;
if (engineUrl) process.env.KB_KNOWLEDGE_ENGINE_URL = engineUrl;

const { createWorkbenchServer } = require(path.join(moduleRoot, 'packages', 'server'));

function buildOptions() {
  const options = { dataDir, workspaces };
  if (profileSource === 'real-readonly') {
    const shell = require('./parallel-retrieval-followup-r2-shell');
    options.profiles = shell.createReadOnlyProfileStore(moduleRoot, { dataDir });
  }
  if (bridgeUrl && bridgeToken) {
    // The real Workbench capture: the module records the ORIGINAL user input
    // (not the augmented prompt) and flushes it to the Bridge.
    const { ConversationCapture } = require(path.join(moduleRoot, 'packages', 'server', 'lib', 'conversation-capture.js'));
    options.conversationCapture = new ConversationCapture({
      file: path.join(dataDir, 'capture-outbox.v1.json'),
      bridgeUrl,
      token: bridgeToken,
    });
  }
  return options;
}

const app = createWorkbenchServer(buildOptions());
app.server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`WORKBENCH_HOST_READY http://127.0.0.1:${port} engine=${engineUrl || 'none'} capture=${bridgeUrl ? 'on' : 'off'}\n`);
});

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  setTimeout(() => process.exit(1), 10000).unref();
  try { await app.service.destroy(); } catch { process.exitCode = 1; }
  app.server.closeAllConnections?.();
  app.server.close(() => process.exit(process.exitCode || 0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
