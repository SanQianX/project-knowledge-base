'use strict';
// _site/_test/helpers/parallel-memory-shell.js
//
// Lane harness for the P-MEMORY-01 memory lane.
//
// Every case runs against a real, isolated product instance:
//   * its own port, data dir, knowledge root and Bridge journal home (the
//     shared spawn-server helper already isolates those);
//   * the REAL vendored knowledge engine, in-process, with a declared
//     stand-in analyzer (helpers/parallel-memory-analyzer.js) that only
//     replaces the model step;
//   * a pass-through proxy in front of the engine, so the product's own
//     runtime token reaches the engine the way it does in production;
//   * real HTTP module services for terminal / vector-hub / event-bridge;
//   * a real Chrome (CDP) in its own profile.
//
// Nothing here reaches the developer's live 5757/5790/8787/8790 endpoints,
// the real HOME, the real knowledge directories or the real memories.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
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

const ROOT = path.resolve(__dirname, '../../..');
const ENGINE_ENTRY = path.join(ROOT, '_modules', 'knowledge-engine', 'src', 'server.js');
const LIVE_PORTS = new Set([5757, 5790, 8787, 8790]);

function isInside(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * The lane temp root. It must live outside the repository: the knowledge
 * fixture refuses an in-repo temp root, and the lane rule is that every
 * artefact of a test lives outside the checkout.
 */
function resolveTempRoot() {
  const chosen = process.env.PK_TEST_TEMP_ROOT || process.env.TEMP || process.env.TMP || process.env.TMPDIR || os.tmpdir();
  const root = path.resolve(String(chosen));
  if (isInside(root, ROOT)) throw new Error(`refusing to use a temp root inside the repository: ${root}`);
  return root;
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
  git(repo, ['config', 'user.email', 'parallel-memory@local.invalid']);
  git(repo, ['config', 'user.name', 'Parallel Memory Regression']);
  git(repo, ['config', 'commit.gpgsign', 'false']);
  for (const [file, content] of Object.entries(files)) fs.writeFileSync(path.join(repo, file), content, 'utf8');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-qm', 'baseline']);
  return { path: repo, headCommit: git(repo, ['rev-parse', 'HEAD']) };
}

/**
 * A real follow-up commit in an existing repository.
 *
 * The engine registers a project with `trackingStartCommit` set to the commit
 * that was HEAD at import time, and it treats a run for that very commit as
 * already analysed. A maintenance run therefore has to target a commit that
 * was made after the import — exactly the production flow.
 */
function commitFile(repo, file, content, message = 'follow-up') {
  const full = path.join(repo.path, file);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');
  git(repo.path, ['add', '.']);
  git(repo.path, ['commit', '-qm', message]);
  repo.headCommit = git(repo.path, ['rev-parse', 'HEAD']);
  return repo.headCommit;
}

async function startHarness({ tag, evidenceDir, viewport = { width: 1600, height: 900 } } = {}) {
  const tempRoot = resolveTempRoot();
  fs.mkdirSync(tempRoot, { recursive: true });
  // The shared spawn-server helper and every other lane helper create their
  // directories with os.tmpdir(); point that at the lane temp root so nothing
  // is written inside the checkout.
  process.env.TEMP = tempRoot;
  process.env.TMP = tempRoot;
  process.env.TMPDIR = tempRoot;

  const fixture = fs.mkdtempSync(path.join(tempRoot, `pk-parallel-memory-${tag}-`));
  const evidence = evidenceDir || path.join(fixture, 'evidence');
  fs.mkdirSync(evidence, { recursive: true });
  const dataDir = path.join(fixture, 'data');
  const knowledgeRoot = path.join(fixture, 'knowledge');
  fs.mkdirSync(knowledgeRoot, { recursive: true });

  const plan = { document: '', memoryCandidates: [] };
  const engineToken = crypto.randomBytes(24).toString('hex');
  const { createEngineServer } = require(ENGINE_ENTRY);
  const engine = createEngineServer({
    dataDir: path.join(fixture, 'engine'),
    runtimeToken: engineToken,
    debug: true,
    consume: false,
    analyzer: createMemoryStandinAnalyzer({ plan }),
  });
  await engine.ready;
  await new Promise(resolve => engine.server.listen(0, '127.0.0.1', resolve));
  const engineUrl = `http://127.0.0.1:${engine.server.address().port}`;
  assert.equal(LIVE_PORTS.has(engine.server.address().port), false, 'the lane engine must never use a live port');
  const engineProxy = createUpstreamProxy({ target: engineUrl, token: engineToken, tag: 'engine' });
  await engineProxy.start();

  const terminal = createModuleFixture({ kind: 'terminal', tag: `${tag}-terminal` });
  const vectorHub = createModuleFixture({ kind: 'vectorHub', tag: `${tag}-vectorhub` });
  // The shared event-bridge fixture answers with `bridge-1`, a journal id the
  // engine rejects, so the project never reaches the engine. This lane uses
  // its own stand-in that derives the real `sha256:` workspace id.
  const eventBridge = await createEventBridgeStandin({ tag: `${tag}-eventbridge` });
  await terminal.start();
  await vectorHub.start();
  await eventBridge.start();

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const server = spawnServer({
    root: ROOT,
    port,
    dataDir,
    tag: `parallel-memory-${tag}`,
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

  /** Ask the shell to read the project registry again. */
  const requestRegistryRefresh = () => run("document.dispatchEvent(new Event('visibilitychange'))");

  /** A real page reload, so "it survives a refresh" is proven by the browser. */
  const reload = async () => {
    await browser.send('Page.reload', {});
    await waitFor(() => run("document.readyState === 'complete'"), 'the page reload', 20000);
  };

  const pressBackspace = async (count = 1) => {
    for (let index = 0; index < count; index += 1) await pressKey('Backspace', { code: 'Backspace', keyCode: 8 });
  };

  /** Set a select's value and fire the real change event the shell listens to. */
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

  /** A native pointer click: the hit test runs first and must resolve to the target. */
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

  const pressKey = async (key, { code, keyCode, text } = {}) => {
    const base = { key, code: code || key, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode };
    await browser.send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', ...base, text });
    await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  };
  const pressTab = () => pressKey('Tab', { code: 'Tab', keyCode: 9 });
  const pressEnter = () => pressKey('Enter', { code: 'Enter', keyCode: 13, text: '\r' });

  /** Type into a focused field with real key events. */
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

  /** Import a real project through the real product API. */
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

  /** Add a real domain to the brain of the isolated instance. */
  const addDomain = async name => {
    const result = await productApi('POST', '/api/domains', { name });
    assert.equal(result.status, 201, `the brain domain must be accepted: ${JSON.stringify(result.body)}`);
    return result.body.domain;
  };

  /** The knowledge directory the engine uses for the brain scope. */
  const brainScopePath = () => {
    const scope = engine.store.state.sharedScopes.find(entry => entry.kind === 'brain');
    assert.ok(scope, 'the engine must know the brain scope');
    return scope.knowledgePath;
  };

  /** The knowledge directory the engine uses for one domain scope. */
  const domainScopePath = domainId => {
    const scope = engine.store.state.sharedScopes.find(entry => entry.kind === 'domain' && entry.id === domainId);
    assert.ok(scope, `the engine must know the domain scope ${domainId}`);
    return scope.knowledgePath;
  };

  /** Every memory the product's own snapshot endpoint serves. */
  const productMemories = async () => {
    const snapshot = await productApi('GET', '/api/engine/snapshot?summary=1&limit=50');
    assert.equal(snapshot.status, 200, `the product snapshot must be readable: ${JSON.stringify(snapshot.body)}`);
    return snapshot.body.memories || [];
  };

  /** The memories the engine would inject into a task for one project. */
  const injectedMemories = async projectId => {
    const context = await engineApi('POST', '/api/context', { projectId, query: '长期记忆', task: 'memory-lane' });
    assert.equal(context.status, 200, `the engine context must be readable: ${JSON.stringify(context.body)}`);
    return context.body.memories || [];
  };

  /**
   * A memory candidate that satisfies the engine's own provenance gate: it
   * quotes the real human event, the quote contains the memory text, and it
   * declares why the text is a durable, cross-project owner preference.
   */
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

  /**
   * Drive the real pipeline to a candidate: a real follow-up commit, a real
   * conversation event bound to it, the stand-in analyzer's manifest and the
   * engine's own promotion and capture.
   */
  const produceCandidate = async ({ repo, projectId, text, scopeType = 'global', inputOrigin = 'human', file = 'src/candidate.js' }) => {
    const head = commitFile(repo, file, `// ${text}\n`, 'candidate commit');
    const event = await ingestUserEvent({
      projectId,
      commitSha: head,
      content: `人工要求：${text}`,
      inputOrigin,
    });
    plan.document = `# 冻结证据\n\n${text}\n`;
    plan.memoryCandidates = [memoryCandidate({ text, event, scopeType })];
    const run = await triggerRun(projectId, head);
    return { run, event, commitSha: head, capture: run.memoryCapture };
  };

  /**
   * Append a real conversation event to the engine's own conversation store.
   * The engine's own binder freezes it into the commit snapshot, and the
   * engine's own eligibility gate reads its inputOrigin.
   */
  const ingestUserEvent = async ({ projectId, commitSha, content, inputOrigin = 'human', turnId, eventId }) => {
    const id = eventId || `event-${crypto.randomUUID()}`;
    const turn = turnId || `turn-${crypto.randomUUID()}`;
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

  /** Run the real maintenance pipeline for a commit and wait for the run. */
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

  const cleanup = async () => {
    await browser?.close();
    await server.cleanup();
    await engineProxy.close();
    await terminal.close();
    await vectorHub.close();
    await eventBridge.close();
    await engine.close().catch(() => {});
    fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  };

  return {
    fixture, evidence, dataDir, knowledgeRoot, tempRoot, plan,
    base, server, productApi, engineApi, engine, engineUrl, engineProxy,
    terminal, vectorHub, eventBridge,
    browser, run, wait, waitFor, network,
    requestRegistryRefresh, reload, pressBackspace, selectOption,
    nativeClick, pressKey, pressTab, pressEnter, typeText,
    importProject, addDomain, ingestUserEvent, triggerRun,
    brainScopePath, domainScopePath, productMemories, injectedMemories,
    memoryCandidate, produceCandidate,
    cleanup,
  };
}

module.exports = { startHarness, makeRepo, commitFile, ROOT };
