'use strict';
// Thin-shell backend helpers. No Electron imports here: every function is
// plain Node so the desktop test suite can exercise it directly.

const fs = require('node:fs');
const path = require('node:path');

function resolveCoreRoot() {
  try {
    return path.dirname(require.resolve('@sanqianx/project-knowledge/package.json'));
  } catch {
    throw Object.assign(new Error('project-knowledge core package is not installed.'), { code: 'DESKTOP_CORE_MISSING' });
  }
}

function coreCliPath(coreRoot) {
  return path.join(coreRoot, 'bin', 'project-knowledge.js');
}

function coreDataDir(coreRoot, override) {
  if (override) return path.resolve(override);
  const { getDataDir } = require(path.join(coreRoot, '_site', 'lib', 'data-dir.js'));
  return getDataDir();
}

function versionState(coreVersion, instanceVersion) {
  if (!instanceVersion) return 'unknown';
  return coreVersion === instanceVersion ? 'match' : 'mismatch';
}

function endpointUrl(endpoint) {
  const host = endpoint.host === '::1' ? '[::1]' : endpoint.host;
  return `http://${host}:${endpoint.port}`;
}

function isAllowedNavigation(url, endpoint) {
  try {
    return new URL(url).origin === new URL(endpointUrl(endpoint)).origin;
  } catch {
    return false;
  }
}

function isAllowedExternalUrl(url) {
  try {
    const protocol = new URL(url).protocol;
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
}

// Any real HTTP answer (2xx-4xx) proves the backend is accepting requests;
// 5xx means it is still booting. Network errors keep polling until timeout.
async function waitForHttpReady({ host, port, timeoutMs = 60000, intervalMs = 200, fetchImpl = fetch }) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetchImpl(`http://${host}:${port}/api/state`);
      if (response.status < 500) return { host, port };
      lastError = new Error(`backend returned HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  throw Object.assign(new Error(`backend did not become ready: ${lastError ? lastError.message : 'timeout'}`), { code: 'DESKTOP_BACKEND_TIMEOUT' });
}

function rotateLog(logPath, maxBytes = 2 * 1024 * 1024) {
  try {
    if (fs.statSync(logPath).size <= maxBytes) return;
    fs.rmSync(`${logPath}.old`, { force: true });
    fs.renameSync(logPath, `${logPath}.old`);
  } catch {}
}

// Spawn the core CLI in foreground mode under Electron's bundled Node. The
// core performs its own port fallback and publishes the real endpoint via
// runtime-endpoint.json, so the desktop never bakes in a port.
function spawnBackend({ executable, cliPath, dataDir, cwd, env = {} }) {
  const { spawn } = require('node:child_process');
  const logPath = path.join(dataDir, 'desktop-backend.log');
  fs.mkdirSync(dataDir, { recursive: true });
  rotateLog(logPath);
  const logFd = fs.openSync(logPath, 'a');
  const child = spawn(executable, [cliPath, '--fg', '--no-open'], {
    cwd: cwd || path.dirname(executable),
    env: {
      ...process.env,
      ...env,
      ELECTRON_RUN_AS_NODE: '1',
      KB_DATA_DIR: dataDir,
      KB_RUNTIME_MODE: 'desktop',
    },
    detached: false,
    windowsHide: true,
    stdio: ['ignore', logFd, logFd],
  });
  fs.closeSync(logFd);
  return { child, logPath };
}

module.exports = {
  resolveCoreRoot,
  coreCliPath,
  coreDataDir,
  versionState,
  endpointUrl,
  isAllowedNavigation,
  isAllowedExternalUrl,
  waitForHttpReady,
  rotateLog,
  spawnBackend,
};
