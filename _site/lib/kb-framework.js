const fs = require('fs');
const path = require('path');
const { migrateAIWorkspace, ensureProjectAIPath } = require('./ai-workspace');
const { regenerateIndexes } = require('./index-builder');

const PROJECT_SCHEMA_VERSION = 'minimal';
const KB_FRAMEWORK_SCHEMA = 'minimal-kb/v1';
const TOP_LEVEL = ['README.md', 'GOAL.md', 'ARCHITECTURE.md', 'modules', 'changes'];
const TRUSTED_AUTO_PATHS = ['README.md', 'modules/', 'modules/00-index.md', 'changes/', 'changes/00-index.md'];
const REVIEW_REQUIRED_PATHS = ['GOAL.md', 'ARCHITECTURE.md'];
const NEVER_TOUCH_PREFIXES = ['.git/', '.gitignore', '_meta/', '_ai/'];

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function readTemplate(name) {
  const file = path.resolve(__dirname, '..', '..', 'templates', name);
  if (!fs.existsSync(file)) return null;
  return fs.readFileSync(file, 'utf-8');
}

function renderTemplate(name, vars, fallback) {
  const tpl = readTemplate(name) || fallback;
  return String(tpl || '').replace(/__([A-Z_][A-Z0-9_]*)__/g, (_, key) => (
    key in vars ? String(vars[key]) : `__${key}__`
  ));
}

function frontmatter(fields) {
  const lines = ['---'];
  for (const [key, value] of Object.entries(fields)) {
    if (value == null || value === '') continue;
    if (Array.isArray(value)) lines.push(`${key}: [${value.join(', ')}]`);
    else lines.push(`${key}: ${String(value).replace(/\r?\n/g, ' ')}`);
  }
  lines.push('---', '');
  return lines.join('\n');
}

function ensureFile(file, content, created, base) {
  if (fs.existsSync(file)) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf-8');
  if (created) created.push(path.relative(base, file).replace(/\\/g, '/'));
}

function initProjectDirs(slug, kbPath) {
  const base = path.resolve(kbPath);
  const created = [];
  const vars = { PROJECT: slug, SLUG: slug, DATE: todayIso(), AUTHOR: process.env.USERNAME || process.env.USER || 'unknown' };
  fs.mkdirSync(path.join(base, 'modules'), { recursive: true });
  fs.mkdirSync(path.join(base, 'changes'), { recursive: true });
  ensureFile(
    path.join(base, 'README.md'),
    renderTemplate('project-readme.md', vars, `# ${slug}\n\nThis knowledge base contains only trusted, useful project memory.\n`),
    created,
    base,
  );
  ensureFile(
    path.join(base, 'GOAL.md'),
    renderTemplate('goal.md', vars, `${frontmatter({ schema: KB_FRAMEWORK_SCHEMA, title: `${slug} Goal`, status: 'draft', updatedAt: todayIso() })}# ${slug} Goal\n\nTODO: confirm the project goal, users, success criteria, non-goals, and review principles.\n`),
    created,
    base,
  );
  ensureFile(
    path.join(base, 'ARCHITECTURE.md'),
    renderTemplate('architecture.md', vars, `${frontmatter({ schema: KB_FRAMEWORK_SCHEMA, title: `${slug} Architecture`, updatedAt: todayIso() })}# ${slug} Architecture\n\nTODO: summarize the current architecture, module relationships, data flow, constraints, and source entry points.\n`),
    created,
    base,
  );
  regenerateIndexes(base);
  ensureProjectAIPath(slug);
  return {
    created,
    basePath: base,
    kbSchemaVersion: PROJECT_SCHEMA_VERSION,
    frameworkSchema: KB_FRAMEWORK_SCHEMA,
    topLevel: TOP_LEVEL.slice(),
  };
}

function readIfExists(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : '';
}

function visibleTopLevel(kbPath) {
  if (!fs.existsSync(kbPath)) return [];
  return fs.readdirSync(kbPath).filter(name => !name.startsWith('.')).sort();
}

function isCurrentKb(kbPath) {
  return fs.existsSync(path.join(kbPath, 'GOAL.md')) &&
    fs.existsSync(path.join(kbPath, 'ARCHITECTURE.md')) &&
    fs.existsSync(path.join(kbPath, 'modules')) &&
    fs.existsSync(path.join(kbPath, 'changes'));
}

function consolidateLegacyCommits({ slug, kbPath }) {
  const commitsDir = path.join(kbPath, 'commits');
  const aiRoot = ensureProjectAIPath(slug);
  const backupDir = path.join(aiRoot, 'legacy-commits');
  const result = { found: 0, created: [], backupDir };
  if (!fs.existsSync(commitsDir)) return result;
  const files = fs.readdirSync(commitsDir).filter(f => f.endsWith('.md') && f !== '00-index.md').sort();
  result.found = files.length;
  if (!files.length) return result;
  fs.mkdirSync(backupDir, { recursive: true });
  for (const file of files) fs.copyFileSync(path.join(commitsDir, file), path.join(backupDir, file));
  const bucketCount = Math.min(10, Math.max(1, Math.ceil(files.length / 4)));
  const bucketSize = Math.ceil(files.length / bucketCount);
  const changesDir = path.join(kbPath, 'changes');
  fs.mkdirSync(changesDir, { recursive: true });
  for (let i = 0; i < bucketCount; i++) {
    const bucket = files.slice(i * bucketSize, (i + 1) * bucketSize);
    if (!bucket.length) continue;
    const rel = `legacy-change-${String(i + 1).padStart(2, '0')}.md`;
    const title = `Legacy Change ${i + 1}`;
    const body = [
      frontmatter({
        schema: KB_FRAMEWORK_SCHEMA,
        title,
        tags: ['legacy-migration'],
        updatedAt: todayIso(),
        aggregatedFrom: `[${bucket.map(f => `commits/${f}`).join(', ')}]`,
      }),
      `# ${title}`,
      '',
      '## Development Intent',
      '',
      'This change was generated by consolidating older per-commit records. No raw prompts are preserved.',
      '',
      '## Implementation Result',
      '',
      'Legacy commit notes were grouped into this durable change summary.',
      '',
      '## Evidence',
      '',
      ...bucket.map(file => `- \`commits/${file}\``),
      '',
    ].join('\n');
    fs.writeFileSync(path.join(changesDir, rel), body, 'utf-8');
    result.created.push(`changes/${rel}`);
  }
  return result;
}

function removeLegacyItems(kbPath) {
  const removed = [];
  const names = [
    '_ai', 'kb-manifest.json', 'project-goal.md', 'project-analysis.md', 'framework.md',
    'architecture', 'commits', 'features', 'operations', 'quality', 'requirements', 'references',
  ];
  for (const name of names) {
    const target = path.join(kbPath, name);
    if (fs.existsSync(target)) {
      fs.rmSync(target, { recursive: true, force: true });
      removed.push(name);
    }
  }
  return removed;
}

function migrateToFramework({ slug, kbPath, preserveLegacyAI = true }) {
  const base = path.resolve(kbPath);
  fs.mkdirSync(base, { recursive: true });
  const aiMigration = migrateAIWorkspace({ slug, kbPath: base, preserveOriginal: preserveLegacyAI });

  const oldGoal = readIfExists(path.join(base, 'project-goal.md'));
  const oldFramework = readIfExists(path.join(base, 'framework.md'));
  const oldArch = readIfExists(path.join(base, 'architecture', 'overview.md'));
  const oldAnalysis = readIfExists(path.join(base, 'project-analysis.md'));

  const init = initProjectDirs(slug, base);
  if (oldGoal && !oldGoal.includes('TODO: confirm the project goal')) {
    fs.writeFileSync(path.join(base, 'GOAL.md'), oldGoal, 'utf-8');
  }
  const archParts = [
    oldFramework && `## Migrated Framework\n\n${oldFramework}`,
    oldArch && `## Migrated Architecture Overview\n\n${oldArch}`,
    oldAnalysis && `## Migrated Project Analysis\n\n${oldAnalysis}`,
  ].filter(Boolean);
  if (archParts.length) {
    fs.writeFileSync(path.join(base, 'ARCHITECTURE.md'), `${frontmatter({ schema: KB_FRAMEWORK_SCHEMA, title: `${slug} Architecture`, updatedAt: todayIso() })}# ${slug} Architecture\n\n${archParts.join('\n\n')}\n`, 'utf-8');
  }
  const commits = consolidateLegacyCommits({ slug, kbPath: base });
  const removed = removeLegacyItems(base);
  regenerateIndexes(base);
  return {
    ok: true,
    slug,
    kbPath: base,
    kbSchemaVersion: PROJECT_SCHEMA_VERSION,
    frameworkSchema: KB_FRAMEWORK_SCHEMA,
    init,
    aiMigration,
    legacyCommits: commits,
    removed,
    topLevel: visibleTopLevel(base),
  };
}

function normalizeApplyPath(rel) {
  return String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '');
}

function applyPolicyForPath(rel, allowGoalEdit = false) {
  const norm = normalizeApplyPath(rel);
  if (!norm || norm.includes('../') || norm.startsWith('../')) return { ok: false, reason: 'unsafe path' };
  if (NEVER_TOUCH_PREFIXES.some(prefix => norm === prefix.replace(/\/$/, '') || norm.startsWith(prefix))) {
    return { ok: false, reason: 'path is reserved and cannot be written by AI' };
  }
  if (REVIEW_REQUIRED_PATHS.includes(norm)) {
    return allowGoalEdit ? { ok: true, reviewRequired: true } : { ok: false, status: 409, reviewRequired: true, reason: `${norm} requires human review` };
  }
  if (norm === 'README.md') return { ok: true, autoApply: true };
  if (norm.startsWith('modules/') || norm.startsWith('changes/')) return { ok: true, autoApply: true };
  return { ok: false, reason: `path is outside the trusted KB allowlist: ${norm}` };
}

module.exports = {
  PROJECT_SCHEMA_VERSION,
  KB_FRAMEWORK_SCHEMA,
  TOP_LEVEL,
  TRUSTED_AUTO_PATHS,
  REVIEW_REQUIRED_PATHS,
  NEVER_TOUCH_PREFIXES,
  initProjectDirs,
  migrateToFramework,
  consolidateLegacyCommits,
  isCurrentKb,
  visibleTopLevel,
  applyPolicyForPath,
  frontmatter,
};
