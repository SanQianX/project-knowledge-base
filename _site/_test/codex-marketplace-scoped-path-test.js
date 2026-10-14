'use strict';
// Red-first regression (Q7): Codex CLI 0.137 rejects
// `plugin marketplace add <SOURCE>` with
// "Error: --ref is only supported for git marketplace sources"
// whenever the SOURCE string contains '@', which every scoped npm root
// (node_modules/@sanqianx/project-knowledge) does. Running the same add from
// the package directory's own cwd with SOURCE '.' avoids the '@' entirely.
// ensureCodexMarketplace() must use that form for the target add and for the
// rollback re-add of a previous scoped root, while non-'@' absolute paths keep
// the original invocation and third-party same-name sources stay untouched.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { IntegrationManager } = require('../lib/integration-installer');

const TEMP_BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-marketplace-scoped-path-'));
const TEST_HOME = path.join(TEMP_BASE, 'home');
const MARKETPLACE = 'project-knowledge';
const REF_ERROR = 'Error: --ref is only supported for git marketplace sources';
const NEW_ROOT = path.join(TEMP_BASE, 'new-root', '@sanqianx', 'project-knowledge');
const OLD_ROOT = path.join(TEMP_BASE, 'old-root', '@sanqianx-previous', 'project-knowledge');
const PLAIN_ROOT = path.join(TEMP_BASE, 'plain-root', 'project-knowledge');
const THIRD_PARTY_ROOT = path.join(TEMP_BASE, 'third-party', 'marketplace');

function writePackage(directory, name, version) {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name, version }, null, 2));
}

// Native-style in-memory codex CLI mirroring 0.137 marketplace semantics:
// a marketplace add SOURCE containing '@' is parsed as <repo>@<ref> and
// rejected; SOURCE '.' resolves against runnerOptions.cwd.
function createCodexCli() {
  const state = { marketplaces: new Map(), calls: [], addCalls: [], removeCalls: [], failAddDirs: new Set() };
  const runner = (command, args, runnerOptions = {}) => {
    state.calls.push({ command, args: [...args], cwd: runnerOptions.cwd || null });
    if (args[0] !== 'plugin' || args[1] !== 'marketplace') {
      return { status: 1, stdout: '', stderr: `fake codex CLI: unsupported command: ${args.join(' ')}` };
    }
    if (args[2] === 'list') {
      const lines = [...state.marketplaces].map(([name, source]) => `${name} ${source}`);
      return { status: 0, stdout: lines.length ? `${lines.join('\n')}\n` : '', stderr: '' };
    }
    if (args[2] === 'remove') {
      state.marketplaces.delete(args[3]);
      state.removeCalls.push(args[3]);
      return { status: 0, stdout: '', stderr: '' };
    }
    if (args[2] === 'add') {
      const source = String(args[3]);
      const resolved = path.resolve(String(runnerOptions.cwd || process.cwd()), source);
      state.addCalls.push({ source, cwd: runnerOptions.cwd || null, resolved });
      if (source.includes('@')) return { status: 1, stdout: '', stderr: REF_ERROR };
      if (state.failAddDirs.has(resolved)) return { status: 1, stdout: '', stderr: 'forced marketplace add failure (test)' };
      let stat = null;
      try { stat = fs.statSync(resolved); } catch { /* missing source handled below */ }
      if (!stat || !stat.isDirectory()) return { status: 1, stdout: '', stderr: `Error: marketplace source not found: ${source}` };
      state.marketplaces.set(MARKETPLACE, resolved);
      return { status: 0, stdout: '', stderr: '' };
    }
    return { status: 1, stdout: '', stderr: `fake codex CLI: unsupported marketplace command: ${args.join(' ')}` };
  };
  return { runner, state };
}

function createManager(cli, rootDir) {
  return new IntegrationManager({
    rootDir,
    homeDir: TEST_HOME,
    bridgeHomeDir: path.join(TEMP_BASE, 'bridge'),
    env: {},
    commandResolver: name => `fake-${name}`,
    runner: cli.runner,
  });
}

function registeredSource(cli) {
  const line = [...cli.state.marketplaces].map(([name, source]) => `${name} ${source}`)
    .find(item => item.startsWith(`${MARKETPLACE} `));
  return line ? line.slice(MARKETPLACE.length).trim() : null;
}

function lastAdd(cli) {
  assert.ok(cli.state.addCalls.length, 'expected at least one marketplace add call');
  return cli.state.addCalls[cli.state.addCalls.length - 1];
}

function assertDotAdd(add, expectedRoot, label) {
  assert.equal(add.source, '.', `${label}: scoped root must be added via the "." source, not an "@"-containing path`);
  assert.equal(path.resolve(add.cwd || ''), expectedRoot, `${label}: "." must resolve against the package directory's own cwd`);
}

function main() {
  writePackage(NEW_ROOT, '@sanqianx/project-knowledge', '5.0.16');
  writePackage(OLD_ROOT, '@sanqianx/project-knowledge', '5.0.15');
  writePackage(PLAIN_ROOT, '@sanqianx/project-knowledge', '5.0.16');
  writePackage(THIRD_PARTY_ROOT, 'third-party-market', '1.0.0');

  const results = [];
  const scenario = (name, fn) => {
    try { fn(); results.push({ name, ok: true }); }
    catch (error) { results.push({ name, ok: false, error: String((error && error.message) || error) }); }
  };

  scenario('fresh: scoped npm root installs via "." from its own cwd', () => {
    const cli = createCodexCli();
    createManager(cli, NEW_ROOT).ensureCodexMarketplace();
    assert.equal(registeredSource(cli), NEW_ROOT, 'fresh install must register the scoped npm root');
    assertDotAdd(lastAdd(cli), NEW_ROOT, 'fresh install');
    assert.equal(cli.state.removeCalls.length, 0, 'fresh install must not remove anything');
  });

  scenario('switch: replacing a previous scoped root registers the new root', () => {
    const cli = createCodexCli();
    cli.state.marketplaces.set(MARKETPLACE, OLD_ROOT);
    createManager(cli, NEW_ROOT).ensureCodexMarketplace();
    assert.ok(cli.state.removeCalls.includes(MARKETPLACE), 'switch must remove the previous marketplace first');
    assert.equal(registeredSource(cli), NEW_ROOT, 'switch must end registered on the new scoped root');
    assertDotAdd(lastAdd(cli), NEW_ROOT, 'switch');
    assert.ok(cli.state.addCalls.every(add => !add.source.includes('@')), 'no add may pass an "@"-containing source');
  });

  scenario('rollback: failed switch restores the old scoped root', () => {
    const cli = createCodexCli();
    cli.state.marketplaces.set(MARKETPLACE, OLD_ROOT);
    cli.state.failAddDirs.add(NEW_ROOT);
    assert.throws(() => createManager(cli, NEW_ROOT).ensureCodexMarketplace(), /已恢复原市场来源/);
    assert.equal(registeredSource(cli), OLD_ROOT, 'rollback must restore the previous scoped root');
    assertDotAdd(lastAdd(cli), OLD_ROOT, 'rollback');
    assert.ok(cli.state.addCalls.every(add => !add.source.includes('@')), 'rollback add must also avoid "@" in the source');
  });

  scenario('plain path: non-"@" absolute source keeps the original invocation', () => {
    const cli = createCodexCli();
    createManager(cli, PLAIN_ROOT).ensureCodexMarketplace();
    assert.equal(registeredSource(cli), PLAIN_ROOT);
    const add = lastAdd(cli);
    assert.equal(add.source, PLAIN_ROOT, 'non-scoped absolute path must keep being passed as the add source');
    assert.notEqual(add.source, '.', 'the "." form is reserved for "@"-containing paths');
  });

  scenario('third-party: same-name marketplace is never overwritten', () => {
    const cli = createCodexCli();
    cli.state.marketplaces.set(MARKETPLACE, THIRD_PARTY_ROOT);
    assert.throws(() => createManager(cli, NEW_ROOT).ensureCodexMarketplace(), /未覆盖第三方来源/);
    assert.equal(cli.state.addCalls.length, 0, 'third-party source must not be replaced');
    assert.equal(cli.state.removeCalls.length, 0, 'third-party source must not be removed');
    assert.equal(registeredSource(cli), THIRD_PARTY_ROOT, 'third-party registration must be untouched');
  });

  scenario('allowed failure keeps operation linkage and a safe diagnostic code', () => {
    const cli = createCodexCli();
    const logs = [];
    const manager = createManager(cli, NEW_ROOT);
    manager.operationId = 'op-native-source-test';
    manager.logger = Object.fromEntries(['info', 'warn', 'error'].map(level => [level, (event, message, meta) => logs.push({ event, message, meta })]));
    manager.execute('codex', ['plugin', 'marketplace', 'add', NEW_ROOT], { allowFailure: true });
    const failure = logs.find(log => log.event === 'integration.command_failed');
    assert.ok(failure, 'a tolerated CLI failure must not be logged as success');
    assert.equal(failure.meta.operationId, 'op-native-source-test');
    assert.equal(failure.meta.error.code, 'CODEX_LOCAL_SOURCE_REF');
    assert.equal(failure.meta.context.status, 1);
    assert.ok(!JSON.stringify(logs).includes(REF_ERROR), 'never save raw CLI output');
  });

  assert.equal(path.dirname(TEMP_BASE), path.resolve(os.tmpdir()));
  assert.equal(fs.lstatSync(TEMP_BASE).isSymbolicLink(), false);
  fs.rmSync(TEMP_BASE, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });

  const failed = results.filter(item => !item.ok);
  for (const item of results) console.log(`${item.ok ? 'PASS' : 'FAIL'} ${item.name}${item.ok ? '' : ` :: ${item.error}`}`);
  if (failed.length) {
    console.error(`codex-marketplace-scoped-path-test: ${failed.length} of ${results.length} case(s) failed.`);
    process.exitCode = 1;
    return;
  }
  console.log('codex-marketplace-scoped-path-test passed.');
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
