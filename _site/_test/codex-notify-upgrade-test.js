// Run: node _site/_test/codex-notify-upgrade-test.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { IntegrationManager } = require('../lib/integration-installer');
const { planNotify, writeNotify } = require('../lib/codex-notify-config');

const ROOT = path.resolve(__dirname, '..', '..');
const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), `pk-codex-notify-upgrade-${process.pid}-`));
const CURRENT_FANOUT = path.join(ROOT, '_site', 'scripts', 'codex-notify-fanout.cjs');

function encode(command) {
  return Buffer.from(JSON.stringify(command)).toString('base64');
}

function writeFixtureFile(file, content = '// isolated notifier fixture\n') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
  return file;
}

function desktopCommand(name, previous, exists) {
  const executable = path.join(TEMP, name, 'OpenAI', 'Codex', 'runtimes', 'cua_node', '0123456789abcdef', 'bin', 'node_modules', '@oai', 'sky', 'bin', 'windows', 'codex-computer-use.exe');
  if (exists) writeFixtureFile(executable, '');
  return [executable, 'turn-ended', '--previous-notify', JSON.stringify(previous)];
}

function oldFanout(name, previous, bridge, scoped = false) {
  const packagePath = scoped ? ['@sanqianx', 'project-knowledge'] : ['project-knowledge'];
  const file = path.join(TEMP, name, 'npm', 'node_modules', ...packagePath, '_site', 'scripts', 'codex-notify-fanout.cjs');
  return ['node', file, ...(previous ? ['--next-base64', encode(previous)] : []), '--bridge-base64', encode(bridge)];
}

function fixture(name, notify) {
  const directory = path.join(TEMP, name);
  const configFile = path.join(directory, 'home', '.codex', 'config.toml');
  const bridgeHomeDir = path.join(directory, 'bridge-home');
  const before = `# unrelated settings must survive\r\nmodel = "test-model"\r\nnotify = ${JSON.stringify(notify)}\r\n[features]\r\nreview = true\r\n`;
  writeFixtureFile(configFile, before);
  return {
    before,
    configFile,
    bridgeHomeDir,
    manager: new IntegrationManager({
      rootDir: ROOT,
      homeDir: path.join(directory, 'home'),
      env: {},
      bridgeHomeDir,
      codexConfigFile: configFile,
      commandResolver: name => name,
      runner: () => ({ status: 0, stdout: '', stderr: '' }),
    }),
  };
}

function readNotify(configFile) {
  const source = fs.readFileSync(configFile, 'utf8');
  const line = source.split(/\r?\n/).find(value => /^notify\s*=/.test(value));
  return line ? JSON.parse(line.replace(/^notify\s*=\s*/, '')) : null;
}

function descendants(command) {
  if (!command) return [];
  const result = [command];
  for (let index = 0; index < command.length - 1; index += 1) {
    const marker = command[index];
    if (!['--previous-notify', '--next-base64', '--bridge-base64'].includes(marker)) continue;
    const text = marker === '--previous-notify' ? command[index + 1] : Buffer.from(command[index + 1], 'base64').toString('utf8');
    try {
      const child = JSON.parse(text);
      if (Array.isArray(child)) result.push(...descendants(child));
    } catch {
      // Fixtures also exercise uninterpreted third-party arguments.
    }
  }
  return result;
}

function assertUnrelatedSettings(item) {
  const source = fs.readFileSync(item.configFile, 'utf8');
  assert(source.startsWith('# unrelated settings must survive\r\nmodel = "test-model"\r\n'), 'retain comments, settings, and CRLF');
  assert(source.endsWith('[features]\r\nreview = true\r\n'), 'retain unrelated TOML sections');
}

function assertCurrentCapture(item) {
  const commands = descendants(readNotify(item.configFile));
  assert.strictEqual(commands.filter(command => command[1] === CURRENT_FANOUT).length, 1, 'exactly one current managed fan-out remains');
  assert.strictEqual(commands.filter(command => command.join('\n') === ['node', path.join(item.bridgeHomeDir, 'bin', 'bridge-hook.cjs')].join('\n')).length, 1, 'capture targets the current bridge home exactly once');
  assertUnrelatedSettings(item);
  return commands;
}

async function assertInstallIdempotent(item) {
  const installed = await item.manager.installCaptureCodex();
  assert(installed.installed && !installed.conflict, JSON.stringify(installed));
  assertCurrentCapture(item);
  const first = fs.readFileSync(item.configFile, 'utf8');
  const repeated = await item.manager.installCaptureCodex();
  assert(repeated.installed && !repeated.conflict, 'repeat install must succeed');
  assert.strictEqual(fs.readFileSync(item.configFile, 'utf8'), first, 'repeat install must not add wrappers or rewrite a healthy chain');
  const status = await item.manager.statusCaptureCodex();
  assert(status.installed && !status.conflict, 'status must recognize repaired capture through desktop wrappers');
}

async function main() {
  // Mirrors the upgrade failure: a live Codex outer wrapper embeds a missing
  // unscoped package wrapper, which embeds a removed Codex runtime wrapper.
  const radarFile = writeFixtureFile(path.join(TEMP, 'tools', 'devtask-radar', 'connectors', 'codex', 'notify-hook.js'));
  const radar = ['node', radarFile, '--config', path.join(TEMP, 'radar settings.json')];
  const staleBridge = ['node', path.join(TEMP, 'old-data', 'events', 'bin', 'bridge-hook.cjs')];
  const missingDesktop = desktopCommand('removed-codex-runtime', radar, false);
  const stalePackage = oldFanout('removed-unscoped-package', missingDesktop, staleBridge);
  const liveDesktop = desktopCommand('current-codex-runtime', stalePackage, true);
  const upgrade = fixture('upgrade', liveDesktop);
  await assertInstallIdempotent(upgrade);
  const upgraded = readNotify(upgrade.configFile);
  assert.deepStrictEqual(upgraded.slice(0, 3), liveDesktop.slice(0, 3), 'preserve the live desktop notifier as the outer command');
  const upgradedCommands = descendants(upgraded);
  assert(upgradedCommands.some(command => JSON.stringify(command) === JSON.stringify(radar)), 'retain the valid Radar command and every non-notify argument');
  assert(!upgradedCommands.some(command => command.includes(missingDesktop[0])), 'unwrap only the removed, known Codex runtime wrapper');
  assert(!upgradedCommands.some(command => command.includes(stalePackage[1])), 'remove the stale unscoped managed package path');
  assert(!upgradedCommands.some(command => command.includes(staleBridge[1])), 'remove the stale managed bridge home');

  await upgrade.manager.uninstallCaptureCodex();
  assert.deepStrictEqual(readNotify(upgrade.configFile), desktopCommand('current-codex-runtime', radar, true), 'uninstall restores the valid third-party desktop-to-Radar chain');
  assertUnrelatedSettings(upgrade);
  const removedSource = fs.readFileSync(upgrade.configFile, 'utf8');
  await upgrade.manager.uninstallCaptureCodex();
  assert.strictEqual(fs.readFileSync(upgrade.configFile, 'utf8'), removedSource, 'uninstall is idempotent and retains third-party notification');

  // Ownership is determined by the installed package path, not by Radar being
  // present: a prior managed fan-out may preserve an arbitrary third-party tool.
  const arbitraryFile = writeFixtureFile(path.join(TEMP, 'tools', 'notify-user.cjs'));
  const arbitrary = ['node', arbitraryFile, '--label', 'existing third party'];
  const scoped = fixture('scoped-package-upgrade', oldFanout('removed-scoped-package', arbitrary, staleBridge, true));
  await assertInstallIdempotent(scoped);
  assert(descendants(readNotify(scoped.configFile)).some(command => JSON.stringify(command) === JSON.stringify(arbitrary)), 'upgrade preserves arbitrary already-chained third-party commands');
  await scoped.manager.uninstallCaptureCodex();
  assert.deepStrictEqual(readNotify(scoped.configFile), arbitrary, 'uninstall unwraps only owned capture, preserving the unrelated command');

  const liveNestedDesktop = desktopCommand('still-present-previous-codex-runtime', radar, true);
  const preserveLive = fixture('preserve-live-nested-runtime', oldFanout('old-nested-package', liveNestedDesktop, staleBridge));
  await assertInstallIdempotent(preserveLive);
  assert(descendants(readNotify(preserveLive.configFile)).some(command => JSON.stringify(command) === JSON.stringify(liveNestedDesktop)), 'a known but still-present Codex runtime must not be collapsed');
  await preserveLive.manager.uninstallCaptureCodex();
  assert.deepStrictEqual(readNotify(preserveLive.configFile), liveNestedDesktop, 'uninstall retains the complete live Codex runtime wrapper');

  const missingUnowned = ['python', path.join(TEMP, 'missing-but-user-owned.py'), '--keep-this'];
  const preserveMissing = fixture('preserve-missing-user-command', oldFanout('old-package-user-command', missingUnowned, staleBridge));
  await assertInstallIdempotent(preserveMissing);
  assert(descendants(readNotify(preserveMissing.configFile)).some(command => JSON.stringify(command) === JSON.stringify(missingUnowned)), 'only missing known Codex wrappers may be folded; missing user-owned commands remain untouched');
  await preserveMissing.manager.uninstallCaptureCodex();
  assert.deepStrictEqual(readNotify(preserveMissing.configFile), missingUnowned, 'uninstall restores even a missing user-owned notifier');

  const bridgeMoved = fixture('bridge-home-upgrade', ['node', CURRENT_FANOUT, '--next-base64', encode(radar), '--bridge-base64', encode(staleBridge)]);
  await assertInstallIdempotent(bridgeMoved);
  assert(!descendants(readNotify(bridgeMoved.configFile)).some(command => command.includes(staleBridge[1])), 'a moved bridge home is repaired even when the package path is unchanged');

  const fanoutOnly = fixture('managed-only', oldFanout('removed-managed-only', null, staleBridge));
  await assertInstallIdempotent(fanoutOnly);
  await fanoutOnly.manager.uninstallCaptureCodex();
  assert.strictEqual(readNotify(fanoutOnly.configFile), null, 'uninstall removes the notify entry only if no third-party notifier remains');
  assertUnrelatedSettings(fanoutOnly);

  const defaultLegacy = name => ['node', path.join(TEMP, name, 'home', '.ai-coding-event-bridge', 'bin', 'bridge-hook.cjs')];
  const rawLegacy = fixture('legacy-default-home', defaultLegacy('legacy-default-home'));
  await assertInstallIdempotent(rawLegacy);
  assert(!descendants(readNotify(rawLegacy.configFile)).some(command => command[1] === defaultLegacy('legacy-default-home')[1]), 'replace the known old standalone Bridge instead of chaining it as a third party');
  await rawLegacy.manager.uninstallCaptureCodex();
  assert.strictEqual(readNotify(rawLegacy.configFile), null, 'uninstall must not resurrect a retired Bridge home');

  const nestedLegacyCommand = defaultLegacy('nested-legacy-default-home');
  const legacyRadar = [...radar, '--previous-notify', JSON.stringify(nestedLegacyCommand)];
  const nestedLegacy = fixture('nested-legacy-default-home', oldFanout('old-with-legacy-next', legacyRadar, staleBridge));
  await assertInstallIdempotent(nestedLegacy);
  assert(!descendants(readNotify(nestedLegacy.configFile)).some(command => command[1] === nestedLegacyCommand[1]), 'remove known stale Bridge capture hidden in a compatible notification branch');
  assert(descendants(readNotify(nestedLegacy.configFile)).some(command => JSON.stringify(command) === JSON.stringify(radar)), 'preserve Radar and its non-notify arguments');
  await nestedLegacy.manager.uninstallCaptureCodex();
  assert.deepStrictEqual(readNotify(nestedLegacy.configFile), radar);

  // Missing files alone never authorize deleting a third-party notifier.
  // Neither a matching script basename nor the word devtask-radar is ownership.
  for (const [name, command] of [
    ['unknown-third-party', ['python', path.join(TEMP, 'missing-user-notifier.py')]],
    ['unowned-lookalike', ['node', path.join(TEMP, 'my-custom-tools', 'codex-notify-fanout.cjs')]],
    ['unowned-radar-string', ['node', arbitraryFile, '--label', 'devtask-radar']],
    ['unowned-desktop-lookalike', [path.join(TEMP, 'custom-tool', 'codex-computer-use.exe'), 'turn-ended', '--previous-notify', JSON.stringify(radar)]],
  ]) {
    const item = fixture(name, command);
    const installed = await item.manager.installCaptureCodex();
    assert(installed.conflict && !installed.installed, `${name}: unrecognized third-party notify must remain a conflict`);
    assert.strictEqual(fs.readFileSync(item.configFile, 'utf8'), item.before, `${name}: conflict must leave the config byte-for-byte unchanged`);
    await item.manager.uninstallCaptureCodex();
    assert.strictEqual(fs.readFileSync(item.configFile, 'utf8'), item.before, `${name}: uninstall cannot remove unknown third-party settings`);
  }

  const rootSetting = fixture('root-setting', radar);
  const tablesOnly = '# retain the original tables\n[features]\nreview = true\n[tui]\nnotifications = false\n';
  fs.writeFileSync(rootSetting.configFile, tablesOnly);
  await rootSetting.manager.installCaptureCodex();
  const rootSource = fs.readFileSync(rootSetting.configFile, 'utf8');
  assert(rootSource.startsWith('notify = '), 'new notify must be a root setting, not inside the final TOML table');
  assert(rootSource.endsWith(tablesOnly), 'existing tables and comments stay byte-for-byte intact');
  await rootSetting.manager.uninstallCaptureCodex();
  assert(fs.readFileSync(rootSetting.configFile, 'utf8').endsWith(tablesOnly));

  for (const [name, source] of [
    ['malformed', 'notify = ["node",\n'],
    ['duplicate', `notify = ${JSON.stringify(radar)}\nnotify = ${JSON.stringify(radar)}\n`],
    ['malformed-owned', `notify = ${JSON.stringify(['node', CURRENT_FANOUT, '--bridge-base64', 'not-a-command'])}\n`],
  ]) {
    const item = fixture(name, radar);
    fs.writeFileSync(item.configFile, source);
    const plan = planNotify(item.configFile, item.manager);
    assert(plan.conflict, `${name}: fail closed on ambiguous notify settings`);
    const result = await item.manager.installCaptureCodex();
    assert(result.conflict && !result.installed);
    assert.strictEqual(fs.readFileSync(item.configFile, 'utf8'), source);
  }
  let deep = radar;
  for (let index = 0; index < 18; index++) deep = desktopCommand(`deep-${index}`, deep, true);
  const tooDeep = fixture('deep-notify', deep);
  assert(planNotify(tooDeep.configFile, tooDeep.manager).conflict, 'bound recursion on repeated wrappers');

  const compareAndSwap = fixture('concurrent-change', radar);
  const plan = planNotify(compareAndSwap.configFile, compareAndSwap.manager);
  const otherWrite = `${compareAndSwap.before}# written by another application\r\n`;
  fs.writeFileSync(compareAndSwap.configFile, otherWrite);
  assert.throws(() => writeNotify(compareAndSwap.configFile, plan), error => error.code === 'CONFIG_CHANGED');
  assert.strictEqual(fs.readFileSync(compareAndSwap.configFile, 'utf8'), otherWrite, 'do not overwrite a config that changed after preflight');

  const backup = fixture('notify-only-backup', radar);
  const withSecret = `local_test_key = "must-not-be-backed-up"\r\n${backup.before}`;
  fs.writeFileSync(backup.configFile, withSecret);
  const backedUp = await backup.manager.installCaptureCodex();
  assert(backedUp.backupFile && fs.existsSync(backedUp.backupFile), 'a changed setting gets a recoverable backup');
  const saved = fs.readFileSync(backedUp.backupFile, 'utf8');
  assert(!saved.includes('must-not-be-backed-up'), 'backup must not duplicate unrelated credentials');
  assert.deepStrictEqual(JSON.parse(JSON.parse(saved).notify.replace(/^notify\s*=\s*/, '')), radar);

  console.log('codex-notify-upgrade-test PASS');
}

module.exports = main().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}).finally(() => {
  assert(path.resolve(TEMP).startsWith(`${path.resolve(os.tmpdir())}${path.sep}`), 'cleanup stays inside the allocated temp directory');
  fs.rmSync(TEMP, { recursive: true, force: true });
});
