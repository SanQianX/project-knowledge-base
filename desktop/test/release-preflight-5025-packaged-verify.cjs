'use strict';
// P-RELEASE-PREFLIGHT-5025 packaged-runtime verification (successor of the
// deleted test/packaged-smoke.cjs, which referenced the also-deleted npm
// scripts). Launches the REAL built "Project Knowledge.exe" — GUI first,
// then its backend — in a fully isolated profile, and asserts:
//
//   1. backend publishes runtime-endpoint.json with mode === 'desktop'
//   2. /api/state answers 200 with the server-state/v2 schema
//   3. /api/runtime/identity reports the core version pinned by desktop
//      (--expect-core-version overrides; a mismatch FAILS — this is the
//      negative-control hook, not a decorative comparison)
//   4. the served UI (/ and /product.js) is byte-identical to the
//      ui/product.js packed inside app.asar
//   5. a second instance exits promptly while the first stays alive
//   6. the packaged backend's native path works: requiring the core from
//      inside app.asar loads apache-arrow AND @lancedb/lancedb's win32
//      native binding (run by the same exe under ELECTRON_RUN_AS_NODE=1,
//      exactly how main.cjs spawns the backend)
//   7. shutdown via the core CLI 'stop' protocol works and the backend
//      process actually exits
//   8. after backend loss the GUI stays tray-resident by design (main.cjs
//      keeps the app alive; it surfaces a reconnect dialog) without crashing
//
// Isolation (R2-hardened via release-preflight-5025-env.cjs): NOTHING is
// inherited from this shell's environment except an explicit system-variable
// allow-list — ambient provider credentials (ANTHROPIC_AUTH_TOKEN, OPENAI_*,
// ... — the exact vars the bundled Workbench reads) never reach the candidate
// processes. HOME/APPDATA/LOCALAPPDATA/TEMP/TMP/TMPDIR, PS module-analysis
// cache, CODEX_HOME, CLAUDE_CONFIG_DIR, Workbench data, Bridge home, both KB
// data dirs, npm/electron caches and the Chromium user-data-dir
// (--user-data-dir switch) all live under one run directory
// (KB_PREFLIGHT_ISO_ROOT overrides the root; default is the OS temp dir). The
// installed desktop, its 5757/5760 instances and real user profiles are never
// touched. taskkill is only ever aimed at PIDs this tool spawned.
//
// Audited exception: only the REAL GUI browser processes keep the original
// USERPROFILE (Electron 43.1.1 CHECK-fails otherwise, before any JS — see
// evidence/verify/env-userprofile-crash-bisect.log); they still boot with
// --user-data-dir into the run dir. ELECTRON_RUN_AS_NODE children (backend
// probe, CLI stop) use the fully isolated USERPROFILE. The exception is NOT
// generalized to drivers/SDKs/Chrome/modules.

const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const asarLib = require('./release-preflight-5025-asar.cjs');
const envLib = require('./release-preflight-5025-env.cjs');
const localModules = require('./release-preflight-5025-local-modules.cjs');

const desktopRoot = path.resolve(__dirname, '..');
const NATIVE_PROBE_SOURCE = `'use strict';
const path = require('node:path');
const { createRequire } = require('node:module');
const asarDir = process.argv[2];
const req = createRequire(path.join(asarDir, 'app.asar', 'node_modules', '@sanqianx', 'project-knowledge', 'package.json'));
const corePkg = req('@sanqianx/project-knowledge/package.json');
console.log('CORE_VERSION ' + corePkg.version);
const arrow = req('apache-arrow');
console.log('APACHE_ARROW_LOAD ' + (typeof arrow.Table === 'function'));
const lancedb = req('@lancedb/lancedb');
console.log('LANCEDB_LOAD ' + (typeof lancedb.connect === 'function'));
console.log('PROBE_PASS');
`;

// R3: prove the packaged Workbench quota feature actually LOADS from inside
// app.asar (ELECTRON_RUN_AS_NODE, same exe, same as the backend would).
const WB_QUOTA_PROBE_SOURCE = `'use strict';
const path = require('node:path');
const { createRequire } = require('node:module');
const asarDir = process.argv[2];
const req = createRequire(path.join(asarDir, 'app.asar', 'node_modules', 'claude-ai-workbench', 'package.json'));
const wbPkg = req('./package.json');
console.log('WB_VERSION ' + wbPkg.version);
const quota = req('./packages/server/lib/profile-quota.js');
const keys = Object.keys(quota || {});
console.log('WB_QUOTA_LOAD ' + (quota && keys.length > 0));
console.log('WB_QUOTA_EXPORTS ' + keys.join(','));
console.log('PROBE_PASS');
`;

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

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
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

async function httpGet(url, timeoutMs = 10000) {
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
  const result = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { encoding: 'utf8' });
  return result.status === 0;
}

async function main() {
  const args = process.argv.slice(2);
  const flagValue = (flag) => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const bundleDir = path.resolve(flagValue('--bundle') || process.env.KB_DESKTOP_BUNDLE
    || path.join(desktopRoot, 'out', '.release-preflight-5025-stage', 'app', 'out', 'Project Knowledge-win32-x64'));
  const coreTarball = flagValue('--core-tarball');
  const wbTarball = flagValue('--wb-tarball');
  const bridgeTarball = flagValue('--bridge-tarball');
  const expectEngineVersion = flagValue('--expect-engine-version');
  const desktopPkg = require(path.join(desktopRoot, 'package.json'));
  const expectedCoreVersion = flagValue('--expect-core-version') || desktopPkg.dependencies['@sanqianx/project-knowledge'];
  const exePath = path.join(bundleDir, 'Project Knowledge.exe');
  const resourcesDir = path.join(bundleDir, 'resources');
  if (!fs.existsSync(exePath)) throw new Error(`bundle exe not found: ${exePath}`);

  const isoRoot = process.env.KB_PREFLIGHT_ISO_ROOT || path.join(os.tmpdir(), 'release-preflight-5025-packaged-verify');
  const runDir = path.join(isoRoot, `verify-${process.pid}-${Date.now()}`);
  const dirs = {
    data: path.join(runDir, 'data'),
    knowledge: path.join(runDir, 'knowledge'),
    home: path.join(runDir, 'home'),
    appdata: path.join(runDir, 'appdata'),
    localappdata: path.join(runDir, 'localappdata'),
    temp: path.join(runDir, 'temp'),
    userData: path.join(runDir, 'electron-user-data'),
  };
  for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true });

  const sitePort = await freePort();
  // Hardened environments (R2): allow-list inheritance only. guiEnv keeps the
  // original USERPROFILE for the Electron 43 GUI browser process (audited
  // exception — it CHECK-fails otherwise) and MUST be paired with
  // --user-data-dir so Chromium still writes inside runDir. nodeEnv is for
  // ELECTRON_RUN_AS_NODE children and isolates USERPROFILE like everything
  // else. The sentinel assertions fail closed before anything is spawned.
  const kbOverrides = {
    KB_MODULES_REGISTER: '0',
    KB_MODULES_AUTOSTART: '0',
    KB_EMBEDDING_FAKE: '1',
    KB_AUTOMATION_FAKE_CLAUDE: '1',
    KB_SITE_HOST: '127.0.0.1',
    KB_SITE_PORT: String(sitePort),
  };
  const envDirs = {
    home: dirs.home,
    appdata: dirs.appdata,
    localappdata: dirs.localappdata,
    temp: dirs.temp,
    psCache: path.join(runDir, 'ps-module-cache', 'ModuleAnalysisCache'),
    codex: path.join(runDir, 'codex'),
    claude: path.join(runDir, 'claude'),
    workbench: path.join(runDir, 'workbench'),
    bridge: path.join(runDir, 'bridge'),
    data: dirs.data,
    knowledge: dirs.knowledge,
    npmCache: path.join(runDir, 'npm-cache'),
    electronCache: path.join(runDir, 'electron-cache'),
  };
  const guiEnv = envLib.buildIsolatedEnv({
    sourceEnv: process.env, runDir, dirs: envDirs, gui: true,
    extra: { ...kbOverrides, ELECTRON_RUN_AS_NODE: undefined },
  });
  const nodeEnv = envLib.buildIsolatedEnv({
    sourceEnv: process.env, runDir, dirs: envDirs, gui: false,
    extra: { ...kbOverrides, ELECTRON_RUN_AS_NODE: '1' },
  });
  envLib.assertEnvContract(guiEnv, runDir, { gui: true, originalUserProfile: process.env.USERPROFILE });
  envLib.assertEnvContract(nodeEnv, runDir, { gui: false });

  const guiLogFd = fs.openSync(path.join(runDir, 'gui.log'), 'a');
  const results = [];
  const record = (id, passed, detail) => {
    results.push({ id, passed, detail });
    console.log(`${passed ? 'PASS' : 'FAIL'} ${id}${detail ? ` — ${detail}` : ''}`);
  };

  let gui;
  const endpointPath = path.join(dirs.data, 'runtime-endpoint.json');
  try {
    // 1. GUI launch. --user-data-dir is load-bearing: Electron resolves
    // appData via the Windows Shell known-folder API and IGNORES the APPDATA
    // env var, so without this switch the packaged app's Chromium userData
    // (caches, Crashpad, single-instance lock) would land in the REAL profile
    // — and while an installed desktop is running, its single-instance lock
    // makes this exe quit with exit 0 before booting anything.
    const guiArgs = [`--user-data-dir=${dirs.userData}`];
    gui = spawn(exePath, guiArgs, { cwd: bundleDir, env: guiEnv, detached: false, stdio: ['ignore', guiLogFd, guiLogFd] });
    const guiExit = new Promise((resolve) => gui.on('exit', (code) => resolve(code)));
    record('exe-launched', true, `pid ${gui.pid}`);

    // 2. backend endpoint published in desktop mode
    const endpoint = await waitFor(() => {
      if (!fs.existsSync(endpointPath)) return null;
      const parsed = JSON.parse(fs.readFileSync(endpointPath, 'utf8'));
      return parsed && parsed.host && parsed.port ? parsed : null;
    }, 120000, 'runtime-endpoint.json');
    record('endpoint-mode', endpoint.mode === 'desktop', `mode=${endpoint.mode} port=${endpoint.port}`);
    const baseUrl = `http://${endpoint.host === '::1' ? '[::1]' : endpoint.host}:${endpoint.port}`;

    // 3. /api/state serves
    const state = await httpGet(`${baseUrl}/api/state`);
    const stateJson = JSON.parse(state.body.toString('utf8'));
    record('api-state', state.status === 200 && stateJson.schema === 'server-state/v2', `http ${state.status} schema ${stateJson.schema}`);

    // 4. core version identity (negative-control hook lives here)
    const identity = await httpGet(`${baseUrl}/api/runtime/identity`);
    const identityJson = JSON.parse(identity.body.toString('utf8'));
    record('core-version',
      identity.status === 200 && identityJson.version === expectedCoreVersion,
      `reported ${identityJson.version} expected ${expectedCoreVersion}`);

    // 5. served UI matches asar bytes
    const asarPath = path.join(resourcesDir, 'app.asar');
    const asar = asarLib.readHeader(asarPath);
    const packedProductJs = asarLib.extractFile(asarPath, asar, 'node_modules/@sanqianx/project-knowledge/ui/product.js');
    const index = await httpGet(`${baseUrl}/`);
    const product = await httpGet(`${baseUrl}/product.js`);
    const servedMatches = product.status === 200 && sha256(product.body) === sha256(packedProductJs);
    record('served-ui', index.status === 200 && servedMatches,
      `/ http ${index.status}; product.js sha256 ${sha256(product.body).slice(0, 16)} vs asar ${sha256(packedProductJs).slice(0, 16)}`);

    // 5b. R3 candidate mode (--core-tarball --wb-tarball --bridge-tarball,
    // all three together): the packaged core/WB/Bridge must BE the provided
    // tarballs byte for byte (strict set equality), exactly one copy of each
    // anywhere in the asar, the WB quota-17 audited sources present, the
    // Bridge Windows path fix markers present, a NEW vendored engine whose
    // vendor-manifest hashes match the asar bytes, and the UI version tooltip
    // markers present. Version strings alone prove nothing. These are LOCAL
    // pre-publish candidates (none of the three is on the registry yet) —
    // NOT official npm acceptance; the FINAL official installer is rebuilt
    // from registry artifacts and re-verified against the registry bytes.
    if (coreTarball || wbTarball || bridgeTarball) {
      const { mods } = localModules.resolveCandidates({ coreTarball, wbTarball, bridgeTarball });
      const moduleAudit = localModules.auditLocalModules({
        asarPath,
        env: nodeEnv,
        extractRoot: path.join(runDir, 'local-modules-audit'),
        mods,
        expectEngineVersion,
      });
      const coreDetail = moduleAudit.details.core;
      const summarized = mods.map((m) => `${m.id}@${(moduleAudit.details[m.id] || {}).version || '?'}/${(moduleAudit.details[m.id] || {}).checked || 0}f`).join(' ');
      record('local-modules-byte-contract',
        moduleAudit.failures.length === 0 && coreDetail && coreDetail.version === expectedCoreVersion,
        `${summarized}; expected core ${expectedCoreVersion}`
          + (moduleAudit.failures.length ? `; first failures: ${moduleAudit.failures.slice(0, 5).join(' | ')}` : ''));

      // WB quota feature must actually LOAD from the packaged asar (same exe
      // in ELECTRON_RUN_AS_NODE mode, exactly how the backend runs modules).
      if (mods.some((m) => m.id === 'wb')) {
        const wbProbeScript = path.join(runDir, 'wb-quota-probe.cjs');
        fs.writeFileSync(wbProbeScript, WB_QUOTA_PROBE_SOURCE);
        const wbProbe = spawnSync(exePath, [wbProbeScript, resourcesDir], {
          cwd: bundleDir,
          env: nodeEnv,
          encoding: 'utf8',
          timeout: 120000,
        });
        const wbOut = `${wbProbe.stdout || ''}${wbProbe.stderr || ''}`.trim();
        record('wb-quota-load',
          wbProbe.status === 0 && wbOut.includes('PROBE_PASS') && wbOut.includes('WB_QUOTA_LOAD true'),
          `exit ${wbProbe.status}: ${wbOut.split('\n').filter((l) => l.startsWith('WB_')).join(' | ').slice(0, 300)}`);
      }
    }

    // 6. second instance yields to the first (same user-data-dir → same lock)
    const second = spawn(exePath, guiArgs, { cwd: bundleDir, env: guiEnv, detached: false, stdio: ['ignore', 'ignore', 'ignore'] });
    const secondExit = await Promise.race([
      new Promise((resolve) => second.on('exit', (code) => resolve(code))),
      new Promise((resolve) => setTimeout(() => resolve('still-running-after-20s'), 20000)),
    ]);
    if (typeof secondExit !== 'number') taskkillTree(second.pid);
    const firstStillAlive = gui.exitCode === null && !gui.killed;
    record('second-instance-yields',
      typeof secondExit === 'number' && firstStillAlive,
      `second exit=${secondExit} first alive=${firstStillAlive}`);

    // 7. native runtime probe through the same exe in backend mode
    const probeScript = path.join(runDir, 'native-probe.cjs');
    fs.writeFileSync(probeScript, NATIVE_PROBE_SOURCE);
    const probe = spawnSync(exePath, [probeScript, resourcesDir], {
      cwd: bundleDir,
      env: nodeEnv,
      encoding: 'utf8',
      timeout: 120000,
    });
    const probeOut = `${probe.stdout || ''}${probe.stderr || ''}`.trim();
    record('native-runtime', probe.status === 0 && probeOut.includes('PROBE_PASS'),
      `exit ${probe.status}: ${probeOut.split('\n').filter((l) => !l.startsWith('Debug Filters')).join(' | ')}`);

    // 8. stop via core CLI protocol
    const coreCli = path.join(resourcesDir, 'app.asar', 'node_modules', '@sanqianx', 'project-knowledge', 'bin', 'project-knowledge.js');
    const stop = spawnSync(exePath, [coreCli, 'stop'], {
      cwd: bundleDir,
      env: nodeEnv,
      encoding: 'utf8',
      timeout: 60000,
    });
    const backendGone = await waitFor(() => {
      if (process.platform === 'win32') {
        const alive = spawnSync('tasklist', ['/FI', `PID eq ${endpoint.pid}`, '/NH'], { encoding: 'utf8' });
        return !alive.stdout.includes(String(endpoint.pid));
      }
      try { process.kill(endpoint.pid, 0); return false; } catch { return true; }
    }, 30000, 'backend process exit');
    record('cli-stop', stop.status === 0 && backendGone, `stop exit ${stop.status} backend-exited ${backendGone}`);

    // 9. GUI lifecycle after backend loss: main.cjs keeps the app resident in
    // the tray by design ("Tray keeps the app alive; knowledge maintenance
    // continues") and surfaces a reconnect dialog — it must neither crash nor
    // exit non-zero. The verify then terminates the process it spawned.
    await new Promise((resolve) => setTimeout(resolve, 5000));
    const guiAliveAfterBackendLoss = gui.exitCode === null && !gui.killed;
    record('gui-survives-backend-loss', guiAliveAfterBackendLoss,
      guiAliveAfterBackendLoss ? `alive pid ${gui.pid} (tray-resident by design)` : `gui exited ${gui.exitCode}`);
    const killed = taskkillTree(gui.pid);
    const guiFinal = await guiExit;
    record('gui-cleanup', killed, `terminated pid ${gui.pid} (exit ${guiFinal})`);
  } catch (error) {
    record('unexpected', false, error.message);
    if (gui && gui.exitCode === null) taskkillTree(gui.pid);
  } finally {
    fs.closeSync(guiLogFd);
  }

  const report = {
    schema: 'release-preflight-5025-packaged-verify/v1',
    bundle: bundleDir,
    expectedCoreVersion,
    moduleTarballs: (coreTarball || wbTarball || bridgeTarball)
      ? {
        source: 'LOCAL pre-publish tarballs (unpublished on npm) — NOT official npm acceptance',
        core: coreTarball ? path.resolve(coreTarball) : null,
        wb: wbTarball ? path.resolve(wbTarball) : null,
        bridge: bridgeTarball ? path.resolve(bridgeTarball) : null,
        expectEngineVersion: expectEngineVersion || null,
      }
      : null,
    runDir,
    results,
    passed: results.every((r) => r.passed),
  };
  fs.writeFileSync(path.join(runDir, 'verify-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ passed: report.passed, runDir }));
  process.exit(report.passed ? 0 : 1);
}

main().catch((error) => {
  console.error(error && error.stack || error);
  process.exit(1);
});
