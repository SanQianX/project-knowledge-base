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
  // The gold queries are calibrated against the corpus state of their last
  // evidenced run (2026-10-23). Later knowledge entries ABOUT the gate itself
  // quote the queries and their expectations verbatim, so including them makes
  // a PostgreSQL "unsupported" question match the entry documenting that very
  // gate. Snapshot the corpus with a mtime cutoff instead of copying it live.
  const cutoffEnv = process.env.PKB_GOLD_CORPUS_CUTOFF;
  const cutoff = cutoffEnv ? Date.parse(cutoffEnv) : Date.parse('2026-10-24T00:00:00+08:00');
  if (!Number.isFinite(cutoff)) throw new Error(`PKB_GOLD_CORPUS_CUTOFF is not a valid date: ${cutoffEnv}`);
  const copySnapshot = (from, to) => {
    fs.mkdirSync(to, { recursive: true });
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      const sourceFile = path.join(from, entry.name), targetFile = path.join(to, entry.name);
      if (entry.isDirectory()) copySnapshot(sourceFile, targetFile);
      else if (entry.isFile() && fs.statSync(sourceFile).mtimeMs < cutoff) fs.copyFileSync(sourceFile, targetFile);
    }
  };
  const projects = {};
  for (const [name, source] of Object.entries(corpus)) {
    const target = path.join(corpusRoot, name);
    copySnapshot(source, target);
    const repo = path.join(fixture, 'repos', name);
    fs.mkdirSync(repo, { recursive: true });
    const projectId = `gold-${name}-${crypto.randomBytes(3).toString('hex')}`;
    projects[name] = { projectId, knowledgePath: target, repoPath: repo, files: fs.readdirSync(target).length };
  }
  console.log('corpus snapshot cutoff:', new Date(cutoff).toISOString(), '| files:', Object.fromEntries(Object.entries(projects).map(([name, p]) => [name, p.files])));
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
      // The remote embedding API rate-limits full-corpus imports (RPM). The
      // import is incremental per file hash, so retrying after a cool-down
      // only embeds what the previous attempt did not reach.
      let imported = null;
      for (let attempt = 1; attempt <= 20; attempt++) {
        try { imported = await postJson(vectorUrl, '/api/import', { projectName: project.projectId, sourceDir: project.knowledgePath, watch: false }, 30 * 60 * 1000); break; }
        catch (error) {
          if (attempt === 20 || !/rate limit|429|1002/i.test(String(error.message))) throw error;
          console.log(`rate-limited on ${project.projectId} (attempt ${attempt}); cooling down 75s`);
          await new Promise(resolve => setTimeout(resolve, 75 * 1000));
        }
      }
      console.log(`indexed-import accepted: ${project.projectId}`, JSON.stringify(imported).slice(0, 120));
    }
    const indexTimeout = Number(process.env.PKB_GOLD_INDEX_TIMEOUT_MS || 20 * 60 * 1000);
    await waitFor(`${vectorUrl}/api/projects`, async response => {
      const payload = await response.clone().json();
      return Object.values(projects).every(project => payload.projects?.some(p => p.name === project.projectId && p.hasIndex));
    }, 'all three corpus indexes', indexTimeout);
    // Rate-limited incremental imports can leave a file tracked but not fully
    // embedded. Every gold target must answer a probe built from its own
    // distinctive text before the cases run; re-import until they all do.
    const queries = JSON.parse(fs.readFileSync(path.join(ROOT, '_site/_test/fixtures/retrieval-gold-queries.json'), 'utf8'));
    const targets = queries.filter(q => q.entry).map(q => ({ id: q.id, project: q.project, entry: q.entry }));
    const needle = file => fs.readFileSync(file, 'utf8').split(/\r?\n/).map(line => line.trim()).filter(line => line.length >= 12 && !line.startsWith('#')).sort((a, b) => b.length - a.length)[0];
    const probeTarget = async target => {
      const file = path.join(projects[target.project].knowledgePath, target.entry);
      if (!fs.existsSync(file)) return 'file-missing-in-snapshot';
      const phrase = needle(file);
      if (!phrase) return 'no-distinctive-line';
      const probe = await fetch(`${vectorUrl}/api/search?q=${encodeURIComponent(phrase)}&projects=${projects[target.project].projectId}&maxResults=5&resultLevel=chunk`, { signal: AbortSignal.timeout(30000) });
      const payload = await probe.json();
      return (payload.results || []).some(row => String(row.uri || row.documentUri || '').replace(/\\/g, '/').endsWith(target.entry)) ? null : 'not-in-vector-top5';
    };
    let missing = [];
    for (let round = 1; round <= 10; round++) {
      missing = [];
      for (const target of targets) { const verdict = await probeTarget(target); if (verdict) missing.push({ ...target, verdict }); }
      if (!missing.length) break;
      console.log('vector completeness round', round, '- missing:', missing.map(m => `${m.id}(${m.verdict})`).join(','));
      if (missing.some(m => m.verdict === 'file-missing-in-snapshot')) throw new Error('a gold target file is absent from the corpus snapshot: ' + JSON.stringify(missing));
      for (const project of Object.values(projects)) await postJson(vectorUrl, '/api/import', { projectName: project.projectId, sourceDir: project.knowledgePath, watch: false }, 30 * 60 * 1000);
    }
    if (missing.length) throw new Error('vector index incomplete after re-imports: ' + JSON.stringify(missing));
    console.log('corpus indexed and all gold targets probe clean; running the gold cases');

    const report = await verify({
      url: proxy.url,
      basePath: '/api',
      recallAt: Number(process.env.PKB_GOLD_RECALL_AT || 15),
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
