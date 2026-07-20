// Job Orchestrator (TASK-010)
//
// Run modes for the server-side scheduler. Each mode produces a job record
// that is persisted to <KB_ROOT>/.jobs-log.json so the user can audit what ran
// and when.
//
// Modes:
//   * `scan`           — read-only: for each enabled project, call scanProject
//                        to update headCommit/lastSeenCommit/lastScanAt. Never
//                        invokes AI and never writes any drafts.
//   * `analyze-initial`— for each enabled project that has a KB but no
//                        trusted GOAL.md, run the initial-analysis
//                        orchestrator. Drafts land under _site/_ai/<slug>/drafts/.
//   * `analyze-commits`— for each enabled project with pending commits
//                        (scan.pendingCount > 0), run incremental commit
//                        analysis. Drafts land under _site/_ai/<slug>/drafts/.
//   * `safe`           — composite mode: scan + analyze-commits. This is the
//                        new default for the scheduled task. Crucially, it
//                        never calls apply, so AI drafts cannot become
//                        trusted knowledge without a human at the Drafts tab.
//
// All modes honor `slug` to scope a run to one project, or `ALL` (default)
// to iterate every enabled project.
//
// Job records are JSON-serializable and streamed to the caller via the job
// object passed in by the route handler (so the existing `runningJobs` map
// can be repurposed as a live status view).

const fs = require('fs');
const path = require('path');
const { scanProject, applyScanResult } = require('./scanner');
const { runCommitAnalysis } = require('./analysis-orchestrator');

const { getDataDir } = require('./data-dir');
const APP_ROOT = getDataDir();

const KNOWN_MODES = new Set(['scan', 'analyze-initial', 'analyze-commits', 'safe']);

function appendLine(job, line) {
  job.output = (job.output || '') + line + '\n';
  if (job.output.length > 200_000) {
    job.output = job.output.slice(-200_000);
  }
}

function appendJobLog(jobsLogPath, entry) {
  let arr = [];
  try { arr = JSON.parse(fs.readFileSync(jobsLogPath, 'utf-8')); } catch {}
  if (!Array.isArray(arr)) arr = [];
  arr.push(entry);
  // Keep at most the most recent 100 entries
  if (arr.length > 100) arr = arr.slice(-100);
  try { fs.writeFileSync(jobsLogPath, JSON.stringify(arr, null, 2) + '\n', 'utf-8'); } catch {}
}

function readJobLog(jobsLogPath) {
  if (!fs.existsSync(jobsLogPath)) return [];
  try { return JSON.parse(fs.readFileSync(jobsLogPath, 'utf-8')) || []; }
  catch { return []; }
}

function makeJob({ mode, slug }) {
  return {
    jobId: 'job-' + Date.now() + '-' + Math.floor(Math.random() * 10000),
    mode,
    slug: slug || 'ALL',
    startTime: new Date().toISOString(),
    endTime: null,
    status: 'running',
    exitCode: null,
    output: '',
    summary: null,
  };
}

function projectList(projects, slug) {
  // Return the live project objects (with a `slug` field guaranteed). The caller
  // may mutate them — `runScan` does, via `applyScanResult` — and those changes
  // should be visible in the projects map the caller passed in.
  if (slug && slug !== 'ALL') {
    if (!projects[slug]) throw new Error(`unknown slug: ${slug}`);
    return [{ slug, ...projects[slug] }];
  }
  return Object.keys(projects)
    .filter(s => projects[s].enabled !== false)
    .map(s => ({ slug: s, ...projects[s] }));
}

function defaultProjectKbPathFallback(slug) {
  return path.join(APP_ROOT, 'projects', slug);
}

async function runScan(projects, slug, job) {
  const list = projectList(projects, slug);
  let scanned = 0, errors = 0;
  for (const p of list) {
    const scan = await scanProject(p, { maxCommits: 200 });
    if (scan.error && scan.repoStatus !== 'ok' && scan.repoStatus !== 'empty') {
      appendLine(job, `[scan] ${p.slug} → ${scan.repoStatus}: ${scan.error}`);
      errors++;
    } else {
      // Mutate the original in the projects map so the caller sees the update.
      const target = projects[p.slug] || p;
      applyScanResult(target, scan);
      appendLine(job, `[scan] ${p.slug} → head ${(scan.headCommit || '?').slice(0, 7)} · ${scan.pendingCount} pending · mode ${scan.mode || '?'}`);
      scanned++;
    }
  }
  return { scanned, errors, total: list.length };
}

async function runInitial(projects, slug, job, options = {}) {
  const resolveKbPath = options.defaultProjectKbPath || defaultProjectKbPathFallback;
  const list = projectList(projects, slug);
  let skipped = 0;
  for (const p of list) {
    const kbPath = p.kbPath || resolveKbPath(p.slug);
    if (!fs.existsSync(kbPath)) { skipped++; appendLine(job, `[analyze-initial] ${p.slug} → skipped (no KB)`); continue; }
    // Initial draft generation was removed. Project owners author GOAL.md /
    // ARCHITECTURE.md themselves or in the embedded Claude terminal; this job
    // mode is kept as a no-op for job-log compatibility.
    skipped++;
    appendLine(job, `[analyze-initial] ${p.slug} → skipped (initial analysis removed; author goals manually or use terminal)`);
  }
  return { ran: 0, skipped, failed: 0, total: list.length };
}

async function runCommits(projects, slug, job, options = {}) {
  const resolveKbPath = options.defaultProjectKbPath || defaultProjectKbPathFallback;
  const list = projectList(projects, slug);
  let ran = 0, noop = 0, failed = 0;
  for (const p of list) {
    const kbPath = p.kbPath || resolveKbPath(p.slug);
    if (!fs.existsSync(kbPath)) { appendLine(job, `[analyze-commits] ${p.slug} → skipped (no KB)`); continue; }
    const result = await runCommitAnalysis({ slug: p.slug, ...p, kbPath });
    if (result.ok) {
      if (result.noop) { noop++; appendLine(job, `[analyze-commits] ${p.slug} → no pending commits`); }
      else { ran++; appendLine(job, `[analyze-commits] ${p.slug} → ${result.succeededCount}/${result.totalCommits} commits analyzed (${(result.runIds || []).length} runs)`); }
    } else { failed++; appendLine(job, `[analyze-commits] ${p.slug} → failed: ${result.error}`); }
  }
  return { ran, noop, failed, total: list.length };
}

async function runJob({ job, projects, projectsPath, jobsLogPath, writeProjects, defaultProjectKbPath }) {
  const runOptions = { defaultProjectKbPath };
  if (!job) throw new Error('job required');
  if (!KNOWN_MODES.has(job.mode)) {
    job.status = 'failed';
    job.endTime = new Date().toISOString();
    job.exitCode = 2;
    job.summary = { error: `unknown mode: ${job.mode}` };
    appendLine(job, `Unknown mode: ${job.mode}. Known: ${[...KNOWN_MODES].join(', ')}`);
    appendJobLog(jobsLogPath, job);
    return job;
  }
  const slug = job.slug || 'ALL';
  appendLine(job, `[start] mode=${job.mode} slug=${slug} at ${job.startTime}`);

  let summary = null;
  let exitCode = 0;
  try {
    if (job.mode === 'scan') {
      summary = await runScan(projects, slug, job);
      job.status = summary.errors > 0 ? 'partial' : 'success';
      exitCode = summary.errors > 0 ? 1 : 0;
    } else if (job.mode === 'analyze-initial') {
      summary = await runInitial(projects, slug, job, runOptions);
      job.status = summary.failed > 0 ? 'partial' : 'success';
      exitCode = summary.failed > 0 ? 1 : 0;
    } else if (job.mode === 'analyze-commits') {
      summary = await runCommits(projects, slug, job, runOptions);
      job.status = summary.failed > 0 ? 'partial' : 'success';
      exitCode = summary.failed > 0 ? 1 : 0;
    } else if (job.mode === 'safe') {
      // scan → analyze-commits. Crucially, no apply step.
      const scanSummary = await runScan(projects, slug, job);
      const commitSummary = await runCommits(projects, slug, job, runOptions);
      summary = { scan: scanSummary, commits: commitSummary, applied: 0 };
      const totalFailed = scanSummary.errors + commitSummary.failed;
      job.status = totalFailed > 0 ? 'partial' : 'success';
      exitCode = totalFailed > 0 ? 1 : 0;
      appendLine(job, `[safe] complete. applied drafts: 0 (review required).`);
    }
  } catch (e) {
    job.status = 'failed';
    exitCode = 1;
    summary = { error: e.message };
    appendLine(job, `[error] ${e.message}`);
  }

  job.endTime = new Date().toISOString();
  job.exitCode = exitCode;
  job.summary = summary;
  appendLine(job, `[end] status=${job.status} exitCode=${exitCode}`);

  // Persist any project-state changes (e.g. scan updated headCommit).
  if (writeProjects) {
    try { writeProjects(); } catch (e) { appendLine(job, `[warn] could not persist projects.json: ${e.message}`); }
  }
  appendJobLog(jobsLogPath, job);
  return job;
}

module.exports = {
  KNOWN_MODES,
  makeJob,
  runJob,
  readJobLog,
  appendJobLog,
  runScan,
  runInitial,
  runCommits,
};
