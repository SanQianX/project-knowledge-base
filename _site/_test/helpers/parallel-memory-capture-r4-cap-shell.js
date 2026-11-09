'use strict';
// _site/_test/helpers/parallel-memory-capture-r4-cap-shell.js
//
// Lane harness for the DEFAULT-owner (engine) external-Agent integration
// cases of P-MEMORY-CAPTURE-R4 (CAP-008 engine mode).
//
// The R3 cap shell proved the legacy consumer. This harness runs the same
// real product UI against the DEFAULT production topology instead:
//
//   * the REAL event-bridge console (@sanqianx/ai-coding-event-bridge-console,
//     the exact pinned package the product installs) as its OWN child
//     process, spawned the way module-bridge spawns it in production
//     (`node src/bin.js serve --host 127.0.0.1 --port <p> --home <dir>`),
//     serving the SAME journal home the installed shim, the shell's Bridge
//     adapter and the engine all use;
//   * the REAL vendored knowledge engine in-process, started with consume
//     DISABLED — consumption is switched on by the SHELL's own
//     connectEngine -> POST /api/control activation, never by the driver;
//   * the engine's analysis step is the frozen P-MEMORY-01 stand-in analyzer
//     with an empty plan (the case under test is capture/consumption
//     identity, not model judgement);
//   * the real product server in its DEFAULT mode (analysisOwner 'engine')
//     wired to the console and the engine through the same env and token
//     proxy the frozen memory lane proved;
//   * a shared real HTTP module fixture for terminal plus a lane-local
//     vector endpoint (implementing the real hub's /api/sync contract
//     subset) so the ENGINE's index step never falls back to its built-in
//     default vectorUrl — 127.0.0.1:8787, which is a LIVE module here.
//     Neither is the module under test;
//   * a real Chrome (CDP) in its own profile, an isolated home for the
//     接入 installation, and the real-home digests of the R3 cap shell.
//
// Nothing here reaches the developer's live ports, live homes or live
// journals; every path lives under the lane temp root.

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

const r3cap = require('./parallel-memory-capture-r3-cap-shell');
const { spawnServer } = require('../helpers/spawn-server');
const { findChrome } = require('../helpers/find-chrome');
const { launchCdpBrowser, waitFor } = require('../helpers/cdp-browser');
const { attachNetworkCapture } = require('../helpers/cdp-network-capture');
const { createModuleFixture, createUpstreamProxy } = require('../helpers/module-fixture');
const freePort = require('../helpers/free-port');
const { createMemoryStandinAnalyzer } = require('./parallel-memory-analyzer');

const ROOT = r3cap.ROOT;
const ENGINE_ENTRY = path.join(path.dirname(require.resolve('@sanqianx/ai-coding-knowledge-engine/package.json', { paths: [path.join(ROOT)] })), 'src', 'server.js');
const CONSOLE_ENTRY = path.join(ROOT, 'node_modules', '@sanqianx', 'ai-coding-event-bridge-console', 'src', 'bin.js');
const { resolveTempRoot, withSanitizedEnv } = r3cap;

function sha256File(file) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); } catch { return null; }
}

/** The pinned console package identity + per-file hashes of the serving code. */
function consoleIdentity() {
  const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules', '@sanqianx', 'ai-coding-event-bridge-console', 'package.json'), 'utf8'));
  const files = [
    'src/bin.js',
    'src/server.js',
    'src/bridge/core/journal-router.js',
    'src/bridge/core/journal.js',
    'src/bridge/core/repo-context.js',
    'src/bridge/core/project-registry.js',
  ];
  return {
    package: packageJson.name,
    version: packageJson.version,
    resolved: packageJson._resolved || null,
    integrity: packageJson._integrity || null,
    entry: CONSOLE_ENTRY,
    files: files.map(file => ({ file, sha256: sha256File(path.join(ROOT, 'node_modules', '@sanqianx', 'ai-coding-event-bridge-console', file)) })),
  };
}

/** Start the real console child process and wait until it serves its API. */
async function startConsoleChild({ bridgeHome, tag }) {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const output = [];
  const child = withSanitizedEnv(() => spawn(process.execPath, [CONSOLE_ENTRY, 'serve', '--host', '127.0.0.1', '--port', String(port), '--home', bridgeHome], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env: { ...process.env, AI_CODING_EVENT_BRIDGE_HOME: bridgeHome },
  }));
  child.stdout.on('data', chunk => output.push(String(chunk)));
  child.stderr.on('data', chunk => output.push(String(chunk)));
  const exited = new Promise(resolve => child.on('exit', (code, signal) => resolve({ code, signal })));
  let lastError = null;
  await waitFor(async () => {
    try {
      const response = await fetch(`${url}/api/journals`, { signal: AbortSignal.timeout(2000) });
      if (response.ok) return true;
      lastError = `status ${response.status}`;
      return false;
    } catch (error) { lastError = error.message; return false; }
  }, `the real event-bridge console child (port ${port}, last error ${lastError})`, 30000);
  return {
    kind: 'eventBridgeConsole',
    tag,
    child, url, port, bridgeHome, exited,
    output: () => output.join(''),
    async api(method, route, body) {
      const response = await fetch(url + route, {
        method,
        headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      });
      return { status: response.status, body: await response.json().catch(() => null) };
    },
    async close() {
      if (child.exitCode !== null) return;
      child.kill();
      const settled = await Promise.race([exited, new Promise(resolve => setTimeout(() => resolve('timeout'), 5000))]);
      if (settled === 'timeout' && child.exitCode === null) {
        const { spawnSync } = require('node:child_process');
        spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
        await exited.catch(() => {});
      }
    },
  };
}

/**
 * Lane-local vector endpoint for the ENGINE's index step.
 *
 * The shared vector-hub fixture implements the module surface but not
 * POST /api/sync — and the engine's built-in vectorUrl default is
 * http://127.0.0.1:8787, which on this machine is the developer's LIVE
 * desktop vector-hub. Creating the engine without an explicit vectorUrl
 * leaked /api/sync calls (and their index writes) into that live module
 * (CAP-008e attempts 1-4; fixed from attempt 5 on). This service mirrors
 * the real hub's /api/sync contract subset so runs settle deterministically
 * inside the lane, and records every request as evidence.
 */
function startLaneVectorHub({ tag }) {
  const state = { projects: [], requests: [] };
  const sendJson = (res, status, payload) => {
    const body = JSON.stringify(payload);
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  };
  const readBody = req => new Promise(resolve => {
    let raw = Buffer.alloc(0);
    req.on('data', chunk => { raw = Buffer.concat([raw, chunk]); });
    req.on('end', () => resolve(raw));
    req.on('error', () => resolve(raw));
  });
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const raw = await readBody(req);
    let body = null;
    if (raw.length) { try { body = JSON.parse(raw.toString('utf8')); } catch { body = null; } }
    state.requests.push({ method: req.method, path: url.pathname + url.search, body, at: Date.now() });
    if (req.method === 'GET' && url.pathname === '/api/projects') { sendJson(res, 200, { projects: state.projects }); return; }
    if (req.method === 'POST' && url.pathname === '/api/sync') {
      if (!body?.project || !body?.sourceDir) { sendJson(res, 400, { error: "Body must include 'project' and 'sourceDir'." }); return; }
      let filesTracked = 0;
      try { filesTracked = fs.readdirSync(body.sourceDir, { withFileTypes: true }).filter(entry => entry.isFile() && entry.name.endsWith('.md')).length; } catch {}
      state.projects = state.projects.filter(project => project.name !== body.project);
      state.projects.push({ name: body.project, sourceDir: body.sourceDir, hasIndex: true });
      sendJson(res, 200, { ok: true, project: body.project, filesTracked });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/import') {
      state.projects.push({ name: body?.projectName || '', sourceDir: body?.sourceDir || '', hasIndex: true });
      sendJson(res, 200, { ok: true, project: body?.projectName || '' });
      return;
    }
    if (req.method === 'DELETE' && url.pathname === '/api/project') {
      const name = url.searchParams.get('name');
      state.projects = state.projects.filter(project => project.name !== name);
      sendJson(res, 200, { ok: true });
      return;
    }
    sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: '未实现的模块接口' } });
  });
  return {
    kind: 'laneVectorHub',
    tag,
    state,
    requests: state.requests,
    url: null,
    async start() {
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      this.url = `http://127.0.0.1:${server.address().port}`;
      return this.url;
    },
    async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); },
  };
}

async function startCapHarness({ tag, evidenceDir, viewport = { width: 1600, height: 950 }, serverEnv = {} } = {}) {
  const tempRoot = resolveTempRoot();
  fs.mkdirSync(tempRoot, { recursive: true });
  const previousTemp = { TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR };
  process.env.TEMP = tempRoot;
  process.env.TMP = tempRoot;
  process.env.TMPDIR = tempRoot;

  const fixture = fs.mkdtempSync(path.join(tempRoot, `pk-cap-r4-${tag}-`));
  const homeDir = path.join(fixture, 'home');
  fs.mkdirSync(homeDir, { recursive: true });
  const evidence = evidenceDir || path.join(fixture, 'evidence');
  fs.mkdirSync(evidence, { recursive: true });
  const bridgeHome = fs.mkdtempSync(path.join(tempRoot, `pk-cap-r4-${tag}-bridge-`));
  // Force every PowerShell child of this lane (the browser helper's CIM
  // sweep, the product's own port probe) to keep its module analysis cache
  // inside the disposable fixture — see the Microsoft/ forensics.
  process.env.PSModuleAnalysisCachePath = path.join(fixture, 'ps-module-analysis-cache.bin');

  const realHomeBefore = r3cap.digestRealClientConfigs();
  const realTreesBefore = r3cap.digestRealClientTrees();

  // The analysis step is the frozen stand-in with an empty plan: runs triggered
  // by real commit boundaries complete, and the case says so honestly.
  const plan = { document: '', memoryCandidates: [] };

  const consoleChild = await startConsoleChild({ bridgeHome, tag: `${tag}-console` });

  let engine = null;
  let engineProxy = null;
  let terminal = null;
  let laneVector = null;
  let server = null;
  let browser = null;
  let network = null;
  const engineToken = crypto.randomBytes(24).toString('hex');
  let base = null;
  try {
    // The vector plane MUST exist before the engine: the engine's index step
    // calls it, and its built-in default points at the developer's live
    // vector-hub (127.0.0.1:8787) — never reached from this lane.
    laneVector = startLaneVectorHub({ tag: `${tag}-vector` });
    await laneVector.start();

    const { createEngineServer } = require(ENGINE_ENTRY);
    engine = createEngineServer({
      dataDir: path.join(fixture, 'engine'),
      runtimeToken: engineToken,
      debug: true,
      consume: false,
      bridgeUrl: consoleChild.url,
      vectorUrl: laneVector.url,
      analyzer: createMemoryStandinAnalyzer({ plan }),
    });
    await engine.ready;
    await new Promise(resolve => engine.server.listen(0, '127.0.0.1', resolve));
    const engineUrl = `http://127.0.0.1:${engine.server.address().port}`;
    engineProxy = createUpstreamProxy({ target: engineUrl, token: engineToken, tag: `${tag}-engine` });
    await engineProxy.start();

    terminal = createModuleFixture({ kind: 'terminal', tag: `${tag}-terminal` });
    await terminal.start();

    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    server = withSanitizedEnv(() => spawnServer({
      root: ROOT,
      port,
      dataDir: path.join(fixture, 'data'),
      tag: `cap-r4-${tag}`,
      analysisOwner: 'engine',
      extraEnv: {
        HOME: homeDir,
        USERPROFILE: homeDir,
        CLAUDE_CONFIG_DIR: path.join(homeDir, '.claude'),
        KB_MODULES_REGISTER: '1',
        KB_MODULES_AUTOSTART: '0',
        KB_TERMINAL_URL: terminal.url,
        KB_VECTORHUB_URL: laneVector.url,
        KB_EVENTBRIDGE_URL: consoleChild.url,
        KB_KNOWLEDGE_ENGINE_URL: engineProxy.url,
        AI_CODING_EVENT_BRIDGE_HOME: bridgeHome,
        // A lane may override or extend the server process environment (the
        // CAP-006 isolation case points the server's own codex children at an
        // explicit external CODEX_HOME plus independent APPDATA/LOCALAPPDATA).
        ...serverEnv,
      },
    }));
    process.env.TEMP = previousTemp.TEMP;
    process.env.TMP = previousTemp.TMP;
    process.env.TMPDIR = previousTemp.TMPDIR;

    await waitFor(async () => {
      try {
        const response = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(5000) });
        return response.status === 200;
      } catch { return false; }
    }, 'the isolated product instance (engine owner)', 30000);

    browser = await launchCdpBrowser({
      chrome: findChrome(),
      profileDir: path.join(fixture, 'browser'),
      url: `${base}/`,
      width: viewport.width,
      height: viewport.height,
    });
    await browser.setViewport(viewport.width, viewport.height);
    await browser.send('Network.enable');
    network = attachNetworkCapture(browser);
  } catch (error) {
    await browser?.close().catch(() => {});
    await server?.cleanup().catch(() => {});
    await engineProxy?.close().catch(() => {});
    await terminal?.close().catch(() => {});
    await laneVector?.close().catch(() => {});
    await consoleChild?.close().catch(() => {});
    await engine?.close().catch(() => {});
    fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    fs.rmSync(bridgeHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    throw error;
  }

  const run = expression => browser.evaluate(expression);

  const productApi = async (method, route, body) => {
    const response = await fetch(base + route, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  };

  // The engine trusts only the runtime token; the harness created it and holds it.
  const engineTokenFetch = async (method, route, body) => {
    const engineUrl = `http://127.0.0.1:${engine.server.address().port}`;
    const response = await fetch(engineUrl + route, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${engineToken}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  };

  /** A native pointer click: the hit test must resolve to the target. */
  const nativeClick = async selector => {
    const probe = await run(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return { missing: true };
      el.scrollIntoView({ block: 'center' });
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return { invisible: true };
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      const hit = document.elementFromPoint(x, y);
      return { x, y, hitIsTarget: Boolean(hit && (hit === el || el.contains(hit))), label: (el.textContent || '').trim().slice(0, 40) };
    })()`);
    if (!probe || probe.missing) throw new Error(`the control ${selector} must exist in the page`);
    if (probe.invisible) throw new Error(`the control ${selector} must be visible`);
    if (!probe.hitIsTarget) throw new Error(`the control ${selector} must be the hit target; something else is on top`);
    const common = { x: probe.x, y: probe.y, button: 'left', clickCount: 1 };
    await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: probe.x, y: probe.y, button: 'none', clickCount: 0 });
    await browser.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...common });
    await browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...common });
    return probe;
  };

  /** Open the real system drawer and wait until the product's own scan settles. */
  const openSystemDrawer = async () => {
    await nativeClick('#openSystem');
    await waitFor(() => run("document.getElementById('systemDrawer').hidden === false"), 'the system drawer is open', 15000);
    await waitFor(
      () => run("document.querySelectorAll('#agentCaptureList .agent-capture-row').length > 0"),
      'the external agent rows are rendered',
      60000,
    );
    await waitFor(
      () => run("[...document.querySelectorAll('#agentCaptureList .agent-capture-row')].every(row => { const badge = row.querySelector('.status'); return badge && badge.textContent !== '检测中'; })"),
      'the external agent rows show a settled state',
      90000,
    );
  };

  /** The last install request the real UI sent, with its real response body. */
  const lastInstallCall = async () => {
    const entries = network.find(entry => entry.method === 'POST' && entry.url.includes('/api/integrations/install'));
    const entry = entries.length ? entries[entries.length - 1] : null;
    if (!entry) return null;
    return { method: entry.method, url: entry.url.replace(base, ''), request: entry.body, status: entry.status, response: await network.body(entry) };
  };

  /** Every install request the real UI sent so far. */
  const installCallCount = () => network.find(entry => entry.method === 'POST' && entry.url.includes('/api/integrations/install')).length;

  /** Close and reopen the drawer with real clicks: reopening is the product's own refresh point. */
  const reopenSystemDrawer = async () => {
    if (!(await run("document.getElementById('systemDrawer').hidden === false"))) throw new Error('the system drawer must be open before it can be reopened');
    await nativeClick('#closeSystem');
    await waitFor(() => run("document.getElementById('systemDrawer').hidden === true"), 'the system drawer is closed', 15000);
    await openSystemDrawer();
  };

  /** The rows exactly as the UI rendered them. */
  const agentRows = () => run(`[...document.querySelectorAll('#agentCaptureList .agent-capture-row')].map(row => ({
    label: row.querySelector('b') ? row.querySelector('b').textContent : null,
    badge: row.querySelector('.status') ? row.querySelector('.status').textContent : null,
    client: row.querySelector('[data-agent-switch]') ? row.querySelector('[data-agent-switch]').dataset.agentClient : null,
    details: [...row.querySelectorAll('small')].map(el => el.textContent),
    switch: row.querySelector('[data-agent-switch]') ? {
      action: row.querySelector('[data-agent-switch]').dataset.agentSwitch,
      client: row.querySelector('[data-agent-switch]').dataset.agentClient,
      text: row.querySelector('[data-agent-switch]').textContent,
      disabled: row.querySelector('[data-agent-switch]').disabled,
    } : null,
    retry: row.querySelector('[data-agent-retry]') ? row.querySelector('[data-agent-retry]').dataset.agentClient : null,
  }))`);

  /** The row of one client exactly as the UI rendered it. */
  const agentRow = async client => {
    const rows = await agentRows();
    return rows.find(row => row.client === client) || null;
  };

  /** The status once the product's own scan has settled (never a 'checking' placeholder). */
  const settledStatus = async (timeoutMs = 90000) => {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
      const result = await productApi('GET', '/api/integrations/status');
      last = result.body;
      const clients = (last && last.clients) || [];
      const pending = clients.some(client => ['checking', 'refreshing'].includes(client.summary)
        || client.knowledgeIntegration?.state === 'checking'
        || client.automaticContext?.state === 'checking'
        || client.developmentCapture?.state === 'checking');
      if (!pending && last && last.scan && last.scan.state === 'ready') return last;
      await new Promise(resolve => setTimeout(resolve, 400));
    }
    throw new Error(`the integration status never settled: ${JSON.stringify(last)}`);
  };

  /** One client entry of the settled status. */
  const statusClient = (status, client) => (status.clients || []).find(entry => entry.client === client) || null;

  const typeInto = async (selector, text) => {
    await nativeClick(selector);
    await run(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.value = ''; el.focus(); })()`);
    for (const character of String(text)) {
      const upper = character.toUpperCase();
      const isLetter = character >= 'a' && character <= 'z';
      const isUpper = character >= 'A' && character <= 'Z';
      const isDigit = character >= '0' && character <= '9';
      const code = isLetter ? `Key${upper}` : isUpper ? `Key${character}` : isDigit ? `Digit${character}` : '';
      const keyCode = isUpper ? upper.charCodeAt(0) : isLetter ? character.charCodeAt(0) : isDigit ? character.charCodeAt(0) : 0;
      const base = { key: character, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode };
      await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base, text: character, unmodifiedText: character });
      await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
    }
  };

  /** The real 系统诊断记录 dialog, searched with the real input and the real 查询 button. */
  const logsSearch = async operationId => {
    if (await run("document.getElementById('logsDialog').open === true")) {
      await nativeClick('#logsDialog [data-close="logsDialog"]');
      await waitFor(() => run("document.getElementById('logsDialog').open === false"), 'the diagnostics dialog is closed', 10000);
    }
    if (await run("document.getElementById('systemDrawer').hidden === true")) await openSystemDrawer();
    await nativeClick('#openLogs');
    await waitFor(() => run("document.getElementById('logsDialog').open === true"), 'the diagnostics dialog is open', 10000);
    await typeInto('#logsSearch', operationId);
    await nativeClick('#loadLogs');
    await waitFor(
      () => run(`[...document.getElementById('logsContent').querySelectorAll('.log-entry')].some(row => row.textContent.includes(${JSON.stringify(operationId)}))`),
      'the diagnostics search returns records for the operation id',
      20000,
    );
    return run(`({
      status: document.getElementById('logsStatus').textContent,
      search: document.getElementById('logsSearch').value,
      entries: [...document.getElementById('logsContent').querySelectorAll('.log-entry')].map(row => ({
        level: row.dataset.level,
        summary: row.querySelector('summary') ? row.querySelector('summary').textContent : '',
        detail: row.querySelector('.log-detail') ? row.querySelector('.log-detail').textContent : '',
      })),
    })`);
  };

  /** The client configuration files the installer wrote into the isolated home. */
  const isolatedConfigs = () => {
    const claudeSettings = path.join(homeDir, '.claude', 'settings.json');
    const readJson = file => {
      try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
    };
    const settings = readJson(claudeSettings);
    const hookEvents = settings && settings.hooks ? settings.hooks : null;
    const ownedHooks = {};
    for (const [event, groups] of Object.entries(hookEvents || {})) {
      const list = Array.isArray(groups) ? groups : [];
      const entries = [];
      for (const group of list) for (const hook of group?.hooks || []) {
        const command = hook?.type === 'command' ? hook.command : `${hook?.command} ${(hook?.args || []).join(' ')}`;
        if (/bridge-hook\.cjs/i.test(String(command))) entries.push({ command, args: hook?.args || null, type: hook?.type || null });
      }
      ownedHooks[event] = entries;
    }
    return {
      homeDir,
      claudeSettingsFile: claudeSettings,
      claudeSettingsExists: fs.existsSync(claudeSettings),
      claudeSettings: settings,
      ownedHooks,
      ownedHookCounts: Object.fromEntries(Object.entries(ownedHooks).map(([event, entries]) => [event, entries.length])),
    };
  };

  /** The Bridge hook entries the product owns in the isolated home. */
  const ownedHookEntries = () => {
    const configs = isolatedConfigs();
    const entries = [];
    for (const [event, list] of Object.entries(configs.ownedHooks)) {
      for (const hook of list) {
        const match = String(hook.command || '').match(/bridge-hook\.cjs/i);
        const target = match ? String(hook.command).match(/"([^"]*bridge-hook\.cjs)"/i) : null;
        const shim = target ? target[1] : null;
        entries.push({ event, command: hook.command, shimPath: shim, shimExists: Boolean(shim && fs.existsSync(shim)) });
      }
    }
    return entries;
  };

  // A hung child (a slow install inside the shell, a stuck drain) must never
  // zombie the whole probe: every cleanup step is raced against a deadline and
  // the remaining children are force-killed by their own PIDs afterwards.
  const withDeadline = (promise, ms, label) => Promise.race([
    Promise.resolve(promise).catch(() => {}),
    new Promise(resolve => setTimeout(() => { console.error(`cleanup step timed out: ${label}`); resolve(); }, ms)),
  ]);
  const forceKillTree = pid => {
    if (!pid) return;
    const { spawnSync } = require('node:child_process');
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
  };
  const cleanup = async () => {
    // Order follows the connection graph: chrome -> shell -> engine (its 2s
    // console poll keeps opening connections) -> console -> lane fixtures.
    // browser.close() includes a machine-wide CIM sweep for detached chrome
    // launchers, which alone can take >15s — give it a real budget.
    await withDeadline(browser?.close(), 30000, 'browser');
    await withDeadline(engine?.close(), 12000, 'engine');
    if (engine?.server) { try { engine.server.closeAllConnections?.(); await new Promise(resolve => engine.server.close(() => resolve())); } catch {} }
    await withDeadline(server?.cleanup(), 20000, 'server');
    if (server?.child?.pid && server.child.exitCode === null) forceKillTree(server.child.pid);
    await withDeadline(consoleChild?.close(), 10000, 'console');
    if (consoleChild && consoleChild.child.exitCode === null) forceKillTree(consoleChild.child.pid);
    await withDeadline(engineProxy?.close(), 5000, 'engine proxy');
    await withDeadline(terminal?.close(), 5000, 'terminal');
    await withDeadline(laneVector?.close(), 5000, 'lane vector');
    fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    fs.rmSync(bridgeHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  };

  return {
    fixture, evidence, homeDir, bridgeHome, tempRoot, base, server, browser, network,
    run, waitFor, nativeClick, openSystemDrawer, reopenSystemDrawer, agentRows, agentRow,
    settledStatus, statusClient, lastInstallCall, installCallCount, logsSearch,
    isolatedConfigs, ownedHookEntries,
    productApi, engineApi: engineTokenFetch, consoleApi: consoleChild.api, consoleChild,
    engine, engineProxy, terminal, laneVector, plan,
    realHomeBefore, realTreesBefore,
    cleanup,
  };
}

module.exports = { ROOT, startCapHarness, consoleIdentity, sha256File };
