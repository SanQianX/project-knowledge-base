'use strict';
// P-DESKTOP-FINAL-THIN-R5 thin-TGZ real GUI smoke with ALL FOUR REAL module
// processes. Fixes the three R4 review findings in the TEST HARNESS only (no
// candidate byte is edited):
//
//   F1 KB_*_URL overrides are now full URL STRINGS (http://127.0.0.1:PORT).
//     R4 spread bare port NUMBERS into KB_*_URL; module-bridge urlPort() then
//     failed new URL() and fell back to the PROTECTED default ports
//     (5760/8787/8790). This run asserts the health body's ACTUAL module URLs
//     equal the reserved own URLs, that all four modules are up, their live
//     health versions, and that the protected-port listener set is unchanged.
//   F2 the DRIVER hardens its OWN process.env (hardenProcessEnv) before any
//     tar/taskkill/tasklist/netstat/powershell child runs, so no ambient
//     credential ever leaks through driver-spawned helpers. The REAL GUI
//     USERPROFILE is captured first and re-injected ONLY into the gui env
//     (the audited Electron-native exception).
//   F3 the GUI still runs with the real USERPROFILE, but production
//     backend-runtime.cjs spawns the Node backend inheriting it. This driver
//     launches Electron with --inspect-brk on an own loopback port and
//     installs a TEST-ONLY spawn hook in the MAIN process via the inspector
//     protocol BEFORE app entry resumes: every child spawned with
//     ELECTRON_RUN_AS_NODE=1 (the backend, and transitively the module
//     children) gets USERPROFILE/APPDATA/LOCALAPPDATA/TEMP rewritten to the
//     owned roots plus a --require env-proof observer (PATH BOOLEANS only, no
//     secrets). The observer propagates the same rewrite to RUN_AS_NODE
//     descendants, so the real os.homedir()/env of the actual Node children
//     is proven, independently, from inside those children. The GUI/native
//     parent keeps the real USERPROFILE — the exception is no longer silent.
//
// With KB_MODULES_AUTOSTART=1 the REAL supervisor in the candidate core
// spawns the four REAL module services (terminal = claude-ai-workbench
// 0.13.7, vector-hub 1.0.8-rc.8, event-bridge 0.7.3, knowledge-engine
// 0.2.7-rc.11 vendored) bound exactly to the four reserved own ports. The
// run asserts per module: health-body URL, up=true, live endpoint version
// where the module exposes one (honestly labeled where it does not),
// listener PID via netstat, the process command line (entry file under the
// candidate extraction) and the entry-file sha256 against the candidate's
// own module-runtime-manifest / vendor-manifest hashes. The quota
// management UI is fetched LIVE through the product reverse proxy
// (/modules/terminal/profile-settings/...) and byte-compared with the WB
// extraction. Quit + relaunch on the SAME short-root data dir proves
// persistence. Teardown kills ONLY trees this driver spawned and proves the
// protected-port listeners and the owned cache are untouched.
//
// No publish, no commit, no install, no quota query, no model calls
// (KB_EMBEDDING_FAKE=1, KB_AUTOMATION_FAKE_CLAUDE=1); synthetic/empty
// profile only (owned homes are empty dirs). The run dir is KEPT.
//
// Run:
//   node desktop/test/release-preflight-5025-thin-smoke-r5.cjs \
//     --desktop-tgz <thin.tgz> --core-tarball <core.tgz> \
//     --wb-tarball <wb.tgz> --bridge-tarball <bridge.tgz> \
//     --owned-cache <BASE/sources/core/node_modules> \
//     --expect-engine-version 0.2.7-rc.11

const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const envLib = require('./release-preflight-5025-env.cjs');
const coreTarballLib = require('./release-preflight-5025-core-tarball.cjs');
const localModules = require('./release-preflight-5025-local-modules.cjs');

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const PROTECTED_PORTS = [5757, 5760, 8787, 8790];
const MODULE_KEYS = ['terminal', 'vectorHub', 'eventBridge', 'engine'];

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'timeout';
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      lastError = error.message;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`timed out waiting for ${label}: ${lastError}`);
}

async function httpGet(url, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    return { status: response.status, body: Buffer.from(await response.arrayBuffer()) };
  } finally {
    clearTimeout(timer);
  }
}

function taskkillTree(pid) {
  const r = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { encoding: 'utf8', windowsHide: true });
  return r.status === 0;
}

function pidAlive(pid) {
  const r = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH'], { encoding: 'utf8', windowsHide: true });
  return (r.stdout || '').includes(String(pid));
}

// port -> [listener pids] for the PROTECTED ports only (we never touch them;
// the snapshots before/after prove our run never fell back onto them).
function protectedPortSnapshot() {
  const r = spawnSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  const map = {};
  for (const line of String(r.stdout || '').split('\n')) {
    if (!line.includes('LISTENING')) continue;
    const cols = line.trim().split(/\s+/);
    const local = cols[1] || '';
    const pid = cols[cols.length - 1];
    const port = Number(local.slice(local.lastIndexOf(':') + 1));
    if (PROTECTED_PORTS.includes(port)) {
      (map[port] = map[port] || []).push(pid);
    }
  }
  for (const port of PROTECTED_PORTS) if (!map[port]) map[port] = [];
  for (const port of Object.keys(map)) map[port].sort();
  return map;
}

// Which PID listens on 127.0.0.1:<port> (own module ports only).
function listenerPid(port) {
  const r = spawnSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  for (const line of String(r.stdout || '').split('\n')) {
    if (!line.includes('LISTENING')) continue;
    const cols = line.trim().split(/\s+/);
    const local = cols[1] || '';
    if (!local.endsWith(`:${port}`)) continue;
    if (!local.startsWith('127.0.0.1') && !local.startsWith('[::1]')) continue;
    return Number(cols[cols.length - 1]);
  }
  return null;
}

function processCmdline(pid) {
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
    `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`],
  { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  return (r.stdout || '').trim();
}

function extractTgz(tgz, extractDir, env) {
  fs.mkdirSync(extractDir, { recursive: true });
  const r = spawnSync(coreTarballLib.bsdtar(), ['-xzf', tgz, '-C', extractDir], {
    env, encoding: 'utf8', windowsHide: true, timeout: 120000,
  });
  if (r.status !== 0) throw new Error(`extract ${tgz} failed: ${(r.stderr || '').slice(-400)}`);
  const pkgDir = path.join(extractDir, 'package');
  if (!fs.existsSync(pkgDir)) throw new Error(`extract ${tgz} produced no package/ dir`);
  return pkgDir;
}

function buildMixNodeModules(nmDir, cacheRoot) {
  const skipTop = new Set([
    'claude-ai-workbench',
    '@sanqianx/project-knowledge',
    '@sanqianx/ai-coding-event-bridge-console',
  ]);
  fs.mkdirSync(nmDir, { recursive: true });
  const skipped = [];
  for (const ent of fs.readdirSync(cacheRoot, { withFileTypes: true })) {
    if (skipTop.has(ent.name)) { skipped.push(ent.name); continue; }
    if (ent.name.startsWith('.')) { skipped.push(ent.name); continue; }
    const target = path.join(cacheRoot, ent.name);
    if (ent.isDirectory()) {
      if (ent.name.startsWith('@')) {
        fs.mkdirSync(path.join(nmDir, ent.name), { recursive: true });
        for (const leaf of fs.readdirSync(target)) {
          if (skipTop.has(`${ent.name}/${leaf}`)) { skipped.push(`${ent.name}/${leaf}`); continue; }
          fs.symlinkSync(path.join(target, leaf), path.join(nmDir, ent.name, leaf), 'junction');
        }
      } else {
        fs.symlinkSync(target, path.join(nmDir, ent.name), 'junction');
      }
    } else {
      fs.copyFileSync(target, path.join(nmDir, ent.name));
    }
  }
  return skipped;
}

const CHAIN_PROBE_SOURCE = `'use strict';
const path = require('node:path');
const { createRequire } = require('node:module');
const desktopDir = process.argv[2];
const req = createRequire(path.join(desktopDir, 'package.json'));
const corePkgPath = req.resolve('@sanqianx/project-knowledge/package.json');
console.log('CORE_PATH ' + corePkgPath);
const corePkg = req('@sanqianx/project-knowledge/package.json');
console.log('CORE_VERSION ' + corePkg.version);
const vendor = require(path.join(path.dirname(corePkgPath), 'vendor-manifest.json'));
console.log('ENGINE_VENDOR_VERSION ' + vendor.modules['knowledge-engine'].version);
const arrow = req('apache-arrow');
console.log('APACHE_ARROW_LOAD ' + (typeof arrow.Table === 'function'));
const lancedb = req('@lancedb/lancedb');
console.log('LANCEDB_LOAD ' + (typeof lancedb.connect === 'function'));
const binding = req('@lancedb/lancedb-win32-x64-msvc/lancedb.win32-x64-msvc.node');
console.log('LANCEDB_NATIVE_LOAD ' + (binding !== undefined && binding !== null));
const wbReq = createRequire(path.join(desktopDir, 'node_modules', 'claude-ai-workbench', 'package.json'));
console.log('WB_VERSION ' + wbReq('./package.json').version);
const quota = wbReq('./packages/server/lib/profile-quota.js');
const keys = Object.keys(quota || {});
console.log('WB_QUOTA_LOAD ' + (quota && keys.length > 0));
console.log('WB_QUOTA_EXPORTS ' + keys.join(','));
const brReq = createRequire(path.join(desktopDir, 'node_modules', '@sanqianx', 'ai-coding-event-bridge-console', 'package.json'));
console.log('BRIDGE_VERSION ' + brReq('./package.json').version);
const bridge = brReq('./src/bridge/core/bridge.js');
console.log('BRIDGE_LOAD ' + (bridge && Object.keys(bridge).length > 0));
console.log('PROBE_PASS');
`;

function observerSource(own) {
  return `'use strict';
// P-DESKTOP-FINAL-THIN-R5 test-only env-proof observer. Injected via --require
// into ELECTRON_RUN_AS_NODE children by the main-process spawn hook. Records
// PATH BOOLEANS only (never env values/secrets) and propagates the same
// rewrite to RUN_AS_NODE descendants. A failure here must never break product
// behavior, hence the blanket try/catch.
try {
  const OWN = ${JSON.stringify(own)};
  const os = require('node:os');
  const fs = require('node:fs');
  const cp = require('node:child_process');
  const eq = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();
  const rec = {
    pid: process.pid, ppid: process.ppid, ts: Date.now(),
    runAsNode: String(process.env.ELECTRON_RUN_AS_NODE) === '1',
    userProfileOwned: eq(process.env.USERPROFILE, OWN.userProfile),
    homedirOwned: eq(os.homedir(), OWN.userProfile),
    appdataOwned: eq(process.env.APPDATA, OWN.appdata),
    localappdataOwned: eq(process.env.LOCALAPPDATA, OWN.localappdata),
    tempOwned: eq(os.tmpdir(), OWN.temp),
  };
  try { fs.appendFileSync(OWN.log, JSON.stringify(rec) + '\\n'); } catch {}
  if (!global.__KB_R5_OBSERVER_HOOK) {
    global.__KB_R5_OBSERVER_HOOK = true;
    const isRunAsNode = (o) => o && o.env && String(o.env.ELECTRON_RUN_AS_NODE) === '1';
    // R8 harness fix: the backend itself RUNS with ELECTRON_RUN_AS_NODE=1, so
    // any child it spawns with a spread env (e.g. runGit's git) carries the
    // marker without actually being a node process — injecting --require
    // there broke git ("unknown option: --require", run-3 import 400). Only
    // node/electron targets get the observer now.
    // NOTE: this source is embedded in a template literal — the class needs
    // four backslashes in the file so the delivered source keeps [\\/] and
    // Windows backslash paths match (run-4 lesson: two collapsed to [/]).
    const isNodeCommand = (c) => /(^|[\\\\/])(node|electron)(\\.exe)?$/i.test(String(c || ''));
    const rewriteEnv = (env) => {
      const e = Object.assign({}, env, {
        USERPROFILE: OWN.userProfile, APPDATA: OWN.appdata,
        LOCALAPPDATA: OWN.localappdata, TMP: OWN.temp, TEMP: OWN.temp,
      });
      delete e.HOMEDRIVE; delete e.HOMEPATH;
      return e;
    };
    const wrap = (orig) => function (cmd, args, opts) {
      try {
        if (isRunAsNode(opts) && isNodeCommand(cmd)) {
          const newArgs = (Array.isArray(args) ? args : []).slice();
          if (newArgs.indexOf(OWN.observer) === -1) newArgs.unshift('--require', OWN.observer);
          return orig.call(this, cmd, newArgs, Object.assign({}, opts, { env: rewriteEnv(opts.env) }));
        }
      } catch {}
      return orig.apply(this, arguments);
    };
    cp.spawn = wrap(cp.spawn);
    cp.spawnSync = wrap(cp.spawnSync);
  }
} catch {}
`;
}

function mainHookExpression(own, observerPath) {
  return `(() => { try {
  if (global.__KB_R5_HOOK) return 'already';
  const OWN = ${JSON.stringify(own)};
  const OBSERVER = ${JSON.stringify(observerPath)};
  // Evaluated via Debugger.evaluateOnCallFrame on the paused entry frame, so
  // the module scope's real require is in scope.
  const req = typeof require === 'function' ? require
    : (process.mainModule && process.mainModule.require);
  if (typeof req !== 'function') return 'hook-error:no-require';
  const cp = req('node:child_process');
  const isRunAsNode = (o) => o && o.env && String(o.env.ELECTRON_RUN_AS_NODE) === '1';
  // R8 harness fix (see observerSource): never inject --require into non-node
  // children (git et al.) even when their env carries the RUN_AS_NODE marker.
  // Template-literal escape: four backslashes deliver [\\/] to this evaluated
  // source so Windows backslash exec paths match (run-4 lesson).
  const isNodeCommand = (c) => /(^|[\\\\/])(node|electron)(\\.exe)?$/i.test(String(c || ''));
  const rewriteEnv = (env) => {
    const e = Object.assign({}, env, {
      USERPROFILE: OWN.userProfile, APPDATA: OWN.appdata,
      LOCALAPPDATA: OWN.localappdata, TMP: OWN.temp, TEMP: OWN.temp,
    });
    delete e.HOMEDRIVE; delete e.HOMEPATH;
    return e;
  };
  const wrap = (orig) => function (cmd, args, opts) {
    try {
      if (isRunAsNode(opts) && isNodeCommand(cmd)) {
        const newArgs = (Array.isArray(args) ? args : []).slice();
        if (newArgs.indexOf(OBSERVER) === -1) newArgs.unshift('--require', OBSERVER);
        return orig.call(this, cmd, newArgs, Object.assign({}, opts, { env: rewriteEnv(opts.env) }));
      }
    } catch {}
    return orig.apply(this, arguments);
  };
  cp.spawn = wrap(cp.spawn);
  cp.spawnSync = wrap(cp.spawnSync);
  global.__KB_R5_HOOK = true;
  return 'installed';
} catch (e) { return 'hook-error:' + (e && e.message); } })()`;
}

// Attach to the held (--inspect-brk) Electron main process and install the
// spawn hook BEFORE the app logic runs. Electron holds the app via the
// waiting-for-debugger mechanism, so we set a pending breakpoint on the entry
// main.cjs first statement, release the wait, and evaluate the hook on the
// resulting paused frame — the module/bootstrap scope carries a real
// `require` (Runtime.evaluate's global scope has none, its command-line-API
// require is non-callable in this build, and dynamic import can never settle
// while a pause freezes the event loop).
async function attachInspectHook(inspectPort, hookExpression, entryRegex) {
  const deadline = Date.now() + 60000;
  let target = null;
  while (Date.now() < deadline && !target) {
    try {
      const res = await fetch(`http://127.0.0.1:${inspectPort}/json/list`);
      const list = await res.json();
      const candidates = Array.isArray(list) ? list : [];
      target = candidates.find((t) => t.webSocketDebuggerUrl && t.type === 'node')
        || candidates.find((t) => t.webSocketDebuggerUrl);
    } catch {}
    if (!target) await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!target) throw new Error('inspector target not found');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map();
  let nextId = 0;
  let pausedFrames = null;
  // The paused event can arrive the instant the socket opens — the handler
  // must be registered before awaiting the open, or it is lost.
  ws.onmessage = (event) => {
    let msg;
    try { msg = JSON.parse(String(event.data)); } catch { return; }
    if (msg.method === 'Debugger.paused' && !pausedFrames) pausedFrames = msg.params.callFrames || [];
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  };
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('inspector websocket open timeout')), 15000);
    ws.onopen = () => { clearTimeout(timer); resolve(); };
    ws.onerror = () => { clearTimeout(timer); reject(new Error('inspector websocket error')); };
  });
  const call = (method, params) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timeout`)); }, 20000);
    pending.set(id, (msg) => { clearTimeout(timer); msg.error ? reject(new Error(`${method}: ${JSON.stringify(msg.error)}`)) : resolve(msg.result); });
    ws.send(JSON.stringify({ id, method, params: params || {} }));
  });
  try {
    await call('Runtime.enable');
    await call('Debugger.enable');
    await call('Debugger.setBreakpointByUrl', {
      lineNumber: 0, columnNumber: 0,
      urlRegex: entryRegex || '.*/main\\.cjs$',
    });
    await call('Runtime.runIfWaitingForDebugger');
    const pauseDeadline = Date.now() + 15000;
    while (!pausedFrames && Date.now() < pauseDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!pausedFrames || !pausedFrames.length) throw new Error('no paused call frames after entry breakpoint');
    const evaluation = await call('Debugger.evaluateOnCallFrame', {
      callFrameId: pausedFrames[0].callFrameId,
      expression: hookExpression,
      returnByValue: true,
    });
    if (evaluation && evaluation.exceptionDetails) {
      const detail = evaluation.exceptionDetails.exception;
      throw new Error(`hook frame-evaluate threw: ${detail && (detail.description || detail.value)}`);
    }
    const value = evaluation && evaluation.result && evaluation.result.value;
    if (value !== 'installed') throw new Error(`hook evaluate returned: ${JSON.stringify(value)}`);
    await call('Debugger.resume').catch(() => {});
    return value;
  } finally {
    try { ws.close(); } catch {}
  }
}

// R6 renderer acceptance: attach to the REAL Electron renderer page of the
// running GUI (Chromium remote-debugging target on an own loopback port —
// the same GUI process the candidate launched; never a driver-local page or
// fabricated DOM) and drive ACTUAL input: real CDP mouse moves for the brand
// tooltip, the focus path for keyboard behavior, a real click that opens the
// Model Management UI, and screenshots saved under the run root (outside
// Git). No provider refresh, no quota API, no model requests.
async function attachRendererSession(rdpPort, sitePort) {
  const deadline = Date.now() + 30000;
  let target = null;
  while (Date.now() < deadline && !target) {
    try {
      const res = await fetch(`http://127.0.0.1:${rdpPort}/json/list`);
      const list = await res.json();
      const pages = (Array.isArray(list) ? list : []).filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      target = pages.find((t) => String(t.url).includes(`127.0.0.1:${sitePort}`)) || pages[0] || null;
    } catch {}
    if (!target) await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!target) throw new Error('renderer page target not found on the remote-debugging port');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map();
  let nextId = 0;
  ws.onmessage = (event) => {
    let msg;
    try { msg = JSON.parse(String(event.data)); } catch { return; }
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  };
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('renderer websocket open timeout')), 15000);
    ws.onopen = () => { clearTimeout(timer); resolve(); };
    ws.onerror = () => { clearTimeout(timer); reject(new Error('renderer websocket error')); };
  });
  const call = (method, params) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timeout`)); }, 20000);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      msg.error ? reject(new Error(`${method}: ${msg.error.message || JSON.stringify(msg.error)}`)) : resolve(msg.result);
    });
    ws.send(JSON.stringify({ id, method, params: params || {} }));
  });
  const evaluate = async (expression) => {
    const r = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) {
      const ex = r.exceptionDetails.exception || {};
      throw new Error(`renderer evaluate threw: ${ex.description || ex.value || r.exceptionDetails.text}`);
    }
    return r.result && r.result.value;
  };
  return { pageUrl: target.url, call, evaluate, close: () => { try { ws.close(); } catch {} } };
}

function readObserverLog(logPath) {
  if (!fs.existsSync(logPath)) return [];
  return fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean)
    .map((line) => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean);
}

async function main() {
  const args = process.argv.slice(2);
  const flagValue = (flag) => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const desktopTgz = flagValue('--desktop-tgz');
  const coreTarball = flagValue('--core-tarball');
  const wbTarball = flagValue('--wb-tarball');
  const bridgeTarball = flagValue('--bridge-tarball');
  const ownedCache = flagValue('--owned-cache');
  const expectEngineVersion = flagValue('--expect-engine-version');
  for (const [flag, value] of [['--desktop-tgz', desktopTgz], ['--core-tarball', coreTarball],
    ['--wb-tarball', wbTarball], ['--bridge-tarball', bridgeTarball], ['--owned-cache', ownedCache]]) {
    if (!value || !fs.existsSync(value)) throw new Error(`${flag} missing or not found: ${value}`);
  }

  // F2 first: capture the real GUI USERPROFILE, then harden THIS driver's own
  // env before any tar/taskkill/tasklist/netstat/powershell child or product
  // require runs. Children spawned without an explicit env inherit the
  // hardened set from here on.
  const realUserProfile = process.env.USERPROFILE;
  // A short prefix on the cache's volume by default; operators can choose
  // a writable external directory explicitly. Never assume a D: drive.
  const shortTempBase = path.resolve(process.env.KB_PREFLIGHT_ISO_ROOT
    || path.parse(path.resolve(ownedCache)).root);
  const repoRoot = path.resolve(__dirname, '..', '..');
  const rel = path.relative(repoRoot, shortTempBase);
  if (!rel || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
    throw new Error('smoke temp root must be outside the source repository');
  }
  // A Windows drive root exists but mkdirSync(recursive) on it throws EPERM —
  // only create the base when it does not exist yet.
  if (!fs.existsSync(shortTempBase)) fs.mkdirSync(shortTempBase, { recursive: true });
  const runRoot = fs.mkdtempSync(path.join(shortTempBase, 'pkr5-'));
  const ambient = envLib.hardenProcessEnv(runRoot, { gui: false });

  const envDirs = envLib.defaultDirs(runRoot);
  const dirs = {
    home: envDirs.home, appdata: envDirs.appdata, localappdata: envDirs.localappdata,
    temp: envDirs.temp, userData: path.join(runRoot, 'electron-user-data'),
  };
  const results = [];
  const record = (id, passed, detail) => {
    results.push({ id, passed, detail });
    console.log(`${passed ? 'PASS' : 'FAIL'} ${id}${detail ? ` — ${detail}` : ''}`);
  };
  const census = { spawned: [], killed: [] };

  // F1: KB_*_URL overrides are full URL STRINGS on explicit own ports.
  const sitePort = await freePort();
  const moduleUrls = {
    KB_TERMINAL_URL: `http://127.0.0.1:${await freePort()}`,
    KB_VECTORHUB_URL: `http://127.0.0.1:${await freePort()}`,
    KB_EVENTBRIDGE_URL: `http://127.0.0.1:${await freePort()}`,
    KB_KNOWLEDGE_ENGINE_URL: `http://127.0.0.1:${await freePort()}`,
  };
  const modulePortOf = (key) => Number(new URL(moduleUrls[key]).port);
  const allPorts = [sitePort, ...Object.keys(moduleUrls).map(modulePortOf)];
  if (allPorts.some((p) => PROTECTED_PORTS.includes(p))) {
    throw new Error(`reserved port collides with a protected port: ${allPorts}`);
  }
  const kbOverrides = {
    KB_MODULES_REGISTER: '0',
    KB_MODULES_AUTOSTART: '1',
    KB_EMBEDDING_FAKE: '1',
    KB_AUTOMATION_FAKE_CLAUDE: '1',
    KB_SITE_HOST: '127.0.0.1',
    KB_SITE_PORT: String(sitePort),
    KB_DATA_DIR_DESKTOP: envDirs.data,
    ...moduleUrls,
  };
  const guiEnv = envLib.buildIsolatedEnv({
    sourceEnv: ambient, runDir: runRoot, dirs: envDirs, gui: true,
    extra: { ...kbOverrides, ELECTRON_RUN_AS_NODE: undefined },
  });
  const nodeEnv = envLib.buildIsolatedEnv({
    sourceEnv: ambient, runDir: runRoot, dirs: envDirs, gui: false,
    extra: { ...kbOverrides, ELECTRON_RUN_AS_NODE: '1' },
  });
  envLib.assertEnvContract(guiEnv, runRoot, { gui: true, originalUserProfile: realUserProfile });
  envLib.assertEnvContract(nodeEnv, runRoot, { gui: false });
  record('driver-self-whitelist', path.resolve(process.env.USERPROFILE || '') === path.resolve(envDirs.home)
    && guiEnv.USERPROFILE === realUserProfile,
  `driver process.env hardened to owned home (children inherit it); real USERPROFILE re-injected ONLY into the gui env (audited Electron exception)`);

  // F3: observer + main-process hook payload
  const observerPath = path.join(runRoot, 'observer.cjs');
  const ownRoots = {
    userProfile: envDirs.home, appdata: envDirs.appdata, localappdata: envDirs.localappdata,
    temp: envDirs.temp, log: path.join(runRoot, 'observer-proof.jsonl'), observer: observerPath,
  };
  fs.writeFileSync(observerPath, observerSource(ownRoots));

  // 1. resolve the real candidate trio + desktop manifest cross-check
  const envBuild = nodeEnv;
  const { mods, byId } = localModules.resolveCandidates({ coreTarball, wbTarball, bridgeTarball });
  const desktopPkg = JSON.parse(spawnSync(coreTarballLib.bsdtar(),
    ['-xOf', desktopTgz, 'package/package.json'], { env: envBuild, encoding: 'utf8', windowsHide: true, timeout: 60000 }).stdout);
  record('inputs-resolved', byId.core.version === desktopPkg.version
    && desktopPkg.dependencies['@sanqianx/project-knowledge'] === byId.core.version,
  `trio ${mods.map((m) => `${m.id}@${m.version}`).join(' ')}; desktop ${desktopPkg.version} pins core ${desktopPkg.dependencies['@sanqianx/project-knowledge']}`);

  const inputHashes = {};
  for (const [k, f] of [['desktopTgz', desktopTgz], ['coreTarball', coreTarball], ['wbTarball', wbTarball], ['bridgeTarball', bridgeTarball]]) {
    inputHashes[k] = { path: path.resolve(f), sha256: sha256(fs.readFileSync(f)), bytes: fs.statSync(f).size };
  }
  const toolHashes = {};
  for (const t of ['release-preflight-5025-env.cjs', 'release-preflight-5025-core-tarball.cjs',
    'release-preflight-5025-local-modules.cjs', 'release-preflight-5025-thin-smoke-r5.cjs']) {
    toolHashes[t] = sha256(fs.readFileSync(path.join(__dirname, t)));
  }
  const cacheCorePkg = path.join(ownedCache, '@sanqianx', 'project-knowledge', 'package.json');
  const staleCacheCoreVersion = JSON.parse(fs.readFileSync(cacheCorePkg, 'utf8')).version;
  const cacheJunctionBefore = fs.readlinkSync(path.join(path.dirname(ownedCache), 'desktop', 'node_modules'));

  // 2. exact extractions (single extraction per tarball; audits run on them,
  //    then the package dir is MOVED into the mix tree)
  const extractRoot = path.join(runRoot, 'extract');
  const coreDir = extractTgz(coreTarball, path.join(extractRoot, 'core'), envBuild);
  const wbDir = extractTgz(wbTarball, path.join(extractRoot, 'wb'), envBuild);
  const bridgeDir = extractTgz(bridgeTarball, path.join(extractRoot, 'bridge'), envBuild);
  const desktopDir = path.join(runRoot, 'app', 'desktop');
  const desktopExtract = extractTgz(desktopTgz, path.join(runRoot, 'app', 'desktop-extract'), envBuild);
  fs.mkdirSync(path.dirname(desktopDir), { recursive: true });
  fs.renameSync(desktopExtract, desktopDir);

  // 3. offline content contracts on the exact extractions
  const quota = localModules.auditWbQuota(byId.wb, path.join(extractRoot, 'wb'), undefined);
  record('wb-quota17-content', quota.failures.length === 0,
    `audited ${quota.detail.audited}, matched ${quota.detail.matched}, versionDocs ${quota.detail.versionDocs}, notShipped ${quota.detail.notShipped.length}`
    + (quota.failures.length ? `; failures: ${quota.failures.slice(0, 3).join(' | ')}` : ''));

  const bridgeText = fs.readFileSync(path.join(bridgeDir, localModules.BRIDGE_FIX_MARKERS.file), 'utf8');
  const bridgeSymbols = localModules.BRIDGE_FIX_MARKERS.substrings;
  record('bridge-path-fix-markers', bridgeSymbols.every((s) => bridgeText.includes(s)),
    `${bridgeSymbols.join(' + ')} present in ${localModules.BRIDGE_FIX_MARKERS.file}`);

  const vendor = JSON.parse(fs.readFileSync(path.join(coreDir, 'vendor-manifest.json'), 'utf8'));
  const engine = vendor.modules['knowledge-engine'];
  const engineFiles = Object.entries(engine.files || {});
  const engineMismatch = engineFiles.filter(([rel, hash]) =>
    sha256(fs.readFileSync(path.join(coreDir, engine.root, ...rel.split('/')))) !== hash);
  record('engine-vendor-content',
    engine.version !== localModules.PREVIOUS_STABLE.engine
      && (!expectEngineVersion || engine.version === expectEngineVersion)
      && engineFiles.length > 0 && engineMismatch.length === 0,
  `version ${engine.version} (previous stable ${localModules.PREVIOUS_STABLE.engine}, expected ${expectEngineVersion || 'any-new'}), ${engineFiles.length} files verified`
    + (engineMismatch.length ? `; mismatched: ${engineMismatch.slice(0, 3).map((e) => e[0]).join(', ')}` : ''));

  const tooltipOk = localModules.UI_TOOLTIP_MARKERS.every((m) =>
    fs.readFileSync(path.join(coreDir, ...m.file.split('/')), 'utf8').includes(m.substring));
  record('ui-tooltip-content', tooltipOk,
    localModules.UI_TOOLTIP_MARKERS.map((m) => `${m.file}:${m.substring}`).join(' + '));

  const runtimeManifest = JSON.parse(fs.readFileSync(path.join(coreDir, 'module-runtime-manifest.json'), 'utf8'));
  const terminal = runtimeManifest.modules.terminal;
  const quotaAppFiles = Object.entries(terminal.files || {}).filter(([rel]) => rel.startsWith('apps/ai-profile-settings-host/'));
  const quotaAppBad = quotaAppFiles.filter(([rel, hash]) =>
    sha256(fs.readFileSync(path.join(wbDir, ...rel.split('/')))) !== hash);
  record('quota-management-ui-content',
    terminal.name === byId.wb.pkgName && terminal.version === byId.wb.version
      && quotaAppFiles.length > 0 && quotaAppBad.length === 0,
  `${terminal.name}@${terminal.version} ai-profile-settings-host ${quotaAppFiles.length} files hash-verified against the WB extraction`
    + (quotaAppBad.length ? `; mismatched: ${quotaAppBad.slice(0, 3).map((f) => f[0]).join(', ')}` : ''));

  // 4. junction-mix node_modules + exact candidate slots
  const nmDir = path.join(desktopDir, 'node_modules');
  const skippedCacheEntries = buildMixNodeModules(nmDir, path.resolve(ownedCache));
  fs.mkdirSync(path.join(nmDir, '@sanqianx'), { recursive: true });
  fs.renameSync(coreDir, path.join(nmDir, '@sanqianx', 'project-knowledge'));
  fs.renameSync(wbDir, path.join(nmDir, 'claude-ai-workbench'));
  fs.renameSync(bridgeDir, path.join(nmDir, '@sanqianx', 'ai-coding-event-bridge-console'));
  const mixCoreVersion = JSON.parse(fs.readFileSync(path.join(nmDir, '@sanqianx', 'project-knowledge', 'package.json'), 'utf8')).version;
  const bypassedSlots = ['claude-ai-workbench', '@sanqianx/project-knowledge', '@sanqianx/ai-coding-event-bridge-console'];
  record('candidate-slots-exact',
    mixCoreVersion === byId.core.version && bypassedSlots.every((slot) => skippedCacheEntries.includes(slot)),
  `mix core ${mixCoreVersion} from the exact TGZ; all three cache slots bypassed (owned-cache stale core ${staleCacheCoreVersion} never junctioned); skipped cache entries: ${skippedCacheEntries.length}`);

  const vectorManifestSpec = runtimeManifest.modules.vectorHub;
  const vectorPkgPath = path.join(nmDir, '@sanqianx', 'vector-hub', 'package.json');
  const vectorCacheVersion = JSON.parse(fs.readFileSync(vectorPkgPath, 'utf8')).version;
  record('vectorhub-version-pinned',
    vectorCacheVersion === vectorManifestSpec.version,
  `owned-cache @sanqianx/vector-hub ${vectorCacheVersion} === candidate module-runtime-manifest ${vectorManifestSpec.version} (registry dependency pinned by the core candidate, reused read-only via junction)`);

  const electronExe = path.join(ownedCache, 'electron', 'dist', 'electron.exe');
  if (!fs.existsSync(electronExe)) throw new Error(`owned cache electron exe missing: ${electronExe}`);

  // 5. native/module chain probe under the REAL electron exe (RUN_AS_NODE)
  const probeScript = path.join(runRoot, 'chain-probe.cjs');
  fs.writeFileSync(probeScript, CHAIN_PROBE_SOURCE);
  const probe = spawnSync(electronExe, [probeScript, desktopDir], {
    cwd: desktopDir, env: nodeEnv, encoding: 'utf8', windowsHide: true, timeout: 180000,
  });
  const probeOut = `${probe.stdout || ''}${probe.stderr || ''}`.trim();
  const probeLine = (key) => (probeOut.split('\n').find((l) => l.startsWith(key + ' ')) || '');
  record('core-native-module-chain',
    probe.status === 0 && probeOut.includes('PROBE_PASS')
      && probeLine('CORE_VERSION').endsWith(byId.core.version)
      && probeLine('ENGINE_VENDOR_VERSION').endsWith(engine.version)
      && probeLine('APACHE_ARROW_LOAD').endsWith('true')
      && probeLine('LANCEDB_LOAD').endsWith('true')
      && probeLine('LANCEDB_NATIVE_LOAD').endsWith('true')
      && probeLine('WB_QUOTA_LOAD').endsWith('true')
      && probeLine('BRIDGE_LOAD').endsWith('true')
      && probeLine('CORE_PATH').includes(path.join('node_modules', '@sanqianx', 'project-knowledge')),
  `exit ${probe.status}: ${['CORE_VERSION', 'ENGINE_VENDOR_VERSION', 'APACHE_ARROW_LOAD', 'LANCEDB_LOAD', 'LANCEDB_NATIVE_LOAD', 'WB_QUOTA_LOAD', 'BRIDGE_LOAD'].map((k) => probeLine(k)).filter(Boolean).join(' | ').slice(0, 400)}`);

  // synthetic own source project + knowledge markers under the SHORT root.
  // R8: a REAL git repository (canonical import fixture shape, makeRepo in
  // _site/_test/helpers) so the product can import it through its own API.
  const ownProject = path.join(runRoot, 'ownproject');
  fs.mkdirSync(ownProject, { recursive: true });
  fs.writeFileSync(path.join(ownProject, 'hello.py'), 'print("r5 synthetic project")\n');
  const ownKnowledge = path.join(runRoot, 'ownknowledge');
  fs.mkdirSync(ownKnowledge, { recursive: true });
  const gitIn = (args) => spawnSync('git', args, { cwd: ownProject, encoding: 'utf8', windowsHide: true, timeout: 60000 });
  gitIn(['init', '-q', '-b', 'main']);
  gitIn(['config', 'user.email', 'r8-ownproject@local.invalid']);
  gitIn(['config', 'user.name', 'R8 Own Project']);
  gitIn(['config', 'commit.gpgsign', 'false']);
  gitIn(['add', '.']);
  const ownCommit = gitIn(['commit', '-qm', 'r8 own project baseline']);
  const protectedBefore = protectedPortSnapshot();

  const endpointPath = path.join(envDirs.data, 'runtime-endpoint.json');
  const guiLogFd = fs.openSync(path.join(runRoot, 'gui.log'), 'a');
  const hookExpression = mainHookExpression(ownRoots, observerPath);
  const inspectorLog = [];
  const launchGui = async (round) => {
    const inspectPort = await freePort();
    if (PROTECTED_PORTS.includes(inspectPort)) throw new Error('inspect port collided with a protected port');
    const rdpPort = await freePort();
    if (PROTECTED_PORTS.includes(rdpPort) || rdpPort === inspectPort) throw new Error('renderer debug port collided');
    const child = spawn(electronExe,
      [`--user-data-dir=${dirs.userData}`, `--inspect-brk=127.0.0.1:${inspectPort}`,
        `--remote-debugging-port=${rdpPort}`, desktopDir], {
        cwd: desktopDir, env: guiEnv, detached: false, stdio: ['ignore', guiLogFd, guiLogFd],
      });
    census.spawned.push(child.pid);
    let hook = { round, inspectPort, rdpPort, attached: false, error: 'not attempted' };
    try {
      const value = await attachInspectHook(inspectPort, hookExpression);
      hook = { round, inspectPort, rdpPort, attached: true, hookResult: value };
    } catch (error) {
      hook = { round, inspectPort, rdpPort, attached: false, error: error.message };
    }
    inspectorLog.push(hook);
    return { child, hook, rdpPort };
  };

  // 6. GUI round 1: endpoint -> HTTP contract -> four REAL modules
  const roundMarker = path.join(envDirs.data, 'r5-round1-marker.txt');
  const knowledgeMarker = path.join(envDirs.knowledge, 'r5-round1-marker.txt');
  const { child: gui1, rdpPort: rdpPort1 } = await launchGui(1);
  let endpoint = null;
  let healthJson = null;
  let moduleProcesses = [];
  let quotaUiLive = null;
  let rendererEvidence = null;
  try {
    endpoint = await waitFor(() => {
      if (!fs.existsSync(endpointPath)) return null;
      const parsed = JSON.parse(fs.readFileSync(endpointPath, 'utf8'));
      return parsed && parsed.host && parsed.port ? parsed : null;
    }, 180000, 'runtime-endpoint.json (round 1)');
    if (endpoint.mode !== 'desktop') throw new Error(`endpoint mode ${endpoint.mode} != desktop`);
    if (endpoint.port !== sitePort) throw new Error(`backend took port ${endpoint.port}, reserved ${sitePort}`);
    record('gui-endpoint-desktop', true, `mode=${endpoint.mode} host=${endpoint.host} port=${endpoint.port} pid=${endpoint.pid}`);
    census.spawned.push(endpoint.pid);
    fs.writeFileSync(roundMarker, `round1 endpoint pid ${endpoint.pid}\n`);
    fs.writeFileSync(knowledgeMarker, `round1 knowledge ${new Date().toISOString()}\n`);

    const baseUrl = `http://${endpoint.host === '::1' ? '[::1]' : endpoint.host}:${endpoint.port}`;
    // The endpoint file can appear a beat before the backend accepts
    // connections (observed once as a bare 'fetch failed' first connect —
    // run preserved at the first-failure root) — probe with a short retry
    // window instead of a single attempt.
    const state = await waitFor(async () => {
      try {
        const response = await httpGet(`${baseUrl}/api/state`, 5000);
        return response.status === 200 ? response : null;
      } catch { return null; }
    }, 15000, 'backend state endpoint accepting connections');
    const stateJson = JSON.parse(state.body.toString('utf8'));
    record('api-state', state.status === 200 && stateJson.schema === 'server-state/v2',
      `http ${state.status} schema ${stateJson.schema}`);

    const identity = await httpGet(`${baseUrl}/api/runtime/identity`);
    const identityJson = JSON.parse(identity.body.toString('utf8'));
    record('core-version-identity', identity.status === 200 && identityJson.version === byId.core.version,
      `reported ${identityJson.version} expected ${byId.core.version} (served by the actual candidate extraction)`);

    const mixProductJs = fs.readFileSync(path.join(nmDir, '@sanqianx', 'project-knowledge', 'ui', 'product.js'));
    const index = await httpGet(`${baseUrl}/`);
    const product = await httpGet(`${baseUrl}/product.js`);
    const versionInfo = await httpGet(`${baseUrl}/version-info.js`);
    const tooltipLive = versionInfo.status === 200 && versionInfo.body.toString('utf8').includes('知识库 v')
      && index.status === 200 && index.body.toString('utf8').includes('brandVersion');
    record('served-ui-bytes-and-tooltip', product.status === 200
      && sha256(product.body) === sha256(mixProductJs) && tooltipLive,
    `/ http ${index.status}, product.js sha256 match=${sha256(product.body) === sha256(mixProductJs)}, tooltip markers live in served bytes (brandVersion + 知识库 v), core identity ${identityJson.version}`);

    // F1 core assertion: health-body URLs are the ACTUAL module URLs and all
    // four REAL modules are up on the reserved own ports.
    healthJson = await waitFor(async () => {
      const response = await httpGet(`${baseUrl}/api/modules/health`);
      if (response.status !== 200) return null;
      const parsed = JSON.parse(response.body.toString('utf8'));
      return MODULE_KEYS.every((k) => parsed.modules && parsed.modules[k] && parsed.modules[k].up) ? parsed : null;
    }, 240000, 'all four modules up');
    const expectedUrlOf = {
      terminal: moduleUrls.KB_TERMINAL_URL, vectorHub: moduleUrls.KB_VECTORHUB_URL,
      eventBridge: moduleUrls.KB_EVENTBRIDGE_URL, engine: moduleUrls.KB_KNOWLEDGE_ENGINE_URL,
    };
    const urlMatches = MODULE_KEYS.map((k) => ({
      k, expected: expectedUrlOf[k], actual: healthJson.modules[k].url,
      up: healthJson.modules[k].up, source: healthJson.modules[k].source,
      ok: String(healthJson.modules[k].url).replace(/\/+$/, '') === expectedUrlOf[k],
    }));
    record('modules-health-own-urls',
      healthJson.ok === true && urlMatches.every((m) => m.ok && m.up),
    `health ok=${healthJson.ok}; ${urlMatches.map((m) => `${m.k} url=${m.actual} up=${m.up} source=${m.source} match=${m.ok}`).join('; ')}`);

    // live module identities: version where the module's own health exposes
    // one; honest labels where it does not.
    const terminalHealth = await httpGet(`${moduleUrls.KB_TERMINAL_URL}/api/claude-workbench/v1/health`);
    const terminalJson = JSON.parse(terminalHealth.body.toString('utf8'));
    record('module-terminal-live-version',
      terminalHealth.status === 200 && terminalJson.status === 'ok'
        && terminalJson.version === byId.wb.version && typeof terminalJson.apiVersion === 'string',
    `WB /api/claude-workbench/v1/health http ${terminalHealth.status}: status=${terminalJson.status} version=${terminalJson.version} (expected ${byId.wb.version}) apiVersion=${terminalJson.apiVersion}`);

    const engineHealth = await httpGet(`${moduleUrls.KB_KNOWLEDGE_ENGINE_URL}/api/health`);
    const engineJson = JSON.parse(engineHealth.body.toString('utf8'));
    record('module-engine-live-version',
      engineHealth.status === 200 && engineJson.name === 'knowledge-engine' && engineJson.version === engine.version,
    `engine /api/health http ${engineHealth.status}: name=${engineJson.name} version=${engineJson.version} (expected ${engine.version}) dataDir=${engineJson.dataDir}`);

    const vectorHealth = await httpGet(`${moduleUrls.KB_VECTORHUB_URL}/api/health`);
    const vectorJson = JSON.parse(vectorHealth.body.toString('utf8'));
    record('module-vectorhub-live-health',
      vectorHealth.status === 200 && vectorJson.ok === true && Array.isArray(vectorJson.projects),
    `vector-hub /api/health http ${vectorHealth.status}: ok=${vectorJson.ok} projects=${(vectorJson.projects || []).length}; the endpoint does NOT expose a version field — version proven via the running entry/process proof below (${vectorManifestSpec.version})`);

    const bridgeHealth = await httpGet(`${moduleUrls.KB_EVENTBRIDGE_URL}/api/health`);
    const bridgeJson = JSON.parse(bridgeHealth.body.toString('utf8'));
    const bridgeHomeOwned = String(bridgeJson.home || '').toLowerCase().startsWith(runRoot.toLowerCase());
    record('module-bridge-live-health',
      bridgeHealth.status === 200 && bridgeJson.ok === true && typeof bridgeJson.registeredProjects === 'number' && bridgeHomeOwned,
    `bridge /api/health http ${bridgeHealth.status}: ok=${bridgeJson.ok} registeredProjects=${bridgeJson.registeredProjects} home=${bridgeJson.home} (owned-root ${bridgeHomeOwned}); no version field — version proven via entry/process proof below`);

    // runtime process/entry/file-hash proof per module (netstat PID ->
    // command line -> entry under the candidate extraction -> sha256 vs the
    // candidate's own manifests). Entries are resolved the SAME way the
    // candidate supervisor resolves them (require.resolve from the core
    // package; package "exports" maps subpaths, e.g. vector-hub ./bin.js ->
    // dist/cjs/bin.js), so the hashed file is the file actually running.
    const coreRequire = require('node:module').createRequire(path.join(nmDir, '@sanqianx', 'project-knowledge', 'package.json'));
    const resolveEntry = (id, fallbackAbs) => {
      try { return coreRequire.resolve(id); } catch { /* engine is a path check, not an id */ }
      return fs.existsSync(fallbackAbs) ? fallbackAbs : null;
    };
    const engineSlot = path.join(nmDir, '@sanqianx', 'project-knowledge', '_modules', 'knowledge-engine');
    const entrySpecs = {
      terminal: { id: 'claude-ai-workbench/packages/server/bin/agent-terminal-server.js', slot: path.join(nmDir, 'claude-ai-workbench'), manifestFiles: terminal.files, version: byId.wb.version },
      vectorHub: { id: '@sanqianx/vector-hub/bin.js', slot: path.join(nmDir, '@sanqianx', 'vector-hub'), manifestFiles: runtimeManifest.modules.vectorHub.files, version: vectorManifestSpec.version },
      eventBridge: { id: '@sanqianx/ai-coding-event-bridge-console/src/bin.js', slot: path.join(nmDir, '@sanqianx', 'ai-coding-event-bridge-console'), manifestFiles: runtimeManifest.modules.eventBridge.files, version: byId.bridge.version },
      engine: { id: null, fallback: path.join(engineSlot, 'src', 'bin.js'), slot: engineSlot, manifestFiles: engine.files, version: engine.version },
    };
    for (const key of MODULE_KEYS) entrySpecs[key].entryAbs = resolveEntry(entrySpecs[key].id, entrySpecs[key].fallback);
    const portOfModule = {
      terminal: modulePortOf('KB_TERMINAL_URL'), vectorHub: modulePortOf('KB_VECTORHUB_URL'),
      eventBridge: modulePortOf('KB_EVENTBRIDGE_URL'), engine: modulePortOf('KB_KNOWLEDGE_ENGINE_URL'),
    };
    for (const key of MODULE_KEYS) {
      const spec = entrySpecs[key];
      if (!spec.entryAbs) throw new Error(`entry for ${key} did not resolve in the mix tree`);
      const pid = await waitFor(() => {
        const found = listenerPid(portOfModule[key]);
        return found && found !== endpoint.pid ? found : null;
      }, 60000, `listener pid for ${key}`);
      census.spawned.push(pid);
      const cmdline = processCmdline(pid);
      const entryAbs = spec.entryAbs;
      // Node realpaths resolved module paths, so a junctioned slot (vector-hub
      // reuses the owned cache read-only) resolves INTO the cache. The hash
      // key must therefore be relative to the slot's REAL path.
      const realSlot = fs.realpathSync(spec.slot);
      const rel = path.relative(realSlot, entryAbs).split(path.sep).join('/');
      const entryInCmdline = cmdline.toLowerCase().includes(rel.toLowerCase())
        || cmdline.toLowerCase().includes(entryAbs.toLowerCase());
      const entryHash = sha256(fs.readFileSync(entryAbs));
      const manifestHash = spec.manifestFiles[rel];
      const cmdlineLower = cmdline.toLowerCase();
      const underDesktop = cmdlineLower.includes(desktopDir.toLowerCase());
      const underOwnedCache = cmdlineLower.includes(path.resolve(ownedCache).toLowerCase());
      moduleProcesses.push({
        module: key, pid, port: portOfModule[key], version: spec.version,
        entry: entryAbs, entryRel: rel, entrySha256: entryHash,
        manifestSha256: manifestHash || 'not-listed-in-manifest',
        entryRoot: underDesktop ? 'candidate-extraction' : (underOwnedCache ? 'owned-cache-junction' : 'other'),
        entryInCmdline,
      });
      record(`module-process-${key}`,
        entryInCmdline && (underDesktop || underOwnedCache) && (manifestHash ? entryHash === manifestHash : true),
      `pid ${pid} on 127.0.0.1:${portOfModule[key]}; entry ${rel} in cmdline=${entryInCmdline}, served from ${underDesktop ? 'the candidate extraction' : (underOwnedCache ? `the owned-cache junction (byte-identical to the candidate manifest hash${manifestHash ? '' : ' — entry not individually listed'})` : 'an UNEXPECTED root')}; entry sha256 ${entryHash.slice(0, 12)}… ${manifestHash ? `=== module manifest sha256 (${spec.version})` : `(entry not individually listed in the manifest; module version ${spec.version} verified via manifest+package files)`}`);
    }

    // quota management UI served LIVE by the actual WB 0.13.7 through the
    // product reverse proxy (/modules/terminal/profile-settings/...), byte
    // compared with the WB extraction.
    const wbExtractionRoot = path.join(nmDir, 'claude-ai-workbench');
    const liveFiles = ['index.html', 'page.css', 'page.js'].map((name) => {
      const local = path.join(wbExtractionRoot, 'apps', 'ai-profile-settings-host', name);
      const served = httpGet(`${baseUrl}/modules/terminal/profile-settings/${name}`);
      return { name, local, localSha256: sha256(fs.readFileSync(local)), served };
    });
    const servedResults = [];
    for (const item of liveFiles) {
      const response = await item.served;
      servedResults.push({
        name: item.name, status: response.status,
        bytesMatch: response.status === 200 && sha256(response.body) === item.localSha256,
      });
    }
    quotaUiLive = servedResults;
    record('quota-management-ui-live',
      servedResults.every((r) => r.bytesMatch),
    `served by the REAL WB ${byId.wb.version} via product proxy /modules/terminal/profile-settings/: ${servedResults.map((r) => `${r.name} http ${r.status} bytes-match=${r.bytesMatch}`).join(', ')}`);

    // R6: ACTUAL RENDERER UI verification on the running candidate. The
    // tooltip text must be filled by the renderer's OWN /api/system/version
    // fetch; the driver independently GETs the same endpoint and both must
    // equal the candidate core version (machine-derived, no literals). All
    // interaction is real CDP input on the real Electron renderer page — no
    // fabricated DOM, no driver-local rendering. Screenshots land in the run
    // root (outside Git). NO provider refresh, NO quota API, NO model calls.
    const versionResp = await httpGet(`${baseUrl}/api/system/version`);
    let versionBody = null;
    try { versionBody = JSON.parse(versionResp.body.toString('utf8')); } catch {}
    const actualVersion = versionBody && versionBody.core && versionBody.core.version || null;
    record('renderer-version-endpoint-actual',
      versionResp.status === 200 && actualVersion === byId.core.version,
    `GET /api/system/version http ${versionResp.status} -> core.version ${JSON.stringify(actualVersion)}; candidate core ${byId.core.version}`);

    const coreUiDir = path.join(nmDir, '@sanqianx', 'project-knowledge', 'ui');
    const widgetByteResults = [];
    for (const name of ['version-info.js', 'version-info.css']) {
      const localSha = sha256(fs.readFileSync(path.join(coreUiDir, name)));
      const served = await httpGet(`${baseUrl}/${name}`);
      widgetByteResults.push({ name, status: served.status, bytesMatch: served.status === 200 && sha256(served.body) === localSha, sha256: localSha });
    }
    record('renderer-widget-byte-sources',
      widgetByteResults.every((w) => w.bytesMatch),
    `tooltip widget bytes served by the actual site: ${widgetByteResults.map((w) => `${w.name} http ${w.status} bytes-match=${w.bytesMatch} sha256 ${w.sha256.slice(0, 12)}…`).join(', ')}`);

    // R8: a fresh desktop instance ships knowledge.rootPath "" and the import
    // API rejects with "Knowledge root is not configured." (run-2 transaction
    // journal). The product's own first-run path for that setting is
    // PATCH /api/settings, so the fixture seeds a self-owned brain root
    // through that same real API — never by editing candidate bytes or
    // weakening the import validation.
    const brainRoot = path.join(runRoot, 'brainroot');
    const seedResp = await fetch(`${baseUrl}/api/settings`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ knowledge: { rootPath: brainRoot } }),
    });
    let seedRootPath = null;
    try { const sb = JSON.parse(await seedResp.text()); seedRootPath = sb.settings && sb.settings.knowledge && sb.settings.knowledge.rootPath || null; } catch {}
    // R8: seed the own project through the REAL same-origin product API
    // (canonical import fixture shape: POST /api/projects/import with
    // localPath/knowledgePath/displayName) so the real root UI gets an
    // actually-selected project BEFORE StartWork/providers. This is an API
    // setup fixture only — it is NOT the audited import-dialog UI case.
    const importResp = await fetch(`${baseUrl}/api/projects/import`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ localPath: ownProject, knowledgePath: ownKnowledge, displayName: 'R8 Own Project' }),
    });
    let importBody = null;
    try { importBody = JSON.parse(await importResp.text()); } catch {}
    const importedProjectId = importBody && importBody.projectId || null;
    const wiring = importBody && importBody.modules
      ? Object.entries(importBody.modules).map(([k, v]) => `${k}=${v && v.ok === true ? 'ok' : 'pending'}`).join(', ')
      : 'n/a';
    record('own-project-imported-api',
      seedResp.status === 200 && !!seedRootPath && importResp.status === 201 && !!importedProjectId && ownCommit.status === 0,
    `git fixture ownproject (commit exit ${ownCommit.status}) + PATCH /api/settings knowledge.rootPath -> http ${seedResp.status} rootPath=${JSON.stringify(seedRootPath)} + POST /api/projects/import -> http ${importResp.status} projectId=${JSON.stringify(importedProjectId)} displayName "R8 Own Project"; module wiring ${wiring} (API setup fixture, not the import-dialog UI case)`);

    rendererEvidence = { rdpPort: rdpPort1, pageUrl: null, screenshots: [], quota: null };
    try {
      const renderer = await attachRendererSession(rdpPort1, sitePort);
      rendererEvidence.pageUrl = renderer.pageUrl;
      await renderer.call('Page.enable');
      await renderer.call('Page.bringToFront');
      // The candidate ships a prefers-reduced-motion block that drops the
      // tooltip transition; emulating it makes computed visibility
      // deterministic even when the GUI window is occluded (the compositor
      // clock stalls CSS transitions on occluded windows).
      await renderer.call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
      const shot = async (name) => {
        try {
          const r = await renderer.call('Page.captureScreenshot', { format: 'png' });
          const p = path.join(runRoot, name);
          fs.writeFileSync(p, Buffer.from(r.data, 'base64'));
          rendererEvidence.screenshots.push(p);
          return p;
        } catch { return null; }
      };
      const TOOLTIP_STATE = "(() => { const el = document.getElementById('brandVersion'); const cs = getComputedStyle(el); return { text: el.textContent, opacity: cs.opacity, position: cs.position, tabindex: el.getAttribute('tabindex'), role: el.getAttribute('role') }; })()";
      const PAGE_FACTS = "(() => ({ title: document.title, brand: (document.querySelector('.brand strong') || {}).textContent || '', hasBrandVersion: !!document.getElementById('brandVersion'), readyState: document.readyState }))()";

      const pageFacts = await renderer.evaluate(PAGE_FACTS);
      record('renderer-page-smoke',
        pageFacts.title === 'Project Knowledge · 我的智脑' && pageFacts.brand === 'Project Knowledge' && pageFacts.hasBrandVersion,
      `real renderer page ${JSON.stringify(renderer.pageUrl)}: title ${JSON.stringify(pageFacts.title)}, brand ${JSON.stringify(pageFacts.brand)}, #brandVersion present=${pageFacts.hasBrandVersion}, readyState ${pageFacts.readyState}`);

      // R8 determinism fix (run-6 first failure): the REAL OS cursor can rest
      // inside .brand (the window's top-left 232x72 box), leaving the tooltip
      // legitimately visible before any synthetic input ("opacity 1 before").
      // Park the pointer at the elementFromPoint-proven away point FIRST so
      // the pre-state is deterministic; every assertion stays unchanged.
      const away = await renderer.evaluate("(() => { const b = document.querySelector('.brand').getBoundingClientRect(); const p = { x: Math.round(Math.min(b.right + 160, innerWidth - 8)), y: Math.round(b.top + 24) }; const hit = document.elementFromPoint(p.x, p.y); return Object.assign(p, { outsideBrand: !(hit && hit.closest('.brand')) }); })()");
      if (away && away.outsideBrand) {
        await renderer.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: away.x, y: away.y, button: 'none', pointerType: 'mouse' });
        await waitFor(async () => Number((await renderer.evaluate(TOOLTIP_STATE)).opacity) === 0 ? true : null, 2000, 'pointer parked away before sampling').catch(() => null);
      }
      const state0 = await renderer.evaluate(TOOLTIP_STATE);
      const settledState = await waitFor(async () => {
        const s = await renderer.evaluate(TOOLTIP_STATE);
        return s.text === `知识库 v${actualVersion}` ? s : null;
      }, 8000, `renderer tooltip text 知识库 v${actualVersion}`).catch(() => null);
      record('renderer-version-tooltip-text',
        !!settledState && state0.tabindex === '0',
      `the renderer's OWN fetch filled #brandVersion: ${JSON.stringify(settledState && settledState.text)} from /api/system/version value ${JSON.stringify(actualVersion)}; tabindex=${JSON.stringify(state0.tabindex)} role=${JSON.stringify(state0.role)}; failure state would read 知识库 版本未知 (honest)`);

      const center = await renderer.evaluate("(() => { const r = document.querySelector('.brand').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + Math.min(r.height / 2, 24)) }; })()");
      const hiddenBefore = Number(state0.opacity) === 0;
      await renderer.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: center.x, y: center.y, button: 'none', pointerType: 'mouse' });
      const hoverState = await waitFor(async () => {
        const s = await renderer.evaluate(TOOLTIP_STATE);
        return Number(s.opacity) === 1 ? s : null;
      }, 4000, 'tooltip visible on real hover').catch(() => null);
      await shot('renderer-tooltip-hover.png');
      // away was computed and proven (elementFromPoint) BEFORE parking the
      // pointer there — see the determinism fix above.
      await renderer.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: away.x, y: away.y, button: 'none', pointerType: 'mouse' });
      const hiddenAfter = await waitFor(async () => {
        const s = await renderer.evaluate(TOOLTIP_STATE);
        return Number(s.opacity) === 0 ? s : null;
      }, 4000, 'tooltip hidden after move-away').catch(() => null);
      record('renderer-tooltip-hover',
        hiddenBefore && !!hoverState && !!hiddenAfter && away.outsideBrand,
      `opacity ${state0.opacity} before -> real CDP mouseMoved over .brand -> ${hoverState ? hoverState.opacity : 'never shown'} (text ${JSON.stringify(hoverState && hoverState.text)}) -> move-away to (${away.x},${away.y}) proven outside .brand via elementFromPoint -> ${hiddenAfter ? '0' : 'still visible'}; screenshot renderer-tooltip-hover.png`);

      await renderer.evaluate("document.getElementById('brandVersion').focus()");
      const focusShown = await waitFor(async () => {
        const s = await renderer.evaluate("(() => { const el = document.getElementById('brandVersion'); return { active: document.activeElement === el, opacity: getComputedStyle(el).opacity }; })()");
        return s.active && Number(s.opacity) === 1 ? s : null;
      }, 4000, 'tooltip visible on focus').catch(() => null);
      await renderer.evaluate("document.getElementById('brandVersion').blur()");
      const blurHidden = await waitFor(async () => {
        const s = await renderer.evaluate("(() => { return Number(getComputedStyle(document.getElementById('brandVersion')).opacity); })()");
        return Number(s) === 0 ? true : null;
      }, 4000, 'tooltip hidden after blur').catch(() => null);
      record('renderer-tooltip-focus',
        !!focusShown && Number(focusShown.opacity) === 1 && !!blurHidden,
      `keyboard path: focus() -> active with opacity ${focusShown ? focusShown.opacity : 'never shown'}; blur() -> hidden ${!!blurHidden} (polled; tabindex=0 keeps the label in the real tab order and the CSS carries the :focus rules)`);

      // R8 VISIBLE-UI gate (leader desktop-r7-visible-review-checkpoint): the
      // own project is imported through the real product API (driver side) and
      // must be VISIBLE and SELECTED in the real UI first; then real input
      // opens StartWork, the system drawer, and 管理模型供应商. The WB providers
      // panel only passes when the iframe AND every ancestor are actually
      // visible (nonzero rect, display/visibility/opacity, active work view,
      // on-screen viewport intersection, hit-test at the frame center) and the
      // 模型供应商 heading renders inside the visible frame; the screenshot is
      // taken WHILE the panel is visible. A hidden frame can never pass. No
      // provider refresh, no quota API, no model calls; the empty owned
      // profile's empty provider list is the honest expected state.
      const realInput = async (sel, condExpr, label, ms = 4000) => {
        const selJson = JSON.stringify(sel);
        const pt = await renderer.evaluate(`(() => { const el = document.querySelector(${selJson}); if (!el) return null; const r = el.getBoundingClientRect(); if (r.width <= 0 || r.height <= 0) return null; return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`).catch(() => null);
        if (!pt) return { path: 'element-missing-or-invisible', activated: false };
        await renderer.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y, button: 'none', pointerType: 'mouse' });
        await renderer.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clicks: 1, pointerType: 'mouse' });
        await renderer.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clicks: 1, pointerType: 'mouse' });
        if (await waitFor(async () => (await renderer.evaluate(condExpr)) ? true : null, Math.min(ms, 3000), `${label} (mouse)`).catch(() => null)) return { path: 'cdp-mouse-click', activated: true };
        await renderer.evaluate(`(() => { const el = document.querySelector(${selJson}); if (el) el.focus(); })()`);
        await renderer.call('Input.dispatchKeyEvent', { type: 'keyDown', key: ' ', code: 'Space', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 });
        await renderer.call('Input.dispatchKeyEvent', { type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 });
        if (await waitFor(async () => (await renderer.evaluate(condExpr)) ? true : null, ms, `${label} (keyboard)`).catch(() => null)) return { path: 'cdp-keyboard-space', activated: true };
        return { path: 'failed', activated: false };
      };

      // 1. the API-imported project must surface as the VISIBLE selected
      //    project. The app auto-refreshes over /api/registry/events (SSE);
      //    if that never fires (e.g. the page is treated as hidden) the
      //    driver honestly falls back to reloading the REAL app page — never
      //    DOM injection or class forcing.
      const selState = () => renderer.evaluate("(() => { const s = document.getElementById('projectSelect'); if (!s) return { missing: true }; let opt = null; for (let i = 0; i < s.options.length; i++) if (s.options[i].value === s.value) opt = s.options[i]; return { disabled: s.disabled, optionCount: s.options.length, value: s.value, label: opt ? opt.textContent.trim() : '' }; })()");
      let selection = await waitFor(async () => {
        const s = await selState();
        return s && !s.missing && !s.disabled && s.value === importedProjectId ? s : null;
      }, 8000, 'imported project visible+selected (registry SSE)').catch(() => null);
      let selectionPath = 'registry-sse-auto-refresh';
      if (!selection) {
        selectionPath = 'cdp-page-reload (honest fallback: registry SSE auto-refresh did not surface the selection)';
        await renderer.call('Page.reload');
        selection = await waitFor(async () => {
          const s = await selState();
          return s && !s.missing && !s.disabled && s.value === importedProjectId ? s : null;
        }, 15000, 'imported project visible+selected after page reload').catch(() => null);
      }
      record('renderer-project-selection-visible',
        !!selection,
      `the API-imported own project is VISIBLE and SELECTED in the real top bar: #projectSelect disabled=${selection ? selection.disabled : 'n/a'} options=${selection ? selection.optionCount : 0} selected=${JSON.stringify(selection && selection.value)} label=${JSON.stringify(selection && selection.label)} (pickup path: ${selectionPath})`);

      // 2. real input enters StartWork with the project selected — the work
      //    layout (not the empty-import notice) must be the visible surface.
      const workExpr = "(() => { const v = document.getElementById('view-work'); const empty = document.getElementById('workEmpty'); const layout = document.getElementById('workLayout'); return !!(v && v.classList.contains('active') && empty && empty.hidden && layout && !layout.hidden); })()";
      const workView = await realInput("button[data-view='work']", workExpr, 'StartWork view');

      // 3. real input opens the system drawer (#configureProviders stays
      //    hidden/unfocusable until the drawer is open — R7 lesson).
      const drawerOpen = await realInput('#openSystem', "(() => { const d = document.getElementById('systemDrawer'); return !!(d && !d.hidden); })()", 'system drawer');

      // 4. full VISIBLE-state probe: iframe + all ancestors in BOTH documents,
      //    active work view, on-screen viewport intersection, hit-test at the
      //    frame center, providers heading rendered inside the frame.
      const quotaProbe = "(() => { const f = document.getElementById('workFrame'); const out = { hasFrame: !!f, frameSrc: f && f.src ? f.src : '', frameRect: null, frameRectNonZero: false, ancestorChainVisible: false, workViewActive: false, onScreen: false, hitTest: false, docLoaded: false, settingsActive: false, settingsChainVisible: false, providersActive: false, heading: '', headingVisible: false, providerListChildren: -1, bodyHasProviderText: false }; if (!f) return out; const r = f.getBoundingClientRect(); out.frameRect = { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; out.frameRectNonZero = r.width >= 50 && r.height >= 50; let chain = true; for (let n = f; n && n.nodeType === 1; n = n.parentElement) { const cs = getComputedStyle(n); if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) <= 0.05) chain = false; const nr = n.getBoundingClientRect(); if (n !== document.documentElement && n !== document.body && (nr.width <= 0 || nr.height <= 0)) chain = false; } out.ancestorChainVisible = chain; const vw = document.getElementById('view-work'); out.workViewActive = !!(vw && vw.classList.contains('active')); const ix0 = Math.max(r.left, 0), iy0 = Math.max(r.top, 0), ix1 = Math.min(r.right, window.innerWidth), iy1 = Math.min(r.bottom, window.innerHeight); const inter = Math.max(0, ix1 - ix0) * Math.max(0, iy1 - iy0); out.onScreen = inter >= 0.5 * r.width * r.height; const cx = ix0 + (ix1 - ix0) / 2, cy = iy0 + (iy1 - iy0) / 2; const hit = document.elementFromPoint(cx, cy); out.hitTest = !!(hit && (hit === f || f.contains(hit))); let doc = null; try { doc = f.contentDocument; } catch (e) {} if (doc) { out.docLoaded = doc.readyState === 'complete'; const vs = doc.getElementById('view-settings'); out.settingsActive = !!(vs && vs.classList.contains('active') && !vs.inert); let sChain = true; if (vs) { for (let n = vs; n && n.nodeType === 1; n = n.parentElement) { const cs = doc.defaultView.getComputedStyle(n); if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) <= 0.05) sChain = false; } } out.settingsChainVisible = sChain; const panel = doc.getElementById('s-providers'); out.providersActive = !!(panel && panel.classList.contains('active')); const h2 = panel ? panel.querySelector('h2') : null; out.heading = h2 ? h2.textContent.trim() : ''; if (h2) { const hr = h2.getBoundingClientRect(); const dw = doc.documentElement.clientWidth, dh = doc.documentElement.clientHeight; out.headingVisible = hr.width > 0 && hr.height > 0 && hr.top >= 0 && hr.left >= 0 && hr.bottom <= dh && hr.right <= dw; } const list = doc.getElementById('provider-list'); out.providerListChildren = list ? list.children.length : -1; out.bodyHasProviderText = String(doc.body && doc.body.textContent || '').includes('模型供应商'); } return out; })()";
      const quotaReady = (s) => !!(s && s.hasFrame && s.frameRectNonZero && s.ancestorChainVisible && s.workViewActive && s.onScreen && s.hitTest && s.docLoaded && s.settingsActive && s.settingsChainVisible && s.providersActive);
      let activation = 'not-attempted';
      let quotaState = null;
      let btnText = '(button not reachable)';
      if (drawerOpen.activated) {
        const btnPt = await renderer.evaluate(`(() => { const el = document.querySelector('#configureProviders'); if (!el) return null; const r = el.getBoundingClientRect(); if (r.width <= 0 || r.height <= 0) return null; return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), text: el.textContent.trim() }; })()`).catch(() => null);
        if (btnPt) {
          btnText = btnPt.text;
          activation = 'cdp-mouse-click';
          await renderer.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: btnPt.x, y: btnPt.y, button: 'none', pointerType: 'mouse' });
          await renderer.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: btnPt.x, y: btnPt.y, button: 'left', clicks: 1, pointerType: 'mouse' });
          await renderer.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: btnPt.x, y: btnPt.y, button: 'left', clicks: 1, pointerType: 'mouse' });
          quotaState = await waitFor(async () => { const s = await renderer.evaluate(quotaProbe); return quotaReady(s) ? s : null; }, 3000, 'visible providers panel (mouse)').catch(() => null);
          if (!quotaState) {
            activation = 'cdp-keyboard-space';
            await renderer.evaluate("(() => { const el = document.querySelector('#configureProviders'); if (el) el.focus(); })()");
            await renderer.call('Input.dispatchKeyEvent', { type: 'keyDown', key: ' ', code: 'Space', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 });
            await renderer.call('Input.dispatchKeyEvent', { type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 });
            quotaState = await waitFor(async () => { const s = await renderer.evaluate(quotaProbe); return quotaReady(s) ? s : null; }, 20000, 'visible providers panel (keyboard)').catch(() => null);
          }
        }
      }
      const stagedFail = quotaState ? null : await renderer.evaluate(quotaProbe).catch(() => null);
      const quotaShot = await shot('renderer-quota-ui.png');
      const failBits = [];
      if (stagedFail) {
        for (const k of ['hasFrame', 'frameRectNonZero', 'ancestorChainVisible', 'workViewActive', 'onScreen', 'hitTest', 'docLoaded', 'settingsActive', 'settingsChainVisible', 'providersActive']) if (!stagedFail[k]) failBits.push(k);
      }
      const failReason = !selection
        ? 'imported project never became visible+selected'
        : (!workView.activated
          ? 'StartWork work layout never became visible via real input'
          : (!drawerOpen.activated
            ? 'system drawer never opened via real input'
            : (btnText === '(button not reachable)'
              ? 'configureProviders not visible inside the open drawer'
              : (failBits.length ? `visible-UI gate not satisfied: ${failBits.join(',')}` : 'providers panel state unknown'))));
      rendererEvidence.quota = quotaState
        ? { opened: true, visibleProof: true, selectionPath, workViewActivation: workView.path, drawerActivation: drawerOpen.path, activation, ...quotaState }
        : { opened: false, visibleProof: false, selectionPath, workViewActivation: workView.path, drawerActivation: drawerOpen.path, activation, staged: stagedFail, reason: failReason };
      record('renderer-quota-ui-live',
        !!(quotaState && quotaState.providersActive && quotaState.heading === '模型供应商' && quotaState.headingVisible),
      `visible-UI proof: real input (${workView.path}) entered StartWork with the imported project selected (work layout visible, empty-import notice hidden), (${drawerOpen.path}) opened the system drawer, (${activation}) activated ${JSON.stringify(btnText)}; the WB ${byId.wb.version} providers panel is REALLY VISIBLE inside the agent-terminal iframe: frameRect=${quotaState ? JSON.stringify(quotaState.frameRect) : 'n/a'} ancestorChainVisible=${quotaState ? quotaState.ancestorChainVisible : false} workViewActive=${quotaState ? quotaState.workViewActive : false} onScreen>=50%=${quotaState ? quotaState.onScreen : false} hitTest=${quotaState ? quotaState.hitTest : false} settingsActive=${quotaState ? quotaState.settingsActive : 'never'} heading=${JSON.stringify(quotaState && quotaState.heading)} headingVisible=${quotaState ? quotaState.headingVisible : false} providerListChildren=${quotaState ? quotaState.providerListChildren : '-'} (empty owned profile — honest empty state; no provider refresh, no quota API, no model calls); screenshot taken while visible: ${quotaShot || 'n/a'}${quotaState ? '' : `; ${failReason}`}`);
      renderer.close();
    } catch (error) {
      record('renderer-ui-verification', false, error.message);
    }

    // F3 proof: the actual Node children (backend + module grandchildren)
    // report owned roots from INSIDE themselves (booleans only, no secrets).
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const observerEntries = readObserverLog(ownRoots.log);
    const runAsNodeEntries = observerEntries.filter((e) => e.runAsNode);
    const backendEntry = runAsNodeEntries.find((e) => e.pid === endpoint.pid) || null;
    const modulePids = new Set(moduleProcesses.map((m) => m.pid));
    const moduleEntries = runAsNodeEntries.filter((e) => modulePids.has(e.pid));
    const allOwned = (e) => e.userProfileOwned && e.homedirOwned && e.appdataOwned
      && e.localappdataOwned && e.tempOwned;
    record('node-children-userprofile-owned',
      !!backendEntry && allOwned(backendEntry) && moduleEntries.length >= MODULE_KEYS.length
        && moduleEntries.every(allOwned),
    `observer proof from inside the real children: backend pid ${backendEntry ? backendEntry.pid : 'missing'} owned=${backendEntry ? allOwned(backendEntry) : '-'}; module children observed ${moduleEntries.length}/${MODULE_KEYS.length} all-owned=${moduleEntries.every(allOwned)} (USERPROFILE/HOME/APPDATA/LOCALAPPDATA/TEMP booleans); GUI parent keeps the real USERPROFILE by the audited exception`);
  } catch (error) {
    record('gui-round-1', false, error.message);
  }

  // 7. teardown round 1 ALWAYS — kill the tree THIS driver spawned, then
  // verify every observed process of the round is gone.
  const round1Pids = [gui1.pid, endpoint ? endpoint.pid : 0, ...moduleProcesses.map((m) => m.pid)].filter(Boolean);
  taskkillTree(gui1.pid);
  census.killed.push(...round1Pids);
  let round1Gone = true;
  for (const pid of round1Pids) {
    try {
      await waitFor(() => !pidAlive(pid), 30000, `round-1 pid ${pid} exit`);
    } catch {
      round1Gone = false;
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 3000));
  fs.rmSync(endpointPath, { force: true });

  const round1Ok = results.every((r) => r.passed);
  let relaunchOk = false;
  let relaunchDetail = 'skipped (round 1 failed)';
  let round2ObserverCount = 0;
  if (round1Ok) {
    const observerCountAfterRound1 = readObserverLog(ownRoots.log).length;
    const { child: gui2 } = await launchGui(2);
    let endpoint2 = null;
    try {
      endpoint2 = await waitFor(() => {
        if (!fs.existsSync(endpointPath)) return null;
        const parsed = JSON.parse(fs.readFileSync(endpointPath, 'utf8'));
        return parsed && parsed.host && parsed.port && parsed.pid !== (endpoint ? endpoint.pid : 0) ? parsed : null;
      }, 180000, 'runtime-endpoint.json (round 2)');
      census.spawned.push(endpoint2.pid);
      const baseUrl2 = `http://${endpoint2.host === '::1' ? '[::1]' : endpoint2.host}:${endpoint2.port}`;
      // R8 harness fix (run-5 first failure): same boot-race class as round 1 —
      // the endpoint file can appear a beat before the listener accepts, so a
      // single-attempt fetch dies with "fetch failed" (run-5 evidence: backend
      // pid 46056 logged Listening at 127.0.0.1:50549). Retry both fetches.
      const state2 = await waitFor(async () => {
        try {
          const response = await httpGet(`${baseUrl2}/api/state`, 5000);
          return response.status === 200 ? response : null;
        } catch { return null; }
      }, 15000, 'round-2 state endpoint accepting connections');
      const identity2 = await waitFor(async () => {
        try {
          const response = await httpGet(`${baseUrl2}/api/runtime/identity`, 5000);
          return response.status === 200 ? response : null;
        } catch { return null; }
      }, 15000, 'round-2 identity endpoint accepting connections');
      const identity2Json = JSON.parse(identity2.body.toString('utf8'));
      const health2 = await waitFor(async () => {
        const response = await httpGet(`${baseUrl2}/api/modules/health`);
        if (response.status !== 200) return null;
        const parsed = JSON.parse(response.body.toString('utf8'));
        return MODULE_KEYS.every((k) => parsed.modules && parsed.modules[k] && parsed.modules[k].up) ? parsed : null;
      }, 240000, 'all four modules up (round 2)');
      const health2UrlsOk = MODULE_KEYS.every((k) =>
        String(health2.modules[k].url).replace(/\/+$/, '') === ({
          terminal: moduleUrls.KB_TERMINAL_URL, vectorHub: moduleUrls.KB_VECTORHUB_URL,
          eventBridge: moduleUrls.KB_EVENTBRIDGE_URL, engine: moduleUrls.KB_KNOWLEDGE_ENGINE_URL,
        }[k]));
      round2ObserverCount = readObserverLog(ownRoots.log).length - observerCountAfterRound1;
      relaunchOk = endpoint2.port === sitePort && state2.status === 200
        && identity2.status === 200 && identity2Json.version === byId.core.version
        && health2UrlsOk
        && fs.existsSync(roundMarker) && fs.existsSync(knowledgeMarker) && fs.existsSync(path.join(ownProject, 'hello.py'));
      relaunchDetail = `relaunch endpoint pid ${endpoint2.pid} port ${endpoint2.port}, identity ${identity2Json.version}, four modules up again on the same own URLs=${health2UrlsOk}, data+knowledge markers and synthetic project preserved, round-1 teardown clean=${round1Gone}, fresh observer proof lines from round 2: ${round2ObserverCount}`;
    } catch (error) {
      relaunchDetail = error.message;
    } finally {
      taskkillTree(gui2.pid);
      census.killed.push(gui2.pid, endpoint2 ? endpoint2.pid : 0);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    record('quit-relaunch-same-data', relaunchOk, relaunchDetail);
  }

  // 8. ownership cleanup + input preservation + protected ports untouched
  const modulePidsAll = moduleProcesses.map((m) => m.pid);
  const lingering = [...new Set([...census.spawned, ...modulePidsAll])]
    .filter((pid) => pid && pidAlive(pid));
  record('own-process-cleanup', lingering.length === 0,
    `spawned/observed ${[...new Set([...census.spawned, ...modulePidsAll])].join(', ')}; killed trees ${census.killed.filter(Boolean).join(', ')}; lingering: ${lingering.length || 'none'}`);

  const protectedAfter = protectedPortSnapshot();
  record('protected-ports-untouched', JSON.stringify(protectedBefore) === JSON.stringify(protectedAfter),
    `listener sets on 5757/5760/8787/8790 identical before/after: ${JSON.stringify(protectedAfter)}`);

  const cacheCoreAfter = JSON.parse(fs.readFileSync(cacheCorePkg, 'utf8')).version;
  const cacheJunctionAfter = fs.readlinkSync(path.join(path.dirname(ownedCache), 'desktop', 'node_modules'));
  record('owned-inputs-untouched',
    cacheCoreAfter === staleCacheCoreVersion && cacheJunctionAfter === cacheJunctionBefore,
  `owned cache core manifest still ${cacheCoreAfter} (stale 5.0.24 copy intact, only READ); desktop/node_modules junction target unchanged`);

  fs.closeSync(guiLogFd);
  const observerEntriesFinal = readObserverLog(ownRoots.log);
  const backendLog = path.join(envDirs.data, 'desktop-backend.log');
  const report = {
    schema: 'release-preflight-5025-thin-smoke-r5/v1',
    labeling: 'REAL 5.0.25 candidate bytes (exact TGZ extractions + owned-cache junction reuse) with ALL FOUR REAL module processes spawned by the candidate supervisor on reserved own URL-string ports; GUI keeps the real USERPROFILE (audited Electron exception) while every ELECTRON_RUN_AS_NODE child is isolated and proven from inside via the observer; vector-hub/bridge health endpoints expose no version field — labeled honestly and proven via running entry-file hashes; R6 renderer checks drive REAL CDP input on the real Electron renderer page (tooltip via the renderer\'s own /api/system/version fetch, hover/focus visibility under prefers-reduced-motion emulation, Model Management opened with the activation path recorded honestly); R8: the own project is imported through the real product API (canonical fixture) and must be VISIBLE+SELECTED before StartWork, and the WB providers panel only passes when the iframe and every ancestor are actually visible (nonzero rect, display/visibility/opacity, active work view, on-screen viewport intersection, hit-test) with the 模型供应商 heading rendered inside the frame and the screenshot taken while visible — no fabricated DOM, no quota API, no model calls',
    inputs: inputHashes,
    tools: toolHashes,
    ownedCache: {
      path: path.resolve(ownedCache),
      staleCoreCopyVersion: staleCacheCoreVersion,
      junctionTarget: cacheJunctionBefore,
      electronExe,
      skippedInMix: skippedCacheEntries,
    },
    ports: {
      site: sitePort,
      modules: moduleUrls,
      protected: PROTECTED_PORTS,
      protectedListenersBefore: protectedBefore,
      protectedListenersAfter: protectedAfter,
    },
    runRoot,
    desktopDir,
    ownProject,
    isolation: {
      driverSelfWhitelisted: true,
      realGuiUserProfileException: true,
      nodeChildrenHook: 'Electron --inspect-brk main-process test-only spawn hook rewrites USERPROFILE/APPDATA/LOCALAPPDATA/TEMP for ELECTRON_RUN_AS_NODE children and injects the --require observer; observer propagates to RUN_AS_NODE descendants',
      inspectorLog,
      observerProofFile: ownRoots.log,
      observerEntries: observerEntriesFinal,
    },
    moduleProcesses,
    quotaUiLive,
    rendererEvidence,
    backendLog: fs.existsSync(backendLog) ? { path: backendLog, bytes: fs.statSync(backendLog).size } : null,
    guiLog: path.join(runRoot, 'gui.log'),
    results,
    passed: results.every((r) => r.passed),
  };
  fs.writeFileSync(path.join(runRoot, 'thin-smoke-r5-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ passed: report.passed, runRoot }));
  process.exit(report.passed ? 0 : 1);
}

main().catch((error) => {
  console.error(error && error.stack || error);
  process.exit(1);
});
