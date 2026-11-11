'use strict';
// A/B ranking diagnosis: the SAME corpus snapshot and the SAME vector index,
// queried through engine 0.2.8 (v3 ranking, repo node_modules) and engine
// 0.2.7-rc.12 (v2 ranking, scratch prefix). For every semantic / isolation
// gold query this prints the target's rank under both engines. If v2 finds
// the target in top-5 and v3 does not, the regression is in the engine change;
// if both miss, the corpus/queries drifted relative to the gate's baseline.
//
// Usage: node _site/scripts/ab-rank-v2-v3.js <v2-engine-prefix> <reportPath>
// Env:   MINIMAX_API_KEY required (one embedding pass, shared by both engines)
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { applyDriverIsolation } = require('../_test/helpers/parallel-qa-engine-endpoint-isolate');
const freePort = require('../_test/helpers/free-port');

const ROOT = path.resolve(__dirname, '../..');
const CORPUS = {
  product: 'D:\\SanQian.Xu\\knowledge\\project-knowledge-base-f8eb65',
  workbench: 'D:\\SanQian.Xu\\knowledge\\claude-ai-workbench-a40cb2',
  engine: 'D:\\SanQian.Xu\\knowledge\\knowledge-engine-8ce6c0',
};
const postJson = (baseUrl, route, body, timeoutMs = 60000) => new Promise((resolve, reject) => {
  const target = new URL(baseUrl);
  const payload = Buffer.from(JSON.stringify(body));
  const request = http.request({ hostname: target.hostname, port: target.port, path: route, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length, Authorization: `Bearer ${process.env.__AB_TOKEN__}` } }, response => {
    let text = '';
    response.on('data', chunk => { text += chunk; });
    response.on('end', () => {
      if (response.statusCode < 200 || response.statusCode >= 300) return reject(new Error(`POST ${route} -> ${response.statusCode}: ${text.slice(0, 200)}`));
      try { resolve(JSON.parse(text)); } catch (error) { reject(error); }
    });
  });
  request.setTimeout(timeoutMs, () => request.destroy(new Error(`POST ${route} timed out`)));
  request.on('error', reject);
  request.end(payload);
});

async function waitFor(url, label, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const r = await fetch(url, { signal: AbortSignal.timeout(2000) }); if (r.ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error('Timed out waiting for ' + label);
}

async function main() {
  const v2Prefix = path.resolve(process.argv[2]);
  const reportPath = path.resolve(process.argv[3] || 'ab-rank-report.json');
  const apiKey = process.env.MINIMAX_API_KEY;
  if (!apiKey) throw new Error('MINIMAX_API_KEY required');
  const v2Server = require(path.join(v2Prefix, 'node_modules', '@sanqianx', 'ai-coding-knowledge-engine', 'src', 'server.js')).createEngineServer;
  const v3Server = require(path.join(ROOT, 'node_modules', '@sanqianx', 'ai-coding-knowledge-engine', 'src', 'server.js')).createEngineServer;

  const applied = applyDriverIsolation({ prefix: 'pk-qa-gold-ab' });
  const fixture = fs.mkdtempSync(path.join(applied.layout.temp, 'pk-gold-ab-'));
  const cutoff = Date.parse('2026-10-24T00:00:00+08:00');
  const copySnapshot = (from, to) => {
    fs.mkdirSync(to, { recursive: true });
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      const s = path.join(from, entry.name), t = path.join(to, entry.name);
      if (entry.isDirectory()) copySnapshot(s, t);
      else if (entry.isFile() && fs.statSync(s).mtimeMs < cutoff) fs.copyFileSync(s, t);
    }
  };
  const corpusRoot = path.join(fixture, 'corpus');
  const names = { product: 'gold-product', workbench: 'gold-workbench', engine: 'gold-engine' };
  for (const [name, source] of Object.entries(CORPUS)) copySnapshot(source, path.join(corpusRoot, name));

  const vectorPort = await freePort();
  const vectorUrl = `http://127.0.0.1:${vectorPort}`;
  const vector = spawn(process.execPath, [path.join(ROOT, 'node_modules/@sanqianx/vector-hub/dist/cjs/bin.js'), 'serve', '--port', String(vectorPort), '--root', path.join(fixture, 'vector')], { env: { ...process.env, MINIMAX_API_KEY: apiKey, VECTOR_HUB_ROOT: path.join(fixture, 'vector'), VECTOR_HUB_CONFIG: path.join(fixture, 'vector-config.json') }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  vector.stdout.on('data', c => process.stdout.write('[v] ' + c)); vector.stderr.on('data', c => process.stderr.write('[ve] ' + c));

  const bridgeStub = http.createServer((req, res) => { res.statusCode = 503; res.end(JSON.stringify({ ok: false })); });
  await new Promise(resolve => bridgeStub.listen(0, '127.0.0.1', resolve));
  const bridgeUrl = `http://127.0.0.1:${bridgeStub.address().port}`;
  const token = crypto.randomBytes(24).toString('hex');
  process.env.__AB_TOKEN__ = token;
  const engines = {};
  for (const [key, factory] of [['v2', v2Server], ['v3', v3Server]]) {
    const app = factory({ dataDir: path.join(fixture, `engine-${key}`), runtimeToken: token, debug: false, consume: false, vectorUrl, bridgeUrl });
    await app.ready;
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    engines[key] = { app, url: `http://127.0.0.1:${app.server.address().port}` };
  }
  const report = { startedAt: new Date().toISOString(), corpus: { cutoff: new Date(cutoff).toISOString() }, cases: [] };
  try {
    await waitFor(`${vectorUrl}/api/health`, 'vector');
    const sharedBrain = path.join(corpusRoot, '_shared-brain'), sharedDomain = path.join(corpusRoot, '_shared-domain');
    fs.mkdirSync(sharedBrain, { recursive: true }); fs.mkdirSync(sharedDomain, { recursive: true });
    for (const key of ['v2', 'v3']) {
      const base = engines[key].url;
      await postJson(base, '/api/scopes', { scopes: [
        { id: 'brain-ab', kind: 'brain', brainId: 'brain-ab', name: 'AB Brain', knowledgePath: sharedBrain },
        { id: 'domain-ab', kind: 'domain', brainId: 'brain-ab', domainId: 'domain-ab', name: 'AB Domain', knowledgePath: sharedDomain },
      ] });
      for (const [name, projectId] of Object.entries(names)) {
        const repo = path.join(fixture, 'repos', name); fs.mkdirSync(repo, { recursive: true });
        await postJson(base, '/api/projects', { projectId, repoPath: repo, knowledgePath: path.join(corpusRoot, name), domainId: 'domain-ab' });
      }
    }
    for (const [name, projectId] of Object.entries(names)) {
      for (let attempt = 1; attempt <= 20; attempt++) {
        try { await postJson(vectorUrl, '/api/import', { projectName: projectId, sourceDir: path.join(corpusRoot, name), watch: false }, 30 * 60 * 1000); break; }
        catch (error) { if (attempt === 20 || !/rate limit|429|1002/i.test(String(error.message))) throw error; console.log(`rate-limited on ${projectId}, cooling down`); await new Promise(r => setTimeout(r, 75 * 1000)); }
      }
      console.log('imported', name);
    }
    const gold = JSON.parse(fs.readFileSync(path.join(ROOT, '_site/_test/fixtures/retrieval-gold-queries.json'), 'utf8'));
    const projectOf = q => names[q.project];
    for (const q of gold.filter(x => ['semantic', 'isolation'].includes(x.kind))) {
      const item = { id: q.id, kind: q.kind, query: q.query, expect: q.entry || null, empty: q.empty === true, engines: {} };
      for (const key of ['v2', 'v3']) {
        const searched = await postJson(engines[key].url, '/api/search', { projectId: projectOf(q), scope: 'project', query: q.query, limit: 20 }, 60000);
        const rows = searched.results || [];
        item.engines[key] = {
          total: rows.length,
          top5: rows.slice(0, 5).map(r => r.entry_id),
          expectRank: q.entry ? rows.findIndex(r => r.entry_id === q.entry) + 1 : null,
          rankingVersion: searched.rankingVersion,
        };
      }
      report.cases.push(item);
      const v2 = item.engines.v2, v3 = item.engines.v3;
      console.log(q.id, '| v2 rank:', v2.expectRank || (q.empty ? (v2.total === 0 ? 'EMPTY✓' : v2.total + ' rows') : '-'), '| v3 rank:', v3.expectRank || (q.empty ? (v3.total === 0 ? 'EMPTY✓' : v3.total + ' rows') : '-'));
    }
    report.finishedAt = new Date().toISOString();
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.log('report:', reportPath);
  } finally {
    vector.kill();
    for (const key of ['v2', 'v3']) await engines[key].app.close().catch(() => {});
    await new Promise(resolve => bridgeStub.close(resolve));
    fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}
main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
