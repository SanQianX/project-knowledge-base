'use strict';
// P-DESKTOP-ACTUAL-CANDIDATE-R4 thin-TGZ real GUI smoke.
//
// Proves the ACTUAL 5.0.25 candidate (thin desktop TGZ + core 5.0.25 TGZ +
// WB 0.13.7 TGZ + Bridge 0.7.3 TGZ, none on the registry) launches a real
// Electron GUI with a real backend — BEFORE the expensive Squirrel build —
// without any giant dependency copy and without mutating the Leader's owned
// cache:
//
//   runRoot/app/desktop          extracted thin desktop TGZ (actual bytes)
//   runRoot/app/desktop/node_modules  MIXED tree: per-package JUNCTIONS into
//                                the owned cache (read-only reuse, zero copy)
//                                EXCEPT the three candidate slots, which are
//                                exact TGZ extractions:
//                                  @sanqianx/project-knowledge  <- core tgz
//                                  claude-ai-workbench          <- WB tgz
//                                  @sanqianx/ai-coding-event-bridge-console <- bridge tgz
//   The owned cache keeps its OLD root core 5.0.24 copy — this smoke never
//   reads it for the core slot (no junction is created there at all) and
//   never writes into the cache. The cache + the Leader export are asserted
//   byte-identical (junction target, core manifest version) afterwards.
//
// Checks (all against the actual extracted candidate bytes):
//   1. offline content contracts: WB quota-17 (12 match / 1 version doc /
//      4 not shipped), Bridge Windows path-fix symbols, vendored engine
//      version + per-file sha256, UI tooltip markers, module-runtime-manifest
//      terminal app (ai-profile-settings-host — the quota management UI)
//      file hashes vs the WB extraction
//   2. native/module chain under the REAL electron.exe in ELECTRON_RUN_AS_NODE
//      mode: core resolves to the extraction, apache-arrow loads, lancedb
//      loads AND the win32-x64 native .node dlopens, WB profile-quota module
//      loads with exports, bridge module loads
//   3. real GUI launch -> runtime-endpoint.json (mode desktop) -> /api/state,
//      /api/runtime/identity 5.0.25, served UI byte-compare + tooltip markers
//      in the SERVED bytes, /api/modules/health with OWN module URLs
//   4. quit + relaunch on the SAME data dir (data preserved, second endpoint
//      published, identity still 5.0.25)
//
// Isolation: R2 whitelist env (release-preflight-5025-env.cjs), GUI-only
// USERPROFILE exception + --user-data-dir, KB_DATA_DIR and
// KB_KNOWLEDGE_DATA_DIR distinct under the run dir, own free ports for the
// site AND all four module URLs (defaults point at the protected real
// 5757/5760/8787/8790 services and are never used). Module servers are NOT
// started (KB_MODULES_AUTOSTART=0) — the quota management UI is proven at
// content + module-load level, exactly labeled, no claim of live module
// startup. No publish, no commit, no install; only PIDs this tool spawned
// are ever killed. The run dir is KEPT (candidate data preservation).
//
// Run:
//   node desktop/test/release-preflight-5025-thin-smoke.cjs \
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

async function httpGet(url, timeoutMs = 15000) {
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

// Extract <tgz> (bsdtar; 'package/' root) into <extractDir> and return the
// package dir path.
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

// Junction-mix node_modules: reuse every owned-cache package read-only via
// junctions (zero copy) except the candidate slots, which the caller fills
// with exact TGZ extractions. Returns the skipped entries for the report.
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
    if (ent.name.startsWith('.')) { skipped.push(ent.name); continue; } // .bin (unused: exe + CLI paths), .package-lock.json (stale 5.0.24 core map)
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

  const runDir = path.join(os.tmpdir(), `release-preflight-5025-thin-smoke-${process.pid}-${Date.now()}`);
  const dirs = {
    home: path.join(runDir, 'home'),
    appdata: path.join(runDir, 'appdata'),
    localappdata: path.join(runDir, 'localappdata'),
    temp: path.join(runDir, 'temp'),
    userData: path.join(runDir, 'electron-user-data'),
    data: path.join(runDir, 'data'),
    knowledge: path.join(runDir, 'knowledge'),
  };
  const envDirs = {
    home: dirs.home, appdata: dirs.appdata, localappdata: dirs.localappdata, temp: dirs.temp,
    psCache: path.join(runDir, 'ps-module-cache', 'ModuleAnalysisCache'),
    codex: path.join(runDir, 'codex'), claude: path.join(runDir, 'claude'),
    workbench: path.join(runDir, 'workbench'), bridge: path.join(runDir, 'bridge'),
    data: dirs.data, knowledge: dirs.knowledge,
    npmCache: path.join(runDir, 'npm-cache'), electronCache: path.join(runDir, 'electron-cache'),
  };
  const envBuild = envLib.buildIsolatedEnv({ sourceEnv: process.env, runDir, dirs: envDirs, gui: false });

  const results = [];
  const record = (id, passed, detail) => {
    results.push({ id, passed, detail });
    console.log(`${passed ? 'PASS' : 'FAIL'} ${id}${detail ? ` — ${detail}` : ''}`);
  };
  const census = { spawned: [], killed: [] };

  const sitePort = await freePort();
  const modulePorts = {
    KB_TERMINAL_URL: await freePort(),
    KB_VECTORHUB_URL: await freePort(),
    KB_EVENTBRIDGE_URL: await freePort(),
    KB_KNOWLEDGE_ENGINE_URL: await freePort(),
  };
  const allPorts = [sitePort, ...Object.values(modulePorts).map((u) => Number(u))];
  if (allPorts.some((p) => PROTECTED_PORTS.includes(p))) {
    throw new Error(`reserved port collides with a protected port: ${allPorts}`);
  }
  const kbOverrides = {
    KB_MODULES_REGISTER: '0',
    KB_MODULES_AUTOSTART: '0',
    KB_EMBEDDING_FAKE: '1',
    KB_AUTOMATION_FAKE_CLAUDE: '1',
    KB_SITE_HOST: '127.0.0.1',
    KB_SITE_PORT: String(sitePort),
    KB_DATA_DIR_DESKTOP: dirs.data,
    ...modulePorts,
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

  // 1. resolve the real candidate trio + desktop manifest cross-check
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
  const cacheCorePkg = path.join(ownedCache, '@sanqianx', 'project-knowledge', 'package.json');
  const staleCacheCoreVersion = JSON.parse(fs.readFileSync(cacheCorePkg, 'utf8')).version;
  const cacheJunctionBefore = fs.readlinkSync(path.join(path.dirname(ownedCache), 'desktop', 'node_modules'));

  // 2. exact extractions (single extraction per tarball; audits run on them,
  //    then the package dir is MOVED into the mix tree)
  const extractRoot = path.join(runDir, 'extract');
  const coreDir = extractTgz(coreTarball, path.join(extractRoot, 'core'), envBuild);
  const wbDir = extractTgz(wbTarball, path.join(extractRoot, 'wb'), envBuild);
  const bridgeDir = extractTgz(bridgeTarball, path.join(extractRoot, 'bridge'), envBuild);
  const desktopDir = path.join(runDir, 'app', 'desktop');
  const desktopExtract = extractTgz(desktopTgz, path.join(runDir, 'app', 'desktop-extract'), envBuild);
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

  // quota management UI content: the core's own module-runtime-manifest hashes
  // the WB module's terminal app (ai-profile-settings-host) — verify those
  // hashes against the WB extraction (product-native contract, no stand-ins).
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

  const electronExe = path.join(ownedCache, 'electron', 'dist', 'electron.exe');
  if (!fs.existsSync(electronExe)) throw new Error(`owned cache electron exe missing: ${electronExe}`);

  // 5. native/module chain probe under the REAL electron exe (RUN_AS_NODE)
  const probeScript = path.join(runDir, 'chain-probe.cjs');
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

  // 6. GUI round 1 -> endpoint -> HTTP contract
  const endpointPath = path.join(dirs.data, 'runtime-endpoint.json');
  const guiLogFd = fs.openSync(path.join(runDir, 'gui.log'), 'a');
  const launchGui = () => {
    const child = spawn(electronExe, [`--user-data-dir=${dirs.userData}`, desktopDir], {
      cwd: desktopDir, env: guiEnv, detached: false, stdio: ['ignore', guiLogFd, guiLogFd],
    });
    census.spawned.push(child.pid);
    return child;
  };
  const roundMarker = path.join(dirs.data, 'r4-round1-marker.txt');
  let gui = launchGui();
  let endpoint;
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

    const baseUrl = `http://${endpoint.host === '::1' ? '[::1]' : endpoint.host}:${endpoint.port}`;
    const state = await httpGet(`${baseUrl}/api/state`);
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
    `/ http ${index.status}, product.js sha256 match=${sha256(product.body) === sha256(mixProductJs)}, tooltip markers live in served bytes (brandVersion + 知识库 v)`);

    const modulesHealth = await httpGet(`${baseUrl}/api/modules/health`);
    record('modules-health-own-urls', modulesHealth.status === 200,
      `http ${modulesHealth.status}; module servers intentionally NOT started (KB_MODULES_AUTOSTART=0), all four module URLs pinned to own reserved ports ${JSON.stringify(Object.values(modulePorts))} — never the protected 5757/5760/8787/8790`);
  } catch (error) {
    record('gui-round-1', false, error.message);
  }

  // 7. teardown round 1 ALWAYS (kill own tree first, then verify the backend
  // of the endpoint we observed is gone) — the cleanup census below must
  // never observe a live process, whatever happened above.
  const killed1 = taskkillTree(gui.pid);
  census.killed.push(gui.pid, endpoint ? endpoint.pid : 0);
  let backendGone = true;
  if (endpoint) {
    backendGone = await waitFor(() => !pidAlive(endpoint.pid), 30000, 'round-1 backend exit');
  }
  await new Promise((resolve) => setTimeout(resolve, 3000));
  fs.rmSync(endpointPath, { force: true }); // stale endpoint of the killed tree; a fresh instance republishes

  const round1Ok = results.every((r) => r.passed);
  let relaunchOk = false;
  let relaunchDetail = 'skipped (round 1 failed)';
  if (round1Ok) {
    const gui2 = launchGui();
    let endpoint2 = null;
    try {
      endpoint2 = await waitFor(() => {
        if (!fs.existsSync(endpointPath)) return null;
        const parsed = JSON.parse(fs.readFileSync(endpointPath, 'utf8'));
        return parsed && parsed.host && parsed.port && parsed.pid !== endpoint.pid ? parsed : null;
      }, 180000, 'runtime-endpoint.json (round 2)');
      census.spawned.push(endpoint2.pid);
      const baseUrl2 = `http://${endpoint2.host === '::1' ? '[::1]' : endpoint2.host}:${endpoint2.port}`;
      const state2 = await httpGet(`${baseUrl2}/api/state`);
      const identity2 = await httpGet(`${baseUrl2}/api/runtime/identity`);
      const identity2Json = JSON.parse(identity2.body.toString('utf8'));
      relaunchOk = endpoint2.port === sitePort && state2.status === 200
        && identity2.status === 200 && identity2Json.version === byId.core.version
        && fs.existsSync(roundMarker);
      relaunchDetail = `relaunch endpoint pid ${endpoint2.pid} port ${endpoint2.port}, identity ${identity2Json.version}, data preserved (${path.basename(roundMarker)} present), round-1 kill clean=${killed1 && backendGone}`;
    } catch (error) {
      relaunchDetail = error.message;
    } finally {
      const killed2 = taskkillTree(gui2.pid);
      census.killed.push(gui2.pid, endpoint2 ? endpoint2.pid : 0);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    record('quit-relaunch-same-data', relaunchOk, relaunchDetail);
  }

  // 8. ownership cleanup + input preservation
  const lingering = census.spawned.filter((pid) => pid && pidAlive(pid));
  record('own-process-cleanup', lingering.length === 0,
    `spawned ${census.spawned.join(', ')}; killed trees ${census.killed.filter(Boolean).join(', ')}; lingering: ${lingering.length || 'none'}`);

  const cacheCoreAfter = JSON.parse(fs.readFileSync(cacheCorePkg, 'utf8')).version;
  const cacheJunctionAfter = fs.readlinkSync(path.join(path.dirname(ownedCache), 'desktop', 'node_modules'));
  record('owned-inputs-untouched',
    cacheCoreAfter === staleCacheCoreVersion && cacheJunctionAfter === cacheJunctionBefore,
  `owned cache core manifest still ${cacheCoreAfter} (stale 5.0.24 copy intact, only READ); desktop/node_modules junction target unchanged`);

  fs.closeSync(guiLogFd);
  const backendLog = path.join(dirs.data, 'desktop-backend.log');
  const report = {
    schema: 'release-preflight-5025-thin-smoke/v1',
    labeling: 'REAL 5.0.25 candidate bytes (exact TGZ extractions + owned-cache junction reuse); module servers NOT started — quota management UI proven at content + module-load level, not live module startup',
    inputs: inputHashes,
    ownedCache: {
      path: path.resolve(ownedCache),
      staleCoreCopyVersion: staleCacheCoreVersion,
      junctionTarget: cacheJunctionBefore,
      electronExe,
      skippedInMix: skippedCacheEntries,
    },
    ports: { site: sitePort, modules: modulePorts, protected: PROTECTED_PORTS },
    runDir,
    desktopDir,
    backendLog: fs.existsSync(backendLog) ? { path: backendLog, bytes: fs.statSync(backendLog).size } : null,
    guiLog: path.join(runDir, 'gui.log'),
    results,
    passed: results.every((r) => r.passed),
  };
  fs.writeFileSync(path.join(runDir, 'thin-smoke-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ passed: report.passed, runDir }));
  process.exit(report.passed ? 0 : 1);
}

main().catch((error) => {
  console.error(error && error.stack || error);
  process.exit(1);
});
