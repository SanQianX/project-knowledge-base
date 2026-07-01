const fs = require('fs');
const path = require('path');
const { getDataDir } = require('./data-dir');

const APP_ROOT = getDataDir();
const SITE_ROOT = path.resolve(__dirname, '..');
const AI_ROOT = path.join(APP_ROOT, '_ai');
const STANDARD_SUBDIRS = ['drafts', 'runs', 'context-packs', 'backups', 'claude-workbench'];

function safeSlug(slug) {
  return typeof slug === 'string' && /^[a-z0-9][a-z0-9-]{0,40}$/.test(slug);
}

function projectAIPath(slug) {
  if (!safeSlug(slug)) throw new Error(`invalid slug for AI workspace: ${slug}`);
  return path.join(AI_ROOT, slug);
}

function ensureProjectAIPath(slug) {
  const root = projectAIPath(slug);
  for (const sub of STANDARD_SUBDIRS) {
    fs.mkdirSync(path.join(root, sub), { recursive: true });
  }
  return root;
}

function legacyAIPath(kbPath) {
  return path.join(kbPath, '_ai');
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(from, to);
    else if (entry.isFile()) fs.copyFileSync(from, to);
  }
}

function migrateAIWorkspace({ slug, kbPath, preserveOriginal = true }) {
  const legacy = legacyAIPath(kbPath);
  const target = ensureProjectAIPath(slug);
  const result = {
    ok: true,
    slug,
    legacyPath: legacy,
    targetPath: target,
    copied: false,
    preservedOriginal: preserveOriginal,
  };
  if (!fs.existsSync(legacy)) return result;
  copyDir(legacy, target);
  result.copied = true;
  if (!preserveOriginal) {
    fs.rmSync(legacy, { recursive: true, force: true });
    result.preservedOriginal = false;
  }
  return result;
}

function runPath(slug, runId) {
  return path.join(projectAIPath(slug), 'runs', `${runId}.json`);
}

function draftDir(slug, runId) {
  return path.join(projectAIPath(slug), 'drafts', runId);
}

function contextPackDir(slug, runId) {
  return path.join(projectAIPath(slug), 'context-packs', runId);
}

function findExistingRunPath({ slug, kbPath, runId }) {
  const primary = path.join(projectAIPath(slug), 'runs', `${runId}.json`);
  return primary;
}

function findExistingDraftDir({ slug, kbPath, runId }) {
  const primary = path.join(projectAIPath(slug), 'drafts', runId);
  return primary;
}

function listProjectDirs(projectSlug = null, projects = null) {
  if (projectSlug) return [projectAIPath(projectSlug)];
  const dirs = [];
  if (fs.existsSync(AI_ROOT)) {
    for (const entry of fs.readdirSync(AI_ROOT, { withFileTypes: true })) {
      if (entry.isDirectory() && safeSlug(entry.name)) dirs.push(path.join(AI_ROOT, entry.name));
    }
  }
  if (projects) {
    for (const [slug] of Object.entries(projects)) {
      if (safeSlug(slug)) dirs.push(projectAIPath(slug));
    }
  }
  return [...new Set(dirs.map(d => path.resolve(d)))];
}

module.exports = {
  APP_ROOT,
  SITE_ROOT,
  AI_ROOT,
  STANDARD_SUBDIRS,
  projectAIPath,
  ensureProjectAIPath,
  legacyAIPath,
  migrateAIWorkspace,
  runPath,
  draftDir,
  contextPackDir,
  findExistingRunPath,
  findExistingDraftDir,
  listProjectDirs,
};
