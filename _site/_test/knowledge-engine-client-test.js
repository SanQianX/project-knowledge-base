'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { StorageLayout } = require('../lib/storage-layout');
const { SettingsStore } = require('../lib/settings-store');
const { ProjectRegistryStore } = require('../lib/project-registry-store');
const { ProjectStore } = require('../lib/project-store');
const { KnowledgeToolRuntime } = require('../lib/knowledge-tool-runtime');
const endpoint = require('../lib/runtime-endpoint');
const control = require('../lib/runtime-control');
const { EngineKnowledgeClient } = require('../lib/engine-knowledge-client');

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-engine-client-'));
  const layout = new StorageLayout({ dataDir: path.join(root, 'data') });
  const settings = new SettingsStore({ layout }), registry = new ProjectRegistryStore({ layout }), projects = new ProjectStore({ layout });
  const projectId = 'project-test', repoPath = path.join(root, 'repo'), knowledgePath = path.join(root, 'knowledge');
  fs.mkdirSync(repoPath); fs.mkdirSync(knowledgePath);
  fs.writeFileSync(path.join(knowledgePath, 'README.md'), '# Legacy\n\nlegacy-local-only\n');
  await settings.initialize(); await registry.initialize();
  await projects.create(projectId, { repoPath, knowledgePath }, { modules: { engine: { status: 'registered', projectId } } });
  await projects.updateState(projectId, state => { state.modules = { engine: { status: 'registered', projectId } }; });
  await registry.add(projectId, { displayNameSnapshot: 'Test' });
  let invalidIdentity = false, malformed = false, businessError = false, oversized = false, wrongBinding = false, scopeChanged = false;
  const calls = [];
  const reference = { scope_project_id: projectId, entry_id: 'changes/aaaaaaaaaaaa.md', commitSha: 'a'.repeat(40), chunk_text: 'Engine authoritative knowledge' };
  const payload = { ok: true, projectId, backend: 'hybrid+markdown-truth', results: [reference], answer: reference.chunk_text, citations: [{ ...reference, entryId: reference.entry_id }], chunks: [{ chunk_text: reference.chunk_text }] };
  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/runtime/identity') return res.end(JSON.stringify(control.identity(invalidIdentity ? root : layout.getDataDir(), { port: server.address().port, host: '127.0.0.1', startedAt: 'test-start' })));
    if (req.url === '/api/health') return res.end(JSON.stringify({ name: 'knowledge-engine', dataSchemaVersion: 3 }));
    if (req.url === '/api/projects') return res.end(JSON.stringify({ projects: [{ projectId, repoPath, knowledgePath: wrongBinding ? root : knowledgePath }] }));
    let text = ''; for await (const bytes of req) text += bytes;
    calls.push({ route: req.url, input: JSON.parse(text || '{}') });
    if (oversized) return res.end(JSON.stringify({ ok: true, text: 'x'.repeat(2 * 1024 * 1024) }));
    if (scopeChanged) { res.statusCode = 409; return res.end(JSON.stringify({ ok: false, error: { code: 'PROJECT_SCOPE_CHANGED' } })); }
    if (businessError) { res.statusCode = 403; return res.end(JSON.stringify({ ok: false, error: { code: 'PATH_OUTSIDE_ROOT', message: 'private-test-secret' } })); }
    res.end(malformed ? '[]' : JSON.stringify(payload));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  endpoint.writeEndpoint(layout.getDataDir(), { pid: process.pid, port: server.address().port, host: '127.0.0.1', startedAt: 'test-start' });
  const runtime = new KnowledgeToolRuntime({ layout, settingsStore: settings, registryStore: registry, projectStore: projects });
  try {
    for (const action of ['search', 'ask', 'get', 'history']) {
      assert.deepEqual(await runtime[action]({ project: projectId, query: 'knowledge', entry: reference.entry_id, scope: 'brain', apiKey: 'must-not-forward', password: 'must-not-forward' }), payload);
      const call = calls.at(-1);
      assert.equal(call.route, `/api/engine/${action}`);
      assert.equal(call.input.projectId, projectId); assert.equal(call.input.scope, 'brain');
      assert.ok(!JSON.stringify(call.input).includes('must-not-forward'));
    }
    const subprocess = (file, args) => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [file, ...args], { env: { ...process.env, KB_DATA_DIR: layout.getDataDir() }, windowsHide: true });
      let out = '', err = ''; child.stdout.on('data', b => { out += b; }); child.stderr.on('data', b => { err += b; });
      child.once('error', reject); child.once('close', code => resolve({ code, out, err }));
    });
    const cli = await subprocess(path.resolve(__dirname, '../../bin/project-knowledge-kb.js'), ['search', '--project', projectId, '--query', 'knowledge', '--scope', 'brain', '--json']);
    assert.equal(cli.code, 0, cli.err); assert.deepEqual(JSON.parse(cli.out), payload);
    assert.equal(calls.at(-1).input.scope, 'brain');
    await runtime.get({ projectId, entry: reference.entry_id, space: 'brain:test' });
    assert.equal(calls.at(-1).input.spaceId, 'brain:test', 'legacy space alias is forwarded');
    const { createRequire } = require('node:module');
    const sdk = createRequire(path.resolve(__dirname, '../../package.json'));
    const { Client } = sdk('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = sdk('@modelcontextprotocol/sdk/client/stdio.js');
    const transport = new StdioClientTransport({ command: process.execPath, args: [path.resolve(__dirname, '../../bin/project-knowledge-mcp.js')], env: { ...process.env, KB_DATA_DIR: layout.getDataDir() }, stderr: 'pipe' });
    const client = new Client({ name: 'engine-regression', version: '1.0.0' });
    try {
      await client.connect(transport);
      const tools = await client.listTools();
      assert.deepEqual(tools.tools.find(t => t.name === 'project_knowledge_search').inputSchema.properties.scope.enum, ['project', 'domain', 'brain']);
      for (const action of ['search', 'ask', 'get', 'history']) {
        const result = await client.callTool({ name: `project_knowledge_${action}`, arguments: { projectId, scope: 'brain', ...(action === 'get' ? { entry: reference.entry_id, space: 'brain:test' } : action === 'history' ? {} : { query: 'knowledge' }) } });
        assert.ok(!result.isError); assert.deepEqual(JSON.parse(result.content[0].text), payload);
        assert.equal(calls.at(-1).input.scope, 'brain');
      }
    } finally { await client.close(); }
    invalidIdentity = true;
    await assert.rejects(runtime.search({ projectId, query: 'knowledge' }), e => e.code === 'ENGINE_IDENTITY_MISMATCH');
    invalidIdentity = false; malformed = true;
    await assert.rejects(runtime.search({ projectId, query: 'knowledge' }), e => e.code === 'ENGINE_INVALID_RESPONSE');
    malformed = false; businessError = true;
    await assert.rejects(runtime.get({ projectId, entry: '../outside.md' }), e => e.code === 'PATH_OUTSIDE_ROOT' && !e.message.includes('private-test-secret'));
    businessError = false; oversized = true;
    await assert.rejects(runtime.search({ projectId, query: 'knowledge' }), e => e.code === 'ENGINE_INVALID_RESPONSE');
    oversized = false;
    scopeChanged = true;
    await assert.rejects(runtime.search({ projectId, query: 'knowledge' }), e => e.code === 'PROJECT_SCOPE_CHANGED' && e.status === 409);
    scopeChanged = false;
    const direct = new EngineKnowledgeClient({ layout, engineUrl: `http://127.0.0.1:${server.address().port}` });
    assert.deepEqual(await direct.request('search', {}, runtime.resolveProject({ projectId })), payload);
    assert.equal(calls.at(-1).route, '/api/search');
    wrongBinding = true;
    await assert.rejects(direct.request('search', {}, runtime.resolveProject({ projectId })), e => e.code === 'ENGINE_IDENTITY_MISMATCH');
    wrongBinding = false;
    for (const engineUrl of ['http://example.com', 'http://secret@127.0.0.1', 'http://127.0.0.1/?apiKey=secret', 'file:///private']) {
      const unsafe = new EngineKnowledgeClient({ layout, engineUrl });
      await assert.rejects(unsafe.request('search', {}, runtime.resolveProject({ projectId })), e => e.code === 'ENGINE_URL_INVALID' && !e.message.includes('secret'));
    }
    await assert.rejects(direct.request('../runtime-config', {}, {}), e => e.code === 'INVALID_ARGUMENT');
    await assert.rejects(runtime.search({ projectId, scope: 'another-brain' }), e => e.code === 'INVALID_ARGUMENT');
    const unavailable = new EngineKnowledgeClient({ layout, fetchImpl: async () => { throw new Error('private-test-secret'); } });
    await assert.rejects(unavailable.request('search', {}, runtime.resolveProject({ projectId })), e => e.code === 'ENGINE_UNAVAILABLE' && !e.message.includes('private-test-secret'));
    console.log('knowledge-engine-client-test PASS (native runtime, CLI and MCP share engine facts)');
  } finally { await runtime.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
