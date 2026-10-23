'use strict';
// Offline regression for the RET-007 attribution contract.
//
// What is locked here: a promoted knowledge entry must carry the FULL commit
// SHA and the project it belongs to, a later session must retrieve that entry
// by a semantic query that contains NO identifier, and an unrelated hex query
// must not reach the entry through the exact-commit channel.
//
// What is NOT claimed here: the analyzer is a DECLARED STUB (no model is
// called) and the vector endpoint is a DECLARED STUB that returns no rows, so
// this file says nothing about model behaviour or about vector recall. The
// real-model chain and the real index live in
// qa-autopilot/tools/product-probes/parallel-retrieval-followup-ret007.js,
// which is deliberately outside the offline CI.
//
// Everything runs in isolation: own data directory, own knowledge root, own
// temporary repository, own HTTP ports, no ambient module address, no real
// HOME.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');

const shell = require('./helpers/parallel-retrieval-followup-shell');
// Isolate before any product module is loaded.
shell.isolateProcess();

const { createEngineServer } = require('../../_modules/knowledge-engine/src/server');
const AtomicFile = require('../../_modules/knowledge-engine/src/runtime/atomic-file');

const TOKEN = 'RET007OFFLINE';
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
      requests.push({ url: req.url, method: req.method });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, results: [], errors: [], projects: [] }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    requests,
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); },
  };
}

function forbiddenBridge() {
  const guard = name => async () => { throw new Error(`event bridge must not be contacted from the test lane (${name})`); };
  return {
    registerConsumer: guard('registerConsumer'),
    listJournals: guard('listJournals'),
    readEvents: guard('readEvents'),
    ackConsumerCursor: guard('ackConsumerCursor'),
    close() {},
  };
}

// Declared stub analyzer: stages one Markdown file plus a manifest that
// carries the four required evidence references, exactly like the real
// analyzer's contract. It never contacts a model.
function stubAnalyzer(events = []) {
  return {
    sourceReadMode: 'isolated-frozen-evidence',
    async runClaim(input) {
      events.push({ kind: 'start', projectId: input.projectId, sha: input.claim.commitSha });
      const relative = `changes/${input.claim.commitSha.slice(0, 12)}.md`;
      const content = `# 离线归属条目\n\n${TOKEN} 事实：重试上限调整为 7 次，提交 ${input.claim.commitSha}。\n`;
      AtomicFile.writeFileAtomic(path.join(input.stagingPath, 'files', ...relative.split('/')), content);
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
          evidenceReferences: [
            `commit:${input.claim.commitSha}`,
            `patch:${input.claim.patchHash}`,
            `conversation:${input.claim.conversationSnapshotHash}`,
            `retrieval:${input.claim.retrievalManifestHash}`,
          ],
        }],
      });
      events.push({ kind: 'finish', projectId: input.projectId, sha: input.claim.commitSha });
      return { ok: true };
    },
  };
}

async function startEngine({ dataDir, vectorUrl, analyzer }) {
  fs.mkdirSync(dataDir, { recursive: true });
  const runtime = createEngineServer({ dataDir, vectorUrl, bridge: forbiddenBridge(), analyzer });
  await runtime.ready;
  await new Promise(resolve => runtime.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${runtime.server.address().port}`;
  return {
    ...runtime,
    base,
    async call(route, body) {
      const response = await fetch(`${base}${route}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() };
    },
  };
}

(async () => {
  const root = shell.makeTempDir('parallel-retrieval-followup-citation');
  const vector = await stubVectorServer();
  const analyzerEvents = [];
  let engine = null;
  try {
    const repo = shell.makeRepo(root, 'repo-citation', [
      { message: '初始提交', files: { 'README.md': '# citation\n' } },
      { message: '事实提交', files: { 'note.txt': `${TOKEN} 重试上限调整为 7 次。\n` } },
    ]);
    const knowledgePath = shell.makeKnowledgeDir(root, 'knowledge-citation');
    engine = await startEngine({
      dataDir: path.join(root, 'engine-citation'),
      vectorUrl: vector.url,
      analyzer: stubAnalyzer(analyzerEvents),
    });
    const registration = await engine.call('/api/projects', {
      projectId: 'project-citation',
      name: 'citation',
      repoPath: repo.repoPath,
      knowledgePath,
      brainId: 'brain-default',
      domainId: 'domain-tools',
    });
    assert.equal(registration.status, 200, `the project registration failed: ${JSON.stringify(registration.body)}`);

    const run = engine.coordinator.enqueue({ projectId: 'project-citation', commitSha: repo.head });
    const settled = await shell.eventually(() => ['succeeded', 'failed'].includes(engine.store.getRun(run.runId).state), 20000);
    assert.equal(settled, true, 'the run must reach a terminal state');
    const finished = engine.store.getRun(run.runId);
    assert.equal(finished.state, 'succeeded', `the promotion failed: ${JSON.stringify(finished.error)}`);

    const commitSha = repo.head;
    const entryRelative = `changes/${commitSha.slice(0, 12)}.md`;
    const promoted = fs.readFileSync(path.join(knowledgePath, ...entryRelative.split('/')), 'utf8');
    assert.ok(promoted.includes(TOKEN), 'the promoted body must carry the planted fact');
    assert.ok(promoted.includes(commitSha), 'the promoted body must carry the full commit SHA');

    // A later session asks with a semantic query that contains no identifier.
    const semanticQuery = `${TOKEN} 重试上限调整为几次`;
    assert.ok(!/[0-9a-f]{7}/i.test(semanticQuery), 'the semantic query must not contain a hex identifier');

    const search = await engine.coordinator.retrieval.search({ query: semanticQuery, projectId: 'project-citation', client: 'workbench', sessionId: 'offline-session' });
    const rows = search.results || [];
    const hit = rows.find(row => row.commitSha === commitSha);
    assert.ok(hit, `the promoted entry must be retrieved with its full SHA; rows: ${JSON.stringify(rows.map(row => ({ entry: row.entry_id, sha: row.commitSha, channels: row.match_channels })))}`);
    assert.equal(hit.projectId, 'project-citation', 'the retrieved entry must keep its project');
    assert.ok(String(hit.chunk_text || hit.snippet || '').includes(TOKEN), 'the retrieved entry must carry the planted body');
    assert.ok(!(hit.match_channels || []).includes('exact-commit'), 'a semantic query must not reach the entry through the exact-commit channel');

    const asked = await engine.coordinator.retrieval.ask({ query: semanticQuery, projectId: 'project-citation' });
    const citation = (asked.citations || []).find(entry => entry.commitSha === commitSha);
    assert.ok(citation, 'the answer must cite the promoted entry with its full SHA');
    assert.equal(citation.projectId, 'project-citation', 'the citation must keep its project');
    assert.ok(String(citation.text || '').includes(TOKEN), 'the citation must carry the planted body');

    // Control: an unrelated hex query must not reach the entry.
    const controlQuery = 'deadbeefcafe';
    const control = await engine.coordinator.retrieval.search({ query: controlQuery, projectId: 'project-citation', client: 'workbench', sessionId: 'offline-session' });
    const controlHit = (control.results || []).find(row => row.commitSha === commitSha);
    assert.equal(controlHit, undefined, 'an unrelated hex query must not return the promoted entry');
    assert.equal((control.results || []).some(row => (row.match_channels || []).includes('exact-commit')), false, 'an unrelated hex query must not use the exact-commit channel');

    record('RET-007-CITE', 'PASS', {
      commitSha,
      entryRelative,
      retrievedRows: rows.length,
      hitEntryId: hit.entry_id,
      hitChannels: hit.match_channels,
      citationEntryId: citation.entryId,
      controlRows: (control.results || []).length,
      analyzer: 'declared stub analyzer (no model call)',
      vector: 'declared stub returning no rows',
    });

    const summary = {
      lane: 'parallel-retrieval-followup',
      file: 'parallel-retrieval-followup-citation-test.js',
      cases: results,
      model: 'declared stub analyzer (no model call)',
      vector: 'declared stub returning no rows',
    };
    const target = process.env.PARALLEL_RETRIEVAL_EVIDENCE;
    if (target) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, JSON.stringify(summary, null, 2), 'utf8');
    }
    console.log('parallel-retrieval-followup-citation-test PASS');
  } finally {
    if (engine) await engine.close();
    await vector.close();
    shell.removeTree(root);
    shell.cleanupIsolatedProcess();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
