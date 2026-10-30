'use strict';
// _site/_test/helpers/qa-r91-harness.cjs — P-MEMORY-DELETE-R91
//
// Copy of helpers/parallel-memory-shell.js (the P-MEMORY-01 lane harness)
// with exactly one product difference: the in-process knowledge engine is
// loaded from the R91 SOURCE CHECKOUT (sibling knowledge-engine repository,
// override with QA_R91_ENGINE_SRC) instead of the root's _modules pin, so
// the browser exercises the lane's own delete implementation. The installed
// core modules and the _modules pin are never touched.
//
// Everything else keeps the original lane discipline: own port/data dir/
// knowledge root/bridge journal home, declared stand-in analyzer, token
// pass-through proxy in front of the engine, real HTTP module services,
// real Chrome in its own profile, and no contact with the live
// 5757/5790/8787/8790 endpoints, the real HOME or the real memories.
//
// R99 (P-MEMORY-RELEASE-PREP-R99): startHarness({ productRoot }) — or the
// QA_R91_PRODUCT_ROOT env — runs the SAME isolated acceptance against an
// explicitly chosen OFFICIAL installed prefix: the spawned product server,
// its cwd and the static UI come from <productRoot>/_site/lib/server-app.js,
// and the in-process engine defaults to the prefix's vendored
// _modules/knowledge-engine (QA_R91_ENGINE_SRC still overrides). Helpers,
// isolation and stand-in analyzers stay canonical. Invalid roots are
// rejected by resolveProductRoot BEFORE any spawn; the default source-root
// behaviour is unchanged.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { spawnServer } = require('../helpers/spawn-server');
const { findChrome } = require('../helpers/find-chrome');
const { launchCdpBrowser, waitFor } = require('../helpers/cdp-browser');
const { attachNetworkCapture } = require('../helpers/cdp-network-capture');
const { createModuleFixture, createUpstreamProxy } = require('../helpers/module-fixture');
const freePort = require('../helpers/free-port');
const { createMemoryStandinAnalyzer } = require('./parallel-memory-analyzer');
const { createEventBridgeStandin } = require('./parallel-memory-event-bridge');
const { applyDriverIsolation } = require('./parallel-qa-engine-endpoint-isolate');
const { assertOwnedEndpoint, createEngineVectorStandin } = require('./parallel-qa-engine-endpoint-guard');

const ROOT = path.resolve(__dirname, '../../..');
const LIVE_PORTS = new Set([5757, 5760, 5790, 8787, 8790]);
const ENGINE_SRC_ENV = process.env.QA_R91_ENGINE_SRC;
const ENGINE_SOURCE_ROOT = path.resolve(ENGINE_SRC_ENV || path.join(ROOT, '..', 'knowledge-engine'));
const ENGINE_SOURCE_SERVER = path.join(ENGINE_SOURCE_ROOT, 'src', 'server.js');
// R99: captured at MODULE LOAD, before applyDriverIsolation can replace the
// process environment (the isolate helper wipes process.env). These are the
// REAL system locations a product root must never live in: the live npm
// global prefix, per-user program installs, Program Files, and any prefix
// surfaced through NPM_CONFIG_PREFIX. Reading them later would see the
// ISOLATED values and the protection would silently vanish.
const REAL_ENV_MARKERS = {
  appdata: process.env.APPDATA,
  localAppdata: process.env.LOCALAPPDATA,
  programFiles: process.env.ProgramFiles,
  programFilesX86: process.env['ProgramFiles(x86)'],
  npmConfigPrefix: process.env.NPM_CONFIG_PREFIX,
};
const PRODUCT_ROOT_ENV = process.env.QA_R91_PRODUCT_ROOT;
const DENY_ROOTS_ENV = process.env.QA_R99_DENY_ROOTS;

const PRODUCT_SITE_ENTRY = path.join('_site', 'lib', 'server-app.js');

function invalidProductRoot(reason, detail) {
  return Object.assign(new Error(`QA_R91_PRODUCT_ROOT ${reason}: ${detail}`), { code: 'INVALID_PRODUCT_ROOT', reason });
}

function pathInside(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// R99: validates an explicitly chosen product root for official-artifact
// acceptance. A product root is where a REAL installed prefix lives: the
// spawned server, its cwd and its static UI all come from
// <root>/_site/lib/server-app.js. Location rules run BEFORE the existence
// check, so a protected location is rejected deterministically even when the
// path does not exist yet. The canonical source checkout stays reachable
// only through the DEFAULT behaviour (no productRoot).
function resolveProductRoot(candidate) {
  if (typeof candidate !== 'string' || candidate.trim() === '') {
    throw invalidProductRoot('NOT_ABSOLUTE', `the product root must be a non-empty absolute path, got ${JSON.stringify(candidate)}`);
  }
  if (!path.isAbsolute(candidate)) {
    throw invalidProductRoot('NOT_ABSOLUTE', `relative product root ${JSON.stringify(candidate)} — the official prefix must be given as an absolute path`);
  }
  const root = path.resolve(candidate);

  const protectedLocations = [];
  if (REAL_ENV_MARKERS.appdata) protectedLocations.push({ label: 'the live npm global prefix', dir: path.join(REAL_ENV_MARKERS.appdata, 'npm') });
  if (REAL_ENV_MARKERS.localAppdata) protectedLocations.push({ label: 'per-user program installs', dir: path.join(REAL_ENV_MARKERS.localAppdata, 'Programs') });
  if (REAL_ENV_MARKERS.programFiles) protectedLocations.push({ label: 'Program Files', dir: REAL_ENV_MARKERS.programFiles });
  if (REAL_ENV_MARKERS.programFilesX86) protectedLocations.push({ label: 'Program Files (x86)', dir: REAL_ENV_MARKERS.programFilesX86 });
  if (REAL_ENV_MARKERS.npmConfigPrefix) protectedLocations.push({ label: 'NPM_CONFIG_PREFIX', dir: REAL_ENV_MARKERS.npmConfigPrefix });
  for (const deny of (DENY_ROOTS_ENV || '').split(path.delimiter).map(entry => entry.trim()).filter(Boolean)) {
    protectedLocations.push({ label: 'QA_R99_DENY_ROOTS', dir: deny });
  }
  for (const spot of protectedLocations) {
    if (pathInside(spot.dir, root)) throw invalidProductRoot('PROTECTED_LOCATION', `${root} is inside ${spot.label} ${spot.dir} — the real installed prefix must never be a test root`);
  }
  // A product root must be a separate installed location: the canonical
  // source checkout and the engine source checkout are not official prefixes
  // (and overlapping them in either direction would blur source/default runs).
  for (const spot of [{ label: 'the canonical test repository', dir: ROOT }, { label: 'the engine source checkout', dir: ENGINE_SOURCE_ROOT }]) {
    if (pathInside(spot.dir, root) || pathInside(root, spot.dir)) throw invalidProductRoot('PROTECTED_SOURCE_ROOT', `${root} overlaps ${spot.label} ${spot.dir}`);
  }

  if (!fs.existsSync(root)) throw invalidProductRoot('MISSING_ROOT', `${root} does not exist`);
  const siteEntry = path.join(root, PRODUCT_SITE_ENTRY);
  if (!fs.existsSync(siteEntry)) throw invalidProductRoot('MISSING_SITE_ENTRY', `${siteEntry} not found — not a product prefix`);
  let packageJson;
  try {
    packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  } catch (error) {
    throw invalidProductRoot('INVALID_PACKAGE', `package.json unreadable: ${error.message}`);
  }
  if (!packageJson || typeof packageJson.name !== 'string' || !packageJson.name || typeof packageJson.version !== 'string' || !packageJson.version) {
    throw invalidProductRoot('INVALID_PACKAGE', `package.json must carry name and version, got ${JSON.stringify({ name: packageJson && packageJson.name, version: packageJson && packageJson.version })}`);
  }
  return { root, packageJson, siteEntry, engineRoot: path.join(root, '_modules', 'knowledge-engine') };
}

function r91CreateEngineServer(options = {}, engineSourceRoot = ENGINE_SOURCE_ROOT) {
  // Same fail-closed endpoint discipline as the R5 guard, but the module is
  // the R91 source checkout under review (or, under a product root, the
  // prefix's vendored engine).
  const engineServerPath = path.join(engineSourceRoot, 'src', 'server.js');
  if (!fs.existsSync(engineServerPath)) throw new Error(`R91 engine source not found: ${engineServerPath}`);
  assertOwnedEndpoint(options.vectorUrl, { role: 'vectorUrl' });
  if (options.bridge === undefined) assertOwnedEndpoint(options.bridgeUrl, { role: 'bridgeUrl' });
  const { createEngineServer } = require(engineServerPath);
  return createEngineServer(options);
}

function git(cwd, args) {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
  return String(result.stdout || '').trim();
}

/** A real Git repository with real commits: the product imports it for real. */
function makeRepo(root, name, files = { 'README.md': `# ${name}\n` }) {
  const repo = path.join(root, name);
  fs.mkdirSync(repo, { recursive: true });
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.email', 'qa-r91@local.invalid']);
  git(repo, ['config', 'user.name', 'QA R91 Regression']);
  git(repo, ['config', 'commit.gpgsign', 'false']);
  for (const [file, content] of Object.entries(files)) fs.writeFileSync(path.join(repo, file), content, 'utf8');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-qm', 'baseline']);
  return { path: repo, headCommit: git(repo, ['rev-parse', 'HEAD']) };
}

function commitFile(repo, file, content, message = 'follow-up') {
  const full = path.join(repo.path, file);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  // R94: every fixture commit must be MEANINGFUL. Re-committing identical
  // bytes leaves nothing to stage and fails the git assert; instead the file
  // gains a distinct revision line so the repository always moves forward
  // with a real, distinct commit.
  let revision = 0;
  do {
    fs.writeFileSync(full, revision === 0 ? content : `${content}\n// qa-revision-${revision}\n`, 'utf8');
    revision += 1;
  } while (git(repo.path, ['status', '--porcelain']).length === 0 && revision < 50);
  git(repo.path, ['add', '.']);
  git(repo.path, ['commit', '-qm', message]);
  repo.headCommit = git(repo.path, ['rev-parse', 'HEAD']);
  return repo.headCommit;
}

async function startHarness({ tag, evidenceDir, productRoot, viewport = { width: 1600, height: 900 } } = {}) {
  // R99: validate an explicit product root BEFORE isolation and BEFORE any
  // spawn — a bad root fails synchronously here, no child process starts.
  // Without productRoot (option or QA_R91_PRODUCT_ROOT env) the default
  // source-root behaviour is byte-for-byte unchanged.
  const requestedProductRoot = productRoot || PRODUCT_ROOT_ENV || null;
  const product = requestedProductRoot ? resolveProductRoot(requestedProductRoot) : null;
  // Engine source: an explicit QA_R91_ENGINE_SRC always wins; under a product
  // root the default becomes the prefix's vendored engine; otherwise the
  // sibling source checkout (unchanged default).
  const harnessEngineSource = ENGINE_SRC_ENV ? ENGINE_SOURCE_ROOT : (product ? product.engineRoot : ENGINE_SOURCE_ROOT);
  if (product && !fs.existsSync(path.join(harnessEngineSource, 'src', 'server.js'))) {
    throw invalidProductRoot('MISSING_PRODUCT_ENGINE', `no vendored engine under the official prefix: ${path.join(harnessEngineSource, 'src', 'server.js')} (set QA_R91_ENGINE_SRC to override)`);
  }

  const applied = applyDriverIsolation({ prefix: `pk-qa-r91-${tag}`, captureChrome: true });
  const tempRoot = applied.layout.temp;

  const fixture = fs.mkdtempSync(path.join(tempRoot, `pk-qa-r91-${tag}-`));
  const evidence = evidenceDir || path.join(fixture, 'evidence');
  fs.mkdirSync(evidence, { recursive: true });
  const dataDir = path.join(fixture, 'data');
  const knowledgeRoot = path.join(fixture, 'knowledge');
  fs.mkdirSync(knowledgeRoot, { recursive: true });

  const plan = { document: '', memoryCandidates: [] };
  const engineToken = crypto.randomBytes(24).toString('hex');
  const engineVector = createEngineVectorStandin({ label: 'r91-engine-vector' });
  await engineVector.ready;
  const terminal = createModuleFixture({ kind: 'terminal', tag: `${tag}-terminal` });
  const vectorHub = createModuleFixture({ kind: 'vectorHub', tag: `${tag}-vectorhub` });
  const eventBridge = await createEventBridgeStandin({ tag: `${tag}-eventbridge` });
  await terminal.start();
  await vectorHub.start();
  await eventBridge.start();

  const engineDataDir = path.join(fixture, 'engine');
  // R94: `let`, not `const` — restartEngine reassigns this handle so cleanup
  // and every in-process helper always act on the LIVE engine (closing the
  // closed original left the restarted server handle open and hung Node).
  let engine = r91CreateEngineServer({
    dataDir: engineDataDir,
    runtimeToken: engineToken,
    debug: true,
    consume: false,
    analyzer: createMemoryStandinAnalyzer({ plan }),
    vectorUrl: engineVector.url,
    bridgeUrl: eventBridge.url,
  }, harnessEngineSource);
  await engine.ready;
  await new Promise(resolve => engine.server.listen(0, '127.0.0.1', resolve));
  const enginePort = engine.server.address().port;
  assert.equal(LIVE_PORTS.has(enginePort), false, 'the lane engine must never use a live port');
  const engineUrl = `http://127.0.0.1:${enginePort}`;
  const engineProxy = createUpstreamProxy({ target: engineUrl, token: engineToken, tag: 'engine' });
  await engineProxy.start();

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const server = spawnServer({
    // R99: under a product root the SERVER, its cwd and the static UI come
    // from the official prefix; helpers and fixtures stay canonical.
    root: product ? product.root : ROOT,
    port,
    dataDir,
    tag: `qa-r91-${tag}`,
    analysisOwner: 'engine',
    extraEnv: {
      KB_MODULES_REGISTER: '1',
      KB_MODULES_AUTOSTART: '0',
      KB_TERMINAL_URL: terminal.url,
      KB_VECTORHUB_URL: vectorHub.url,
      KB_EVENTBRIDGE_URL: eventBridge.url,
      KB_KNOWLEDGE_ENGINE_URL: engineProxy.url,
    },
  });

  const productApi = async (method, route, body) => {
    const response = await fetch(base + route, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  };

  const engineApi = async (method, route, body) => {
    const response = await fetch(engineUrl + route, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(engineToken ? { Authorization: `Bearer ${engineToken}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  };

  await waitFor(async () => {
    try { return (await productApi('GET', '/api/health')).status === 200; } catch { return false; }
  }, 'the isolated product instance', 30000);
  const settings = await productApi('PATCH', '/api/settings', { knowledge: { rootPath: knowledgeRoot } });
  assert.equal(settings.status, 200, `the isolated instance accepts its own knowledge root: ${JSON.stringify(settings.body)}`);

  let browser = null;
  let network = null;
  try {
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
    await server.cleanup();
    await engineProxy.close();
    await terminal.close();
    await vectorHub.close();
    await eventBridge.close();
    await engine.close().catch(() => {});
    fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    throw error;
  }

  const run = expression => browser.evaluate(expression);
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

  const reload = async () => {
    const startedAt = Date.now();
    await run('window.__pkShellReloadMark = Date.now(), true');
    await browser.send('Page.reload', {});
    await waitFor(
      () => run("document.readyState === 'complete' && typeof window.__pkShellReloadMark === 'undefined' && document.querySelector('.view.active') !== null"),
      'the reloaded page is the fresh document and its boot finished',
      20000,
    );
    return Date.now() - startedAt;
  };

  const selectOption = async (selector, value) => {
    const changed = await run(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return { missing: true };
      el.value = ${JSON.stringify(value)};
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { value: el.value };
    })()`);
    assert.ok(changed && !changed.missing, `the select ${selector} must exist`);
    assert.equal(changed.value, value, `the select ${selector} must accept the value ${value}`);
  };

  const nativeClick = async selector => {
    const probe = await run(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return { missing: true };
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return { invisible: true };
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      const hit = document.elementFromPoint(x, y);
      return { x, y, hitIsTarget: Boolean(hit && (hit === el || el.contains(hit))), label: (el.textContent || '').trim().slice(0, 40) };
    })()`);
    assert.ok(probe && !probe.missing, `the control ${selector} must exist in the page`);
    assert.ok(!probe.invisible, `the control ${selector} must be visible`);
    assert.ok(probe.hitIsTarget, `the control ${selector} must be the hit target; something else is on top`);
    const common = { x: probe.x, y: probe.y, button: 'left', clickCount: 1 };
    await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: probe.x, y: probe.y, button: 'none', clickCount: 0 });
    await browser.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...common });
    await browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...common });
    return probe;
  };

  const typeText = async text => {
    for (const character of String(text)) {
      const upper = character.toUpperCase();
      const isLower = character >= 'a' && character <= 'z';
      const isUpper = character >= 'A' && character <= 'Z';
      const isDigit = character >= '0' && character <= '9';
      const code = isLower ? `Key${upper}` : isUpper ? `Key${character}` : isDigit ? `Digit${character}` : '';
      const keyCode = isLower ? upper.charCodeAt(0) : isUpper || isDigit ? character.charCodeAt(0) : 0;
      const base = { key: character, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode };
      await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base, text: character, unmodifiedText: character });
      await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
    }
  };

  const importProject = async (repo, displayName, { domainId } = {}) => {
    const knowledgePath = path.join(knowledgeRoot, displayName);
    fs.mkdirSync(knowledgePath, { recursive: true });
    const result = await productApi('POST', '/api/projects/import', { localPath: repo.path, knowledgePath, displayName });
    assert.equal(result.status, 201, `the project import must succeed: ${JSON.stringify(result.body)}`);
    const projectId = result.body.projectId;
    if (domainId) {
      const patched = await productApi('PATCH', `/api/projects/${encodeURIComponent(projectId)}`, { domainId });
      assert.equal(patched.status, 200, `the domain binding must succeed: ${JSON.stringify(patched.body)}`);
    }
    return { projectId, project: result.body.project, knowledgePath, modules: result.body.modules };
  };

  const addDomain = async name => {
    const result = await productApi('POST', '/api/domains', { name });
    assert.equal(result.status, 201, `the brain domain must be accepted: ${JSON.stringify(result.body)}`);
    return result.body.domain;
  };

  const brainScopePath = () => {
    const scope = engine.store.state.sharedScopes.find(entry => entry.kind === 'brain');
    assert.ok(scope, 'the engine must know the brain scope');
    return scope.knowledgePath;
  };

  const productMemories = async () => {
    const snapshot = await productApi('GET', '/api/engine/snapshot?summary=1&limit=50');
    assert.equal(snapshot.status, 200, `the product snapshot must be readable: ${JSON.stringify(snapshot.body)}`);
    return snapshot.body.memories || [];
  };

  const injectedMemories = async projectId => {
    const context = await engineApi('POST', '/api/context', { projectId, query: '长期记忆', task: 'qa-r91' });
    assert.equal(context.status, 200, `the engine context must be readable: ${JSON.stringify(context.body)}`);
    return context.body.memories || [];
  };

  const memoryCandidate = ({ text, event, scopeType = 'global' }) => ({
    text,
    quote: text,
    scopeType,
    sourceEventId: event.eventId,
    sourceHash: event.contentHash,
    eligibility: {
      durable: true,
      crossProject: true,
      reason: '人工明确表达的长期偏好',
      scopeReason: scopeType === 'global' ? '适用于所有领域与项目' : '适用于指定领域',
    },
  });

  const ingestUserEvent = async ({ projectId, commitSha, content, inputOrigin = 'human' }) => {
    const id = `event-${crypto.randomUUID()}`;
    const turn = `turn-${crypto.randomUUID()}`;
    const result = await engine.coordinator.conversations.appendEvent(projectId, {
      eventId: id,
      sequence: 1,
      source: 'claude-code',
      eventType: 'user_prompt',
      role: 'user',
      inputOrigin,
      content,
      sessionId: `session-${projectId}`,
      turnId: turn,
      capturedAt: new Date().toISOString(),
      identityConfidence: 'exact',
      explicitCommitSha: commitSha,
    });
    return { eventId: id, turnId: turn, contentHash: result.event.contentHash, inputOrigin: result.event.inputOrigin };
  };

  const triggerRun = async (projectId, commitSha, timeoutMs = 60000) => {
    const started = await engineApi('POST', '/api/runs', { projectId, commitSha });
    assert.equal(started.status, 200, `the run must be accepted: ${JSON.stringify(started.body)}`);
    const runId = started.body.run.runId;
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
      const current = await engineApi('GET', `/api/runs/${encodeURIComponent(runId)}`);
      last = current.body && current.body.run;
      if (last && ['succeeded', 'failed'].includes(last.state)) {
        if (last.state === 'failed') throw new Error(`the run failed: ${JSON.stringify(last.error)}`);
        return last;
      }
      if (last && last.promotedAt && last.memoryCapture) return last;
      await wait(150);
    }
    throw new Error(`the run did not finish in time: ${JSON.stringify(last)}`);
  };

  const produceCandidate = async ({ repo, projectId, text, scopeType = 'global', file = 'src/candidate.js' }) => {
    const head = commitFile(repo, file, `// ${text}\n`, 'candidate commit');
    const event = await ingestUserEvent({ projectId, commitSha: head, content: `人工要求：${text}` });
    plan.document = `# 冻结证据\n\n${text}\n`;
    plan.memoryCandidates = [memoryCandidate({ text, event, scopeType })];
    const run = await triggerRun(projectId, head);
    return { run, event, commitSha: head, capture: run.memoryCapture };
  };

  // Restart the in-process engine on its own data dir and port: the shell's
  // proxy keeps its target, so the browser sees a real engine restart.
  // R94: the handle is REASSIGNED, so cleanup()/brainScopePath() always act
  // on the live restarted engine, never on the already-closed original.
  const restartEngine = async () => {
    await engine.close();
    engine = r91CreateEngineServer({
      dataDir: engineDataDir,
      runtimeToken: engineToken,
      debug: true,
      consume: false,
      analyzer: createMemoryStandinAnalyzer({ plan }),
      vectorUrl: engineVector.url,
      bridgeUrl: eventBridge.url,
    }, harnessEngineSource);
    await engine.ready;
    await new Promise(resolve => engine.server.listen(enginePort, '127.0.0.1', resolve));
    return engine;
  };

  // R94: every cleanup step is bounded. A wedged child or an uncooperative
  // close used to turn the whole driver into an unkillable lane process (the
  // Node 17840 hang was exactly this); each step now gets a deadline and a
  // failure is reported instead of blocking the teardown forever.
  const cleanupStep = async (label, task, deadlineMs = 15000) => {
    let timer = null;
    try {
      await Promise.race([
        Promise.resolve().then(task).catch(error => { console.error(`[qa-r91-harness] cleanup step ${label} failed:`, error && error.message); }),
        new Promise(resolve => { timer = setTimeout(resolve, deadlineMs); if (typeof timer.unref === 'function') timer.unref(); }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };

  const cleanup = async () => {
    await cleanupStep('browser', () => browser?.close() || Promise.resolve());
    await cleanupStep('server', () => server.cleanup());
    await cleanupStep('engineProxy', () => engineProxy.close());
    await cleanupStep('terminal', () => terminal.close());
    await cleanupStep('vectorHub', () => vectorHub.close());
    await cleanupStep('eventBridge', () => eventBridge.close());
    await cleanupStep('engine', () => engine.close());
    await cleanupStep('engineVector', () => engineVector.close());
    fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  };

  return {
    fixture, evidence, dataDir, knowledgeRoot, tempRoot, plan,
    base, server, productApi, engineApi, engineUrl, enginePort, engineProxy, engineDataDir,
    terminal, vectorHub, eventBridge, engineVector,
    // R94: a getter, not a snapshot — harness.engine always resolves to the
    // LIVE engine handle after restartEngine().
    get engine() { return engine; },
    browser, run, wait, waitFor, network, reload,
    selectOption, nativeClick, typeText,
    importProject, addDomain, ingestUserEvent, triggerRun,
    brainScopePath, productMemories, injectedMemories,
    memoryCandidate, produceCandidate, restartEngine,
    cleanup,
  };
}

module.exports = { startHarness, makeRepo, commitFile, resolveProductRoot, ROOT, ENGINE_SOURCE_ROOT, REAL_ENV_MARKERS, PRODUCT_SITE_ENTRY };
