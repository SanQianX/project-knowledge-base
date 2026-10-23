// _site/_test/helpers/parallel-nav-shell.js
//
// Shared harness for the P-TEST-NAV regressions (NAV-002/004/005/006/007/008).
//
// Every case runs against a real, isolated product instance:
//   * its own port, data dir, knowledge root and Bridge journal home
//     (the shared spawn-server helper already isolates those);
//   * the REAL vendored knowledge engine on its own port, reached through a
//     pass-through proxy, so snapshots and runs are real engine state;
//   * a test double for the embedded module UI, so the shell really talks
//     the kb:* protocol to a real frame;
//   * a real Chrome (CDP) in its own profile, reaching the product through a
//     pass-through proxy that can hold or fail a single answer.
//
// The harness owns the native-input helpers: pointer clicks and key presses
// go through CDP Input events, never through element.click(), and every
// pointer click proves the hit test first (document.elementFromPoint must
// return the target, so a transparent overlay cannot fake a click).

'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { spawnServer } = require('../helpers/spawn-server');
const { findChrome } = require('../helpers/find-chrome');
const { launchCdpBrowser, waitFor } = require('../helpers/cdp-browser');
const { attachNetworkCapture } = require('../helpers/cdp-network-capture');
const { createUpstreamProxy } = require('../helpers/module-fixture');
const { createNavProductProxy } = require('./parallel-nav-proxy');
const { createModuleUiFixture } = require('./parallel-nav-module-ui');
const { enterNavIsolation } = require('./parallel-nav-isolation-env');
const freePort = require('../helpers/free-port');

const ROOT = path.resolve(__dirname, '../../..');
const ENGINE_ENTRY = path.join(ROOT, '_modules', 'knowledge-engine', 'src', 'server.js');

const THEMES = ['light', 'dark'];

function git(cwd, args) {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
  return String(result.stdout || '').trim();
}

/** A real Git repository with one real commit: the product imports it for real. */
function makeRepo(root, name) {
  const repo = path.join(root, name);
  fs.mkdirSync(repo, { recursive: true });
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.email', 'parallel-nav@local.invalid']);
  git(repo, ['config', 'user.name', 'Parallel NAV Regression']);
  fs.writeFileSync(path.join(repo, 'README.md'), `# ${name}\n`);
  git(repo, ['add', '.']);
  git(repo, ['commit', '-qm', 'baseline']);
  return { path: repo, headCommit: git(repo, ['rev-parse', 'HEAD']) };
}

/**
 * Boot the isolated product instance, the real engine, the module-UI double
 * and a real browser. The caller owns the cleanup through `harness.cleanup()`.
 */
async function startHarness({ tag, viewport = { width: 1920, height: 1080 }, evidenceDir, withEngine = true, browserDirect = false } = {}) {
  // R7 incident premise: Chrome resolves under the REAL environment (read-only
  // discovery) BEFORE isolation; the engine entry and every child load AFTER
  // the driver enters the explicit environment whitelist.
  const chromeExec = findChrome();
  const isolation = enterNavIsolation({ tag: `pk-parallel-nav-${tag}` });
  const fixture = isolation.root;
  const evidence = evidenceDir || path.join(fixture, 'evidence');
  fs.mkdirSync(evidence, { recursive: true });
  const dataDir = path.join(fixture, 'data');
  const knowledgeRoot = path.join(fixture, 'knowledge');
  fs.mkdirSync(knowledgeRoot, { recursive: true });

  const handles = { fixture, evidence, dataDir, knowledgeRoot };
  let engine = null;
  let engineProxy = null;
  let engineToken = null;
  let engineUrl = null;

  // The vector stand-in starts BEFORE the engine: the engine constructor gets
  // its URL explicitly, so its built-in default (127.0.0.1:8787 — a LIVE
  // desktop hub here) is never reachable (R7 root-cause fix).
  const moduleUi = createModuleUiFixture({ tag: `${tag}-module-ui` });
  await moduleUi.start();

  if (withEngine) {
    engineToken = crypto.randomBytes(24).toString('hex');
    const { createEngineServer } = require(ENGINE_ENTRY);
    engine = createEngineServer({ dataDir: path.join(fixture, 'engine'), runtimeToken: engineToken, debug: true, consume: false, vectorUrl: moduleUi.url, bridgeUrl: moduleUi.url });
    assert.equal(engine.coordinator.vectorUrl, moduleUi.url, 'the engine must run against the lane vector stand-in, never its 8787 default');
    assert.equal(engine.coordinator.bridge.url, moduleUi.url, 'the engine bridge must use the lane stand-in even if a case enables consumption');
    await engine.ready;
    await new Promise(resolve => engine.server.listen(0, '127.0.0.1', resolve));
    engineUrl = `http://127.0.0.1:${engine.server.address().port}`;
    engineProxy = createUpstreamProxy({ target: engineUrl, token: engineToken, tag: 'engine' });
    await engineProxy.start();
  }

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const server = spawnServer({
    root: ROOT,
    port,
    dataDir,
    tag: `parallel-nav-${tag}`,
    analysisOwner: 'engine',
    extraEnv: {
      KB_MODULES_REGISTER: '1',
      KB_MODULES_AUTOSTART: '0',
      KB_TERMINAL_URL: moduleUi.url,
      KB_VECTORHUB_URL: moduleUi.url,
      KB_EVENTBRIDGE_URL: moduleUi.url,
      ...(engineProxy ? { KB_KNOWLEDGE_ENGINE_URL: engineProxy.url } : {}),
    },
  });

  const productProxy = createNavProductProxy({ target: base, tag: `parallel-nav-${tag}` });
  await productProxy.start();

  const api = async (method, route, body) => {
    const response = await fetch(base + route, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  const engineApi = async (method, route, body) => {
    if (!engineUrl) throw new Error('the harness runs without the engine');
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
    try { return (await api('GET', '/api/health')).status === 200; } catch { return false; }
  }, 'the isolated product instance', 30000);
  const settings = await api('PATCH', '/api/settings', { knowledge: { rootPath: knowledgeRoot } });
  assert.equal(settings.status, 200, `the isolated instance accepts its own knowledge root: ${JSON.stringify(settings.body)}`);

  let browser = null;
  try {
    browser = await launchCdpBrowser({
      chrome: chromeExec,
      profileDir: path.join(fixture, 'browser'),
      // The live channel is a WebSocket upgrade: a plain HTTP proxy cannot
      // carry it, so a case that needs the real live stream talks to the
      // product directly and emulates the network failure in the browser.
      url: (browserDirect ? base : productProxy.url) + '/',
      width: viewport.width,
      height: viewport.height,
    });
    await browser.setViewport(viewport.width, viewport.height);
    await browser.send('Network.enable');
  } catch (error) {
    await server.cleanup();
    await productProxy.close();
    await moduleUi.close();
    if (engineProxy) await engineProxy.close();
    if (engine) await engine.close().catch(() => {});
    fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    isolation.restore();
    throw error;
  }

  const capture = attachNetworkCapture(browser);
  await capture.enable();

  const run = expression => browser.evaluate(expression);
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

  /** Import a real project through the real product API. */
  const importProject = async (repo, displayName) => {
    const knowledgePath = path.join(knowledgeRoot, displayName);
    fs.mkdirSync(knowledgePath, { recursive: true });
    const result = await api('POST', '/api/projects/import', { localPath: repo.path, knowledgePath, displayName });
    assert.equal(result.status, 201, `the project import must succeed: ${JSON.stringify(result.body)}`);
    return { projectId: result.body.projectId, project: result.body.project, knowledgePath };
  };

  /**
   * A native pointer click: the hit test runs first and must resolve to the
   * target, so no transparent layer can stand in for a real click.
   */
  const nativeClick = async (selector, { expectHit = true } = {}) => {
    const probe = await run(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return { missing: true };
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return { invisible: true, rect: { width: rect.width, height: rect.height } };
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      const hit = document.elementFromPoint(x, y);
      return {
        x, y,
        width: rect.width, height: rect.height,
        hitTag: hit ? hit.tagName : '',
        hitId: hit && hit.id ? hit.id : '',
        hitClass: hit && hit.className && typeof hit.className === 'string' ? hit.className : '',
        hitIsTarget: Boolean(hit && (hit === el || el.contains(hit))),
        label: (el.textContent || '').trim().slice(0, 40),
      };
    })()`);
    assert.ok(probe && !probe.missing, `the control ${selector} must exist in the page`);
    assert.ok(!probe.invisible, `the control ${selector} must be visible: ${JSON.stringify(probe)}`);
    if (expectHit) {
      assert.ok(probe.hitIsTarget, `the control ${selector} must be the hit target at (${probe.x}, ${probe.y}); something else is on top: ${probe.hitTag}#${probe.hitId}.${probe.hitClass}`);
    }
    const common = { x: probe.x, y: probe.y, button: 'left', clickCount: 1 };
    await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: probe.x, y: probe.y, button: 'none', clickCount: 0 });
    await browser.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...common });
    await browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...common });
    return probe;
  };

  /** A native key press (raw key events, no synthesized DOM events). */
  const pressKey = async (key, { code, keyCode, text } = {}) => {
    const base = { key, code: code || key, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode };
    await browser.send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', ...base, text });
    await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  };

  const pressTab = () => pressKey('Tab', { code: 'Tab', keyCode: 9 });
  const pressEnter = () => pressKey('Enter', { code: 'Enter', keyCode: 13, text: '\r' });

  /** The real browser network goes offline / online (CDP, not a mock). */
  const setOffline = async offline => {
    await browser.send('Network.emulateNetworkConditions', {
      offline,
      latency: 0,
      downloadThroughput: offline ? 0 : -1,
      uploadThroughput: offline ? 0 : -1,
    });
  };

  const setViewport = (width, height) => browser.setViewport(width, height);

  /**
   * The kb:* messages one embedded frame really received, in order. The
   * module double records them inside the frame, so this is the protocol
   * traffic itself and not a shell-side guess.
   */
  const frameMessages = id => run(`(() => {
    const frame = document.getElementById(${JSON.stringify(id)});
    const messages = frame && frame.contentWindow && frame.contentWindow.__navMessages;
    if (!Array.isArray(messages)) return null;
    return messages.map(entry => ({
      type: String(entry.type || ''),
      theme: entry.payload ? entry.payload.theme : undefined,
      visible: entry.payload ? entry.payload.visible : undefined,
      project: entry.payload ? entry.payload.project : undefined,
      projectId: entry.payload ? entry.payload.projectId : undefined,
      requestId: entry.payload ? entry.payload.requestId : undefined,
    }));
  })()`);

  /** The number of embedded-UI documents the module double really served. */
  const modulePageLoads = () => moduleUi.pageLoads();

  /**
   * Ask the shell to read the registry again, through the real event the
   * shell itself listens for when the page becomes visible.
   */
  const requestRegistryRefresh = () => run("document.dispatchEvent(new Event('visibilitychange'))");

  /**
   * Make the shell read the registry again and wait until a new registry
   * read really left the browser. The shell joins a registry read that is
   * already running, so the visibility event is repeated until a new read
   * shows up in the proxy.
   */
  const refreshRegistryAndWait = async (match = entry => entry.path.startsWith('/api/projects/projection'), timeoutMs = 20000) => {
    const before = productProxy.requests.filter(match).length;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await requestRegistryRefresh();
      await wait(300);
      const now = productProxy.requests.filter(match).length;
      if (now > before) return now;
    }
    throw new Error('the shell did not read the registry again');
  };

  /**
   * The engine's vector traffic stayed inside this run: every /api/sync and
   * /api/import body the stand-in received must name a sourceDir inside the
   * fixture root. The stand-in is the ONLY vector endpoint the engine can
   * reach (constructor vectorUrl + whitelisted env), so this proves the run
   * never touched the real 8787 hub's write surface.
   */
  const assertVectorIsolation = () => {
    const calls = [...moduleUi.vectorSyncs(), ...moduleUi.vectorImports()];
    const violations = [];
    for (const entry of calls) {
      const sourceDir = entry.body && entry.body.sourceDir;
      if (!sourceDir) continue;
      const inside = sourceDir === fixture || sourceDir.startsWith(fixture + path.sep);
      if (!inside) violations.push({ path: entry.path, sourceDir });
    }
    assert.deepEqual(violations, [], `vector calls must stay inside the fixture root (${fixture})`);
    return { calls: calls.length, bodies: calls.map(entry => entry.body), violations };
  };

  const cleanup = async () => {
    await browser?.close();
    await server.cleanup();
    await productProxy.close();
    await moduleUi.close();
    if (engineProxy) await engineProxy.close();
    if (engine) await engine.close().catch(() => {});
    fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    isolation.restore();
  };

  return {
    ...handles,
    base,
    server,
    productProxy,
    moduleUi,
    engine,
    engineUrl,
    engineApi,
    engineProxy,
    api,
    browser,
    capture,
    run,
    wait,
    waitFor,
    importProject,
    nativeClick,
    pressKey,
    pressTab,
    pressEnter,
    setOffline,
    setViewport,
    frameMessages,
    modulePageLoads,
    requestRegistryRefresh,
    refreshRegistryAndWait,
    assertVectorIsolation,
    isolation,
    cleanup,
  };
}

module.exports = { startHarness, makeRepo, THEMES, ROOT };
