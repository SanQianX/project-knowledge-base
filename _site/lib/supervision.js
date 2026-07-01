const fs = require('fs');
const path = require('path');
const { scanProject } = require('./scanner');
const { validateKb } = require('./kb-validator');

function issue(id, projectSlug, level, source, message, meta = {}) {
  return {
    issueId: id,
    projectSlug: projectSlug || '',
    level,
    source,
    message,
    meta,
    detectedAt: new Date().toISOString(),
  };
}

function projectIssues(slug, cfg, kbPath) {
  const out = [];
  if (!cfg) return out;
  if (cfg.repoStatus && !['ok', 'empty', 'unknown'].includes(cfg.repoStatus)) {
    out.push(issue(`git-${slug}-${cfg.repoStatus}`, slug, 'error', 'git', `Git status is ${cfg.repoStatus}`, { error: cfg.lastScanError || '' }));
  }
  if (cfg.repoStatus === 'empty') {
    out.push(issue(`git-${slug}-empty`, slug, 'warn', 'git', 'Repository has no commits yet.'));
  }
  if (!fs.existsSync(kbPath)) {
    out.push(issue(`kb-${slug}-missing`, slug, 'error', 'kb', 'Knowledge base directory is missing.', { kbPath }));
  } else {
    const validation = validateKb(kbPath);
    if (!validation.ok) {
      out.push(issue(`kb-${slug}-invalid`, slug, 'error', 'kb', 'Knowledge base validation failed.', {
        errors: validation.errors || [],
      }));
    }
  }
  if (!cfg.lastAnalyzedCommit) {
    out.push(issue(`analysis-${slug}-not-started`, slug, 'warn', 'analysis', 'Project has not been analyzed yet.'));
  }
  if ((cfg.lastScanPendingCount || 0) > 0) {
    out.push(issue(`analysis-${slug}-pending`, slug, 'warn', 'analysis', `${cfg.lastScanPendingCount} pending commits need analysis.`, {
      pendingCount: cfg.lastScanPendingCount,
    }));
  }
  return out;
}

function jobIssues(history = []) {
  const out = [];
  for (const job of history || []) {
    if (!['failed', 'partial'].includes(job.status)) continue;
    out.push(issue(`job-${job.jobId}`, job.slug, job.status === 'failed' ? 'error' : 'warn', 'automation', `${job.mode} job ${job.status}.`, {
      jobId: job.jobId,
      mode: job.mode,
      summary: job.summary || null,
    }));
  }
  return out;
}

async function pendingCommits(projects, resolveKbPath) {
  const items = [];
  for (const [slug, cfg] of Object.entries(projects || {})) {
    if (cfg.enabled === false) continue;
    const scan = await scanProject({ slug, ...cfg }, { maxCommits: 200 });
    items.push({
      slug,
      displayName: cfg.displayName || slug,
      sourcePath: cfg.gitPath || cfg.localPath || '',
      kbPath: resolveKbPath(slug, cfg),
      repoStatus: scan.repoStatus,
      mode: scan.mode,
      range: scan.range,
      headCommit: scan.headCommit,
      lastAnalyzedCommit: scan.lastAnalyzedCommit,
      pendingCount: scan.pendingCount,
      commits: scan.commits || [],
      error: scan.error || null,
    });
  }
  return items;
}

function summary(projects, runningJobs, issues) {
  const list = Object.values(projects || {});
  const pending = list.reduce((sum, cfg) => sum + Number(cfg.lastScanPendingCount || 0), 0);
  return {
    projects: list.length,
    runningJobs: (runningJobs || []).length,
    pendingCommits: pending,
    recentIssues: (issues || []).filter(item => ['warn', 'error'].includes(item.level)).length,
  };
}

module.exports = {
  projectIssues,
  jobIssues,
  pendingCommits,
  summary,
};
