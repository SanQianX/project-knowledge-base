'use strict';
// P-STARTUP-ISOLATION-R12 isolation harness for every slow-startup driver and
// fixture. Reuses (requires, never edits) the audited
// release-preflight-5025-env.cjs construction and the R5 thin-smoke
// inspector/observer pattern:
//
//  - The DRIVER hardens its own process.env at START (before any tool spawn
//    or user-filesystem work): nothing ambient but the system allow-list
//    survives, and every writable root moves under one outside-repo run
//    directory. Children spawned without an explicit env inherit that set.
//  - Every non-GUI Node child (fixtures, CLI runs, the real backend booted by
//    the CLI) gets a fully isolated env via buildIsolatedEnv(gui:false):
//    USERPROFILE/HOME/APPDATA/LOCALAPPDATA/TEMP/PS cache FILE + both
//    KB_DATA_DIR/KB_KNOWLEDGE_DATA_DIR + agent homes, all inside runRoot.
//  - The REAL Electron GUI keeps its original USERPROFILE (the audited
//    Electron 43 exception) but gets --user-data-dir + KB_DESKTOP_USER_DATA_DIR
//    under runRoot and is launched with --inspect-brk; before app entry the
//    driver installs a TEST-ONLY spawn hook in the MAIN process so every
//    ELECTRON_RUN_AS_NODE child (the production backend-runtime.cjs backend)
//    has USERPROFILE/APPDATA/LOCALAPPDATA/TEMP rewritten to the owned roots
//    plus a --require observer. The real Node backend therefore NEVER
//    inherits the real GUI USERPROFILE.
//  - Every observed child records PATH BOOLEANS only (never env values or
//    secrets) into a JSONL log: userProfileOwned/homedirOwned/appdataOwned/
//    localappdataOwned/tempOwned. Assertions consume those booleans.
//  - Own loopback ports only (freePort guards the protected 5757/5760/8787/
//    8790 set); the protected set is snapshotted before/after each run.

const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const envLib = require('./release-preflight-5025-env.cjs');

const sha256 = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const PROTECTED_PORTS = [5757, 5760, 8787, 8790];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => {
        if (PROTECTED_PORTS.includes(port)) return freePort().then(resolve, reject);
        resolve(port);
      });
    });
    server.on('error', reject);
  });
}

function pidAlive(pid) {
  if (!pid) return false;
  const { spawnSync } = require('node:child_process');
  const r = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH'], { encoding: 'utf8', windowsHide: true });
  return (r.stdout || '').includes(String(pid));
}

function taskkillTree(pid) {
  const { spawnSync } = require('node:child_process');
  const r = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { encoding: 'utf8', windowsHide: true });
  return r.status === 0;
}

// port -> [listener pids] for the PROTECTED ports only; we never touch them,
// and the before/after snapshots prove our runs never fell back onto them.
function protectedPortSnapshot() {
  const { spawnSync } = require('node:child_process');
  const r = spawnSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  const map = {};
  for (const line of String(r.stdout || '').split('\n')) {
    if (!line.includes('LISTENING')) continue;
    const cols = line.trim().split(/\s+/);
    const local = cols[1] || '';
    const pid = cols[cols.length - 1];
    const port = Number(local.slice(local.lastIndexOf(':') + 1));
    if (PROTECTED_PORTS.includes(port)) (map[port] = map[port] || []).push(pid);
  }
  for (const port of PROTECTED_PORTS) if (!map[port]) map[port] = [];
  for (const port of Object.keys(map)) map[port].sort();
  return map;
}

// R5 observer (copied minimal, one extension): records PATH BOOLEANS only and
// propagates to RUN_AS_NODE descendants. Extension for the CLI chain: the
// bin CLI spawns its --fg backend WITHOUT an explicit env option, so the
// effective env is the inherited one — the marker check now considers that
// case (env rewrite is still only applied to explicitly-passed envs, which
// are already isolated anyway; env-less children inherit the isolated set).
function observerSource(own) {
  return `'use strict';
// P-STARTUP-ISOLATION-R12 test-only env-proof observer (--require injected).
// Records PATH BOOLEANS only (never env values/secrets) and propagates the
// hook to RUN_AS_NODE descendants. A failure here must never break product
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
  if (!global.__KB_R12_OBSERVER_HOOK) {
    global.__KB_R12_OBSERVER_HOOK = true;
    // R8 lesson: never inject --require into non-node children (git et al.)
    // even when their env carries the RUN_AS_NODE marker.
    // Template-literal escape: four backslashes here deliver [\\/] to the
    // observer file so Windows backslash exec paths match (R5 run-4 lesson).
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
        const effective = (opts && opts.env) || process.env;
        const isMarker = String(effective.ELECTRON_RUN_AS_NODE) === '1';
        if (isMarker && isNodeCommand(cmd)) {
          const newArgs = (Array.isArray(args) ? args : []).slice();
          if (newArgs.indexOf(OWN.observer) === -1) newArgs.unshift('--require', OWN.observer);
          if (opts && opts.env) return orig.call(this, cmd, newArgs, Object.assign({}, opts, { env: rewriteEnv(opts.env) }));
          return orig.call(this, cmd, newArgs, opts);
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

// R5 main-process spawn hook, installed via the inspector protocol on the
// paused entry frame of main.cjs BEFORE app logic runs. The production
// spawnBackend passes an explicit env with ELECTRON_RUN_AS_NODE=1, so its
// rewrite applies there; the GUI browser process keeps the real USERPROFILE
// (audited exception) but its userData was already redirected.
function mainHookExpression(own, observerPath) {
  return `(() => { try {
  if (global.__KB_R12_HOOK) return 'already';
  const OWN = ${JSON.stringify(own)};
  const OBSERVER = ${JSON.stringify(observerPath)};
  const req = typeof require === 'function' ? require
    : (process.mainModule && process.mainModule.require);
  if (typeof req !== 'function') return 'hook-error:no-require';
  const cp = req('node:child_process');
  const isRunAsNode = (o) => o && o.env && String(o.env.ELECTRON_RUN_AS_NODE) === '1';
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
  global.__KB_R12_HOOK = true;
  return 'installed';
} catch (e) { return 'hook-error:' + (e && e.message); } })()`;
}

// Attach to the held (--inspect-brk) Electron main process and install the
// spawn hook before app entry resumes (R5 mechanism; the paused entry frame
// carries the module scope's real require).
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
    if (!target) await sleep(250);
  }
  if (!target) throw new Error('inspector target not found');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map();
  let nextId = 0;
  let pausedFrames = null;
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
    await call('Debugger.setBreakpointByUrl', { lineNumber: 0, columnNumber: 0, urlRegex: entryRegex || '.*/main\\.cjs$' });
    await call('Runtime.runIfWaitingForDebugger');
    const pauseDeadline = Date.now() + 15000;
    while (!pausedFrames && Date.now() < pauseDeadline) await sleep(100);
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

// Minimal renderer screenshot over CDP (R6 pattern): real page of the running
// GUI, captured only AFTER isolation booleans were proven.
async function captureRendererScreenshot(rdpPort, urlPart, outPng) {
  const deadline = Date.now() + 30000;
  let target = null;
  while (Date.now() < deadline && !target) {
    try {
      const res = await fetch(`http://127.0.0.1:${rdpPort}/json/list`);
      const list = await res.json();
      const pages = (Array.isArray(list) ? list : []).filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      target = pages.find((t) => String(t.url).includes(urlPart)) || pages[0] || null;
    } catch {}
    if (!target) await sleep(250);
  }
  if (!target) throw new Error('renderer page target not found');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let nextId = 0;
  const pending = new Map();
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
    pending.set(id, (msg) => { msg.error ? reject(new Error(`${method}: ${msg.error.message}`)) : resolve(msg.result); });
    ws.send(JSON.stringify({ id, method, params: params || {} }));
  });
  try {
    await call('Page.enable');
    const shot = await call('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(outPng, Buffer.from(shot.data, 'base64'));
    return { pageUrl: target.url, bytes: shot.data.length / 4 * 3 };
  } finally {
    try { ws.close(); } catch {}
  }
}

function readObserverLog(logPath) {
  if (!fs.existsSync(logPath)) return [];
  return fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean)
    .map((line) => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean);
}

// Driver-entry hardening. Call FIRST, before any tool spawn or user-filesystem
// work. Returns the harness object every driver uses for envs, spawns,
// observer proofs, ports, and cleanup.
function createHarness(label) {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const realUserProfile = process.env.USERPROFILE;
  const baseRoot = path.resolve(process.env.KB_PREFLIGHT_ISO_ROOT || os.tmpdir());
  const rel = path.relative(repoRoot, baseRoot);
  if (!rel || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
    throw new Error(`isolation run root must be outside the source repository: ${baseRoot}`);
  }
  const runRoot = fs.mkdtempSync(path.join(baseRoot, `kb-ss-r12-${label || 'x'}-`));
  // From here on THIS driver process carries only the allow-listed system
  // floor plus runRoot-owned writable roots.
  const ambient = envLib.hardenProcessEnv(runRoot, { gui: false });
  const envDirs = envLib.defaultDirs(runRoot);

  const observerPath = path.join(runRoot, 'observer.cjs');
  const observerLog = path.join(runRoot, 'observer.jsonl');
  const ownRoots = {
    userProfile: envDirs.home, appdata: envDirs.appdata,
    localappdata: envDirs.localappdata, temp: envDirs.temp,
  };
  fs.writeFileSync(observerPath, observerSource({
    ...ownRoots, log: observerLog, observer: observerPath,
  }));

  const nodeEnv = (extra = {}) => {
    const env = envLib.buildIsolatedEnv({ sourceEnv: ambient, runDir: runRoot, dirs: envDirs, gui: false, extra });
    envLib.assertEnvContract(env, runRoot, { gui: false });
    return env;
  };
  const guiEnv = (extra = {}) => {
    const env = envLib.buildIsolatedEnv({
      sourceEnv: ambient, runDir: runRoot, dirs: envDirs, gui: true,
      extra: { ELECTRON_RUN_AS_NODE: undefined, ...extra },
    });
    envLib.assertEnvContract(env, runRoot, { gui: true, originalUserProfile: realUserProfile });
    return env;
  };

  const spawnNode = (file, args, { extra = {}, observer = false } = {}) => {
    const env = nodeEnv(observer
      ? { ...extra, ELECTRON_RUN_AS_NODE: '1' }
      : { ...extra, ELECTRON_RUN_AS_NODE: undefined });
    const argv = observer ? ['--require', observerPath, file, ...args] : [file, ...args];
    return spawn(process.execPath, argv, { env, windowsHide: true });
  };

  // Launch the REAL GUI under the audited exception: original USERPROFILE,
  // own --user-data-dir, held on --inspect-brk until the spawn hook is in.
  const spawnGuiHeld = async (electronExe, appDir, { extra = {}, userDataDir } = {}) => {
    const inspectPort = await freePort();
    const rdpPort = await freePort();
    if (rdpPort === inspectPort) throw new Error('debug port collision');
    const dir = userDataDir || path.join(runRoot, 'electron-user-data');
    fs.mkdirSync(dir, { recursive: true });
    const env = guiEnv({
      KB_DESKTOP_USER_DATA_DIR: dir,
      KB_MODULES_AUTOSTART: '0',
      ELECTRON_ENABLE_LOGGING: '1',
      ...extra,
    });
    const child = spawn(electronExe,
      [`--user-data-dir=${dir}`, `--inspect-brk=127.0.0.1:${inspectPort}`,
        `--remote-debugging-port=${rdpPort}`, appDir],
      { cwd: appDir, env, detached: false, windowsHide: true });
    const hookResult = await attachInspectHook(inspectPort, mainHookExpression(
      { ...ownRoots, log: observerLog, observer: observerPath }, observerPath));
    return { child, inspectPort, rdpPort, hookResult, userDataDir: dir };
  };

  const observerProof = () => {
    const entries = readObserverLog(observerLog);
    const runAsNode = entries.filter((e) => e.runAsNode);
    return {
      entries,
      runAsNodeCount: runAsNode.length,
      allOwned: entries.length > 0 && runAsNode.length > 0
        && runAsNode.every((e) => e.userProfileOwned && e.homedirOwned && e.appdataOwned
          && e.localappdataOwned && e.tempOwned),
      realUserProfileSeen: entries.some((e) => !e.userProfileOwned),
    };
  };

  return {
    runRoot, envDirs, ownRoots, observerPath, observerLog,
    realUserProfile, ambient,
    nodeEnv, guiEnv, spawnNode, spawnGuiHeld,
    observerProof,
    freePort, pidAlive, taskkillTree,
    protectedPortSnapshot, protectedPorts: PROTECTED_PORTS,
    captureRendererScreenshot,
    cleanup: () => { try { fs.rmSync(runRoot, { recursive: true, force: true }); } catch {} },
    sha256,
  };
}

module.exports = {
  createHarness, freePort, pidAlive, taskkillTree, protectedPortSnapshot,
  PROTECTED_PORTS, observerSource, mainHookExpression, attachInspectHook,
  readObserverLog, captureRendererScreenshot, sha256,
};
