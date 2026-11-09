'use strict';
// _site/_test/helpers/parallel-memory-capture-r3-shell.js
//
// Lane helper for the P-MEMORY-CAPTURE-R3 batch.
//
// The P-MEMORY-01 harness (helpers/parallel-memory-shell.js) and the two
// stand-ins it drives are FROZEN and owned by the Leader. This lane REUSES
// them READ-ONLY: they are imported, never edited, never copied over, and
// their SHA-256 is written into every evidence file, so a later integration
// by the Leader is detectable instead of silent.
//
// What this helper adds on top of the frozen harness:
//   * provenance()      - the frozen sources this lane depends on;
//   * sourceFingerprint()- a comparable fingerprint of ONE frozen memory
//     source: the promoted entry file on disk, the Git commit it came from
//     and the frozen conversation event;
//   * memoryFrozenFields()/compareFrozen() - the subset of a memory record
//     that an ignore action must never rewrite;
//   * engineStateOnDisk()- the engine's own persisted projection, so
//     "the status survived a reload" can be proven at rest and not only
//     through a live in-memory projection.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const FROZEN_SOURCES = [
  { piece: 'memory lane harness (reused read-only)', file: require.resolve('./parallel-memory-shell') },
  { piece: 'memory lane stand-in analyzer (reused read-only)', file: require.resolve('./parallel-memory-analyzer') },
  { piece: 'memory lane event-bridge stand-in (reused read-only)', file: require.resolve('./parallel-memory-event-bridge') },
];

function sha256File(file) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); } catch { return null; }
}

function sha256Text(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex');
}

function relativeToRoot(file) {
  return path.relative(path.resolve(__dirname, '..', '..', '..'), file).replace(/\\/g, '/');
}

/** The frozen sources this lane depends on, with the hash of each file. */
function provenance() {
  return FROZEN_SOURCES.map(source => ({
    piece: source.piece,
    source: relativeToRoot(source.file),
    sourceSha256: sha256File(source.file),
    sourceExists: fs.existsSync(source.file),
    usage: 'imported read-only; never edited by this lane',
  }));
}

function gitText(cwd, args) {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) return null;
  return String(result.stdout || '').trim();
}

/**
 * A comparable fingerprint of the frozen source of one memory candidate.
 *
 * The three artefacts are the ones the product shows as 来源依据: the
 * promoted entry file, the commit it was promoted from and the frozen
 * conversation event. A later comparison proves that ignoring the candidate
 * rewrote none of them.
 */
function sourceFingerprint({ knowledgePath, entryId, repoPath, commitSha, eventId, events }) {
  const entryFile = entryId && knowledgePath ? path.resolve(knowledgePath, entryId) : null;
  const entry = { path: entryFile, exists: false, sha256: null, bytes: null };
  if (entryFile && fs.existsSync(entryFile)) {
    const bytes = fs.readFileSync(entryFile);
    entry.exists = true;
    entry.sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    entry.bytes = bytes.length;
  }
  const git = { commitSha: commitSha || null, commitExists: false, tree: null };
  if (repoPath && commitSha) {
    git.commitExists = gitText(repoPath, ['cat-file', '-t', commitSha]) === 'commit';
    git.tree = gitText(repoPath, ['rev-parse', `${commitSha}^{tree}`]);
  }
  const found = (events || []).find(event => event.eventId === eventId) || null;
  const event = found ? {
    eventId: found.eventId,
    contentHash: found.contentHash,
    inputOrigin: found.inputOrigin,
    role: found.role || null,
  } : null;
  return { entry, git, event };
}

/**
 * The part of a memory record that an ignore action must never rewrite.
 *
 * The status is deliberately NOT part of it: ignoring is exactly the action
 * that changes the status, and the engine itself refuses any other field.
 */
function memoryFrozenFields(memory) {
  if (!memory) return null;
  return {
    id: memory.id,
    text: memory.text,
    evidence: {
      projectId: memory.evidence ? memory.evidence.projectId : null,
      commitSha: memory.evidence ? memory.evidence.commitSha : null,
      entryId: memory.evidence ? memory.evidence.entryId : null,
      quote: memory.evidence ? memory.evidence.quote : null,
    },
    sourceEventId: memory.sourceEventId || null,
    sourceHash: memory.sourceHash || null,
    eligibility: memory.eligibility || null,
  };
}

/** Compare the frozen source of one memory before and after an action. */
function compareFrozen(before, after) {
  const diffs = [];
  const same = (label, left, right) => {
    const equal = JSON.stringify(left) === JSON.stringify(right);
    if (!equal) diffs.push(label);
    return equal;
  };
  const entrySha256Same = same('entry.sha256', before.source.entry.sha256, after.source.entry.sha256);
  const entryBytesSame = same('entry.bytes', before.source.entry.bytes, after.source.entry.bytes);
  const gitTreeSame = same('git.tree', before.source.git.tree, after.source.git.tree);
  const gitCommitSame = same('git.commitSha', before.source.git.commitSha, after.source.git.commitSha);
  const eventHashSame = same('event.contentHash', before.source.event && before.source.event.contentHash, after.source.event && after.source.event.contentHash);
  const eventIdSame = same('event.eventId', before.source.event && before.source.event.eventId, after.source.event && after.source.event.eventId);
  const memorySame = same('memory.frozenFields', before.memory, after.memory);
  return {
    identical: diffs.length === 0,
    diffs,
    entrySha256Same,
    entryBytesSame,
    gitTreeSame,
    gitCommitSame,
    eventHashSame,
    eventIdSame,
    memoryFrozenFieldsSame: memorySame,
  };
}

/**
 * The engine's own persisted projection, read from its state file.
 *
 * This is the "at rest" truth: a live projection could be an in-memory
 * artefact of a running process, the file is what survives a restart.
 */
function engineStateOnDisk(engine) {
  const file = engine && engine.store ? engine.store.file : null;
  if (!file || !fs.existsSync(file)) return { file, exists: false, memories: [] };
  let parsed = null;
  try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { parsed = null; }
  return {
    file,
    exists: true,
    sha256: sha256File(file),
    memories: parsed && Array.isArray(parsed.memories) ? parsed.memories : [],
  };
}

module.exports = {
  FROZEN_SOURCES,
  sha256File,
  sha256Text,
  relativeToRoot,
  provenance,
  gitText,
  sourceFingerprint,
  memoryFrozenFields,
  compareFrozen,
  engineStateOnDisk,
};
