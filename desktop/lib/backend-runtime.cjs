const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

function requestState(endpoint, timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: endpoint.host,
      port: endpoint.port,
      path: '/api/state',
      method: 'GET',
      timeout: timeoutMs,
    }, res => {
      res.resume();
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 500) resolve(endpoint);
        else reject(new Error(`backend returned HTTP ${res.statusCode}`));
      });
    });
    req.once('error', reject);
    req.once('timeout', () => req.destroy(new Error('backend request timed out')));
    req.end();
  });
}

async function waitForBackend({ readLiveEndpoint, dataDir, timeoutMs = 30000, expectedPid } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    const endpoint = readLiveEndpoint(dataDir);
    if (endpoint && (!expectedPid || endpoint.pid === expectedPid)) {
      try {
        return await requestState(endpoint);
      } catch (error) {
        lastError = error;
      }
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw lastError || new Error('project-knowledge backend did not become ready');
}

function isPortFree(port, host = '127.0.0.1') {
  return new Promise(resolve => {
    const server = net.createServer();
    const finish = free => {
      server.removeAllListeners();
      try { server.close(() => resolve(free)); } catch { resolve(free); }
    };
    server.once('error', () => finish(false));
    server.once('listening', () => finish(true));
    server.listen(port, host);
  });
}

async function findFreePort(start = 5757, range = 20) {
  for (let offset = 0; offset < range; offset++) {
    if (await isPortFree(start + offset)) return start + offset;
  }
  throw new Error(`No free local port in ${start}-${start + range - 1}`);
}

function rotateLog(logPath, maxBytes = 2 * 1024 * 1024) {
  try {
    if (fs.statSync(logPath).size <= maxBytes) return;
    fs.rmSync(`${logPath}.old`, { force: true });
    fs.renameSync(logPath, `${logPath}.old`);
  } catch {}
}

function spawnBackend({ executable, cliPath, dataDir, port, cwd, extraEnv = {} }) {
  const logPath = path.join(dataDir, 'desktop-backend.log');
  rotateLog(logPath);
  const logFd = fs.openSync(logPath, 'a');
  const child = spawn(executable, [cliPath, '--fg', '--no-open', '--port', String(port)], {
    // cliPath can live inside app.asar. Windows can execute that path through
    // Electron's ASAR support, but it cannot use a virtual ASAR directory as
    // the operating-system working directory.
    cwd: cwd || path.dirname(executable),
    env: {
      ...process.env,
      ...extraEnv,
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

function waitForOwnedBackend({ child, ...options }) {
  return new Promise((resolve, reject) => {
    const onError = error => reject(new Error(`failed to start desktop backend: ${error.message}`));
    const onExit = (code, signal) => reject(new Error(
      `desktop backend exited before startup (code=${code == null ? 'none' : code}, signal=${signal || 'none'})`
    ));
    child.once('error', onError);
    child.once('exit', onExit);
    waitForBackend(options).then(resolve, reject).finally(() => {
      child.removeListener('error', onError);
      child.removeListener('exit', onExit);
    });
  });
}

function endpointUrl(endpoint) {
  return `http://${endpoint.host}:${endpoint.port}`;
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

function proxyUrlFromElectronRules(rules) {
  const entries = String(rules || '').split(';').map(item => item.trim()).filter(Boolean);
  for (const entry of entries) {
    if (/^DIRECT$/i.test(entry)) continue;
    const match = /^(PROXY|HTTP|HTTPS|SOCKS|SOCKS5)\s+(.+)$/i.exec(entry);
    if (!match) continue;
    const kind = match[1].toUpperCase();
    const address = match[2].trim();
    if (!address) continue;
    if (kind === 'SOCKS5') return `socks5://${address}`;
    if (kind === 'SOCKS') return `socks://${address}`;
    return `http://${address}`;
  }
  return '';
}

module.exports = {
  requestState,
  waitForBackend,
  isPortFree,
  findFreePort,
  rotateLog,
  spawnBackend,
  waitForOwnedBackend,
  endpointUrl,
  isAllowedNavigation,
  isAllowedExternalUrl,
  proxyUrlFromElectronRules,
};
