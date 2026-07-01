const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execGit } = require('./git-runner');
const aiWorkspace = require('./ai-workspace');
const {
  normalizeAutomationConfig,
  normalizeClaudeWorkbenchConfig,
  renderTemplate,
  pathsReferToSameLocation,
  buildAutomationToolPolicy,
} = require('./automation-config');
const { createAutomationQueue } = require('./automation-queue');

const AUTOMATION_RUNS_DIR = 'automation-runs';

// Per-project serial gate. Same project's automation runs serialize; different
// projects are completely independent. In-memory only — see cleanupOrphanedRuns
// for restart handling.
const queue = createAutomationQueue();
let endHookRegistered = false;

const AUTOMATION_SYSTEM_PROMPT = `You are the background KB automation worker for one registered project.

Hard rules:
- Work only on the current project knowledge base.
- Do not modify the source repository.
- Do not modify any other project knowledge base.
- Do not run write-capable or destructive Bash commands.
- If the configured mode is requestApproval, produce a reviewable proposal and do not edit files.
- If the configured mode allows writing, make conservative KB-only edits that are directly supported by the commit evidence.`;

function newRunId() {
  return `auto-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
}

function projectRepoPath(cfg) {
  return cfg && (cfg.gitPath || cfg.localPath || '');
}

function projectKbPath(slug, cfg, defaultProjectKbPath) {
  return cfg.kbPath || (typeof defaultProjectKbPath === 'function' ? defaultProjectKbPath(slug) : path.join(process.cwd(), 'projects', slug));
}

function findProjectForRepo(projects, repoPath) {
  if (!repoPath) return null;
  for (const [slug, cfg] of Object.entries(projects || {})) {
    const candidate = projectRepoPath(cfg);
    if (candidate && pathsReferToSameLocation(candidate, repoPath)) return { slug, cfg };
  }
  return null;
}

async function gitText(repoPath, args, fallback = '') {
  const r = await execGit(repoPath, args, 10000);
  if (!r.ok) return fallback;
  return (r.stdout || '').trim();
}

async function collectCommitMetadata(project, event = {}) {
  const repoPath = projectRepoPath(project);
  const requestedHash = event.commitHash || 'HEAD';
  const fullHash = await gitText(repoPath, ['rev-parse', requestedHash], requestedHash);
  const shortHash = await gitText(repoPath, ['rev-parse', '--short', fullHash], String(fullHash).slice(0, 7));
  const branch = event.branch || await gitText(repoPath, ['branch', '--show-current'], '');
  const raw = await gitText(repoPath, ['show', '-s', '--date=iso-strict', '--pretty=format:%H%n%h%n%an%n%ad%n%s', fullHash], '');
  const lines = raw.split(/\r?\n/);
  const subject = lines.slice(4).join('\n').trim();
  const changedFilesRaw = await gitText(repoPath, ['show', '--name-only', '--pretty=format:', '--no-renames', fullHash], '');
  const changedFiles = changedFilesRaw.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const diffSummary = await gitText(repoPath, ['show', '--stat', '--oneline', '--no-renames', '--format=short', fullHash], '');

  return {
    repoPath,
    branch,
    commitHash: lines[0] || fullHash,
    shortHash: lines[1] || shortHash,
    commitAuthor: lines[2] || '',
    commitDate: lines[3] || '',
    commitSubject: subject || '',
    changedFiles,
    diffSummary,
  };
}

function buildPromptVars({ slug, cfg, kbPath, automation, workbench, metadata }) {
  return {
    projectSlug: slug,
    displayName: cfg.displayName || slug,
    kbPath,
    repoPath: metadata.repoPath || projectRepoPath(cfg),
    branch: metadata.branch || '',
    commitHash: metadata.commitHash || '',
    shortHash: metadata.shortHash || '',
    commitSubject: metadata.commitSubject || '',
    commitAuthor: metadata.commitAuthor || '',
    commitDate: metadata.commitDate || '',
    changedFiles: (metadata.changedFiles || []).join('\n'),
    diffSummary: metadata.diffSummary || '',
    remoteUrl: metadata.remoteUrl || cfg.remoteUrl || '',
    primaryLanguage: cfg.primaryLanguage || '',
    tags: Array.isArray(cfg.tags) ? cfg.tags.join(', ') : String(cfg.tags || ''),
    sourceOverview: metadata.sourceOverview || '',
    knowledgeMode: automation.knowledgeMode,
    permissionMode: workbench.permissionMode,
  };
}

async function renderAutomationPrompt({ slug, cfg, event = {}, defaultProjectKbPath }) {
  const automation = normalizeAutomationConfig(cfg.automation);
  const workbench = normalizeClaudeWorkbenchConfig(cfg.claudeWorkbench);
  const kbPath = projectKbPath(slug, cfg, defaultProjectKbPath);
  const metadata = await collectCommitMetadata(cfg, event);
  const vars = buildPromptVars({ slug, cfg, kbPath, automation, workbench, metadata });
  return {
    ok: true,
    slug,
    kbPath,
    repoPath: metadata.repoPath,
    automation,
    workbench,
    metadata,
    prompt: renderTemplate(automation.hookPromptTemplate, vars),
    vars,
  };
}

async function sourceOverview(repoPath) {
  if (!repoPath || !fs.existsSync(repoPath)) return '';
  const tracked = await gitText(repoPath, ['ls-files'], '');
  const files = tracked
    ? tracked.split(/\r?\n/).map(s => s.trim()).filter(Boolean)
    : [];
  const picked = files.length ? files : (() => {
    const out = [];
    const walk = (dir, prefix = '', depth = 0) => {
      if (depth > 2 || out.length >= 120) return;
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        const rel = `${prefix}${entry.name}`;
        if (entry.isDirectory()) walk(path.join(dir, entry.name), `${rel}/`, depth + 1);
        else if (entry.isFile()) out.push(rel);
        if (out.length >= 120) break;
      }
    };
    walk(repoPath);
    return out;
  })();
  return picked.slice(0, 160).map(file => `- ${file}`).join('\n');
}

async function renderProjectInitPrompt({ slug, cfg, defaultProjectKbPath }) {
  const automation = normalizeAutomationConfig(cfg.automation);
  const workbench = normalizeClaudeWorkbenchConfig(cfg.claudeWorkbench);
  const kbPath = projectKbPath(slug, cfg, defaultProjectKbPath);
  const repoPath = projectRepoPath(cfg);
  const branch = await gitText(repoPath, ['branch', '--show-current'], cfg.currentBranch || '');
  const commitHash = await gitText(repoPath, ['rev-parse', 'HEAD'], cfg.headCommit || '');
  const remoteUrl = await gitText(repoPath, ['remote', 'get-url', 'origin'], cfg.remoteUrl || '');
  const metadata = {
    repoPath,
    branch,
    commitHash,
    shortHash: commitHash ? commitHash.slice(0, 7) : '',
    remoteUrl,
    changedFiles: [],
    diffSummary: '',
    sourceOverview: await sourceOverview(repoPath),
  };
  const vars = buildPromptVars({ slug, cfg, kbPath, automation, workbench, metadata });
  return {
    ok: true,
    slug,
    kbPath,
    repoPath,
    automation,
    workbench,
    metadata,
    prompt: renderTemplate(automation.initPromptTemplate, vars),
    vars,
  };
}

function automationRunsDir(slug) {
  return path.join(aiWorkspace.ensureProjectAIPath(slug), AUTOMATION_RUNS_DIR);
}

function writeAutomationRun(slug, record) {
  const dir = automationRunsDir(slug);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${record.runId}.json`);
  fs.writeFileSync(file, JSON.stringify(record, null, 2) + '\n', 'utf-8');
  return file;
}

function listAutomationRuns(slug, limit = 20) {
  const dir = automationRunsDir(slug);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(name => name.endsWith('.json'))
    .map(name => {
      try { return JSON.parse(fs.readFileSync(path.join(dir, name), 'utf-8')); }
      catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => String(b.startedAt || '').localeCompare(String(a.startedAt || '')))
    .slice(0, limit);
}

async function dispatchAutomation({ slug, cfg, event = {}, source = 'git-hook' }, deps) {
  const automation = normalizeAutomationConfig(cfg.automation);
  if (!automation.enabled || !automation.postCommitEnabled) {
    return { ok: true, skipped: true, reason: 'post-commit automation disabled', slug };
  }

  const rendered = await renderAutomationPrompt({ slug, cfg, event, defaultProjectKbPath: deps.defaultProjectKbPath });
  return dispatchRenderedAutomation({ slug, cfg, rendered, source }, deps);
}

async function dispatchProjectInit({ slug, cfg, source = 'project-init' }, deps) {
  const automation = normalizeAutomationConfig(cfg.automation);
  if (!automation.enabled) {
    return { ok: true, skipped: true, reason: 'automation disabled', slug };
  }
  const rendered = await renderProjectInitPrompt({ slug, cfg, defaultProjectKbPath: deps.defaultProjectKbPath });
  return dispatchRenderedAutomation({ slug, cfg, rendered, source }, deps);
}

async function dispatchRenderedAutomation({ slug, cfg, rendered, source }, deps) {
  _ensureEndHook(deps);
  const automation = normalizeAutomationConfig(cfg.automation);
  const workbench = rendered.workbench;
  const policy = buildAutomationToolPolicy({ automation, kbPath: rendered.kbPath });
  const runId = newRunId();
  const startedAt = new Date().toISOString();
  const record = {
    schema: 'kb-automation-run/v1',
    runId,
    projectSlug: slug,
    source,
    repoPath: rendered.repoPath,
    kbPath: rendered.kbPath,
    commitHash: rendered.metadata.commitHash,
    branch: rendered.metadata.branch,
    knowledgeMode: automation.knowledgeMode,
    permissionMode: workbench.permissionMode,
    status: 'dispatching',
    sessionId: null,
    startedAt,
    endedAt: null,
    error: null,
    promptPreview: rendered.prompt.slice(0, 2000),
    allowedTools: policy.allowedTools,
  };
  writeAutomationRun(slug, record);

  const profileCheck = deps.validateUsableAiProfile(cfg.aiProfileId);
  if (!profileCheck.ok) {
    record.status = 'failed';
    record.endedAt = new Date().toISOString();
    record.error = profileCheck.error;
    writeAutomationRun(slug, record);
    return { ok: false, status: profileCheck.status || 400, error: profileCheck.error, runId, slug };
  }

  const ctx = { slug, runId, cfg, record, rendered, automation, profileCheck, policy, workbench, source };

  if (queue.tryAcquire(slug, runId)) {
    return _startRun(ctx, deps);
  }

  if (!queue.enqueue(slug, runId, automation.maxQueueSize)) {
    record.status = 'abandoned';
    record.endedAt = new Date().toISOString();
    record.error = `queue full (max ${automation.maxQueueSize})`;
    writeAutomationRun(slug, record);
    return { ok: false, status: 429, error: record.error, runId, slug };
  }

  record.status = 'queued';
  writeAutomationRun(slug, record);
  return {
    ok: true,
    queued: true,
    slug,
    runId,
    sessionId: null,
    status: 'queued',
    queuePosition: queue.size(slug),
  };
}

function _startRun(ctx, deps) {
  try {
    const started = deps.startAutomationSession({
      slug: ctx.slug,
      projectPath: projectRepoPath(ctx.cfg),
      kbPath: ctx.rendered.kbPath,
      userPrompt: ctx.rendered.prompt,
      systemPrompt: AUTOMATION_SYSTEM_PROMPT,
      aiProfile: ctx.profileCheck.profile,
      permissionMode: ctx.workbench.permissionMode,
      allowedTools: ctx.policy.allowedTools,
      safetyPolicy: ctx.policy,
      metadata: {
        source: ctx.source,
        automation: true,
        automationRunId: ctx.runId,
        commitHash: ctx.rendered.metadata.commitHash,
        knowledgeMode: ctx.automation.knowledgeMode,
      },
    });
    ctx.record.status = 'dispatched';
    ctx.record.sessionId = started.sessionId || null;
    writeAutomationRun(ctx.slug, ctx.record);
    return { ok: true, slug: ctx.slug, runId: ctx.runId, sessionId: ctx.record.sessionId, status: 'dispatched', prompt: ctx.rendered.prompt };
  } catch (e) {
    ctx.record.status = 'failed';
    ctx.record.endedAt = new Date().toISOString();
    ctx.record.error = e.message;
    writeAutomationRun(ctx.slug, ctx.record);
    // No session was created, so onSessionEnded will never fire. Release the
    // slot manually and promote the next queued run.
    _advanceAfter(ctx.slug, deps, ctx.runId);
    return { ok: false, status: 500, error: e.message, runId: ctx.runId, slug: ctx.slug };
  }
}

async function _resumeQueuedRun(slug, runId, deps) {
  const record = _readAutomationRun(slug, runId);
  if (!record || record.status !== 'queued') return;
  const projects = typeof deps.readProjects === 'function' ? deps.readProjects() : deps.projects;
  const cfg = projects && projects[slug];
  if (!cfg) {
    record.status = 'abandoned';
    record.endedAt = new Date().toISOString();
    record.error = 'project disappeared while queued';
    writeAutomationRun(slug, record);
    return;
  }
  let rendered;
  try {
    rendered = record.source === 'project-init'
      ? await renderProjectInitPrompt({ slug, cfg, defaultProjectKbPath: deps.defaultProjectKbPath })
      : await renderAutomationPrompt({
          slug,
          cfg,
          event: { commitHash: record.commitHash, branch: record.branch },
          defaultProjectKbPath: deps.defaultProjectKbPath,
        });
  } catch (e) {
    record.status = 'failed';
    record.endedAt = new Date().toISOString();
    record.error = `re-render failed: ${e.message}`;
    writeAutomationRun(slug, record);
    _advanceAfter(slug, deps, runId);
    return;
  }
  const automation = normalizeAutomationConfig(cfg.automation);
  const workbench = normalizeClaudeWorkbenchConfig(cfg.claudeWorkbench);
  const policy = buildAutomationToolPolicy({ automation, kbPath: rendered.kbPath });
  const profileCheck = deps.validateUsableAiProfile(cfg.aiProfileId);
  record.status = 'dispatching';
  writeAutomationRun(slug, record);
  if (!profileCheck.ok) {
    record.status = 'failed';
    record.endedAt = new Date().toISOString();
    record.error = profileCheck.error;
    writeAutomationRun(slug, record);
    _advanceAfter(slug, deps, runId);
    return;
  }
  _startRun({ slug, runId, cfg, record, rendered, automation, profileCheck, policy, workbench, source: record.source || 'git-hook' }, deps);
}

function _advanceAfter(slug, deps, justFinishedRunId) {
  const nextRunId = queue.releaseAndNext(slug);
  if (nextRunId && nextRunId !== justFinishedRunId) {
    _resumeQueuedRun(slug, nextRunId, deps).catch(() => {
      const r = _readAutomationRun(slug, nextRunId);
      if (r) {
        r.status = 'failed';
        r.endedAt = new Date().toISOString();
        r.error = 'resume threw unexpectedly';
        writeAutomationRun(slug, r);
      }
      _advanceAfter(slug, deps, nextRunId);
    });
  }
}

function _readAutomationRun(slug, runId) {
  if (!slug || !runId) return null;
  const file = path.join(automationRunsDir(slug), `${runId}.json`);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
}

function _markRunEnded(slug, runId, session) {
  const r = _readAutomationRun(slug, runId);
  if (!r) return;
  r.sessionId = session.sessionId || r.sessionId;
  r.endedAt = session.endedAt || new Date().toISOString();
  r.exitCode = typeof session.exitCode === 'number' ? session.exitCode : null;
  if (session.state === 'aborted') {
    r.status = 'aborted';
  } else if (session.state === 'failed') {
    r.status = 'failed';
    r.error = session.error || 'claude session failed';
  } else {
    // idle — single automation turn completed. Treat as succeeded.
    r.status = session.exitCode === 0 || session.exitCode === null ? 'succeeded' : 'failed';
    if (r.status === 'failed' && !r.error) r.error = `non-zero exitCode (${session.exitCode})`;
  }
  writeAutomationRun(slug, r);
}

let _currentDepsRef = null;
let _registeredOnEnded = null;
function _ensureEndHook(deps) {
  _currentDepsRef = deps;
  if (typeof deps.onSessionEnded !== 'function') return;
  // Register at most once per `onSessionEnded` function identity. In
  // production this is a stable function reference (claudeCliRunner.onSessionEnded),
  // so registration happens exactly once. In tests with per-fixture lambdas,
  // re-registration is intentional and lets each fixture receive callbacks.
  if (_registeredOnEnded === deps.onSessionEnded) return;
  deps.onSessionEnded(session => {
    const d = _currentDepsRef;
    if (!d) return;
    const slug = session && session.projectSlug;
    const runId = session && session.metadata && session.metadata.automationRunId;
    if (!slug || !runId) return;
    _markRunEnded(slug, runId, session);
    _advanceAfter(slug, d, runId);
  });
  _registeredOnEnded = deps.onSessionEnded;
  endHookRegistered = true;
}

function getQueueSize(slug) {
  return queue.size(slug);
}

function drainQueue(slug) {
  const dropped = queue.drain(slug);
  const out = [];
  for (const runId of dropped) {
    const r = _readAutomationRun(slug, runId);
    if (!r) continue;
    r.status = 'abandoned';
    r.endedAt = new Date().toISOString();
    r.error = r.error || 'automation disabled while queued';
    writeAutomationRun(slug, r);
    out.push(runId);
  }
  return out;
}

function cleanupOrphanedRuns(projects) {
  const summary = { queued: 0, dispatched: 0, dispatching: 0 };
  for (const slug of Object.keys(projects || {})) {
    const runs = listAutomationRuns(slug, 500);
    for (const r of runs) {
      if (r.status === 'queued' || r.status === 'dispatched' || r.status === 'dispatching') {
        summary[r.status] = (summary[r.status] || 0) + 1;
        r.status = 'abandoned';
        r.endedAt = new Date().toISOString();
        r.error = r.error || 'server restart: in-memory queue/session lost';
        writeAutomationRun(slug, r);
      }
    }
  }
  return summary;
}

async function handlePostCommitEvent(event, deps) {
  const repoPath = event && event.repoPath;
  if (!repoPath) return { ok: false, status: 400, error: 'repoPath required' };
  const hit = findProjectForRepo(deps.projects, repoPath);
  if (!hit) return { ok: false, status: 404, error: `no project registered for repoPath: ${repoPath}` };
  return dispatchAutomation({ slug: hit.slug, cfg: hit.cfg, event, source: event.source || 'git-hook' }, deps);
}

module.exports = {
  AUTOMATION_RUNS_DIR,
  AUTOMATION_SYSTEM_PROMPT,
  findProjectForRepo,
  collectCommitMetadata,
  buildPromptVars,
  renderAutomationPrompt,
  renderProjectInitPrompt,
  writeAutomationRun,
  listAutomationRuns,
  dispatchAutomation,
  dispatchProjectInit,
  handlePostCommitEvent,
  cleanupOrphanedRuns,
  getQueueSize,
  drainQueue,
};
