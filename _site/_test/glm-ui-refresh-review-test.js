'use strict';
// GLM independent QA for the web part of docs/plans/ui-refresh-electron-plan-2026-10-13.md.
// Node/HTTP/VM only: no browser, no CDP; stubs listen on 127.0.0.1:0; no product process.
// Temp data stays in .local-test-data/ui-refresh-2026-10-15/ and is never deleted here.
//
// Every risk is probed twice: baseline = the pre-fix sources from git HEAD (first-failure
// evidence), current = the working tree (post-fix verification, the Leader is fixing
// production code concurrently). Gates encode the plan's desired behavior.
// A first screen / B slow module / C engine takeover / D config sync / E 8-tab SSE.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '../..');
const { ModuleBridge } = require('../lib/module-bridge');
const { connectEngine } = require('../lib/engine-connection');

const TEMP_DATA = path.join(ROOT, '.local-test-data', 'ui-refresh-2026-10-15');
fs.mkdirSync(TEMP_DATA, { recursive: true });

const allServers = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const gates = [];

async function gate(section, name, run) {
  try { await run(); gates.push({ section, name, ok: true }); console.log('[PASS] ' + section + ' ' + name); }
  catch (error) { gates.push({ section, name, ok: false, message: error && error.message }); console.log('[FAIL] ' + section + ' ' + name + ' :: ' + (error && error.message)); }
}

const BASELINE_COMMIT = '55e162762950a069cf00e826c9f9b8eea5c768e5';
// CI checks out with actions/checkout's default fetch-depth=1, so the pinned
// baseline commit may not exist there. Baseline gates are first-failure
// evidence already recorded with the plan review; when the commit is absent
// they degrade to a skip instead of crashing the whole run.
let baselineReady = true;
try { execFileSync('git', ['cat-file', '-e', `${BASELINE_COMMIT}^{commit}`], { cwd: ROOT, stdio: 'ignore' }); }
catch { baselineReady = false; }

function headSource(relPath) {
  return execFileSync('git', ['show', BASELINE_COMMIT + ':' + relPath], { encoding: 'utf8', cwd: ROOT, maxBuffer: 16 * 1024 * 1024 });
}

const headModuleCache = new Map();
function loadHeadModule(relPath) {
  if (headModuleCache.has(relPath)) return headModuleCache.get(relPath);
  const moduleObject = { exports: {} };
  const directory = path.dirname(path.join(ROOT, relPath));
  const sandboxRequire = request => require(request.startsWith('.') ? path.join(directory, request) : request);
  const sandbox = {
    require: sandboxRequire, module: moduleObject, exports: moduleObject.exports,
    fetch, AbortController, setTimeout, clearTimeout, setInterval, clearInterval, Buffer, URL, URLSearchParams, console,
    process: { env: {}, versions: { node: process.versions.node }, platform: process.platform },
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(headSource(relPath), sandbox, { filename: relPath });
  headModuleCache.set(relPath, moduleObject.exports);
  return moduleObject.exports;
}

function startStub(routes) {
  const counters = {};
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const cleanPath = req.url.split('?')[0];
      const route = routes.find(r => (r.method === 'ANY' || r.method === req.method) && r.path.test(cleanPath));
      if (!route) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end('{}'); return; }
      if (route.hang) return; // accepted the socket and never responds: the hung module
      counters[route.name] = (counters[route.name] || 0) + 1;
      if (route.countWith) { const key = route.countWith(body); if (key) counters[key] = (counters[key] || 0) + 1; }
      let payload = {};
      let status = route.status || 200;
      if (route.handle) {
        payload = route.handle(cleanPath, body);
        if (payload && payload.__status) { status = payload.__status; delete payload.__status; }
      }
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    });
  });
  allServers.push(server);
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, url: 'http://127.0.0.1:' + server.address().port, counters })));
}

async function makeEnv(options = {}) {
  const failProjects = options.engineFailProjects || [];
  const BridgeClass = options.baseline ? loadHeadModule('_site/lib/module-bridge.js').ModuleBridge : ModuleBridge;
  const connect = options.baseline ? loadHeadModule('_site/lib/engine-connection.js').connectEngine : connectEngine;
  const terminal = await startStub([
    { method: 'GET', path: /\/projects\/?$/, name: 'terminal-list', handle: () => ({ projects: options.terminalProjects || [] }) },
    { method: 'POST', path: /\/claude-workbench\/v1\/projects\/?$/, name: 'terminal-register', handle: () => ({ id: 't1' }) },
    { method: 'POST', path: /internal\/maintenance-config$/, name: 'terminal-maintenance', status: 500, handle: () => ({}) },
    { method: 'POST', path: /internal\/embedding-config$/, name: 'terminal-embedding', status: 500, handle: () => ({}) },
  ]);
  const vectorHub = await startStub([
    { method: 'GET', path: /^\/api\/projects\/?$/, name: 'vector-list', hang: !!options.vectorHubHung, handle: () => ({ projects: [] }) },
    { method: 'GET', path: /^\/api\/health\/?$/, name: 'vector-health', hang: !!options.vectorHubHung, handle: () => ({ ok: true }) },
    { method: 'POST', path: /^\/api\/import$/, name: 'vector-import', handle: () => ({ ok: true }) },
    { method: 'POST', path: /^\/api\/internal\/runtime-config$/, name: 'vector-runtime-config', handle: () => ({ rootPath: null }) },
  ]);
  const eventBridge = await startStub([
    { method: 'GET', path: /^\/api\/projects\/?$/, name: 'bridge-list', handle: () => ({ projects: [] }) },
    { method: 'POST', path: /^\/api\/projects\/?$/, name: 'bridge-register', handle: () => ({ project: { id: 'eb1' } }) },
    { method: 'GET', path: /^\/api\/journal\/high-watermark$/, name: 'bridge-watermark', handle: () => ({ sequence: 0 }) },
  ]);
  const registered = [...(options.engineProjects || [])];
  const engine = await startStub([
    { method: 'GET', path: /^\/api\/health\/?$/, name: 'engine-health', handle: () => ({ name: 'knowledge-engine', dataSchemaVersion: 3 }) },
    { method: 'ANY', path: /^\/api\/runtime-auth\/?$/, name: 'engine-auth', handle: () => ({ ok: true }) },
    { method: 'GET', path: /^\/api\/projects\/?$/, name: 'engine-list', handle: () => ({ projects: registered }) },
    { method: 'POST', path: /^\/api\/projects\/?$/, name: 'engine-register', countWith: body => { try { return 'engine-register:' + JSON.parse(body).projectId; } catch { return null; } }, handle: (cleanPath, body) => { try { const parsed = JSON.parse(body); if (failProjects.includes(parsed.projectId)) return { __status: 500, ok: false, failed: parsed.projectId }; registered.push({ projectId: parsed.projectId, repoPath: parsed.repoPath, knowledgePath: parsed.knowledgePath }); } catch {} return { ok: true }; } },
    { method: 'GET', path: /^\/api\/snapshot\/?$/, name: 'engine-snapshot', handle: () => ({ sharedScopes: [] }) },
    { method: 'POST', path: /^\/api\/scopes\/?$/, name: 'engine-scopes', handle: () => ({ ok: true }) },
    { method: 'POST', path: /^\/api\/runtime-config\/?$/, name: 'engine-runtime-config', handle: () => ({ ok: true }) },
    { method: 'POST', path: /^\/api\/control\/?$/, name: 'engine-control', handle: () => ({ ok: true }) },
  ]);
  const projectIds = options.projectIds || [];
  const configs = new Map(projectIds.map(id => [id, { displayName: id, repoPath: 'D:/qa/' + id, knowledgePath: 'D:/qa/knowledge/' + id, brainId: 'brain-default', domainId: null }]));
  const states = new Map(projectIds.map(id => [id, {}]));
  const registryStore = { listIds: () => [...projectIds], readDisplaySnapshot: id => projectIds.includes(id) ? { displayName: id } : null };
  const projectStore = { readConfig: id => configs.get(id), readState: id => states.get(id) || {}, updateState: async (id, mutator) => { const state = states.get(id) || {}; mutator(state); states.set(id, state); } };
  const settings = { brain: { id: 'brain-default', name: 'QA-Brain', domains: [] }, knowledge: { rootPath: path.join(TEMP_DATA, 'qa-knowledge-root') } };
  const settingsStore = { read: () => settings, bindSharedKnowledgePaths: async () => {} };
  const bridge = new BridgeClass({
    terminalUrl: terminal.url, vectorHubUrl: vectorHub.url, eventBridgeUrl: eventBridge.url, engineUrl: engine.url,
    registryStore, projectStore, settingsStore, dataDir: path.join(TEMP_DATA, 'qa-data-dir'),
    logger: { info() {}, warn() {}, error() {} },
  });
  const makeRuntime = () => ({ analysisOwner: 'engine', moduleBridge: bridge, registryStore, projectStore, logger: { info() {}, warn() {}, error() {} }, ownership: { owner: 'engine', ready: false } });
  return { bridge, connect, makeRuntime, stubs: { terminal, vectorHub, eventBridge, engine } };
}

async function sectionA() {
  const makeElement = () => {
    const el = { textContent: '', innerHTML: '', hidden: false, disabled: false, value: '', className: '', open: false, dataset: {}, childElementCount: 0, firstElementChild: null };
    el.classList = { toggle() {}, add() {}, remove() {}, contains() { return false; } };
    el.addEventListener = () => {}; el.removeEventListener = () => {}; el.append = () => {}; el.replaceChildren = () => {};
    el.reset = () => {}; el.focus = () => {}; el.select = () => {}; el.close = () => {}; el.showModal = () => {}; el.scrollIntoView = () => {};
    el.dispatchEvent = () => true; el.parentElement = el; el.contentWindow = null;
    el.elements = { confirmGitInit: { checked: false }, confirmReplaceHook: { checked: false } };
    return el;
  };
  const jsonOk = payload => Promise.resolve({ ok: true, status: 200, json: async () => payload, headers: { get: () => null } });
  const brainPayload = { ok: true, brain: { id: 'brain-default', name: 'QA-Brain', domains: [] }, knowledgeRoot: 'D:/qa/root', indexStoragePath: 'D:/qa/idx' };
  const healthPayload = { ok: true, modules: { terminal: { up: true }, vectorHub: { up: true }, eventBridge: { up: true }, engine: { up: true } } };
  const projectsPayload = { ok: true, projects: [{ projectId: 'p1', name: 'P1', workspacePath: 'D:/qa/p1', knowledgePath: 'D:/qa/knowledge/p1', brainId: 'brain-default', domainId: null, modules: { terminal: { registered: true }, vectorHub: { registered: true }, eventBridge: { registered: true }, engine: { registered: true } } }] };
  const runScenario = async (source, fetchImpl) => {
    const elements = new Map();
    const timers = new Set();
    const get = id => { if (!elements.has(id)) elements.set(id, makeElement()); return elements.get(id); };
    const document = { getElementById: get, querySelectorAll: () => [], createElement: makeElement, addEventListener: () => {}, body: makeElement(), documentElement: { dataset: {} }, hidden: false };
    class EventSourceStub { constructor() { this.readyState = 0; } addEventListener() {} close() {} }
    const sandbox = {
      document, navigator: { onLine: true }, location: { origin: 'http://vm.local', hash: '' }, history: { replaceState() {} },
      addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
      localStorage: { getItem: () => null, setItem() {} }, EventSource: EventSourceStub, fetch: fetchImpl, AbortController,
      URLSearchParams, URL, crypto: require('node:crypto').webcrypto,
      setTimeout: (fn, ms, ...rest) => { const timer = setTimeout(fn, ms, ...rest); timers.add(timer); return timer; },
      clearTimeout: timer => { timers.delete(timer); clearTimeout(timer); },
      setInterval: () => 0, clearInterval: () => {},
    };
    sandbox.window = sandbox; sandbox.globalThis = sandbox;
    vm.runInNewContext(source, sandbox, { filename: 'product.js' });
    await sleep(2500);
    for (const timer of timers) clearTimeout(timer);
    return id => (elements.has(id) ? elements.get(id).textContent : undefined);
  };
  const hungFetch = url => {
    const target = String(url);
    if (target.includes('/api/projects/aggregated') || target.includes('/api/projects/projection')) return new Promise(() => {});
    if (target.includes('/api/modules/health')) return jsonOk(healthPayload);
    if (target.includes('/api/brain')) return jsonOk(brainPayload);
    if (target.includes('/api/engine/snapshot')) return jsonOk({ projects: [], runs: [], events: [], memories: [] });
    return jsonOk({ ok: true });
  };
  const fastFetch = url => {
    const target = String(url);
    if (target.includes('/api/projects/aggregated') || target.includes('/api/projects/projection')) return jsonOk(projectsPayload);
    if (target.includes('/api/modules/health')) return jsonOk(healthPayload);
    if (target.includes('/api/brain')) return jsonOk(brainPayload);
    if (target.includes('/api/engine/snapshot')) return jsonOk({ projects: [], runs: [], events: [], memories: [] });
    return jsonOk({ ok: true });
  };
  if (baselineReady) {
    const readBaseline = await runScenario(headSource('ui/product.js'), hungFetch);
    console.log('  baseline(HEAD) systemTitle after 2.5s with a hanging projects read: ' + JSON.stringify(readBaseline('systemTitle')));
    await gate('A', 'A1 baseline(HEAD): health region renders while the projects read hangs', async () => {
      const value = readBaseline('systemTitle');
      assert.ok(value !== undefined && value !== '' && value !== '正在检查系统', 'systemTitle never updated: the first screen is one Promise.all behind the slowest read (refreshRegistry), so brain/health regions cannot render');
    });
  }
  const currentSource = fs.readFileSync(path.join(ROOT, 'ui', 'product.js'), 'utf8');
  const readCurrent = await runScenario(currentSource, hungFetch);
  console.log('  current systemTitle after 2.5s with a hanging projects read: ' + JSON.stringify(readCurrent('systemTitle')));
  await gate('A', 'A2 current: health region renders while the projects read hangs', async () => {
    const value = readCurrent('systemTitle');
    assert.ok(value !== undefined && value !== '' && value !== '正在检查系统', 'post-fix frontend still gates the health region behind the hanging projects read');
  });
  const readControl = await runScenario(currentSource, fastFetch);
  await gate('A', 'A3 control: current frontend renders system status when all reads are fast', async () => {
    assert.strictEqual(readControl('systemTitle'), '系统连接正常', 'control scenario failed to render the health region');
  });
}

async function sectionB() {
  const hungOptions = {
    vectorHubHung: true,
    projectIds: ['p1'],
    terminalProjects: [{ id: 't0', rootPath: 'D:/qa/p1' }],
    engineProjects: [{ projectId: 'p1', repoPath: 'D:/qa/p1', knowledgePath: 'D:/qa/knowledge/p1' }],
  };
  if (baselineReady) {
    const baseline = await makeEnv({ ...hungOptions, baseline: true });
    const baselineStarted = Date.now();
    await baseline.bridge.aggregatedProjects();
    const baselineMs = Date.now() - baselineStarted;
    console.log('  baseline(HEAD) aggregatedProjects() with one hung module: ' + baselineMs + 'ms');
    await gate('B', 'B1 baseline(HEAD): aggregated read within 3.5s despite one hung module', async () => {
      assert.ok(baselineMs <= 3500, 'baseline took ' + baselineMs + 'ms (10s list timeout + sequential 2s availability probes): one slow module stalls the whole first screen');
    });
  }
  const current = await makeEnv(hungOptions);
  const currentStarted = Date.now();
  const aggregated = await current.bridge.aggregatedProjects();
  const currentMs = Date.now() - currentStarted;
  console.log('  current aggregatedProjects() with one hung module: ' + currentMs + 'ms');
  await gate('B', 'B2 current: aggregated read within 3.5s despite one hung module', async () => {
    assert.ok(currentMs <= 3500, 'aggregatedProjects() took ' + currentMs + 'ms with one hung module; plan requires a 3s-class budget');
  });
  await gate('B', 'B3 current: aggregated read keeps the registry spine (no false "no projects")', async () => {
    assert.strictEqual(aggregated.projects.length, 1, 'aggregated projection must keep the registry spine even when a module is unreachable');
  });
  const healthStarted = Date.now();
  await current.bridge.modulesHealth();
  const healthMs = Date.now() - healthStarted;
  console.log('  current modulesHealth() with one hung module: ' + healthMs + 'ms');
  await gate('B', 'B4 current: modulesHealth within 2.5s (parallel probes)', async () => {
    assert.ok(healthMs <= 2500, 'modulesHealth() took ' + healthMs + 'ms');
  });
}

async function sectionC() {
  if (baselineReady) {
    const baseline = await makeEnv({ baseline: true, projectIds: ['proj-bad', 'proj-good'], engineFailProjects: ['proj-bad'] });
    const baselineRuntime = baseline.makeRuntime();
    await baseline.connect(baselineRuntime);
    console.log('  baseline(HEAD) engine counters with one failing project: ' + JSON.stringify(baseline.stubs.engine.counters));
    await gate('C', 'C1 baseline(HEAD): healthy project is wired when another project fails', async () => {
      assert.ok((baseline.stubs.engine.counters['engine-register:proj-good'] || 0) >= 1, 'proj-good never reached engine POST /api/projects: sequential wiring aborted at proj-bad');
    });
    await gate('C', 'C2 baseline(HEAD): ownership not globally pending because of one project', async () => {
      assert.ok(baselineRuntime.ownership.ready, 'ownership stayed not-ready (' + JSON.stringify(baselineRuntime.ownership.error || null) + '): one failing project keeps the whole product in global "待恢复"');
    });
    await gate('C', 'C3 baseline(HEAD): engine activation happens with one failing project', async () => {
      assert.ok((baseline.stubs.engine.counters['engine-control'] || 0) >= 1, 'engine POST /api/control never happened: activation is gated behind all-project wiring');
    });
  }
  const current = await makeEnv({ projectIds: ['proj-bad', 'proj-good'], engineFailProjects: ['proj-bad'] });
  const currentRuntime = current.makeRuntime();
  await current.connect(currentRuntime);
  console.log('  current engine counters with one failing project: ' + JSON.stringify(current.stubs.engine.counters));
  console.log('  current ownership: ' + JSON.stringify(currentRuntime.ownership));
  await gate('C', 'C4 current: healthy project is wired when another project fails', async () => {
    assert.ok((current.stubs.engine.counters['engine-register:proj-good'] || 0) >= 1, 'proj-good still not wired when proj-bad fails');
  });
  await gate('C', 'C5 current: ownership not globally pending because of one project', async () => {
    assert.ok(currentRuntime.ownership.ready, 'ownership still not-ready globally');
  });
  await gate('C', 'C6 current: engine activation happens with one failing project', async () => {
    assert.ok((current.stubs.engine.counters['engine-control'] || 0) >= 1, 'engine POST /api/control still gated behind all-project wiring');
  });
}

async function sectionC4() {
  if (baselineReady) {
    const baseline = await makeEnv({ baseline: true, projectIds: ['p-a', 'p-b'] });
    await baseline.connect(baseline.makeRuntime());
    await baseline.connect(baseline.makeRuntime());
    console.log('  baseline(HEAD) counters after two takeover passes: ' + JSON.stringify(baseline.stubs.engine.counters));
    await gate('C', 'C7 baseline(HEAD): healthy projects are not re-registered on a repeat takeover pass', async () => {
      assert.strictEqual(baseline.stubs.engine.counters['engine-register:p-a'] || 0, 1, 'every takeover pass re-POSTs every healthy project (no remote-list/fingerprint dedupe)');
    });
    await gate('C', 'C8 baseline(HEAD): unchanged configuration is not re-pushed on a repeat takeover pass', async () => {
      assert.strictEqual(baseline.stubs.engine.counters['engine-scopes'] || 0, 1, 'unchanged scopes are re-pushed on every pass (no change detection)');
    });
  }
  const current = await makeEnv({ projectIds: ['p-a', 'p-b'] });
  const currentRuntime = current.makeRuntime();
  await current.connect(currentRuntime);
  await current.connect(currentRuntime);
  console.log('  current counters after two takeover passes: ' + JSON.stringify(current.stubs.engine.counters));
  await gate('C', 'C9 current: healthy projects are not re-registered on a repeat takeover pass', async () => {
    assert.strictEqual(current.stubs.engine.counters['engine-register:p-a'] || 0, 1, 'healthy project re-registered on a repeat pass');
  });
  await gate('C', 'C10 current: unchanged configuration is not re-pushed on a repeat takeover pass', async () => {
    assert.strictEqual(current.stubs.engine.counters['engine-scopes'] || 0, 1, 'unchanged scopes re-pushed on a repeat pass');
  });
}

async function sectionD() {
  if (baselineReady) {
    const baseline = await makeEnv({ baseline: true, projectIds: ['p1'] });
    await Promise.all([baseline.bridge.syncEngineConfiguration(), baseline.bridge.syncEngineConfiguration(), baseline.bridge.syncEngineConfiguration()]);
    console.log('  baseline(HEAD) engine counters after 3 concurrent syncs: ' + JSON.stringify(baseline.stubs.engine.counters));
    await gate('D', 'D1 baseline(HEAD): concurrent duplicate config syncs are merged into one push', async () => {
      assert.strictEqual(baseline.stubs.engine.counters['engine-scopes'] || 0, 1, 'single-flight chains a full re-run per concurrent caller: 3 callers produced ' + (baseline.stubs.engine.counters['engine-scopes'] || 0) + ' scope pushes');
    });
    await baseline.bridge.syncEngineConfiguration();
    console.log('  baseline(HEAD) engine counters after a fourth unchanged sync: ' + JSON.stringify(baseline.stubs.engine.counters));
    await gate('D', 'D2 baseline(HEAD): unchanged configuration is not re-pushed on the next sync', async () => {
      assert.strictEqual(baseline.stubs.engine.counters['engine-scopes'] || 0, 1, 'a completed sync with unchanged settings still re-pushes scopes');
    });
  }
  const current = await makeEnv({ projectIds: ['p1'] });
  await Promise.all([current.bridge.syncEngineConfiguration(), current.bridge.syncEngineConfiguration(), current.bridge.syncEngineConfiguration()]);
  console.log('  current engine counters after 3 concurrent syncs: ' + JSON.stringify(current.stubs.engine.counters));
  await gate('D', 'D3 current: concurrent duplicate config syncs are merged into one push', async () => {
    assert.strictEqual(current.stubs.engine.counters['engine-scopes'] || 0, 1, 'concurrent syncs were not merged');
  });
  await current.bridge.syncEngineConfiguration();
  console.log('  current engine counters after a fourth unchanged sync: ' + JSON.stringify(current.stubs.engine.counters));
  await gate('D', 'D4 current: unchanged configuration is not re-pushed on the next sync', async () => {
    assert.strictEqual(current.stubs.engine.counters['engine-scopes'] || 0, 1, 'unchanged settings re-pushed');
  });
}

async function sectionE() {
  let upstreamOpen = 0;
  const upstream = http.createServer((req, res) => {
    if (!req.url.includes('/api/events/stream')) { res.writeHead(404); res.end(); return; }
    upstreamOpen++;
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    res.write('event: snapshot\ndata: {"n":1}\n\n');
    const keepAlive = setInterval(() => { try { res.write('event: tick\ndata: {}\n\n'); } catch {} }, 200);
    req.on('close', () => { upstreamOpen--; clearInterval(keepAlive); });
  });
  allServers.push(upstream);
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamUrl = 'http://127.0.0.1:' + upstream.address().port;
  const env = await makeEnv({ projectIds: [] });
  const shell = http.createServer((req, res) => { env.bridge.proxy(req, res, upstreamUrl + '/api/events/stream').catch(() => {}); });
  allServers.push(shell);
  await new Promise(resolve => shell.listen(0, '127.0.0.1', resolve));
  const shellUrl = 'http://127.0.0.1:' + shell.address().port;
  const clients = [];
  try {
    for (let i = 0; i < 8; i++) {
      const controller = new AbortController();
      const got = { firstMs: null, startedAt: Date.now() };
      clients.push({ controller, got });
      fetch(shellUrl + '/stream', { signal: controller.signal, headers: { Accept: 'text/event-stream' } })
        .then(response => {
          got.firstMs = Date.now() - got.startedAt;
          const reader = response.body.getReader();
          const pump = () => reader.read().then(({ done }) => { if (!done) pump(); }).catch(() => {});
          pump();
        })
        .catch(() => {});
    }
    await sleep(1500);
    await gate('E', 'E1 current: 8 concurrent SSE clients each get their first event within 3s', async () => {
      assert.strictEqual(clients.filter(c => c.got.firstMs !== null).length, 8, 'not all 8 clients received a response within 1.5s');
      assert.strictEqual(upstreamOpen, 8, 'expected 8 independent upstream connections, saw ' + upstreamOpen);
    });
    for (const client of clients.slice(0, 4)) client.controller.abort();
    await sleep(1000);
    console.log('  upstream connections after aborting 4 of 8 clients: ' + upstreamOpen);
    await gate('E', 'E2 current: aborting 4 clients releases exactly their 4 upstream connections', async () => {
      assert.strictEqual(upstreamOpen, 4, 'aborting clients did not release their upstream connections (leak/block): ' + upstreamOpen + ' still open');
    });
  } finally {
    for (const client of clients) client.controller.abort();
  }
}

async function main() {
  if (!baselineReady) console.log('  baseline(HEAD) commit ' + BASELINE_COMMIT.slice(0, 7) + ' unavailable in this checkout (shallow clone); running current-behavior gates only.');
  await sectionA();
  await sectionB();
  await sectionC();
  await sectionC4();
  await sectionD();
  await sectionE();
  const failed = gates.filter(g => !g.ok);
  console.log('');
  console.log('glm-ui-refresh-review-test summary: ' + (gates.length - failed.length) + '/' + gates.length + ' gates passed');
  if (failed.length) {
    console.log('failed gates (baseline(HEAD) failures = first-failure evidence; current failures = regressions):');
    for (const g of failed) console.log('  [' + g.section + '] ' + g.name + ' :: ' + g.message);
  }
  const baseline = gates.filter(g => g.name.includes('baseline(HEAD)'));
  const regressions = failed.filter(g => !g.name.includes('baseline(HEAD)'));
  console.log(`Current: ${gates.length - baseline.length - regressions.length}/${gates.length - baseline.length}; baseline expected failures: ${baseline.filter(g => !g.ok).length}/${baseline.length}`);
  process.exitCode = regressions.length || baseline.some(g => g.ok) ? 1 : 0;
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  for (const server of allServers) { server.close(); server.closeAllConnections?.(); }
});
