// Stable discovery record for the one local project-knowledge backend.
//
// Git hooks and the desktop shell must not bake in a port: the CLI can fall
// back from 5757 when that port is occupied.  This small file lives in the
// version-independent data directory and is replaced atomically whenever a
// backend starts.

const fs = require('fs');
const path = require('path');

const SCHEMA = 'project-knowledge/runtime-endpoint/v1';
const FILENAME = 'runtime-endpoint.json';

function endpointPath(dataDir) {
  return path.join(path.resolve(dataDir), FILENAME);
}

function isLoopbackHost(host) {
  const value = String(host || '').trim().toLowerCase();
  return value === '127.0.0.1' || value === 'localhost' || value === '::1';
}

function normalizeEndpoint(value) {
  if (!value || typeof value !== 'object') return null;
  const pid = Number(value.pid);
  const port = Number(value.port);
  const host = String(value.host || '127.0.0.1').trim();
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  // Runtime discovery is intentionally local-only. Never let a modified
  // endpoint file make hooks send repository metadata to a remote host.
  if (!isLoopbackHost(host)) return null;
  return {
    schema: SCHEMA,
    pid,
    host,
    port,
    mode: String(value.mode || 'cli'),
    startedAt: String(value.startedAt || ''),
  };
}

function readEndpoint(dataDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(endpointPath(dataDir), 'utf-8'));
    if (parsed.schema !== SCHEMA) return null;
    return normalizeEndpoint(parsed);
  } catch {
    return null;
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

function readLiveEndpoint(dataDir, { removeStale = true } = {}) {
  const endpoint = readEndpoint(dataDir);
  if (!endpoint) return null;
  if (isProcessAlive(endpoint.pid)) return endpoint;
  if (removeStale) clearEndpoint(dataDir, { pid: endpoint.pid });
  return null;
}

function writeEndpoint(dataDir, value) {
  const endpoint = normalizeEndpoint({
    ...value,
    startedAt: value && value.startedAt || new Date().toISOString(),
  });
  if (!endpoint) throw new Error('invalid runtime endpoint');
  const target = endpointPath(dataDir);
  const temp = `${target}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(temp, JSON.stringify(endpoint, null, 2) + '\n', 'utf-8');
  try {
    fs.renameSync(temp, target);
  } catch (error) {
    // Windows cannot always replace an existing file with renameSync.
    try { fs.rmSync(target, { force: true }); } catch {}
    fs.renameSync(temp, target);
  }
  return endpoint;
}

function claimEndpoint(dataDir, value) {
  const endpoint = normalizeEndpoint({
    ...value,
    startedAt: value && value.startedAt || new Date().toISOString(),
  });
  if (!endpoint) throw new Error('invalid runtime endpoint');
  const target = endpointPath(dataDir);
  fs.mkdirSync(path.dirname(target), { recursive: true });

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(target, JSON.stringify(endpoint, null, 2) + '\n', {
        encoding: 'utf-8',
        flag: 'wx',
      });
      return { claimed: true, endpoint };
    } catch (error) {
      if (!error || error.code !== 'EEXIST') throw error;
      const existing = readEndpoint(dataDir);
      if (existing && isProcessAlive(existing.pid)) {
        return { claimed: false, endpoint: existing };
      }
      // A just-created file can briefly be unreadable while another process
      // writes it. Treat it as busy rather than deleting a concurrent claim.
      try {
        const ageMs = Date.now() - fs.statSync(target).mtimeMs;
        if (!existing && ageMs < 2000) return { claimed: false, endpoint: null };
      } catch {}
      clearEndpoint(dataDir, existing ? { pid: existing.pid } : {});
    }
  }
  return { claimed: false, endpoint: readLiveEndpoint(dataDir) };
}

function clearEndpoint(dataDir, { pid } = {}) {
  const target = endpointPath(dataDir);
  if (pid != null) {
    const current = readEndpoint(dataDir);
    if (current && current.pid !== Number(pid)) return false;
  }
  try {
    fs.rmSync(target, { force: true });
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  SCHEMA,
  FILENAME,
  endpointPath,
  isLoopbackHost,
  normalizeEndpoint,
  readEndpoint,
  readLiveEndpoint,
  writeEndpoint,
  claimEndpoint,
  clearEndpoint,
  isProcessAlive,
};
