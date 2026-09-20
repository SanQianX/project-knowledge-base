const fs = require('fs');
const path = require('path');
const { getDataDir } = require('./data-dir');
const { getWorkbenchConfig } = require('./runtime-config');

const SITE_ROOT = path.resolve(__dirname, '..');

function appRoot() {
  return getDataDir();
}

function aiRoot() {
  const cfg = getWorkbenchConfig();
  return path.join(appRoot(), cfg.aiRootDirName || '_ai');
}

function standardSubdirs() {
  const cfg = getWorkbenchConfig();
  const dirs = Array.isArray(cfg.standardSubdirs) && cfg.standardSubdirs.length
    ? cfg.standardSubdirs.slice()
    : ['drafts', 'runs', 'context-packs', 'backups'];
  if (cfg.sessionDirName && !dirs.includes(cfg.sessionDirName)) dirs.push(cfg.sessionDirName);
  return dirs;
}

function safeSlug(slug) {
  return typeof slug === 'string' && /^[a-z0-9][a-z0-9-]{0,40}$/.test(slug);
}

function projectAIPath(slug) {
  if (!safeSlug(slug)) throw new Error(`invalid slug for AI workspace: ${slug}`);
  return path.join(aiRoot(), slug);
}

function ensureProjectAIPath(slug) {
  const root = projectAIPath(slug);
  for (const sub of standardSubdirs()) {
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
  const root = aiRoot();
  if (fs.existsSync(root)) {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory() && safeSlug(entry.name)) dirs.push(path.join(root, entry.name));
    }
  }
  if (projects) {
    for (const [slug] of Object.entries(projects)) {
      if (safeSlug(slug)) dirs.push(projectAIPath(slug));
    }
  }
  return [...new Set(dirs.map(d => path.resolve(d)))];
}

const exported = {
  SITE_ROOT,
  appRoot,
  aiRoot,
  standardSubdirs,
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

Object.defineProperties(exported, {
  APP_ROOT: { enumerable: true, get: appRoot },
  AI_ROOT: { enumerable: true, get: aiRoot },
  STANDARD_SUBDIRS: { enumerable: true, get: standardSubdirs },
});

module.exports = exported;
