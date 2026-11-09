'use strict';
// P-DESKTOP-ACTUAL-CANDIDATE-R4 diagnostic: make.cjs exited 0 WITHOUT the
// PASS lines, any error, or any forge output. This probe reruns the exact
// forge step (api.make) on the ALREADY-PREPARED stage with the same hardened
// env and electron zip dir, plus exit instrumentation:
//   - an unref'd watchdog prints ALIVE ticks (a drained event loop stops them)
//   - 'beforeExit' flags a DRAINED loop while the make promise is pending —
//     the dropped-async silent-exit-0 signature — and exits 2
//   - 'exit' always logs the final code
//   - resolve -> PROBE_FORGE_RESOLVED (0), reject -> stack (1)
// Run: node desktop/test/release-preflight-5025-forge-probe.cjs

const os = require('node:os');
const path = require('node:path');
const envLib = require('./release-preflight-5025-env.cjs');

const desktopRoot = path.resolve(__dirname, '..');
const stageApp = path.join(desktopRoot, 'out', '.release-preflight-5025-stage', 'app');
const buildEnvRoot = path.join(os.tmpdir(), 'release-preflight-5025-make-env');

process.env.KB_DESKTOP_ELECTRON_ZIP_DIR = 'C:/Users/SanQian/AppData/Local/electron/Cache/1c9317029058a8188e4f8d872d27755996c9f5482d3abe9f488e4614f29621cc';
envLib.hardenProcessEnv(buildEnvRoot);
process.env.DEBUG = '@electron/get:*,electron-packager*';

let settled = false;
const started = Date.now();
const tick = setInterval(() => console.log(`ALIVE +${Math.round((Date.now() - started) / 1000)}s`), 20000);
tick.unref();
process.on('beforeExit', (code) => {
  if (!settled) {
    console.error(`PROBE_DRAINED event loop emptied while api.make was still pending (would-be exit code ${code})`);
    process.exit(2);
  }
});
process.on('exit', (code) => console.log(`PROBE_EXIT code=${code} settled=${settled}`));

console.log('PROBE forge loading');
const { api } = require('@electron-forge/core/dist/api');
console.log('PROBE forge loaded, api.make starting');
api.make({ dir: stageApp, interactive: false, arch: 'x64' })
  .then(() => { settled = true; console.log('PROBE_FORGE_RESOLVED'); process.exit(0); })
  .catch((err) => { settled = true; console.error('PROBE_FORGE_REJECTED', (err && err.stack) || err); process.exit(1); });
