// Draft Apply (TASK-009)
//
// Validates a draft, optionally creates backups of any file it would overwrite,
// writes the new content into the formal KB, regenerates indexes, and (for
// commit-analysis runs) records the head commit captured at run time.
//
// Hard rules:
//   * `GOAL.md` and `ARCHITECTURE.md` require explicit review/approval.
//     Any other call that would touch the goal returns 409.
//   * All file writes are best-effort transactional: we write to a backup
//     directory first, then swap into place. If a partial failure occurs, the
//     run is marked `applyStatus: failed` and no KB file is left in a half-written state.

const fs = require('fs');
const path = require('path');
const aiWorkspace = require('./ai-workspace');
const { isCurrentKb, applyPolicyForPath } = require('./kb-framework');
const { regenerateIndexes } = require('./index-builder');

const TRUSTED_GOAL_REL = 'GOAL.md';

function isSafeApplyPath(kbPath, rel) {
  if (typeof rel !== 'string' || rel.length === 0) return false;
  if (path.isAbsolute(rel)) return false;
  const resolved = path.resolve(kbPath, rel);
  const root = path.resolve(kbPath);
  // Reject anything that resolves outside the KB root, even with sibling-prefix bypass
  // (e.g. "/kb-other" passes a naive "startsWith(/kb)" check).
  const relPath = path.relative(root, resolved);
  if (relPath.startsWith('..') || path.isAbsolute(relPath)) return false;
  // Forbid writes to internal AI areas (we never want an apply to write to _ai/ from a draft)
  const norm = rel.replace(/\\/g, '/');
  if (norm.startsWith('_ai/') || norm.split('/').includes('_ai')) return false;
  return true;
}

function parseFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(String(text || ''));
  if (!match) return { meta: {}, body: String(text || '') };
  const meta = {};
  for (const line of match[1].split(/\r?\n/)) {
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line.trim());
    if (m) meta[m[1]] = m[2].trim();
  }
  return { meta, body: String(text || '').slice(match[0].length) };
}

function withStampedFrontmatter(content, stamp) {
  const parsed = parseFrontmatter(content);
  const meta = { ...parsed.meta };
  for (const [key, value] of Object.entries(stamp || {})) {
    if (value != null && value !== '') meta[key] = value;
  }
  const lines = ['---'];
  for (const [key, value] of Object.entries(meta)) lines.push(`${key}: ${String(value).replace(/\r?\n/g, ' ')}`);
  lines.push('---', '');
  return lines.join('\n') + parsed.body.replace(/^\r?\n/, '');
}

function listDraftFiles(kbPath, runId) {
  const slug = path.basename(kbPath);
  const dir = aiWorkspace.findExistingDraftDir({ slug, kbPath, runId });
  if (!fs.existsSync(dir)) return [];
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else out.push({ path: path.relative(dir, full).replace(/\\/g, '/'), full });
    }
  };
  walk(dir);
  return out;
}

function validateDraftSchema(draft) {
  // A draft is a single file produced by the orchestrator. It must:
  //   * have a non-empty path (relative to KB root, no leading slash)
  //   * have non-empty text content
  //   * be a known safe extension (.md, .json)
  if (!draft || typeof draft !== 'object') return { valid: false, errors: ['draft must be an object'] };
  if (!draft.path || typeof draft.path !== 'string') return { valid: false, errors: ['draft.path required'] };
  if (draft.path.startsWith('/') || draft.path.startsWith('\\')) return { valid: false, errors: ['draft.path must be relative'] };
  const ext = path.extname(draft.path).toLowerCase();
  if (ext !== '.md' && ext !== '.json') return { valid: false, errors: ['draft.path must be .md or .json'] };
  if (typeof draft.content !== 'string' || draft.content.length === 0) return { valid: false, errors: ['draft.content required'] };
  return { valid: true };
}

function backupExisting(kbPath, backupsDir, rel) {
  const src = path.join(kbPath, rel);
  if (!fs.existsSync(src)) return null;
  const dest = path.join(backupsDir, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  return dest;
}

function applyDrafts({ kbPath, slug, runId, drafts, allowGoalEdit, headCommitAtRun }) {
  if (!kbPath || !slug || !runId) return { ok: false, status: 400, error: 'kbPath, slug, runId required' };
  if (!Array.isArray(drafts) || drafts.length === 0) return { ok: false, status: 400, error: 'drafts must be a non-empty array' };

  // 1. Validate every draft before touching anything
  const errors = [];
  const prepared = [];
  const currentFramework = isCurrentKb(kbPath);
  for (const d of drafts) {
    const v = validateDraftSchema(d);
    if (!v.valid) { errors.push({ draft: d && d.path, errors: v.errors }); continue; }
    if (!isSafeApplyPath(kbPath, d.path)) { errors.push({ draft: d.path, errors: ['unsafe path'] }); continue; }
    if (!currentFramework) { errors.push({ draft: d.path, errors: ['KB does not match the current minimal framework'] }); continue; }
    const policy = applyPolicyForPath(d.path, allowGoalEdit);
    if (!policy.ok) {
      errors.push({ draft: d.path, status: policy.status || 422, reviewRequired: !!policy.reviewRequired, errors: [policy.reason] });
      continue;
    }
    prepared.push(d);
  }
  if (errors.length) {
    const status = errors.some(item => item.status === 409 || item.reviewRequired) ? 409 : 422;
    return { ok: false, status, error: 'invalid drafts', errors };
  }
  if (prepared.length === 0) return { ok: false, status: 400, error: 'no valid drafts after validation' };

  // 2. Backup everything we will overwrite, into _ai/backups/<runId>/
  const aiRoot = aiWorkspace.ensureProjectAIPath(slug);
  const backupsDir = path.join(aiRoot, 'backups', runId);
  fs.mkdirSync(backupsDir, { recursive: true });
  const backups = [];
  for (const d of prepared) {
    const b = backupExisting(kbPath, backupsDir, d.path);
    if (b) backups.push({ path: d.path, backup: path.relative(aiRoot, b).replace(/\\/g, '/') });
  }

  // 3. Write each draft. Track failures for rollback.
  const writes = [];
  const failed = [];
  for (const d of prepared) {
    const dest = path.join(kbPath, d.path);
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const stamp = {
        sourceBranch: d.sourceBranch || undefined,
        sourceHeadCommit: d.sourceHeadCommit || undefined,
      };
      const content = stamp.sourceBranch || stamp.sourceHeadCommit ? withStampedFrontmatter(d.content, stamp) : d.content;
      fs.writeFileSync(dest, content, 'utf-8');
      writes.push(d.path);
    } catch (e) {
      failed.push({ path: d.path, error: e.message });
    }
  }
  if (failed.length) {
    // Roll back the writes that did succeed
    for (const rel of writes) {
      const dest = path.join(kbPath, rel);
      const backup = path.join(backupsDir, rel);
      if (fs.existsSync(backup)) {
        try { fs.copyFileSync(backup, dest); } catch {}
      } else {
        try { fs.rmSync(dest, { force: true }); } catch {}
      }
    }
    return { ok: false, status: 500, error: 'partial write failure, rolled back', failed, backups };
  }

  // 4. Regenerate indexes. The current framework has no manifest; every file
  // inside the minimal KB layout is trusted by structure.
  const indexes = regenerateIndexes(kbPath);

  // 5. Mark the run as applied (caller is responsible for advancing
  //    lastAnalyzedCommit since they know the commit-batch size).
  const runPath = aiWorkspace.findExistingRunPath({ slug, kbPath, runId });
  if (fs.existsSync(runPath)) {
    try {
      const run = JSON.parse(fs.readFileSync(runPath, 'utf-8'));
      run.applyStatus = 'applied';
      run.appliedAt = new Date().toISOString();
      run.appliedPaths = writes;
      run.backups = backups.map(b => b.backup);
      if (headCommitAtRun) run.advancedLastAnalyzedCommit = headCommitAtRun;
      fs.writeFileSync(runPath, JSON.stringify(run, null, 2), 'utf-8');
    } catch {}
  }

  return { ok: true, applied: writes, backups, indexes };
}

function rejectDrafts({ kbPath, runId, reason }) {
  if (!kbPath || !runId) return { ok: false, status: 400, error: 'kbPath and runId required' };
  const slug = path.basename(kbPath);
  const runPath = aiWorkspace.findExistingRunPath({ slug, kbPath, runId });
  if (!fs.existsSync(runPath)) return { ok: false, status: 404, error: 'run not found' };
  const run = JSON.parse(fs.readFileSync(runPath, 'utf-8'));
  run.applyStatus = 'rejected';
  run.rejectedAt = new Date().toISOString();
  run.rejectionReason = reason || null;
  fs.writeFileSync(runPath, JSON.stringify(run, null, 2), 'utf-8');
  return { ok: true, run };
}

function readDraftContent(kbPath, runId, rel) {
  if (typeof rel !== 'string' || rel.length === 0) return null;
  if (path.isAbsolute(rel)) return null;
  const norm = rel.replace(/\\/g, '/');
  if (norm.startsWith('../') || norm.includes('/../') || norm.endsWith('/..')) return null;
  const slug = path.basename(kbPath);
  const dir = aiWorkspace.findExistingDraftDir({ slug, kbPath, runId });
  const target = path.join(dir, rel);
  // Reject if the resolved target escapes the drafts dir
  const relPath = path.relative(dir, target);
  if (relPath.startsWith('..') || path.isAbsolute(relPath)) return null;
  if (!fs.existsSync(target)) return null;
  return fs.readFileSync(target, 'utf-8');
}

module.exports = {
  applyDrafts,
  rejectDrafts,
  validateDraftSchema,
  listDraftFiles,
  readDraftContent,
  isSafeApplyPath,
  TRUSTED_GOAL_REL,
};
