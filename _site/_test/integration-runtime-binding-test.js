// Run: node _site/_test/integration-runtime-binding-test.js
//
// Covers the local MCP launcher contract (no npx, no network), the durable
// integration-runtime binding, installer binding writes, the mcpStartup
// status probe, and the release-format contracts for the new .mcp.json.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync, fork } = require('node:child_process');
const { IntegrationManager, INTEGRATION_NAME } = require('../lib/integration-installer');
const { IntegrationStatusScan } = require('../lib/integration-status-scan');
const { inspectReleaseVersion } = require('../../_site/scripts/sync-release-version');

const ROOT = path.resolve(__dirname, '..', '..');
const PLUGIN_ROOT = path.join(ROOT, 'plugins', 'project-knowledge');
const LAUNCHER = path.join(PLUGIN_ROOT, 'scripts', 'mcp-launcher.cjs');
const RUNTIME_SCHEMA = 'project-knowledge/integration-runtime/v1';
const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), `pk-integration-runtime-${process.pid}-`));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function runLauncher({ dataDir, env = {} }) {
  const result = spawnSync(process.execPath, [LAUNCHER], {
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, KB_DATA_DIR: dataDir, ...env },
    timeout: 15000,
  });
  return result;
}

function parseLauncherStderr(result) {
  const lines = String(result.stderr || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  assert(lines.length === 1, 'launcher diagnostics must be exactly one stderr line for failures');
  return JSON.parse(lines[0]);
}

function writeBinding(dataDir, binding) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'integration-runtime.json'), JSON.stringify(binding, null, 2));
}

function fakePackage(dir, { name = '@sanqianx/project-knowledge', version = '9.9.9', withEntry = true }) {
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version, bin: { 'project-knowledge-mcp': 'bin/project-knowledge-mcp.js' } }));
  if (withEntry) fs.writeFileSync(path.join(dir, 'bin', 'project-knowledge-mcp.js'), '#!/usr/bin/env node\nprocess.exit(0);\n');
}

async function mcpHandshake({ dataDir, env = {} }) {
  // Line-delimited JSON-RPC handshake against the launcher, asserting every
  // stdout line parses as JSON (no stdio pollution). Resolves when the
  // initialize response arrives: a healthy server keeps running to serve
  // requests, so waiting for process exit would only hit the timeout.
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [LAUNCHER], {
      windowsHide: true,
      env: { ...process.env, KB_DATA_DIR: dataDir, ...env },
    });
    const killTree = () => {
      if (!child.pid) return;
      try { process.platform === 'win32' ? spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 5000 }) : child.kill(); } catch {}
    };
    const timer = setTimeout(() => { killTree(); reject(new Error('launcher handshake timeout')); }, 20000);
    let settled = false;
    const settle = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killTree();
      resolve(result);
    };
    let buffer = '';
    const responses = [];
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        responses.push(JSON.parse(line));
      }
      if (responses.some(message => message.id === 1)) settle({ responses, stderr: '' });
    });
    const stderr = [];
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => stderr.push(chunk));
    child.on('close', code => {
      settle({ code, responses, stderr: stderr.join('') });
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'pk-binding-test', version: '1' } } }) + '\n');
  });
}

async function expectFailureCode(name, { dataDir, env, binding, fakePkg, fakePkgOptions }) {
  const dir = path.join(TEMP, name);
  if (binding) writeBinding(dir, binding);
  else fs.mkdirSync(dir, { recursive: true });
  if (fakePkg) fakePackage(fakePkg, fakePkgOptions || {});
  const result = runLauncher({ dataDir: dir, env });
  assert(result.status !== 0, `${name}: launcher must exit non-zero`);
  const payload = parseLauncherStderr(result);
  assert(payload.schema === 'project-knowledge/mcp-launcher-error/v1', `${name}: error payload must carry the launcher error schema`);
  assert(payload.code === bindingCode(name), `${name}: unexpected code ${payload.code}`);
  assert(String(result.stdout || '').trim() === '', `${name}: launcher must not write diagnostics to stdout`);
}

function bindingCode(name) {
  return {
    missing: 'BINDING_MISSING',
    corrupt: 'BINDING_CORRUPT',
    schema: 'BINDING_SCHEMA_MISMATCH',
    package: 'BINDING_PACKAGE_MISMATCH',
    version: 'BINDING_VERSION_MISMATCH',
    root: 'BINDING_INVALID_ROOT',
    entry: 'BINDING_ENTRY_MISSING',
  }[name];
}

async function testMcpManifestContract() {
  const manifest = readJson(path.join(PLUGIN_ROOT, '.mcp.json'));
  const server = manifest.mcpServers['project-knowledge'];
  assert(server, '.mcp.json must keep the project-knowledge server');
  assert(server.type === 'stdio', 'server must stay stdio');
  assert(server.command === 'node', 'the default MCP entry must use the local Node, not npx');
  assert(!JSON.stringify(server).includes('npx'), 'the plugin MCP chain must not depend on npx anymore');
  assert(!/@sanqianx\/project-knowledge@/.test(JSON.stringify(server)), 'the plugin MCP chain must not pin an npx package argument');
  assert(Array.isArray(server.args) && server.args[0] === '-e', 'the launcher bootstrap must run through node -e');
  const bootstrap = server.args[1];
  assert(typeof bootstrap === 'string' && bootstrap.includes('mcp-launcher.cjs'), 'the bootstrap must locate the plugin launcher script');
  assert(bootstrap.includes('CLAUDE_PLUGIN_ROOT') && bootstrap.includes('PLUGIN_ROOT'), 'the bootstrap must honor both native plugin-root variables');
  assert(server.cwd === undefined, 'A2: no cwd pin; the bootstrap must not resolve relative to a working directory');
  assert(server.env && server.env.KB_PLUGIN_VERSION === readJson(path.join(ROOT, 'package.json')).version, 'A2: env.KB_PLUGIN_VERSION must carry the shipping version');
  assert(!bootstrap.includes('process.cwd'), 'A2: the bootstrap must never consult process.cwd');
  assert(fs.existsSync(LAUNCHER), 'the launcher script must ship inside the plugin');
}

async function testLauncherFailureMatrix() {
  const goodPkg = path.join(TEMP, 'good-pkg');
  fakePackage(goodPkg, { version: '9.9.9' });

  await expectFailureCode('missing', {});
  fs.mkdirSync(path.join(TEMP, 'corrupt'), { recursive: true });
  fs.writeFileSync(path.join(TEMP, 'corrupt', 'integration-runtime.json'), '{ not json');
  await expectFailureCode('corrupt', { binding: null });
  const dir = name => path.join(TEMP, name);
  writeBinding(dir('schema'), { schema: 'other/v2' });
  await expectFailureCode('schema', { binding: readJson(path.join(dir('schema'), 'integration-runtime.json')) });
  writeBinding(dir('package'), { schema: RUNTIME_SCHEMA, packageName: '@other/pkg', packageRoot: goodPkg, version: '9.9.9' });
  await expectFailureCode('package', { binding: readJson(path.join(dir('package'), 'integration-runtime.json')) });
  writeBinding(dir('version'), { schema: RUNTIME_SCHEMA, packageName: '@sanqianx/project-knowledge', packageRoot: goodPkg, version: '1.2.3' });
  await expectFailureCode('version', { binding: readJson(path.join(dir('version'), 'integration-runtime.json')) });
  writeBinding(dir('root'), { schema: RUNTIME_SCHEMA, packageName: '@sanqianx/project-knowledge', packageRoot: 'relative/pkg/root', version: '9.9.9' });
  await expectFailureCode('root', { binding: readJson(path.join(dir('root'), 'integration-runtime.json')) });
  const noEntry = path.join(TEMP, 'no-entry-pkg');
  fakePackage(noEntry, { version: '9.9.9', withEntry: false });
  writeBinding(dir('entry'), { schema: RUNTIME_SCHEMA, packageName: '@sanqianx/project-knowledge', packageRoot: noEntry, version: '9.9.9' });
  await expectFailureCode('entry', { binding: readJson(path.join(dir('entry'), 'integration-runtime.json')) });
}

async function testRealHandshakeIgnoresBrokenNpxCache() {
  // A corrupted _npx entry (missing package.json) must not affect the local
  // launcher chain at all — that is the regression this whole feature fixes.
  const dataDir = path.join(TEMP, '用户 空格 知识库', 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const packageInfo = readJson(path.join(ROOT, 'package.json'));
  writeBinding(dataDir, { schema: RUNTIME_SCHEMA, packageName: packageInfo.name, packageRoot: ROOT, version: packageInfo.version, updatedAt: new Date().toISOString() });
  const brokenCache = path.join(TEMP, '用户 空格 知识库', 'npm-cache');
  fs.mkdirSync(path.join(brokenCache, '_npx', '7581c64052dde81c'), { recursive: true });
  fs.mkdirSync(path.join(brokenCache, '_npx', '7581c64052dde81c', 'node_modules'), { recursive: true });
  const result = await mcpHandshake({ dataDir, env: { npm_config_cache: brokenCache } });
  assert(result.code === 0 || result.responses.length, 'the local chain must initialize despite a broken npx cache');
  const init = result.responses.find(message => message.id === 1);
  assert(init && !init.error, 'initialize must succeed');
  assert(init.result.serverInfo.name === 'project-knowledge', 'serverInfo must identify project-knowledge');
  assert(init.result.serverInfo.version === packageInfo.version, 'the bound local package version must be reported');
  assert(String(result.stderr || '').trim() === '', 'a healthy launch writes nothing to stderr');
}

async function testBootstrapResolvesForBothNativeForms() {
  const manifest = readJson(path.join(PLUGIN_ROOT, '.mcp.json'));
  const bootstrap = manifest.mcpServers['project-knowledge'].args[1];
  const dataDir = path.join(TEMP, 'bootstrap-forms');
  fs.mkdirSync(dataDir, { recursive: true });
  // Test isolation: the host session may itself run inside a native plugin
  // (CLAUDE_PLUGIN_ROOT pointing at claude-mem, etc.); the bootstrap under
  // test must not silently prefer that unrelated root.
  const baseEnv = { ...process.env };
  delete baseEnv.CLAUDE_PLUGIN_ROOT;
  delete baseEnv.PLUGIN_ROOT;
  const run = env => spawnSync(process.execPath, ['-e', bootstrap], {
    encoding: 'utf8', windowsHide: true, timeout: 15000,
    env: { ...baseEnv, KB_DATA_DIR: dataDir, ...env },
    cwd: env.PLUGIN_ROOT || env.CLAUDE_PLUGIN_ROOT || PLUGIN_ROOT,
  });
  // A2: without a plugin-root env the bootstrap must NOT fall back to cwd.
  const decoyDir = path.join(TEMP, 'bootstrap-decoy');
  fs.mkdirSync(path.join(decoyDir, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(decoyDir, 'scripts', 'mcp-launcher.cjs'), 'process.exit(7);\n');
  const codex = spawnSync(process.execPath, ['-e', bootstrap], {
    encoding: 'utf8', windowsHide: true, timeout: 15000,
    env: { ...baseEnv, KB_DATA_DIR: dataDir }, cwd: decoyDir,
  });
  assert(codex.status === 127, 'A2: without a trusted root or usable binding the bootstrap exits 127, got ' + codex.status);
  // Claude form: CLAUDE_PLUGIN_ROOT is exported to MCP stdio servers.
  const claude = run({ CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT, cwd: undefined });
  assert(claude.status === 1 && /BINDING_MISSING/.test(String(claude.stderr || '')), 'the CLAUDE_PLUGIN_ROOT form must reach the launcher');
  const codexCompat = run({ PLUGIN_ROOT: PLUGIN_ROOT });
  assert(codexCompat.status === 1 && /BINDING_MISSING/.test(String(codexCompat.stderr || '')), 'the PLUGIN_ROOT form must reach the launcher');
  // A2: the verified binding fallback loads the in-package launcher with no env root.
  const fakePkg = path.join(TEMP, 'bootstrap-fake-pkg');
  const fakeLauncher = path.join(fakePkg, 'plugins', 'project-knowledge', 'scripts', 'mcp-launcher.cjs');
  fs.mkdirSync(path.dirname(fakeLauncher), { recursive: true });
  fs.writeFileSync(fakeLauncher, 'process.stderr.write(\'BINDING_FALLBACK_REACHED\'); process.exit(5);\n');
  writeBinding(dataDir, { schema: RUNTIME_SCHEMA, packageName: '@sanqianx/project-knowledge', packageRoot: fakePkg, version: '0.0.0' });
  const bound = spawnSync(process.execPath, ['-e', bootstrap], {
    encoding: 'utf8', windowsHide: true, timeout: 15000,
    env: { ...baseEnv, KB_DATA_DIR: dataDir }, cwd: decoyDir,
  });
  assert(bound.status === 5 && /BINDING_FALLBACK_REACHED/.test(String(bound.stderr || '')), 'the verified binding fallback must load the in-package launcher');
}

async function testInstallerBindingLifecycle() {
  const home = path.join(TEMP, 'installer-home');
  const dataDir = path.join(home, '.project-knowledge-v5');
  const bindingPath = path.join(dataDir, 'integration-runtime.json');
  const manager = new IntegrationManager({
    rootDir: ROOT,
    homeDir: home,
    env: { KB_DATA_DIR: dataDir },
    commandResolver: name => name,
    runner: () => ({ status: 0, stdout: '', stderr: '' }),
  });
  assert(typeof manager.ensureIntegrationRuntimeBinding === 'function', 'the installer must expose the binding writer');
  const packageInfo = readJson(path.join(ROOT, 'package.json'));
  manager.ensureIntegrationRuntimeBinding();
  const first = readJson(bindingPath);
  assert(first.schema === RUNTIME_SCHEMA, 'binding must carry the integration-runtime schema');
  assert(first.packageName === packageInfo.name, 'binding must pin the package name');
  assert(first.packageRoot === ROOT, 'binding must pin the absolute package root');
  assert(first.version === packageInfo.version, 'binding must pin the package version');
  assert(!JSON.stringify(first).match(/token|secret|key/i), 'binding must not carry credentials');
  // Idempotent repair: a second explicit install keeps the binding valid.
  manager.ensureIntegrationRuntimeBinding();
  const second = readJson(bindingPath);
  assert(second.packageRoot === first.packageRoot && second.version === first.version && second.packageName === first.packageName, 'repeated installs must keep the binding stable');

  // A failed atomic write keeps the previous binding byte-for-byte.
  const before = fs.readFileSync(bindingPath);
  let failed = false;
  try {
    manager.ensureIntegrationRuntimeBinding({ beforeRename: () => { throw new Error('disk full'); } });
  } catch (error) {
    failed = true;
    assert(/disk full/.test(error.message), 'write failures must surface, not be swallowed');
  }
  assert(failed, 'an injected rename failure must throw');
  assert(fs.readFileSync(bindingPath).equals(before), 'a failed atomic write must preserve the old binding');
  assert(!fs.readdirSync(dataDir).some(name => name.endsWith('.tmp')), 'no temp residue may survive a failed write');

  // dry-run never writes a binding.
  const dryHome = path.join(TEMP, 'installer-dry-home');
  new IntegrationManager({ rootDir: ROOT, homeDir: dryHome, env: { KB_DATA_DIR: path.join(dryHome, 'data') }, dryRun: true }).ensureIntegrationRuntimeBinding();
  assert(!fs.existsSync(path.join(dryHome, 'data', 'integration-runtime.json')), 'dry-run must not write the binding');
}

async function testInstallAllCaptureOnlySkipsBinding() {
  const home = path.join(TEMP, 'install-all-home');
  const dataDir = path.join(home, '.project-knowledge-v5');
  const bridgeStub = {
    createBridge: () => ({
      registerConsumer: async () => ({}),
      getConsumer: async () => ({}),
      getHealth: async () => ({}),
      ensureRuntimeHome: async () => ({}),
      installers: {
        claudeCode: { installClaudeCodeHook: async () => ({ added: [] }), statusClaudeCodeHook: async () => ({ installed: false }), uninstallClaudeCodeHook: async () => ({}) },
        codex: { statusCodexHook: async () => ({ installed: false }) },
        openCode: { installOpenCodePlugin: async () => ({}), statusOpenCodePlugin: async () => ({ installed: false }), uninstallOpenCodePlugin: async () => ({}) },
        zcode: { installZcodeHook: async () => ({}), statusZcodeHook: async () => ({ installed: false }), uninstallZcodeHook: async () => ({}) },
      },
    }),
  };
  const manager = new IntegrationManager({
    rootDir: ROOT,
    homeDir: home,
    env: { KB_DATA_DIR: dataDir },
    commandResolver: name => name,
    runner: () => ({ status: 0, stdout: '[]', stderr: '' }),
    bridgeModule: bridgeStub,
  });
  await manager.installAll({ clients: ['claude'], captureOnly: true });
  assert(!fs.existsSync(path.join(dataDir, 'integration-runtime.json')), 'A2: captureOnly must not write the knowledge runtime binding');
}

async function testMcpStartupProbe() {
  const home = path.join(TEMP, 'probe-home');
  const dataDir = path.join(home, '.project-knowledge-v5');
  const packageInfo = readJson(path.join(ROOT, 'package.json'));
  writeBinding(dataDir, { schema: RUNTIME_SCHEMA, packageName: packageInfo.name, packageRoot: ROOT, version: packageInfo.version, updatedAt: new Date().toISOString() });
  const manager = new IntegrationManager({
    rootDir: ROOT,
    homeDir: home,
    env: { KB_DATA_DIR: dataDir },
    commandResolver: name => name,
    runner: () => ({ status: 0, stdout: '[]', stderr: '' }),
    bridgeModule: {
      createBridge: () => ({
        getConsumer: async () => ({}),
        getHealth: async () => ({}),
        installers: {
          claudeCode: { statusClaudeCodeHook: async () => ({ installed: false }) },
          codex: { statusCodexHook: async () => ({ installed: false }) },
        },
      }),
    },
  });
  assert(typeof manager.probeMcpStartup === 'function', 'the installer must expose the MCP startup probe');
  const ready = await manager.probeMcpStartup();
  assert(ready.state === 'ready', `a healthy binding must probe ready, got ${JSON.stringify(ready)}`);
  assert(ready.actualVersion === packageInfo.version && ready.expectedVersion === packageInfo.version, 'the probe must report both versions');
  assert(ready.scope === 'product-runtime' && ready.serverName === 'project-knowledge', 'A2: the probe reports its scope and the verified server identity');
  assert(Array.isArray(ready.tools) && ready.tools.length === 6, 'A2: the probe verifies the six knowledge tools');
  assert(typeof ready.checkedAt === 'string', 'the probe must record checkedAt');

  // A broken binding must surface a failed probe with a machine code.
  fs.writeFileSync(path.join(dataDir, 'integration-runtime.json'), '{ broken');
  const failed = await manager.probeMcpStartup();
  assert(failed.state === 'failed', `a corrupted binding must probe failed, got ${JSON.stringify(failed)}`);
  assert(typeof failed.code === 'string' && failed.code, 'failed probes must carry a code');
  assert(typeof failed.detail === 'string', 'failed probes must carry a bounded detail');

  // Probe details must be sanitized: a launcher that prints a token must not
  // leak it into status output.
  const leaky = path.join(TEMP, 'leaky-launcher.cjs');
  fs.writeFileSync(leaky, 'process.stderr.write("boom sk-abcdef123456 token\\n"); process.exit(3);\n');
  const leakyProbe = await manager.probeMcpStartup({ launcherPath: leaky });
  assert(leakyProbe.state === 'failed', 'the leaky launcher must count as failed');
  assert(!JSON.stringify(leakyProbe).includes('sk-abcdef123456'), 'probe details must redact credential-shaped strings');
  assert(JSON.stringify(leakyProbe).length < 2000, 'probe details must stay bounded');

  // statusAll must attach mcpStartup for MCP-capable clients and honor the
  // injected probe (so UI refreshes reuse the cached scan instead of spawning).
  let probeCalls = 0;
  const counting = new IntegrationManager({
    rootDir: ROOT,
    homeDir: home,
    env: { KB_DATA_DIR: dataDir },
    commandResolver: name => name,
    runner: () => ({ status: 0, stdout: '[]', stderr: '' }),
    mcpProbe: async () => { probeCalls += 1; return { state: 'ready', checkedAt: new Date().toISOString(), actualVersion: packageInfo.version, expectedVersion: packageInfo.version }; },
    bridgeModule: manager.bridge,
  });
  const summary = await counting.statusAll({ clients: ['claude', 'codex', 'zcode'] });
  const claude = summary.clients.find(entry => entry.client === 'claude');
  const codex = summary.clients.find(entry => entry.client === 'codex');
  assert(claude.mcpStartup?.code === 'CLIENT_PLUGIN_ENTRY_MISSING', 'A2: claude without an installed plugin entry reports the explicit miss');
  assert(codex.mcpStartup?.code === 'CLIENT_PLUGIN_ENTRY_MISSING', 'A2: codex without an installed plugin entry reports the explicit miss');
  assert(summary.mcpRuntime?.state === 'ready', 'A2: the shared product-runtime probe lands in the summary');
  assert(probeCalls === 1, 'A2: only the host product-runtime probe runs when no installed entries exist');
}

async function testStatusScanDoesNotRespawn() {
  // UI refreshes funnel through the cached scan; identical reads within the
  // TTL must not fork another probe worker.
  const counter = path.join(TEMP, 'scan-count.txt');
  const worker = path.join(TEMP, 'scan-worker.js');
  fs.writeFileSync(worker, `${'const fs = require(\'node:fs\');'}
process.once('message', async input => {
  const counter = ${JSON.stringify(counter)};
  const count = fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) + 1 : 1;
  fs.writeFileSync(counter, String(count));
  process.send({ ok: true, summary: { bridge: { ok: true }, clients: [{ client: input.statusOptions.clients?.[0] || 'claude', mcpStartup: { state: 'ready' } }] } }, () => process.disconnect());
});
`);
  const scan = new IntegrationStatusScan({ workerFile: worker, timeoutMs: 20000 });
  const options = { rootDir: ROOT, homeDir: TEMP, bridgeHomeDir: TEMP };
  await scan.read(options, { clients: ['claude'] }, { waitMs: 5000 });
  await scan.read(options, { clients: ['claude'] }, { waitMs: 5000 });
  assert(Number(fs.readFileSync(counter, 'utf8')) === 1, 'a cached scan must not fork another worker for the same key');
  await scan.read(options, { clients: ['claude'] }, { force: true, waitMs: 5000 });
  assert(Number(fs.readFileSync(counter, 'utf8')) === 2, 'force refresh must re-run the scan');
  scan.close();
}

async function testCodexTrustSeparatedFromWaitingTrust() {
  // The same already-trusted definition must not be reported as waiting-trust.
  const home = path.join(TEMP, 'codex-trust-home');
  const manager = new IntegrationManager({
    rootDir: ROOT,
    homeDir: home,
    env: {},
    commandResolver: name => name,
    runner: () => ({ status: 0, stdout: JSON.stringify({ installed: [{ pluginId: 'project-knowledge@project-knowledge', version: readJson(path.join(ROOT, 'package.json')).version, enabled: true, source: { path: path.join(ROOT, 'plugins', 'project-knowledge') } }] }), stderr: '' }),
    codexHookProbe: async () => ({ data: [{ cwd: home, hooks: [{ pluginId: 'project-knowledge@project-knowledge', eventName: 'userPromptSubmit', command: 'node "…/scripts/context-hook.cjs" --client codex', enabled: true, trustStatus: 'trusted' }] }] }),
    bridgeModule: {
      createBridge: () => ({ getConsumer: async () => ({}), getHealth: async () => ({}), installers: { codex: { statusCodexHook: async () => ({ installed: false }) } } }),
    },
  });
  const status = await manager.automaticCodexContextStatus(manager.statusCodex(), home);
  assert(status.state === 'configured', `an already-trusted matching definition must be configured, not waiting-trust (got ${status.state})`);
  assert(status.trustStatus === 'trusted', 'the native trust status must be surfaced');
}

async function testReleaseContracts() {
  const { drift } = inspectReleaseVersion(ROOT, { webOnly: true });
  assert(!drift.includes('plugins/project-knowledge/.mcp.json'), `the shipped launcher .mcp.json must satisfy the release contract (drift: ${drift.join(', ')})`);

  const mini = path.join(TEMP, 'release-mini');
  fs.mkdirSync(path.join(mini, 'plugins', 'project-knowledge', '.claude-plugin'), { recursive: true });
  fs.mkdirSync(path.join(mini, 'plugins', 'project-knowledge', '.codex-plugin'), { recursive: true });
  fs.mkdirSync(path.join(mini, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(mini, 'package.json'), JSON.stringify({ name: '@sanqianx/project-knowledge', version: '1.0.0' }));
  fs.writeFileSync(path.join(mini, 'package-lock.json'), JSON.stringify({ name: '@sanqianx/project-knowledge', version: '1.0.0', packages: { '': { version: '1.0.0' } } }));
  fs.writeFileSync(path.join(mini, 'plugins', 'project-knowledge', '.claude-plugin', 'plugin.json'), JSON.stringify({ version: '1.0.0' }));
  fs.writeFileSync(path.join(mini, 'plugins', 'project-knowledge', '.codex-plugin', 'plugin.json'), JSON.stringify({ version: '1.0.0' }));
  fs.writeFileSync(path.join(mini, '.claude-plugin', 'marketplace.json'), JSON.stringify({ plugins: [{ version: '1.0.0' }] }));
  fs.writeFileSync(path.join(mini, 'plugins', 'project-knowledge', '.mcp.json'), JSON.stringify({
    mcpServers: { 'project-knowledge': { type: 'stdio', command: 'npx', args: ['-y', '--package', '@sanqianx/project-knowledge@1.0.0', 'project-knowledge-mcp'] } },
  }, null, 2));
  let rejected = false;
  try { inspectReleaseVersion(mini, { webOnly: true }); } catch (error) { rejected = /pinned|npx|launcher/i.test(error.message); }
  assert(rejected, 'the release check must reject a resurrected npx-pinned .mcp.json');

  const staleEnv = path.join(TEMP, 'release-stale-env');
  fs.mkdirSync(path.join(staleEnv, 'plugins', 'project-knowledge', '.claude-plugin'), { recursive: true });
  fs.mkdirSync(path.join(staleEnv, 'plugins', 'project-knowledge', '.codex-plugin'), { recursive: true });
  fs.mkdirSync(path.join(staleEnv, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(staleEnv, 'package.json'), JSON.stringify({ name: '@sanqianx/project-knowledge', version: '1.0.0' }));
  fs.writeFileSync(path.join(staleEnv, 'package-lock.json'), JSON.stringify({ name: '@sanqianx/project-knowledge', version: '1.0.0', packages: { '': { version: '1.0.0' } } }));
  fs.writeFileSync(path.join(staleEnv, 'plugins', 'project-knowledge', '.claude-plugin', 'plugin.json'), JSON.stringify({ version: '1.0.0' }));
  fs.writeFileSync(path.join(staleEnv, 'plugins', 'project-knowledge', '.codex-plugin', 'plugin.json'), JSON.stringify({ version: '1.0.0' }));
  fs.writeFileSync(path.join(staleEnv, '.claude-plugin', 'marketplace.json'), JSON.stringify({ plugins: [{ version: '1.0.0' }] }));
  fs.writeFileSync(path.join(staleEnv, 'plugins', 'project-knowledge', '.mcp.json'), JSON.stringify({
    mcpServers: { 'project-knowledge': { type: 'stdio', command: 'node', args: ['-e', "require('scripts/mcp-launcher.cjs')"], cwd: '.', env: { KB_PLUGIN_VERSION: '0.9.9' } } },
  }, null, 2));
  let envRejected = false;
  try { inspectReleaseVersion(staleEnv, { webOnly: true }); } catch (error) { envRejected = /cwd|KB_PLUGIN_VERSION|plugin version|env/i.test(error.message); }
  assert(envRejected, 'the release check must reject a drifted env.KB_PLUGIN_VERSION and a resurrected cwd pin');

  const manifest = readJson(path.join(ROOT, 'module-runtime-manifest.json'));
  assert(manifest.productFiles && manifest.productFiles['plugins/project-knowledge/scripts/mcp-launcher.cjs'], 'the packaged product manifest must track the launcher');
  for (const script of ['_site/scripts/sync-product-content.js', '_site/scripts/verify-product-runtime.js']) {
    assert(fs.readFileSync(path.join(ROOT, script), 'utf8').includes('mcp-launcher.cjs'), `${script} must include the launcher in the product asset checklist`);
  }
}

async function main() {
  await testMcpManifestContract();
  await testLauncherFailureMatrix();
  await testRealHandshakeIgnoresBrokenNpxCache();
  await testBootstrapResolvesForBothNativeForms();
  await testInstallerBindingLifecycle();
  await testInstallAllCaptureOnlySkipsBinding();
  await testMcpStartupProbe();
  await testStatusScanDoesNotRespawn();
  await testCodexTrustSeparatedFromWaitingTrust();
  await testReleaseContracts();
  console.log('INTEGRATION_RUNTIME_BINDING_TEST_PASSED');
}

main().catch(error => {
  console.error('INTEGRATION_RUNTIME_BINDING_TEST_FAILED', error.message);
  process.exit(1);
});
