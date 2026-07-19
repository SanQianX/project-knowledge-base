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

const AUTOMATION_RUNS_DIR = 'automation-runs';
const AUTOMATION_WORKSPACES_DIR = 'automation-workspaces';

// Per-project serial gate. Same project's automation runs serialize; different
// projects are completely independent. In-memory only — see cleanupOrphanedRuns
// for restart handling.
const queue = createAutomationQueue();
const wakeLocks = new Map();
const indexRetryTimers = new Map();
let endHookRegistered = false;

const AUTOMATION_SYSTEM_PROMPT = `You are the background KB automation worker for one registered project.

Hard rules:
- Work only on the current project knowledge base.
- Do not modify the source repository.
- Do not modify any other project knowledge base.
- Do not run write-capable or destructive Bash commands.
- If the configured mode is requestApproval, produce a reviewable proposal and do not edit files.
- If the configured mode allows writing, make conservative KB-only edits that are directly supported by the commit evidence.`;

const KNOWLEDGE_HYGIENE_INSTRUCTIONS = `

知识库结构维护硬规则：
- 不要创建、修改或追加任何 00-index.md；它们是系统完整重建的派生文件。
- 每次自动分析只处理一个 Git commit，并必须为该 commit 创建或完善一份独立 changes Markdown；文件名必须包含当前短哈希，正文或 frontmatter 必须包含当前完整哈希。测试、文档和基础设施提交也不能省略此记录。
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
  const scanOptions = { maxCommits: 200 };
  if (event.analysisHeadCommit) scanOptions.headCommit = event.analysisHeadCommit;
  const scan = await scanProject(project, scanOptions);
  if (scan && scan.repoStatus === 'ok' && !event.analysisHeadCommit) {
    await applyScanResult(project, scan);
  }
  const requestedHash = scan && scan.headCommit || event.commitHash || 'HEAD';
  const fullHash = await gitText(repoPath, ['rev-parse', requestedHash], requestedHash);
  const shortHash = await gitText(repoPath, ['rev-parse', '--short', fullHash], String(fullHash).slice(0, 7));
  const branch = event.branch || await gitText(repoPath, ['branch', '--show-current'], '');
  const raw = await gitText(repoPath, ['show', '-s', '--date=iso-strict', '--pretty=format:%H%n%h%n%an%n%ad%n%s', fullHash], '');
  const lines = raw.split(/\r?\n/);
  const subject = lines.slice(4).join('\n').trim();
  const pendingCommits = scan && Array.isArray(scan.commits) ? scan.commits : [];
  const range = scan && scan.range || '';
  const changedFilesRaw = pendingCommits.length && range
    ? await gitText(repoPath, ['diff', '--name-only', '--no-renames', range], '')
    : await gitText(repoPath, ['show', '--name-only', '--pretty=format:', '--no-renames', fullHash], '');
  const changedFiles = changedFilesRaw.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const diffSummary = pendingCommits.length && range
    ? await gitText(repoPath, ['log', '--stat', '--oneline', '--no-renames', range], '')
    : await gitText(repoPath, ['show', '--stat', '--oneline', '--no-renames', '--format=short', fullHash], '');

  return {
    repoPath,
    branch,
    commitHash: lines[0] || fullHash,
    shortHash: lines[1] || shortHash,
    commitAuthor: lines[2] || '',
    commitDate: lines[3] || '',
    commitSubject: pendingCommits.length > 1 ? `${pendingCommits.length} pending commits through ${shortHash}` : subject || '',
    changedFiles,
    diffSummary,
    repoStatus: scan && scan.repoStatus || 'unknown',
    commitRange: range,
    pendingCommitCount: pendingCommits.length,
    pendingCommits: pendingCommits.map(c => `${c.short || String(c.hash || '').slice(0, 7)} ${c.date || ''} ${c.author || ''} ${c.subject || ''}`.trim()),
    headCommitAtRun: scan && scan.headCommit || lines[0] || fullHash,
    lastAnalyzedCommitBefore: project.lastAnalyzedCommit || null,
    trackingStartCommit: project.trackingStartCommit || scan && scan.trackingStartCommit || null,
    baselineWasMissing: !hadTrackingBaseline,
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

function automationWorkspaceDir(slug, runId) {
  return path.join(aiWorkspace.ensureProjectAIPath(slug), AUTOMATION_WORKSPACES_DIR, runId);
}

function shouldCopyKnowledgePath(sourcePath) {
  const segments = path.resolve(sourcePath).split(path.sep).map(value => value.toLowerCase());
  return !segments.some(segment => ['.git', '_ai', '_backup', 'knowledge.lancedb'].includes(segment));
}

function prepareKnowledgeWorkspace(slug, runId, liveKbPath) {
  const root = automationWorkspaceDir(slug, runId);
  const stagingKbPath = path.join(root, 'staging');
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(stagingKbPath, { recursive: true });
  if (liveKbPath && fs.existsSync(liveKbPath)) {
    fs.cpSync(liveKbPath, stagingKbPath, {
      recursive: true,
      force: true,
      filter: shouldCopyKnowledgePath,
    });
  }
  return { root, stagingKbPath };
}

function listKnowledgeFiles(root) {
  const files = [];
  if (!root || !fs.existsSync(root)) return files;
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (['.git', '_ai', '_backup', 'knowledge.lancedb'].includes(entry.name.toLowerCase())) continue;
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile()) files.push(path.relative(root, absolute).replace(/\\/g, '/'));
    }
  };
  walk(root);
  return files.sort();
}

function fileHash(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function validateCommitChangeRecord(stagingKbPath, commitHash) {
  const full = String(commitHash || '').trim().toLowerCase();
  const short = full.slice(0, 7);
  const changesDir = path.join(stagingKbPath, 'changes');
  if (!full || !fs.existsSync(changesDir)) {
    throw new Error(`missing changes record for commit ${full || '(unknown)'}`);
  }
  const matches = listKnowledgeFiles(changesDir).filter(relativePath => {
    if (!relativePath.toLowerCase().endsWith('.md')) return false;
    if (!path.basename(relativePath).toLowerCase().includes(short)) return false;
    try { return fs.readFileSync(path.join(changesDir, relativePath), 'utf8').toLowerCase().includes(full); }
    catch { return false; }
  });
  if (!matches.length) {
    throw new Error(`changes record must include full commit ${full} and ${short} in its filename`);
  }
  return matches.map(relativePath => `changes/${relativePath.replace(/\\/g, '/')}`);
}

function applyKnowledgeWorkspace(record) {
  const stagingKbPath = record.stagingKbPath;
  const liveKbPath = record.liveKbPath;
  if (!stagingKbPath || !liveKbPath) return { changed: [], changeRecords: [] };
  const changeRecords = validateCommitChangeRecord(stagingKbPath, record.commitHash);
  const stagedFiles = listKnowledgeFiles(stagingKbPath);
  const changed = stagedFiles.filter(relativePath => {
    if (!relativePath.toLowerCase().endsWith('.md')) return false;
    if (path.basename(relativePath).toLowerCase() === '00-index.md') return false;
    return fileHash(path.join(stagingKbPath, relativePath)) !== fileHash(path.join(liveKbPath, relativePath));
  });
  const backupRoot = path.join(path.dirname(stagingKbPath), 'backup');
  const applied = [];
  try {
    for (const relativePath of changed) {
      const source = path.join(stagingKbPath, relativePath);
      const target = path.join(liveKbPath, relativePath);
      const backup = path.join(backupRoot, relativePath);
      const existed = fs.existsSync(target);
      if (existed) {
        fs.mkdirSync(path.dirname(backup), { recursive: true });
        fs.copyFileSync(target, backup);
      }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
      fs.copyFileSync(source, temp);
      fs.renameSync(temp, target);
      applied.push({ relativePath, existed, backup });
    }
  } catch (error) {
    for (const item of applied.reverse()) {
      const target = path.join(liveKbPath, item.relativePath);
      try {
        if (item.existed) fs.copyFileSync(item.backup, target);
        else fs.rmSync(target, { force: true });
      } catch {}
    }
    throw error;
  }
  return { changed, changeRecords };
}

function discardKnowledgeWorkspace(record) {
  if (!record || !record.stagingKbPath) return;
  try { fs.rmSync(path.dirname(record.stagingKbPath), { recursive: true, force: true }); } catch {}
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
  if (automation.paused) {
    return { ok: true, skipped: true, reason: 'post-commit automation paused', slug };
  }

  const rendered = await renderAutomationPrompt({ slug, cfg, event, defaultProjectKbPath: deps.defaultProjectKbPath });
  if (typeof deps.writeProjects === 'function') {
    try { deps.writeProjects(deps.projects); } catch {}
  }
  if (rendered.metadata.repoStatus === 'ok' && !rendered.metadata.baselineWasMissing && (rendered.metadata.pendingCommitCount || 0) === 0) {
    return { ok: true, skipped: true, reason: 'no pending commits', slug, scan: {
      range: rendered.metadata.commitRange || '',
      headCommit: rendered.metadata.headCommitAtRun || null,
      trackingStartCommit: rendered.metadata.trackingStartCommit || null,
    } };
  }
  return dispatchRenderedAutomation({ slug, cfg, rendered, source }, deps);
}

async function wakeProjectAutomation(slug, triggerEvent = {}, deps) {
  const previous = wakeLocks.get(slug) || Promise.resolve();
  const current = previous.catch(() => {}).then(async () => {
    const projects = typeof deps.readProjects === 'function' ? deps.readProjects() : deps.projects;
    const cfg = projects && projects[slug];
    if (!cfg || cfg.enabled === false) return { ok: true, skipped: true, reason: 'project disabled', slug };
    const automation = normalizeAutomationConfig(cfg.automation);
    if (!automation.enabled || !automation.postCommitEnabled) {
      return { ok: true, skipped: true, reason: 'post-commit automation disabled', slug };
    }
    if (automation.paused) return { ok: true, skipped: true, reason: 'post-commit automation paused', slug };
    if (queue.isActive(slug)) return { ok: true, busy: true, reason: 'project automation already running', slug };
    const pendingIndex = listAutomationRuns(slug, 100).find(run => ['indexing', 'index-pending'].includes(run.status));
    if (pendingIndex) {
      scheduleIndexRetry(slug, pendingIndex.runId, deps, 250);
      return { ok: true, busy: true, reason: 'project vector finalization is pending', slug, runId: pendingIndex.runId };
    }

    const scan = await scanProject({ slug, ...cfg }, { maxCommits: 200 });
    if (scan.repoStatus === 'ok') {
      await applyScanResult(cfg, scan);
      if (typeof deps.writeProjects === 'function') {
        try { deps.writeProjects(projects); } catch {}
      }
    }
    if (scan.repoStatus !== 'ok' || scan.pendingCount === 0) {
      return { ok: scan.repoStatus === 'ok', skipped: true, reason: scan.error || 'no pending commits', slug, scan };
    }

    const nextCommit = scan.commits[0];
    return dispatchAutomation({
      slug,
      cfg,
      event: {
        ...triggerEvent,
        commitHash: nextCommit.hash,
        analysisHeadCommit: nextCommit.hash,
        branch: triggerEvent.branch || cfg.currentBranch || '',
      },
      source: triggerEvent.source || 'pending-sweep',
    }, { ...deps, projects });
  });
  wakeLocks.set(slug, current);
  try { return await current; }
  finally { if (wakeLocks.get(slug) === current) wakeLocks.delete(slug); }
}

async function dispatchPendingAutomations({ triggerSlug = null, triggerEvent = {} } = {}, deps) {
  const projects = typeof deps.readProjects === 'function' ? deps.readProjects() : deps.projects;
  const results = [];
  let dispatched = 0;
  for (const [slug, cfg] of Object.entries(projects || {})) {
    if (!cfg || cfg.enabled === false) continue;
    const result = await wakeProjectAutomation(slug, {
      ...(slug === triggerSlug ? triggerEvent : {}),
      source: slug === triggerSlug ? (triggerEvent.source || 'git-hook') : 'pending-sweep',
    }, deps);
    if (result && result.status === 'dispatched') dispatched += 1;
    results.push({ slug, result });
  }
  return { ok: true, dispatched, results };
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
  const runId = newRunId();
  const startedAt = new Date().toISOString();
  const liveKbPath = rendered.kbPath;
  let stagingKbPath = null;
  if (source !== 'project-init' && ['autoApply', 'directWriteKb'].includes(automation.knowledgeMode)) {
    const workspace = prepareKnowledgeWorkspace(slug, runId, liveKbPath);
    stagingKbPath = workspace.stagingKbPath;
    rendered = {
      ...rendered,
      kbPath: stagingKbPath,
      prompt: rendered.prompt.split(liveKbPath).join(stagingKbPath),
    };
  }
  const policy = buildAutomationToolPolicy({ automation, kbPath: rendered.kbPath });
  const record = {
    schema: 'kb-automation-run/v1',
    runId,
    projectSlug: slug,
    source,
    repoPath: rendered.repoPath,
    kbPath: liveKbPath,
    workingKbPath: rendered.kbPath,
    liveKbPath,
    stagingKbPath,
    commitHash: rendered.metadata.commitHash,
    branch: rendered.metadata.branch,
    knowledgeMode: automation.knowledgeMode,
    permissionMode: workbench.permissionMode,
    status: 'dispatching',
    sessionId: null,
    startedAt,
    endedAt: null,
    error: null,
    phase: stagingKbPath ? 'analyzing' : null,
    commitRange: rendered.metadata.commitRange || '',
    pendingCommitCount: rendered.metadata.pendingCommitCount || 0,
    headCommitAtRun: rendered.metadata.headCommitAtRun || rendered.metadata.commitHash || null,
    lastAnalyzedCommitBefore: rendered.metadata.lastAnalyzedCommitBefore || null,
    trackingStartCommit: rendered.metadata.trackingStartCommit || null,
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
    discardKnowledgeWorkspace(record);
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
    discardKnowledgeWorkspace(record);
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
    discardKnowledgeWorkspace(ctx.record);
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
    if (record.stagingKbPath && record.liveKbPath) {
      rendered = {
        ...rendered,
        kbPath: record.stagingKbPath,
        prompt: rendered.prompt.split(record.liveKbPath).join(record.stagingKbPath),
      };
    }
    if (typeof deps.writeProjects === 'function') {
      try { deps.writeProjects(projects); } catch {}
    }
    if (record.source !== 'project-init' && rendered.metadata.repoStatus === 'ok' && !rendered.metadata.baselineWasMissing && (rendered.metadata.pendingCommitCount || 0) === 0) {
      record.status = 'succeeded';
      record.endedAt = new Date().toISOString();
      record.error = 'no pending commits';
      writeAutomationRun(slug, record);
      _advanceAfter(slug, deps, runId);
      return;
    }
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
  record.repoPath = rendered.repoPath;
  record.kbPath = record.liveKbPath || rendered.kbPath;
  record.workingKbPath = rendered.kbPath;
  record.commitHash = rendered.metadata.commitHash;
  record.branch = rendered.metadata.branch;
  record.knowledgeMode = automation.knowledgeMode;
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

function advanceProjectCheckpoint(slug, r, deps) {
  const projects = typeof deps.readProjects === 'function' ? deps.readProjects() : deps.projects;
  if (!projects || !projects[slug] || !r.headCommitAtRun) return;
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
  if (typeof deps.writeProjects === 'function') deps.writeProjects(projects);
}

async function finishVectorIndex(slug, runId, deps) {
  const r = _readAutomationRun(slug, runId);
  if (!r) return false;
  if (!['indexing', 'index-pending'].includes(r.status)) return r.status === 'succeeded';
  try {
    const result = typeof deps.onKnowledgeUpdated === 'function'
      ? await deps.onKnowledgeUpdated(slug, r)
      : null;
    r.vectorIndex = { status: 'succeeded', endedAt: new Date().toISOString(), result: result || null };
    r.phase = 'completed';
    r.status = 'succeeded';
    r.endedAt = new Date().toISOString();
    r.error = null;
    if (r.source !== 'project-init' && r.headCommitAtRun) advanceProjectCheckpoint(slug, r, deps);
    writeAutomationRun(slug, r);
    discardKnowledgeWorkspace(r);
    const timer = indexRetryTimers.get(`${slug}:${runId}`);
    if (timer) clearTimeout(timer);
    indexRetryTimers.delete(`${slug}:${runId}`);
    return true;
  } catch (error) {
    r.status = 'index-pending';
    r.phase = 'indexing';
    r.error = error.message;
    r.vectorIndex = { status: 'failed', endedAt: new Date().toISOString(), error: error.message };
    writeAutomationRun(slug, r);
    scheduleIndexRetry(slug, runId, deps);
    return false;
  }
}

function scheduleIndexRetry(slug, runId, deps, requestedDelay = null) {
  const key = `${slug}:${runId}`;
  if (indexRetryTimers.has(key)) return;
  const r = _readAutomationRun(slug, runId);
  if (!r || !['indexing', 'index-pending'].includes(r.status)) return;
  r.indexRetryCount = Number(r.indexRetryCount || 0) + 1;
  writeAutomationRun(slug, r);
  const delay = requestedDelay == null
    ? Math.min(300000, 5000 * Math.pow(2, Math.min(6, r.indexRetryCount - 1)))
    : requestedDelay;
  const timer = setTimeout(async () => {
    indexRetryTimers.delete(key);
    const completed = await finishVectorIndex(slug, runId, deps);
    if (completed) await wakeProjectAutomation(slug, { source: 'vector-recovery' }, deps);
  }, delay);
  if (typeof timer.unref === 'function') timer.unref();
  indexRetryTimers.set(key, timer);
}

async function _markRunEnded(slug, runId, session, deps) {
  const r = _readAutomationRun(slug, runId);
  if (!r) return;
  r.sessionId = session.sessionId || r.sessionId;
  r.endedAt = session.endedAt || new Date().toISOString();
  r.exitCode = typeof session.exitCode === 'number' ? session.exitCode : null;
  if (session.state === 'aborted') {
    r.status = 'aborted';
    r.phase = 'aborted';
  } else if (session.state === 'failed') {
    r.status = 'failed';
    r.phase = 'failed';
    r.error = session.error || 'claude session failed';
  } else {
    r.status = session.exitCode === 0 || session.exitCode === null ? 'succeeded' : 'failed';
    r.phase = r.status === 'succeeded' ? r.phase : 'failed';
    if (r.status === 'failed' && !r.error) r.error = `non-zero exitCode (${session.exitCode})`;
  }
  writeAutomationRun(slug, r);

  if (r.status !== 'succeeded') {
    discardKnowledgeWorkspace(r);
    if (r.status === 'aborted') drainQueue(slug);
    _advanceAfter(slug, deps, runId);
    return;
  }

  if (!['autoApply', 'directWriteKb'].includes(r.knowledgeMode)) {
    _advanceAfter(slug, deps, runId);
    return;
  }

  try {
    if (r.stagingKbPath) {
      r.status = 'applying';
      r.phase = 'applying';
      writeAutomationRun(slug, r);
      const applied = applyKnowledgeWorkspace(r);
      r.changedKnowledgeFiles = applied.changed;
      r.changeRecords = applied.changeRecords;
      r.markdownAppliedAt = new Date().toISOString();
    }
    r.status = 'indexing';
    r.phase = 'indexing';
    writeAutomationRun(slug, r);
  } catch (error) {
    r.status = 'failed';
    r.phase = 'failed';
    r.error = error.message;
    r.endedAt = new Date().toISOString();
    writeAutomationRun(slug, r);
    discardKnowledgeWorkspace(r);
    _advanceAfter(slug, deps, runId);
    return;
  }

  const completed = await finishVectorIndex(slug, runId, deps);
  _advanceAfter(slug, deps, runId);
  if (completed && r.source !== 'project-init') {
    await wakeProjectAutomation(slug, { source: 'queue-drain' }, deps);
  }
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
    Promise.resolve(_markRunEnded(slug, runId, session, d)).catch(error => {
      const r = _readAutomationRun(slug, runId);
      if (r) {
        r.status = 'failed';
        r.phase = 'failed';
        r.error = `finalization failed: ${error.message}`;
        r.endedAt = new Date().toISOString();
        writeAutomationRun(slug, r);
      }
      _advanceAfter(slug, d, runId);
    });
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
        discardKnowledgeWorkspace(r);
      }
    }
  }
  return summary;
}

async function resumePendingFinalizations(projects, deps) {
  const results = [];
  for (const slug of Object.keys(projects || {})) {
    const pending = listAutomationRuns(slug, 500)
      .filter(run => ['applying', 'indexing', 'index-pending'].includes(run.status))
      .sort((a, b) => String(a.startedAt || '').localeCompare(String(b.startedAt || '')));
    for (const run of pending) {
      try {
        if (run.status === 'applying') {
          const applied = applyKnowledgeWorkspace(run);
          run.changedKnowledgeFiles = applied.changed;
          run.changeRecords = applied.changeRecords;
          run.markdownAppliedAt = run.markdownAppliedAt || new Date().toISOString();
          run.status = 'indexing';
          run.phase = 'indexing';
          writeAutomationRun(slug, run);
        }
        const completed = await finishVectorIndex(slug, run.runId, deps);
        results.push({ slug, runId: run.runId, completed });
        if (!completed) break;
      } catch (error) {
        run.status = 'failed';
        run.phase = 'failed';
        run.error = `startup finalization failed: ${error.message}`;
        run.endedAt = new Date().toISOString();
        writeAutomationRun(slug, run);
        results.push({ slug, runId: run.runId, completed: false, error: error.message });
        break;
      }
    }
  }
  return results;
}

async function handlePostCommitEvent(event, deps) {
  const repoPath = event && event.repoPath;
  if (!repoPath) return { ok: false, status: 400, error: 'repoPath required' };
  const projects = typeof deps.readProjects === 'function' ? deps.readProjects() : deps.projects;
  const hit = findProjectForRepo(projects, repoPath);
  if (!hit) return { ok: false, status: 404, error: `no project registered for repoPath: ${repoPath}` };
  const nextDeps = { ...deps, projects };
  const pendingSweep = await dispatchPendingAutomations({
    triggerSlug: hit.slug,
    triggerEvent: event,
  }, nextDeps);
  const trigger = pendingSweep.results.find(item => item.slug === hit.slug);
  const result = trigger && trigger.result || { ok: true, skipped: true, reason: 'trigger project was not dispatched', slug: hit.slug };
  return { ...result, pendingSweep };
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
  wakeProjectAutomation,
  handlePostCommitEvent,
  cleanupOrphanedRuns,
  resumePendingFinalizations,
  getQueueSize,
  drainQueue,
};
