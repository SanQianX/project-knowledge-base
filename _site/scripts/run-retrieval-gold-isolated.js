'use strict';
// Isolated runner for the retrieval gold gate. Spins its own vector-hub (real
// remote embeddings via MINIMAX_API_KEY) and the real knowledge engine from
// node_modules, copies the three corpus project knowledge directories into a
// throwaway fixture (the source knowledge roots are only ever read), indexes
// them, then runs verify-retrieval-gold.js against the engine.
//
// Nothing here touches the running product instance: the corpus source roots
// are read-only inputs, all servers use fresh data directories and free ports,
// and the driver isolation helper rebuilds the environment before any product
// module is required.
//
// Usage:
//   node _site/scripts/run-retrieval-gold-isolated.js <reportPath>
// Env:
//   MINIMAX_API_KEY (or PKB_GOLD_MINIMAX_API_KEY)  required - embedding API key
//   PKB_GOLD_CORPUS_PRODUCT / _WORKBENCH / _ENGINE optional corpus overrides
//   PKB_GOLD_INDEX_TIMEOUT_MS                       default 20 min

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const http = require('node:http');
// Remote embedding of a full corpus keeps the import response open far past
// undici's default 5-minute headers timeout; plain http has no such default.
const postJson = (baseUrl, route, body, timeoutMs) => new Promise((resolve, reject) => {
  const target = new URL(baseUrl);
  const payload = Buffer.from(JSON.stringify(body));
  const request = http.request({ hostname: target.hostname, port: target.port, path: route, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length } }, response => {
    let text = '';
    response.on('data', chunk => { text += chunk; });
    response.on('end', () => {
      if (response.statusCode < 200 || response.statusCode >= 300) return reject(new Error(`POST ${route} -> ${response.statusCode}: ${text.slice(0, 300)}`));
      try { resolve(JSON.parse(text)); } catch (error) { reject(error); }
    });
  });
  request.setTimeout(timeoutMs, () => request.destroy(new Error(`POST ${route} timed out after ${timeoutMs}ms`)));
  request.on('error', reject);
  request.end(payload);
});
const { applyDriverIsolation } = require('../_test/helpers/parallel-qa-engine-endpoint-isolate');
const { guardedCreateEngineServer } = require('../_test/helpers/parallel-qa-engine-endpoint-guard');
const { createUpstreamProxy, createModuleFixture } = require('../_test/helpers/module-fixture');
const freePort = require('../_test/helpers/free-port');
const { verify } = require('./verify-retrieval-gold');

const ROOT = path.resolve(__dirname, '../..');
const DEFAULT_CORPUS = {
  product: 'D:\\SanQian.Xu\\knowledge\\project-knowledge-base-f8eb65',
  workbench: 'D:\\SanQian.Xu\\knowledge\\claude-ai-workbench-a40cb2',
  engine: 'D:\\SanQian.Xu\\knowledge\\knowledge-engine-8ce6c0',
};

async function waitFor(url, check, label, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (response.ok && (await check(response))) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error('Timed out waiting for ' + label);
}

async function main() {
  const reportPath = path.resolve(process.argv[2] || 'retrieval-gold-report.json');
  const apiKey = process.env.PKB_GOLD_MINIMAX_API_KEY || process.env.MINIMAX_API_KEY;
  if (!apiKey) throw new Error('Set MINIMAX_API_KEY (embedding key) before running the gold gate.');
  const corpus = {
    product: process.env.PKB_GOLD_CORPUS_PRODUCT || DEFAULT_CORPUS.product,
    workbench: process.env.PKB_GOLD_CORPUS_WORKBENCH || DEFAULT_CORPUS.workbench,
    engine: process.env.PKB_GOLD_CORPUS_ENGINE || DEFAULT_CORPUS.engine,
  };
  for (const [name, source] of Object.entries(corpus)) if (!fs.existsSync(source)) throw new Error(`Corpus directory for "${name}" is missing: ${source}`);

  const applied = applyDriverIsolation({ prefix: 'pk-qa-gold' });
  const fixture = fs.mkdtempSync(path.join(applied.layout.temp, 'pk-gold-'));
  const corpusRoot = path.join(fixture, 'corpus');
  fs.mkdirSync(corpusRoot, { recursive: true });
  const projects = {};
  for (const [name, source] of Object.entries(corpus)) {
    const target = path.join(corpusRoot, name);
    fs.cpSync(source, target, { recursive: true, dereferenceLinks: true });
    const repo = path.join(fixture, 'repos', name);
    fs.mkdirSync(repo, { recursive: true });
    const projectId = `gold-${name}-${crypto.randomBytes(3).toString('hex')}`;
    projects[name] = { projectId, knowledgePath: target, repoPath: repo, files: fs.readdirSync(target).length };
  }
  const shared = path.join(corpusRoot, '_shared');
  fs.mkdirSync(path.join(shared, 'brain'), { recursive: true }); fs.mkdirSync(path.join(shared, 'domain'), { recursive: true });

  const vectorPort = await freePort();
  const vectorUrl = `http://127.0.0.1:${vectorPort}`;
  // A fresh VECTOR_HUB_CONFIG is isolation-critical: the default is the user's
  // global ~/.vector-hub/config.json, whose project watchers point at the LIVE
  // knowledge directories - an isolated gate instance must never resume them.
  const vector = spawn(process.execPath, [path.join(ROOT, 'node_modules/@sanqianx/vector-hub/dist/cjs/bin.js'), 'serve', '--port', String(vectorPort), '--root', path.join(fixture, 'vector')], {
    env: { ...process.env, MINIMAX_API_KEY: apiKey, VECTOR_HUB_ROOT: path.join(fixture, 'vector'), VECTOR_HUB_CONFIG: path.join(fixture, 'vector-config.json') },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  vector.stdout.on('data', chunk => process.stdout.write('[vector] ' + chunk));
  vector.stderr.on('data', chunk => process.stderr.write('[vector] ' + chunk));

  const engineToken = crypto.randomBytes(24).toString('hex');
  const bridge = createModuleFixture({ kind: 'eventBridge' });
  await bridge.start(); bridge.setOnline(false);
  const engine = guardedCreateEngineServer({ dataDir: path.join(fixture, 'engine'), runtimeToken: engineToken, debug: true, consume: false, vectorUrl, bridgeUrl: bridge.url });
  await engine.ready;
  await new Promise(resolve => engine.server.listen(0, '127.0.0.1', resolve));
  const engineUrl = `http://127.0.0.1:${engine.server.address().port}`;
  const proxy = createUpstreamProxy({ target: engineUrl, token: engineToken, tag: 'gold-engine' });
  await proxy.start();

  const engineApi = async (method, route, body) => {
    // Registration routes are shell-only: the runtime token authorizes this
    // harness exactly like the product shell (same loopback + timing-safe
    // Bearer check the engine enforces).
    const headers = { Authorization: `Bearer ${engineToken}` };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(engineUrl + route, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000) });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`${method} ${route} -> ${response.status}: ${JSON.stringify(payload).slice(0, 300)}`);
    return payload;
  };
  try {
    await waitFor(`${vectorUrl}/api/health`, async () => true, 'vector-hub health');
    const initialProjects = await (await fetch(`${vectorUrl}/api/projects`)).json();
    if ((initialProjects.projects || []).length) throw new Error(`isolated vector-hub must start empty, found: ${(initialProjects.projects || []).map(p => p.name).join(', ')}`);
    const brainId = 'brain-gold', domainId = 'domain-gold';
    await engineApi('POST', '/api/scopes', { scopes: [
      { id: brainId, kind: 'brain', brainId, name: 'Gold Brain', knowledgePath: path.join(shared, 'brain') },
      { id: domainId, kind: 'domain', brainId, domainId, name: 'Gold Domain', knowledgePath: path.join(shared, 'domain') },
    ] });
    for (const project of Object.values(projects)) {
      await engineApi('POST', '/api/projects', { projectId: project.projectId, repoPath: project.repoPath, knowledgePath: project.knowledgePath, domainId });
      const imported = await postJson(vectorUrl, '/api/import', { projectName: project.projectId, sourceDir: project.knowledgePath, watch: false }, 30 * 60 * 1000);
      console.log(`indexed-import accepted: ${project.projectId}`);
    }
    const indexTimeout = Number(process.env.PKB_GOLD_INDEX_TIMEOUT_MS || 20 * 60 * 1000);
    await waitFor(`${vectorUrl}/api/projects`, async response => {
      const payload = await response.clone().json();
      return Object.values(projects).every(project => payload.projects?.some(p => p.name === project.projectId && p.hasIndex));
    }, 'all three corpus indexes', indexTimeout);
    console.log('corpus indexed; running the gold cases');

    const queries = JSON.parse(fs.readFileSync(path.join(ROOT, '_site/_test/fixtures/retrieval-gold-queries.json'), 'utf8'));
    const report = await verify({
      url: proxy.url,
      basePath: '/api',
      projects: Object.fromEntries(Object.entries(projects).map(([name, project]) => [name, { projectId: project.projectId, knowledgePath: project.knowledgePath }])),
      fixtureRoot: corpusRoot,
      queries,
      reportPath,
    });
    process.exitCode = report.passed ? 0 : 1;
  } finally {
    vector.kill();
    await engine.close().catch(() => {});
    await proxy.close();
    await bridge.close();
    fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

main().catch(error => { console.error(error.stack || error.message); if (error.cause) console.error('cause:', String(error.cause).slice(0, 400)); process.exitCode = 1; });
