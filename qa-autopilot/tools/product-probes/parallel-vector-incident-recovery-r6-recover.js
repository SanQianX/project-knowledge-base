'use strict';
// qa-autopilot/tools/product-probes/parallel-vector-incident-recovery-r6-recover.js
//
// P-VECTOR-INCIDENT-RECOVERY-R6 one-shot (lane-owned). Restores the ONE
// collection the R5 mem005 lane overwrote (scope-brain-brain-default) by a
// single authorized POST /api/sync from the REAL source directory
// D:\SanQian.Xu\knowledge\_shared\brain-default. Everything else is read-only.
//
// Phases:
//   PRE   (read-only): hub pid snapshot (OS-level, not endpoint); complete
//         pre-recovery copy of the collection + SHA256SUMS; cross-check vs the
//         frozen R5 quarantine copy; real-source identity check (exactly 1
//         file, no fixture paths); full sha256 baseline of knowledge root
//         minus .indexes; .indexes-wide name/mtime/filecount snapshot.
//   FIX   (the single authorized live call): ONE POST /api/sync, no retry.
//         On failure: record error + executable recovery command for the
//         Leader, touch nothing else, exit non-zero.
//   POST  (read-only): catalog must reference ONLY the real sourceDir (count=1,
//         fixture URI absent from every file in the collection); bounded
//         read-only retrieval GET /api/document (status + uri + content hash,
//         never the content); post copy + hashes; baseline re-digest must be
//         byte-identical; .indexes diff may contain ONLY this collection
//         (plus __manifest bookkeeping, classified); same hub pid after.
//
// No knowledge content and no secrets are printed or exported: evidence keeps
// IDs, paths, counts, hashes and shapes only.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const LANE_DIR = path.join(REPO_ROOT, 'qa-autopilot', 'artifacts', 'parallel-20261023', 'vector-incident-recovery-r6');
const EVIDENCE = path.join(LANE_DIR, 'evidence');

const KNOWLEDGE_ROOT = 'D:\\SanQian.Xu\\knowledge';
const INDEXES_ROOT = path.join(KNOWLEDGE_ROOT, '.indexes');
const COLLECTION = 'scope-brain-brain-default';
const COLLECTION_DIR = path.join(INDEXES_ROOT, COLLECTION);
const REAL_SOURCE_DIR = path.join(KNOWLEDGE_ROOT, '_shared', 'brain-default');
const REAL_DOC_URI = path.join(REAL_SOURCE_DIR, 'memories', 'confirmed.md');
const QUARANTINE_COPY = path.join(REPO_ROOT, 'qa-autopilot', 'artifacts', 'parallel-20261023', 'capture-safety-r5',
  'evidence', 'vectorhub-incident', 'quarantine', COLLECTION);
const HUB_BASE = 'http://127.0.0.1:8787';
const FIXTURE_MARKERS = ['pk-parallel-memory', 'AppData\\Local\\Temp', 'AppData/Local/Temp'];
const RECOVERY_COMMAND = `Invoke-RestMethod -Method Post -Uri ${HUB_BASE}/api/sync -ContentType 'application/json' -Body '{"project":"${COLLECTION}","sourceDir":"${REAL_SOURCE_DIR.replace(/\\/g, '\\\\')}"}'`;

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function sha256File(file) { return sha256(fs.readFileSync(file)); }

function walkFiles(dir) {
  const out = [];
  const walk = (d) => {
    let names;
    try { names = fs.readdirSync(d); } catch { return; }
    for (const name of names) {
      const p = path.join(d, name);
      let st;
      try { st = fs.statSync(p); } catch { continue; }
      if (st.isDirectory()) walk(p); else out.push(p);
    }
  };
  walk(dir);
  return out.sort();
}

function copyTreeWithHashes(srcDir, destDir) {
  const hashes = {};
  for (const file of walkFiles(srcDir)) {
    const rel = path.relative(srcDir, file).split(path.sep).join('/');
    const buf = fs.readFileSync(file);
    hashes[rel] = sha256(buf);
    const dest = path.join(destDir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, buf);
  }
  return hashes;
}

function hashTreeToSums(hashes, baseDir, sumsFile) {
  const lines = Object.entries(hashes).sort(([a], [b]) => a.localeCompare(b))
    .map(([rel, hash]) => `${hash}  ${rel}`).join('\n');
  fs.writeFileSync(sumsFile, lines + '\n', 'utf8');
  return { baseDir, fileCount: Object.keys(hashes).length };
}

function digestKnowledgeRootMinusIndexes() {
  const map = {};
  for (const entry of fs.readdirSync(KNOWLEDGE_ROOT, { withFileTypes: true })) {
    if (entry.name === '.indexes') continue;
    const full = path.join(KNOWLEDGE_ROOT, entry.name);
    if (!entry.isDirectory()) { map[entry.name] = sha256File(full); continue; }
    for (const file of walkFiles(full)) {
      map[path.relative(KNOWLEDGE_ROOT, file).split(path.sep).join('/')] = sha256File(file);
    }
  }
  return map;
}

function snapshotIndexesRoot() {
  const entries = {};
  for (const entry of fs.readdirSync(INDEXES_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory()) { entries[entry.name] = { kind: 'file', mtimeMs: fs.statSync(path.join(INDEXES_ROOT, entry.name)).mtimeMs }; continue; }
    const files = walkFiles(path.join(INDEXES_ROOT, entry.name));
    entries[entry.name] = { kind: 'dir', fileCount: files.length, mtimeMs: fs.statSync(path.join(INDEXES_ROOT, entry.name)).mtimeMs };
  }
  return entries;
}

function diffMaps(before, after) {
  const delta = [];
  for (const [k, v] of Object.entries(after)) if (before[k] !== v) delta.push({ path: k, state: before[k] === undefined ? 'created' : 'changed', before: before[k], after: v });
  for (const k of Object.keys(before)) if (!(k in after)) delta.push({ path: k, state: 'removed' });
  return delta;
}

function hubIdentity() {
  const script = path.join(LANE_DIR, 'find-hub-process.ps1');
  const result = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-File', script], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
  const text = String(result.stdout || '').trim();
  try {
    const parsed = JSON.parse(text);
    const arr = Array.isArray(parsed) ? parsed : [parsed];
    return { listening: arr.length > 0 && arr[0].pid != null, processes: arr.map(p => ({ pid: p.pid, name: p.name, createdUtc: p.createdUtc, parentName: p.parentName })) };
  } catch {
    return { listening: false, processes: [], error: `unparseable identity output: ${text.slice(0, 300)}` };
  }
}

function readCatalog(dir) {
  try {
    const catalog = JSON.parse(fs.readFileSync(path.join(dir, 'catalog.json'), 'utf8'));
    return {
      exists: true, version: catalog.version, count: catalog.count,
      uris: Object.keys(catalog.uriToId || {}),
      contentHashes: Object.values(catalog.uriToHash || {}),
    };
  } catch (error) {
    return { exists: false, error: String(error.message) };
  }
}

async function singleRequest(method, url, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120000);
  const startedAt = new Date().toISOString();
  try {
    const response = await fetch(url, { method, signal: controller.signal, headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* keep raw */ }
    return { startedAt, finishedAt: new Date().toISOString(), method, url, httpStatus: response.status, json, raw: json ? undefined : text.slice(0, 500) };
  } catch (error) {
    return { startedAt, finishedAt: new Date().toISOString(), method, url, networkError: String(error.message || error) };
  } finally {
    clearTimeout(timer);
  }
}

(async () => {
  fs.mkdirSync(EVIDENCE, { recursive: true });
  const record = { lane: 'vector-incident-recovery-r6', startedAt: new Date().toISOString() };

  // ---------------- PRE ----------------
  record.hubBefore = hubIdentity();

  const preHashes = copyTreeWithHashes(COLLECTION_DIR, path.join(LANE_DIR, 'pre-recovery', COLLECTION));
  record.preRecoveryCopy = hashTreeToSums(preHashes, `pre-recovery/${COLLECTION}/`, path.join(LANE_DIR, 'SHA256SUMS-pre-recovery.txt'));

  const quarantineHashes = {};
  for (const file of walkFiles(QUARANTINE_COPY)) {
    quarantineHashes[path.relative(QUARANTINE_COPY, file).split(path.sep).join('/')] = sha256File(file);
  }
  const qKeys = Object.keys(quarantineHashes).sort();
  const pKeys = Object.keys(preHashes).sort();
  record.crossCheckVsR5Quarantine = {
    quarantineFileCount: qKeys.length,
    identical: qKeys.length === pKeys.length && qKeys.every(k => quarantineHashes[k] === preHashes[k]),
    perFile: qKeys.reduce((acc, k) => { acc[k] = quarantineHashes[k] === preHashes[k]; return acc; }, {}),
  };

  const sourceFiles = walkFiles(REAL_SOURCE_DIR);
  record.realSourceIdentity = {
    sourceDir: REAL_SOURCE_DIR,
    fileCount: sourceFiles.length,
    files: sourceFiles.map(f => ({
      rel: path.relative(REAL_SOURCE_DIR, f).split(path.sep).join('/'),
      bytes: fs.statSync(f).size, sha256: sha256File(f),
    })),
    containsFixtureMarkers: sourceFiles.some(f => FIXTURE_MARKERS.some(m => f.includes(m))),
    realDocUri: REAL_DOC_URI,
  };

  record.catalogBefore = readCatalog(COLLECTION_DIR);

  const baselineBefore = digestKnowledgeRootMinusIndexes();
  const indexesBefore = snapshotIndexesRoot();
  fs.writeFileSync(path.join(EVIDENCE, 'baseline-before.json'), JSON.stringify({ knowledgeRootMinusIndexes: baselineBefore, indexesRoot: indexesBefore }, null, 2), 'utf8');

  // ---------------- FIX (the single authorized call) ----------------
  if (!record.hubBefore.listening) {
    record.repair = { attempted: false, reason: 'hub not listening on 8787 (OS-level check)', recoveryCommandForLeader: RECOVERY_COMMAND };
    record.overall = false;
    fs.writeFileSync(path.join(EVIDENCE, 'recovery-record.json'), JSON.stringify(record, null, 2), 'utf8');
    console.log(JSON.stringify(record, null, 2));
    process.exitCode = 2;
    return;
  }

  record.repair = {
    attempted: true, request: { project: COLLECTION, sourceDir: REAL_SOURCE_DIR },
    response: await singleRequest('POST', `${HUB_BASE}/api/sync`, { project: COLLECTION, sourceDir: REAL_SOURCE_DIR }),
  };
  const repairOk = record.repair.response.httpStatus === 200 && record.repair.response.json && record.repair.response.json.ok === true;
  record.repair.ok = repairOk;
  if (!repairOk) {
    record.repair.recoveryCommandForLeader = RECOVERY_COMMAND;
    record.overall = false;
    fs.writeFileSync(path.join(EVIDENCE, 'recovery-record.json'), JSON.stringify(record, null, 2), 'utf8');
    console.log(JSON.stringify({ repair: record.repair, overall: false }, null, 2));
    process.exitCode = 2;
    return;
  }

  // ---------------- POST ----------------
  const catalogAfter = readCatalog(COLLECTION_DIR);
  const collectionFilesAfter = walkFiles(COLLECTION_DIR);
  const markerHits = [];
  for (const file of collectionFilesAfter) {
    const text = fs.readFileSync(file, 'utf8');
    for (const m of FIXTURE_MARKERS) if (text.includes(m)) markerHits.push({ file: path.basename(file), marker: m });
  }
  const postHashes = copyTreeWithHashes(COLLECTION_DIR, path.join(LANE_DIR, 'post-recovery', COLLECTION));
  record.postRecoveryCopy = hashTreeToSums(postHashes, `post-recovery/${COLLECTION}/`, path.join(LANE_DIR, 'SHA256SUMS-post-recovery.txt'));

  const retrieval = await singleRequest('GET', `${HUB_BASE}/api/document?project=${encodeURIComponent(COLLECTION)}&uri=${encodeURIComponent(REAL_DOC_URI)}`);
  record.boundedRetrieval = {
    httpStatus: retrieval.httpStatus,
    uriInResponse: retrieval.json && retrieval.json.uri,
    textSha256: retrieval.json && typeof retrieval.json.text === 'string' ? sha256(Buffer.from(retrieval.json.text, 'utf8')) : null,
    textLength: retrieval.json && typeof retrieval.json.text === 'string' ? retrieval.json.text.length : null,
    docType: retrieval.json && retrieval.json.docType,
  };

  const baselineAfter = digestKnowledgeRootMinusIndexes();
  const indexesAfter = snapshotIndexesRoot();
  const rootDelta = diffMaps(baselineBefore, baselineAfter);
  const indexDelta = diffMaps(indexesBefore, indexesAfter);

  record.hubAfter = hubIdentity();

  record.postVerification = {
    catalogAfter,
    collectionFileCount: collectionFilesAfter.length,
    fixtureMarkerHits: markerHits,
    catalogPointsOnlyAtRealSource: catalogAfter.exists && catalogAfter.count === 1
      && catalogAfter.uris.length === 1 && catalogAfter.uris[0] === REAL_DOC_URI,
    countMatchesRealSource: catalogAfter.exists && catalogAfter.count === record.realSourceIdentity.fileCount,
    knowledgeRootMinusIndexesDelta: rootDelta,
    indexesRootDelta: indexDelta,
    sameHubInstance: record.hubBefore.listening && record.hubAfter.listening
      && record.hubBefore.processes[0].pid === record.hubAfter.processes[0].pid,
  };

  const onlyExpectedIndexChanges = indexDelta.every(d =>
    (d.path === COLLECTION && d.state === 'changed')
    || (d.path === '__manifest' && (d.state === 'changed' || d.state === 'created')));

  record.gates = {
    repairRequestOk: repairOk,
    catalogRealOnly: record.postVerification.catalogPointsOnlyAtRealSource && markerHits.length === 0,
    countMatches: record.postVerification.countMatchesRealSource,
    realKnowledgeUnchanged: rootDelta.length === 0,
    indexesScopedToThisCollection: onlyExpectedIndexChanges && indexDelta.some(d => d.path === COLLECTION),
    sameHubInstance: record.postVerification.sameHubInstance,
    boundedRetrievalOk: record.boundedRetrieval.httpStatus === 200 && record.boundedRetrieval.uriInResponse === REAL_DOC_URI,
  };
  record.finishedAt = new Date().toISOString();
  record.overall = Object.values(record.gates).every(Boolean);

  fs.writeFileSync(path.join(EVIDENCE, 'recovery-record.json'), JSON.stringify(record, null, 2), 'utf8');
  console.log(JSON.stringify({ repair: { ok: repairOk, filesTracked: record.repair.response.json.filesTracked }, gates: record.gates, overall: record.overall }, null, 2));
  process.exitCode = record.overall ? 0 : 1;
})().catch(error => {
  console.error(JSON.stringify({ fatal: String(error && error.stack || error) }, null, 2));
  process.exitCode = 3;
});
