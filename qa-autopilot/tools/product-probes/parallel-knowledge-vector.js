'use strict';
// Environment-dependent acceptance probe for the real vector channel.
//
// This file is NOT a regression test. It is deliberately kept out of
// _site/_test/ so the offline regression runner never collects it, because
// its verdict depends on the machine: it needs a real, authorised embedding
// model to produce a real non-empty vector and to drive the real index.
//
// Invoke it explicitly:
//   node qa-autopilot/tools/product-probes/parallel-knowledge-vector.js
//   node qa-autopilot/tools/product-probes/parallel-knowledge-vector.js --evidence <path>
//
// Exit codes:
//   0  every sub-item below was verified with a real embedder and a real
//      vector index (PASS)
//   3  at least one sub-item could not be verified (BLOCKED / PARTIAL)
//   1  the probe itself failed
//
// The sub-items are deliberately separate from the case conclusions. Producing
// a real vector is NOT the same as proving the real retrieval channel, and
// neither is the same as proving that a new index root can be rebuilt:
//
//   S1-embedding-obtained          a real non-empty vector of the expected
//                                   dimension was produced by the product's
//                                   own embedding service
//   S2-real-channel-upsert-search  the real vector hub stored a document
//                                   with that vector and returned it again
//                                   through a real semantic query
//   S3-new-root-rebuild-and-search after a real index-root switch, the new
//                                   root was really rebuilt (a real vector
//                                   index was written into it) and searched
//   S4-old-root-retained           the old root kept its data byte-for-byte
//
//   RET-002 (真实向量) needs S1 + S2.
//   RET-006 (索引根切换) needs S3 + S4 from this probe; its deterministic
//   sub-items a-d are covered by the canonical entry point
//   _site/_test/parallel-knowledge-vector-test.js.
//
// A missing embedding model therefore never turns into a PASS: it leaves the
// affected sub-items BLOCKED, the case verdict BLOCKED and the exit code
// non-zero.
//
// Policy honoured by this probe:
//   * it never calls a paid embedding provider and never sets an API key;
//   * it never uses the shipped mock embedding provider, and this file
//     contains no stand-in embedder at all: only the product's own
//     LocalEmbeddingService can produce evidence here;
//   * it never downloads a model automatically. A model that is already on
//     disk is used offline (KB_EMBEDDING_LOCAL_PATH, or the probe's own
//     model cache under the lane temp root). A remote model load happens only
//     when the operator sets PK_VECTOR_PROBE_ALLOW_DOWNLOAD=1, or when an
//     explicit local mirror is configured through KB_EMBEDDING_REMOTE_HOST;
//   * it never touches the live 5757/5790/8787/8790 endpoints or the real
//     HOME.
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const fixture = require(path.join(REPO_ROOT, '_site', '_test', 'helpers', 'parallel-knowledge-fixture'));
// Isolate before any product module loads.
fixture.isolateProcess();

const { LocalEmbeddingService, DEFAULT_MODEL_ID } = require(path.join(REPO_ROOT, '_site', 'lib', 'embedding-service'));
const { EMBEDDING_DIMENSIONS } = require(path.join(REPO_ROOT, '_site', 'lib', 'knowledge-schema'));
const HUB_DIST = path.join(REPO_ROOT, 'node_modules', '@sanqianx', 'vector-hub', 'dist', 'cjs');

const QUERY = '配额采样为什么要串行执行';
const PASSAGE = '配额采样改为串行执行，避免并发请求打满额度上限。';
const OLD_PASSAGE = '旧索引根中的历史记录：首轮验收基线建立于五月。';
const NEW_PASSAGE = '根切换之后向量索引被重新生成；配额采样依旧串行执行，避免打满额度上限。';

const SUB_ITEM_IDS = {
  embedding: 'S1-embedding-obtained',
  channel: 'S2-real-channel-upsert-search',
  rebuild: 'S3-new-root-rebuild-and-search',
  retained: 'S4-old-root-retained',
};

const DOWNLOAD_ALLOWED = process.env.PK_VECTOR_PROBE_ALLOW_DOWNLOAD === '1';

function describe(error) {
  return String((error && (error.message || error)) || 'unknown error').slice(0, 400);
}

function sameTree(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// The product's own embedding service, wrapped in the interface the real
// vector hub expects. This is the ONLY embedder this probe accepts as
// evidence: the kind marker is checked again when the case verdicts are
// computed, so no other implementation can turn a sub-item green.
function createProductEmbedder(service) {
  const state = { calls: 0, dimensions: [], nonZeroVectors: 0 };
  return {
    kind: 'product-local-embedding-service',
    model: service.modelId,
    modelId: service.modelId,
    maxTokens: 500,
    state,
    async createEmbeddings(inputs) {
      const isBatch = Array.isArray(inputs);
      const texts = isBatch ? inputs : [inputs];
      const output = [];
      for (const text of texts) {
        // A document batch is embedded as a passage, a single query string
        // as a query, exactly like the product's retrieval service does.
        const vector = isBatch ? await service.embedPassage(text) : await service.embedQuery(text);
        state.calls += 1;
        state.dimensions.push(vector.length);
        if (vector.some(value => value !== 0)) state.nonZeroVectors += 1;
        output.push(vector);
      }
      return { status: 'success', output };
    },
  };
}

// The real vector index on disk: the stored vectors must be real, of the
// expected dimension and not all zero. A lexical or mocked result cannot
// produce such an index.
function inspectStoredVectors(projectDir) {
  const indexFile = path.join(projectDir, 'index.json');
  if (!fs.existsSync(indexFile)) {
    return {
      inspected: false,
      reason: 'no index.json in the project folder',
      files: fs.existsSync(projectDir) ? fs.readdirSync(projectDir) : [],
    };
  }
  const raw = fs.readFileSync(indexFile, 'utf8');
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch { parsed = null; }
  if (!parsed || !Array.isArray(parsed.items)) {
    return { inspected: false, reason: 'index.json is not a readable JSON index', bytes: raw.length };
  }
  const vectors = parsed.items.map(item => item && item.vector).filter(Array.isArray);
  const dimensions = [...new Set(vectors.map(vector => vector.length))];
  return {
    inspected: true,
    bytes: raw.length,
    itemCount: parsed.items.length,
    vectorCount: vectors.length,
    dimensions,
    expectedDimensions: EMBEDDING_DIMENSIONS,
    dimensionsMatch: dimensions.length === 1 && dimensions[0] === EMBEDDING_DIMENSIONS,
    allVectorsNonZero: vectors.length > 0 && vectors.every(vector => vector.some(value => value !== 0)),
  };
}

// S2: the real hub, the real embedder, a real upsert and a real semantic
// query against the index that was just written.
async function runChannelStep({ root, embedder }) {
  const { VectorHub } = require(path.join(HUB_DIST, 'core', 'hub.js'));
  const channelRoot = path.join(root, 'channel-root');
  const hub = new VectorHub({ rootPath: channelRoot });
  hub.setEmbeddings(embedder);
  await hub.upsertDocument({ project: 'demo', uri: 'note.md', text: PASSAGE });
  const response = await hub.search(QUERY, { maxResults: 5, resultLevel: 'chunk' });
  const top = response.results[0];
  return {
    channelRoot,
    resultCount: response.results.length,
    topUri: top && top.uri,
    topScore: top && top.score,
    scoreType: top && top.scoreType,
    projectsSearched: response.projectsSearched,
    errors: response.errors,
    storedVectors: inspectStoredVectors(path.join(channelRoot, 'demo')),
    embedderCalls: embedder.state.calls,
  };
}

// S3 + S4: a real index-root switch through the real HubManager, then a
// real rebuild of the new root and a real search in it, while the old root
// keeps its data.
async function runRootSwitchSteps({ root, embedder }) {
  const { HubManager } = require(path.join(HUB_DIST, 'server', 'manager.js'));
  const oldRoot = path.join(root, 'switch-old');
  const newRoot = path.join(root, 'switch-new');
  const configPath = path.join(root, 'switch', 'config.json');
  fs.mkdirSync(oldRoot, { recursive: true });
  fs.mkdirSync(path.dirname(configPath), { recursive: true });

  const manager = await HubManager.load({ rootPath: oldRoot, configPath, managed: true });
  manager.hub.setEmbeddings(embedder);
  // Real data in the old root, so that its retention can be checked.
  await manager.hub.upsertDocument({ project: 'demo', uri: 'old.md', text: OLD_PASSAGE });
  const oldHashBefore = fixture.hashTree(oldRoot);

  // The real switch: the manager drains its writers and moves the root.
  await manager.applyRuntimeSettings(null, newRoot);
  const switchedRoot = path.resolve(manager.hub.rootPath);

  // The rebuild into the new root, with the real embedder.
  manager.hub.setEmbeddings(embedder);
  await manager.hub.upsertDocument({ project: 'demo', uri: 'new.md', text: NEW_PASSAGE });
  const rebuilt = await manager.hub.search(QUERY, { maxResults: 5, resultLevel: 'chunk' });
  const top = rebuilt.results[0];
  const oldHashAfter = fixture.hashTree(oldRoot);

  return {
    oldRoot,
    newRoot,
    switchedRoot,
    rootMoved: switchedRoot === path.resolve(newRoot),
    rebuildResultCount: rebuilt.results.length,
    rebuildTopUri: top && top.uri,
    rebuildTopScore: top && top.score,
    rebuildScoreType: top && top.scoreType,
    rebuildErrors: rebuilt.errors,
    storedVectors: inspectStoredVectors(path.join(newRoot, 'demo')),
    oldRootRetained: sameTree(oldHashBefore, oldHashAfter),
    oldRootStillExists: fs.existsSync(oldRoot),
    oldRootFileCount: Object.keys(oldHashAfter).length,
    embedderCalls: embedder.state.calls,
  };
}

function evaluateSubItems({ subItems, embedderKind }) {
  const real = embedderKind === 'product-local-embedding-service';
  const embedding = subItems[SUB_ITEM_IDS.embedding];
  const channel = subItems[SUB_ITEM_IDS.channel];
  const rebuild = subItems[SUB_ITEM_IDS.rebuild];
  const retained = subItems[SUB_ITEM_IDS.retained];

  const channelPassed = real
    && channel.status === 'PASS'
    && channel.detail.resultCount > 0
    && channel.detail.topUri === 'note.md'
    && Number.isFinite(channel.detail.topScore)
    && channel.detail.topScore > 0
    && channel.detail.storedVectors.inspected
    && channel.detail.storedVectors.dimensionsMatch
    && channel.detail.storedVectors.allVectorsNonZero
    && channel.detail.embedderCalls >= 2;

  const rebuildPassed = real
    && rebuild.status === 'PASS'
    && rebuild.detail.rootMoved
    && rebuild.detail.rebuildResultCount > 0
    && rebuild.detail.rebuildTopUri === 'new.md'
    && Number.isFinite(rebuild.detail.rebuildTopScore)
    && rebuild.detail.rebuildTopScore > 0
    && rebuild.detail.storedVectors.inspected
    && rebuild.detail.storedVectors.dimensionsMatch
    && rebuild.detail.storedVectors.allVectorsNonZero;

  const retainedPassed = real
    && retained.status === 'PASS'
    && retained.detail.oldRootRetained === true
    && retained.detail.oldRootStillExists === true
    && retained.detail.oldRootFileCount > 0;

  return {
    ret002: embedding.status === 'PASS' && channelPassed ? 'PASS' : 'BLOCKED',
    ret006: rebuildPassed && retainedPassed ? 'PASS' : 'BLOCKED',
    channelPassed,
    rebuildPassed,
    retainedPassed,
  };
}

async function acquireRealEmbedder(attempts, root) {
  // The model cache lives outside the repository and outside the real HOME, so
  // a repeated run reuses the model instead of downloading it again. It is
  // never the developer's own model cache.
  const cacheDir = process.env.PK_VECTOR_PROBE_CACHE_DIR
    ? path.resolve(process.env.PK_VECTOR_PROBE_CACHE_DIR)
    : path.join(fixture.resolveTempRoot(), 'parallel-knowledge-hf-cache');
  fs.mkdirSync(cacheDir, { recursive: true });
  const localModelPath = process.env.KB_EMBEDDING_LOCAL_PATH || '';
  const explicitMirror = String(process.env.KB_EMBEDDING_REMOTE_HOST || '').trim();
  const cachedModelDir = path.join(cacheDir, 'Xenova', 'bge-small-zh-v1.5');
  const cachedModelComplete = fs.existsSync(path.join(cachedModelDir, 'onnx', 'model.onnx'))
    && fs.existsSync(path.join(cachedModelDir, 'tokenizer.json'));

  const candidates = [];
  // 1) A model the operator pointed at: used offline, no network at all.
  if (localModelPath) {
    candidates.push({ attempt: 'local-model-offline', options: { cacheDir, localFilesOnly: true, localModelPath }, networkUsed: false });
  } else {
    attempts.push({
      attempt: 'local-model-offline',
      ok: false,
      skipped: true,
      error: 'KB_EMBEDDING_LOCAL_PATH is not configured, so no local model directory was given',
    });
  }
  // 2) A model the probe already has on disk: still offline, no download.
  if (!localModelPath && cachedModelComplete) {
    candidates.push({ attempt: 'probe-model-cache-offline', options: { cacheDir, localFilesOnly: true, localModelPath: cacheDir }, networkUsed: false });
  }
  // 3) An explicitly configured mirror.
  if (explicitMirror) {
    candidates.push({ attempt: 'configured-mirror', options: { cacheDir, remoteHost: explicitMirror }, networkUsed: true });
  } else if (DOWNLOAD_ALLOWED) {
    // 4) The default remote host, only when the operator allowed the download.
    candidates.push({ attempt: 'local-model-remote-download', options: { cacheDir }, networkUsed: true });
  } else {
    attempts.push({
      attempt: 'local-model-remote-download',
      ok: false,
      skipped: true,
      error: 'automatic model download is disabled by policy; set PK_VECTOR_PROBE_ALLOW_DOWNLOAD=1 to attempt it, or configure KB_EMBEDDING_LOCAL_PATH / KB_EMBEDDING_REMOTE_HOST',
    });
  }

  for (const candidate of candidates) {
    const service = new LocalEmbeddingService(candidate.options);
    const modelCacheDir = path.join(cacheDir, 'Xenova', 'bge-small-zh-v1.5');
    const cacheHit = fs.existsSync(modelCacheDir);
    try {
      const vector = await service.embedQuery(QUERY);
      const nonZero = vector.some(value => value !== 0);
      const usable = vector.length === EMBEDDING_DIMENSIONS && nonZero;
      attempts.push({
        attempt: candidate.attempt,
        ok: usable,
        dimensions: vector.length,
        expectedDimensions: EMBEDDING_DIMENSIONS,
        nonZero,
        modelCacheDir,
        cacheHit,
        networkUsed: candidate.networkUsed,
        ...(usable ? {} : { error: 'the produced vector did not match the expected dimension or was all zeros' }),
      });
      if (usable) return { service, vector, attempt: candidate.attempt, cacheDir, cacheHit, networkUsed: candidate.networkUsed };
    } catch (error) {
      attempts.push({ attempt: candidate.attempt, ok: false, error: describe(error), modelCacheDir, cacheHit, networkUsed: candidate.networkUsed });
    }
  }
  return null;
}

async function main() {
  const args = process.argv.slice(2);
  const evidenceIndex = args.indexOf('--evidence');
  const evidencePath = evidenceIndex >= 0 && args[evidenceIndex + 1]
    ? path.resolve(args[evidenceIndex + 1])
    : path.join(REPO_ROOT, 'qa-autopilot', 'artifacts', 'parallel-20261023', 'test-knowledge', 'evidence', 'parallel-knowledge-vector-probe.json');

  const root = fixture.makeTempDir('parallel-knowledge-vector-probe');
  const attempts = [];
  const subItems = {};
  try {
    // ---- 1) A real embedder, from an authorised source only.
    const acquired = await acquireRealEmbedder(attempts, root);

    if (acquired) {
      const embedder = createProductEmbedder(acquired.service);
      subItems[SUB_ITEM_IDS.embedding] = {
        status: 'PASS',
        detail: {
          attempt: acquired.attempt,
          modelId: acquired.service.modelId,
          dimensions: acquired.vector.length,
          expectedDimensions: EMBEDDING_DIMENSIONS,
          nonZero: acquired.vector.some(value => value !== 0),
          embedderKind: embedder.kind,
          modelCacheDir: acquired.cacheDir,
          modelServedFromCache: acquired.cacheHit,
          networkUsed: acquired.networkUsed,
        },
      };

      // ---- 2) The real retrieval channel.
      try {
        const detail = await runChannelStep({ root, embedder });
        subItems[SUB_ITEM_IDS.channel] = { status: 'PASS', detail };
      } catch (error) {
        subItems[SUB_ITEM_IDS.channel] = { status: 'BLOCKED', detail: { error: describe(error) } };
      }

      // ---- 3 + 4) The real root switch, the rebuild into the new root and
      // the retention of the old root.
      try {
        const detail = await runRootSwitchSteps({ root, embedder });
        subItems[SUB_ITEM_IDS.rebuild] = { status: 'PASS', detail };
        subItems[SUB_ITEM_IDS.retained] = {
          status: 'PASS',
          detail: {
            oldRootRetained: detail.oldRootRetained,
            oldRootStillExists: detail.oldRootStillExists,
            oldRootFileCount: detail.oldRootFileCount,
          },
        };
      } catch (error) {
        const failure = { error: describe(error) };
        subItems[SUB_ITEM_IDS.rebuild] = { status: 'BLOCKED', detail: failure };
        subItems[SUB_ITEM_IDS.retained] = { status: 'BLOCKED', detail: failure };
      }
    } else {
      const reason = 'no authorised embedding source: the real retrieval channel cannot be exercised without a real embedder, and neither a lexical fallback nor the shipped mock provider is accepted as vector evidence';
      for (const id of [SUB_ITEM_IDS.embedding, SUB_ITEM_IDS.channel, SUB_ITEM_IDS.rebuild, SUB_ITEM_IDS.retained]) {
        subItems[id] = { status: 'BLOCKED', detail: { reason } };
      }
    }

    // ---- The shipped hub refuses every index write without a model. The
    //      mock provider is detected and explicitly NOT used.
    const { VectorHub } = require(path.join(HUB_DIST, 'core', 'hub.js'));
    const bareHub = new VectorHub({ rootPath: path.join(root, 'bare-hub-root') });
    try {
      await bareHub.upsertDocument({ project: 'demo', uri: 'note.md', text: PASSAGE });
      attempts.push({ attempt: 'vector-hub-upsert-without-embeddings', ok: true });
    } catch (error) {
      attempts.push({ attempt: 'vector-hub-upsert-without-embeddings', ok: false, error: describe(error) });
    }
    const embeddingsModule = require(path.join(HUB_DIST, 'core', 'embeddings.js'));
    const providerSurface = Object.keys(embeddingsModule).filter(key => key.startsWith('create'));
    const managerModule = require(path.join(HUB_DIST, 'server', 'manager.js'));
    const mockAvailable = typeof managerModule.createMockEmbeddings === 'function';

    const embedderKind = acquired ? 'product-local-embedding-service' : 'none';
    const evaluated = evaluateSubItems({ subItems, embedderKind });
    const ret002 = evaluated.ret002;
    const ret006 = evaluated.ret006;
    const allPassed = ret002 === 'PASS' && ret006 === 'PASS';

    const evidence = {
      probe: 'qa-autopilot/tools/product-probes/parallel-knowledge-vector.js',
      modelId: DEFAULT_MODEL_ID,
      expectedDimensions: EMBEDDING_DIMENSIONS,
      attempts,
      providerSurface,
      mockEmbeddingsAvailable: mockAvailable,
      mockEmbeddingsUsed: false,
      standInEmbedderUsed: false,
      paidProviderCalled: false,
      automaticDownloadAllowed: DOWNLOAD_ALLOWED,
      embedderKind,
      subItems,
      cases: {
        'RET-002': {
          title: '真实向量',
          verdict: ret002,
          requiredSubItems: [SUB_ITEM_IDS.embedding, SUB_ITEM_IDS.channel],
          reason: ret002 === 'PASS'
            ? 'a real embedder produced a real vector, the real hub stored it and a real semantic query returned the document from the real index'
            : 'the real retrieval channel was not verified: the vector sub-item and the real upsert/search sub-item must both hold',
          note: 'a lexical fallback, the shipped mock provider or a bare embedding call alone never satisfies this case',
        },
        'RET-006': {
          title: '索引根切换',
          verdict: ret006,
          requiredSubItems: [SUB_ITEM_IDS.rebuild, SUB_ITEM_IDS.retained],
          probeSubItems: {
            'new-root-rebuild': subItems[SUB_ITEM_IDS.rebuild].status,
            'old-root-retained': subItems[SUB_ITEM_IDS.retained].status,
          },
          canonicalSubItemsCoveredElsewhere: [
            'RET-006.a-root-switch',
            'RET-006.b-writer-drain',
            'RET-006.c-old-root-retained',
            'RET-006.d-project-knowledge-kept',
          ],
          canonicalEntryPoint: '_site/_test/parallel-knowledge-vector-test.js',
          reason: ret006 === 'PASS'
            ? 'the new root was really rebuilt with a real vector index and searched, and the old root kept its data'
            : 'the new-root rebuild was not verified: it needs a real embedder and a real vector index in the new root',
          note: 'the overall RET-006 verdict is only meaningful together with the canonical entry point, which proves the deterministic sub-items a-d',
        },
      },
      realVectorObtained: subItems[SUB_ITEM_IDS.embedding].status === 'PASS',
      realChannelVerified: evaluated.channelPassed,
      newRootRebuilt: evaluated.rebuildPassed,
      status: allPassed ? 'PASS' : 'BLOCKED',
      reason: allPassed
        ? 'every sub-item was verified with the product\'s own embedding service and a real vector index'
        : 'at least one sub-item could not be verified, so no case is reported as passing',
    };

    fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
    fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2), 'utf8');

    console.log(JSON.stringify(evidence, null, 2));
    console.log(`evidence written to ${evidencePath}`);
    if (allPassed) {
      console.log('parallel-knowledge-vector-probe PASS');
      process.exitCode = 0;
    } else {
      console.log('parallel-knowledge-vector-probe BLOCKED (no case is reported as passing; no mock or lexical result was counted)');
      process.exitCode = 3;
    }
  } finally {
    fixture.removeTree(root);
    fixture.cleanupIsolatedProcess();
  }
}

if (require.main === module) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}

module.exports = {
  SUB_ITEM_IDS,
  QUERY,
  PASSAGE,
  createProductEmbedder,
  evaluateSubItems,
  inspectStoredVectors,
  runChannelStep,
  runRootSwitchSteps,
};
