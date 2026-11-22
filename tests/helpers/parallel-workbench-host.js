'use strict';
// Lane-owned standalone host for the Workbench provenance batch (WB002/WB003).
//
// This child process hosts the REAL claude-ai-workbench module — the copy the
// installed product ships — as an independent process with an isolated data
// directory, workspace, HOME and Claude config. It is started by the lane
// tests and speaks the module's real HTTP contract.
//
// Modes:
//   standalone   no knowledge engine, no profiles beyond the empty isolated
//                store — proves the module needs no knowledge-base business
//                objects to work;
//   integration  KB_KNOWLEDGE_ENGINE_URL points at the controlled integration
//                fixture, so the module consumes an integration context that
//                this lane controls and can observe.
//
// Profile source:
//   none          the isolated ProfileStore (empty) is used;
//   real-readonly the ORIGINAL profile store of the product is wrapped in a
//                read-only facade: profiles and credentials are read from
//                their real location, every write method refuses. The
//                credential stays in this process's memory and is never
//                written anywhere.
//
// Environment (all set by the parent):
//   PK_WB_MODULE_ROOT     the claude-ai-workbench package root to host
//   PK_WB_HOST_PORT       port to listen on (127.0.0.1)
//   PK_WB_HOST_DATA_DIR   isolated workbench data directory
//   PK_WB_HOST_WORKSPACE  isolated workspace directory
//   PK_WB_HOST_MODE       standalone | integration
//   PK_WB_ENGINE_URL      the controlled integration fixture URL (integration)
//   PK_WB_PROFILE_SOURCE  none | real-readonly
const path = require('node:path');

const moduleRoot = String(process.env.PK_WB_MODULE_ROOT || '').trim();
const port = Number(process.env.PK_WB_HOST_PORT || 0);
const dataDir = String(process.env.PK_WB_HOST_DATA_DIR || '').trim();
const workspace = String(process.env.PK_WB_HOST_WORKSPACE || '').trim();
const mode = String(process.env.PK_WB_HOST_MODE || 'standalone');
const engineUrl = String(process.env.PK_WB_ENGINE_URL || '').trim();
const profileSource = String(process.env.PK_WB_PROFILE_SOURCE || 'none');

if (!moduleRoot || !port || !dataDir || !workspace) {
  console.error('parallel-workbench-host: PK_WB_MODULE_ROOT, PK_WB_HOST_PORT, PK_WB_HOST_DATA_DIR and PK_WB_HOST_WORKSPACE are required');
  process.exit(2);
}

// Same contract as the module's own bin: the legacy runtime resolves its
// data directory from these.
process.env.CLAUDE_AI_WORKBENCH_DATA_DIR = dataDir;
process.env.KB_DATA_DIR = dataDir;
if (mode === 'integration' && engineUrl) process.env.KB_KNOWLEDGE_ENGINE_URL = engineUrl;

const { createWorkbenchServer } = require(path.join(moduleRoot, 'packages', 'server'));

function buildOptions() {
  const options = { dataDir, workspaces: { 'wb-fixture': workspace } };
  if (profileSource === 'real-readonly') {
    const fixture = require('./parallel-workbench-fixture');
    options.profiles = fixture.createReadOnlyProfileStore(moduleRoot, { dataDir });
  }
  return options;
}

const app = createWorkbenchServer(buildOptions());
app.server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`WORKBENCH_HOST_READY http://127.0.0.1:${port} mode=${mode} module=${moduleRoot} data=${dataDir}\n`);
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
