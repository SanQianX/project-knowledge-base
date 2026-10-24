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

// Slow-startup readiness primitives (R10). A live backend that has not answered
// yet is STARTING, not failed: every helper below distinguishes "process died"
// (definitive) from "deadline reached while alive" (honest still-starting),
// and never lets a busy-but-alive instance be classified as a failure.

function isRetryableControlError(error) {
  if (!error) return false;
  if (['ETIMEDOUT', 'ECONNRESET', 'EAGAIN'].includes(error.code)) return true;
  // runtime-control's budget timeout and a mid-answer disconnect carry no
  // code; semantic refusals (identity mismatch, invalid instance) must not
  // be retried because they are real control-plane answers.
  if (error.code) return false;
  return /超时|断开连接/.test(String(error.message || ''));
}

// Poll for the spawned child to publish its runtime endpoint. Resolves
// { status: 'endpoint', endpoint } once published (and owned by our child
// when ownedPid is given), { status: 'taken', endpoint } when a different
// live PID owns the endpoint file, { status: 'exited' } when the child died
// before publishing, or { status: 'timeout', elapsedMs } at the deadline.
async function waitForBackendEndpoint({ readEndpoint, ownedPid, isAlive = () => true, timeoutMs = 180000, intervalMs = 250, onProgress = null }) {
  const startedAt = Date.now();
  while (true) {
    const endpoint = readEndpoint();
    if (endpoint) {
      if (!ownedPid || endpoint.pid === ownedPid) return { status: 'endpoint', endpoint };
      return { status: 'taken', endpoint };
    }
    if (!isAlive()) return { status: 'exited' };
    const elapsed = Date.now() - startedAt;
    if (elapsed >= timeoutMs) return { status: 'timeout', elapsedMs: elapsed };
    if (onProgress) onProgress(elapsed);
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
}

// waitForHttpReady with child liveness: a dead child is a definitive failure
// surfaced immediately; reaching the deadline while the child lives throws
// DESKTOP_BACKEND_STILL_STARTING instead of claiming the backend timed out.
// R12: every fetch attempt is BOUNDED — a request that hangs (socket open,
// no answer) must not hide liveness, progress, or the overall budget behind
// an await that may never settle. Each attempt gets its own AbortController
// with a per-request deadline, a liveness ticker that aborts as soon as the
// child dies, and an optional outer cancel signal.
async function waitForHttpReadyGuarded({ host, port, timeoutMs = 120000, intervalMs = 200, requestTimeoutMs = 10000, fetchImpl = fetch, isAlive = () => true, onProgress = null, signal = null }) {
  const startedAt = Date.now();
  let lastError = null;
  let cancelled = false;
  let currentController = null;
  const onCancel = () => { cancelled = true; if (currentController) currentController.abort(); };
  if (signal) {
    if (signal.aborted) throw Object.assign(new Error('等待已被取消。'), { code: 'DESKTOP_WAIT_CANCELLED' });
    signal.addEventListener('abort', onCancel, { once: true });
  }
  try {
    while (true) {
      if (cancelled) throw Object.assign(new Error('等待已被取消。'), { code: 'DESKTOP_WAIT_CANCELLED' });
      const elapsed = Date.now() - startedAt;
      const remaining = timeoutMs - elapsed;
      const attemptBudget = Math.max(50, Math.min(requestTimeoutMs, remaining > 0 ? remaining : 50));
      currentController = new AbortController();
      const attemptTimer = setTimeout(() => currentController.abort(), attemptBudget);
      const livenessTicker = setInterval(() => { if (!isAlive()) currentController.abort(); }, intervalMs);
      try {
        const response = await fetchImpl(`http://${host}:${port}/api/state`, { signal: currentController.signal });
        if (response.status < 500) return { host, port };
        lastError = new Error(`backend returned HTTP ${response.status}`);
      } catch (error) {
        lastError = error;
      } finally {
        clearTimeout(attemptTimer);
        clearInterval(livenessTicker);
        currentController.abort();
        currentController = null;
      }
      if (!isAlive()) {
        throw Object.assign(new Error(`后台进程在就绪前已退出：${lastError ? lastError.message : '进程已消失'}`), { code: 'DESKTOP_BACKEND_EXITED' });
      }
      const totalElapsed = Date.now() - startedAt;
      if (totalElapsed >= timeoutMs) {
        throw Object.assign(new Error(`后台仍在启动（已等待 ${Math.round(totalElapsed / 1000)}s，进程存活）：${lastError ? lastError.message : '尚未响应'}`), { code: 'DESKTOP_BACKEND_STILL_STARTING' });
      }
      if (onProgress) onProgress(totalElapsed, lastError);
      await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
  } finally {
    if (signal) signal.removeEventListener('abort', onCancel);
  }
}

// Ask an already-running instance (live endpoint PID) to answer the control
// channel, retrying through busy windows. Resolves { status: 'answered',
// instance } once the control channel answers, { status: 'gone' } when the
// endpoint PID dies first, or { status: 'busy', elapsedMs, endpoint } when
// the patience budget runs out with the PID still alive. Semantic control
// refusals surface immediately as 'refused' with the error.
async function waitForInstanceControl({ probe, endpoint, isAlive, timeoutMs = 600000, intervalMs = 500, onProgress = null }) {
  const startedAt = Date.now();
  while (true) {
    try {
      const instance = await probe();
      if (instance) return { status: 'answered', instance };
      // null means no control channel yet — the PID may still be booting.
    } catch (error) {
      if (!isRetryableControlError(error)) return { status: 'refused', error };
    }
    if (!isAlive(endpoint.pid)) return { status: 'gone' };
    const elapsed = Date.now() - startedAt;
    if (elapsed >= timeoutMs) return { status: 'busy', elapsedMs: elapsed, endpoint };
    if (onProgress) onProgress(elapsed);
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
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
  isRetryableControlError,
  waitForBackendEndpoint,
  waitForHttpReadyGuarded,
  waitForInstanceControl,
};
