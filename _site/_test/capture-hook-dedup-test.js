'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { IntegrationManager } = require(process.env.PK_TEST_INTEGRATION_ROOT
  ? path.join(process.env.PK_TEST_INTEGRATION_ROOT, '_site/lib/integration-installer') : '../lib/integration-installer');
const { bridgeBinding, planCaptureHooks, repairCaptureHooks } = require('../lib/capture-hook-config');
const bridge = require('@sanqianx/ai-coding-event-bridge-console/src/bridge');
const ROOT = path.resolve(__dirname, '../..');
const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-capture-dedup-'));
const HOME = path.join(TEMP, '用户 空格');
const OLD = path.join(HOME, '.ai-coding-event-bridge');
const OLD_V5 = path.join(HOME, '.project-knowledge-v5/events');
const CURRENT = path.join(HOME, '.project-knowledge/events');
const options = { homeDir: HOME, bridgeHomeDir: CURRENT };
const shim = home => path.join(home, 'bin/bridge-hook.cjs');
const cmd = home => ({ type: 'command', command: `node "${shim(home)}"` });
const processHook = home => ({ type: 'process', command: 'node', args: [shim(home), '--source', 'zcode'], timeoutMs: 15000 });
const events = ['UserPromptSubmit', 'Stop'];
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
function write(file, object) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(object, null, 2) + '\n'); }
function manager(extra = {}) { return new IntegrationManager({ rootDir: ROOT, env: {}, ...options, ...extra }); }

async function main() {
  const claude = path.join(HOME, '.claude/settings.json');
  const third = { type: 'command', command: 'node "notify-user.cjs"', timeout: 10 };
  const context = { type: 'command', command: 'node "context-hook.cjs" --client claude' };
  const lookalike = { type: 'command', command: `node "${shim(OLD)}" && echo keep-user-wrapper` };
  const customHome = path.join(HOME, 'independent-third-party-bridge');
  const unrelated = { model: 'user-model', env: { PRIVATE_TEST_TOKEN: 'do-not-back-up-unrelated-secret' } };
  write(claude, { ...unrelated, hooks: Object.fromEntries(events.map(event => [event, [
    { matcher: '*', hooks: [cmd(OLD), third, cmd(CURRENT)] },
    { matcher: '*', hooks: [cmd(OLD), cmd(CURRENT), context, lookalike, cmd(customHome)] },
  ]])) });
  const before = fs.readFileSync(claude, 'utf8');
  const logs = [];
  const item = manager({ logger: { info: (...args) => logs.push(args), error: (...args) => logs.push(args) } });
  assert.equal((await item.statusCaptureClaude()).state, 'needs-repair', 'duplicate capture cannot be reported healthy');
  assert.equal(fs.readFileSync(claude, 'utf8'), before, 'status is read-only');
  const installed = await item.captureOperation('install', 'claude');
  assert.equal(installed.removedLegacy, 4);
  assert.equal(installed.removedDuplicates, 2);
  assert(logs.some(row => row[2]?.context?.removedLegacy === 4 && row[2]?.context?.removedDuplicates === 2), 'repair counts are persisted without raw configuration');
  assert(!JSON.stringify(logs).includes('do-not-back-up-unrelated-secret'));
  let saved = read(claude);
  assert.equal(saved.model, unrelated.model); assert.deepEqual(saved.env, unrelated.env);
  for (const event of events) {
    const hooks = saved.hooks[event].flatMap(group => group.hooks);
    assert.equal(hooks.filter(hook => hook.command === cmd(CURRENT).command).length, 1);
    assert.equal(hooks.filter(hook => hook.command === cmd(OLD).command).length, 0);
    for (const keep of [third, context, lookalike, cmd(customHome)]) assert(hooks.some(hook => JSON.stringify(hook) === JSON.stringify(keep)), 'mixed-group third-party hooks survive');
  }
  assert(!fs.readFileSync(installed.backupFile, 'utf8').includes('do-not-back-up-unrelated-secret'), 'backup contains only removed owned invocations');
  assert.equal((await item.statusCaptureClaude()).state, 'installed');
  const after = fs.readFileSync(claude, 'utf8');
  assert.equal((await item.installCaptureClaude()).changed, false);
  assert.equal(fs.readFileSync(claude, 'utf8'), after, 'repeat repair is byte-idempotent');
  await item.uninstallCaptureClaude();
  saved = read(claude);
  for (const event of events) assert(saved.hooks[event].flatMap(group => group.hooks).some(hook => hook.command === third.command), 'uninstall keeps other hooks in the same group');

  const zcode = path.join(HOME, '.zcode/cli/config.json');
  const zContext = { type: 'process', command: 'node', args: ['context-hook.cjs', '--client', 'zcode'] };
  write(zcode, { ...unrelated, hooks: { enabled: true, events: Object.fromEntries(events.map(event => [event, [{ hooks: [processHook(OLD), third, processHook(CURRENT), processHook(CURRENT), zContext] }]])) } });
  assert.equal((await item.statusCaptureZCode()).state, 'needs-repair');
  const zInstalled = await item.installCaptureZCode();
  assert.equal(zInstalled.removedLegacy, 2); assert.equal(zInstalled.removedDuplicates, 2);
  const zBeforeRepeat = fs.readFileSync(zcode, 'utf8');
  await item.installCaptureZCode();
  assert.equal(fs.readFileSync(zcode, 'utf8'), zBeforeRepeat);
  await item.uninstallCaptureZCode();
  assert.deepEqual(read(zcode).env, unrelated.env);
  assert.deepEqual(read(zcode).hooks.events.UserPromptSubmit[0].hooks, [third, zContext]);

  // Renaming the default data directory leaves absolute hooks behind. The
  // missing v5 shim must be retired even when the current hook already exists.
  for (const client of ['claude', 'zcode']) {
    const file = path.join(HOME, client, 'v5-migration.json');
    const managed = client === 'zcode' ? processHook : cmd;
    const eventMap = Object.fromEntries(events.map(event => [event, [
      { matcher: '*', hooks: [managed(OLD_V5), third, managed(CURRENT), managed(customHome), lookalike] },
    ]]));
    write(file, { ...unrelated, hooks: client === 'zcode' ? { enabled: true, events: eventMap } : eventMap });
    const migrated = manager(client === 'zcode' ? { zcodeConfigFile: file } : { claudeSettingsFile: file });
    const status = () => client === 'zcode' ? migrated.statusCaptureZCode() : migrated.statusCaptureClaude();
    const install = () => client === 'zcode' ? migrated.installCaptureZCode() : migrated.installCaptureClaude();
    const original = fs.readFileSync(file, 'utf8');
    assert(!fs.existsSync(shim(OLD_V5)), 'the retired v5 runtime is absent');
    assert.equal((await status()).state, 'needs-repair', `${client}: stale v5 hooks cannot be reported healthy`);
    assert.equal(fs.readFileSync(file, 'utf8'), original, 'migration status remains read-only');
    const repaired = await install();
    assert.equal(repaired.removedLegacy, 2);
    assert.equal(repaired.removedDuplicates, 0);
    const config = read(file), fixedEvents = client === 'zcode' ? config.hooks.events : config.hooks;
    assert.deepEqual(config.env, unrelated.env);
    for (const event of events) {
      const hooks = fixedEvents[event].flatMap(group => group.hooks);
      assert(!hooks.some(hook => JSON.stringify(hook) === JSON.stringify(managed(OLD_V5))));
      assert.equal(hooks.filter(hook => JSON.stringify(hook) === JSON.stringify(managed(CURRENT))).length, 1);
      for (const keep of [third, managed(customHome), lookalike]) assert(hooks.some(hook => JSON.stringify(hook) === JSON.stringify(keep)));
      assert.equal(fixedEvents[event][0].matcher, '*');
    }
    assert.equal((await status()).state, 'installed');
    const fixed = fs.readFileSync(file, 'utf8');
    assert.equal((await install()).changed, false);
    assert.equal(fs.readFileSync(file, 'utf8'), fixed, 'v5 migration is byte-idempotent');
  }
  assert.equal(bridgeBinding(['node', shim(OLD_V5)], options), 'legacy');
  assert.equal(bridgeBinding(['node', shim(OLD_V5)], { ...options, bridgeHomeDir: OLD_V5 }), 'current', 'an explicitly selected v5 data directory remains current');
  assert.equal(bridgeBinding(['node', shim(OLD_V5), '--custom-argument'], options), '');
  assert.equal(bridgeBinding(['node', `${shim(OLD_V5)}.user-script`], options), '');
  assert.equal(bridgeBinding(['node', shim(path.join(TEMP, 'another-user/.project-knowledge-v5/events'))], options), '', 'another account is not owned');

  write(claude, { hooks: Object.fromEntries(events.map(event => [event, [{ hooks: [cmd(OLD)] }]])) });
  const onlyLegacy = fs.readFileSync(claude, 'utf8');
  assert.throws(() => repairCaptureHooks(claude, 'claude', options), /入口未完整/);
  const failed = manager({ bridgeModule: { installers: { claudeCode: { installClaudeCodeHook: async () => { throw new Error('runtime materialization failed'); } } } } });
  await assert.rejects(failed.installCaptureClaude(), /materialization failed/);
  assert.equal(fs.readFileSync(claude, 'utf8'), onlyLegacy, 'failed runtime install cannot retire working old capture');
  const conflict = manager({ bridgeModule: { installers: { claudeCode: { installClaudeCodeHook: async () => ({ added: [], runtime: { conflict: true } }) } } } });
  await assert.rejects(conflict.installCaptureClaude(), /版本冲突/);
  assert.equal(fs.readFileSync(claude, 'utf8'), onlyLegacy, 'a runtime conflict cannot retire old capture');
  const dry = manager({ dryRun: true });
  await dry.installCaptureClaude(); await dry.uninstallCaptureClaude();
  assert.equal(fs.readFileSync(claude, 'utf8'), onlyLegacy);
  fs.writeFileSync(claude, '{invalid JSON');
  assert.throws(() => planCaptureHooks(claude, 'claude', options), /JSON/);
  assert.equal(fs.readFileSync(claude, 'utf8'), '{invalid JSON');
  assert.equal(bridgeBinding(['node', `${shim(OLD)}.user-script`], options), '');
  assert.equal(bridgeBinding(['node', shim(OLD), '--custom-argument'], options), '');
  assert.equal(bridgeBinding([['node'], shim(OLD)], options), '');
  write(claude, { hooks: { UserPromptSubmit: [null, { hooks: [cmd(OLD), cmd(CURRENT)] }], Stop: [{ hooks: [cmd(CURRENT)] }] } });
  repairCaptureHooks(claude, 'claude', options);
  assert.equal(read(claude).hooks.UserPromptSubmit[0], null, 'repair does not silently drop unrelated malformed groups');
  write(claude, { hooks: Object.fromEntries(events.map(event => [event, [{ hooks: [cmd(OLD), cmd(CURRENT)] }]])) });
  const originalRead = fs.readFileSync;
  let reads = 0;
  fs.readFileSync = function(file, ...args) {
    const value = originalRead.call(this, file, ...args);
    if (file === claude && ++reads === 2) write(claude, { ...JSON.parse(value), userConcurrentEdit: 'kept' });
    return value;
  };
  try { assert.throws(() => repairCaptureHooks(claude, 'claude', options), error => error.code === 'CONFIG_CHANGED'); }
  finally { fs.readFileSync = originalRead; }
  assert.equal(read(claude).userConcurrentEdit, 'kept', 'a concurrent user edit is never overwritten');

  // Real Git + real installed shims: the stale store is registered, but no
  // repaired client invocation recreates it or sends duplicate events.
  const repo = path.join(TEMP, '代码 中文 project');
  fs.mkdirSync(repo, { recursive: true });
  const git = spawnSync('git', ['init', '-q'], { cwd: repo, encoding: 'utf8', windowsHide: true });
  assert.equal(git.status, 0, git.stderr);
  const obsoleteStore = path.join(TEMP, 'knowledge/old-slug/dev-conversations');
  const canonicalStore = path.join(TEMP, 'knowledge/Canonical-abcdef/dev-conversations');
  await bridge.ensureRuntimeHome({ homeDir: OLD });
  await bridge.projectRegistry.addProject({ home: OLD, path: repo, store: obsoleteStore });
  await bridge.projectRegistry.addProject({ home: CURRENT, path: repo, store: canonicalStore });
  fs.rmSync(path.join(TEMP, 'knowledge/old-slug'), { recursive: true, force: true });
  write(claude, { hooks: Object.fromEntries(events.map(event => [event, [{ hooks: [cmd(OLD), cmd(CURRENT), cmd(CURRENT)] }]])) });
  await item.installCaptureClaude();
  const env = { ...process.env }; delete env.AI_CODING_EVENT_BRIDGE_HOME;
  for (const [event, payload] of [
    ['UserPromptSubmit', { prompt: 'isolated dedup test request' }],
    ['Stop', { last_assistant_message: 'isolated dedup test answer' }],
  ]) {
    const hooks = read(claude).hooks[event].flatMap(group => group.hooks);
    assert.equal(hooks.length, 1);
    const call = spawnSync(process.execPath, [shim(CURRENT)], { cwd: repo, env, input: JSON.stringify({ hook_event_name: event, cwd: repo, session_id: 'dedup-test', ...payload }), encoding: 'utf8', windowsHide: true, timeout: 10000 });
    assert.equal(call.status, 0, call.stderr);
  }
  const journal = path.join(canonicalStore, 'journal/events.jsonl');
  const captured = fs.readFileSync(journal, 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line));
  assert.deepEqual(captured.map(row => row.eventType), ['user_prompt', 'assistant_response']);
  assert(!fs.existsSync(obsoleteStore), 'the stale second directory is not recreated');
  write(zcode, { hooks: { enabled: true, events: Object.fromEntries(events.map(event => [event, [{ hooks: [processHook(OLD_V5), processHook(CURRENT), processHook(CURRENT)] }]])) } });
  await item.installCaptureZCode();
  for (const [event, payload] of [
    ['UserPromptSubmit', { prompt: 'isolated zcode dedup request' }],
    ['Stop', { last_assistant_message: 'isolated zcode dedup answer' }],
  ]) {
    const hooks = read(zcode).hooks.events[event].flatMap(group => group.hooks);
    assert.equal(hooks.length, 1);
    const call = spawnSync(process.execPath, hooks[0].args, { cwd: repo, env, input: JSON.stringify({ hook_event_name: event, cwd: repo, session_id: 'zcode-dedup-test', ...payload }), encoding: 'utf8', windowsHide: true, timeout: 10000 });
    assert.equal(call.status, 0, call.stderr);
  }
  const afterZCode = fs.readFileSync(journal, 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line));
  assert.deepEqual(afterZCode.map(row => row.source), ['claude-code', 'claude-code', 'zcode', 'zcode']);
  assert(!fs.existsSync(obsoleteStore), 'ZCode also cannot recreate the old knowledge folder');
  console.log('capture-hook-dedup-test PASS (duplicate status, exact ownership, mixed-group preservation, idempotency, runtime failure and real journal capture)');
}

main().catch(error => { console.error(error.stack); process.exitCode = 1; }).finally(() => {
  assert(path.resolve(TEMP).startsWith(path.resolve(os.tmpdir()) + path.sep));
  fs.rmSync(TEMP, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});
