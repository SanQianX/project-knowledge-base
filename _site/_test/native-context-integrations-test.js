'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { IntegrationManager } = require('../lib/integration-installer');
const { run } = require('../../plugins/project-knowledge/scripts/context-hook.cjs');

async function main() {
  const plugin = path.resolve(__dirname, '../../plugins/project-knowledge');
  assert.equal(JSON.parse(fs.readFileSync(path.join(plugin, '.codex-plugin/plugin.json'))).hooks, './hooks/codex.json');
  const hook = JSON.parse(fs.readFileSync(path.join(plugin, 'hooks/codex.json'))).hooks.UserPromptSubmit[0].hooks[0];
  assert.equal(hook.additionalContextLimit, 0); assert.equal(hook.async, undefined); assert.match(hook.command, /--client codex$/);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-context-integration-'));
  try {
    const configFile = path.join(root, '.zcode/cli/config.json'); fs.mkdirSync(path.dirname(configFile), { recursive: true });
    const thirdParty = { type: 'process', command: 'node', args: ['third-party-hook.js'], timeoutMs: 4000 };
    const before = { model: 'user-model', env: { USER_VALUE: 'keep' }, hooks: { enabled: true, events: { UserPromptSubmit: [{ hooks: [thirdParty] }], Stop: [{ hooks: [thirdParty] }] } } };
    fs.writeFileSync(configFile, JSON.stringify(before));
    let version = '5.0.9', enabled = true, trusted = false;
    const calls = [], cache = path.join(root, 'codex-cache');
    const manager = new IntegrationManager({ homeDir: root, zcodeConfigFile: configFile, commandResolver: name => name,
      codexHookProbe: async () => ({ data: [{ cwd: root, errors: [], warnings: [], hooks: [{ eventName: 'userPromptSubmit', pluginId: 'project-knowledge@project-knowledge', command: hook.command, sourcePath: path.join(cache, 'hooks/codex.json'), enabled: true, trustStatus: trusted ? 'trusted' : 'untrusted' }] }] }),
      runner: (command, args) => {
        calls.push(args.join(' '));
        if (args.join(' ') === 'plugin marketplace list') return { status: 0, stdout: 'project-knowledge marketplace' };
        if (args.join(' ') === 'plugin list --json') return { status: 0, stdout: JSON.stringify({ installed: [{ pluginId: 'project-knowledge@project-knowledge', version, enabled, source: { path: cache } }] }) };
        if (args.slice(0, 2).join(' ') === 'plugin add') { version = manager.version; fs.mkdirSync(cache, { recursive: true }); fs.cpSync(plugin, cache, { recursive: true }); }
        return { status: 0, stdout: '' };
      }
    });
    assert.equal(manager.statusCodex().state, 'needs-update'); manager.installCodex();
    assert.ok(calls.includes('plugin marketplace upgrade project-knowledge')); assert.equal(manager.statusCodex().state, 'installed');
    let automatic = await manager.automaticCodexContextStatus(manager.statusCodex(), root);
    assert.equal(automatic.state, 'waiting-trust'); assert.equal(automatic.configured, false);
    trusted = true; automatic = await manager.automaticCodexContextStatus(manager.statusCodex(), root); assert.equal(automatic.configured, true);
    const count = calls.filter(c => c.startsWith('plugin add')).length; manager.installCodex(); assert.equal(calls.filter(c => c.startsWith('plugin add')).length, count);
    enabled = false; assert.throws(() => manager.installCodex(), /禁用/); assert.equal(manager.statusCodex().state, 'disabled'); enabled = true;
    assert.ok(calls.every(c => !/trust|bypass/.test(c)), 'installer never writes native trust or bypasses review');
    const installed = manager.installZCode(); assert.equal(installed.state, 'installed'); manager.installZCode();
    const current = JSON.parse(fs.readFileSync(configFile));
    assert.equal(current.model, before.model); assert.deepEqual(current.env, before.env); assert.deepEqual(current.hooks.events.Stop, before.hooks.events.Stop);
    assert.equal(current.hooks.events.UserPromptSubmit.length, 2); assert.deepEqual(current.hooks.events.UserPromptSubmit[0].hooks[0], thirdParty);
    assert.equal(manager.statusZCode().installed, true); assert.equal(manager.automaticContextStatus('zcode', manager.statusZCode()).configured, true);
    current.hooks.enabled = false; fs.writeFileSync(configFile, JSON.stringify(current)); assert.equal(manager.statusZCode().state, 'disabled'); assert.throws(() => manager.installZCode(), /禁用/);
    current.hooks.enabled = true; fs.writeFileSync(configFile, JSON.stringify(current)); manager.uninstallZCode();
    assert.deepEqual(JSON.parse(fs.readFileSync(configFile)), before, 'remove only the owned context entry, not capture or user config');
    const oldScript = path.join(root, 'old-prefix/node_modules/@sanqianx/project-knowledge/plugins/project-knowledge/scripts/context-hook.cjs');
    const oldOwned = { type: 'process', command: 'node', args: [oldScript, '--client', 'zcode'], timeoutMs: 12000 };
    const similarThirdParty = { type: 'process', command: 'node', args: [path.join(root, 'custom/project-knowledge/scripts/context-hook.cjs'), '--client', 'zcode'] };
    fs.writeFileSync(configFile, JSON.stringify({ ...before, hooks: { ...before.hooks, events: { ...before.hooks.events, UserPromptSubmit: [{ note: 'preserve group metadata', hooks: [thirdParty, oldOwned, similarThirdParty] }, { hooks: [oldOwned] }] } } }));
    assert.equal(manager.statusZCode().installed, false, 'an old prefix is not current readiness');
    manager.installZCode(); manager.installZCode();
    const rewired = JSON.parse(fs.readFileSync(configFile));
    const entries = rewired.hooks.events.UserPromptSubmit.flatMap(g => g.hooks);
    assert.ok(!entries.some(h => h.args?.[0] === oldScript), 'an old managed npm path must not survive a new-prefix install');
    assert.equal(entries.filter(h => h.args?.[0] === path.join(manager.rootDir, 'plugins/project-knowledge/scripts/context-hook.cjs')).length, 1, 'old duplicate managed entries collapse to one');
    assert.ok(entries.some(h => JSON.stringify(h) === JSON.stringify(similarThirdParty)), 'similar third-party scripts are not owned');
    assert.equal(rewired.hooks.events.UserPromptSubmit[0].note, 'preserve group metadata');
    assert.deepEqual(rewired.hooks.events.Stop, before.hooks.events.Stop);
    assert.equal(rewired.model, before.model); assert.deepEqual(rewired.env, before.env);
    manager.uninstallZCode();
    assert.deepEqual(JSON.parse(fs.readFileSync(configFile)).hooks.events.UserPromptSubmit[0].hooks, [thirdParty, similarThirdParty]);
    fs.writeFileSync(configFile, '{invalid'); assert.throws(() => manager.installZCode(), /JSON/); assert.equal(fs.readFileSync(configFile, 'utf8'), '{invalid');
    const endpoint = { schema: 'project-knowledge/runtime-endpoint/v1', host: '127.0.0.1', pid: process.pid, port: 12345, startedAt: 'test' }; fs.writeFileSync(path.join(root, 'runtime-endpoint.json'), JSON.stringify(endpoint));
    for (const client of ['codex', 'zcode']) {
      let input;
      const result = await run({ cwd: root, session_id: 'session-' + client, hook_event_name: 'UserPromptSubmit', prompt: '请开发导出功能' }, { argv: ['--client', client], env: { KB_DATA_DIR: root }, fetchImpl: async (url, opts) => {
        if (String(url).endsWith('/identity')) return Response.json({ ...endpoint, schema: 'project-knowledge/runtime-control/v1', name: 'project-knowledge', dataDir: root });
        input = JSON.parse(opts.body); return Response.json({ ok: true, requestId: input.requestId, projectId: 'project-test', status: 'ready', prompt: '<knowledge_context>facts and memories</knowledge_context>', references: [{}], facts: [{}], memories: [{}] });
      } });
      assert.equal(input.client, client); assert.equal(result.hookSpecificOutput.hookEventName, 'UserPromptSubmit'); assert.match(result.hookSpecificOutput.additionalContext, /facts and memories/);
    }
    console.log('Native Codex/ZCode context integration, trust honesty, compatibility and preservation passed.');
  } finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
