const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execGit } = require('./git-runner');
const { scanProject, applyScanResult } = require('./scanner');
const aiWorkspace = require('./ai-workspace');
const {
  normalizeAutomationConfig,
  normalizeClaudeWorkbenchConfig,
  renderTemplate,
  pathsReferToSameLocation,
  buildAutomationToolPolicy,
} = require('./automation-config');
const { createAutomationQueue } = require('./automation-queue');
const commitStore = require('./commit-automation-store');

const AUTOMATION_RUNS_DIR = 'automation-runs';

// Per-project serial gate. Same project's automation runs serialize; different
// projects are completely independent. In-memory only — see cleanupOrphanedRuns
// for restart handling.
const queue = createAutomationQueue();
const reconcileLocks = new Map();
let endHookRegistered = false;

const AUTOMATION_SYSTEM_PROMPT = `You are the background KB automation worker for one registered project.

Hard rules:
- Work only on the current project knowledge base.
- Do not modify the source repository.
- Do not modify any other project knowledge base.
- Do not run write-capable or destructive Bash commands.
- Apply the knowledge-base update directly; there is no draft or human review stage.
- Make conservative KB-only edits that are directly supported by this single commit.`;

const KNOWLEDGE_HYGIENE_INSTRUCTIONS = `

知识库结构维护硬规则：
- 不要创建、修改或追加任何 00-index.md；它们是系统完整重建的派生文件。
- 更新 README、ARCHITECTURE 或 modules 文档时，必须在原有章节中就地替换已经过时的描述，并删除被新事实取代的旧描述；不要在文件末尾重复追加同名章节、完整旧正文或多行 Updated 元数据。
- 提交历史只写入对应的 changes 文档；模块文档只保留当前有效状态，并通过 changes 文档保留历史。
- 保持 Markdown frontmatter、标题层级和代码围栏完整；不要为了“保留历史”复制整段重复内容。`;

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
  const hadTrackingBaseline = !!(project.lastAnalyzedCommit || project.trackingStartCommit);
  const requestedHash = event.commitHash || 'HEAD';
  const fullHash = await gitText(repoPath, ['rev-parse', requestedHash], requestedHash);
  const shortHash = await gitText(repoPath, ['rev-parse', '--short', fullHash], String(fullHash).slice(0, 7));
  const branch = event.branch || await gitText(repoPath, ['branch', '--show-current'], '');
  const raw = await gitText(repoPath, ['show', '-s', '--date=iso-strict', '--pretty=format:%H%n%h%n%an%n%ad%n%s', fullHash], '');
  const lines = raw.split(/\r?\n/);
  const subject = lines.slice(4).join('\n').trim();
  const resolvedHash = lines[0] || fullHash;
  const commit = {
    hash: resolvedHash,
    short: lines[1] || shortHash,
    date: lines[3] || '',
    author: lines[2] || '',
    subject: subject || '',
  };
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
    repoStatus: /^[0-9a-f]{40}$/i.test(resolvedHash) ? 'ok' : 'unknown',
    commitRange: resolvedHash,
    pendingCommitCount: 1,
    pendingCommits: [`${commit.short} ${commit.date} ${commit.author} ${commit.subject}`.trim()],
    headCommitAtRun: resolvedHash,
    lastAnalyzedCommitBefore: project.lastAnalyzedCommit || null,
    trackingStartCommit: project.trackingStartCommit || null,
    baselineWasMissing: !hadTrackingBaseline,
    commit,
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
    repoStatus: metadata.repoStatus || '',
    commitRange: metadata.commitRange || '',
    pendingCommitCount: metadata.pendingCommitCount || 0,
    pendingCommits: (metadata.pendingCommits || []).join('\n'),
    trackingStartCommit: metadata.trackingStartCommit || '',
    lastAnalyzedCommitBefore: metadata.lastAnalyzedCommitBefore || '',
    baselineWasMissing: metadata.baselineWasMissing ? 'true' : 'false',
    remoteUrl: metadata.remoteUrl || cfg.remoteUrl || '',
    primaryLanguage: cfg.primaryLanguage || '',
    tags: Array.isArray(cfg.tags) ? cfg.tags.join(', ') : String(cfg.tags || ''),
    sourceOverview: metadata.sourceOverview || '',
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
    prompt: `${renderTemplate(automation.hookPromptTemplate, vars).trimEnd()}${KNOWLEDGE_HYGIENE_INSTRUCTIONS}\n`,
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
    prompt: `${renderTemplate(automation.initPromptTemplate, vars).trimEnd()}${KNOWLEDGE_HYGIENE_INSTRUCTIONS}\n`,
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
  const temp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(record, null, 2) + '\n', 'utf-8');
  fs.renameSync(temp, file);
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
  if (typeof deps.writeProjects === 'function') {
    try { deps.writeProjects(deps.projects); } catch {}
  }
  if (rendered.metadata.repoStatus !== 'ok') {
    return { ok: false, status: 400, error: `commit not found: ${event.commitHash || 'HEAD'}`, slug };
  }
  return dispatchRenderedAutomation({ slug, cfg, rendered, source }, deps);
}

async function _reconcileProjectUnlocked(slug, cfg, deps, source) {
  const projects = deps.projects || {};
  const scan = await scanProject({ slug, ...cfg }, { maxCommits: 200 });
  if (scan.repoStatus !== 'ok') {
    return { slug, ok: false, error: scan.error || `git status ${scan.repoStatus}` };
  }
  applyScanResult(cfg, scan);
  // scanner.scanProject() exposes commits in chronological order. Persist and
  // dispatch them in exactly that order: one source commit maps to one task.
  const chronological = [...(scan.commits || [])];
  commitStore.discover(slug, chronological, scan.headCommit);
  const results = [];
  for (const commit of commitStore.pending(slug)) {
    const result = await dispatchAutomation({
      slug,
      cfg,
      event: { commitHash: commit.hash, branch: cfg.currentBranch || '' },
      source,
    }, { ...deps, projects });
    results.push({ commitHash: commit.hash, result });
    if (!result.ok) break;
  }
  const summary = commitStore.summary(slug);
  cfg.lastScanPendingCount = summary.pending;
  cfg.commitAutomation = summary;
  if (typeof deps.writeProjects === 'function') {
    try { deps.writeProjects(projects); } catch {}
  }
  const dispatched = results.filter(item => item.result && item.result.ok && !item.result.skipped).length;
  return { slug, ok: true, discovered: chronological.length, dispatched, results, summary };
}

async function reconcileProject(slug, cfg, deps, source = 'startup-recovery') {
  const previous = reconcileLocks.get(slug) || Promise.resolve();
  const current = previous
    .catch(() => {})
    .then(() => _reconcileProjectUnlocked(slug, cfg, deps, source));
  reconcileLocks.set(slug, current);
  try {
    return await current;
  } finally {
    if (reconcileLocks.get(slug) === current) reconcileLocks.delete(slug);
  }
}

async function dispatchPendingAutomations(_options = {}, deps) {
  const projects = typeof deps.readProjects === 'function' ? deps.readProjects() : deps.projects;
  const results = [];
  if (!projects || typeof projects !== 'object') {
    return { ok: true, dispatched: 0, results };
  }

  for (const [slug, cfg] of Object.entries(projects)) {
    if (!cfg || cfg.enabled === false) continue;
    const result = await reconcileProject(slug, cfg, { ...deps, projects }, 'startup-recovery');
    results.push(result);
  }

  return { ok: true, dispatched: results.reduce((sum, item) => sum + Number(item.dispatched || 0), 0), results };
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
    permissionMode: workbench.permissionMode,
    status: 'dispatching',
    sessionId: null,
    startedAt,
    endedAt: null,
    error: null,
    commitRange: rendered.metadata.commitRange || '',
    pendingCommitCount: rendered.metadata.pendingCommitCount || 0,
    headCommitAtRun: rendered.metadata.headCommitAtRun || rendered.metadata.commitHash || null,
    lastAnalyzedCommitBefore: rendered.metadata.lastAnalyzedCommitBefore || null,
    trackingStartCommit: rendered.metadata.trackingStartCommit || null,
    promptPreview: rendered.prompt.slice(0, 2000),
    allowedTools: policy.allowedTools,
  };
  if (source !== 'project-init') {
    const claimed = commitStore.claim(slug, rendered.metadata.commit, runId);
    if (!claimed.ok) {
      return {
        ok: true,
        skipped: true,
        reason: claimed.reason,
        slug,
        commitHash: rendered.metadata.commitHash,
      };
    }
  }
  writeAutomationRun(slug, record);

  const profileCheck = deps.validateUsableAiProfile(cfg.aiProfileId);
  if (!profileCheck.ok) {
    record.status = 'failed';
    record.endedAt = new Date().toISOString();
    record.error = profileCheck.error;
    writeAutomationRun(slug, record);
    if (source !== 'project-init') {
      commitStore.markFailed(slug, record.commitHash, record.error, { runId });
    }
    return { ok: false, status: profileCheck.status || 400, error: profileCheck.error, runId, slug };
  }

  const ctx = { slug, runId, cfg, record, rendered, automation, profileCheck, policy, workbench, source };

  if (queue.tryAcquire(slug, runId)) {
    return _startRun(ctx, deps);
  }

  if (!queue.enqueue(slug, runId)) {
    record.status = 'abandoned';
    record.endedAt = new Date().toISOString();
    record.error = 'automation queue rejected the commit';
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
        headCommitAtRun: ctx.rendered.metadata.headCommitAtRun || ctx.rendered.metadata.commitHash,
        commitRange: ctx.rendered.metadata.commitRange || '',
      },
    });
    ctx.record.status = 'dispatched';
    ctx.record.sessionId = started.sessionId || null;
    writeAutomationRun(ctx.slug, ctx.record);
    if (ctx.source !== 'project-init') {
      commitStore.markRunning(ctx.slug, ctx.record.commitHash, {
        runId: ctx.runId,
        sessionId: ctx.record.sessionId,
      });
    }
    return { ok: true, slug: ctx.slug, runId: ctx.runId, sessionId: ctx.record.sessionId, status: 'dispatched', prompt: ctx.rendered.prompt };
  } catch (e) {
    ctx.record.status = 'failed';
    ctx.record.endedAt = new Date().toISOString();
    ctx.record.error = e.message;
    writeAutomationRun(ctx.slug, ctx.record);
    if (ctx.source !== 'project-init') {
      commitStore.markFailed(ctx.slug, ctx.record.commitHash, e.message, { runId: ctx.runId });
    }
    // No session was created, so onSessionEnded will never fire. Release the
    // slot manually and promote the next queued run.
    _pauseAfterFailure(ctx.slug, deps, ctx.runId);
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
    if (typeof deps.writeProjects === 'function') {
      try { deps.writeProjects(projects); } catch {}
    }
  } catch (e) {
    record.status = 'failed';
    record.endedAt = new Date().toISOString();
    record.error = `re-render failed: ${e.message}`;
    writeAutomationRun(slug, record);
    if (record.source !== 'project-init') {
      commitStore.markFailed(slug, record.commitHash, record.error, { runId });
    }
    _pauseAfterFailure(slug, deps, runId);
    return;
  }
  const automation = normalizeAutomationConfig(cfg.automation);
  const workbench = normalizeClaudeWorkbenchConfig(cfg.claudeWorkbench);
  const policy = buildAutomationToolPolicy({ automation, kbPath: rendered.kbPath });
  const profileCheck = deps.validateUsableAiProfile(cfg.aiProfileId);
  record.repoPath = rendered.repoPath;
  record.kbPath = rendered.kbPath;
  record.commitHash = rendered.metadata.commitHash;
  record.branch = rendered.metadata.branch;
  record.permissionMode = workbench.permissionMode;
  record.commitRange = rendered.metadata.commitRange || '';
  record.pendingCommitCount = rendered.metadata.pendingCommitCount || 0;
  record.headCommitAtRun = rendered.metadata.headCommitAtRun || rendered.metadata.commitHash || null;
  record.lastAnalyzedCommitBefore = rendered.metadata.lastAnalyzedCommitBefore || null;
  record.trackingStartCommit = rendered.metadata.trackingStartCommit || null;
  record.promptPreview = rendered.prompt.slice(0, 2000);
  record.allowedTools = policy.allowedTools;
  record.status = 'dispatching';
  writeAutomationRun(slug, record);
  if (!profileCheck.ok) {
    record.status = 'failed';
    record.endedAt = new Date().toISOString();
    record.error = profileCheck.error;
    writeAutomationRun(slug, record);
    if (record.source !== 'project-init') {
      commitStore.markFailed(slug, record.commitHash, record.error, { runId });
    }
    _pauseAfterFailure(slug, deps, runId);
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
        if (r.source !== 'project-init' && r.commitHash) {
          commitStore.markFailed(slug, r.commitHash, r.error, { runId: nextRunId });
        }
      }
      _pauseAfterFailure(slug, deps, nextRunId);
    });
  }
}

function _pauseAfterFailure(slug, deps, failedRunId) {
  const queuedRunIds = queue.drain(slug);
  for (const runId of queuedRunIds) {
    const record = _readAutomationRun(slug, runId);
    if (!record) continue;
    record.status = 'abandoned';
    record.endedAt = new Date().toISOString();
    record.error = `waiting for failed predecessor ${failedRunId}`;
    writeAutomationRun(slug, record);
    if (record.source !== 'project-init' && record.commitHash) {
      commitStore.markDiscovered(slug, record.commitHash, record.error);
    }
  }
  queue.releaseAndNext(slug);
  const projects = typeof deps.readProjects === 'function' ? deps.readProjects() : deps.projects;
  if (projects && projects[slug]) {
    const summary = commitStore.summary(slug);
    projects[slug].lastScanPendingCount = summary.pending;
    projects[slug].commitAutomation = summary;
    if (typeof deps.writeProjects === 'function') {
      try { deps.writeProjects(projects); } catch {}
    }
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

function _markRunEnded(slug, runId, session, deps) {
  const r = _readAutomationRun(slug, runId);
  if (!r) return null;
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
  if (r.source !== 'project-init') {
    if (r.status === 'succeeded') {
      commitStore.markCompleted(slug, r.commitHash, { runId, sessionId: r.sessionId });
    } else {
      commitStore.markFailed(slug, r.commitHash, r.error || r.status, { runId, sessionId: r.sessionId });
    }
  }
  if (r.status === 'succeeded') {
    if (r.source !== 'project-init' && r.headCommitAtRun) {
      try {
        const projects = typeof deps.readProjects === 'function' ? deps.readProjects() : deps.projects;
        if (projects && projects[slug]) {
          projects[slug].lastAnalyzedCommit = r.headCommitAtRun;
          const knownHead = projects[slug].headCommit || projects[slug].lastSeenCommit || null;
          const shouldAdvanceVisibleHead = !knownHead
            || knownHead === r.headCommitAtRun
            || knownHead === r.lastAnalyzedCommitBefore;
          if (shouldAdvanceVisibleHead) {
            projects[slug].lastSeenCommit = r.headCommitAtRun;
            projects[slug].headCommit = r.headCommitAtRun;
          }
          if (!projects[slug].trackingStartCommit && r.trackingStartCommit) {
            projects[slug].trackingStartCommit = r.trackingStartCommit;
            projects[slug].trackingStartedAt = projects[slug].trackingStartedAt || r.startedAt || new Date().toISOString();
          }
          const summary = commitStore.summary(slug);
          projects[slug].lastScanPendingCount = summary.pending;
          projects[slug].commitAutomation = summary;
          if (typeof deps.writeProjects === 'function') deps.writeProjects(projects);
        }
      } catch {}
    }
    if (typeof deps.onKnowledgeUpdated === 'function') {
      Promise.resolve(deps.onKnowledgeUpdated(slug, r)).then(result => {
        const latest = _readAutomationRun(slug, runId);
        if (!latest) return;
        latest.vectorIndex = { status: 'succeeded', endedAt: new Date().toISOString(), result: result || null };
        writeAutomationRun(slug, latest);
      }).catch(error => {
        const latest = _readAutomationRun(slug, runId);
        if (!latest) return;
        latest.vectorIndex = { status: 'failed', endedAt: new Date().toISOString(), error: error.message };
        writeAutomationRun(slug, latest);
      });
    }
  }
  return r.status;
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
    const status = _markRunEnded(slug, runId, session, d);
    if (status === 'succeeded') _advanceAfter(slug, d, runId);
    else if (status) _pauseAfterFailure(slug, d, runId);
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
  const summary = { queued: 0, dispatched: 0, dispatching: 0, recoveredCommits: 0 };
  for (const slug of Object.keys(projects || {})) {
    summary.recoveredCommits += commitStore.recoverInterrupted(slug);
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
  const projects = typeof deps.readProjects === 'function' ? deps.readProjects() : deps.projects;
  const hit = findProjectForRepo(projects, repoPath);
  if (!hit) return { ok: false, status: 404, error: `no project registered for repoPath: ${repoPath}` };
  const automation = normalizeAutomationConfig(hit.cfg.automation);
  if (!automation.enabled || !automation.postCommitEnabled) {
    return { ok: true, skipped: true, reason: 'post-commit automation disabled', slug: hit.slug };
  }
  // A real Hook event is authoritative: when an older/manual project has no
  // tracking baseline yet, start at the new commit's parent so this commit is
  // not mistaken for the initial baseline and silently skipped.
  if (!hit.cfg.lastAnalyzedCommit && !hit.cfg.trackingStartCommit) {
    const commitRef = event.commitHash || 'HEAD';
    const parent = await gitText(projectRepoPath(hit.cfg), ['rev-parse', `${commitRef}^`], '');
    if (/^[0-9a-f]{40}$/i.test(parent)) {
      hit.cfg.trackingStartCommit = parent;
      hit.cfg.trackingStartedAt = new Date().toISOString();
      if (typeof deps.writeProjects === 'function') {
        try { deps.writeProjects(projects); } catch {}
      }
    }
  }
  const result = await reconcileProject(
    hit.slug,
    hit.cfg,
    { ...deps, projects },
    event.source || 'git-hook'
  );
  return { ...result, commitHash: event.commitHash || null };
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
  dispatchPendingAutomations,
  reconcileProject,
  handlePostCommitEvent,
  cleanupOrphanedRuns,
  getQueueSize,
  drainQueue,
};
