'use strict';
// _site/_test/helpers/parallel-memory-capture-r3-cap-shell.js
//
// Lane harness for the external-Agent integration cases of
// P-MEMORY-CAPTURE-R3 (CAP-001 / CAP-006 / CAP-008).
//
// The harness runs the REAL product server and the REAL browser UI. The
// product's own integration manager then runs the REAL native client
// (Claude Code) against an ISOLATED home directory, so the "接入" action is
// a real installation and not a stub.
//
// Isolation:
//
//   * HOME / USERPROFILE / CLAUDE_CONFIG_DIR -> a throwaway home, so the
//     client's own configuration (settings.json hooks, codex notify wrapper,
//     plugin marketplace) is written there and never in the developer's
//     real home. The real home is digested before and after the run and the
//     comparison is part of the evidence.
//   * KB_DATA_DIR / KB_KNOWLEDGE_DATA_DIR / Bridge home -> the isolated
//     directories the shared spawn-server helper creates.
//   * every ambient ANTHROPIC_*/CLAUDE_*/CODEX_*/KB_*/AI_CODING_* variable
//     of the calling shell is removed from the child environment, so the
//     child cannot inherit a live endpoint or a live credential.
//   * own port, own Chrome profile, own external temp root with an owner
//     prefix.

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { spawnServer } = require('../helpers/spawn-server');
const { findChrome } = require('../helpers/find-chrome');
const { launchCdpBrowser, waitFor } = require('../helpers/cdp-browser');
const { attachNetworkCapture } = require('../helpers/cdp-network-capture');
const freePort = require('../helpers/free-port');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const LIVE_PORTS = new Set([5757, 5760, 5789, 5790, 8787, 8790]);

// Every ambient variable that could point a child at a live surface.
const AMBIENT_PREFIXES = ['ANTHROPIC_', 'CLAUDE_', 'CODEX_', 'KB_', 'AI_CODING_', 'OPENCODE_'];
const AMBIENT_EXACT = ['AI_AGENT', 'CLAUDECODE'];

function isInside(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function resolveTempRoot() {
  const sharedRoot = path.join(path.dirname(ROOT), '.project-knowledge-test-temp');
  const chosen = [process.env.PK_TEST_TEMP_ROOT, fs.existsSync(sharedRoot) ? sharedRoot : null, process.env.TEMP, process.env.TMP, process.env.TMPDIR, os.tmpdir()]
    .find(value => value && String(value).trim());
  const root = path.resolve(String(chosen));
  if (isInside(root, ROOT)) throw new Error(`refusing to use a temp root inside the repository: ${root}`);
  return root;
}

function sha256File(file) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); } catch { return null; }
}

/** A recursive digest of a directory tree; digests never leave this process. */
function digestTree(dir) {
  const files = [];
  const walk = current => {
    let entries = [];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) files.push(full);
    }
  };
  walk(dir);
  return {
    dir,
    count: files.length,
    digest: crypto.createHash('sha256').update(files.map(file => `${path.relative(dir, file)}:${sha256File(file)}`).sort().join('\n')).digest('hex'),
  };
}

/**
 * The client's CONFIGURATION surface: the files and directories an
 * integration writes into. A native install that escaped the isolated home
 * would show up here first.
 */
const CLIENT_CONFIG_FILES = [
  '.claude/settings.json',
  '.claude/settings.local.json',
  '.claude/plugins/installed_plugins.json',
  '.claude/plugins/known_marketplaces.json',
  '.claude/plugins/config.json',
  '.codex/config.toml',
  '.zcode/cli/config.json',
  '.config/opencode/opencode.json',
  '.config/opencode/opencode.jsonc',
];
const CLIENT_CONFIG_DIRS = [
  '.claude/plugins/cache',
  '.claude/plugins/marketplaces',
  '.config/opencode/plugin',
  '.config/opencode/skills',
  '.config/opencode/instructions',
];

/**
 * Runtime state of the developer's OWN live clients: transcripts, logs,
 * caches and lock files. The developer runs Claude Code and Codex while the
 * case runs, so these files change on their own — they are not evidence of
 * anything the product did. Everything outside this list and outside the
 * configuration surface is treated as a leak.
 */
const RUNTIME_PATH = /(?:^|\/)(?:projects|sessions|todos|tasks|teams|ide|debug|statsig|telemetry|shell-snapshots|file-history|paste-cache|session-env|backups|tmp|logs|state|sqlite|cache|ambient-suggestions|archived_sessions|automations|browser|computer-use|cap_sid|code-review-plugin|codex-remote-attachments)(?:\/|$)|(?:^|\/)(?:history\.jsonl|stats-cache\.json|install-counts-cache\.json|blocklist\.json|models_cache\.json|\.last-cleanup|.*\.sqlite(?:-shm|-wal)?|.*\.lock)$/;

/** Every file below a directory, as relative path -> sha256. */
function digestTreeFiles(dir) {
  const map = new Map();
  const walk = current => {
    let entries = [];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) map.set(path.relative(dir, full).split(path.sep).join('/'), sha256File(full));
    }
  };
  walk(dir);
  return map;
}

/** The real client configuration of the developer, digested. */
function digestRealClientConfigs(homeDir = os.homedir()) {
  const files = CLIENT_CONFIG_FILES.map(relative => ({ relative, sha256: sha256File(path.join(homeDir, relative)) }));
  const dirs = CLIENT_CONFIG_DIRS.map(relative => ({ relative, ...digestTree(path.join(homeDir, relative)) }));
  return { files, dirs };
}

/** The whole real client tree, as relative path -> sha256 per client home. */
function digestRealClientTrees(homeDir = os.homedir()) {
  return [
    { dir: '.claude', files: digestTreeFiles(path.join(homeDir, '.claude')) },
    { dir: '.codex', files: digestTreeFiles(path.join(homeDir, '.codex')) },
    { dir: '.config/opencode', files: digestTreeFiles(path.join(homeDir, '.config', 'opencode')) },
  ];
}

function compareDigests(before, after) {
  const changed = [];
  for (const [index, entry] of before.entries()) {
    const now = after[index];
    if (!now || now.digest !== entry.digest) changed.push(entry.dir);
  }
  return { byteIdentical: changed.length === 0, changed, before, after };
}

/** The configuration surface comparison: the real isolation claim. */
function compareConfigSurface(before, after) {
  const changedFiles = [];
  for (const entry of before.files) {
    const now = after.files.find(item => item.relative === entry.relative);
    if (!now || now.sha256 !== entry.sha256) changedFiles.push(entry.relative);
  }
  const changedDirs = [];
  for (const entry of before.dirs) {
    const now = after.dirs.find(item => item.relative === entry.relative);
    if (!now || now.digest !== entry.digest) changedDirs.push(entry.relative);
  }
  return { byteIdentical: changedFiles.length === 0 && changedDirs.length === 0, changedFiles, changedDirs, before, after };
}

/**
 * Every file that changed in the real home during the run, classified.
 * A file outside the runtime set and outside the configuration surface is a
 * leak and must fail the case.
 */
function compareRealTrees(before, after) {
  const changed = [];
  for (const entry of before) {
    const now = after.find(item => item.dir === entry.dir);
    if (!now) { changed.push({ dir: entry.dir, file: null, state: 'directory-removed' }); continue; }
    for (const [file, sha] of now.files) {
      if (entry.files.get(file) === sha) continue;
      changed.push({ dir: entry.dir, file, state: entry.files.has(file) ? 'modified' : 'created' });
    }
    for (const file of entry.files.keys()) {
      if (!now.files.has(file)) changed.push({ dir: entry.dir, file, state: 'deleted' });
    }
  }
  const isConfig = item => CLIENT_CONFIG_FILES.includes(`${item.dir}/${item.file}`)
    || CLIENT_CONFIG_DIRS.some(dir => `${item.dir}/${item.file}`.startsWith(`${dir}/`));
  const leaks = changed.filter(item => !isConfig(item) && !RUNTIME_PATH.test(`${item.dir}/${item.file}`));
  const configChanges = changed.filter(item => isConfig(item));
  return { changed, leaks, configChanges, runtimeChanges: changed.length - leaks.length - configChanges.length };
}

/** Remove the ambient variables of the calling shell around one call. */
function withSanitizedEnv(fn) {
  const saved = new Map();
  for (const name of Object.keys(process.env)) {
    if (AMBIENT_PREFIXES.some(prefix => name.startsWith(prefix)) || AMBIENT_EXACT.includes(name)) {
      saved.set(name, process.env[name]);
      delete process.env[name];
    }
  }
  try {
    return fn();
  } finally {
    for (const [name, value] of saved) process.env[name] = value;
  }
}

async function startCapHarness({ tag, evidenceDir, viewport = { width: 1600, height: 950 }, analysisOwner = 'engine' } = {}) {
  const tempRoot = resolveTempRoot();
  fs.mkdirSync(tempRoot, { recursive: true });
  const previousTemp = { TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR };
  process.env.TEMP = tempRoot;
  process.env.TMP = tempRoot;
  process.env.TMPDIR = tempRoot;

  const fixture = fs.mkdtempSync(path.join(tempRoot, `pk-cap-r3-${tag}-`));
  const homeDir = path.join(fixture, 'home');
  fs.mkdirSync(homeDir, { recursive: true });
  const evidence = evidenceDir || path.join(fixture, 'evidence');
  fs.mkdirSync(evidence, { recursive: true });

  const realHomeBefore = digestRealClientConfigs();
  const realTreesBefore = digestRealClientTrees();

  const port = await freePort();
  if (LIVE_PORTS.has(port)) throw new Error(`refusing to use the live port ${port}`);
  const base = `http://127.0.0.1:${port}`;

  const server = withSanitizedEnv(() => spawnServer({
    root: ROOT,
    port,
    dataDir: path.join(fixture, 'data'),
    tag: `cap-r3-${tag}`,
    analysisOwner,
    extraEnv: {
      HOME: homeDir,
      USERPROFILE: homeDir,
      CLAUDE_CONFIG_DIR: path.join(homeDir, '.claude'),
      KB_MODULES_REGISTER: '0',
      KB_MODULES_AUTOSTART: '0',
    },
  }));
  process.env.TEMP = previousTemp.TEMP;
  process.env.TMP = previousTemp.TMP;
  process.env.TMPDIR = previousTemp.TMPDIR;

  let browser = null;
  let network = null;
  try {
    await waitFor(async () => {
      try {
        const response = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(5000) });
        return response.status === 200;
      } catch { return false; }
    }, 'the isolated product instance', 30000);

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
    fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    throw error;
  }

  const run = expression => browser.evaluate(expression);
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

  const productApi = async (method, route, body) => {
    const response = await fetch(base + route, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
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
      const describe = node => {
        if (!node) return 'nothing';
        let text = node.tagName.toLowerCase();
        if (node.id) text += '#' + node.id;
        if (node.className && typeof node.className === 'string' && node.className.trim()) text += '.' + node.className.trim().split(/\\s+/).join('.');
        return text;
      };
      return { x, y, hitIsTarget: Boolean(hit && (hit === el || el.contains(hit))), hit: describe(hit), label: (el.textContent || '').trim().slice(0, 40) };
    })()`);
    if (!probe || probe.missing) throw new Error(`the control ${selector} must exist in the page`);
    if (probe.invisible) throw new Error(`the control ${selector} must be visible`);
    if (!probe.hitIsTarget) throw new Error(`the control ${selector} must be the hit target; ${probe.hit} is on top`);
    const common = { x: probe.x, y: probe.y, button: 'left', clickCount: 1 };
    await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: probe.x, y: probe.y, button: 'none', clickCount: 0 });
    await browser.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...common });
    await browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...common });
    return probe;
  };

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

  /** Open the real system drawer: the 外部 Agent 接入 section lives there. */
  const openSystemDrawer = async () => {
    await nativeClick('#openSystem');
    await waitFor(() => run("document.getElementById('systemDrawer').hidden === false"), 'the system drawer is open', 15000);
    await waitFor(
      () => run("document.querySelectorAll('#agentCaptureList .agent-capture-row').length > 0"),
      'the external agent rows are rendered',
      60000,
    );
    // The drawer answers '检测中' until the product's own scan settles; a
    // case that reads that placeholder would prove nothing.
    await waitFor(
      () => run("[...document.querySelectorAll('#agentCaptureList .agent-capture-row')].every(row => { const badge = row.querySelector('.status'); return badge && badge.textContent !== '检测中'; })"),
      'the external agent rows show a settled state',
      90000,
    );
  };

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

  const feedback = () => run("document.getElementById('agentCaptureFeedback').textContent");

  /** The product's own status: one entry per client, one state per capability. */
  const integrationStatus = async (refresh = true) => {
    const result = await productApi('GET', `/api/integrations/status${refresh ? '?refresh=1' : ''}`);
    if (result.status !== 200) throw new Error(`the integration status must be readable: ${JSON.stringify(result.body)}`);
    return result.body;
  };

  /** The client configuration files the installer writes into the isolated home. */
  const isolatedConfigs = () => {
    const claudeSettings = path.join(homeDir, '.claude', 'settings.json');
    const codexConfig = path.join(homeDir, '.codex', 'config.toml');
    const openCodeConfig = path.join(homeDir, '.config', 'opencode', 'opencode.json');
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
      installedPlugins: readJson(path.join(homeDir, '.claude', 'plugins', 'installed_plugins.json')),
      knownMarketplaces: readJson(path.join(homeDir, '.claude', 'plugins', 'known_marketplaces.json')),
      codexConfigFile: codexConfig,
      codexConfigExists: fs.existsSync(codexConfig),
      codexConfigText: fs.existsSync(codexConfig) ? fs.readFileSync(codexConfig, 'utf8') : null,
      openCodeConfigFile: openCodeConfig,
      openCodeConfigExists: fs.existsSync(openCodeConfig),
    };
  };

  /**
   * The status once the product's own scan has settled.
   *
   * The product answers the first status request with 'checking' placeholders
   * and refreshes itself; a case that reads a 'checking' answer would prove
   * nothing. This waits for the product's own settled answer.
   */
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

  /** The row of one client exactly as the UI rendered it. */
  const agentRow = async client => {
    const rows = await agentRows();
    return rows.find(row => row.client === client) || null;
  };

  /** Every install request the real UI sent so far. */
  const installCallCount = () => network.find(entry => entry.method === 'POST' && entry.url.includes('/api/integrations/install')).length;

  /** The last install request the real UI sent, with its real response body. */
  const lastInstallCall = async () => {
    const entries = network.find(entry => entry.method === 'POST' && entry.url.includes('/api/integrations/install'));
    const entry = entries.length ? entries[entries.length - 1] : null;
    if (!entry) return null;
    return { method: entry.method, url: entry.url.replace(base, ''), request: entry.body, status: entry.status, response: await network.body(entry) };
  };

  /**
   * The real 系统诊断记录 dialog, searched with the real input and the real
   * 查询 button. The operationId must be findable in the product's own
   * diagnostics, not only in the HTTP response that produced it.
   */
  const logsSearch = async operationId => {
    // The dialog is modal and stays open after a previous search; the real
    // user path back to the button is the dialog's own close control, and
    // then the system drawer again.
    if (await run("document.getElementById('logsDialog').open === true")) {
      await nativeClick('#logsDialog [data-close="logsDialog"]');
      await waitFor(() => run("document.getElementById('logsDialog').open === false"), 'the diagnostics dialog is closed', 10000);
    }
    if (await run("document.getElementById('systemDrawer').hidden === true")) await openSystemDrawer();
    await nativeClick('#openLogs');
    await waitFor(() => run("document.getElementById('logsDialog').open === true"), 'the diagnostics dialog is open', 10000);
    await typeInto('#logsSearch', operationId);
    await nativeClick('#loadLogs');
    // The content keeps the previous search's records until the new answer
    // lands; the operation id appearing in a returned record is the product's
    // own answer for this search.
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

  /**
   * The installed knowledge plugin of the isolated home, compared with the
   * product's own plugin source file by file.
   */
  const pluginEvidence = () => {
    const indexFile = path.join(homeDir, '.claude', 'plugins', 'installed_plugins.json');
    const index = (() => {
      try { return JSON.parse(fs.readFileSync(indexFile, 'utf8')); } catch { return null; }
    })();
    const entries = index && index.plugins ? index.plugins['project-knowledge@project-knowledge'] || [] : [];
    const installPath = entries.length ? entries[0].installPath : null;
    const files = ['hooks/claude.json', 'scripts/context-hook.cjs', '.mcp.json', '.claude-plugin/plugin.json'];
    const normalize = file => {
      try { return new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(file)).replace(/\r\n/g, '\n'); } catch { return null; }
    };
    const comparison = files.map(file => {
      const installed = installPath ? path.join(installPath, file) : null;
      const source = path.join(ROOT, 'plugins', 'project-knowledge', file);
      const installedText = installed && fs.existsSync(installed) ? normalize(installed) : null;
      const sourceText = fs.existsSync(source) ? normalize(source) : null;
      return {
        file,
        installedPath: installed,
        installedExists: Boolean(installedText !== null),
        sourcePath: source,
        byteIdentical: installedText !== null && sourceText !== null && installedText === sourceText,
        installedSha256: installed && fs.existsSync(installed) ? sha256File(installed) : null,
        sourceSha256: fs.existsSync(source) ? sha256File(source) : null,
      };
    });
    const marketplaceFile = path.join(homeDir, '.claude', 'plugins', 'known_marketplaces.json');
    const marketplace = (() => {
      try { return JSON.parse(fs.readFileSync(marketplaceFile, 'utf8')); } catch { return null; }
    })();
    return {
      indexFile,
      installedPlugins: index,
      installedVersion: entries.length ? entries[0].version : null,
      installPath,
      installPathExists: Boolean(installPath && fs.existsSync(installPath)),
      files: comparison,
      allFilesIdentical: comparison.every(entry => entry.byteIdentical),
      marketplaceSource: marketplace && marketplace['project-knowledge'] ? marketplace['project-knowledge'].source : null,
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
        entries.push({
          event,
          command: hook.command,
          shimPath: shim,
          shimExists: Boolean(shim && fs.existsSync(shim)),
        });
      }
    }
    return entries;
  };

  const cleanup = async () => {
    await browser?.close();
    await server.cleanup();
    fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  };

  return {
    fixture, evidence, homeDir, tempRoot, base, server, productApi, browser, network,
    run, wait, waitFor, nativeClick, typeInto,
    openSystemDrawer, reopenSystemDrawer, agentRows, agentRow, feedback, integrationStatus, isolatedConfigs,
    settledStatus, statusClient, lastInstallCall, installCallCount, logsSearch, pluginEvidence, ownedHookEntries,
    realHomeBefore, realTreesBefore, digestRealClientConfigs, digestRealClientTrees,
    compareDigests, compareConfigSurface, compareRealTrees, cleanup,
  };
}

module.exports = {
  ROOT,
  LIVE_PORTS,
  AMBIENT_PREFIXES,
  AMBIENT_EXACT,
  CLIENT_CONFIG_FILES,
  CLIENT_CONFIG_DIRS,
  RUNTIME_PATH,
  resolveTempRoot,
  digestTree,
  digestTreeFiles,
  digestRealClientConfigs,
  digestRealClientTrees,
  compareDigests,
  compareConfigSurface,
  compareRealTrees,
  withSanitizedEnv,
  startCapHarness,
};
