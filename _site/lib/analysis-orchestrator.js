// Analysis Orchestrator — incremental commit analysis only.
//
// Initial-project draft generation (TASK-007) was removed: project owners
// author GOAL.md / ARCHITECTURE.md themselves or in the embedded Claude
// terminal; only the post-commit incremental path remains.
//
// Hard rules:
//   * `GOAL.md` and `ARCHITECTURE.md` require human review before apply.
//     Drafts always land under `_site/_ai/<slug>/drafts/<run-id>/`.
//   * `lastAnalyzedCommit` is NEVER updated by analysis. Only the apply step
//     advances that pointer.
//   * Failed analysis produces a `failed` run record and does NOT write any drafts.

const fs = require('fs');
const path = require('path');
const { getAdapter } = require('./ai-adapter');
const { buildContextPack } = require('./context-pack-builder');
const { scanProject } = require('./scanner');
const aiWorkspace = require('./ai-workspace');
const { frontmatter } = require('./kb-framework');

const { getDataDir } = require('./data-dir');
const DATA_DIR = getDataDir();
const AI_PROFILES_PATH = path.join(DATA_DIR, 'ai-profiles.json');

function readAiProfiles() {
  try {
    const cfg = JSON.parse(fs.readFileSync(AI_PROFILES_PATH, 'utf-8'));
    return Array.isArray(cfg.profiles) ? cfg.profiles : [];
  } catch {
    return [];
  }
}

function validateUsableProfile(profileId) {
  if (!profileId) return { ok: false, status: 400, error: 'AI profile not assigned to project' };
  const profile = readAiProfiles().find(item => item && item.id === profileId);
  if (!profile) return { ok: false, status: 400, error: `AI profile not configured: ${profileId}` };
  const implementation = profile.implementation || profile.id;
  const adapter = getAdapter(implementation);
  if (!adapter) return { ok: false, status: 400, error: `unknown adapter: ${implementation}` };
  if (profile.enabled === false) return { ok: false, status: 400, error: `AI profile disabled: ${profileId}` };
  return { ok: true, adapter, profile };
}

function readTemplate(name) {
  const p = path.join(__dirname, '..', '..', 'templates', name);
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, 'utf-8');
}

function renderTemplate(content, vars) {
  return content.replace(/__([A-Z_][A-Z0-9_]*)__/g, (_, key) => (key in vars ? String(vars[key]) : `__${key}__`));
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function shortRunId(input) {
  return input.toString().slice(0, 12).replace(/[^a-zA-Z0-9-]/g, '-');
}

function knowledgeLanguage(project) {
  return project && project.knowledgeLanguage === 'en-US' ? 'en-US' : 'zh-CN';
}

function sourceMeta(project, headCommitAtRun = null) {
  return {
    sourceBranch: project.currentBranch || null,
    sourceDefaultBranch: project.defaultBranch || null,
    sourceRemote: project.remoteUrl || null,
    sourceRunId: null,
    sourceHeadCommit: headCommitAtRun || project.headCommit || null,
  };
}

function prependDraftFrontmatter(text, meta) {
  const clean = String(text || '').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
  return `${frontmatter(meta)}${clean}`;
}

function renderChangeDraft(project, change, commit) {
  const tpl = readTemplate('change.md');
  if (!tpl) return null;
  const l = labels(project);
  const vars = {
    PROJECT: project.slug,
    COMMIT: commit.hash,
    SHORTCOMMIT: (commit.short || commit.hash || '').slice(0, 7),
    DATE: commit.date || todayIso(),
    AUTHOR: commit.author || 'unknown',
    SUBJECT: commit.subject || '',
    TYPE: (commit.subject || '').match(/^[a-z]+/i) ? RegExp.lastMatch.toLowerCase() : 'chore',
    CLASSIFICATION: change.classification,
    DEVELOPMENT_INTENT: change.developmentIntent || change.intentSummary || 'TODO',
    GOAL_IMPACT: change.goalImpact || 'TODO',
    EVIDENCE: (change.evidence || []).map(s => `- ${s}`).join('\n') || `- ${l.noEvidence}`,
    PROPOSED_OPERATIONS: (change.proposedOps || []).map(o => `- ${o.op} ${o.path}${o.fromTemplate ? ` (from ${o.fromTemplate})` : ''}`).join('\n') || `- ${l.noEvidence}`,
  };
  let rendered = renderTemplate(tpl, vars);
  const proposal = [
    '',
    `## ${l.aiProposal}`,
    '',
    `- **${l.developmentIntent}**: ${change.developmentIntent || change.intentSummary || 'TODO'}`,
    `- **${l.goalImpact}**: ${change.goalImpact || 'TODO'}`,
    `- **${l.evidence}**: ${(change.evidence || []).map(s => `- ${s}`).join('\n') || `- ${l.noEvidence}`}`,
    `- **${l.proposedOperations}**: ${(change.proposedOps || []).map(o => `- ${o.op} ${o.path}${o.fromTemplate ? ` (from ${o.fromTemplate})` : ''}`).join('\n') || `- ${l.noEvidence}`}`,
  ].join('\n');
  return rendered.replace('## Reviewer Notes', proposal + '\n\n## Reviewer Notes');
}

async function runCommitAnalysis(project, options = {}) {
  const slug = project.slug;
  const kbPath = path.resolve(project.kbPath);
  const aiProfileId = project.aiProfileId;
  const profileCheck = validateUsableProfile(aiProfileId);
  if (!profileCheck.ok) return profileCheck;
  const adapter = profileCheck.adapter;
  if (!fs.existsSync(kbPath)) return { ok: false, status: 400, error: 'project KB not initialized' };
  // Run the scanner to discover pending commits since lastAnalyzedCommit.
  const scan = await scanProject({ slug, ...project }, { maxCommits: options.maxCommits || 200 });
  if (scan.repoStatus !== 'ok') {
    return { ok: false, status: 400, error: `git not ok: ${scan.repoStatus} (${scan.error || ''})` };
  }
  if (!scan.commits || scan.commits.length === 0) {
    return { ok: true, noop: true, message: 'no pending commits', runId: null, scan };
  }

  const runId = `commits-${shortRunId(Date.now().toString(36) + Math.random().toString(36))}`;
  const aiRoot = aiWorkspace.ensureProjectAIPath(slug);
  const draftsDir = path.join(aiRoot, 'drafts', runId);
  const runsDir = path.join(aiRoot, 'runs');
  fs.mkdirSync(draftsDir, { recursive: true });
  fs.mkdirSync(runsDir, { recursive: true });
  const meta = sourceMeta(project, scan.headCommit || null);

  const runRecord = {
    schema: 'ai-run/v1',
    runId,
    type: 'commits',
    project: slug,
    aiProfileId,
    knowledgeLanguage: knowledgeLanguage(project),
    status: 'running',
    startedAt: new Date().toISOString(),
    mode: scan.mode,
    range: scan.range,
    commitCount: scan.commits.length,
    headCommitAtRun: scan.headCommit || null,
    lastAnalyzedCommitBefore: project.lastAnalyzedCommit || null,
    sourceBranch: meta.sourceBranch,
    sourceDefaultBranch: meta.sourceDefaultBranch,
    sourceRemote: meta.sourceRemote,
    drafts: [],
    outputPaths: [],
  };

  try {
    // 1. Build a commit-aware context pack
    const pack = await buildContextPack({
      project,
      runId,
      trigger: 'commits',
      commits: scan.commits,
    });
    runRecord.contextPackPath = path.relative(aiRoot, path.join(aiRoot, 'context-packs', runId, 'context-pack.json')).replace(/\\/g, '/');

    // 2. Run analyzer
    const output = await adapter.analyzeCommitBatch({ project, commits: scan.commits, contextPack: pack });

    // 3. Validate
    const validation = adapter.validateOutput(output);
    if (!validation.valid) {
      runRecord.status = 'failed';
      runRecord.finishedAt = new Date().toISOString();
      runRecord.error = 'invalid adapter output';
      runRecord.validationErrors = validation.errors;
      writeRun(runsDir, runRecord);
      return { ok: false, status: 422, error: 'invalid adapter output', validation, runId, runRecord };
    }

    // 4. Render drafts
    const changes = output.changes || [];
    const changesByCommit = new Map(changes.map(c => [c.commit, c]));
    let touchedGoal = false;

    for (const commit of scan.commits) {
      const change = changesByCommit.get(commit.hash);
      if (!change) continue;
      const shortCommit = (commit.short || commit.hash || '').slice(0, 7);
      const draftChangePath = path.join(draftsDir, 'changes', `${shortCommit}.md`);
      fs.mkdirSync(path.dirname(draftChangePath), { recursive: true });
      const draftMeta = { ...meta, sourceRunId: runId, sourceHeadCommit: runRecord.headCommitAtRun };
      fs.writeFileSync(draftChangePath, prependDraftFrontmatter(renderChangeDraft(project, change, commit), draftMeta), 'utf-8');
      runRecord.drafts.push({ op: 'create-file', path: `changes/${shortCommit}.md`, fromDraft: 'change', sourceBranch: meta.sourceBranch });
      runRecord.outputPaths.push(`changes/${shortCommit}.md`);

      if (change.classification === 'refactor' || change.classification === 'infrastructure') {
        // Note a goal-impact line so the reviewer can see this changed the implementation shape.
        touchedGoal = touchedGoal || (change.goalImpact && change.goalImpact.length > 0);
      }
    }

    runRecord.touchedGoal = touchedGoal;
    runRecord.status = 'succeeded';
    runRecord.finishedAt = new Date().toISOString();
    runRecord.evidenceTotal = changes.reduce((acc, c) => acc + (c.evidence ? c.evidence.length : 0), 0);
    writeRun(runsDir, runRecord);

    return { ok: true, runId, runRecord, scan };
  } catch (e) {
    runRecord.status = 'failed';
    runRecord.finishedAt = new Date().toISOString();
    runRecord.error = e.message;
    writeRun(runsDir, runRecord);
    return { ok: false, status: 500, error: e.message, runId, runRecord };
  }
}

function writeRun(runsDir, runRecord) {
  const p = path.join(runsDir, `${runRecord.runId}.json`);
  fs.writeFileSync(p, JSON.stringify(runRecord, null, 2), 'utf-8');
  return p;
}

function readRun(kbPath, runId) {
  const slug = path.basename(kbPath);
  const p = aiWorkspace.findExistingRunPath({ slug, kbPath, runId });
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

function listRuns(kbPath) {
  const slug = path.basename(kbPath);
  const dirs = [path.join(aiWorkspace.projectAIPath(slug), 'runs')];
  const byId = new Map();
  for (const runsDir of dirs) {
    if (!fs.existsSync(runsDir)) continue;
    for (const f of fs.readdirSync(runsDir).filter(file => file.endsWith('.json'))) {
      try {
        const run = JSON.parse(fs.readFileSync(path.join(runsDir, f), 'utf-8'));
        byId.set(run.runId || f, run);
      } catch {}
    }
  }
  return [...byId.values()];
}

function listDrafts(kbPath, runId) {
  const slug = path.basename(kbPath);
  const run = readRun(kbPath, runId) || {};
  const dir = aiWorkspace.findExistingDraftDir({ slug, kbPath, runId });
  if (!fs.existsSync(dir)) return [];
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else {
        const rel = path.relative(dir, full).replace(/\\/g, '/');
        out.push({
          path: rel,
          size: fs.statSync(full).size,
          sourceBranch: run.sourceBranch ?? 'unknown (pre-TASK-016)',
          sourceDefaultBranch: run.sourceDefaultBranch ?? null,
          sourceRemote: run.sourceRemote ?? null,
          sourceRunId: run.runId || runId,
          sourceHeadCommit: run.headCommitAtRun || null,
        });
      }
    }
  };
  walk(dir);
  return out;
}

module.exports = {
  runCommitAnalysis,
  readRun,
  listRuns,
  listDrafts,
};
