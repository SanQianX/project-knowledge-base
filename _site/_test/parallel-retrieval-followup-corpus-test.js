'use strict';
// Offline regression for the RET-008 harness contract.
//
// This file locks the pieces of the RET-008 comparison that do NOT need a
// model and do NOT need the vector-hub source checkout:
//
//   1) the fixed corpus and the human-labelled ground truth stay consistent
//      (unique ids, every relevant document exists, no query carries a hex
//      identifier, no query is a verbatim copy of a document sentence);
//   2) the ranking and latency helpers compute what the report claims;
//   3) the engine and the PINNED vector-hub package agree on the body hash,
//      which is the precondition the engine needs before it may merge a
//      vector-hub chunk row into a retrieved fact;
//   4) the PINNED package still has the identity the comparison was made
//      against, and its query cache still BEHAVES the way the comparison
//      assumed: an identical query is served from the cache, a failed query
//      is evicted, and a late failure of an evicted owner cannot destroy the
//      replacement cached for the same text. The behaviour is observed
//      through the public API with deterministic counts; the source text of
//      the pinned build is never matched.
//
// What is NOT claimed here: the embedder is a DECLARED STUB (a deterministic
// character-gram hashing vector, NOT a neural model), so this file says
// nothing about retrieval quality or recall. The real-model measurement
// (Xenova/bge-small-zh-v1.5) and the baseline/candidate comparison live in
// qa-autopilot/tools/product-probes/parallel-retrieval-followup-ret008.js,
// which is deliberately outside the offline CI.
//
// Everything runs in isolation: own temp root, own hub root, own ports, no
// ambient module address, no real HOME, no network.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const shell = require('./helpers/parallel-retrieval-followup-shell');
// Isolate before any product module is loaded.
shell.isolateProcess();

const corpusDefinitions = require('./helpers/parallel-retrieval-followup-corpus');
const ranking = require('../../_modules/knowledge-engine/src/retrieval-ranking');

const HUB_DIST = path.join(shell.REPO_ROOT, 'node_modules', '@sanqianx', 'vector-hub', 'dist', 'cjs');
const DIMENSIONS = 512;
const results = [];

function record(caseId, status, detail) {
  results.push({ caseId, status, detail });
  console.log(`CASE ${caseId} ${status} ${JSON.stringify(detail)}`);
}

// DECLARED STUB embedder: a deterministic character-gram hashing vector.
// It is not a model and makes no claim about semantic quality; it only gives
// the hub real numbers to store and compare. The counters separate the
// document embeddings (a batch) from the query embeddings (a single string),
// because the query cache is only observable on the single-string path.
function stubEmbedder() {
  const state = { batchCalls: 0, singleCalls: 0, failNext: false, deferFor: null, pending: [] };
  const vector = text => {
    const out = new Array(DIMENSIONS).fill(0);
    const source = String(text || '').toLowerCase();
    for (let i = 0; i < source.length; i += 1) {
      const gram = source.slice(i, i + 2);
      const slot = crypto.createHash('sha256').update(gram).digest();
      const index = slot.readUInt16BE(0) % DIMENSIONS;
      out[index] += 1 + (slot[2] / 255);
    }
    const norm = Math.sqrt(out.reduce((sum, value) => sum + value * value, 0)) || 1;
    return out.map(value => value / norm);
  };
  state.vector = vector;
  const embedder = {
    kind: 'declared-stub-hashing-embedder',
    model: 'stub-hashing-embedder',
    modelId: 'stub-hashing-embedder',
    maxTokens: 500,
    async createEmbeddings(inputs) {
      if (Array.isArray(inputs)) {
        state.batchCalls += 1;
        return { status: 'success', output: inputs.map(vector) };
      }
      state.singleCalls += 1;
      if (state.failNext) {
        state.failNext = false;
        return { status: 'failure', output: [] };
      }
      if (state.deferFor && state.deferFor(String(inputs))) {
        return new Promise((resolve, reject) => { state.pending.push({ text: String(inputs), resolve, reject }); });
      }
      return { status: 'success', output: [vector(inputs)] };
    },
  };
  return { embedder, state };
}

async function waitUntil(predicate, timeoutMs = 5000, intervalMs = 20) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  return false;
}

(async () => {
  const root = shell.makeTempDir('parallel-retrieval-followup-corpus');
  try {
    // ------------------------------------------------------- definitions
    const ids = corpusDefinitions.CORPUS.map(doc => doc.id);
    assert.equal(new Set(ids).size, ids.length, 'every corpus id must be unique');
    const files = corpusDefinitions.CORPUS.map(doc => doc.file);
    assert.equal(new Set(files).size, files.length, 'every corpus file name must be unique');
    for (const doc of corpusDefinitions.CORPUS) {
      assert.ok(doc.content.trim().length > 0, `the corpus document ${doc.id} must not be empty`);
    }
    assert.ok(corpusDefinitions.QUERIES.length >= 5, 'the query set must be usable');
    for (const definition of corpusDefinitions.QUERIES) {
      assert.ok(definition.relevant.length > 0, `the query ${definition.id} must name at least one relevant document`);
      for (const relevant of definition.relevant) {
        assert.ok(ids.includes(relevant), `the query ${definition.id} names the unknown document ${relevant}`);
      }
      assert.ok(!/[0-9a-f]{7}/i.test(definition.query), `the query ${definition.id} must not carry a hex identifier`);
      for (const doc of corpusDefinitions.CORPUS) {
        assert.ok(!doc.content.includes(definition.query), `the query ${definition.id} is copied verbatim from ${doc.id}`);
      }
    }
    record('RET-008-DEFINITIONS', 'PASS', {
      documents: corpusDefinitions.CORPUS.length,
      queries: corpusDefinitions.QUERIES.length,
      multiRelevantQueries: corpusDefinitions.QUERIES.filter(definition => definition.relevant.length > 1).map(definition => definition.id),
    });

    // ------------------------------------------------------------ helpers
    const ranked = corpusDefinitions.evaluateRanking(['b', 'a', 'c'], ['a', 'c']);
    assert.equal(ranked.firstRelevantRank, 2, 'the first relevant rank must be reported');
    assert.equal(ranked.reciprocalRank, 0.5, 'the reciprocal rank must be 1/2');
    assert.equal(ranked.recallAt1, 0, 'nothing relevant is in the top 1');
    assert.equal(ranked.recallAt5, 1, 'both relevant documents are within the top 5');
    const empty = corpusDefinitions.evaluateRanking(['x'], ['a']);
    assert.equal(empty.hit, false, 'a query without any relevant document must not count as a hit');
    assert.equal(empty.reciprocalRank, 0, 'a query without any relevant document has no reciprocal rank');
    const latency = corpusDefinitions.summariseLatency([10, 20, 30, 40, 100]);
    assert.equal(latency.count, 5, 'every finite sample must be counted');
    assert.equal(latency.min, 10, 'the minimum must be reported');
    assert.equal(latency.max, 100, 'the maximum must be reported');
    assert.equal(latency.p50, 30, 'the median must be reported');
    assert.equal(corpusDefinitions.summariseLatency([]).p50, null, 'an empty sample has no percentile');
    record('RET-008-METRICS', 'PASS', { ranked, latency });

    // -------------------------------------------- engine/hub body hash
    const corpusDir = path.join(root, 'corpus');
    const corpusIndex = corpusDefinitions.materialiseCorpus(corpusDir);
    assert.equal(fs.readdirSync(corpusDir).length, corpusDefinitions.CORPUS.length, 'every corpus document must be written');
    assert.equal(corpusIndex.idForFile('quota-sampling.md'), 'quota-sampling', 'a result file must map back to its corpus id');
    assert.equal(corpusIndex.idForFile('missing.md'), null, 'an unknown file must not map to a corpus id');

    const { VectorHub } = require(path.join(HUB_DIST, 'core', 'hub.js'));
    const hub = new VectorHub({ rootPath: path.join(root, 'hub') });
    const corpusEmbedder = stubEmbedder();
    hub.setEmbeddings(corpusEmbedder.embedder);
    const tracked = await hub.syncFolder('ret008-offline', corpusDir);
    assert.equal(tracked, corpusDefinitions.CORPUS.length, 'every corpus document must reach the index');

    const response = await hub.search(corpusDefinitions.QUERIES[0].query, { maxResults: 10, resultLevel: 'chunk' });
    assert.ok(response.results.length > 0, 'the chunk search must return rows');
    const expectedHashes = new Map();
    for (const doc of corpusDefinitions.CORPUS) {
      const content = fs.readFileSync(path.join(corpusDir, doc.file), 'utf8');
      expectedHashes.set(doc.file, ranking.bodyHash(content));
    }
    let checked = 0;
    for (const row of response.results) {
      const expected = expectedHashes.get(row.file);
      assert.ok(expected, `the search returned an unknown document ${row.file}`);
      assert.equal(row.bodyHash, expected, `the engine and the pinned hub must agree on the body hash of ${row.file}`);
      assert.equal(row.scoreType, 'cosine', 'a chunk row must carry the cosine score type');
      assert.ok(Number.isInteger(row.startPos) && Number.isInteger(row.endPos), 'a chunk row must carry integer positions');
      checked += 1;
    }
    record('RET-008-BODY-HASH', 'PASS', { tracked, rowsChecked: checked, distinctFiles: new Set(response.results.map(row => row.file)).size });

    // The pinned dependency must still be the one the RET-008 comparison was
    // made against. A dependency change has to re-run the explicit probe.
    // Only the PACKAGE IDENTITY is asserted here: the source text of the
    // pinned build is never matched, because a string match against the
    // implementation is not a behaviour.
    const pinnedPackage = path.join(shell.REPO_ROOT, 'node_modules', '@sanqianx', 'vector-hub');
    const pinnedManifest = JSON.parse(fs.readFileSync(path.join(pinnedPackage, 'package.json'), 'utf8'));
    assert.equal(pinnedManifest.name, '@sanqianx/vector-hub', 'the pinned package identity changed');
    assert.equal(
      pinnedManifest.version,
      '1.0.8-rc.8',
      `the pinned @sanqianx/vector-hub is ${pinnedManifest.version} instead of 1.0.8-rc.8; re-run qa-autopilot/tools/product-probes/parallel-retrieval-followup-ret008.js`,
    );
    record('RET-008-PINNED-PACKAGE', 'PASS', { pinnedName: pinnedManifest.name, pinnedVersion: pinnedManifest.version });

    // ---- real query-cache behaviour of the pinned package -----------------
    // The RET-008 comparison assumed that the pinned hub caches the query
    // embedding and that a late failure of an evicted owner cannot destroy
    // the replacement cached for the same text. Both are checked here through
    // the public API with DETERMINISTIC COUNTS. The embedder is the DECLARED
    // STUB, so this case says nothing about neural semantic quality; it only
    // says that the cache still behaves the way the comparison assumed.
    const cacheEmbedder = stubEmbedder();
    const cacheHub = new VectorHub({ rootPath: path.join(root, 'hub-cache') });
    cacheHub.setEmbeddings(cacheEmbedder.embedder);
    const cacheTracked = await cacheHub.syncFolder('ret008-cache', corpusDir);
    assert.equal(cacheTracked, corpusDefinitions.CORPUS.length, 'every corpus document must reach the cache index');
    const search = text => cacheHub.search(text, { maxResults: 10, resultLevel: 'chunk' });

    const queryA = corpusDefinitions.QUERIES[0].query;
    const queryB = corpusDefinitions.QUERIES[1].query;
    const beforeFirst = cacheEmbedder.state.singleCalls;
    await search(queryA);
    const afterFirst = cacheEmbedder.state.singleCalls;
    assert.ok(afterFirst > beforeFirst, 'the first query must be embedded');
    await search(queryA);
    const afterRepeated = cacheEmbedder.state.singleCalls;
    assert.equal(afterRepeated, afterFirst, 'the identical query must be served from the query cache');
    const beforeSecond = cacheEmbedder.state.singleCalls;
    await search(queryB);
    const afterDifferent = cacheEmbedder.state.singleCalls;
    assert.ok(afterDifferent > beforeSecond, 'a different query must be embedded again');
    record('RET-008-QUERY-CACHE-HIT', 'PASS', {
      firstQueryEmbeddings: afterFirst - beforeFirst,
      repeatedQueryEmbeddings: afterRepeated - afterFirst,
      differentQueryEmbeddings: afterDifferent - beforeSecond,
      documentEmbeddings: cacheEmbedder.state.batchCalls,
    });

    // A failed query must not survive in the cache.
    const queryFail = `${queryB} 失败用例`;
    cacheEmbedder.state.failNext = true;
    await search(queryFail).catch(() => {});
    const afterFailed = cacheEmbedder.state.singleCalls;
    await search(queryFail).catch(() => {});
    assert.ok(cacheEmbedder.state.singleCalls > afterFailed, 'a failed query must not stay cached');
    record('RET-008-QUERY-CACHE-FAILURE-EVICTION', 'PASS', {
      embeddingsAfterFailedQuery: afterFailed,
      embeddingsAfterRetry: cacheEmbedder.state.singleCalls,
    });

    // The ownership guard: a late failure of an evicted owner must not
    // destroy the replacement that was cached for the same text.
    const ownerQuery = '归属校验用的查询文本';
    cacheEmbedder.state.deferFor = text => text === ownerQuery;
    const firstOwner = search(ownerQuery).catch(() => null);
    assert.ok(await waitUntil(() => cacheEmbedder.state.pending.length === 1), 'the first owner was never created');
    // The hub keeps 100 cached queries; 100 distinct queries evict the
    // oldest one, which is the entry of the first owner.
    for (let index = 0; index < 100; index += 1) await search(`驱逐查询 ${index}`);
    const replacement = search(ownerQuery).catch(() => null);
    assert.ok(await waitUntil(() => cacheEmbedder.state.pending.length === 2), 'the replacement owner was never created');
    // The evicted owner now fails late. It must not delete the replacement.
    cacheEmbedder.state.pending[0].reject(new Error('late failure of the evicted owner'));
    await firstOwner;
    const beforeThird = cacheEmbedder.state.singleCalls;
    const thirdSearch = search(ownerQuery);
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(cacheEmbedder.state.pending.length, 2, 'the replacement must still be cached: no new query embedding was created');
    assert.equal(cacheEmbedder.state.singleCalls, beforeThird, 'the replacement must still be cached: the embedder was called again');
    cacheEmbedder.state.pending[1].resolve({ status: 'success', output: [cacheEmbedder.state.vector(ownerQuery)] });
    const thirdResult = await thirdSearch;
    cacheEmbedder.state.deferFor = null;
    record('RET-008-QUERY-CACHE-OWNERSHIP', 'PASS', {
      evictingQueries: 100,
      embedderCallsAfterLateFailure: cacheEmbedder.state.singleCalls - beforeThird,
      replacementRows: Array.isArray(thirdResult && thirdResult.results) ? thirdResult.results.length : null,
    });

    const summary = {
      lane: 'parallel-retrieval-followup',
      file: 'parallel-retrieval-followup-corpus-test.js',
      cases: results,
      model: 'declared stub embedder (no model call)',
    };
    const target = process.env.PARALLEL_RETRIEVAL_EVIDENCE;
    if (target) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, JSON.stringify(summary, null, 2), 'utf8');
    }
    console.log('parallel-retrieval-followup-corpus-test PASS');
  } finally {
    shell.removeTree(root);
    shell.cleanupIsolatedProcess();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
