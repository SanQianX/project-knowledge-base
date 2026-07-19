// Shared scanner used by the server and the analysis orchestrator.
const fs = require('fs');
const path = require('path');
const { execGit } = require('./git-runner');

async function scanProject(project, options = {}) {
  const { maxCommits = 200, headCommit = null } = options;
  const result = {
    slug: project && project.slug,
    repoStatus: 'unknown',
    headCommit: null,
    lastSeenCommit: project ? project.lastSeenCommit : null,
    lastAnalyzedCommit: project ? project.lastAnalyzedCommit : null,
    trackingStartCommit: project ? project.trackingStartCommit : null,
    pendingCount: 0,
    mode: null,
    range: null,
    commits: [],
    filteredTeamAnalyzedCount: 0,
    teamKnowledgeSync: null,
    error: null,
  };
  if (!project) { result.error = 'no project'; return result; }

  const targetPath = project.gitPath || project.localPath;
  if (!targetPath) {
    result.repoStatus = 'missing-path';
    result.error = 'no git path configured';
    return result;
  }
  if (!fs.existsSync(targetPath)) {
    result.repoStatus = 'missing-path';
    result.error = `path not found: ${targetPath}`;
    return result;
  }
  const inside = await execGit(targetPath, ['rev-parse', '--is-inside-work-tree']);
  if (!inside.ok || (inside.stdout || '').trim() !== 'true') {
    result.repoStatus = 'not-git';
    result.error = 'not a git repository';
    return result;
  }
  const headRef = headCommit || 'HEAD';
  const head = await execGit(targetPath, ['rev-parse', `${headRef}^{commit}`]);
  if (!head.ok) {
    result.repoStatus = 'empty';
    result.error = 'repository has no commits';
    return result;
  }
  result.headCommit = (head.stdout || '').trim() || null;
  result.repoStatus = 'ok';
  if (project.knowledgeMode === 'team') {
    result.teamKnowledgeSync = await syncTeamKnowledgeStore(project);
  }

  const rangeStart = project.lastAnalyzedCommit || project.trackingStartCommit || null;
  if (!rangeStart) {
    result.mode = 'tracking-start';
    result.trackingStartCommit = result.headCommit;
    result.range = `${result.headCommit}..${result.headCommit}`;
  } else {
    result.mode = project.lastAnalyzedCommit ? 'incremental' : 'tracked';
    result.trackingStartCommit = project.trackingStartCommit || result.trackingStartCommit || rangeStart;
    const range = `${rangeStart}..${result.headCommit}`;
    result.range = range;
    // Git is the durable automation queue. Always expose pending commits in
    // chronological order so a per-project worker can process exactly one
    // commit at a time without inventing a second persisted queue.
    const logArgs = ['log', '--reverse', '--no-merges', range, '--pretty=format:%H|%h|%ad|%an|%s', '--date=short'];
    const log = await execGit(targetPath, logArgs);
    if (log.ok) {
      const lines = (log.stdout || '').split('\n').filter(l => l.includes('|'));
      for (const line of lines) {
        const [hash, short, date, author, ...rest] = line.split('|');
        result.commits.push({ hash, short, date, author, subject: rest.join('|') });
      }
      if (project.knowledgeMode === 'team') {
        const analyzed = readTeamAnalyzedCommits(project.kbPath);
        if (analyzed.full.size || analyzed.short.size) {
          const before = result.commits.length;
          result.commits = result.commits.filter(commit => !isKnownTeamCommit(commit, analyzed));
          result.filteredTeamAnalyzedCount = before - result.commits.length;
        }
      }
    } else {
      result.error = (log.stderr || log.error || 'git log failed').toString();
    }
  }

  result.pendingCount = result.commits.length;
  return result;
}

function readTeamAnalyzedCommits(kbPath) {
  const analyzed = { full: new Set(), short: new Set() };
  if (!kbPath) return analyzed;
  const changesDir = path.join(kbPath, 'changes');
  if (!fs.existsSync(changesDir)) return analyzed;
  let entries = [];
  try {
    entries = fs.readdirSync(changesDir, { withFileTypes: true });
  } catch {
    return analyzed;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md') || entry.name === '00-index.md') continue;
    const stem = path.basename(entry.name, '.md').toLowerCase();
    if (/^[0-9a-f]{7,40}$/.test(stem)) {
      if (stem.length === 40) analyzed.full.add(stem);
      else analyzed.short.add(stem);
    }
    try {
      const text = fs.readFileSync(path.join(changesDir, entry.name), 'utf-8');
      const frontmatterCommit = text.match(/^commit:\s*['"]?([0-9a-f]{7,40})['"]?\s*$/im);
      if (frontmatterCommit) {
        const value = frontmatterCommit[1].toLowerCase();
        if (value.length === 40) analyzed.full.add(value);
        else analyzed.short.add(value);
      }
    } catch {}
  }
  return analyzed;
}

async function syncTeamKnowledgeStore(project) {
  const storePath = project.kbStorePath || '';
  if (!storePath) return { ok: true, skipped: true, reason: 'no team KB store path' };
  if (!fs.existsSync(storePath)) return { ok: false, skipped: true, error: `team KB store path not found: ${storePath}` };
  const inside = await execGit(storePath, ['rev-parse', '--is-inside-work-tree']);
  if (!inside.ok || (inside.stdout || '').trim() !== 'true') {
    return { ok: true, skipped: true, reason: 'team KB store is not a git repository' };
  }
  const branch = String(project.kbStoreBranch || '').trim();
  const pullArgs = branch ? ['pull', '--ff-only', 'origin', branch] : ['pull', '--ff-only'];
  const pull = await execGit(storePath, pullArgs, 60000);
  if (!pull.ok) {
    return { ok: false, skipped: false, error: (pull.stderr || pull.error || 'git pull failed').toString() };
  }
  return { ok: true, skipped: false };
}

function isKnownTeamCommit(commit, analyzed) {
  const full = String(commit && commit.hash || '').toLowerCase();
  const short = String(commit && commit.short || full.slice(0, 7)).toLowerCase();
  if (full && analyzed.full.has(full)) return true;
  if (short && analyzed.short.has(short)) return true;
  for (const knownShort of analyzed.short) {
    if (full.startsWith(knownShort)) return true;
  }
  return false;
}

async function applyScanResult(project, scan) {
  project.headCommit = scan.headCommit;
  project.repoStatus = scan.repoStatus;
  if (!project.trackingStartCommit && scan.trackingStartCommit) {
    project.trackingStartCommit = scan.trackingStartCommit;
    project.trackingStartedAt = project.trackingStartedAt || new Date().toISOString();
  }
  project.lastSeenCommit = scan.headCommit || project.lastSeenCommit;
  project.lastScanAt = new Date().toISOString();
  project.lastScanPendingCount = scan.pendingCount;
  project.lastScanMode = scan.mode;
  project.lastScanError = scan.error || null;
  return project;
}

module.exports = { scanProject, applyScanResult };
