'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = process.env.KB_LAUNCHER_TEST_PACKAGE || path.resolve(__dirname, '../../..');
const { IntegrationManager } = require(path.join(root, '_site/lib/integration-installer'));
IntegrationManager.prototype.statusAll = async function () {
  fs.writeFileSync(process.env.KB_STARTUP_INTEGRATION_MARKER, String(process.pid));
  // Models a synchronous native CLI probe, without running or repairing any
  // real client integration on the developer or CI machine.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 8000);
  return { clients: [{ client: 'codex', developmentCapture: { installed: true } }] };
};
