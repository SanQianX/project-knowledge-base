#!/usr/bin/env node
'use strict';
// P-DOCK-ISOLATION-R3 launcher.
//
// It runs BEFORE any product / terminal / Chrome / SDK process exists and it
// performs the whole environment contract of this lane:
//
//   1. Chrome's executable is resolved first (that discovery reads the real
//      %LOCALAPPDATA%);
//   2. the real subscription profile is read READ-ONLY from the installed
//      workbench store - only the definition leaves this process, the secret
//      is handed to the server process through a pipe;
//   3. one isolated layout is created outside the repository, with an owner
//      marker;
//   4. the terminal module is started inside the isolated environment, with
//      the credential overlay preloaded from the pipe;
//   5. the PROBE itself is re-executed with the same isolated environment, so
//      every child it starts (product, Chrome, the SDK) inherits the
//      isolation instead of the developer's shell;
//   6. afterwards the whole layout is searched for the real secret: a single
//      hit would mean the credential reached a file.
//
// Usage:
//   node parallel-dock-isolation-r3-launch.js --probe <probe.js> [--tag t]
//        [--profile minimax] [--artifacts <dir>]

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');

const PKB_ROOT = path.resolve(__dirname, '..', '..', '..');
const HELPERS = path.join(PKB_ROOT, '_site', '_test', 'helpers');
const fixture = require(path.join(HELPERS, 'parallel-dock-isolation-r3-fixture.js'));
const { findChromeDetailed } = require(path.join(HELPERS, 'find-chrome.js'));

const MODULE_API_PREFIX = '/api/claude-workbench/v1';
const TOTAL_BUDGET_MS = Number(process.env.R3_DOCK_BUDGET_MS || 25 * 60 * 1000);

function parseArgs(argv) {
  const args = { probe: null, tag: 'dock-isolation-r3', profile: 'minimax', artifacts: path.join(PKB_ROOT, 'qa-autopilot', 'artifacts', 'parallel-20261023', 'dock-isolation-r3') };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === '--probe') { args.probe = argv[++i]; continue; }
    if (value === '--tag') { args.tag = argv[++i]; continue; }
    if (value === '--profile') { args.profile = argv[++i]; continue; }
    if (value === '--artifacts') { args.artifacts = argv[++i]; continue; }
    if (value === '--no-credential') { args.profile = null; continue; }
    throw new Error(`unknown argument: ${value}`);
  }
  if (!args.probe) throw new Error('--probe <probe.js> is required');
  return args;
}

function httpJson(url, { method = 'GET', body, timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const request = http.request(url, { method, headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {} }, response => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { text += chunk; });
      response.on('end', () => {
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch { data = null; }
        resolve({ status: response.statusCode, data, text });
      });
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error('timeout')));
    request.on('error', reject);
    if (payload) request.write(payload);
    request.end();
  });
}

async function waitForModule(url, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  let last = 'not attempted';
  while (Date.now() < deadline) {
    try {
      const response = await httpJson(`${url}${MODULE_API_PREFIX}/health`, { timeoutMs: 3000 });
      if (response.status === 200 && response.data && response.data.status === 'ok') return response.data;
      last = `status ${response.status}`;
    } catch (error) { last = error.message; }
    await new Promise(resolve => setTimeout(resolve, 400));
  }
  throw new Error(`terminal module health never came up (${last})`);
}

function gitHead(root) {
  try {
    const result = spawnSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true });
    return result.status === 0 ? String(result.stdout || '').trim() : null;
  } catch { return null; }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const startedAt = new Date().toISOString();
  const summary = {
    schema: 'qa-autopilot/dock-isolation-r3-launch/v1',
    startedAt,
    probe: path.relative(PKB_ROOT, path.resolve(args.probe)),
    tag: args.tag,
    artifactsDir: args.artifacts,
    isolation: {},
    processes: {},
    exitCodes: {},
    secretScan: null,
    failures: [],
  };

  // 1. Chrome first: the discovery reads the real %LOCALAPPDATA%.
  const chrome = findChromeDetailed();
  summary.chrome = { path: chrome.path, source: chrome.source };

  // 2. The pinned module (the shipped copy the repo pins).
  const moduleRoot = path.join(PKB_ROOT, 'node_modules', 'claude-ai-workbench');
  const terminalEntry = path.join(moduleRoot, 'packages', 'server', 'bin', 'agent-terminal-server.js');
  if (!fs.existsSync(terminalEntry)) throw new Error(`pinned terminal entry missing: ${terminalEntry}`);
  summary.pinned = {
    moduleRoot,
    terminalEntry,
    terminalEntrySha256: fixture.sha256File(terminalEntry),
    profileStoreSha256: fixture.sha256File(path.join(moduleRoot, 'packages', 'server', 'lib', 'profile-store.js')),
    version: (() => { try { return require(path.join(moduleRoot, 'package.json')).version; } catch { return null; } })(),
  };
  summary.source = { repoRoot: PKB_ROOT, gitHead: gitHead(PKB_ROOT) };

  // 3. The real profile: read-only, and the secret never leaves this process
  //    except through the pipe into the server.
  let realProfile = null;
  if (args.profile) {
    realProfile = fixture.readRealWorkbenchProfile(args.profile);
    summary.realProfile = {
      profileId: realProfile.profileId,
      credentialRef: realProfile.credentialRef,
      provider: realProfile.definition.provider,
      baseUrl: realProfile.definition.baseUrl,
      model: realProfile.definition.models && realProfile.definition.models.default,
      sourceStore: realProfile.sourceStore,
      credentialLocation: 'server process memory (pipe handoff)',
      secretRecorded: false,
    };
  }

  // 4. One isolated layout outside the repository.
  const layout = fixture.createIsolationLayout(`pk-${args.tag}`);
  fixture.writeOwnerMarker(layout, { pid: process.pid, startedAt, lane: 'P-DOCK-ISOLATION-R3', tag: args.tag, kind: 'launcher' });
  summary.isolation = {
    root: layout.root,
    outsideRepository: !fixture.isInside(layout.root, PKB_ROOT),
    ownerMarker: path.join(layout.root, 'owner-marker.json'),
    home: layout.home,
    appData: layout.appData,
    localAppData: layout.localAppData,
    temp: layout.temp,
    claudeConfigDir: layout.claudeConfigDir,
    codexHome: layout.codexHome,
    knowledgeDataDir: layout.knowledgeDataDir,
    bridgeHome: layout.bridgeHome,
    moduleDataDir: layout.dataDir,
    browserProfile: layout.browserProfile,
    workspace: layout.workspace,
  };

  // The module store holds the profile DEFINITION only. The credential file is
  // created empty on purpose: the secret must never be written to disk.
  if (realProfile) {
    fixture.writeJson(path.join(layout.dataDir, 'profiles.v2.json'), {
      schema: 'claude-workbench-profiles/v2',
      profiles: [realProfile.definition],
      maintenanceDefaultProfileId: null,
    });
  }
  fixture.writeJson(path.join(layout.dataDir, 'credentials.v1.json'), {
    schema: 'claude-workbench-credentials/v1',
    credentials: {},
  });

  const modulePort = await fixture.freePort();
  const productPort = await fixture.freePort();
  const moduleUrl = `http://127.0.0.1:${modulePort}`;
  const moduleEnv = fixture.isolatedEnv(layout, {
    AGENT_TERMINAL_PORT: String(modulePort),
    AGENT_TERMINAL_HOST: '127.0.0.1',
    AGENT_TERMINAL_DATA_DIR: layout.dataDir,
    KB_KNOWLEDGE_DATA_DIR: layout.knowledgeDataDir,
    KB_KNOWLEDGE_ENGINE_URL: 'http://127.0.0.1:0',
    KB_WORKBENCH_DISABLE_PICKER: '1',
    PK_R3_MODULE_ROOT: moduleRoot,
  });
  const preload = path.join(HELPERS, 'parallel-dock-isolation-r3-credential-preload.js');

  const moduleLogPath = path.join(layout.root, 'module.log');
  const moduleLog = [];
  const moduleTail = (chunk) => { moduleLog.push(String(chunk)); };
  const moduleChild = spawn(process.execPath, ['--require', preload, terminalEntry], {
    cwd: PKB_ROOT,
    env: moduleEnv,
    stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  moduleChild.stdout.on('data', moduleTail);
  moduleChild.stderr.on('data', moduleTail);
  if (realProfile) {
    moduleChild.stdio[3].write(JSON.stringify({ secret: realProfile.secret, credentialRef: realProfile.credentialRef }));
    moduleChild.stdio[3].end();
  } else {
    moduleChild.stdio[3].end();
  }
  summary.processes.module = {
    pid: moduleChild.pid,
    envKeys: fixture.envKeyNames(moduleEnv),
    isolationEnv: fixture.isolationEnvMap(layout),
    credentialInEnv: false,
    startedWithPreload: true,
  };

  let child = null;
  let childExit = null;
  try {
    await waitForModule(moduleUrl, 60000);
    summary.processes.module.health = 'ok';

    // The handoff carries NO secret: only paths and identities.
    const handoff = {
      schema: 'qa-autopilot/dock-isolation-r3-handoff/v1',
      createdAt: new Date().toISOString(),
      layout,
      moduleUrl,
      modulePort,
      modulePid: moduleChild.pid,
      moduleRoot,
      terminalEntry,
      moduleLogPath,
      chromePath: chrome.path,
      productPort,
      profileDefinition: realProfile ? realProfile.definition : null,
      credentialRef: realProfile ? realProfile.credentialRef : null,
      artifactsDir: args.artifacts,
    };
    const handoffFile = path.join(layout.root, 'handoff.json');
    fixture.writeJson(handoffFile, handoff);

    // 5. The probe itself runs isolated.
    const probeEnv = fixture.isolatedEnv(layout, {
      PK_R3_HANDOFF: handoffFile,
      PK_R3_ARTIFACTS: args.artifacts,
      PK_R3_TAG: args.tag,
    });
    summary.processes.probe = {
      pid: null,
      envKeys: fixture.envKeyNames(probeEnv),
      isolationEnv: fixture.isolationEnvMap(layout),
      credentialInEnv: false,
    };

    child = spawn(process.execPath, [path.resolve(args.probe)], {
      cwd: PKB_ROOT,
      env: probeEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    summary.processes.probe.pid = child.pid;
    child.stdout.on('data', chunk => process.stdout.write(String(chunk)));
    child.stderr.on('data', chunk => process.stderr.write(String(chunk)));
    childExit = await new Promise(resolve => {
      const timer = setTimeout(() => resolve({ code: null, signal: 'TIMEOUT', timedOut: true }), TOTAL_BUDGET_MS);
      child.once('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
    });
    summary.exitCodes.probe = childExit;
  } catch (error) {
    summary.failures.push({ stage: 'launch', message: error.message });
    if (!childExit) summary.exitCodes.probe = { code: 1, signal: null, error: error.message };
  } finally {
    // The module belongs to this run: stop it by pid and ownership proof.
    let moduleStoppedBy = null;
    if (moduleChild.exitCode === null && moduleChild.pid) {
      try {
        if (process.platform === 'win32') {
          moduleStoppedBy = 'taskkill /T /F (own pid)';
          spawnSync('taskkill', ['/PID', String(moduleChild.pid), '/T', '/F'], { stdio: 'ignore', timeout: 15000, windowsHide: true });
        } else {
          moduleStoppedBy = 'SIGTERM (own pid)';
          moduleChild.kill('SIGTERM');
        }
      } catch (error) { moduleStoppedBy = `stop failed: ${error.message}`; }
    }
    summary.exitCodes.module = {
      code: moduleChild.exitCode,
      signal: moduleChild.signalCode,
      stoppedBy: moduleStoppedBy,
      note: process.platform === 'win32'
        ? 'a force-killed Windows process reports no exit code'
        : 'SIGTERM exit code',
    };
    try { fs.writeFileSync(moduleLogPath, moduleLog.join(''), 'utf8'); } catch {}
    summary.processes.module.logTail = moduleLog.join('').slice(-1500);

    // 6. The secret must not exist in any file of this run.
    if (realProfile) {
      const scan = fixture.scanForSecret([layout.root, args.artifacts], realProfile.secret);
      summary.secretScan = {
        roots: [layout.root, args.artifacts],
        filesScanned: scan.scanned,
        findings: scan.findings,
        secretPersistedToFile: scan.findings.length > 0,
      };
    }

    // Cleanup: only the tree this run owns.
    const marker = fixture.readOwnerMarker(layout);
    if (marker && marker.pid === process.pid) fixture.removeTree(layout.root);
    summary.cleanup = { layoutRemoved: !fs.existsSync(layout.root) };
  }

  fs.mkdirSync(args.artifacts, { recursive: true });
  const summaryFile = path.join(args.artifacts, `launch-${args.tag}-summary.json`);
  fs.writeFileSync(summaryFile, JSON.stringify(summary, null, 2), 'utf8');
  console.log(`[r3-launch] summary=${summaryFile}`);
  const failed = summary.failures.length || (summary.secretScan && summary.secretScan.secretPersistedToFile);
  process.exitCode = failed ? 1 : (summary.exitCodes.probe && summary.exitCodes.probe.code === 0 ? 0 : 1);
}

main().catch(error => { console.error('[r3-launch] fatal:', error); process.exitCode = 1; });
