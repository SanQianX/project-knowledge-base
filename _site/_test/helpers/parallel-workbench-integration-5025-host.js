'use strict';
// P-WB-QA-INTEGRATION-5025 host — the canonical isolated host child for the
// no-model Workbench UI tools, carried forward from the accepted R5 host
// (helpers/parallel-workbench-drafts-r5-host.js, frozen).
//
// This child process hosts the REAL claude-ai-workbench module — the copy the
// installed product ships (read-only, as the tested bytes) — as an independent
// process with a fully isolated data directory, workspace and environment.
//
// Profile source: a purely fictional profile is seeded through the product's
// OWN ProfileStore on the isolated data dir:
//   * provider/baseUrl are invented; the baseUrl host is under the reserved
//     `.invalid` TLD, so even an accidental dial could never reach a provider;
//   * the credential is an explicit fake key that is never sent anywhere;
//   * nothing under the real profile location is read, copied or written.
//
// Real-model tools (the WB-003/004/008 entries) do NOT use this host; they
// host through the frozen tracked host with the real-readonly facade.
const path = require('node:path');

const moduleRoot = String(process.env.PK_WB_MODULE_ROOT || '').trim();
const port = Number(process.env.PK_WB_HOST_PORT || 0);
const dataDir = String(process.env.PK_WB_HOST_DATA_DIR || '').trim();
const workspace = String(process.env.PK_WB_HOST_WORKSPACE || '').trim();

if (!moduleRoot || !port || !dataDir || !workspace) {
  console.error('parallel-workbench-integration-5025-host: PK_WB_MODULE_ROOT, PK_WB_HOST_PORT, PK_WB_HOST_DATA_DIR and PK_WB_HOST_WORKSPACE are required');
  process.exit(2);
}

// Same contract as the module's own bin: the legacy runtime resolves its
// data directory from these.
process.env.CLAUDE_AI_WORKBENCH_DATA_DIR = dataDir;
process.env.KB_DATA_DIR = dataDir;

const { createWorkbenchServer } = require(path.join(moduleRoot, 'packages', 'server'));
const { ProfileStore } = require(path.join(moduleRoot, 'packages', 'server', 'lib', 'profile-store.js'));

const FAKE_PROFILE_ID = 'i5025fake';
const FAKE_KEY = 'i5025-fake-key-never-dial';
const FAKE_PROFILE = {
  id: FAKE_PROFILE_ID,
  name: 'I5025-Fake',
  provider: 'i5025-fake-provider',
  baseUrl: 'https://i5025-fake.invalid/anthropic',
  models: { default: 'i5025-fake-model' },
};

// The fictional profile enters through the product's own store write path on
// the isolated data dir — no store file is pre-seeded by hand.
const store = new ProfileStore({ dataDir });
store.save(FAKE_PROFILE);
store.setCredential(FAKE_PROFILE_ID, FAKE_KEY);

const app = createWorkbenchServer({ dataDir, workspaces: { 'wb-fixture': workspace }, profiles: store });
app.server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`WORKBENCH_HOST_READY http://127.0.0.1:${port} mode=standalone-fake-profile module=${moduleRoot} data=${dataDir} profile=${FAKE_PROFILE_ID}/${FAKE_PROFILE.models.default}\n`);
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
