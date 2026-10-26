'use strict';
// desktop/test/release-browser-5025-smoke.cjs
//
// P-BROWSER-RELEASE-SMOKE-R14: reusable BROWSER-ONLY acceptance tool for the
// exact core+WB+Bridge candidate TGZ trio. Unlike the frozen desktop/Electron
// lane (release-preflight-5025-thin-smoke-r5.cjs, read-only reference) this
// tool runs the ACTUAL core package CLI `start --fg --no-open --port <own>` in
// own data dirs and reserved ports and drives the real web UI through the
// audited headless CDP browser helper — no Electron, no desktop TGZ.
//
//   node desktop/test/release-browser-5025-smoke.cjs \
//     --core-tarball <core.tgz> --wb-tarball <wb.tgz> --bridge-tarball <bridge.tgz> \
//     --owned-cache <BASE/sources/core/node_modules> --output-root <dir> \
//     [--expect-engine-version <v>] [--provenance <label>]
//
// --provenance is a LABEL ONLY (e.g. local-prepublish-candidate or
// official-next-download): the tool never contacts any registry/provider; the
// only network requests it makes are to the 127.0.0.1 services it spawned.
// Reuses read-only: release-preflight-5025-{env,core-tarball,local-modules}.cjs
// and the audited _site/_test/helpers/{cdp-browser,find-chrome}.js.

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const envLib = require('./release-preflight-5025-env.cjs');
const coreTarballLib = require('./release-preflight-5025-core-tarball.cjs');
const localModules = require('./release-preflight-5025-local-modules.cjs');
const quotaPins = require('./release-browser-5025-quota-pins.cjs');
const { launchCdpBrowser } = require('../../_site/_test/helpers/cdp-browser');
const { findChromeDetailed } = require('../../_site/_test/helpers/find-chrome');

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

function protectedPortSnapshot() {
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

// Junction-mix the owned cache into a FRESH node_modules, bypassing the three
// candidate slots and dot-entries: the stale shared-cache core is never
// junctioned, and no owned-cache byte is ever written through the junctions.
function buildMixNodeModules(nmDir, cacheRoot) {
  const skipTop = new Set([
    'claude-ai-workbench',
    '@sanqianx/project-knowledge',
    '@sanqianx/ai-coding-event-bridge-console',
  ]);
  fs.mkdirSync(nmDir, { recursive: true });
  const skipped = [];
  for (const ent of fs.readdirSync(cacheRoot, { withFileTypes: true })) {
    if (skipTop.has(ent.name) || ent.name.startsWith('.')) { skipped.push(ent.name); continue; }
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

const QUOTA_PROBE = "(() => { const f = document.getElementById('workFrame'); const out = { hasFrame: !!f, frameRect: null, frameRectNonZero: false, ancestorChainVisible: false, workViewActive: false, onScreen: false, hitTest: false, docLoaded: false, settingsActive: false, settingsChainVisible: false, providersActive: false, heading: '', headingVisible: false, providerListChildren: -1 }; if (!f) return out; const r = f.getBoundingClientRect(); out.frameRect = { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; out.frameRectNonZero = r.width >= 50 && r.height >= 50; let chain = true; for (let n = f; n && n.nodeType === 1; n = n.parentElement) { const cs = getComputedStyle(n); if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) <= 0.05) chain = false; const nr = n.getBoundingClientRect(); if (n !== document.documentElement && n !== document.body && (nr.width <= 0 || nr.height <= 0)) chain = false; } out.ancestorChainVisible = chain; const vw = document.getElementById('view-work'); out.workViewActive = !!(vw && vw.classList.contains('active')); const ix0 = Math.max(r.left, 0), iy0 = Math.max(r.top, 0), ix1 = Math.min(r.right, window.innerWidth), iy1 = Math.min(r.bottom, window.innerHeight); const inter = Math.max(0, ix1 - ix0) * Math.max(0, iy1 - iy0); out.onScreen = inter >= 0.5 * r.width * r.height; const cx = ix0 + (ix1 - ix0) / 2, cy = iy0 + (iy1 - iy0) / 2; const hit = document.elementFromPoint(cx, cy); out.hitTest = !!(hit && (hit === f || f.contains(hit))); let doc = null; try { doc = f.contentDocument; } catch (e) {} if (doc) { out.docLoaded = doc.readyState === 'complete'; const vs = doc.getElementById('view-settings'); out.settingsActive = !!(vs && vs.classList.contains('active') && !vs.inert); let sChain = true; if (vs) { for (let n = vs; n && n.nodeType === 1; n = n.parentElement) { const cs = doc.defaultView.getComputedStyle(n); if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) <= 0.05) sChain = false; } } out.settingsChainVisible = sChain; const panel = doc.getElementById('s-providers'); out.providersActive = !!(panel && panel.classList.contains('active')); const h2 = panel ? panel.querySelector('h2') : null; out.heading = h2 ? h2.textContent.trim() : ''; if (h2) { const hr = h2.getBoundingClientRect(); const dw = doc.documentElement.clientWidth, dh = doc.documentElement.clientHeight; out.headingVisible = hr.width > 0 && hr.height > 0 && hr.top >= 0 && hr.left >= 0 && hr.bottom <= dh && hr.right <= dw; } const list = doc.getElementById('provider-list'); out.providerListChildren = list ? list.children.length : -1; } return out; })()";
const TOOLTIP_STATE = "(() => { const el = document.getElementById('brandVersion'); const cs = getComputedStyle(el); return { text: el.textContent, opacity: cs.opacity, tabindex: el.getAttribute('tabindex') }; })()";

async function main() {
  const args = process.argv.slice(2);
  const flagValue = (flag) => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const coreTarball = flagValue('--core-tarball');
  const wbTarball = flagValue('--wb-tarball');
  const bridgeTarball = flagValue('--bridge-tarball');
  const ownedCache = flagValue('--owned-cache');
  const outputRoot = flagValue('--output-root');
  const expectEngineVersion = flagValue('--expect-engine-version');
  const provenance = flagValue('--provenance') || 'unspecified';
  const usage = 'usage: node desktop/test/release-browser-5025-smoke.cjs --core-tarball <t> --wb-tarball <t> --bridge-tarball <t> --owned-cache <dir> --output-root <dir> [--expect-engine-version <v>] [--provenance <label>]';
  for (const [flag, value] of [['--core-tarball', coreTarball], ['--wb-tarball', wbTarball],
    ['--bridge-tarball', bridgeTarball], ['--owned-cache', ownedCache]]) {
    if (!value || !fs.existsSync(value)) throw new Error(`${flag} missing or not found: ${value}\n${usage}`);
  }
  if (!outputRoot) throw new Error(`--output-root missing\n${usage}`);

  const repoRoot = path.resolve(__dirname, '..', '..');
  const outRoot = path.resolve(outputRoot);
  const relOut = path.relative(repoRoot, outRoot);
  if (!relOut || (!relOut.startsWith('..') && !path.isAbsolute(relOut))) {
    throw new Error(`--output-root must be outside the source repository: ${outRoot}`);
  }
  fs.mkdirSync(outRoot, { recursive: true });
  const runRoot = fs.mkdtempSync(path.join(outRoot, 'pkr14-'));

  // Browser selection (R22), from the REAL env BEFORE the driver hardens
  // itself; only the absolute path string is carried forward. On Windows
  // prefer the known machine Edge the Leader proved serves DevTools under the
  // FULLY isolated env with every home owned (edge-isolated-probe-url.json
  // ok:true guiException:false); an explicit KB_CHROME_PATH still wins;
  // otherwise the normal finder. No GUI exception anywhere in this tool.
  const MACHINE_EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  let chromeInfo;
  if (process.env.KB_CHROME_PATH) chromeInfo = { path: path.resolve(process.env.KB_CHROME_PATH), source: 'KB_CHROME_PATH' };
  else if (process.platform === 'win32' && fs.existsSync(MACHINE_EDGE)) chromeInfo = { path: MACHINE_EDGE, source: 'machine-edge-r22-leader-proven' };
  else chromeInfo = findChromeDetailed();
  const ambient = envLib.hardenProcessEnv(runRoot, { gui: false });
  const envDirs = envLib.defaultDirs(runRoot);

  const results = [];
  const record = (id, passed, detail) => {
    results.push({ id, passed, detail });
    console.log(`${passed ? 'PASS' : 'FAIL'} ${id}${detail ? ` — ${detail}` : ''}`);
  };
  const census = { spawned: [], killed: [] };

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
    ...moduleUrls,
  };
  const nodeEnv = envLib.buildIsolatedEnv({
    sourceEnv: ambient, runDir: runRoot, dirs: envDirs, gui: false, extra: kbOverrides,
  });
  envLib.assertEnvContract(nodeEnv, runRoot, { gui: false });

  // R22: NO GUI exception anywhere. The native browser child gets the SAME
  // fully-isolated nodeEnv as every other child (USERPROFILE/HOME/APPDATA/
  // LOCALAPPDATA/TEMP all owned), passed only via launchCdpBrowser({ env }) —
  // process.env is never touched. The driver hardens itself the same way.
  const browserProfileDir = path.join(runRoot, 'browser');
  record('browser-env-fully-isolated',
    path.resolve(nodeEnv.USERPROFILE) === path.resolve(envDirs.home)
      && path.resolve(nodeEnv.HOME) === path.resolve(envDirs.home)
      && path.resolve(nodeEnv.APPDATA) === path.resolve(envDirs.appdata)
      && path.resolve(nodeEnv.LOCALAPPDATA) === path.resolve(envDirs.localappdata)
      && path.resolve(process.env.USERPROFILE || '') === path.resolve(envDirs.home),
    `driver AND native browser child (${chromeInfo.source} ${chromeInfo.path}) share the fully-isolated env: USERPROFILE/HOME/APPDATA/LOCALAPPDATA/TEMP all owned, envLib contract asserted, NO GUI exception; own empty profile ${browserProfileDir}`);

  // 1. resolve + hash the candidate trio (stale/mismatch rejected here)
  const { mods, byId } = localModules.resolveCandidates({ coreTarball, wbTarball, bridgeTarball });
  const inputHashes = { provenance };
  for (const [k, f] of [['coreTarball', coreTarball], ['wbTarball', wbTarball], ['bridgeTarball', bridgeTarball]]) {
    inputHashes[k] = { path: path.resolve(f), sha256: sha256(fs.readFileSync(f)), bytes: fs.statSync(f).size };
  }
  const toolHashes = {};
  for (const t of ['release-preflight-5025-env.cjs', 'release-preflight-5025-core-tarball.cjs',
    'release-preflight-5025-local-modules.cjs', 'release-browser-5025-smoke.cjs']) {
    toolHashes[t] = sha256(fs.readFileSync(path.join(__dirname, t)));
  }
  for (const h of ['cdp-browser.js', 'find-chrome.js']) {
    toolHashes[h] = sha256(fs.readFileSync(path.join(__dirname, '..', '..', '_site', '_test', 'helpers', h)));
  }
  const cacheCorePkg = path.join(ownedCache, '@sanqianx', 'project-knowledge', 'package.json');
  const staleCacheCoreVersion = JSON.parse(fs.readFileSync(cacheCorePkg, 'utf8')).version;
  const cacheJunctionPath = path.join(path.dirname(path.resolve(ownedCache)), 'desktop', 'node_modules');
  const cacheJunctionBefore = fs.existsSync(cacheJunctionPath) ? fs.readlinkSync(cacheJunctionPath) : null;
  record('inputs-resolved', true,
    `trio ${mods.map((m) => `${m.id}@${m.version}`).join(' ')}; provenance label ${JSON.stringify(provenance)} (label only — no registry contact); owned-cache stale core copy ${staleCacheCoreVersion}`);

  // 2. exact extractions + offline content contracts on the exact bytes
  const extractRoot = path.join(runRoot, 'extract');
  const coreDir = extractTgz(coreTarball, path.join(extractRoot, 'core'), nodeEnv);
  const wbDir = extractTgz(wbTarball, path.join(extractRoot, 'wb'), nodeEnv);
  const bridgeDir = extractTgz(bridgeTarball, path.join(extractRoot, 'bridge'), nodeEnv);

  // Workbench quota pin re-base. The reviewed pin tables live in
  // release-browser-5025-quota-pins.cjs: the R20 0.13.8 re-base (ONLY 3 of
  // the 17 audited quota files re-pinned — source of truth
  // qa-autopilot/.runtime/leader-20261023/wb-0138-package-files.json, the
  // 125-file review of that exact tarball; r17-leader-review.json
  // wb125HashesMatched=true) and the R42 0.13.9 table (the 0.13.8 table plus
  // ONLY packages/ui/ai-profile-settings.js, the R33/R33B quota patch
  // 928c1bb, shipped in the official 0.13.9 artifact and proven identical to
  // the installed official package by the R36 review). Everything else keeps
  // the frozen 0.13.7-era baseline (shipped pins, notShipped, versionDoc), and
  // any WB version other than 0.13.8/0.13.9 keeps the frozen baseline
  // untouched — strict 17/17 both ways, never a skip and never derived from
  // the candidate-under-test.
  const wbQuotaTable = quotaPins.selectWbQuotaTable(byId.wb.version);
  const quota = localModules.auditWbQuota(byId.wb, path.join(extractRoot, 'wb'), wbQuotaTable);
  record('wb-quota17-content', quota.failures.length === 0,
    `pin table ${quotaPins.describeWbQuotaTable(byId.wb.version)} for wb@${byId.wb.version}; `
    + `audited ${quota.detail.audited}, matched ${quota.detail.matched}, versionDocs ${quota.detail.versionDocs}`
    + (quota.failures.length ? `; failures: ${quota.failures.slice(0, 3).join(' | ')}` : ''));

  const bridgeText = fs.readFileSync(path.join(bridgeDir, localModules.BRIDGE_FIX_MARKERS.file), 'utf8');
  record('bridge-path-fix-markers', localModules.BRIDGE_FIX_MARKERS.substrings.every((s) => bridgeText.includes(s)),
    `${localModules.BRIDGE_FIX_MARKERS.substrings.join(' + ')} present in ${localModules.BRIDGE_FIX_MARKERS.file}`);

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
    `${terminal.name}@${terminal.version} ai-profile-settings-host ${quotaAppFiles.length} files hash-verified against the WB extraction`);

  // 3. junction-mix node_modules + exact candidate slots (no desktop wrapper)
  const appRoot = path.join(runRoot, 'app');
  const nmDir = path.join(appRoot, 'node_modules');
  const skippedCacheEntries = buildMixNodeModules(nmDir, path.resolve(ownedCache));
  fs.mkdirSync(path.join(nmDir, '@sanqianx'), { recursive: true });
  fs.renameSync(coreDir, path.join(nmDir, '@sanqianx', 'project-knowledge'));
  fs.renameSync(wbDir, path.join(nmDir, 'claude-ai-workbench'));
  fs.renameSync(bridgeDir, path.join(nmDir, '@sanqianx', 'ai-coding-event-bridge-console'));
  const coreSlot = path.join(nmDir, '@sanqianx', 'project-knowledge');
  const mixCoreVersion = JSON.parse(fs.readFileSync(path.join(coreSlot, 'package.json'), 'utf8')).version;
  const bypassedSlots = ['claude-ai-workbench', '@sanqianx/project-knowledge', '@sanqianx/ai-coding-event-bridge-console'];
  record('candidate-slots-exact',
    mixCoreVersion === byId.core.version && bypassedSlots.every((slot) => skippedCacheEntries.includes(slot)),
    `mix core ${mixCoreVersion} from the exact TGZ; all three cache slots bypassed (owned-cache stale core ${staleCacheCoreVersion} never junctioned); skipped cache entries: ${skippedCacheEntries.length}`);

  const vectorManifestSpec = runtimeManifest.modules.vectorHub;
  const vectorCacheVersion = JSON.parse(fs.readFileSync(path.join(nmDir, '@sanqianx', 'vector-hub', 'package.json'), 'utf8')).version;
  record('vectorhub-version-pinned', vectorCacheVersion === vectorManifestSpec.version,
    `owned-cache @sanqianx/vector-hub ${vectorCacheVersion} === candidate module-runtime-manifest ${vectorManifestSpec.version} (native Lance/vector deps reused read-only via junction)`);

  // 4. the actual core CLI under Node: bin resolved from the candidate itself
  const corePkgJson = JSON.parse(fs.readFileSync(path.join(coreSlot, 'package.json'), 'utf8'));
  const binSpec = corePkgJson.bin && (typeof corePkgJson.bin === 'string'
    ? corePkgJson.bin : (corePkgJson.bin[corePkgJson.name] || Object.values(corePkgJson.bin)[0]));
  if (!binSpec) throw new Error('core candidate exposes no bin');
  const coreBin = path.join(coreSlot, binSpec);

  // synthetic own source project (canonical import fixture shape)
  const ownProject = path.join(runRoot, 'ownproject');
  fs.mkdirSync(ownProject, { recursive: true });
  fs.writeFileSync(path.join(ownProject, 'hello.py'), 'print("r14 synthetic project")\n');
  const ownKnowledge = path.join(runRoot, 'ownknowledge');
  fs.mkdirSync(ownKnowledge, { recursive: true });
  const gitIn = (gitArgs) => spawnSync('git', gitArgs, { cwd: ownProject, encoding: 'utf8', windowsHide: true, timeout: 60000 });
  gitIn(['init', '-q', '-b', 'main']);
  gitIn(['config', 'user.email', 'r14-ownproject@local.invalid']);
  gitIn(['config', 'user.name', 'R14 Own Project']);
  gitIn(['config', 'commit.gpgsign', 'false']);
  gitIn(['add', '.']);
  const ownCommit = gitIn(['commit', '-qm', 'r14 own project baseline']);

  const protectedBefore = protectedPortSnapshot();
  // FOREGROUND lifecycle (R16): the default daemon `start --no-open` spawns a
  // DETACHED --fg backend and exits 0, so the spawned parent pid owns nothing.
  // We drive the actual CLI foreground branch `start --fg --no-open --port`:
  // the child process IS the server + module supervisor (bin/project-knowledge.js
  // --fg branch), so pid ownership, graceful `stop --data`, and restart are all
  // real. FG acceptance is labeled; the default daemon mode is covered by the
  // existing CLI unit lane, not here.
  const spawnCli = (round) => {
    const logFd = fs.openSync(path.join(runRoot, `cli-${round}.log`), 'a');
    const child = spawn(process.execPath,
      [coreBin, 'start', '--fg', '--no-open', '--port', String(sitePort)], {
        cwd: appRoot, env: nodeEnv, detached: false, stdio: ['ignore', logFd, logFd],
      });
    census.spawned.push(child.pid);
    return { child, logFd };
  };
  // Bounded ASYNC child for `status`/`stop` invocations of the same candidate
  // CLI (the driver's event loop must keep serving waits). On timeout only THIS
  // own control child is killed — never the server.
  const runCliControl = (args, timeoutMs) => new Promise((resolve) => {
    const child = spawn(process.execPath, [coreBin, ...args], {
      cwd: appRoot, env: nodeEnv, detached: false, windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    census.spawned.push(child.pid);
    let out = '';
    let done = false;
    const finish = (code, killed) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, out, killed });
    };
    let timer = null;
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('error', (error) => { out += String(error); finish(null, false); });
    child.on('close', (code) => finish(code, false));
    timer = setTimeout(() => {
      taskkillTree(child.pid);
      census.killed.push(child.pid);
      finish(null, true);
    }, timeoutMs);
  });
  const readEndpoint = () => {
    try {
      return JSON.parse(fs.readFileSync(path.join(envDirs.data, 'runtime-endpoint.json'), 'utf8'));
    } catch { return null; }
  };
  // Graceful stop via the candidate's OWN `stop --data` (named-pipe control
  // channel with pid/port/startedAt identity match). Force kill is a FALLBACK
  // on our own verified pids only, always labeled honestly — never counted as
  // a graceful stop. Cleanup runs even when the round already failed.
  const gracefulStop = async (round, cli, modulePids, note) => {
    const stopRun = await runCliControl(['stop', '--data', envDirs.data], 90000);
    const stoppedPid = Number((/stopped \(PID (\d+)\)/.exec(stopRun.out) || [])[1]);
    const graceful = stopRun.code === 0 && !stopRun.killed && stoppedPid === cli.child.pid;
    let linger = [cli.child.pid, ...modulePids].filter((pid) => pid && pidAlive(pid));
    if (graceful && linger.length) {
      try {
        await waitFor(() => linger.every((pid) => !pidAlive(pid)) ? true : null, 30000, `round-${round} pids exit after graceful stop`);
        linger = [];
      } catch { linger = [cli.child.pid, ...modulePids].filter((pid) => pid && pidAlive(pid)); }
    }
    let forced = [];
    if (linger.length) {
      forced = [...linger];
      for (const pid of linger) taskkillTree(pid);
      census.killed.push(...linger);
      linger = [cli.child.pid, ...modulePids].filter((pid) => pid && pidAlive(pid));
    }
    record(`cli-stop-graceful-r${round}`,
      graceful && forced.length === 0 && linger.length === 0,
    `candidate CLI stop --data exit ${stopRun.code}${stopRun.killed ? ' (CONTROL CHILD TIMED OUT and was killed)' : ''}: ${JSON.stringify(stopRun.out.trim().slice(0, 300))}; graceful=${graceful} (stopped PID ${stoppedPid || 'unparsed'} === FG child ${cli.child.pid}); module/backend pids exited=${linger.length === 0}${forced.length ? `; FORCE-KILL FALLBACK on own pids ${forced.join(', ')} (NOT graceful, reported as fallback)` : ''}${note ? `; ${note}` : ''}`);
    fs.closeSync(cli.logFd);
  };
  const baseUrl = `http://127.0.0.1:${sitePort}`;

  // 5. round 1: start -> status (identity/health/process proofs) -> UI -> stop
  const roundMarker = path.join(envDirs.data, 'r14-round1-marker.txt');
  const knowledgeMarker = path.join(envDirs.knowledge, 'r14-round1-marker.txt');
  const cli1 = spawnCli(1);
  let moduleProcesses = [];
  let quotaUiLive = null;
  let browserEvidence = null;
  let importedProjectId = null;
  let fatalRound1 = null;
  try {
    const state = await waitFor(async () => {
      try {
        const response = await httpGet(`${baseUrl}/api/state`, 5000);
        return response.status === 200 ? response : null;
      } catch { return null; }
    }, 180000, 'core CLI state endpoint accepting connections');
    const stateJson = JSON.parse(state.body.toString('utf8'));
    const endpoint1 = await waitFor(readEndpoint, 30000, 'runtime-endpoint.json (round 1)');
    const siteListenerPid = listenerPid(sitePort);
    record('cli-started-own-port',
      state.status === 200 && stateJson.schema === 'server-state/v2'
        && endpoint1.pid === cli1.child.pid && siteListenerPid === cli1.child.pid
        && endpoint1.port === sitePort,
    `FG child pid ${cli1.child.pid} IS the server: /api/state http ${state.status} schema ${stateJson.schema}, netstat 127.0.0.1:${sitePort} listener pid ${siteListenerPid}, runtime-endpoint.json pid ${endpoint1.pid} port ${endpoint1.port} mode ${JSON.stringify(endpoint1.mode)} — all belong to the spawned child, no detached parent illusion`);
    fs.writeFileSync(roundMarker, `round1 cli pid ${cli1.child.pid}\n`);
    fs.writeFileSync(knowledgeMarker, `round1 knowledge ${new Date().toISOString()}\n`);

    const identity = await httpGet(`${baseUrl}/api/runtime/identity`);
    const identityJson = JSON.parse(identity.body.toString('utf8'));
    record('core-version-identity', identity.status === 200 && identityJson.version === byId.core.version,
      `reported ${identityJson.version} expected ${byId.core.version} (served by the actual candidate extraction)`);

    // real `status --data` invocation of the same candidate CLI (bounded async
    // child): the control channel must answer OUR pid/port, proving the
    // recorded endpoint belongs to the spawned FG child.
    const statusRun = await runCliControl(['status', '--data', envDirs.data], 15000);
    const statusPid = Number((/\(PID (\d+)\)/.exec(statusRun.out) || [])[1]);
    const statusPort = Number((/:\/\/127\.0\.0\.1:(\d+)/.exec(statusRun.out) || [])[1]);
    record('cli-status-own-pid',
      statusRun.code === 0 && !statusRun.killed && statusPid === cli1.child.pid && statusPort === sitePort,
    `candidate CLI status --data exit ${statusRun.code}: ${JSON.stringify(statusRun.out.trim())} — reported PID ${statusPid || 'unparsed'} port ${statusPort || 'unparsed'} === FG child ${cli1.child.pid} on ${sitePort}`);

    const mixProductJs = fs.readFileSync(path.join(coreSlot, 'ui', 'product.js'));
    const index = await httpGet(`${baseUrl}/`);
    const product = await httpGet(`${baseUrl}/product.js`);
    const versionInfo = await httpGet(`${baseUrl}/version-info.js`);
    record('served-ui-bytes-and-tooltip', product.status === 200
      && sha256(product.body) === sha256(mixProductJs)
      && index.status === 200 && index.body.toString('utf8').includes('brandVersion')
      && versionInfo.status === 200 && versionInfo.body.toString('utf8').includes('知识库 v'),
    `/ http ${index.status}, product.js sha256 match=${sha256(product.body) === sha256(mixProductJs)}, tooltip markers live in served bytes`);

    const healthJson = await waitFor(async () => {
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
      k, expected: expectedUrlOf[k], actual: healthJson.modules[k].url, up: healthJson.modules[k].up,
      ok: String(healthJson.modules[k].url).replace(/\/+$/, '') === expectedUrlOf[k],
    }));
    record('modules-health-own-urls', healthJson.ok === true && urlMatches.every((m) => m.ok && m.up),
      `health ok=${healthJson.ok}; ${urlMatches.map((m) => `${m.k} url=${m.actual} up=${m.up} match=${m.ok}`).join('; ')}`);

    const terminalHealth = await httpGet(`${moduleUrls.KB_TERMINAL_URL}/api/claude-workbench/v1/health`);
    const terminalJson = JSON.parse(terminalHealth.body.toString('utf8'));
    record('module-terminal-live-version',
      terminalHealth.status === 200 && terminalJson.status === 'ok' && terminalJson.version === byId.wb.version,
      `WB /api/claude-workbench/v1/health http ${terminalHealth.status}: version=${terminalJson.version} (expected ${byId.wb.version})`);

    const engineHealth = await httpGet(`${moduleUrls.KB_KNOWLEDGE_ENGINE_URL}/api/health`);
    const engineJson = JSON.parse(engineHealth.body.toString('utf8'));
    const engineDataOwned = String(engineJson.dataDir || '').toLowerCase().startsWith(runRoot.toLowerCase());
    record('module-engine-live-version',
      engineHealth.status === 200 && engineJson.name === 'knowledge-engine' && engineJson.version === engine.version && engineDataOwned,
      `engine /api/health http ${engineHealth.status}: name=${engineJson.name} version=${engineJson.version} (expected ${engine.version}) dataDir owned=${engineDataOwned}`);

    const vectorHealth = await httpGet(`${moduleUrls.KB_VECTORHUB_URL}/api/health`);
    const vectorJson = JSON.parse(vectorHealth.body.toString('utf8'));
    record('module-vectorhub-live-health',
      vectorHealth.status === 200 && vectorJson.ok === true && Array.isArray(vectorJson.projects),
      `vector-hub /api/health http ${vectorHealth.status}: ok=${vectorJson.ok}; NO version field — version proven via the running entry/process proof below (${vectorManifestSpec.version})`);

    const bridgeHealth = await httpGet(`${moduleUrls.KB_EVENTBRIDGE_URL}/api/health`);
    const bridgeJson = JSON.parse(bridgeHealth.body.toString('utf8'));
    const bridgeHomeOwned = String(bridgeJson.home || '').toLowerCase().startsWith(runRoot.toLowerCase());
    record('module-bridge-live-health',
      bridgeHealth.status === 200 && bridgeJson.ok === true && typeof bridgeJson.registeredProjects === 'number' && bridgeHomeOwned,
      `bridge /api/health http ${bridgeHealth.status}: ok=${bridgeJson.ok} home owned=${bridgeHomeOwned}; NO version field — version proven via entry/process proof below`);

    // per-module process/entry/hash proof: netstat pid -> cmdline -> entry
    // resolved the SAME way the candidate supervisor resolves it (createRequire
    // from the core package) -> sha256 vs the candidate's own manifests.
    const coreRequire = require('node:module').createRequire(path.join(coreSlot, 'package.json'));
    const resolveEntry = (id, fallbackAbs) => {
      try { return coreRequire.resolve(id); } catch { /* engine is a path check */ }
      return fs.existsSync(fallbackAbs) ? fallbackAbs : null;
    };
    const engineSlot = path.join(coreSlot, '_modules', 'knowledge-engine');
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
        return found && found !== cli1.child.pid ? found : null;
      }, 60000, `listener pid for ${key}`);
      census.spawned.push(pid);
      const cmdline = processCmdline(pid);
      const realSlot = fs.realpathSync(spec.slot);
      const rel = path.relative(realSlot, spec.entryAbs).split(path.sep).join('/');
      const entryInCmdline = cmdline.toLowerCase().includes(rel.toLowerCase())
        || cmdline.toLowerCase().includes(spec.entryAbs.toLowerCase());
      const entryHash = sha256(fs.readFileSync(spec.entryAbs));
      const manifestHash = spec.manifestFiles[rel];
      const cmdlineLower = cmdline.toLowerCase();
      const underMix = cmdlineLower.includes(appRoot.toLowerCase());
      const underOwnedCache = cmdlineLower.includes(path.resolve(ownedCache).toLowerCase());
      moduleProcesses.push({
        module: key, pid, port: portOfModule[key], version: spec.version,
        entry: spec.entryAbs, entryRel: rel, entrySha256: entryHash,
        manifestSha256: manifestHash || 'not-listed-in-manifest',
        entryRoot: underMix ? 'candidate-extraction' : (underOwnedCache ? 'owned-cache-junction' : 'other'),
        entryInCmdline,
      });
      record(`module-process-${key}`,
        entryInCmdline && (underMix || underOwnedCache) && (manifestHash ? entryHash === manifestHash : true),
      `pid ${pid} on 127.0.0.1:${portOfModule[key]}; entry ${rel} in cmdline=${entryInCmdline}, served from ${underMix ? 'the candidate extraction' : (underOwnedCache ? `the owned-cache junction (hash ${manifestHash ? '=== manifest' : 'entry not individually listed'})` : 'an UNEXPECTED root')}; entry sha256 ${entryHash.slice(0, 12)}… ${manifestHash ? `=== module manifest sha256 (${spec.version})` : `(module version ${spec.version} verified via manifest+package files)`}`);
    }

    // quota management UI served LIVE by the actual WB via the product proxy
    const wbExtractionRoot = path.join(nmDir, 'claude-ai-workbench');
    quotaUiLive = [];
    for (const name of ['index.html', 'page.css', 'page.js']) {
      const local = path.join(wbExtractionRoot, 'apps', 'ai-profile-settings-host', name);
      const localSha256 = sha256(fs.readFileSync(local));
      const served = await httpGet(`${baseUrl}/modules/terminal/profile-settings/${name}`);
      quotaUiLive.push({ name, status: served.status, bytesMatch: served.status === 200 && sha256(served.body) === localSha256 });
    }
    record('quota-management-ui-live', quotaUiLive.every((r) => r.bytesMatch),
      `served by the REAL WB ${byId.wb.version} via product proxy /modules/terminal/profile-settings/: ${quotaUiLive.map((r) => `${r.name} http ${r.status} bytes-match=${r.bytesMatch}`).join(', ')}`);

    const versionResp = await httpGet(`${baseUrl}/api/system/version`);
    let versionBody = null;
    try { versionBody = JSON.parse(versionResp.body.toString('utf8')); } catch {}
    const actualVersion = versionBody && versionBody.core && versionBody.core.version || null;
    record('browser-version-endpoint-actual', versionResp.status === 200 && actualVersion === byId.core.version,
      `GET /api/system/version http ${versionResp.status} -> core.version ${JSON.stringify(actualVersion)}; candidate core ${byId.core.version}`);

    // synthetic project through the REAL product API (setup fixture only)
    const brainRoot = path.join(runRoot, 'brainroot');
    const seedResp = await fetch(`${baseUrl}/api/settings`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ knowledge: { rootPath: brainRoot } }),
    });
    const importResp = await fetch(`${baseUrl}/api/projects/import`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ localPath: ownProject, knowledgePath: ownKnowledge, displayName: 'R14 Own Project' }),
    });
    let importBody = null;
    try { importBody = JSON.parse(await importResp.text()); } catch {}
    importedProjectId = importBody && importBody.projectId || null;
    record('own-project-imported-api',
      seedResp.status === 200 && importResp.status === 201 && !!importedProjectId && ownCommit.status === 0,
      `git fixture (commit exit ${ownCommit.status}) + PATCH /api/settings + POST /api/projects/import -> http ${importResp.status} projectId=${JSON.stringify(importedProjectId)} (API setup fixture, not the import-dialog UI case)`);

    // 6. the real web UI through the audited headless CDP browser
    fs.mkdirSync(browserProfileDir, { recursive: true });
    const profileEmptyBefore = fs.readdirSync(browserProfileDir).length === 0;
    browserEvidence = {
      chrome: chromeInfo, pageUrl: `${baseUrl}/`, screenshots: [], quota: null,
      envIsolation: {
        scope: 'native browser child runs under the SAME fully-isolated nodeEnv (no GUI exception)',
        ownedHome: envDirs.home, ownedAppdata: envDirs.appdata, ownedLocalappdata: envDirs.localappdata,
        ownProfileDir: browserProfileDir, profileEmptyBefore,
      },
    };
    let browser = null;
    try {
      browser = await launchCdpBrowser({
        chrome: chromeInfo.path, profileDir: browserProfileDir,
        url: `${baseUrl}/`, width: 1360, height: 900, env: nodeEnv,
      });
      const evaluate = (expr) => browser.evaluate(expr);
      const mouse = (type, x, y, extra = {}) => browser.send('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' ? 'none' : 'left', pointerType: 'mouse', clicks: 1, ...extra });
      const shot = async (name) => {
        try {
          const p = path.join(runRoot, name);
          await browser.screenshot(p);
          browserEvidence.screenshots.push(p);
          return p;
        } catch { return null; }
      };
      await browser.send('Page.bringToFront').catch(() => {});
      await browser.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });

      const pageFacts = await evaluate("(() => ({ title: document.title, brand: (document.querySelector('.brand strong') || {}).textContent || '', hasBrandVersion: !!document.getElementById('brandVersion') }))()");
      record('browser-page-smoke',
        pageFacts.title === 'Project Knowledge · 我的智脑' && pageFacts.brand === 'Project Knowledge' && pageFacts.hasBrandVersion
          && profileEmptyBefore && fs.existsSync(path.join(browserProfileDir, 'DevToolsActivePort')),
      `real page: title ${JSON.stringify(pageFacts.title)}, brand ${JSON.stringify(pageFacts.brand)}, #brandVersion present=${pageFacts.hasBrandVersion}; `
        + `the browser served its own DevToolsActivePort from the empty own profile ${browserProfileDir} (profile empty before launch=${profileEmptyBefore}, fully isolated env — no GUI exception)`);

      const away = await evaluate("(() => { const b = document.querySelector('.brand').getBoundingClientRect(); const p = { x: Math.round(Math.min(b.right + 160, innerWidth - 8)), y: Math.round(b.top + 24) }; const hit = document.elementFromPoint(p.x, p.y); return Object.assign(p, { outsideBrand: !(hit && hit.closest('.brand')) }); })()");
      if (away && away.outsideBrand) {
        await mouse('mouseMoved', away.x, away.y);
        await waitFor(async () => Number((await evaluate(TOOLTIP_STATE)).opacity) === 0 ? true : null, 2000, 'pointer parked away').catch(() => null);
      }
      const state0 = await evaluate(TOOLTIP_STATE);
      const settledState = await waitFor(async () => {
        const s = await evaluate(TOOLTIP_STATE);
        return s.text === `知识库 v${actualVersion}` ? s : null;
      }, 8000, `tooltip text 知识库 v${actualVersion}`).catch(() => null);
      record('browser-version-tooltip-text', !!settledState,
        `the page's OWN fetch filled #brandVersion: ${JSON.stringify(settledState && settledState.text)} from /api/system/version ${JSON.stringify(actualVersion)} (failure state would read 知识库 版本未知)`);

      const center = await evaluate("(() => { const r = document.querySelector('.brand').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + Math.min(r.height / 2, 24)) }; })()");
      await mouse('mouseMoved', center.x, center.y);
      const hoverState = await waitFor(async () => {
        const s = await evaluate(TOOLTIP_STATE);
        return Number(s.opacity) === 1 ? s : null;
      }, 4000, 'tooltip visible on real hover').catch(() => null);
      await shot('browser-tooltip-hover.png');
      await mouse('mouseMoved', away.x, away.y);
      const hiddenAfter = await waitFor(async () => {
        const s = await evaluate(TOOLTIP_STATE);
        return Number(s.opacity) === 0 ? s : null;
      }, 4000, 'tooltip hidden after move-away').catch(() => null);
      await evaluate("document.getElementById('brandVersion').focus()");
      const focusShown = await waitFor(async () => {
        const s = await evaluate("(() => { const el = document.getElementById('brandVersion'); return { active: document.activeElement === el, opacity: getComputedStyle(el).opacity }; })()");
        return s.active && Number(s.opacity) === 1 ? s : null;
      }, 4000, 'tooltip visible on focus').catch(() => null);
      await evaluate("document.getElementById('brandVersion').blur()");
      const blurHidden = await waitFor(async () =>
        Number(await evaluate("(() => Number(getComputedStyle(document.getElementById('brandVersion')).opacity))()")) === 0 ? true : null, 4000, 'tooltip hidden after blur').catch(() => null);
      record('browser-brand-hover-focus',
        Number(state0.opacity) === 0 && !!hoverState && !!hiddenAfter && !!focusShown && !!blurHidden && away.outsideBrand,
      `real CDP input: hover opacity 0 -> ${hoverState ? hoverState.opacity : 'never shown'} (text ${JSON.stringify(hoverState && hoverState.text)}) -> move-away 0; focus ${focusShown ? 'shown' : 'never'} -> blur hidden ${!!blurHidden}; screenshot browser-tooltip-hover.png`);

      // real input helper: mouse first, keyboard Space fallback
      const realInput = async (sel, condExpr, label, ms = 4000) => {
        const selJson = JSON.stringify(sel);
        const pt = await evaluate(`(() => { const el = document.querySelector(${selJson}); if (!el) return null; const r = el.getBoundingClientRect(); if (r.width <= 0 || r.height <= 0) return null; return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`).catch(() => null);
        if (!pt) return { path: 'element-missing-or-invisible', activated: false };
        await mouse('mouseMoved', pt.x, pt.y);
        await mouse('mousePressed', pt.x, pt.y);
        await mouse('mouseReleased', pt.x, pt.y);
        if (await waitFor(async () => (await evaluate(condExpr)) ? true : null, Math.min(ms, 3000), `${label} (mouse)`).catch(() => null)) return { path: 'cdp-mouse-click', activated: true };
        await evaluate(`(() => { const el = document.querySelector(${selJson}); if (el) el.focus(); })()`);
        await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ' ', code: 'Space', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 });
        await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 });
        if (await waitFor(async () => (await evaluate(condExpr)) ? true : null, ms, `${label} (keyboard)`).catch(() => null)) return { path: 'cdp-keyboard-space', activated: true };
        return { path: 'failed', activated: false };
      };

      const selState = () => evaluate("(() => { const s = document.getElementById('projectSelect'); if (!s) return { missing: true }; let opt = null; for (let i = 0; i < s.options.length; i++) if (s.options[i].value === s.value) opt = s.options[i]; return { disabled: s.disabled, optionCount: s.options.length, value: s.value, label: opt ? opt.textContent.trim() : '' }; })()");
      const selExpr = (s) => s && !s.missing && !s.disabled && s.value === importedProjectId ? s : null;
      let selection = await waitFor(async () => selExpr(await selState()), 8000, 'imported project visible+selected (registry SSE)').catch(() => null);
      let selectionPath = 'registry-sse-auto-refresh';
      if (!selection) {
        selectionPath = 'cdp-page-reload (honest fallback: registry SSE did not surface the selection)';
        await browser.send('Page.reload');
        await waitFor(() => evaluate("document.readyState === 'complete'"), 15000, 'page load after reload');
        selection = await waitFor(async () => selExpr(await selState()), 15000, 'imported project visible+selected after reload').catch(() => null);
      }
      record('browser-project-selection-visible', !!selection,
        `the API-imported own project is VISIBLE and SELECTED: #projectSelect disabled=${selection ? selection.disabled : 'n/a'} options=${selection ? selection.optionCount : 0} selected=${JSON.stringify(selection && selection.value)} label=${JSON.stringify(selection && selection.label)} (${selectionPath})`);

      const workView = await realInput("button[data-view='work']",
        "(() => { const v = document.getElementById('view-work'); const empty = document.getElementById('workEmpty'); const layout = document.getElementById('workLayout'); return !!(v && v.classList.contains('active') && empty && empty.hidden && layout && !layout.hidden); })()",
        'StartWork view');
      const drawerOpen = await realInput('#openSystem',
        "(() => { const d = document.getElementById('systemDrawer'); return !!(d && !d.hidden); })()", 'system drawer');

      const quotaReady = (s) => !!(s && s.hasFrame && s.frameRectNonZero && s.ancestorChainVisible && s.workViewActive
        && s.onScreen && s.hitTest && s.docLoaded && s.settingsActive && s.settingsChainVisible && s.providersActive);
      let quotaState = null;
      let activation = 'not-attempted';
      if (drawerOpen.activated) {
        const btnPt = await evaluate("(() => { const el = document.querySelector('#configureProviders'); if (!el) return null; const r = el.getBoundingClientRect(); if (r.width <= 0 || r.height <= 0) return null; return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()").catch(() => null);
        if (btnPt) {
          activation = 'cdp-mouse-click';
          await mouse('mouseMoved', btnPt.x, btnPt.y);
          await mouse('mousePressed', btnPt.x, btnPt.y);
          await mouse('mouseReleased', btnPt.x, btnPt.y);
          quotaState = await waitFor(async () => { const s = await evaluate(QUOTA_PROBE); return quotaReady(s) ? s : null; }, 3000, 'visible providers panel (mouse)').catch(() => null);
          if (!quotaState) {
            activation = 'cdp-keyboard-space';
            await evaluate("(() => { const el = document.querySelector('#configureProviders'); if (el) el.focus(); })()");
            await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ' ', code: 'Space', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 });
            await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 });
            quotaState = await waitFor(async () => { const s = await evaluate(QUOTA_PROBE); return quotaReady(s) ? s : null; }, 20000, 'visible providers panel (keyboard)').catch(() => null);
          }
        }
      }
      const quotaShot = await shot('browser-quota-ui.png');
      const stagedFail = quotaState ? null : await evaluate(QUOTA_PROBE).catch(() => null);
      const failBits = stagedFail ? ['hasFrame', 'frameRectNonZero', 'ancestorChainVisible', 'workViewActive', 'onScreen', 'hitTest', 'docLoaded', 'settingsActive', 'settingsChainVisible', 'providersActive'].filter((k) => !stagedFail[k]) : [];
      browserEvidence.quota = quotaState
        ? { opened: true, visibleProof: true, selectionPath, workViewActivation: workView.path, drawerActivation: drawerOpen.path, activation, ...quotaState }
        : { opened: false, visibleProof: false, selectionPath, workViewActivation: workView.path, drawerActivation: drawerOpen.path, activation, staged: stagedFail, failedBits: failBits };
      record('browser-quota-ui-live',
        !!(quotaState && quotaState.providersActive && quotaState.heading === '模型供应商' && quotaState.headingVisible),
      `real input (${workView.path}) entered StartWork with the project selected, (${drawerOpen.path}) opened the drawer, (${activation}) opened model management; the WB ${byId.wb.version} providers panel REALLY VISIBLE in the agent-terminal iframe: frameRect=${quotaState ? JSON.stringify(quotaState.frameRect) : 'n/a'} ancestors=${quotaState ? quotaState.ancestorChainVisible : false} onScreen=${quotaState ? quotaState.onScreen : false} hitTest=${quotaState ? quotaState.hitTest : false} heading=${JSON.stringify(quotaState && quotaState.heading)} headingVisible=${quotaState ? quotaState.headingVisible : false} (empty owned profile — honest empty state; no provider refresh, no quota API, no model calls); screenshot while visible: ${quotaShot || 'n/a'}${quotaState ? '' : `; failed: ${failBits.join(',')}`}`);

      record('browser-no-uncaught-exceptions', browser.exceptions.length === 0,
        `uncaught page exceptions: ${browser.exceptions.length}${browser.exceptions.length ? ` (${JSON.stringify(browser.exceptions[0].exceptionDetails || browser.exceptions[0]).slice(0, 200)})` : ''}`);
    } catch (error) {
      record('browser-ui-verification', false, error.message);
    } finally {
      // close the browser handle on EVERY path (assert/hover/quota/screenshot
      // failures included) so no orphan headless Chrome outlives the run
      if (browser) { try { await browser.close(); } catch {} }
    }
  } catch (error) {
    fatalRound1 = error;
    record('round-1-fatal', false, error.message);
  }
  // stop is mandatory on every path — graceful candidate `stop --data` first,
  // force-kill only as the labeled fallback on our own verified pids
  await gracefulStop(1, cli1, moduleProcesses.map((m) => m.pid),
    fatalRound1 ? `round 1 already failed: ${fatalRound1.message}` : null);
  const round1TeardownOk = results.find((r) => r.id === 'cli-stop-graceful-r1')?.passed === true;
  await new Promise((resolve) => setTimeout(resolve, 3000));

  // 7. round 2: restart on the SAME data dirs/ports — everything preserved
  const round1Ok = results.every((r) => r.passed);
  let relaunchOk = false;
  let relaunchDetail = 'skipped (round 1 failed)';
  if (round1Ok) {
    const cli2 = spawnCli(2);
    let fatalRound2 = null;
    let round2ModulePids = [];
    try {
      const state2 = await waitFor(async () => {
        try {
          const response = await httpGet(`${baseUrl}/api/state`, 5000);
          return response.status === 200 ? response : null;
        } catch { return null; }
      }, 180000, 'round-2 state endpoint');
      const identity2 = JSON.parse((await httpGet(`${baseUrl}/api/runtime/identity`)).body.toString('utf8'));
      const endpoint2 = await waitFor(() => {
        const e = readEndpoint();
        return e && e.pid === cli2.child.pid ? e : null;
      }, 30000, `runtime-endpoint.json pid === fresh FG child ${cli2.child.pid} (round 2)`);
      const health2 = await waitFor(async () => {
        const response = await httpGet(`${baseUrl}/api/modules/health`);
        if (response.status !== 200) return null;
        const parsed = JSON.parse(response.body.toString('utf8'));
        return MODULE_KEYS.every((k) => parsed.modules && parsed.modules[k] && parsed.modules[k].up) ? parsed : null;
      }, 240000, 'all four modules up (round 2)');
      const health2UrlsOk = MODULE_KEYS.every((k) =>
        String(health2.modules[k].url).replace(/\/+$/, '') === ({
          terminal: moduleUrls.KB_TERMINAL_URL, vectorHub: moduleUrls.KB_VECTORHUB_URL,
          eventBridge: moduleUrls.KB_EVENTBRIDGE_URL, engine: moduleUrls.KB_KNOWLEDGE_ENGINE_URL,
        }[k]));
      relaunchOk = identity2.version === byId.core.version && health2UrlsOk
        && cli2.child.pid !== cli1.child.pid
        && endpoint2.pid === cli2.child.pid && endpoint2.port === sitePort
        && listenerPid(sitePort) === cli2.child.pid
        && fs.existsSync(roundMarker) && fs.existsSync(knowledgeMarker)
        && fs.existsSync(path.join(ownProject, 'hello.py'));
      relaunchDetail = `restart on the SAME dirs: identity ${identity2.version}, FRESH FG child pid ${cli2.child.pid} !== round-1 ${cli1.child.pid} with endpoint pid ${endpoint2.pid} port ${endpoint2.port} and the 127.0.0.1:${sitePort} listener belonging to it, four modules up again on the same own URLs=${health2UrlsOk}, data+knowledge markers and the synthetic project preserved, round-1 graceful stop=${round1TeardownOk}`;
      const modulePids2 = ['KB_TERMINAL_URL', 'KB_VECTORHUB_URL', 'KB_EVENTBRIDGE_URL', 'KB_KNOWLEDGE_ENGINE_URL']
        .map((key) => listenerPid(modulePortOf(key)))
        .filter((pid) => pid && pid !== cli2.child.pid);
      census.spawned.push(...modulePids2);
      round2ModulePids = modulePids2;
    } catch (error) {
      fatalRound2 = error;
      relaunchDetail = error.message;
    }
    await gracefulStop(2, cli2, round2ModulePids,
      fatalRound2 ? `round 2 already failed: ${fatalRound2.message}` : null);
    const stop2Ok = results.find((r) => r.id === 'cli-stop-graceful-r2')?.passed === true;
    relaunchOk = relaunchOk && stop2Ok;
    relaunchDetail += `; round-2 graceful stop=${stop2Ok}`;
  }
  record('stop-restart-same-data', relaunchOk, relaunchDetail);

  // 8. exact-ownership cleanup + protected ports + owned inputs untouched
  const lingering = [...new Set([...census.spawned, ...moduleProcesses.map((m) => m.pid)])]
    .filter((pid) => pid && pidAlive(pid));
  record('own-process-cleanup', lingering.length === 0,
    `spawned/observed ${[...new Set([...census.spawned, ...moduleProcesses.map((m) => m.pid)])].join(', ')}; killed trees ${census.killed.filter(Boolean).join(', ')}; lingering: ${lingering.length || 'none'}`);

  const protectedAfter = protectedPortSnapshot();
  record('protected-ports-untouched', JSON.stringify(protectedBefore) === JSON.stringify(protectedAfter),
    `listener sets on 5757/5760/8787/8790 identical before/after: ${JSON.stringify(protectedAfter)}`);

  const cacheCoreAfter = JSON.parse(fs.readFileSync(cacheCorePkg, 'utf8')).version;
  const junctionAfter = fs.existsSync(cacheJunctionPath) ? fs.readlinkSync(cacheJunctionPath) : null;
  record('owned-inputs-untouched',
    cacheCoreAfter === staleCacheCoreVersion && junctionAfter === cacheJunctionBefore,
  `owned cache core manifest still ${cacheCoreAfter} (stale copy intact, only READ); desktop/node_modules junction ${junctionAfter === cacheJunctionBefore ? 'unchanged' : 'CHANGED'}`);

  const report = {
    schema: 'release-browser-5025-smoke/v1',
    labeling: `BROWSER-ONLY acceptance of the exact TGZ trio (provenance label ${JSON.stringify(provenance)} — label only, no registry contact): FOREGROUND lifecycle — actual core CLI start --fg --no-open --port under plain Node on own data/port, so the spawned child IS the server+supervisor and spawns ALL FOUR REAL module processes; the same candidate CLI's real status --data / stop --data commands prove pid ownership and perform the graceful stop (force-kill only as a labeled fallback on own verified pids, never counted as graceful); default daemon start mode is covered by the existing CLI unit lane, not here; real web UI driven through the audited headless CDP browser helper (real input, no fabricated DOM/classes/toasts); vector-hub/bridge expose no version field — labeled honestly and proven via running entry-file hashes; empty owned profile — no provider refresh, no quota API, no model calls`,
    inputs: inputHashes,
    tools: toolHashes,
    ports: {
      site: sitePort,
      modules: moduleUrls,
      protected: PROTECTED_PORTS,
      protectedListenersBefore: protectedBefore,
      protectedListenersAfter: protectedAfter,
    },
    runRoot,
    appRoot,
    ownProject,
    moduleProcesses,
    quotaUiLive,
    browserEvidence,
    census,
    results,
    passed: results.every((r) => r.passed),
  };
  fs.writeFileSync(path.join(runRoot, 'browser-smoke-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ passed: report.passed, runRoot }));
  process.exit(report.passed ? 0 : 1);
}

// Guarded: importing this module (e.g. from the focused quota-pin test)
// must never boot a service, a browser or the CLI.
if (require.main === module) {
  main().catch((error) => {
    console.error(error && error.stack || error);
    process.exit(1);
  });
}
