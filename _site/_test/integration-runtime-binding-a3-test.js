// Run: node _site/_test/integration-runtime-binding-a3-test.js
//
// A3 acceptance hardening regressions (must fail before the fixes land):
//  - a crashing mcpProbe reports the fixed PROBE_CRASH diagnostic and never
//    echoes the exception text (SYNTHETIC_PRIVATE_MARKER counter-example);
//  - a launcher stderr payload.code outside the allowlist never becomes a
//    result code (fixed LAUNCHER_ERROR_UNKNOWN), while allowlisted codes pass;
//  - an abnormal serverVersion is never echoed (VERSION_MISMATCH only);
//  - install-time binding validation enforces bin realpath containment and a
//    regular-file entry before any binding is written;
//  - the launcher spawns with windowsHide and no "本产品签发" signing claim;
//  - C2 minimal wiring: the supervised terminal spec carries
//    KB_KNOWLEDGE_DATA_DIR (non-secret product root) in both command branches,
//    while AGENT_TERMINAL_DATA_DIR stays the dedicated workbench subtree.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { deepEqual } = require('node:assert/strict');
const { IntegrationManager } = require('../lib/integration-installer');
const { ModuleBridge } = require('../lib/module-bridge');

const ROOT = path.resolve(__dirname, '..', '..');
const LAUNCHER = path.join(ROOT, 'plugins', 'project-knowledge', 'scripts', 'mcp-launcher.cjs');
const INSTALLER = path.join(ROOT, '_site', 'lib', 'integration-installer.js');
const RUNTIME_SCHEMA = 'project-knowledge/integration-runtime/v1';
const ERROR_SCHEMA = 'project-knowledge/mcp-launcher-error/v1';
const PKG = '@sanqianx/project-knowledge';
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-a3-' + process.pid + '-'));

function assert(condition, message) { if (!condition) throw new Error(message); }
function dir(name) { const target = path.join(TEMP, name); fs.mkdirSync(target, { recursive: true }); return target; }
function bindingPathOf(dataDir) { return path.join(dataDir, 'integration-runtime.json'); }
function writeBinding(dataDir, overrides = {}) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(bindingPathOf(dataDir), JSON.stringify({
    schema: RUNTIME_SCHEMA, packageName: PKG, packageRoot: ROOT, version: VERSION,
    updatedAt: new Date().toISOString(), ...overrides,
  }, null, 2));
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

async function testProbeCrashNeverEchoes() {
  const manager = new IntegrationManager({
    rootDir: ROOT, homeDir: dir('crash-home'), env: {},
    commandResolver: name => name, runner: stubRunner,
    mcpProbe: async () => { throw Error('SYNTHETIC_PRIVATE_MARKER'); },
    bridgeModule: bridgeStub(),
  });
  const summary = await manager.statusAll({ clients: ['claude'] });
  const runtime = summary.mcpRuntime;
  assert(runtime && runtime.state === 'failed' && runtime.code === 'PROBE_CRASH', 'a crashing probe reports PROBE_CRASH, got ' + JSON.stringify(runtime));
  assert(runtime.detail === '启动探测自身异常终止；已使用固定诊断，未回显异常内容。', 'PROBE_CRASH must carry the fixed redacted diagnostic, got ' + JSON.stringify(runtime.detail));
  assert(!JSON.stringify(summary).includes('SYNTHETIC_PRIVATE_MARKER'), 'probe crash text must never be reflected into status results');
}

async function testLauncherCodeAllowlist() {
  const base = {
    rootDir: ROOT, homeDir: dir('code-home'), env: {},
    commandResolver: name => name, runner: stubRunner,
  };
  const leaky = path.join(TEMP, 'code-leak-launcher.cjs');
  fs.writeFileSync(leaky, 'process.stderr.write(JSON.stringify({ schema: ' + JSON.stringify(ERROR_SCHEMA) + ', code: \'SYNTHETIC_CODE_LEAK\', message: \'SYNTHETIC_STDERR_MARKER\' })); process.exit(1);\n');
  const leaked = await new IntegrationManager(base).probeMcpStartup({ launcherPath: leaky, timeoutMs: 9000 });
  assert(leaked.state === 'failed' && leaked.code === 'LAUNCHER_ERROR_UNKNOWN', 'unlisted launcher codes collapse to LAUNCHER_ERROR_UNKNOWN, got ' + JSON.stringify(leaked));
  assert(!JSON.stringify(leaked).includes('SYNTHETIC_CODE_LEAK') && !JSON.stringify(leaked).includes('SYNTHETIC_STDERR_MARKER'), 'untrusted launcher stderr values must never be echoed');

  const allowed = path.join(TEMP, 'allowed-code-launcher.cjs');
  fs.writeFileSync(allowed, 'process.stderr.write(JSON.stringify({ schema: ' + JSON.stringify(ERROR_SCHEMA) + ', code: \'BINDING_ENTRY_INVALID\', message: \'SYNTHETIC_STDERR_MARKER\' })); process.exit(1);\n');
  const passed = await new IntegrationManager({ ...base, homeDir: dir('code-home-allowed') }).probeMcpStartup({ launcherPath: allowed, timeoutMs: 9000 });
  assert(passed.state === 'failed' && passed.code === 'BINDING_ENTRY_INVALID', 'allowlisted launcher codes keep passing through, got ' + JSON.stringify(passed));
  assert(!JSON.stringify(passed).includes('SYNTHETIC_STDERR_MARKER'), 'launcher messages stay unechoed even for allowlisted codes');
}

const STUB_TOOLS = ['project_knowledge_resolve', 'project_knowledge_record_requirement', 'project_knowledge_search', 'project_knowledge_ask', 'project_knowledge_get', 'project_knowledge_history'];
const A3_STUB_SOURCE = [
  'const marker = process.env.A3_VERSION_MARKER || \'0.0.1-SYNTHETIC_VERSION\';',
  'let buffer = \'\';',
  'const send = message => process.stdout.write(JSON.stringify(message) + String.fromCharCode(10));',
  'process.stdin.setEncoding(\'utf8\');',
  'process.stdin.on(\'data\', chunk => {',
  '  buffer += chunk; let index;',
  '  while ((index = buffer.indexOf(String.fromCharCode(10))) >= 0) {',
  '    const line = buffer.slice(0, index).trim(); buffer = buffer.slice(index + 1);',
  '    if (!line) continue; let message; try { message = JSON.parse(line); } catch { continue; }',
  '    if (message.method === \'initialize\') {',
  '      send({ jsonrpc: \'2.0\', id: message.id, result: { protocolVersion: \'2025-06-18\', capabilities: {}, serverInfo: { name: \'project-knowledge\', version: marker } } });',
  '    } else if (message.method === \'tools/list\') {',
  '      send({ jsonrpc: \'2.0\', id: message.id, result: { tools: ' + JSON.stringify(STUB_TOOLS.map(name => ({ name, inputSchema: { type: 'object' } }))) + ' } });',
  '    }',
  '  }',
  '});',
].join('\n');

async function testVersionMismatchNeverEchoesServerVersion() {
  const pkg = dir('version-marker-pkg');
  const entry = path.join(pkg, 'bin', 'project-knowledge-mcp.js');
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.writeFileSync(entry, A3_STUB_SOURCE);
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: PKG, version: VERSION, bin: { 'project-knowledge-mcp': 'bin/project-knowledge-mcp.js' } }));
  const dataDir = dir('version-marker-data');
  writeBinding(dataDir, { packageRoot: pkg });
  const manager = new IntegrationManager({
    rootDir: ROOT, homeDir: dir('version-home'), env: { KB_DATA_DIR: dataDir, A3_VERSION_MARKER: '0.0.1-SYNTHETIC_VERSION' },
    commandResolver: name => name, runner: stubRunner,
  });
  const result = await manager.probeMcpStartup({ timeoutMs: 12000 });
  assert(result.state === 'failed' && result.code === 'VERSION_MISMATCH', 'a foreign server version fails VERSION_MISMATCH, got ' + JSON.stringify(result));
  assert(result.actualVersion === undefined, 'the abnormal serverVersion must not be echoed as actualVersion');
  assert(!JSON.stringify(result).includes('0.0.1-SYNTHETIC_VERSION'), 'the foreign version string must never appear in the probe result');
}

async function testInstallTimeBinRealpathBoundary() {
  // A junction inside the package resolving outside the real root must be
  // rejected before any binding file is written.
  const outside = dir('binding-outside-real');
  fs.writeFileSync(path.join(outside, 'server.js'), 'process.exit(0);\n');
  const junctionPkg = dir('binding-junction-pkg');
  fakePackage(junctionPkg, { bin: 'datalink/server.js', withEntry: false });
  fs.rmSync(path.join(junctionPkg, 'datalink'), { recursive: true, force: true });
  fs.symlinkSync(outside, path.join(junctionPkg, 'datalink'), 'junction');
  const junctionData = dir('binding-junction-data');
  const junctionManager = new IntegrationManager({ rootDir: junctionPkg, homeDir: dir('binding-junction-home'), env: { KB_DATA_DIR: junctionData }, commandResolver: name => name, runner: stubRunner });
  let junctionRejected = false;
  try { junctionManager.ensureIntegrationRuntimeBinding(); } catch (error) { junctionRejected = true; }
  assert(junctionRejected, 'an entry whose realpath escapes the package root must be rejected at install time');
  assert(!fs.existsSync(bindingPathOf(junctionData)), 'a rejected entry must not produce a binding file');

  // A bin entry that is a directory is not a regular file: rejected.
  const dirPkg = dir('binding-dir-pkg');
  fs.mkdirSync(fakePackage(dirPkg, { withEntry: false }), { recursive: true });
  const dirData = dir('binding-dir-data');
  const dirManager = new IntegrationManager({ rootDir: dirPkg, homeDir: dir('binding-dir-home'), env: { KB_DATA_DIR: dirData }, commandResolver: name => name, runner: stubRunner });
  let dirRejected = false;
  try { dirManager.ensureIntegrationRuntimeBinding(); } catch (error) { dirRejected = true; }
  assert(dirRejected, 'a directory bin entry must be rejected at install time');
  assert(!fs.existsSync(bindingPathOf(dirData)), 'no binding file may appear for a directory entry');

  // A regular in-package file binds normally.
  const okPkg = dir('binding-ok-pkg');
  fakePackage(okPkg);
  const okData = dir('binding-ok-data');
  const okManager = new IntegrationManager({ rootDir: okPkg, homeDir: dir('binding-ok-home'), env: { KB_DATA_DIR: okData }, commandResolver: name => name, runner: stubRunner });
  const bound = okManager.ensureIntegrationRuntimeBinding();
  assert(bound.state === 'written' && fs.existsSync(bindingPathOf(okData)), 'a regular in-package bin entry still binds');
  assert(readBindingPackageRoot(okData) === path.resolve(okPkg), 'the binding pins the validated package root');
}

function readBindingPackageRoot(dataDir) {
  return JSON.parse(fs.readFileSync(bindingPathOf(dataDir), 'utf8')).packageRoot;
}

async function testLauncherStaticHardening() {
  const launcherSource = fs.readFileSync(LAUNCHER, 'utf8');
  assert(launcherSource.includes('windowsHide: true'), 'the launcher must spawn the MCP entry with windowsHide: true');
  assert(!launcherSource.includes('本产品签发'), 'the launcher must not claim a signing authority it does not have');
  const installerSource = fs.readFileSync(INSTALLER, 'utf8');
  assert(!installerSource.includes('本产品签发'), 'installer diagnostics must not claim a signing authority');
}

async function testTerminalSpecCarriesKnowledgeDataDir() {
  const dataDir = dir('terminal-knowledge-data');
  const bridgeFor = () => new ModuleBridge({
    terminalUrl: 'http://127.0.0.1:1',
    vectorHubUrl: 'http://127.0.0.1:1',
    eventBridgeUrl: 'http://127.0.0.1:1',
    engineUrl: 'http://127.0.0.1:1',
    dataDir,
  });
  const savedCommand = process.env.KB_TERMINAL_COMMAND;
  try {
    process.env.KB_TERMINAL_COMMAND = 'node C:/explicit/terminal-server.js';
    const overrideSpec = bridgeFor()._supervisedSpecs().find(spec => spec.name === 'terminal');
    assert(overrideSpec, 'the KB_TERMINAL_COMMAND branch must produce a terminal spec');
    assert(overrideSpec.env.KB_KNOWLEDGE_DATA_DIR === dataDir, 'the override branch must pass the product knowledge root, got ' + JSON.stringify(overrideSpec.env.KB_KNOWLEDGE_DATA_DIR));
    assert(!('AGENT_TERMINAL_DATA_DIR' in overrideSpec.env), 'the override branch must not widen the terminal-private data dir');
    deepEqual(Object.keys(overrideSpec.env).sort(), ['KB_EVENT_BRIDGE_URL', 'KB_KNOWLEDGE_DATA_DIR', 'KB_KNOWLEDGE_ENGINE_URL', 'KB_WORKBENCH_RUNTIME_TOKEN'], 'the override branch env stays the minimal non-secret contract plus the product root');

    delete process.env.KB_TERMINAL_COMMAND;
    const defaultSpec = bridgeFor()._supervisedSpecs().find(spec => spec.name === 'terminal');
    assert(defaultSpec, 'the vendored terminal entry must resolve in this checkout');
    assert(defaultSpec.env.KB_KNOWLEDGE_DATA_DIR === dataDir, 'the vendored branch must pass the product knowledge root');
    assert(defaultSpec.env.AGENT_TERMINAL_DATA_DIR === path.join(dataDir, 'workbench'), 'AGENT_TERMINAL_DATA_DIR stays the dedicated workbench subtree');
  } finally {
    if (savedCommand === undefined) delete process.env.KB_TERMINAL_COMMAND; else process.env.KB_TERMINAL_COMMAND = savedCommand;
  }
}

async function main() {
  const tests = [
    ['probe-crash', testProbeCrashNeverEchoes],
    ['launcher-code-allowlist', testLauncherCodeAllowlist],
    ['version-echo', testVersionMismatchNeverEchoesServerVersion],
    ['binding-realpath', testInstallTimeBinRealpathBoundary],
    ['launcher-static', testLauncherStaticHardening],
    ['terminal-env', testTerminalSpecCarriesKnowledgeDataDir],
  ];
  const only = process.env.A3_ONLY;
  for (const [name, test] of tests) {
    if (only && name !== only) continue;
    await test();
  }
  console.log('INTEGRATION_RUNTIME_BINDING_A3_TEST_PASSED');
}

main().catch(error => {
  console.error('INTEGRATION_RUNTIME_BINDING_A3_TEST_FAILED', error.message);
  process.exit(1);
});
