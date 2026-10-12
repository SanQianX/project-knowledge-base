'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { IntegrationManager } = require('../lib/integration-installer');
const { run, writeOutput } = require('../../plugins/project-knowledge/scripts/context-hook.cjs');

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'automatic-context-'));
  try {
    const endpoint = { schema: 'project-knowledge/runtime-endpoint/v1', host: '127.0.0.1', pid: process.pid, port: 23456, startedAt: 'now' };
    fs.writeFileSync(path.join(root, 'runtime-endpoint.json'), JSON.stringify(endpoint));
    const payload = { cwd: root, session_id: 'session-a', hook_event_name: 'UserPromptSubmit', prompt: 'Develop export normally' };
    const env = { KB_DATA_DIR: root }, calls = [];
    const identity = { ...endpoint, schema: 'project-knowledge/runtime-control/v1', name: 'project-knowledge', dataDir: root };
    const fetchImpl = async (url, options) => {
      calls.push({ url: String(url), options });
      if (String(url).endsWith('/identity')) return Response.json(identity);
      const input = JSON.parse(options.body);
      return Response.json({ ok: true, requestId: input.requestId, projectId: 'project-a', status: 'ready', memoryStatus: 'ready', prompt: '<knowledge_context>export revision 37</knowledge_context>', facts: [{}], memories: [{}], references: [{}] });
    };
    const output = await run(payload, { env, fetchImpl });
    assert.match(output.hookSpecificOutput.additionalContext, /revision 37/); assert.equal(calls.length, 2);
    assert.equal(JSON.parse(calls[1].options.body).query, payload.prompt);
    assert.ok(!JSON.stringify(output).includes('receipt')); assert.ok(!fs.existsSync(path.join(root, 'logs')));
    await writeOutput(output, { write: (text, callback) => { assert.ok(!text.includes('receipt')); callback(); } });
    const logDir = path.join(root, 'logs/projects/project-a'); const logText = fs.readFileSync(path.join(logDir, fs.readdirSync(logDir)[0]), 'utf8');
    assert.ok(!logText.includes(payload.prompt)); assert.ok(!logText.includes('revision 37')); assert.ok(logText.includes('agent.context.output'));
    calls.length = 0;
    assert.deepEqual(await run(payload, { env: { ...env, KB_KNOWLEDGE_CONTEXT: '0' }, fetchImpl }), {}); assert.equal(calls.length, 0);
    assert.deepEqual(await run({ ...payload, hook_event_name: 'Stop' }, { env, fetchImpl }), {});
    const mismatch = await run(payload, { env, fetchImpl: async () => Response.json({ ...identity, dataDir: path.join(root, 'other') }) });
    assert.match(mismatch.systemMessage, /CONTEXT_IDENTITY_MISMATCH/);
    const unknown = await run(payload, { env, fetchImpl: async url => String(url).endsWith('/identity') ? Response.json(identity) : Response.json({ ok: false, error: 'PROJECT_NOT_FOUND' }, { status: 404 }) });
    assert.deepEqual(unknown, {});
    const offline = await run(payload, { env, fetchImpl: async () => { throw new Error('sensitive untrusted upstream text'); } });
    assert.match(offline.systemMessage, /可继续开发/); assert.ok(!JSON.stringify(offline).includes('sensitive'));
    const slow = await run(payload, { env, timeoutMs: 30, fetchImpl: (url, options) => new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })) });
    assert.match(slow.systemMessage, /CONTEXT_TIMEOUT/);
    let version = '4.2.16'; const commandCalls = [];
    const manager = new IntegrationManager({ homeDir: root, commandResolver: name => name, runner: (command, args) => {
      commandCalls.push(args.join(' '));
      if (args.join(' ') === 'plugin list --json') return { status: 0, stdout: JSON.stringify([{ id: 'project-knowledge@project-knowledge', version, enabled: true }]) };
      if (args.join(' ') === 'plugin marketplace list --json') return { status: 0, stdout: JSON.stringify([{ name: 'project-knowledge' }]) };
      if (args.slice(0, 2).join(' ') === 'plugin update') {
        version = manager.version;
        const source = path.resolve(__dirname, '../../plugins/project-knowledge'), cache = path.join(root, '.claude/plugins/cache/project-knowledge/project-knowledge', version);
        fs.mkdirSync(cache, { recursive: true }); fs.cpSync(source, cache, { recursive: true });
      }
      return { status: 0, stdout: '' };
    } });
    assert.equal(manager.statusClaude().state, 'needs-update');
    manager.installClaude();
    assert.ok(commandCalls.includes('plugin marketplace update project-knowledge'));
    assert.ok(commandCalls.includes('plugin update project-knowledge@project-knowledge --scope user'));
    assert.equal(manager.statusClaude().state, 'installed');
    const before = commandCalls.filter(c => c.startsWith('plugin update')).length; manager.installClaude();
    assert.equal(commandCalls.filter(c => c.startsWith('plugin update')).length, before);
    console.log('Automatic context protocol, fail-open safety and stale-plugin upgrade passed.');
  } finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
