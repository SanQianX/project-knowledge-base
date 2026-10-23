'use strict';
// P-WB-QA-INTEGRATION-5025 runtime harness — the canonical harness for the
// REAL-MODEL Workbench tools (WB-003 / WB-004 / WB-008 canonical copies),
// carried forward from the accepted lane harness
// (helpers/parallel-workbench-runtime-harness.js, frozen untracked) with
// exactly the integration changes:
//   * layouts and child environments come from the canonical
//     integration-5025 fixture: portable temp roots (PK_TEST_TEMP_ROOT → the
//     shared root next to the repo when it exists → TEMP/TMP/TMPDIR → the OS
//     temp dir, never inside the repo), the FULL R5 env whitelist
//     (APPDATA/LOCALAPPDATA/CODEX_HOME included) and the Chrome >= 136
//     default-dir scaffold, all under a per-run owner root;
//   * the host child is still the FROZEN TRACKED host
//     (helpers/parallel-workbench-host.js): the real subscription profile is
//     served through its read-only facade, with the real profile directory
//     passed explicitly (PK_WB_REAL_PROFILE_DIR, resolved from the real
//     environment or the explicit override) because the isolated HOME hides
//     the original location; the credential stays in the host's memory;
//   * openBrowser accepts an explicit chrome path ONLY — resolved with the
//     real environment (or the safe runner's capture) BEFORE any isolation;
//     a post-isolation browser discovery is refused. P-WB-CANONICAL-R2:
//     every probe entry now goes through the canonical launcher boot (gates →
//     read-only discovery → full driver isolation → carried-through captures),
//     so the DRIVER process itself and every child below it run on the full
//     R5 whitelist; the installed-product identity label resolves from the
//     pre-isolation capture and can no longer degrade to a repository pin.
//
// Everything else is the accepted harness verbatim: it drives the REAL
// agent-terminal UI in a REAL browser against the REAL module; the recorder
// logs every event the product receives, verbatim — it never filters,
// reorders or repairs anything; whether a stale event is honoured or dropped
// is decided by the product, not by the driver.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const fixture = require('./parallel-workbench-integration-5025-fixture');
const sourceMap = require('./parallel-workbench-source-map');
const { launchCdpBrowser } = require('./cdp-browser');

const API_BASE = '/api/claude-workbench/v1';

function sha256File(file) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); } catch { return null; }
}

// The real profile directory for the read-only facade, resolved with the REAL
// environment (before any isolation). An explicit override keeps the tool
// portable across machines; the default is the product's own convention.
function realProfileDir(options = {}) {
  const override = String(options.realProfileDir || process.env.PK_WB_REAL_PROFILE_DIR || '').trim();
  return override ? path.resolve(override) : fixture.realWorkbenchProfileDir();
}

// Installed in the page before any product script runs. It wraps EventSource
// so that every delivered event is recorded, and it exposes a replay that
// re-delivers a recorded event to the same stream.
const RECORDER_SOURCE = `
(function () {
  if (window.__wbRecorder) return;
  var Native = window.EventSource;
  var recorder = { log: [], streams: [] };
  window.__wbRecorder = recorder;
  function RecordingEventSource(url, init) {
    var stream = new Native(url, init);
    recorder.streams.push({ stream: stream, url: String(url) });
    var nativeAdd = stream.addEventListener.bind(stream);
    stream.addEventListener = function (type, fn, options) {
      if (typeof fn === 'function' && type !== 'message') {
        var wrapped = function (event) {
          try { recorder.log.push({ type: event.type, data: String(event.data), at: Date.now() }); } catch (error) {}
          return fn.call(stream, event);
        };
        return nativeAdd(type, wrapped, options);
      }
      return nativeAdd(type, fn, options);
    };
    return stream;
  }
  RecordingEventSource.prototype = Native.prototype;
  window.EventSource = RecordingEventSource;
  window.__wbReplay = function (index, urlPattern) {
    var entry = recorder.log[index];
    if (!entry) return { replayed: false, reason: 'no recorded event at that index' };
    var delivered = 0;
    for (var i = 0; i < recorder.streams.length; i++) {
      var target = recorder.streams[i];
      if (urlPattern && target.url.indexOf(urlPattern) < 0) continue;
      try {
        target.stream.dispatchEvent(new MessageEvent(entry.type, { data: entry.data, lastEventId: '' }));
        delivered += 1;
      } catch (error) {}
    }
    return { replayed: true, type: entry.type, delivered: delivered, urlPattern: urlPattern || null };
  };
})();
`;

function wait(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function waitUntil(fn, label, timeoutMs = 30000, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
      last = value;
    } catch (error) { last = error && error.message; }
    await wait(intervalMs);
  }
  const detail = last === undefined ? '' : ` (last: ${typeof last === 'string' ? last : JSON.stringify(last)})`;
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}${detail}`);
}

async function getJson(url, options) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(30000) });
  const body = await response.json().catch(() => null);
  return { status: response.status, ok: response.ok, body };
}

// --- the isolated host ----------------------------------------------------

async function startHost(options = {}) {
  const moduleRoot = options.moduleRoot || fixture.resolveHostModuleRoot();
  if (!moduleRoot) throw new Error('no claude-ai-workbench module copy was found to host');
  // A restart of the SAME host keeps the layout (data dir, browser profile)
  // and may keep the port, so the page origin — and with it the browser
  // storage the product uses for drafts — stays the same.
  const layout = options.layout || fixture.createIsolationLayout(options.prefix || 'parallel-wb-integration-5025-rt');
  const port = options.port || await fixture.freePort();
  const base = `http://127.0.0.1:${port}`;
  const profileSource = options.profileSource || 'real-readonly';
  const child = fixture.spawnNode([path.join(__dirname, 'parallel-workbench-host.js')], fixture.hostEnv(layout, {
    PK_WB_MODULE_ROOT: moduleRoot,
    PK_WB_HOST_PORT: String(port),
    PK_WB_HOST_DATA_DIR: layout.dataDir,
    PK_WB_HOST_WORKSPACE: layout.workspace,
    PK_WB_HOST_MODE: options.mode || 'standalone',
    PK_WB_PROFILE_SOURCE: profileSource,
    ...(profileSource === 'real-readonly' ? { PK_WB_REAL_PROFILE_DIR: realProfileDir(options) } : {}),
    ...(options.engineUrl ? { PK_WB_ENGINE_URL: options.engineUrl } : {}),
  }));
  await fixture.waitForHttp(`${base}${API_BASE}/health`, 30000);
  return { layout, moduleRoot, port, base, child };
}

async function stopHost(host) {
  if (!host || !host.child) return;
  host.child.child.kill();
  await host.child.exited;
}

// --- the real browser -----------------------------------------------------

async function openBrowser(base, layout, options = {}) {
  // Chrome must have been resolved with the REAL environment before the
  // launcher boot isolated this process (the boot carries it through as the
  // explicit PK_WB_CHROME). Discovering a browser from the isolated
  // environment would violate the discovery-before-isolation contract.
  const chrome = options.chrome
    || (String(process.env.PK_WB_CHROME || '').trim() ? path.resolve(process.env.PK_WB_CHROME) : null);
  if (!chrome) {
    throw new Error('openBrowser requires a Chrome path captured before isolation — pass options.chrome from the launcher boot discovery');
  }
  const profileDir = path.join(layout.root, 'browser-profile');
  const browser = await launchCdpBrowser({
    chrome,
    profileDir,
    url: 'about:blank',
    width: 1360,
    height: 900,
    launchAttempts: 2,
  });
  await browser.send('Page.addScriptToEvaluateOnNewDocument', { source: RECORDER_SOURCE });
  const target = `${base}/agent-terminal/?apiBase=${encodeURIComponent(API_BASE)}`;
  await browser.send('Page.navigate', { url: target });
  await waitUntil(
    async () => browser.evaluate("document.readyState === 'complete' && !!window.__wbRecorder && !!document.getElementById('chat-input')"),
    'the agent terminal page',
    30000,
  );
  return { browser, chrome, profileDir, target };
}

async function reloadPage(browser) {
  await browser.send('Page.reload', { ignoreCache: false });
  await waitUntil(
    async () => browser.evaluate("document.readyState === 'complete' && !!window.__wbRecorder && !!document.getElementById('chat-input')"),
    'the reloaded agent terminal page',
    30000,
  );
  // The product script defines its own `state`; the page is only usable once
  // that global exists, not merely when the document finished loading.
  await waitUntil(
    async () => browser.evaluate("typeof state !== 'undefined' && !!state"),
    'the product state of the reloaded page',
    30000,
  );
}

// --- the product's own state, read from the page --------------------------

const READ_STATE = `(() => {
  const send = document.getElementById('btn-send');
  const status = document.getElementById('session-status');
  const statusText = document.getElementById('session-status-text');
  const col = document.getElementById('stream-col');
  const input = document.getElementById('chat-input');
  const tray = document.querySelector('.composer .attach-tray');
  const modelLabel = document.getElementById('model-label');
  const activeProj = document.querySelector('#project-list .proj.active');
  return {
    sendTitle: send ? send.title : null,
    busy: send ? send.title === '停止' : null,
    statusHidden: status ? status.hidden : null,
    statusText: statusText ? statusText.textContent : null,
    inputValue: input ? input.value : null,
    inputDisabled: input ? input.disabled : null,
    streamText: col ? col.textContent : '',
    assistantMessages: col ? Array.from(col.querySelectorAll('.msg.ai')).map(node => node.textContent) : [],
    userMessages: col ? Array.from(col.querySelectorAll('.msg.user')).map(node => node.textContent) : [],
    attachments: tray ? Array.from(tray.querySelectorAll('.attachment-item')).map(node => node.textContent.trim()) : [],
    modelLabel: modelLabel ? modelLabel.textContent : null,
    activeProjectId: activeProj ? activeProj.dataset.project : null,
    product: typeof state === 'undefined' ? null : {
      activeProjectId: state.activeProjectId,
      activeSessionId: state.activeSessionId,
      busy: state.busy,
      sessionState: state.sessionState || null,
      liveRevision: state.liveRevision || 0,
      attachmentCount: (state.attachments || []).length,
      currentProfileId: state.currentProfileId === undefined ? 'undefined' : state.currentProfileId,
      currentModel: state.currentModel,
      projects: (state.projects || []).map(project => ({ id: project.id, name: project.name })),
    },
  };
})()`;

async function readState(browser) {
  return browser.evaluate(READ_STATE);
}

async function waitForState(browser, predicate, label, timeoutMs = 30000, intervalMs = 100) {
  return waitUntil(async () => {
    const state = await readState(browser);
    return predicate(state) ? state : null;
  }, label, timeoutMs, intervalMs);
}

// --- UI actions (the product's own controls) ------------------------------

async function selectModel(browser, profileName, modelId, options = {}) {
  await browser.evaluate("document.getElementById('btn-model').click()");
  const scan = `(() => {
    const pop = document.getElementById('pop-model');
    const groups = pop && pop.querySelector('.pop-groups');
    if (!groups) return null;
    const items = [];
    let profile = null;
    for (const child of Array.from(groups.children)) {
      if (child.tagName === 'BUTTON') {
        const label = ((child.querySelector('.grow') || child).textContent || '').trim();
        items.push({ profile, label, disabled: child.disabled === true });
      } else if (child.classList.contains('pop-group')) {
        profile = (child.textContent || '').trim();
      }
    }
    return { items };
  })()`;
  const menu = await waitUntil(async () => {
    const found = await browser.evaluate(scan);
    return found && found.items.length ? found : null;
  }, 'the model menu', options.timeoutMs || 30000);
  const match = menu.items.find(item => item.profile && item.profile.includes(profileName) && item.label.includes(modelId));
  if (!match) throw new Error(`the model menu has no ${profileName} / ${modelId} entry: ${JSON.stringify(menu.items)}`);
  if (match.disabled) throw new Error(`the ${profileName} / ${modelId} entry is disabled`);
  const clicked = await browser.evaluate(`(() => {
    const profileName = ${JSON.stringify(profileName)};
    const modelId = ${JSON.stringify(modelId)};
    const groups = document.querySelector('#pop-model .pop-groups');
    let profile = null;
    for (const child of Array.from(groups.children)) {
      if (child.tagName === 'BUTTON') {
        const label = ((child.querySelector('.grow') || child).textContent || '').trim();
        if (profile && profile.includes(profileName) && label.includes(modelId)) { child.click(); return { clicked: true, label }; }
      } else if (child.classList.contains('pop-group')) {
        profile = (child.textContent || '').trim();
      }
    }
    return { clicked: false };
  })()`);
  if (!clicked.clicked) throw new Error(`the ${profileName} / ${modelId} entry could not be clicked`);
  await waitForState(browser, state => state.product && state.product.currentModel === modelId, `the ${modelId} selection`, 15000);
  return clicked;
}

async function selectProject(browser, projectId) {
  const clicked = await clickProjectHead(browser, projectId);
  await waitForState(browser, state => state.activeProjectId === projectId, `the ${projectId} project to become active`, 15000);
  return clicked;
}

// The native folder picker opens a blocking OS dialog, which a headless
// browser cannot answer. The product ships a manual fallback form for
// exactly that case; this drives that form, so the project is still created
// by the product's own handler and the product's own client call.
async function createProjectThroughForm(browser, rootPath, options = {}) {
  const prepared = await browser.evaluate(`(() => {
    const modal = document.getElementById('modal-add-proj');
    const path = document.getElementById('np-path');
    const confirm = document.getElementById('np-confirm');
    modal.classList.add('open');
    path.value = ${JSON.stringify(rootPath)};
    path.dispatchEvent(new Event('input', { bubbles: true }));
    return { confirmDisabled: confirm.disabled === true, derivedName: document.getElementById('np-name').value };
  })()`);
  if (prepared.confirmDisabled) throw new Error(`the add-project form refused the path ${rootPath}`);
  const before = await browser.evaluate("Array.from(document.querySelectorAll('#project-list .proj')).map(node => node.dataset.project)");
  await browser.evaluate("document.getElementById('np-confirm').click()");
  const after = await waitUntil(async () => {
    const ids = await browser.evaluate("Array.from(document.querySelectorAll('#project-list .proj')).map(node => node.dataset.project)");
    const added = ids.filter(id => !before.includes(id));
    return added.length ? added : null;
  }, 'the new project to appear in the sidebar', 15000);
  return { projectId: after[0], derivedName: prepared.derivedName };
}

// The isolated host ships a context workspace but no project entry, so the
// sidebar starts empty. The project is created through the product's own
// add-project form, on an isolated directory of this run.
async function ensureProject(browser, rootPath, options = {}) {
  const projects = await browser.evaluate("Array.from(document.querySelectorAll('#project-list .proj')).map(node => ({ id: node.dataset.project, name: ((node.querySelector('.p-name') || {}).textContent || '').trim() }))");
  const wanted = options.name ? projects.find(project => project.name === options.name) : null;
  if (wanted) return { projectId: wanted.id, created: false, name: wanted.name };
  fs.mkdirSync(rootPath, { recursive: true });
  const created = await createProjectThroughForm(browser, rootPath, options);
  return { ...created, created: true };
}

async function typeText(browser, text) {
  const typed = await browser.evaluate(`(() => {
    const input = document.getElementById('chat-input');
    input.value = ${JSON.stringify(text)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return input.value;
  })()`);
  if (typed !== text) throw new Error('the composer did not accept the typed text');
  return typed;
}

async function clickSend(browser) {
  await browser.evaluate("document.getElementById('btn-send').click()");
}

async function clickNewSession(browser) {
  await browser.evaluate("document.getElementById('btn-new-session').click()");
}

// The product's own sidebar: a session is opened by clicking its row, and a
// project is switched by clicking its head. Both are real UI actions.
async function clickProjectHead(browser, projectId) {
  const selector = `#project-list .proj[data-project="${String(projectId).replace(/"/g, '\\"')}"] .proj-item`;
  await waitUntil(async () => browser.evaluate(`!!document.querySelector(${JSON.stringify(selector)})`), `the project ${projectId} in the sidebar`, 20000);
  const clicked = await browser.evaluate(`(() => {
    const node = document.querySelector(${JSON.stringify(selector)});
    if (!node) return { clicked: false };
    node.click();
    return { clicked: true };
  })()`);
  if (!clicked.clicked) throw new Error(`the project ${projectId} has no head in the sidebar`);
  return clicked;
}

// The product's project-head click ALWAYS toggles state.expanded (app.js
// renderProjectList head handler), in both directions, and renders
// asynchronously against SSE-driven refreshes. A fixed two-click dance can
// race a re-render; this state-based settle loop only re-clicks while the
// list is verifiably collapsed or absent, bounded.
async function waitForSessionListExpanded(browser, projectId, attempts = 5) {
  const probe = `(() => {
    const id = ${JSON.stringify(projectId)};
    const proj = document.querySelector('#project-list .proj[data-project="' + id.replace(/"/g, '\\\\"') + '"]');
    const list = proj && proj.querySelector('.sess-list');
    return { projPresent: !!proj, listPresent: !!list, visible: list ? !list.hidden : null, projCount: document.querySelectorAll('#project-list .proj').length };
  })()`;
  let last = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    last = await browser.evaluate(probe);
    if (last && last.visible === true) return last;
    await clickProjectHead(browser, projectId);
    await wait(500);
  }
  throw new Error(`the session list of ${projectId} stayed collapsed or absent after ${attempts} head clicks: ${JSON.stringify(last)}`);
}

async function openSessionRow(browser, projectId, sessionId) {
  const current = await readState(browser);
  if (current.activeProjectId !== projectId) {
    await clickProjectHead(browser, projectId);
    await waitForState(browser, state => state.activeProjectId === projectId, `the ${projectId} project to become active`, 15000);
  }
  await waitForSessionListExpanded(browser, projectId);
  const ready = await waitUntil(async () => {
    const found = await browser.evaluate(`(() => {
      const id = ${JSON.stringify(projectId)};
      const session = ${JSON.stringify(sessionId)};
      const row = document.querySelector('#project-list .proj[data-project="' + id.replace(/"/g, '\\\\"') + '"] .sess-list .session[data-session="' + session.replace(/"/g, '\\\\"') + '"]');
      return row ? { found: true, title: (row.querySelector('.s-title') || {}).textContent || '' } : null;
    })()`);
    return found;
  }, `the session ${sessionId} to be listed under ${projectId}`, 20000);
  await browser.evaluate(`(() => {
    const id = ${JSON.stringify(projectId)};
    const session = ${JSON.stringify(sessionId)};
    const row = document.querySelector('#project-list .proj[data-project="' + id.replace(/"/g, '\\\\"') + '"] .sess-list .session[data-session="' + session.replace(/"/g, '\\\\"') + '"]');
    row.click();
    return true;
  })()`);
  await waitForState(browser, state => state.product && state.product.activeSessionId === sessionId, `the session ${sessionId} to open`, 20000);
  return ready;
}

// The product's own browser storage for drafts, read raw. Nothing is written
// through it here: the product writes it, this only looks.
async function readDraftStorage(browser) {
  return browser.evaluate(`(() => {
    const key = ${JSON.stringify(`kb.workbench.session-drafts:${API_BASE}`)};
    const raw = localStorage.getItem(key) || '';
    let parsed = null;
    try { parsed = JSON.parse(raw || '{}'); } catch { parsed = null; }
    const keys = Object.keys(parsed || {});
    return { key, raw, parsed, keys, entryCount: keys.length };
  })()`);
}

// A real file goes into the real <input type="file">; the product's own
// change handler reads it.
async function attachFile(browser, fileName, content, mediaType = 'text/plain') {
  const result = await browser.evaluate(`(() => {
    const input = document.getElementById('file-input');
    const file = new File([${JSON.stringify(content)}], ${JSON.stringify(fileName)}, { type: ${JSON.stringify(mediaType)} });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return { files: input.files.length };
  })()`);
  await waitForState(browser, state => state.attachments.length > 0, `the attachment ${fileName} to reach the tray`, 15000);
  return result;
}

async function recordedEvents(browser) {
  return browser.evaluate("Array.from((window.__wbRecorder && window.__wbRecorder.log) || []).map((entry, index) => ({ index, type: entry.type, data: entry.data, at: entry.at }))");
}

async function replayRecordedEvent(browser, index, urlPattern) {
  return browser.evaluate(`window.__wbReplay(${Number(index)}, ${urlPattern === undefined || urlPattern === null ? 'null' : JSON.stringify(urlPattern)})`);
}

// --- the module's own session contract ------------------------------------

function sessionEventsUrl(base, sessionId, after = 0) {
  const suffix = after > 0 ? `?after=${encodeURIComponent(after)}` : '';
  return `${base}${API_BASE}/sessions/${encodeURIComponent(sessionId)}/events${suffix}`;
}

// Consume a session's SSE stream and count the events by type. This is the
// product's own event contract, read from outside the browser.
function consumeSessionEvents(url, onEvent, until, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`event stream timed out after ${timeoutMs}ms`)), timeoutMs);
  let done = null;
  const finished = new Promise(resolve => { done = resolve; });
  (async () => {
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) throw new Error(`event stream HTTP ${response.status}`);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { value, done: streamDone } = await reader.read();
        if (streamDone) break;
        buffer += decoder.decode(value, { stream: true });
        let index;
        while ((index = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, index).replace(/\r$/, '');
          buffer = buffer.slice(index + 1);
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload) continue;
          let event;
          try { event = JSON.parse(payload); } catch { continue; }
          try { onEvent(event); } catch { /* listener errors never kill the stream */ }
          if (until && until(event)) { controller.abort(); return; }
        }
      }
    } catch { /* aborted or ended */ }
    finally { done && done(); }
  })();
  return { finished, stop: () => controller.abort() };
}

// --- the process census ----------------------------------------------------
//
// Only the subtree of THIS test's host child is inspected. Nothing outside it
// is ever enumerated by name, signalled or stopped.
function listProcesses() {
  const script = "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress -Depth 2";
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8', timeout: 60000, windowsHide: true, maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0 || !result.stdout) return [];
  let parsed;
  try { parsed = JSON.parse(result.stdout); } catch { return []; }
  if (!Array.isArray(parsed)) parsed = [parsed];
  return parsed.map(entry => ({
    pid: Number(entry.ProcessId),
    ppid: Number(entry.ParentProcessId),
    name: String(entry.Name || ''),
    commandLine: String(entry.CommandLine || ''),
  }));
}

function descendantProcesses(rootPid) {
  const all = listProcesses();
  const byParent = new Map();
  for (const entry of all) {
    if (!byParent.has(entry.ppid)) byParent.set(entry.ppid, []);
    byParent.get(entry.ppid).push(entry);
  }
  const found = [];
  const stack = [Number(rootPid)];
  const seen = new Set();
  while (stack.length) {
    const pid = stack.pop();
    for (const child of byParent.get(pid) || []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      found.push(child);
      stack.push(child.pid);
    }
  }
  return found;
}

// The runtime the module spawns for a session is a node process running the
// Claude CLI. Only names and pids leave this function.
function runtimeProcesses(rootPid) {
  return descendantProcesses(rootPid)
    .filter(entry => /^(node|claude|bun|deno)/i.test(entry.name))
    .map(entry => ({
      pid: entry.pid,
      ppid: entry.ppid,
      name: entry.name,
      // The command line carries the session identity of the runtime; it is
      // truncated and holds no credential (the credential lives in the env).
      commandLine: String(entry.commandLine || '').slice(0, 300),
    }));
}

// --- evidence helpers -----------------------------------------------------

function moduleIdentity(moduleRoot) {
  const identity = sourceMap.packageIdentity(moduleRoot) || {};
  return {
    // The installed-product root comes from the fixture's load-time capture or
    // the launcher's carried-through override — never from a live read of the
    // (already isolated) APPDATA, so an AppData-hosted module can no longer be
    // mislabelled as a repository pin after the driver isolated itself.
    label: moduleRoot === fixture.installedProductPackage()
      ? 'currently-installed-package:installed-product'
      : 'currently-installed-package:repository-pin',
    root: moduleRoot,
    name: identity.name || null,
    version: identity.version || null,
    // The independent constraint the identity chain compares against.
    independentConstraint: fixture.rootWorkbenchDependency(),
    uiFiles: {
      'apps/agent-terminal/app.js': sha256File(path.join(moduleRoot, 'apps', 'agent-terminal', 'app.js')),
      'apps/agent-terminal/index.html': sha256File(path.join(moduleRoot, 'apps', 'agent-terminal', 'index.html')),
      'packages/client/index.js': sha256File(path.join(moduleRoot, 'packages', 'client', 'index.js')),
      'src/backend/lib/claude-cli-runner.js': sha256File(path.join(moduleRoot, 'src', 'backend', 'lib', 'claude-cli-runner.js')),
    },
  };
}

function writeEvidence(target, payload) {
  if (!target) return null;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(payload, null, 2), 'utf8');
  return target;
}

module.exports = {
  API_BASE,
  RECORDER_SOURCE,
  wait,
  waitUntil,
  getJson,
  startHost,
  stopHost,
  openBrowser,
  reloadPage,
  readState,
  waitForState,
  selectModel,
  selectProject,
  createProjectThroughForm,
  ensureProject,
  typeText,
  clickSend,
  clickNewSession,
  clickProjectHead,
  openSessionRow,
  readDraftStorage,
  attachFile,
  recordedEvents,
  replayRecordedEvent,
  sessionEventsUrl,
  consumeSessionEvents,
  listProcesses,
  descendantProcesses,
  runtimeProcesses,
  realProfileDir,
  moduleIdentity,
  writeEvidence,
  sha256File,
};
