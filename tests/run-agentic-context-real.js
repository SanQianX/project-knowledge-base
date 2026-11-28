'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { corpus, evaluate, listen, setup } = require('./helpers/agentic-context-fixture');
const runtimeRequire = createRequire(path.join(process.env.PKB_CONTEXT_CANDIDATE_ROOT || path.resolve(__dirname, '..'), 'package.json'));

async function closeServer(server) {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}

// A fixed vector from the character bigrams of a text: texts that share words
// score higher than unrelated ones. It stands in for an embedding provider
// that rate-limits the test key and verifies the pipeline, never a model.
function simulatedEmbedding(text, size = 256) {
  const vector = new Array(size).fill(0);
  const source = String(text).toLowerCase();
  for (let index = 0; index < source.length - 1; index++) {
    let hash = 2166136261;
    for (const char of source.slice(index, index + 2)) { hash ^= char.codePointAt(0); hash = Math.imul(hash, 16777619) >>> 0; }
    vector[hash % size] += 1;
  }
  const norm = Math.hypot(...vector) || 1;
  return vector.map(value => value / norm);
}

async function startRuntime(key, { deferFirstContext = false, fixtureCorpus = corpus } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-real-context-'));
  const token = crypto.randomBytes(24).toString('hex');
  const model = process.env.PKB_CONTEXT_TEST_MODEL || 'glm-4.7';
  const profileId = 'test-context-profile';
  const workbenchRoot = process.env.PKB_CONTEXT_WORKBENCH_SOURCE || path.dirname(runtimeRequire.resolve('claude-ai-workbench/package.json'));
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
  const handle = createHttpHandler({ profiles, listProfiles: () => profiles.list() }, { runtimeToken: token });
  const trace = [];
  let deferred = false;
  const workbench = http.createServer(async (req, res) => {
    if (req.url === '/v1/embeddings' && req.method === 'POST') {
      const parts = [];
      for await (const piece of req) parts.push(piece);
      if (process.env.PKB_CONTEXT_EMBEDDING === 'simulated') {
        let request;
        try { request = JSON.parse(Buffer.concat(parts).toString('utf8')); } catch { res.writeHead(400).end(); return; }
        const texts = (Array.isArray(request.input) ? request.input : [request.input]).map(text => String(typeof text === 'string' ? text : text?.text));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', model: request.model, usage: { prompt_tokens: 0, total_tokens: 0 },
          data: texts.map((text, index) => ({ object: 'embedding', index, embedding: simulatedEmbedding(text) })) }));
        return;
      }
      try {
        const upstream = await fetch('https://api.z.ai/api/paas/v4/embeddings', { method: 'POST', redirect: 'error',
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: Buffer.concat(parts), signal: AbortSignal.timeout(35000) });
        res.writeHead(upstream.status, { 'Content-Type': 'application/json' });
        res.end(Buffer.from(await upstream.arrayBuffer()));
      } catch { res.writeHead(502).end(); }
      return;
    }
    if (req.method !== 'POST' || req.url !== '/api/claude-workbench/v1/internal/maintenance-agent') {
      if (!(await handle(req, res))) res.writeHead(404).end();
      return;
    }
    let payload = '';
    for await (const piece of req) payload += piece;
    let prompt;
    try { prompt = JSON.parse(JSON.parse(payload).prompt); } catch { /* Non-context Workbench traffic is not an evaluation row. */ }
    if (prompt?.task && deferFirstContext && !deferred) {
      deferred = true;
      await new Promise(resolve => {
        const timer = setTimeout(resolve, 12000);
        res.once('close', () => { clearTimeout(timer); resolve(); });
      });
      if (res.destroyed) return;
    }
    const matched = prompt?.task?.query && fixtureCorpus.cases.find(item => item.queries.includes(prompt.task.query) || item.topic === prompt.task.query);
    // A search-page answer sends other shapes (keyword plan, leads view,
    // synthesis) that carry no exchanges; its rounds are asserted by the
    // browser run itself.
    if (matched && Array.isArray(prompt.exchanges)) {
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
  profiles.setEmbeddingConfig({ provider: 'openai', endpoint: workbenchUrl, model: 'embedding-3', profileId });
  const packageDir = path.dirname(runtimeRequire.resolve('@sanqianx/vector-hub/package.json'));
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
  const createEngineServer = source ? require(path.join(source, 'src/server')).createEngineServer : runtimeRequire('@sanqianx/ai-coding-knowledge-engine').createEngineServer;
  const lane = process.argv[2] || 'smoke';
  const postfix = lane === 'postfix' || lane === 'postfix-file';
  const fixtureCorpus = postfix ? require('./fixtures/agentic-context-postfix-corpus.json') : corpus;
  const runtime = await startRuntime(key, { fixtureCorpus });
  let fixture;
  try {
    fixture = await setup({ createEngineServer, vectorUrl: runtime.vectorUrl, runtimeToken: runtime.token, fixtureCorpus,
      engineOptions: { workbenchUrl: runtime.workbenchUrl } });
    if (lane !== 'postfix-file') await runtime.manager.import(fixture.knowledge, fixture.projectId, false);
    await fixture.request('/api/runtime-context-config', { enabled: true, profileId: runtime.profileId, model: runtime.model });
    const rows = [];
    const cases = lane === 'smoke' ? [fixtureCorpus.cases[0]] : fixtureCorpus.cases;
    for (const item of cases) {
      const indices = lane === 'blind' || postfix ? [1, 2, 3] : [0];
      for (const index of indices) {
        const base = { projectId: fixture.projectId, query: item.queries[index], scope: 'project', client: 'codex' };
        const stable = await fixture.request('/api/context', { ...base, sessionId: `stable-${item.id}-${index}` });
        const candidate = await fixture.request('/api/context/agentic', { ...base, sessionId: `candidate-${item.id}-${index}` });
        rows.push({ case: item.id, index, stable: evaluate(stable, item), candidate: evaluate(candidate, item),
          mode: candidate.mode, status: candidate.packStatus, degraded: candidate.degraded, budget: candidate.budget });
      }
    }
    console.log(JSON.stringify({ lane, model: runtime.model, embedding: lane === 'postfix-file' ? null : 'embedding-3', rows, trace: runtime.trace }, null, 2));
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
