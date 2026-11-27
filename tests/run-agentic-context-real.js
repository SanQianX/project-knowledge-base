'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { corpus, evaluate, listen, setup } = require('./helpers/agentic-context-fixture');

async function closeServer(server) {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}

async function startRuntime(key) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-real-context-'));
  const token = crypto.randomBytes(24).toString('hex');
  const model = process.env.PKB_CONTEXT_TEST_MODEL || 'glm-4.7';
  const profileId = 'test-context-profile';
  const workbenchRoot = process.env.PKB_CONTEXT_WORKBENCH_SOURCE || path.dirname(require.resolve('claude-ai-workbench/package.json'));
  const workbenchRequire = createRequire(path.join(workbenchRoot, 'package.json'));
  const { ProfileStore } = workbenchRequire('./packages/server/lib/profile-store');
  const { createHttpHandler } = workbenchRequire('./packages/server/lib/http-handler');
  const profiles = new ProfileStore({ dataDir: path.join(root, 'workbench') });
  profiles.save({ id: profileId, name: 'Context test', protocol: 'anthropic-compatible', provider: 'test-zai',
    baseUrl: 'https://api.z.ai/api/anthropic', models: { default: model, list: [{ id: model }] } });
  // The test key is supplied as a process secret. Use the normal saved-profile
  // resolver with an in-memory credential source to keep the key off disk.
  const { credentialRef } = profiles._profiles().profiles.find(profile => profile.id === profileId);
  profiles._credentials = () => ({ credentials: { [credentialRef]: key } });
  const handle = createHttpHandler({ profiles }, { runtimeToken: token });
  const trace = [];
  const workbench = http.createServer(async (req, res) => {
    if (req.url === '/v1/embeddings' && req.method === 'POST') {
      try {
        const parts = [];
        for await (const piece of req) parts.push(piece);
        const upstream = await fetch('https://api.z.ai/api/paas/v4/embeddings', { method: 'POST', redirect: 'error',
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: Buffer.concat(parts), signal: AbortSignal.timeout(35000) });
        res.writeHead(upstream.status, { 'Content-Type': 'application/json' });
        res.end(Buffer.from(await upstream.arrayBuffer()));
      } catch { res.writeHead(502).end(); }
      return;
    }
    let payload = '';
    for await (const piece of req) payload += piece;
    const input = JSON.parse(payload);
    const prompt = JSON.parse(input.prompt);
    const matched = corpus.cases.find(item => item.queries.includes(prompt.task.query) || item.topic === prompt.task.query);
    if (matched) {
      const earlier = prompt.exchanges.slice(0, -1);
      const current = prompt.exchanges.at(-1);
      trace.push({ case: matched.id, round: prompt.exchanges.length,
        aliasFirstSeenInToolResult: !JSON.stringify(earlier).includes(matched.alias) && !!JSON.stringify(current)?.includes(matched.alias),
        aliasEntryReturned: !!JSON.stringify(current)?.includes(`modules/${matched.alias.toLowerCase()}.md`) });
    }
    // Replay the consumed bytes through the actual Workbench request handler.
    const request = require('node:stream').Readable.from([Buffer.from(payload)]);
    for (const field of ['method', 'url', 'headers', 'socket']) request[field] = req[field];
    await handle(request, res);
  });
  const workbenchUrl = await listen(workbench);
  const packageDir = path.dirname(require.resolve('@sanqianx/vector-hub/package.json'));
  const { HubManager } = require(path.join(packageDir, 'dist/cjs/server/manager.js'));
  const { createServer } = require(path.join(packageDir, 'dist/cjs/server/server.js'));
  let manager, vector;
  try {
    manager = await HubManager.load({ managed: true, configPath: path.join(root, 'vector-config.json'), rootPath: path.join(root, 'vectors') });
    vector = http.createServer(createServer(manager, { runtimeToken: token }));
    const vectorUrl = await listen(vector);
    await manager.applyRuntimeSettings({ provider: 'openai', endpoint: workbenchUrl, model: 'embedding-3', apiKey: 'isolated-loopback-adapter' });
    return { workbenchUrl, vectorUrl, token, profileId, model, trace, manager,
      close: async () => { await closeServer(vector); await manager.waitForWrites(); await closeServer(workbench); } };
  } catch (error) {
    if (vector?.listening) await closeServer(vector);
    if (manager) await manager.waitForWrites();
    await closeServer(workbench);
    throw error;
  }
}

async function main() {
  const key = process.env.ZAI_API_KEY;
  if (!key) throw new Error('BLOCKED: isolated Z.AI model and embedding credentials are unavailable (ZAI_API_KEY).');
  const source = process.env.PKB_CONTEXT_ENGINE_SOURCE;
  const createEngineServer = source ? require(path.join(source, 'src/server')).createEngineServer : require('@sanqianx/ai-coding-knowledge-engine').createEngineServer;
  const runtime = await startRuntime(key);
  let fixture;
  try {
    fixture = await setup({ createEngineServer, vectorUrl: runtime.vectorUrl, runtimeToken: runtime.token,
      engineOptions: { workbenchUrl: runtime.workbenchUrl } });
    await runtime.manager.import(fixture.knowledge, fixture.projectId, false);
    await fixture.request('/api/runtime-context-config', { enabled: true, profileId: runtime.profileId, model: runtime.model });
    const rows = [];
    const lane = process.argv[2] || 'smoke';
    const cases = lane === 'smoke' ? [corpus.cases[0]] : corpus.cases;
    for (const item of cases) {
      const indices = lane === 'blind' ? [1, 2, 3] : [0];
      for (const index of indices) {
        const base = { projectId: fixture.projectId, query: item.queries[index], scope: 'project', client: 'codex' };
        const stable = await fixture.request('/api/context', { ...base, sessionId: `stable-${item.id}-${index}` });
        const candidate = await fixture.request('/api/context/agentic', { ...base, sessionId: `candidate-${item.id}-${index}` });
        rows.push({ case: item.id, index, stable: evaluate(stable, item), candidate: evaluate(candidate, item),
          mode: candidate.mode, status: candidate.packStatus, degraded: candidate.degraded, budget: candidate.budget });
      }
    }
    console.log(JSON.stringify({ lane, model: runtime.model, embedding: 'embedding-3', rows, trace: runtime.trace }, null, 2));
    if (lane === 'smoke') {
      assert.equal(rows[0].mode, 'agentic');
      assert.equal(rows[0].candidate.facts, 2);
      assert.equal(rows[0].candidate.backend, 'hybrid+markdown-truth');
      assert.ok(runtime.trace.some(row => row.aliasFirstSeenInToolResult && !row.aliasEntryReturned));
      assert.ok(runtime.trace.some(row => row.round >= 2 && row.aliasEntryReturned));
    }
  } finally {
    if (fixture) await fixture.close();
    await runtime.close();
  }
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { startRuntime };
