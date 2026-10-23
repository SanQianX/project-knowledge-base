'use strict';
// Environment-dependent comparison probe for RET-008 (检索负载基线/候选对比).
//
// This file is NOT a regression test and is deliberately kept out of
// _site/_test/ so the offline runner never collects it: it needs the offline
// model cache (the real Xenova/bge-small-zh-v1.5 weights) and the real
// vector-hub source checkout.
//
// What it does, on ONE machine, with the SAME real embedding model, the SAME
// vector dimensions and the SAME index parameters:
//
//   baseline  = the pinned package the root project actually ships
//               (node_modules/@sanqianx/vector-hub, 1.0.8-rc.8)
//   candidate = the vector-hub SOURCE at HEAD, compiled to an isolated
//               output directory (the repo's own dist/ is never touched)
//
// Step 1 verifies the IMPLEMENTATION DIFFERENCE between the two, by diffing
// the compiled candidate against the pinned dist. If the difference is empty
// the honest verdict is "tool validation, no product change" — never a
// fabricated regression.
// Step 2 runs an alternating (baseline/candidate, order flipped per round)
// measurement over a fixed small corpus, fixed semantic queries and the
// human-labelled ground truth in the shared corpus definition.
// Step 3 proves the harness is SENSITIVE: a deliberately mutated build (the
// query cache disabled) must be visible in the same measurement, otherwise
// an equal result would prove nothing.
//
// Exit codes: 0 PASS, 3 BLOCKED (offline model cache unavailable), 1 FAIL.
//
// Invoke explicitly:
//   node qa-autopilot/tools/product-probes/parallel-retrieval-followup-ret008.js
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const shell = require(path.join(__dirname, '..', '..', '..', '_site', '_test', 'helpers', 'parallel-retrieval-followup-shell'));
// Isolate before any product module is loaded.
shell.isolateProcess();

const corpusDefinitions = require(path.join(shell.REPO_ROOT, '_site', '_test', 'helpers', 'parallel-retrieval-followup-corpus'));
const { LocalEmbeddingService } = require(path.join(shell.REPO_ROOT, '_site', 'lib', 'embedding-service'));
const { EMBEDDING_DIMENSIONS } = require(path.join(shell.REPO_ROOT, '_site', 'lib', 'knowledge-schema'));

// The offline model cache lives outside the repository and outside the real
// HOME; the lane temp root (PK_TEST_TEMP_ROOT / TEMP) is its parent.
const MODEL_CACHE = process.env.PK_RETRIEVAL_MODEL_CACHE
  ? path.resolve(process.env.PK_RETRIEVAL_MODEL_CACHE)
  : path.join(shell.resolveTempRoot(), 'parallel-knowledge-hf-cache');
const PINNED_PACKAGE = path.join(shell.REPO_ROOT, 'node_modules', '@sanqianx', 'vector-hub');
const BASELINE_DIST = path.join(PINNED_PACKAGE, 'dist', 'cjs');
// The vector-hub source checkout: a sibling of this repository by default,
// overridable so no developer path is hard-coded.
const VECTOR_HUB_REPO = process.env.PK_VECTOR_HUB_REPO
  ? path.resolve(process.env.PK_VECTOR_HUB_REPO)
  : path.resolve(shell.REPO_ROOT, '..', 'vector-hub');
const VECTRA_PACKAGE = path.join(shell.REPO_ROOT, 'node_modules', '@sanqianx', 'vectra');
const PROJECT = 'ret008-corpus';
const ROUNDS = Math.max(2, Number(process.env.PK_RETRIEVAL_RET008_ROUNDS || 4));
const SEARCH_OPTIONS = { maxResults: 10, resultLevel: 'chunk' };

const layers = {};
const verdicts = {};
let firstFailure = null;

function fail(layer, error, extra = {}) {
  if (!firstFailure) {
    firstFailure = {
      layer,
      at: new Date().toISOString(),
      message: String((error && error.message) || error),
      stack: String((error && error.stack) || '').split('\n').slice(0, 12),
      ...extra,
    };
  }
  throw error;
}

function layer(name, value) {
  layers[name] = { at: new Date().toISOString(), ...value };
  return layers[name];
}

function listJsFiles(dir) {
  const out = [];
  const walk = current => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) out.push(path.relative(dir, full).split(path.sep).join('/'));
    }
  };
  if (!fs.existsSync(dir)) return out;
  walk(dir);
  return out.sort();
}

function hashTree(dir) {
  const out = {};
  for (const relative of listJsFiles(dir)) out[relative] = shell.sha256File(path.join(dir, ...relative.split('/')));
  return out;
}

function compareTrees(baselineDir, candidateDir) {
  const baseline = hashTree(baselineDir);
  const candidate = hashTree(candidateDir);
  const files = [...new Set([...Object.keys(baseline), ...Object.keys(candidate)])].sort();
  const perFile = files.map(relative => ({
    file: relative,
    inBaseline: Object.prototype.hasOwnProperty.call(baseline, relative),
    inCandidate: Object.prototype.hasOwnProperty.call(candidate, relative),
    identical: baseline[relative] === candidate[relative] && Object.prototype.hasOwnProperty.call(baseline, relative),
  }));
  const differing = perFile.filter(entry => !entry.identical);
  let hubDiff = null;
  const hubFile = 'core/hub.js';
  if (perFile.some(entry => entry.file === hubFile && entry.inBaseline && entry.inCandidate)) {
    const a = fs.readFileSync(path.join(baselineDir, ...hubFile.split('/')), 'utf8').split('\n');
    const b = fs.readFileSync(path.join(candidateDir, ...hubFile.split('/')), 'utf8').split('\n');
    const lines = [];
    const max = Math.max(a.length, b.length);
    for (let i = 0; i < max && lines.length < 60; i += 1) {
      if (a[i] !== b[i]) lines.push({ line: i + 1, baseline: a[i] === undefined ? null : a[i], candidate: b[i] === undefined ? null : b[i] });
    }
    hubDiff = { file: hubFile, changedLines: lines.length, lines };
  }
  return {
    baselineFileCount: Object.keys(baseline).length,
    candidateFileCount: Object.keys(candidate).length,
    identicalFileCount: perFile.filter(entry => entry.identical).length,
    differingFiles: differing.map(entry => entry.file),
    identical: differing.length === 0,
    perFile,
    hubDiff,
  };
}

// Compiles the vector-hub source at HEAD into an isolated directory. The
// repository's own dist/ and node_modules/ are never written to.
function buildCandidate(repo, outDir) {
  const tscEntry = path.join(repo, 'node_modules', 'typescript', 'bin', 'tsc');
  if (!fs.existsSync(tscEntry)) {
    return { ok: false, reason: `typescript compiler not found at ${tscEntry}` };
  }
  const started = Date.now();
  const result = spawnSync(process.execPath, [tscEntry, '-p', 'tsconfig.cjs.json', '--outDir', outDir], {
    cwd: repo,
    encoding: 'utf8',
    windowsHide: true,
  });
  return {
    ok: result.status === 0,
    command: `node node_modules/typescript/bin/tsc -p tsconfig.cjs.json --outDir <temp> (cwd=${repo})`,
    exitCode: result.status,
    signal: result.signal || null,
    durationMs: Date.now() - started,
    stdout: String(result.stdout || '').slice(-2000),
    stderr: String(result.stderr || '').slice(-2000),
    outDir,
  };
}

// The compiled candidate lives outside any node_modules tree, so its
// '@sanqianx/vectra' import has to be resolvable. Both variants must use the
// SAME vectra implementation, so the link points at the one the pinned
// package already resolves.
function linkVectra(outDir) {
  const scope = path.join(outDir, 'node_modules', '@sanqianx');
  const link = path.join(scope, 'vectra');
  fs.mkdirSync(scope, { recursive: true });
  if (fs.existsSync(link)) return { link, mode: 'already-present' };
  try {
    fs.symlinkSync(VECTRA_PACKAGE, link, 'junction');
    return { link, mode: 'junction', target: VECTRA_PACKAGE };
  } catch (error) {
    fs.cpSync(VECTRA_PACKAGE, link, { recursive: true });
    return { link, mode: 'copied', target: VECTRA_PACKAGE, fallbackReason: error.message };
  }
}

function gitIn(repo, args) {
  return shell.gitIn(repo, args, {});
}

// Copies the compiled modules of a build without its node_modules folder, so
// the mutant copy can be linked to the same vectra package on its own.
function copyBuildModules(sourceDir, targetDir) {
  fs.mkdirSync(targetDir, { recursive: true });
  const copied = [];
  const walk = current => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) {
        const relative = path.relative(sourceDir, full);
        const target = path.join(targetDir, relative);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(full, target);
        copied.push(relative.split(path.sep).join('/'));
      }
    }
  };
  walk(sourceDir);
  return copied.sort();
}

async function acquireEmbedder() {
  const cache = shell.verifyModelCache(MODEL_CACHE);
  if (!cache.ok) return { ok: false, reason: 'offline model cache incomplete', cache };
  const service = new LocalEmbeddingService({
    cacheDir: MODEL_CACHE,
    localFilesOnly: true,
    localModelPath: MODEL_CACHE,
  });
  try {
    const vector = await service.embedQuery('连接测试');
    if (vector.length !== EMBEDDING_DIMENSIONS) {
      return { ok: false, reason: `the model returned ${vector.length} dimensions instead of ${EMBEDDING_DIMENSIONS}`, cache };
    }
    if (!vector.some(value => value !== 0)) return { ok: false, reason: 'the model returned an all-zero vector', cache };
    return { ok: true, service, cache, dimensions: vector.length, modelId: service.modelId };
  } catch (error) {
    return { ok: false, reason: `the offline model could not be loaded: ${error.message}`, cache };
  }
}

function makeCountingEmbedder(service) {
  const inner = shell.createProductEmbedder(service);
  const state = { calls: 0, batchCalls: 0, singleCalls: 0, dimensions: [] };
  return {
    state,
    model: inner.model,
    modelId: inner.modelId,
    maxTokens: inner.maxTokens,
    async createEmbeddings(inputs) {
      state.calls += 1;
      if (Array.isArray(inputs)) state.batchCalls += 1; else state.singleCalls += 1;
      const output = await inner.createEmbeddings(inputs);
      for (const vector of output.output || []) state.dimensions.push(vector.length);
      return output;
    },
  };
}

async function createHub(variant, { distDir, root, corpusDir, embedder }) {
  const { VectorHub } = require(path.join(distDir, 'core', 'hub.js'));
  const hub = new VectorHub({ rootPath: root });
  hub.setEmbeddings(embedder);
  const tracked = await hub.syncFolder(PROJECT, corpusDir);
  return { hub, tracked };
}

async function runQuerySet(hub, corpusIndex) {
  const rows = [];
  for (const definition of corpusDefinitions.QUERIES) {
    const started = process.hrtime.bigint();
    const response = await hub.search(definition.query, SEARCH_OPTIONS);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    const docIds = [];
    for (const item of response.results || []) {
      const id = corpusIndex.idForFile(item.file || item.uri);
      if (id && !docIds.includes(id)) docIds.push(id);
    }
    const ranking = corpusDefinitions.evaluateRanking(docIds, definition.relevant);
    rows.push({
      queryId: definition.id,
      query: definition.query,
      elapsedMs: Math.round(elapsedMs * 1000) / 1000,
      tookMs: response.tookMs,
      errors: response.errors || [],
      retrievedDocIds: docIds,
      topScore: (response.results || [])[0] ? Math.round(((response.results || [])[0].score || 0) * 1e6) / 1e6 : null,
      ...ranking,
    });
  }
  return rows;
}

function summariseRows(rows) {
  const count = rows.length || 1;
  return {
    queries: rows.length,
    meanRecallAt1: rows.reduce((sum, row) => sum + row.recallAt1, 0) / count,
    meanRecallAt5: rows.reduce((sum, row) => sum + row.recallAt5, 0) / count,
    meanReciprocalRank: rows.reduce((sum, row) => sum + row.reciprocalRank, 0) / count,
    hitRate: rows.filter(row => row.hit).length / count,
    latency: corpusDefinitions.summariseLatency(rows.map(row => row.elapsedMs)),
  };
}

function sameRanking(a, b) {
  if (a.length !== b.length) return false;
  return a.every((value, index) => value === b[index]);
}

(async () => {
  const root = shell.makeTempDir('parallel-retrieval-followup-ret008');
  try {
    // ---- L1: the offline model cache (BLOCKED, never a download).
    const embedderResult = await acquireEmbedder();
    layer('L1-model-cache', {
      cacheDir: MODEL_CACHE,
      modelId: 'Xenova/bge-small-zh-v1.5',
      expectedDimensions: EMBEDDING_DIMENSIONS,
      ok: embedderResult.ok,
      reason: embedderResult.reason || null,
      cache: embedderResult.cache,
    });
    if (!embedderResult.ok) {
      verdicts['RET-008'] = 'BLOCKED';
      console.log(`parallel-retrieval-followup-ret008 BLOCKED (${embedderResult.reason})`);
      process.exitCode = 3;
      return;
    }

    // ---- L2: baseline identity (the pinned package the root project ships).
    const pinnedPackageJson = JSON.parse(fs.readFileSync(path.join(PINNED_PACKAGE, 'package.json'), 'utf8'));
    const baselineIdentity = {
      kind: 'pinned-npm-package',
      path: PINNED_PACKAGE,
      version: pinnedPackageJson.version,
      packageJsonSha256: shell.sha256File(path.join(PINNED_PACKAGE, 'package.json')),
      distSha256: hashTree(BASELINE_DIST),
      vectraVersion: JSON.parse(fs.readFileSync(path.join(VECTRA_PACKAGE, 'package.json'), 'utf8')).version,
      vectraEntrySha256: shell.sha256File(path.join(VECTRA_PACKAGE, 'package.json')),
    };
    layer('L2-baseline-identity', baselineIdentity);

    // ---- L3: candidate identity (the source at HEAD, compiled in isolation).
    if (!fs.existsSync(path.join(VECTOR_HUB_REPO, 'src', 'core', 'hub.ts'))) {
      fail('L3-candidate-identity', new Error(`the vector-hub source checkout is not available at ${VECTOR_HUB_REPO}`));
    }
    const candidateHead = gitIn(VECTOR_HUB_REPO, ['rev-parse', 'HEAD']);
    const candidateStatus = gitIn(VECTOR_HUB_REPO, ['status', '--porcelain']);
    const candidateDist = path.join(root, 'candidate-dist');
    const build = buildCandidate(VECTOR_HUB_REPO, candidateDist);
    if (!build.ok) fail('L3-candidate-identity', new Error(`the candidate build failed with exit code ${build.exitCode}: ${build.stderr.slice(-400)}`));
    const vectraLink = linkVectra(candidateDist);
    const candidateIdentity = {
      kind: 'source-head-build',
      repo: VECTOR_HUB_REPO,
      head: candidateHead,
      headSubject: gitIn(VECTOR_HUB_REPO, ['log', '-1', '--pretty=%s']),
      worktreeClean: candidateStatus.length === 0,
      worktreeStatus: candidateStatus.split('\n').filter(Boolean),
      build,
      vectraLink,
      distSha256: hashTree(candidateDist),
    };
    layer('L3-candidate-identity', candidateIdentity);
    if (!candidateIdentity.worktreeClean) {
      layer('L3-candidate-identity-note', 'the source checkout has uncommitted changes; the recorded HEAD is not the only input');
    }

    // ---- L4: the implementation difference between baseline and candidate.
    const comparison = compareTrees(BASELINE_DIST, candidateDist);
    const implementationDifference = {
      identical: comparison.identical,
      differingFiles: comparison.differingFiles,
      identicalFileCount: comparison.identicalFileCount,
      baselineFileCount: comparison.baselineFileCount,
      candidateFileCount: comparison.candidateFileCount,
      hubDiff: comparison.hubDiff,
      sourceHistory: gitIn(VECTOR_HUB_REPO, ['log', '--oneline', '-5', '--', 'src/']),
      verdict: comparison.identical
        ? 'no implementation difference: the pinned package and the source HEAD compile to the same modules (tool validation, no product change)'
        : `implementation difference found in ${comparison.differingFiles.join(', ')}`,
    };
    layer('L4-implementation-difference', implementationDifference);

    // ---- L5: identical corpus, identical model, identical index parameters.
    const corpusDir = path.join(root, 'corpus');
    const corpusIndex = corpusDefinitions.materialiseCorpus(corpusDir);
    const corpusHash = shell.hashTree(corpusDir);
    const service = embedderResult.service;
    const variants = {};
    for (const variant of ['baseline', 'candidate']) {
      const distDir = variant === 'baseline' ? BASELINE_DIST : candidateDist;
      const embedder = makeCountingEmbedder(service);
      const built = await createHub(variant, {
        distDir,
        root: path.join(root, `${variant}-hub`),
        corpusDir,
        embedder,
      });
      variants[variant] = { variant, distDir, embedder, hub: built.hub, tracked: built.tracked };
    }
    const baselineIndexTree = shell.hashTree(path.join(root, 'baseline-hub'));
    const candidateIndexTree = shell.hashTree(path.join(root, 'candidate-hub'));
    const indexTreeFiles = [...new Set([...Object.keys(baselineIndexTree), ...Object.keys(candidateIndexTree)])].sort();
    const indexTreeDiff = {
      baselineFileCount: Object.keys(baselineIndexTree).length,
      candidateFileCount: Object.keys(candidateIndexTree).length,
      differing: indexTreeFiles.filter(file => baselineIndexTree[file] !== candidateIndexTree[file]),
      onlyBaseline: indexTreeFiles.filter(file => baselineIndexTree[file] !== undefined && candidateIndexTree[file] === undefined),
      onlyCandidate: indexTreeFiles.filter(file => candidateIndexTree[file] !== undefined && baselineIndexTree[file] === undefined),
    };
    layer('L5-index', {
      project: PROJECT,
      corpusDir,
      corpusFileCount: corpusIndex.fileCount,
      corpusHash,
      modelId: 'Xenova/bge-small-zh-v1.5',
      dimensions: EMBEDDING_DIMENSIONS,
      searchOptions: SEARCH_OPTIONS,
      indexParameters: 'identical for both variants: same source directory, same project name, same embedder service instance, same syncFolder options (defaults)',
      baselineTracked: variants.baseline.tracked,
      candidateTracked: variants.candidate.tracked,
      indexTreeDiff,
      note: 'the two index trees are stored in different folders, so their byte hashes may differ in the stored metadata; the retrieval behaviour is compared by the measured ranking, not by the index bytes',
    });

    // ---- L6: alternating measurement (order flips every round).
    const rounds = [];
    for (let round = 0; round < ROUNDS; round += 1) {
      const order = round % 2 === 0 ? ['baseline', 'candidate'] : ['candidate', 'baseline'];
      const roundRecord = { round, order, results: {} };
      for (const variant of order) {
        const before = variants[variant].embedder.state.calls;
        const rows = await runQuerySet(variants[variant].hub, corpusIndex);
        roundRecord.results[variant] = {
          rows,
          summary: summariseRows(rows),
          embeddingCalls: variants[variant].embedder.state.calls - before,
        };
      }
      rounds.push(roundRecord);
    }
    const variantRows = variant => rounds.flatMap(round => round.results[variant].rows);
    const baselineRows = variantRows('baseline');
    const candidateRows = variantRows('candidate');
    const baselineSummary = summariseRows(baselineRows);
    const candidateSummary = summariseRows(candidateRows);
    const coldRound = rounds[0];
    const warmRounds = rounds.slice(1);
    const latencyOf = (variant, subset) => corpusDefinitions.summariseLatency(
      subset.flatMap(round => round.results[variant].rows.map(row => row.elapsedMs)),
    );
    const rankingStability = {};
    for (const variant of ['baseline', 'candidate']) {
      const perQuery = new Map();
      for (const round of rounds) {
        for (const row of round.results[variant].rows) {
          if (!perQuery.has(row.queryId)) perQuery.set(row.queryId, []);
          perQuery.get(row.queryId).push(row.retrievedDocIds.join('|'));
        }
      }
      rankingStability[variant] = [...perQuery.entries()].map(([queryId, orders]) => ({
        queryId,
        distinctOrderings: new Set(orders).size,
        stable: new Set(orders).size === 1,
      }));
    }
    const crossVariantMismatches = [];
    for (const round of rounds) {
      const baselineByQuery = new Map(round.results.baseline.rows.map(row => [row.queryId, row.retrievedDocIds]));
      for (const row of round.results.candidate.rows) {
        const other = baselineByQuery.get(row.queryId) || [];
        if (!sameRanking(other, row.retrievedDocIds)) {
          crossVariantMismatches.push({ round: round.round, queryId: row.queryId, baseline: other, candidate: row.retrievedDocIds });
        }
      }
    }
    layer('L6-measurement', {
      rounds: rounds.length,
      order: rounds.map(round => round.order),
      baseline: baselineSummary,
      candidate: candidateSummary,
      coldRound: {
        baseline: coldRound.results.baseline.summary,
        candidate: coldRound.results.candidate.summary,
        baselineEmbeddingCalls: coldRound.results.baseline.embeddingCalls,
        candidateEmbeddingCalls: coldRound.results.candidate.embeddingCalls,
      },
      warm: {
        baseline: latencyOf('baseline', warmRounds),
        candidate: latencyOf('candidate', warmRounds),
      },
      rankingStability,
      crossVariantMismatches,
      perQuery: rounds[0].results.baseline.rows.map(row => ({
        queryId: row.queryId,
        query: row.query,
        relevant: row.relevant,
        baselineRetrieved: row.retrievedDocIds,
        candidateRetrieved: (rounds[0].results.candidate.rows.find(other => other.queryId === row.queryId) || {}).retrievedDocIds,
        firstRelevantRank: row.firstRelevantRank,
        recallAt1: row.recallAt1,
        recallAt5: row.recallAt5,
        topScore: row.topScore,
      })),
      perRound: rounds.map(round => ({
        round: round.round,
        order: round.order,
        baseline: { summary: round.results.baseline.summary, embeddingCalls: round.results.baseline.embeddingCalls },
        candidate: { summary: round.results.candidate.summary, embeddingCalls: round.results.candidate.embeddingCalls },
      })),
    });

    // ---- L7: sensitivity check — a deliberately mutated build must be visible.
    const mutantDist = path.join(root, 'mutant-dist');
    const copiedModules = copyBuildModules(candidateDist, mutantDist);
    const mutantVectraLink = linkVectra(mutantDist);
    const mutantHubFile = path.join(mutantDist, 'core', 'hub.js');
    const mutantSource = fs.readFileSync(mutantHubFile, 'utf8');
    const mutantNeedle = 'const previous = this._queryCache.get(key);';
    if (!mutantSource.includes(mutantNeedle)) {
      fail('L7-sensitivity', new Error('the mutation target (the query cache lookup) is not present in the compiled candidate'));
    }
    fs.writeFileSync(mutantHubFile, mutantSource.replace(mutantNeedle, 'const previous = undefined; // MUTANT: query cache disabled'), 'utf8');
    const mutantEmbedder = makeCountingEmbedder(service);
    const mutantHub = await createHub('mutant', {
      distDir: mutantDist,
      root: path.join(root, 'mutant-hub'),
      corpusDir,
      embedder: mutantEmbedder,
    });
    const mutantCallsBeforeCold = mutantEmbedder.state.calls;
    const mutantCold = await runQuerySet(mutantHub.hub, corpusIndex);
    const mutantColdCalls = mutantEmbedder.state.calls - mutantCallsBeforeCold;
    const mutantCallsBeforeWarm = mutantEmbedder.state.calls;
    const mutantWarm = await runQuerySet(mutantHub.hub, corpusIndex);
    const mutantWarmCalls = mutantEmbedder.state.calls - mutantCallsBeforeWarm;
    const baselineWarmCalls = rounds.slice(1).reduce((sum, round) => sum + round.results.baseline.embeddingCalls, 0) / Math.max(1, rounds.length - 1);
    const mutantWarmLatency = corpusDefinitions.summariseLatency(mutantWarm.map(row => row.elapsedMs));
    const baselineWarmLatency = latencyOf('baseline', warmRounds);
    const callSignal = mutantWarmCalls > baselineWarmCalls + 1;
    const latencySignal = mutantWarmLatency.p50 !== null && baselineWarmLatency.p50 !== null
      && mutantWarmLatency.p50 > baselineWarmLatency.p50 * 1.5;
    const sensitivity = {
      mutation: 'the query-embedding cache lookup in core/hub.js is disabled in an isolated copy of the candidate build',
      copiedModules,
      vectraLink: mutantVectraLink,
      mutantCold: summariseRows(mutantCold),
      mutantWarm: summariseRows(mutantWarm),
      mutantColdEmbeddingCalls: mutantColdCalls,
      mutantWarmEmbeddingCalls: mutantWarmCalls,
      baselineWarmEmbeddingCallsPerRound: baselineWarmCalls,
      mutantWarmLatency,
      baselineWarmLatency,
      callSignal,
      latencySignal,
      visible: callSignal || latencySignal,
      note: 'the mutant is a harness sensitivity probe on an isolated copy; it is not a product build and no product source is modified',
    };
    layer('L7-sensitivity', sensitivity);
    if (!sensitivity.visible) {
      fail('L7-sensitivity', new Error('the deliberately mutated build was not distinguishable from the baseline, so the equal baseline/candidate result would not prove anything'));
    }

    // ---- expected conclusions
    const qualityEqual = candidateSummary.meanRecallAt5 >= baselineSummary.meanRecallAt5
      && candidateSummary.meanRecallAt1 >= baselineSummary.meanRecallAt1
      && candidateSummary.meanReciprocalRank >= baselineSummary.meanReciprocalRank;
    const noRegression = crossVariantMismatches.length === 0 && qualityEqual;
    const expected = {
      '基线与候选的实现差异已核实': 'PASS',
      '同机同模型同维度同索引参数': 'PASS',
      '语义召回与排序不劣于基线': qualityEqual ? 'PASS' : 'FAIL',
      '真实模型下未发现回归': noRegression ? 'PASS' : 'FAIL',
      '实现无差异时记录为工具验证、无产品变更': implementationDifference.identical ? 'PASS' : 'N/A（存在实现差异）',
      '对照灵敏度由故意变异验证': 'PASS',
    };
    if (!qualityEqual || !noRegression) {
      fail('L6-measurement', new Error(`the candidate measured worse than the baseline: ${JSON.stringify({ baselineSummary, candidateSummary, crossVariantMismatches: crossVariantMismatches.slice(0, 3) })}`));
    }

    verdicts['RET-008'] = 'PASS';
    const evidence = {
      probe: 'qa-autopilot/tools/product-probes/parallel-retrieval-followup-ret008.js',
      date: new Date().toISOString(),
      batch: 'P-RETRIEVAL-FOLLOWUP-01',
      model: {
        modelId: 'Xenova/bge-small-zh-v1.5',
        dimensions: EMBEDDING_DIMENSIONS,
        source: 'offline model cache',
        cacheDir: MODEL_CACHE,
        networkUsed: false,
      },
      expected,
      layers,
      verdicts,
      firstFailure,
    };
    const written = shell.writeEvidence('ret008-comparison.json', evidence);
    console.log(JSON.stringify({
      verdict: 'PASS',
      implementationDifference: implementationDifference.verdict,
      differingFiles: implementationDifference.differingFiles,
      baseline: baselineSummary,
      candidate: candidateSummary,
      crossVariantMismatches: crossVariantMismatches.length,
      evidence: written.file,
      sha256: written.sha256,
    }, null, 2));
    console.log('parallel-retrieval-followup-ret008 PASS');
  } catch (error) {
    const evidence = {
      probe: 'qa-autopilot/tools/product-probes/parallel-retrieval-followup-ret008.js',
      date: new Date().toISOString(),
      batch: 'P-RETRIEVAL-FOLLOWUP-01',
      layers,
      verdicts,
      firstFailure: firstFailure || { layer: 'unknown', message: String((error && error.message) || error) },
    };
    const written = shell.writeEvidence('ret008-comparison.json', evidence);
    console.error(JSON.stringify(evidence.firstFailure, null, 2));
    console.error(`evidence: ${written.file}`);
    console.log('parallel-retrieval-followup-ret008 FAIL');
    process.exitCode = 1;
  } finally {
    shell.removeTree(root);
    shell.cleanupIsolatedProcess();
  }
})();
