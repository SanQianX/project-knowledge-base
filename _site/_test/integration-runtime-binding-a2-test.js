// Run: node _site/_test/integration-runtime-binding-a2-test.js
//
// A2 hardening regressions (must fail before the fixes land):
//  - launcher pins the product package constant, joins KB_PLUGIN_VERSION into
//    the version agreement, bounds binding reads, and never echoes untrusted
//    values;
//  - the .mcp.json bootstrap never guesses from process.cwd;
//  - installer binding gating (captureOnly, failure isolation, byte
//    idempotence, direct entries) and zero-write status/dry-run;
//  - SDK-based probe contract (identity, tools, bounded stderr, no echo);
//  - client-scoped mcpStartup probes with dedupe and explicit misses.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { deepEqual } = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { IntegrationManager } = require('../lib/integration-installer');

const ROOT = path.resolve(__dirname, '..', '..');
const PLUGIN_ROOT = path.join(ROOT, 'plugins', 'project-knowledge');
const LAUNCHER = path.join(PLUGIN_ROOT, 'scripts', 'mcp-launcher.cjs');
const MCP_MANIFEST = path.join(PLUGIN_ROOT, '.mcp.json');
const RUNTIME_SCHEMA = 'project-knowledge/integration-runtime/v1';
const ERROR_SCHEMA = 'project-knowledge/mcp-launcher-error/v1';
const PKG = '@sanqianx/project-knowledge';
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-a2-' + process.pid + '-'));

function assert(condition, message) { if (!condition) throw new Error(message); }
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function dir(name) { const target = path.join(TEMP, name); fs.mkdirSync(target, { recursive: true }); return target; }
function bindingPathOf(dataDir) { return path.join(dataDir, 'integration-runtime.json'); }
function writeBinding(dataDir, overrides = {}) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(bindingPathOf(dataDir), JSON.stringify({
    schema: RUNTIME_SCHEMA, packageName: PKG, packageRoot: ROOT, version: VERSION,
    updatedAt: new Date().toISOString(), ...overrides,
  }, null, 2));
}
function runLauncher(dataDir, env = {}) {
  return spawnSync(process.execPath, [LAUNCHER], {
    encoding: 'utf8', windowsHide: true, timeout: 15000,
    env: { ...process.env, KB_DATA_DIR: dataDir, ...env },
  });
}
function launcherError(result, name) {
  const lines = String(result.stderr || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  assert(lines.length === 1, name + ': exactly one stderr diagnostics line is expected, got ' + lines.length);
  assert(result.status === 1, name + ': launcher failures must exit 1, got ' + result.status);
  const payload = JSON.parse(lines[0]);
  assert(payload.schema === ERROR_SCHEMA, name + ': error payload must carry the launcher error schema');
  assert(String(result.stdout || '').trim() === '', name + ': stdout must stay clean on failure');
  assert(typeof payload.message === 'string' && payload.message.length > 0 && payload.message.length < 500, name + ': fixed bounded message expected');
  return payload;
}
function fakePackage(root, { name = PKG, version = VERSION, bin = 'bin/project-knowledge-mcp.js', withEntry = true } = {}) {
  fs.mkdirSync(path.dirname(path.join(root, bin)), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name, version, bin: { 'project-knowledge-mcp': bin } }));
  if (withEntry) fs.writeFileSync(path.join(root, bin), 'process.exit(0);\n');
  return path.join(root, bin);
}
function bridgeStub() {
  return { createBridge: () => ({
    registerConsumer: async () => ({}), getConsumer: async () => ({}), getHealth: async () => ({}), ensureRuntimeHome: async () => ({}),
    installers: {
      claudeCode: { installClaudeCodeHook: async () => ({ added: [] }), statusClaudeCodeHook: async () => ({ installed: false }), uninstallClaudeCodeHook: async () => ({}) },
      codex: { statusCodexHook: async () => ({ installed: false }) },
    },
  }) };
}
function stubRunner(cmd, args) {
  return { status: 0, stdout: cmd === 'codex' && args[1] === 'list' ? '{}' : '[]', stderr: '' };
}

async function testManifestContractA2() {
  const server = readJson(MCP_MANIFEST).mcpServers['project-knowledge'];
  assert(server.type === 'stdio' && server.command === 'node' && server.args[0] === '-e', 'the stdio node -e chain stays');
  assert(server.cwd === undefined, 'A2 forbids the relative cwd pin in .mcp.json');
  assert(server.env && server.env.KB_PLUGIN_VERSION === VERSION, 'env.KB_PLUGIN_VERSION must carry the shipping version');
  const bootstrap = server.args[1];
  assert(!bootstrap.includes('process.cwd'), 'the bootstrap must never guess the launcher from process.cwd');
  assert(bootstrap.includes('CLAUDE_PLUGIN_ROOT') && bootstrap.includes('PLUGIN_ROOT'), 'trusted plugin-root variables stay first');
  assert(bootstrap.includes(PKG), 'the bootstrap must pin the product package constant');
  assert(bootstrap.includes('integration-runtime'), 'the bootstrap fallback must consult the durable binding');
}

async function testLauncherPinningMatrix() {
  // Both sides agree on a foreign package name: the constant pin must still reject it.
  const foreign = dir('foreign-pkg');
  fakePackage(foreign, { name: 'echo-marker-EVILPKG', version: '9.9.9-echo-marker' });
  const dataA = dir('foreign-data');
  writeBinding(dataA, { packageName: 'echo-marker-EVILPKG', packageRoot: foreign, version: '9.9.9-echo-marker' });
  const resultA = runLauncher(dataA);
  const errorA = launcherError(resultA, 'foreign-package');
  assert(errorA.code === 'BINDING_PACKAGE_MISMATCH', 'foreign package must be rejected by the constant pin, got ' + errorA.code);
  assert(!String(resultA.stderr).includes('echo-marker-EVILPKG') && !String(resultA.stderr).includes('9.9.9-echo-marker'), 'untrusted names and versions must not be echoed');

  // The plugin-declared version joins the binding/manifest agreement.
  const dataB = dir('plugin-version-data');
  writeBinding(dataB);
  const errorB = launcherError(runLauncher(dataB, { KB_PLUGIN_VERSION: '0.0.0-other' }), 'plugin-version');
  assert(errorB.code === 'BINDING_VERSION_MISMATCH', 'KB_PLUGIN_VERSION must join the version agreement, got ' + errorB.code);
  assert(!String(runLauncher(dataB, { KB_PLUGIN_VERSION: '0.0.0-other' }).stderr).includes('0.0.0-other'), 'the rejected version must not be echoed');

  // An entry that exists but is a directory must be rejected.
  const pkgC = dir('dir-entry-pkg');
  fs.mkdirSync(fakePackage(pkgC, { withEntry: false }), { recursive: true });
  const dataC = dir('dir-entry-data');
  writeBinding(dataC, { packageRoot: pkgC });
  assert(launcherError(runLauncher(dataC), 'directory-entry').code === 'BINDING_ENTRY_INVALID', 'a directory entry must be rejected');

  // A junction inside the package that resolves outside the real root must be rejected.
  const outside = dir('outside-real');
  fs.writeFileSync(path.join(outside, 'server.js'), 'process.exit(0);\n');
  const pkgD = dir('junction-pkg');
  fakePackage(pkgD, { bin: 'datalink/server.js', withEntry: false });
  fs.rmSync(path.join(pkgD, 'datalink'), { recursive: true, force: true });
  fs.symlinkSync(outside, path.join(pkgD, 'datalink'), 'junction');
  const dataD = dir('junction-data');
  writeBinding(dataD, { packageRoot: pkgD });
  assert(launcherError(runLauncher(dataD), 'junction-escape').code === 'BINDING_ENTRY_INVALID', 'realpath escape must be rejected');

  // Bindings beyond the bounded read are corrupt, not parsed.
  const dataE = dir('oversized-data');
  writeBinding(dataE, { padding: 'x'.repeat(40000) });
  assert(launcherError(runLauncher(dataE), 'oversized-binding').code === 'BINDING_CORRUPT', 'bindings beyond 32KB must be rejected as corrupt');

  // Untrusted schema values are never echoed back.
  const dataF = dir('schema-echo-data');
  writeBinding(dataF, { schema: 'echo-marker-SCHEMA/v9' });
  const resultF = runLauncher(dataF);
  assert(launcherError(resultF, 'schema-echo').code === 'BINDING_SCHEMA_MISMATCH', 'schema mismatch keeps its code');
  assert(!String(resultF.stderr).includes('echo-marker-SCHEMA'), 'schema values must not be echoed');
}

async function testBootstrapNeverGuessesFromCwd() {
  const bootstrap = readJson(MCP_MANIFEST).mcpServers['project-knowledge'].args[1];
  const decoy = dir('decoy-worktree');
  fs.mkdirSync(path.join(decoy, 'scripts'), { recursive: true });
  const sentinel = path.join(TEMP, 'decoy-sentinel.txt');
  fs.writeFileSync(path.join(decoy, 'scripts', 'mcp-launcher.cjs'), 'require(\'fs\').writeFileSync(process.env.A2_DECOY_SENTINEL, \'loaded\'); process.exit(7);\n');
  const baseEnv = { ...process.env, A2_DECOY_SENTINEL: sentinel };
  delete baseEnv.CLAUDE_PLUGIN_ROOT;
  delete baseEnv.PLUGIN_ROOT;
  const run = (env, cwd) => spawnSync(process.execPath, ['-e', bootstrap], {
    encoding: 'utf8', windowsHide: true, timeout: 15000, cwd, env,
  });
  const emptyData = dir('bootstrap-empty-data');
  const guessed = run({ ...baseEnv, KB_DATA_DIR: emptyData }, decoy);
  assert(!fs.existsSync(sentinel), 'the bootstrap must not load a same-named script from the working directory');
  assert(guessed.status === 127, 'without a trusted root or a usable binding the bootstrap must fail fast, got ' + guessed.status);
  assert(String(guessed.stderr || '').trim().length > 0, 'the bootstrap failure must leave a diagnostic');

  const trusted = run({ ...baseEnv, KB_DATA_DIR: emptyData, PLUGIN_ROOT: PLUGIN_ROOT }, decoy);
  assert(trusted.status === 1, 'the trusted plugin root must reach the real launcher, got ' + trusted.status);
  assert(/BINDING_MISSING/.test(String(trusted.stderr || '')), 'the real launcher then reports the missing binding');
  assert(!fs.existsSync(sentinel), 'the trusted form must still ignore the decoy');

  const corruptData = dir('bootstrap-corrupt-data');
  fs.mkdirSync(corruptData, { recursive: true });
  fs.writeFileSync(bindingPathOf(corruptData), '{ broken');
  const bound = run({ ...baseEnv, KB_DATA_DIR: corruptData }, decoy);
  assert(bound.status === 127, 'an unparseable binding is rejected by the bootstrap itself, got ' + bound.status);
  assert(!fs.existsSync(sentinel), 'the binding fallback must not load the decoy');

  const fakePkg = dir('bootstrap-fake-pkg');
  const fakeLauncher = path.join(fakePkg, 'plugins', 'project-knowledge', 'scripts', 'mcp-launcher.cjs');
  fs.mkdirSync(path.dirname(fakeLauncher), { recursive: true });
  fs.writeFileSync(fakeLauncher, 'process.stderr.write(\'BINDING_FALLBACK_REACHED\'); process.exit(5);\n');
  const fakeData = dir('bootstrap-fake-data');
  writeBinding(fakeData, { packageRoot: fakePkg });
  const reached = run({ ...baseEnv, KB_DATA_DIR: fakeData }, decoy);
  assert(reached.status === 5 && /BINDING_FALLBACK_REACHED/.test(String(reached.stderr || '')), 'a verified binding must resolve and load the in-package launcher');

  const evilData = dir('bootstrap-evil-data');
  writeBinding(evilData, { packageName: 'evil/pkg', packageRoot: decoy });
  const evil = run({ ...baseEnv, KB_DATA_DIR: evilData }, TEMP);
  assert(evil.status === 127, 'the binding fallback must pin the product package name');
  assert(!fs.existsSync(sentinel), 'a foreign binding must never point back at the working tree');
}

async function testCaptureOnlyNeverWritesKnowledgeBinding() {
  const home = dir('capture-only-home');
  const dataDir = path.join(home, 'data');
  const commands = [];
  const manager = new IntegrationManager({
    rootDir: ROOT, homeDir: home, env: { KB_DATA_DIR: dataDir },
    commandResolver: name => name,
    runner: (cmd, args) => { commands.push(args); return stubRunner(cmd, args); },
    bridgeModule: bridgeStub(),
  });
  const summary = await manager.installAll({ clients: ['claude'], captureOnly: true });
  assert(!fs.existsSync(bindingPathOf(dataDir)), 'captureOnly must not write the knowledge runtime binding');
  assert(commands.length === 0, 'captureOnly must not run knowledge client CLI, got ' + JSON.stringify(commands));
  assert(summary.clients[0].developmentCapture, 'capture results stay present');
  assert(!summary.clients[0].knowledgeIntegration, 'captureOnly must not fake knowledge results');
}

async function testBindingFailureGatesKnowledgeNotCapture() {
  const brokenRoot = dir('broken-pkg-root');
  fs.writeFileSync(path.join(brokenRoot, 'package.json'), JSON.stringify({ name: PKG, version: VERSION, bin: { 'project-knowledge-mcp': 'bin/missing.js' } }));
  fs.mkdirSync(path.join(brokenRoot, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(brokenRoot, '.claude-plugin', 'marketplace.json'), JSON.stringify({ plugins: [] }));
  const home = dir('broken-home');
  const dataDir = path.join(home, 'data');
  const commands = [];
  const manager = new IntegrationManager({
    rootDir: brokenRoot, homeDir: home, env: { KB_DATA_DIR: dataDir },
    commandResolver: name => name,
    runner: (cmd, args) => { commands.push(args); return stubRunner(cmd, args); },
    bridgeModule: bridgeStub(),
  });
  const summary = await manager.installAll({ clients: ['claude', 'codex'] });
  assert(summary.runtimeBinding && summary.runtimeBinding.ok === false, 'the failed binding must surface in the summary');
  for (const entry of summary.clients) {
    assert(entry.knowledgeIntegration && entry.knowledgeIntegration.ok === false, entry.client + ': knowledge must fail when the binding cannot be written');
    assert(entry.knowledgeIntegration.code === 'INTEGRATION_RUNTIME_BINDING_FAILED', entry.client + ': machine code expected');
    assert(entry.developmentCapture, entry.client + ': capture results stay independent');
  }
  assert(commands.length === 0, 'no client CLI may run while the binding fails, got ' + JSON.stringify(commands));
  assert(!fs.existsSync(bindingPathOf(dataDir)), 'no binding file may appear');
}

async function testRepeatedRepairIsByteIdempotent() {
  const home = dir('idempotence-home');
  const dataDir = path.join(home, 'data');
  const manager = new IntegrationManager({
    rootDir: ROOT, homeDir: home, env: { KB_DATA_DIR: dataDir },
    commandResolver: name => name, runner: stubRunner,
  });
  const first = manager.ensureIntegrationRuntimeBinding();
  assert(first.state === 'written', 'the first repair writes, got ' + first.state);
  const bytes = fs.readFileSync(bindingPathOf(dataDir));
  const mtime = fs.statSync(bindingPathOf(dataDir)).mtimeMs;
  await new Promise(resolve => setTimeout(resolve, 30));
  const again = manager.ensureIntegrationRuntimeBinding();
  assert(again.state === 'unchanged', 'an unchanged binding must not be rewritten, got ' + again.state);
  assert(fs.readFileSync(bindingPathOf(dataDir)).equals(bytes), 'binding bytes must stay identical across repeated repairs');
  assert(fs.statSync(bindingPathOf(dataDir)).mtimeMs === mtime, 'no rewrite means no mtime churn');
  writeBinding(dataDir, { version: '0.0.0-stale' });
  const repaired = manager.ensureIntegrationRuntimeBinding();
  assert(repaired.state === 'written', 'a drifted binding must be repaired, got ' + repaired.state);
  assert(readJson(bindingPathOf(dataDir)).version === VERSION, 'repair restores the shipping version');
}

async function testDirectKnowledgeEntriesEnsureTheBinding() {
  for (const client of ['claude', 'codex']) {
    const home = dir('direct-' + client + '-home');
    const dataDir = path.join(home, 'data');
    const manager = new IntegrationManager({
      rootDir: ROOT, homeDir: home, env: { KB_DATA_DIR: dataDir },
      commandResolver: name => name, runner: stubRunner,
    });
    try { await (client === 'claude' ? manager.installClaude() : manager.installCodex()); } catch { /* verify steps may fail under stubs; the binding contract is what matters */ }
    assert(fs.existsSync(bindingPathOf(dataDir)), client + ': direct knowledge install must ensure the runtime binding');
  }
}

async function testStatusAndDryRunNeverWriteBindings() {
  const home = dir('status-home');
  const dataDir = path.join(home, 'data');
  const manager = new IntegrationManager({
    rootDir: ROOT, homeDir: home, env: { KB_DATA_DIR: dataDir },
    commandResolver: name => name, runner: stubRunner,
    mcpProbe: async () => ({ state: 'ready', checkedAt: new Date().toISOString() }),
    bridgeModule: bridgeStub(),
  });
  await manager.statusAll({ clients: ['claude'] });
  assert(!fs.existsSync(bindingPathOf(dataDir)), 'status must not create bindings');
  const dryHome = dir('dry-home');
  const dry = new IntegrationManager({
    rootDir: ROOT, homeDir: dryHome, env: { KB_DATA_DIR: path.join(dryHome, 'data') },
    dryRun: true, commandResolver: name => name, runner: stubRunner,
  });
  await dry.operate('install', ['claude']);
  assert(dry.planned.some(step => step.command === 'runtime-binding'), 'dry-run plans the binding');
  assert(!fs.existsSync(dry.integrationRuntimeBindingPath()), 'dry-run must not write the binding');
}

const STUB_TOOLS = ['project_knowledge_resolve', 'project_knowledge_record_requirement', 'project_knowledge_search', 'project_knowledge_ask', 'project_knowledge_get', 'project_knowledge_history'];
const STUB_SERVER_SOURCE = [
  'const mode = process.env.A2_STUB_MODE || \'ok\';',
  'const version = process.env.A2_STUB_VERSION || \'\';',
  'const tools = ' + JSON.stringify(STUB_TOOLS) + ';',
  'let buffer = \'\';',
  'const send = message => process.stdout.write(JSON.stringify(message) + String.fromCharCode(10));',
  'process.stdin.setEncoding(\'utf8\');',
  'process.stdin.on(\'data\', chunk => {',
  '  buffer += chunk;',
  '  let index;',
  '  while ((index = buffer.indexOf(String.fromCharCode(10))) >= 0) {',
  '    const line = buffer.slice(0, index).trim();',
  '    buffer = buffer.slice(index + 1);',
  '    if (!line) continue;',
  '    let message; try { message = JSON.parse(line); } catch { continue; }',
  '    if (message.method === \'initialize\' && mode !== \'hang\') {',
  '      if (mode === \'wrong-name\') send({ jsonrpc: \'2.0\', id: message.id, result: { protocolVersion: \'2025-06-18\', capabilities: {}, serverInfo: { name: \'evil-server\', version } } });',
  '      else if (mode === \'wrong-version\') send({ jsonrpc: \'2.0\', id: message.id, result: { protocolVersion: \'2025-06-18\', capabilities: {}, serverInfo: { name: \'project-knowledge\', version: \'0.0.1-bad\' } } });',
  '      else if (mode === \'hostile\') send({ jsonrpc: \'2.0\', id: message.id, error: { code: -32000, message: \'INJECT-SCRIPT-MARKER sk-abcdef123456\' } });',
    '      else { send({ jsonrpc: \'2.0\', id: message.id, result: { protocolVersion: \'2025-06-18\', capabilities: {}, serverInfo: { name: \'project-knowledge\', version } } }); if (mode === \'stderr-flood\') { process.stderr.write(Buffer.alloc(65536, 120)); const timer = setInterval(() => process.stderr.write(Buffer.alloc(8192, 120)), 5); setTimeout(() => clearInterval(timer), 4000); } if (mode === \'stdout-flood\') process.stdout.write(String.fromCharCode(34) + \'STDOUT-FLOOD-DO-NOT-ECHO \' + \'x\'.repeat(262144)); }',
  '    } else if (message.method === \'notifications/initialized\') {',
  '      if (mode === \'stderr-flood\') { const timer = setInterval(() => process.stderr.write(\'FLOOD-MARKER \' + \'x\'.repeat(4096) + String.fromCharCode(10)), 5); setTimeout(() => clearInterval(timer), 4000); }',
  '    } else if (message.method === \'tools/list\') {',
  '      const list = mode === \'tools-short\' ? tools.slice(0, 5) : tools;',
  '      if (mode !== \'stderr-flood\') send({ jsonrpc: \'2.0\', id: message.id, result: { tools: list.map(name => ({ name, inputSchema: { type: \'object\' } })) } });',
  '    }',
  '  }',
  '});',
].join('\n');

function stubServerPackage(mode) {
  const pkg = dir('stub-' + mode + '-pkg');
  const entry = path.join(pkg, 'bin', 'project-knowledge-mcp.js');
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.writeFileSync(entry, STUB_SERVER_SOURCE);
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: PKG, version: VERSION, bin: { 'project-knowledge-mcp': 'bin/project-knowledge-mcp.js' } }));
  const dataDir = dir('stub-' + mode + '-data');
  writeBinding(dataDir, { packageRoot: pkg });
  return dataDir;
}

function probeManager(mode, dataDir) {
  return new IntegrationManager({
    rootDir: ROOT, homeDir: dir('probe-' + mode + '-home'), env: { KB_DATA_DIR: dataDir, A2_STUB_MODE: mode, A2_STUB_VERSION: VERSION },
    commandResolver: name => name, runner: stubRunner,
  });
}

async function testProbeContractA2() {
  const okData = stubServerPackage('ok');
  const ok = await probeManager('ok', okData).probeMcpStartup({ timeoutMs: 12000 });
  assert(ok.state === 'ready', 'healthy stub must probe ready, got ' + JSON.stringify(ok));
  assert(ok.scope === 'product-runtime', 'the default probe scope is product-runtime');
  assert(ok.serverName === 'project-knowledge', 'the probe must verify the server identity');
  assert(ok.actualVersion === VERSION && ok.expectedVersion === VERSION, 'versions must be reported');
  assert(Array.isArray(ok.tools) && ok.tools.length === 6, 'the six knowledge tools must be verified');

  const wrongName = await probeManager('wrong-name', stubServerPackage('wrong-name')).probeMcpStartup({ timeoutMs: 12000 });
  assert(wrongName.state === 'failed' && wrongName.code === 'SERVER_IDENTITY', 'foreign serverInfo.name must fail SERVER_IDENTITY, got ' + JSON.stringify(wrongName));

  const wrongVersion = await probeManager('wrong-version', stubServerPackage('wrong-version')).probeMcpStartup({ timeoutMs: 12000 });
  assert(wrongVersion.state === 'failed' && wrongVersion.code === 'VERSION_MISMATCH', 'a foreign server version must fail VERSION_MISMATCH, got ' + JSON.stringify(wrongVersion));

  const shortTools = await probeManager('tools-short', stubServerPackage('tools-short')).probeMcpStartup({ timeoutMs: 12000 });
  assert(shortTools.state === 'failed' && shortTools.code === 'TOOLS_CONTRACT', 'a five-tool server must fail TOOLS_CONTRACT, got ' + JSON.stringify(shortTools));

  const hostile = await probeManager('hostile', stubServerPackage('hostile')).probeMcpStartup({ timeoutMs: 12000 });
  assert(hostile.state === 'failed', 'a hostile initialize must fail');
  assert(!JSON.stringify(hostile).includes('INJECT-SCRIPT-MARKER') && !JSON.stringify(hostile).includes('sk-abcdef123456'), 'upstream error text must never be reflected');
  assert(JSON.stringify(hostile).length < 2000, 'probe results stay bounded');

  const floodStarted = Date.now();
  const flood = await probeManager('stderr-flood', stubServerPackage('stderr-flood')).probeMcpStartup({ timeoutMs: 9000 });
  assert(flood.state === 'failed' && flood.code === 'PROBE_OUTPUT_OVERFLOW', 'unbounded stderr must fail fast with PROBE_OUTPUT_OVERFLOW, got ' + JSON.stringify(flood));
  assert(Date.now() - floodStarted < 7500, 'the overflow failure must not wait for the whole timeout');
  assert(!JSON.stringify(flood).includes('FLOOD-MARKER'), 'flood text must not be reflected');

  const hangStarted = Date.now();
  const hang = await probeManager('hang', stubServerPackage('hang')).probeMcpStartup({ timeoutMs: 1200 });
  assert(hang.state === 'failed' && hang.code === 'PROBE_TIMEOUT', 'a silent server must fail with PROBE_TIMEOUT');
  assert(Date.now() - hangStarted < 6000, 'timeout cleanup must be prompt');

  const fake = path.join(TEMP, 'echo-launcher.cjs');
  fs.writeFileSync(fake, 'process.stderr.write(JSON.stringify({ schema: ' + JSON.stringify(ERROR_SCHEMA) + ', code: \'BINDING_CORRUPT\', message: \'INJECT-LAUNCHER-MARKER\' })); process.exit(1);\n');
  const echoed = await probeManager('ok', okData).probeMcpStartup({ launcherPath: fake, timeoutMs: 9000 });
  assert(echoed.state === 'failed' && echoed.code === 'BINDING_CORRUPT', 'launcher error codes pass through, got ' + JSON.stringify(echoed));
  assert(!JSON.stringify(echoed).includes('INJECT-LAUNCHER-MARKER'), 'launcher error messages must not be reflected');
}

function installedPluginEntry(dirName) {
  const pluginDir = dir(dirName);
  fs.mkdirSync(path.join(pluginDir, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(pluginDir, 'scripts', 'mcp-launcher.cjs'), '/* installed copy */\n');
  return pluginDir;
}
function claudeHomeWith(cacheDir) {
  const home = dir('claude-home-' + path.basename(cacheDir));
  fs.mkdirSync(path.join(home, '.claude', 'plugins'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: { 'project-knowledge@project-knowledge': [{ version: VERSION, installPath: cacheDir }] } }));
  return home;
}
function codexRunnerWith(sourcePath) {
  return (cmd, args) => ({
    status: 0, stderr: '',
    stdout: cmd === 'codex' && args[1] === 'list'
      ? JSON.stringify({ installed: [{ pluginId: 'project-knowledge@project-knowledge', version: VERSION, enabled: true, source: { path: sourcePath } }] })
      : '[]',
  });
}

function codexMarketplaceHarness(listStdout, addResults, homeName) {
  const calls = [];
  let addIndex = 0;
  const runner = (cmd, args) => {
    calls.push(args.join(' '));
    if (args.join(' ') === 'plugin marketplace list') return { status: 0, stdout: listStdout, stderr: '' };
    if (args.slice(0, 3).join(' ') === 'plugin marketplace add') {
      const result = addResults[addIndex++] || { status: 0, stderr: '' };
      return { status: result.status, stdout: '', stderr: result.stderr };
    }
    return { status: 0, stdout: '{}', stderr: '' };
  };
  const manager = new IntegrationManager({ rootDir: ROOT, homeDir: dir(homeName), env: {}, commandResolver: name => name, runner });
  return { manager, calls };
}

async function testStatusAllClientScopedProbes() {
  const claudeCache = installedPluginEntry('claude-plugin-cache');
  const codexPluginDir = installedPluginEntry('codex-plugin-source');
  const calls = [];
  const manager = new IntegrationManager({
    rootDir: ROOT, homeDir: claudeHomeWith(claudeCache), env: {},
    commandResolver: name => name, runner: codexRunnerWith(codexPluginDir),
    mcpProbe: info => { calls.push(info); return Promise.resolve({ state: 'ready', checkedAt: new Date().toISOString(), scope: info.scope }); },
    codexHookProbe: async () => ({ data: [{ cwd: TEMP, hooks: [{ pluginId: 'project-knowledge@project-knowledge', eventName: 'userPromptSubmit', command: 'node scripts/context-hook.cjs --client codex', enabled: true, trustStatus: 'trusted' }] }] }),
    bridgeModule: bridgeStub(),
  });
  const summary = await manager.statusAll({ clients: ['claude', 'codex'] });
  const claude = summary.clients.find(entry => entry.client === 'claude');
  const codex = summary.clients.find(entry => entry.client === 'codex');
  const claudeCall = calls.find(call => call.scope === 'client:claude');
  const codexCall = calls.find(call => call.scope === 'client:codex');
  assert(claudeCall && claudeCall.launcherPath === path.join(claudeCache, 'scripts', 'mcp-launcher.cjs'), 'the claude probe must target the installed plugin entry, got ' + JSON.stringify(calls));
  assert(codexCall && codexCall.launcherPath === path.join(codexPluginDir, 'scripts', 'mcp-launcher.cjs'), 'the codex probe must target the installed plugin source');
  assert(claude.mcpStartup && claude.mcpStartup.scope === 'client:claude', 'claude status carries the client-scoped probe');
  assert(codex.mcpStartup && codex.mcpStartup.scope === 'client:codex', 'codex status carries the client-scoped probe');
  assert(summary.mcpRuntime && summary.mcpRuntime.scope === 'product-runtime', 'the shared product-runtime probe lands in the summary');

  const shared = installedPluginEntry('shared-plugin-dir');
  const deduped = [];
  const manager2 = new IntegrationManager({
    rootDir: ROOT, homeDir: claudeHomeWith(shared), env: {},
    commandResolver: name => name, runner: codexRunnerWith(shared),
    mcpProbe: info => { deduped.push(info); return Promise.resolve({ state: 'ready', scope: info.scope }); },
    codexHookProbe: async () => ({ data: [{ cwd: TEMP, hooks: [] }] }),
    bridgeModule: bridgeStub(),
  });
  await manager2.statusAll({ clients: ['claude', 'codex'] });
  const clientScoped = deduped.filter(call => call.scope !== 'product-runtime');
  assert(clientScoped.length === 1, 'identical installed entries must share one probe, got ' + JSON.stringify(clientScoped));
  assert(deduped.some(call => call.scope === 'product-runtime'), 'the host probe still runs');

  const absentCalls = [];
  const manager3 = new IntegrationManager({
    rootDir: ROOT, homeDir: dir('absent-home'), env: {},
    commandResolver: name => name, runner: stubRunner,
    mcpProbe: info => { absentCalls.push(info); return Promise.resolve({ state: 'ready', scope: info.scope }); },
    bridgeModule: bridgeStub(),
  });
  const missing = await manager3.statusAll({ clients: ['claude', 'codex'] });
  const claudeMiss = missing.clients.find(entry => entry.client === 'claude');
  const codexMiss = missing.clients.find(entry => entry.client === 'codex');
  assert(claudeMiss.mcpStartup && claudeMiss.mcpStartup.state === 'failed' && claudeMiss.mcpStartup.code === 'CLIENT_PLUGIN_ENTRY_MISSING', 'claude without an installed entry reports the explicit miss, got ' + JSON.stringify(claudeMiss.mcpStartup));
  assert(codexMiss.mcpStartup && codexMiss.mcpStartup.code === 'CLIENT_PLUGIN_ENTRY_MISSING', 'codex without an installed entry reports the explicit miss');
  assert(absentCalls.every(call => call.scope === 'product-runtime'), 'no client probe may run when no installed entry exists, got ' + JSON.stringify(absentCalls));
}

async function testEnsureCodexMarketplacePolicy() {
  // An own old local marketplace (a previous accepted npm prefix) is replaced
  // with the current package root; the old package files are never touched.
  const oldRoot = dir('codex-old-npm-root');
  fakePackage(oldRoot, { version: '5.0.15' });
  const replace = codexMarketplaceHarness(`MARKETPLACE ROOT\nproject-knowledge ${oldRoot}\n`, [{ status: 0 }], 'codex-own-home');
  replace.manager.ensureCodexMarketplace();
  deepEqual(replace.calls, ['plugin marketplace list', 'plugin marketplace remove project-knowledge', 'plugin marketplace add ' + ROOT], 'own old local marketplace must be replaced by the current package root');
  assert(fs.existsSync(path.join(oldRoot, 'package.json')), 'replacing a marketplace never deletes old package files');

  // An unknown third-party same-name source is refused without any removal.
  const foreign = dir('codex-foreign-root');
  fakePackage(foreign, { name: 'other-vendor/plugin-pack', version: '1.0.0' });
  const refuse = codexMarketplaceHarness(`project-knowledge ${foreign}\n`, [], 'codex-foreign-home');
  let refused = false;
  try { refuse.manager.ensureCodexMarketplace(); } catch (error) { refused = /第三方来源/.test(error.message); }
  assert(refused, 'an unverifiable same-name marketplace must be refused');
  deepEqual(refuse.calls, ['plugin marketplace list'], 'a refused marketplace must not be removed or re-added');

  // A failed replacement restores the previous source; a failed rollback is explicit.
  const rollback = codexMarketplaceHarness(`project-knowledge ${oldRoot}\n`, [{ status: 1, stderr: 'boom' }, { status: 0 }], 'codex-rollback-home');
  let rolled = false;
  try { rollback.manager.ensureCodexMarketplace(); } catch (error) { rolled = /恢复原市场来源/.test(error.message); }
  assert(rolled, 'a failed replacement must report the rollback');
  deepEqual(rollback.calls, ['plugin marketplace list', 'plugin marketplace remove project-knowledge', 'plugin marketplace add ' + ROOT, 'plugin marketplace add ' + oldRoot], 'the old source must be restored after a failed add');
  const broken = codexMarketplaceHarness(`project-knowledge ${oldRoot}\n`, [{ status: 1, stderr: 'boom' }, { status: 1, stderr: 'boom' }], 'codex-broken-home');
  let manual = false;
  try { broken.manager.ensureCodexMarketplace(); } catch (error) { manual = /手动检查/.test(error.message); }
  assert(manual, 'a failed rollback must direct the user to inspect the marketplace manually');

  // The current root is a no-op; dead paths and own GitHub sources move to the
  // local package; a fresh install never registers the GitHub remote.
  const current = codexMarketplaceHarness(`project-knowledge ${ROOT}\n`, [], 'codex-current-home');
  current.manager.ensureCodexMarketplace();
  deepEqual(current.calls, ['plugin marketplace list'], 'an already-current marketplace is a no-op');
  const deadSource = path.join(dir('codex-dead-root'), 'vanished');
  const deadReplace = codexMarketplaceHarness(`project-knowledge ${deadSource}\n`, [{ status: 0 }], 'codex-dead-home');
  deadReplace.manager.ensureCodexMarketplace();
  assert(deadReplace.calls[2] === 'plugin marketplace add ' + ROOT, 'a dead source path is safe to replace');
  const github = codexMarketplaceHarness('project-knowledge SanQianX/project-knowledge-base\n', [{ status: 0 }], 'codex-github-home');
  github.manager.ensureCodexMarketplace();
  assert(github.calls.includes('plugin marketplace add ' + ROOT), 'our own GitHub marketplace moves to the local package');
  const fresh = codexMarketplaceHarness('MARKETPLACE ROOT\n', [], 'codex-fresh-home');
  fresh.manager.ensureCodexMarketplace();
  deepEqual(fresh.calls, ['plugin marketplace list', 'plugin marketplace add ' + ROOT], 'a fresh install registers the local npm package, not GitHub');
}

async function testProbeEnvUsesManagerDataDir() {
  // A host KB_DATA_DIR (for example an exported Workbench session dir) must
  // not leak into the probe: the manager's own home-based binding wins.
  const goodData = stubServerPackage('ok-env');
  const goodHome = dir('env-good-home');
  fs.mkdirSync(path.join(goodHome, '.project-knowledge-v5'), { recursive: true });
  fs.copyFileSync(bindingPathOf(goodData), path.join(goodHome, '.project-knowledge-v5', 'integration-runtime.json'));
  const evilPkg = dir('env-evil-pkg');
  fakePackage(evilPkg, { version: '5.0.15' });
  const evilData = dir('env-evil-data');
  writeBinding(evilData, { packageRoot: evilPkg, version: '5.0.15' });
  const manager = new IntegrationManager({
    rootDir: ROOT, homeDir: goodHome, env: { A2_STUB_VERSION: VERSION },
    commandResolver: name => name, runner: stubRunner,
  });
  const previous = process.env.KB_DATA_DIR;
  process.env.KB_DATA_DIR = evilData;
  let probe;
  try { probe = await manager.probeMcpStartup({ timeoutMs: 12000 }); } finally {
    if (previous === undefined) delete process.env.KB_DATA_DIR; else process.env.KB_DATA_DIR = previous;
  }
  assert(probe.state === 'ready', 'the probe must use the manager own data dir, not the inherited KB_DATA_DIR, got ' + JSON.stringify(probe));
  assert(probe.actualVersion === VERSION, 'the isolated binding version must be the one probed');
}

async function testProbeStdoutOverflow() {
  const started = Date.now();
  const flood = await probeManager('stdout-flood', stubServerPackage('stdout-flood')).probeMcpStartup({ timeoutMs: 9000 });
  assert(flood.state === 'failed' && flood.code === 'PROBE_OUTPUT_OVERFLOW', 'a single-line stdout flood must fail at the byte cap, got ' + JSON.stringify(flood));
  assert(Date.now() - started < 7500, 'the stdout overflow must fail before the whole timeout');
  assert(!JSON.stringify(flood).includes('STDOUT-FLOOD-DO-NOT-ECHO'), 'stdout flood text must not be reflected');
}

async function main() {
  const tests = [
    ['manifest', testManifestContractA2],
    ['launcher', testLauncherPinningMatrix],
    ['bootstrap', testBootstrapNeverGuessesFromCwd],
    ['captureOnly', testCaptureOnlyNeverWritesKnowledgeBinding],
    ['gating', testBindingFailureGatesKnowledgeNotCapture],
    ['idempotence', testRepeatedRepairIsByteIdempotent],
    ['direct', testDirectKnowledgeEntriesEnsureTheBinding],
    ['zerowrite', testStatusAndDryRunNeverWriteBindings],
    ['probe', testProbeContractA2],
    ['scopes', testStatusAllClientScopedProbes],
    ['codex-marketplace', testEnsureCodexMarketplacePolicy],
    ['probe-env', testProbeEnvUsesManagerDataDir],
    ['stdout-flood', testProbeStdoutOverflow],
  ];
  const only = process.env.A2_ONLY;
  for (const [name, test] of tests) {
    if (only && name !== only) continue;
    await test();
  }
  console.log('INTEGRATION_RUNTIME_BINDING_A2_TEST_PASSED');
}

main().catch(error => {
  console.error('INTEGRATION_RUNTIME_BINDING_A2_TEST_FAILED', error.message);
  process.exit(1);
});
