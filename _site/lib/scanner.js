// Shared scanner used by the server and the analysis orchestrator.
const fs = require('fs');
const path = require('path');
const { execGit } = require('./git-runner');

async function scanProject(project, options = {}) {
  const { maxCommits = 200 } = options;
  const result = {
    slug: project && project.slug,
    repoStatus: 'unknown',
    headCommit: null,
    lastSeenCommit: project ? project.lastSeenCommit : null,
    lastAnalyzedCommit: project ? project.lastAnalyzedCommit : null,
    pendingCount: 0,
    mode: null,
    range: null,
    commits: [],
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
  const head = await execGit(targetPath, ['rev-parse', 'HEAD']);
  if (!head.ok) {
    result.repoStatus = 'empty';
    result.error = 'repository has no commits';
    return result;
  }
  result.headCommit = (head.stdout || '').trim() || null;
  result.repoStatus = 'ok';

  if (!project.lastAnalyzedCommit) {
    result.mode = 'initial';
    const logArgs = ['log', '--no-merges', `--max-count=${maxCommits}`, '--pretty=format:%H|%h|%ad|%an|%s', '--date=short'];
    const log = await execGit(targetPath, logArgs);
    if (log.ok) {
      const lines = (log.stdout || '').split('\n').filter(l => l.includes('|'));
      for (const line of lines) {
        const [hash, short, date, author, ...rest] = line.split('|');
        result.commits.push({ hash, short, date, author, subject: rest.join('|') });
      }
    } else {
      result.error = (log.stderr || log.error || 'git log failed').toString();
    }
    result.range = `HEAD~${result.commits.length}..HEAD`;
  } else {
    result.mode = 'incremental';
    const range = `${project.lastAnalyzedCommit}..${result.headCommit}`;
    result.range = range;
    const logArgs = ['log', '--no-merges', range, '--pretty=format:%H|%h|%ad|%an|%s', '--date=short'];
    const log = await execGit(targetPath, logArgs);
    if (log.ok) {
      const lines = (log.stdout || '').split('\n').filter(l => l.includes('|'));
      for (const line of lines) {
        const [hash, short, date, author, ...rest] = line.split('|');
        result.commits.push({ hash, short, date, author, subject: rest.join('|') });
      }
    } else {
      result.error = (log.stderr || log.error || 'git log failed').toString();
    }
  }

  result.pendingCount = result.commits.length;
  return result;
}

async function applyScanResult(project, scan) {
  project.headCommit = scan.headCommit;
  project.repoStatus = scan.repoStatus;
  project.lastSeenCommit = scan.headCommit || project.lastSeenCommit;
  project.lastScanAt = new Date().toISOString();
  project.lastScanPendingCount = scan.pendingCount;
  project.lastScanMode = scan.mode;
  project.lastScanError = scan.error || null;
  return project;
}

module.exports = { scanProject, applyScanResult };
