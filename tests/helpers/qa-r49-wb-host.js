'use strict';
// P-PROFILE-BLANK-REAL-R49 host — modeled on the tracked
// helpers/parallel-workbench-drafts-r5-host.js pattern (frozen for R5), with
// the R49 differences the dispatch requires:
//   * NO ProfileStore seeding at all: every profile and every credential
//     enters through the real HTTP surface of the real module server
//     (normal product flows only);
//   * ephemeral port (listen 0 on 127.0.0.1) — no fixed port is touched;
//   * service-wiring env vars (KB_EVENT_BRIDGE_URL, KB_KNOWLEDGE_ENGINE_URL,
//     KB_TERMINAL_URL, KB_VECTOR_HUB_URL, KB_WORKBENCH_RUNTIME_TOKEN) are
//     scrubbed and asserted absent BEFORE createWorkbenchServer so the module
//     cannot wire itself to any real bridge/engine/vector service even if the
//     ambient environment carried one.
// The module bytes under test are the root's exact-pinned install
// (node_modules/claude-ai-workbench@0.13.9), required read-only.

const path = require('node:path');

const moduleRoot = String(process.env.PK_R49_MODULE_ROOT || '').trim();
const dataDir = String(process.env.PK_R49_DATA_DIR || '').trim();
const workspace = String(process.env.PK_R49_WORKSPACE || '').trim();

if (!moduleRoot || !dataDir || !workspace) {
  console.error('qa-r49-wb-host: PK_R49_MODULE_ROOT, PK_R49_DATA_DIR and PK_R49_WORKSPACE are required');
  process.exit(2);
}

for (const name of ['KB_EVENT_BRIDGE_URL', 'KB_KNOWLEDGE_ENGINE_URL', 'KB_TERMINAL_URL', 'KB_VECTOR_HUB_URL', 'KB_WORKBENCH_RUNTIME_TOKEN', 'KB_ENGINE_URL', 'KB_BRIDGE_HOME']) {
  delete process.env[name];
}
for (const name of ['KB_EVENT_BRIDGE_URL', 'KB_KNOWLEDGE_ENGINE_URL', 'KB_TERMINAL_URL', 'KB_VECTOR_HUB_URL', 'KB_WORKBENCH_RUNTIME_TOKEN', 'KB_ENGINE_URL', 'KB_BRIDGE_HOME']) {
  if (process.env[name] !== undefined) throw new Error(`qa-r49-wb-host: ${name} survived scrub`);
}

// Same contract as the module's own bin: the runtime resolves its data
// directory from these.
process.env.CLAUDE_AI_WORKBENCH_DATA_DIR = dataDir;
process.env.KB_DATA_DIR = dataDir;

const { createWorkbenchServer } = require(path.join(moduleRoot, 'packages', 'server'));

const app = createWorkbenchServer({ dataDir, workspaces: { 'r49-fixture': workspace } });
app.server.listen(0, '127.0.0.1', () => {
  const address = app.server.address();
  process.stdout.write(`R49_WB_HOST_READY http://127.0.0.1:${address.port} module=${moduleRoot} data=${dataDir}\n`);
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
