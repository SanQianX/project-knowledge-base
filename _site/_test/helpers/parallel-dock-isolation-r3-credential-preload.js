// _site/_test/helpers/parallel-dock-isolation-r3-credential-preload.js
//
// Loaded INSIDE the isolated terminal-module process through
// `node --require <this file> <module entry>`.
//
// The real subscription credential is handed over through an extra pipe
// (file descriptor 3) that the launcher writes once and closes. The secret
// therefore never appears in argv, in the environment, in a file, in a URL or
// in the browser - it exists in the server process memory only.
//
// The overlay serves the READ paths of the module's own ProfileStore
// (runtimeProfile / publicProfile / _configured). Every write-capable method
// runs with the overlay switched off, so the secret can never be persisted
// into the isolated credentials.v1.json.

'use strict';

const fs = require('fs');
const path = require('path');

const HANDOFF_FD = 3;

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Reads the whole payload of the handoff pipe. The pipe is non-blocking on
// some platforms, so EAGAIN is retried until the writer closes it.
function readHandoff(fd) {
  const buffer = Buffer.alloc(8192);
  let text = '';
  for (;;) {
    let read = 0;
    try {
      read = fs.readSync(fd, buffer, 0, buffer.length, null);
    } catch (error) {
      if (error && (error.code === 'EAGAIN' || error.code === 'EWOULDBLOCK')) { sleep(5); continue; }
      if (error && error.code === 'EOF') break;
      return null;
    }
    if (!read) break;
    text += buffer.slice(0, read).toString('utf8');
  }
  const trimmed = text.trim();
  if (!trimmed) return null;
  try { return JSON.parse(trimmed); } catch { return null; }
}

function resolveProfileStore() {
  const root = String(process.env.PK_R3_MODULE_ROOT || '').trim();
  const candidates = root
    ? [path.join(root, 'packages', 'server', 'lib', 'profile-store.js')]
    : [];
  candidates.push(path.resolve(__dirname, '..', '..', '..', 'node_modules', 'claude-ai-workbench', 'packages', 'server', 'lib', 'profile-store.js'));
  for (const candidate of candidates) {
    try { if (fs.existsSync(candidate)) return candidate; } catch {}
  }
  throw new Error(`profile-store.js not found (candidates: ${candidates.join(', ')})`);
}

function installOverlay(payload) {
  if (!payload || !payload.secret || !payload.credentialRef) return false;
  const profileStorePath = resolveProfileStore();
  const { ProfileStore } = require(profileStorePath);

  let overlayEnabled = true;
  const originalCredentials = ProfileStore.prototype._credentials;
  ProfileStore.prototype._credentials = function patchedCredentials() {
    const file = originalCredentials.call(this);
    if (!overlayEnabled) return file;
    const credentials = Object.assign({}, file.credentials || {});
    if (!credentials[payload.credentialRef]) credentials[payload.credentialRef] = payload.secret;
    return Object.assign({}, file, { credentials });
  };

  // Methods that persist the credential file must never see the overlay,
  // otherwise the in-memory secret would be written to disk.
  for (const name of ['setCredential', 'delete', 'setEmbeddingConfig', 'importLegacy', 'importEmbedding']) {
    const original = ProfileStore.prototype[name];
    if (typeof original !== 'function') continue;
    ProfileStore.prototype[name] = function patchedWriter(...args) {
      const previous = overlayEnabled;
      overlayEnabled = false;
      try { return original.apply(this, args); } finally { overlayEnabled = previous; }
    };
  }

  // The masked credential would otherwise leak six leading and six trailing
  // characters of the secret into the UI and the public API.
  const originalPublicProfile = ProfileStore.prototype.publicProfile;
  ProfileStore.prototype.publicProfile = function patchedPublicProfile(profile) {
    const result = originalPublicProfile.call(this, profile);
    if (profile && profile.credentialRef === payload.credentialRef) result.credentialMasked = '********';
    return result;
  };

  process.env.PK_R3_CREDENTIAL_IN_MEMORY = '1';
  return true;
}

let installed = false;
try {
  const payload = readHandoff(HANDOFF_FD);
  installed = installOverlay(payload);
} catch (error) {
  // A preload failure must never abort the server silently: the server is
  // started without the overlay and the profile then simply has no
  // credential, which the probe reports as a hard failure.
  process.stderr.write(`[r3-preload] credential overlay not installed: ${error && error.message}\n`);
  installed = false;
}

module.exports = { installed };
