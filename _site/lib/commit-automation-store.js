const fs = require('fs');
const path = require('path');
const aiWorkspace = require('./ai-workspace');

const FILE_NAME = 'commit-automation-state.json';
const SCHEMA = 'commit-automation-state/v1';
const ACTIVE = new Set(['queued', 'running']);

function statePath(slug) {
  return path.join(aiWorkspace.ensureProjectAIPath(slug), FILE_NAME);
}

function emptyState(slug) {
  return {
    schema: SCHEMA,
    projectSlug: slug,
    updatedAt: new Date().toISOString(),
    lastReconciledHead: null,
    commits: {},
  };
}

function readState(slug) {
  const file = statePath(slug);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (!parsed || parsed.schema !== SCHEMA || typeof parsed.commits !== 'object') {
      return emptyState(slug);
    }
    return parsed;
  } catch {
    return emptyState(slug);
  }
}

function writeState(slug, state) {
  const file = statePath(slug);
  const next = {
    ...state,
    schema: SCHEMA,
    projectSlug: slug,
    updatedAt: new Date().toISOString(),
  };
  const temp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, 'utf-8');
  fs.renameSync(temp, file);
  return next;
}

function normalizeCommit(commit) {
  const hash = String(commit && commit.hash || '').trim();
  if (!/^[0-9a-f]{40}$/i.test(hash)) return null;
  return {
    hash,
    short: commit.short || hash.slice(0, 7),
    date: commit.date || '',
    author: commit.author || '',
    subject: commit.subject || '',
  };
}

function discover(slug, commits, headCommit = null) {
  const state = readState(slug);
  const now = new Date().toISOString();
  let added = 0;
  for (const raw of commits || []) {
    const commit = normalizeCommit(raw);
    if (!commit || state.commits[commit.hash]) continue;
    state.commits[commit.hash] = {
      ...commit,
      status: 'discovered',
      attempts: 0,
      discoveredAt: now,
      startedAt: null,
      completedAt: null,
      failedAt: null,
      runId: null,
      sessionId: null,
      error: null,
    };
    added += 1;
  }
  if (headCommit) state.lastReconciledHead = headCommit;
  writeState(slug, state);
  return { state, added };
}

function claim(slug, commit, runId) {
  const normalized = normalizeCommit(commit);
  if (!normalized) return { ok: false, reason: 'invalid commit hash' };
  const state = readState(slug);
  const existing = state.commits[normalized.hash];
  if (existing && (existing.status === 'completed' || ACTIVE.has(existing.status))) {
    return { ok: false, reason: `commit already ${existing.status}`, record: existing };
  }
  const now = new Date().toISOString();
  state.commits[normalized.hash] = {
    ...(existing || {}),
    ...normalized,
    status: 'queued',
    attempts: Number(existing && existing.attempts || 0) + 1,
    discoveredAt: existing && existing.discoveredAt || now,
    startedAt: null,
    completedAt: existing && existing.completedAt || null,
    failedAt: null,
    runId,
    sessionId: null,
    error: null,
  };
  writeState(slug, state);
  return { ok: true, record: state.commits[normalized.hash] };
}

function updateCommit(slug, hash, patch) {
  const state = readState(slug);
  if (!state.commits[hash]) return null;
  state.commits[hash] = { ...state.commits[hash], ...patch };
  writeState(slug, state);
  return state.commits[hash];
}

function markRunning(slug, hash, { runId, sessionId } = {}) {
  return updateCommit(slug, hash, {
    status: 'running',
    runId: runId || null,
    sessionId: sessionId || null,
    startedAt: new Date().toISOString(),
    error: null,
  });
}

function markCompleted(slug, hash, { runId, sessionId } = {}) {
  return updateCommit(slug, hash, {
    status: 'completed',
    runId: runId || null,
    sessionId: sessionId || null,
    completedAt: new Date().toISOString(),
    failedAt: null,
    error: null,
  });
}

function markFailed(slug, hash, error, { runId, sessionId } = {}) {
  return updateCommit(slug, hash, {
    status: 'failed',
    runId: runId || null,
    sessionId: sessionId || null,
    failedAt: new Date().toISOString(),
    error: String(error || 'automation failed'),
  });
}

function markDiscovered(slug, hash, error = null) {
  return updateCommit(slug, hash, {
    status: 'discovered',
    runId: null,
    sessionId: null,
    startedAt: null,
    error: error ? String(error) : null,
  });
}

function recoverInterrupted(slug) {
  const state = readState(slug);
  const now = new Date().toISOString();
  let recovered = 0;
  for (const record of Object.values(state.commits)) {
    if (!ACTIVE.has(record.status)) continue;
    record.status = 'discovered';
    record.failedAt = now;
    record.error = 'server restarted before the automation completed';
    record.runId = null;
    record.sessionId = null;
    recovered += 1;
  }
  if (recovered) writeState(slug, state);
  return recovered;
}

function pending(slug) {
  const state = readState(slug);
  return Object.values(state.commits)
    .filter(record => record.status === 'discovered' || record.status === 'failed')
    .sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));
}

function summary(slug) {
  const counts = { discovered: 0, queued: 0, running: 0, completed: 0, failed: 0 };
  for (const record of Object.values(readState(slug).commits)) {
    counts[record.status] = (counts[record.status] || 0) + 1;
  }
  counts.pending = counts.discovered + counts.queued + counts.running + counts.failed;
  return counts;
}

module.exports = {
  FILE_NAME,
  SCHEMA,
  statePath,
  readState,
  discover,
  claim,
  markRunning,
  markCompleted,
  markFailed,
  markDiscovered,
  recoverInterrupted,
  pending,
  summary,
};
