'use strict';
// R10/R12 test fixture: a fake but REAL control-plane "backend" for one temp
// data directory. It owns runtime-endpoint.json (its own live PID), serves the
// named-pipe control channel via the product's own runtime-control module and
// a minimal HTTP endpoint. During its "busy window" it blocks its own event
// loop synchronously (Atomics.wait), which stalls every channel at once —
// the exact real-world shape of a live backend whose loop is stuck on
// large-data work. It never touches any real data directory.
//
// R12: the fixture self-verifies its isolation with the audited env lib and
// records PATH BOOLEANS only (never env values) into its ready marker, and
// never binds a protected port (5757/5760/8787/8790).
const path = require('node:path');
const http = require('node:http');
const fs = require('node:fs');
const envLib = require('./release-preflight-5025-env.cjs');

const CORE_LIB = require('node:path').resolve(__dirname, '..', '..', '_site', 'lib');
const runtimeControl = require(path.join(CORE_LIB, 'runtime-control.js'));
const runtimeEndpoint = require(path.join(CORE_LIB, 'runtime-endpoint.js'));

const PROTECTED_PORTS = [5757, 5760, 8787, 8790];
const [dataDir, readyMarker, optionsArg] = process.argv.slice(2);
const options = JSON.parse(optionsArg || '{}');
const busyAfterMs = Number(options.busyAfterMs || 0);
const busyMs = Number(options.busyMs || 0);
const blockChunkMs = Number(options.blockChunkMs || 1500);

// Boolean identity proof of THIS child against the own roots the driver
// passed (PATH BOOLEANS only; no env values are ever recorded).
const envProof = () => {
  try {
    const own = JSON.parse(process.env.KB_SS_OWN_ROOTS || 'null');
    if (!own) return { provided: false };
    const eq = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();
    const leaked = Object.keys(process.env)
      .filter((k) => !envLib.ISOLATED_VARS.includes(k) && envLib.PROVIDER_KEY.test(k));
    return {
      provided: true,
      userProfileOwned: eq(process.env.USERPROFILE, own.userProfile),
      homedirOwned: eq(require('node:os').homedir(), own.userProfile),
      appdataOwned: eq(process.env.APPDATA, own.appdata),
      localappdataOwned: eq(process.env.LOCALAPPDATA, own.localappdata),
      tempOwned: eq(require('node:os').tmpdir(), own.temp),
      dataDirOwned: !!process.env.KB_DATA_DIR && !!process.env.KB_KNOWLEDGE_DATA_DIR,
      noCredentialKeys: leaked.length === 0,
    };
  } catch {
    return { provided: true, error: true };
  }
};

const blockLoop = (totalMs, chunkMs) => {
  const sab = new Int32Array(new SharedArrayBuffer(4));
  let remaining = totalMs;
  while (remaining > 0) {
    const chunk = Math.min(chunkMs, remaining);
    Atomics.wait(sab, 0, 0, chunk);
    remaining -= chunk;
  }
};

let appViewed = false;
const server = http.createServer((req, res) => {
  if (req.url === '/api/state') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, fake: 'r10-busy-backend' }));
    return;
  }
  if (!appViewed) {
    appViewed = true;
    try { fs.writeFileSync(readyMarker + '.appviewed', JSON.stringify({ at: new Date().toISOString(), url: req.url })); } catch {}
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end('<!doctype html><html><body><h1 id="fake-app">R10 FAKE APP</h1></body></html>');
});

const listenOwn = () => new Promise((resolve, reject) => {
  const attempt = () => {
    server.once('error', onError);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', onError);
      const { port } = server.address();
      if (PROTECTED_PORTS.includes(port)) { server.close(() => attempt()); return; }
      resolve(port);
    });
  };
  const onError = (error) => { server.removeListener('error', onError); reject(error); };
  attempt();
});

let control;
const stop = async () => {
  try { runtimeEndpoint.clearEndpoint(dataDir, { pid: process.pid }); } catch {}
  server.close(() => {});
  await control?.close().catch(() => {});
  try { fs.writeFileSync(readyMarker + '.stopped', 'stopped\n'); } catch {}
  setTimeout(() => process.exit(0), 300).unref();
};

(async () => {
  const port = await listenOwn();
  const startedAt = new Date().toISOString();
  runtimeEndpoint.writeEndpoint(dataDir, { pid: process.pid, host: '127.0.0.1', port, mode: 'cli', startedAt });
  // identity() spreads endpoint fields AFTER its own schema field, so pass
  // only scalar fields — never the endpoint record itself (its schema would
  // overwrite the control schema and every status probe would be rejected).
  const identity = runtimeControl.identity(dataDir, { pid: process.pid, host: '127.0.0.1', port, version: options.version || '5.0.24', startedAt });
  control = await runtimeControl.listen(dataDir, identity, stop);
  const proof = envProof();
  fs.writeFileSync(readyMarker, JSON.stringify({ pid: process.pid, port, startedAt, dataDir, busyAfterMs, busyMs, envProof: proof }));
  console.log(JSON.stringify({ ready: true, pid: process.pid, port, busyAfterMs, busyMs, envProof: proof }));
  if (proof.provided && !proof.error) {
    const bad = ['userProfileOwned', 'homedirOwned', 'appdataOwned', 'localappdataOwned', 'tempOwned', 'dataDirOwned', 'noCredentialKeys']
      .filter((k) => proof[k] !== true);
    if (bad.length) {
      console.error('FIXTURE ENV NOT ISOLATED (booleans false): ' + bad.join(','));
      process.exit(21);
    }
  }

  if (busyMs > 0) {
    if (busyAfterMs > 0) await new Promise(resolve => setTimeout(resolve, busyAfterMs));
    fs.writeFileSync(readyMarker + '.busy', JSON.stringify({ at: new Date().toISOString(), busyMs }));
    blockLoop(busyMs, blockChunkMs);
    fs.writeFileSync(readyMarker + '.idle', JSON.stringify({ at: new Date().toISOString() }));
  }
  // Stay alive serving both channels until the parent stops us via the
  // control protocol (exact identity required) or kills the process.
  setInterval(() => {}, 60000);
})().catch(error => { console.error('fake-busy-backend failed:', error.message); process.exit(1); });
