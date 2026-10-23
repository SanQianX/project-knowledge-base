'use strict';
// Parallel knowledge lane — retrieval cases RET-001, RET-003, RET-004, RET-005.
// Every assertion runs against real Markdown on disk and the real vendored
// knowledge-engine over real loopback HTTP. The vector endpoint is an
// explicitly declared stub that returns no results, so nothing in this file
// may be counted as vector-channel evidence.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const fixture = require('./helpers/parallel-knowledge-fixture');
// The entry point isolates itself: ambient module addresses, live data
// directories and the real HOME are cleared here, before any product module
// is loaded, so the test never depends on the caller running `env -u`.
fixture.isolateProcess();
const { StorageLayout } = require('../lib/storage-layout');
const { ProjectStore } = require('../lib/project-store');
const { ProjectRegistryStore } = require('../lib/project-registry-store');
const { KnowledgeRetrievalService } = require('../lib/knowledge-retrieval-service');
const { EngineKnowledgeClient } = require('../lib/engine-knowledge-client');
const { CHUNKER_VERSION } = require('../lib/markdown-knowledge-indexer');
const { sha256 } = require('../lib/knowledge-schema');
const { createEngineServer } = require('../../_modules/knowledge-engine/src/server');
const AtomicFile = require('../../_modules/knowledge-engine/src/runtime/atomic-file');

const results = [];
function record(caseId, status, detail) {
  results.push({ caseId, status, detail });
  console.log(`CASE ${caseId} ${status} ${JSON.stringify(detail)}`);
}

async function stubVectorServer() {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      requests.push({ url: req.url, method: req.method, body: body || null });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, results: [], errors: [], projects: [] }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { requests, url: `http://127.0.0.1:${server.address().port}`, close: () => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); } };
}

// The engine must never reach the user's event bridge (8790) from this lane.
function forbiddenBridge() {
  const guard = name => async () => { throw new Error(`event bridge must not be contacted from the test lane (${name})`); };
  return { registerConsumer: guard('registerConsumer'), listJournals: guard('listJournals'), readEvents: guard('readEvents'), ackConsumerCursor: guard('ackConsumerCursor'), close() {} };
}

// A declared stub analyzer: it never calls a model, it only stages Markdown
// so the promotion path can be exercised end to end.
function stubAnalyzer(events = []) {
  return {
    sourceReadMode: 'isolated-frozen-evidence',
    async runClaim(input) {
      events.push({ kind: 'start', projectId: input.projectId, sha: input.claim.commitSha });
      const relative = `changes/${input.claim.commitSha.slice(0, 12)}.md`;
      const content = `# 真实晋升条目 ${input.claim.commitSha.slice(0, 12)}\n\nRET001TOKEN 事实：本次提交把配额采样改为串行执行。\n\ncommit: ${input.claim.commitSha}\n`;
      AtomicFile.writeFileAtomic(path.join(input.stagingPath, 'files', relative), content);
      AtomicFile.writeJsonAtomic(input.manifestPath, {
        schema: 'knowledge-staging-manifest/v1',
        projectId: input.projectId,
        runId: input.claim.runId,
        commitSha: input.claim.commitSha,
        operations: [{
          path: relative,
          operation: 'create',
          sha256: `sha256:${crypto.createHash('sha256').update(content).digest('hex')}`,
          reason: 'Frozen Git evidence',
          evidenceReferences: [`commit:${input.claim.commitSha}`, `patch:${input.claim.patchHash}`, `conversation:${input.claim.conversationSnapshotHash}`, `retrieval:${input.claim.retrievalManifestHash}`],
        }],
      });
      events.push({ kind: 'finish', projectId: input.projectId, sha: input.claim.commitSha });
      return { ok: true };
    },
  };
}

(async () => {
  const root = fixture.makeTempDir('parallel-knowledge-retrieval');
  const dataDir = path.join(root, 'data');
  const layout = new StorageLayout({ dataDir });
  const projects = new ProjectStore({ layout });
  const registry = new ProjectRegistryStore({ layout });
  const vector = await stubVectorServer();
  const analyzerEvents = [];
  const engineDataDir = path.join(root, 'engine-data');
  fs.mkdirSync(engineDataDir, { recursive: true });
  const engine = createEngineServer({ dataDir: engineDataDir, vectorUrl: vector.url, bridge: forbiddenBridge(), analyzer: stubAnalyzer(analyzerEvents) });
  await engine.ready;
  await new Promise(resolve => engine.server.listen(0, '127.0.0.1', resolve));
  const engineUrl = `http://127.0.0.1:${engine.server.address().port}`;
  const call = async (route, body) => {
    const response = await fetch(`${engineUrl}${route}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };

  try {
    // ---------------------------------------------------------------- fixtures
    const repoA = fixture.makeRepo(root, 'repo-a', [
      { message: 'initial', files: { 'README.md': '# A\n\n初始内容\n' } },
      { message: 'feature', files: { 'feature.txt': 'feature A\n' } },
    ]);
    const repoB = fixture.makeRepo(root, 'repo-b', [{ message: 'initial', files: { 'README.md': '# B\n' } }]);
    const repoC = fixture.makeRepo(root, 'repo-c', [{ message: 'initial', files: { 'README.md': '# C\n' } }]);
    const knowledgeA = fixture.makeKnowledgeDir(root, 'knowledge-a');
    const knowledgeB = fixture.makeKnowledgeDir(root, 'knowledge-b');
    const knowledgeC = fixture.makeKnowledgeDir(root, 'knowledge-c');
    const promotedEntry = `changes/planted-${repoA.head.slice(0, 12)}.md`;
    const promotedBody = `# 真实晋升条目\n\nRET001TOKEN 事实：本次提交把配额采样改为串行执行。\n\ncommit: ${repoA.head}\n`;
    fs.mkdirSync(path.join(knowledgeA, 'changes'), { recursive: true });
    fs.writeFileSync(path.join(knowledgeA, promotedEntry), promotedBody, 'utf8');
    fs.writeFileSync(path.join(knowledgeA, 'changes', 'template.md'), '# 模板\n\nTODO: 待补充\n', 'utf8');
    fs.writeFileSync(path.join(knowledgeB, 'README.md'), '# B\n\nDOMAINONLYTOKEN 属于领域知识\n', 'utf8');
    fs.writeFileSync(path.join(knowledgeC, 'README.md'), '# C\n\nOTHERDOMAINTOKEN 属于其它领域\n', 'utf8');

    await projects.create('project-a', { displayName: 'A', repoPath: repoA.repoPath, knowledgePath: knowledgeA, relatedProjectIds: ['project-b'], brainId: 'brain-default', domainId: 'domain-tools' });
    await projects.create('project-b', { displayName: 'B', repoPath: repoB.repoPath, knowledgePath: knowledgeB, brainId: 'brain-default', domainId: 'domain-tools' });
    await projects.create('project-c', { displayName: 'C', repoPath: repoC.repoPath, knowledgePath: knowledgeC, brainId: 'brain-default', domainId: 'domain-other' });
    for (const id of ['project-a', 'project-b', 'project-c']) await registry.add(id, { displayNameSnapshot: id });

    // The root product service is the authoritative-Markdown reader used by
    // the shell. No embedder and no index exist yet.
    const service = new KnowledgeRetrievalService({ layout, registryStore: registry, projectStore: projects });

    // --------------------------------------------------------------- RET-001
    {
      const before = fixture.hashTree(knowledgeA);
      const response = await service.search({ projectId: 'project-a', query: 'RET001TOKEN' });
      assert.equal(response.ok, true);
      assert.ok(response.results.length >= 1, 'the promoted fact must be retrievable');
      const top = response.results[0];
      assert.equal(top.entry_id, promotedEntry, 'citation must point at the promoted relative entry');
      assert.ok(top.chunk_text.includes('RET001TOKEN'), 'the result must carry the real body text');
      assert.ok(top.chunk_text.includes('配额采样改为串行执行'), 'the returned body must contain the promoted fact sentence');
      const expectedDocumentHash = sha256(`chunker:${CHUNKER_VERSION}\n${promotedBody}`);
      assert.equal(top.document_hash, expectedDocumentHash, 'document hash must be recomputable from the real file');
      assert.equal(top.content_hash, crypto.createHash('sha256').update(top.chunk_text, 'utf8').digest('hex'), 'content hash must match the returned body');
      assert.ok(!response.results.some(row => /TODO|待补充/.test(row.chunk_text)), 'template placeholders must not be presented as facts');
      assert.equal(response.backend, 'markdown-hybrid-fallback', 'no vector channel exists in this lane, so the backend must not claim a hybrid hit');
      assert.notEqual(response.health.index, 'ok');
      assert.deepEqual(fixture.hashTree(knowledgeA), before, 'retrieval must not mutate knowledge files');
      record('RET-001', 'PASS', { entryId: top.entry_id, documentHash: top.document_hash, backend: response.backend, healthIndex: response.health.index, resultCount: response.results.length });
    }

    // --------------------------------------------------------------- RET-003
    {
      const projectScope = await service.search({ projectId: 'project-a', query: 'RET001TOKEN' });
      assert.ok(projectScope.results.every(row => row.scope_project_id === 'project-a' || row.scope_project_id === 'project-b'), 'project scope may only expose the project and its declared related projects');
      assert.ok(!projectScope.results.some(row => row.chunk_text.includes('OTHERDOMAINTOKEN')), 'an unrelated project must never leak into the project scope');
      const unrelated = await service.search({ projectId: 'project-c', query: 'OTHERDOMAINTOKEN' });
      assert.ok(unrelated.results.every(row => row.scope_project_id === 'project-c'));
      assert.ok(!unrelated.results.some(row => row.chunk_text.includes('RET001TOKEN')), 'another project must not borrow this project context');
      await assert.rejects(service.search({ projectId: 'project-unknown', query: 'RET001TOKEN' }), 'an unknown project must fail instead of borrowing a registered context');

      // Real engine scope semantics over real loopback HTTP.
      for (const project of [
        { projectId: 'project-a', name: 'A', repoPath: repoA.repoPath, knowledgePath: knowledgeA, brainId: 'brain-default', domainId: 'domain-tools' },
        { projectId: 'project-b', name: 'B', repoPath: repoB.repoPath, knowledgePath: knowledgeB, brainId: 'brain-default', domainId: 'domain-tools' },
        { projectId: 'project-c', name: 'C', repoPath: repoC.repoPath, knowledgePath: knowledgeC, brainId: 'brain-default', domainId: 'domain-other' },
      ]) await call('/api/projects', project);
      fs.writeFileSync(path.join(knowledgeA, 'shared.md'), '# A\n\nSHAREDTOKEN 共享事实 A\n', 'utf8');
      fs.writeFileSync(path.join(knowledgeB, 'shared.md'), '# B\n\nSHAREDTOKEN 共享事实 B\n', 'utf8');
      fs.writeFileSync(path.join(knowledgeC, 'shared.md'), '# C\n\nSHAREDTOKEN 共享事实 C\n', 'utf8');

      const projectScopeEngine = await call('/api/search', { projectId: 'project-a', query: 'SHAREDTOKEN', scope: 'project' });
      assert.equal(projectScopeEngine.status, 200);
      assert.deepEqual([...new Set(projectScopeEngine.body.results.map(row => row.scope_project_id))], ['project-a'], 'engine project scope must stay inside the project');
      const domainScopeEngine = await call('/api/search', { projectId: 'project-a', query: 'SHAREDTOKEN', scope: 'domain' });
      assert.deepEqual([...new Set(domainScopeEngine.body.results.map(row => row.scope_project_id))].sort(), ['project-a', 'project-b'], 'engine domain scope must expose the same-domain project only');
      const brainScopeEngine = await call('/api/search', { projectId: 'project-a', query: 'SHAREDTOKEN', scope: 'brain' });
      assert.deepEqual([...new Set(brainScopeEngine.body.results.map(row => row.scope_project_id))].sort(), ['project-a', 'project-b', 'project-c'], 'engine brain scope must expose every project of the brain');
      const unknownEngine = await call('/api/search', { projectId: 'project-unknown', query: 'SHAREDTOKEN' });
      assert.equal(unknownEngine.status, 404, 'an unknown project must be refused by the engine');
      assert.equal(unknownEngine.body.error, 'PROJECT_NOT_FOUND', 'the real engine reports the failure code as a string');
      const invalidScope = await call('/api/search', { projectId: 'project-a', query: 'SHAREDTOKEN', scope: 'global' });
      assert.equal(invalidScope.body.error, 'INVALID_ARGUMENT', 'an unknown scope must be refused');
      record('RET-003', 'PASS', {
        rootServiceScopes: [...new Set(projectScope.results.map(row => row.scope_project_id))].sort(),
        engineProjectScope: [...new Set(projectScopeEngine.body.results.map(row => row.scope_project_id))],
        engineDomainScope: [...new Set(domainScopeEngine.body.results.map(row => row.scope_project_id))].sort(),
        engineBrainScope: [...new Set(brainScopeEngine.body.results.map(row => row.scope_project_id))].sort(),
        unknownProjectStatus: unknownEngine.status,
        vectorStubRequests: vector.requests.length,
      });
    }

    // --------------------------------------------------------------- RET-004
    {
      // A real promoted run: the engine analyses the real commit SHA and the
      // promoted file keeps that SHA as its source.
      const run = engine.coordinator.enqueue({ projectId: 'project-a', commitSha: repoA.head });
      const promoted = await fixture.eventually(() => engine.store.getRun(run.runId) && ['succeeded', 'failed', 'index-pending'].includes(engine.store.getRun(run.runId).state));
      assert.equal(promoted, true, 'the run must reach a terminal state');
      const finished = engine.store.getRun(run.runId);
      assert.equal(finished.state, 'succeeded', `run failed: ${JSON.stringify(finished.error)}`);
      const promotedFile = path.join(knowledgeA, `changes/${repoA.head.slice(0, 12)}.md`);
      assert.ok(fs.existsSync(promotedFile), 'the promoted Markdown must exist on disk');
      const promotedText = fs.readFileSync(promotedFile, 'utf8');
      assert.ok(promotedText.includes(repoA.head), 'the promoted body must carry the real commit SHA');

      const search = await call('/api/search', { projectId: 'project-a', query: repoA.head.slice(0, 12) });
      assert.equal(search.status, 200);
      const hit = search.body.results.find(row => row.entry_id === `changes/${repoA.head.slice(0, 12)}.md`);
      assert.ok(hit, 'the promoted entry must be retrievable');
      assert.equal(hit.commitSha, repoA.head, 'the citation must carry the full commit source of the current result');
      assert.equal(hit.path, `changes/${repoA.head.slice(0, 12)}.md`, 'the citation path must be relative to the project knowledge root');

      const read = await call('/api/get', { projectId: 'project-a', entryId: hit.entry_id });
      assert.equal(read.status, 200);
      assert.ok(read.body.chunks[0].chunk_text.includes(repoA.head), 'reading the citation must return the real body');
      const outside = await call('/api/get', { projectId: 'project-a', entryId: '../outside.md' });
      assert.equal(outside.status, 403, 'path traversal must be refused');
      assert.equal(outside.body.error, 'PATH_OUTSIDE_ROOT', 'the real engine reports the failure code as a string');

      // The product's own client must reach the same real engine.
      const client = new EngineKnowledgeClient({ layout, engineUrl });
      const viaClient = await client.request('get', { entry: hit.entry_id }, { projectId: 'project-a', repoPath: repoA.repoPath, knowledgePath: knowledgeA });
      assert.ok(viaClient.chunks[0].chunk_text.includes(repoA.head));
      await assert.rejects(client.request('get', { entry: '../outside.md' }, { projectId: 'project-a', repoPath: repoA.repoPath, knowledgePath: knowledgeA }), error => error.code === 'PATH_OUTSIDE_ROOT' && !error.message.includes(repoA.head));
      await assert.rejects(client.request('search', { query: 'x', scope: 'global' }, { projectId: 'project-a', repoPath: repoA.repoPath, knowledgePath: knowledgeA }), error => error.code === 'INVALID_ARGUMENT');
      record('RET-004', 'PASS', {
        promotedEntry: hit.entry_id,
        commitSha: hit.commitSha,
        documentHash: hit.document_hash,
        traversalStatus: outside.status,
        traversalCode: outside.body.error.code,
        analyzerStubRuns: analyzerEvents.length,
      });
    }

    // --------------------------------------------------------------- RET-005
    {
      // The embedding channel is switched off: no embedder, then a failing
      // embedder. The Markdown truth must still answer, and nothing may claim
      // a vector success or delete knowledge.
      const before = fixture.hashTree(knowledgeA);
      fs.mkdirSync(layout.getIndexPath(), { recursive: true });
      const disabled = new KnowledgeRetrievalService({ layout, registryStore: registry, projectStore: projects, embedderProvider: () => null });
      const disabledResponse = await disabled.search({ projectId: 'project-a', query: 'RET001TOKEN' });
      assert.equal(disabledResponse.backend, 'markdown-hybrid-fallback');
      assert.equal(disabledResponse.health.index, 'unavailable');
      assert.ok(disabledResponse.results.length >= 1, 'Markdown truth must stay visible when the embedding channel is off');
      assert.ok(disabledResponse.results.every(row => !row.match_channels.includes('index:vector-hub')), 'no result may claim a vector channel');

      const failing = new KnowledgeRetrievalService({
        layout,
        registryStore: registry,
        projectStore: projects,
        // Row-less index: the database refuses every query, so no vector row
        // can ever reach a result. The only observable effect is the
        // degradation path of the Markdown truth reader.
        databaseProvider: () => ({ async hybridSearch() { throw new Error('index offline'); } }),
        embedderProvider: () => ({ async embedQuery() { throw new Error('embedding disabled'); } }),
      });
      const failingResponse = await failing.search({ projectId: 'project-a', query: 'RET001TOKEN' });
      assert.equal(failingResponse.health.index, 'degraded');
      assert.equal(failingResponse.health.reason, 'index-query-failed');
      assert.equal(failingResponse.backend, 'markdown-hybrid-fallback');
      assert.ok(failingResponse.results.length >= 1, 'a degraded index must still expose the Markdown truth');
      assert.ok(failingResponse.results.every(row => !row.match_channels.includes('index:vector-hub')));
      assert.deepEqual(fixture.hashTree(knowledgeA), before, 'a disabled embedding channel must not delete or rewrite knowledge');
      record('RET-005', 'PASS', {
        disabledBackend: disabledResponse.backend,
        disabledHealth: disabledResponse.health.index,
        degradedHealth: failingResponse.health.index,
        degradedReason: failingResponse.health.reason,
        knowledgeFilesUnchanged: true,
        resultCount: failingResponse.results.length,
      });
    }

    const summary = { lane: 'test-knowledge', file: 'parallel-knowledge-retrieval-test.js', cases: results, vectorChannel: 'stubbed-empty-results (not vector evidence)' };
    const target = process.env.PARALLEL_KNOWLEDGE_EVIDENCE;
    if (target) fs.mkdirSync(path.dirname(target), { recursive: true });
    if (target) fs.writeFileSync(target, JSON.stringify(summary, null, 2), 'utf8');
    console.log('parallel-knowledge-retrieval-test PASS');
  } finally {
    await engine.close();
    await vector.close();
    fixture.removeTree(root);
    fixture.cleanupIsolatedProcess();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
