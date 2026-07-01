// Context Pack Builder (TASK-006)
// Collects Git diff / stats, project goal, related module/change docs,
// package/config files, neighbouring source, and tests into a machine-readable
// context pack written to _site/_ai/<slug>/context-packs/<run-id>/.
//
// Path safety: every path is normalized and verified to live inside the project root
// before it is added to the pack. Outside-the-project paths are rejected.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execGit } = require('./git-runner');
const aiWorkspace = require('./ai-workspace');

const MAX_FILE_BYTES = 200 * 1024;     // Skip files larger than 200 KB
const MAX_EXCERPT_BYTES = 8 * 1024;    // Excerpt limited to 8 KB
const BINARY_DETECT_BYTES = 4096;      // Read up to 4 KB to detect binary

const PACKAGE_CONFIG_FILES = [
  'package.json', 'package-lock.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml',
  'tsconfig.json', 'tsconfig.base.json', 'pyproject.toml', 'setup.py', 'requirements.txt',
  'Cargo.toml', 'Cargo.lock', 'go.mod', 'go.sum', 'pom.xml', 'build.gradle',
  '.eslintrc.json', '.eslintrc.js', '.prettierrc.json',
];

function shortHash(input) {
  return crypto.createHash('sha1').update(input).digest('hex').slice(0, 12);
}

function isSafePath(projectRoot, target) {
  const resolved = path.resolve(projectRoot, target);
  const root = path.resolve(projectRoot);
  // Use a separator-aware check so 'proj-other' does not pass 'proj' as parent.
  return resolved === root || resolved.startsWith(root + path.sep) || resolved.startsWith(root + '/');
}

function isBinaryBuffer(buf) {
  const limit = Math.min(BINARY_DETECT_BYTES, buf.length);
  for (let i = 0; i < limit; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

function readSafeExcerpt(absPath) {
  let stat;
  try { stat = fs.statSync(absPath); } catch { return null; }
  if (!stat.isFile()) return null;
  if (stat.size > MAX_FILE_BYTES) {
    return { excerpt: null, size: stat.size, binary: false, skipped: 'too-large' };
  }
  let buf;
  try { buf = fs.readFileSync(absPath); } catch { return null; }
  if (isBinaryBuffer(buf)) {
    return { excerpt: null, size: stat.size, binary: true, skipped: 'binary' };
  }
  const text = buf.toString('utf-8');
  if (text.length > MAX_EXCERPT_BYTES) {
    return { excerpt: text.slice(0, MAX_EXCERPT_BYTES) + '\n...[truncated]', size: stat.size, binary: false, truncated: true };
  }
  return { excerpt: text, size: stat.size, binary: false, truncated: false };
}

function getNeighborPaths(projectRoot, changedFiles) {
  const neighbors = new Set();
  for (const file of changedFiles) {
    if (!file) continue;
    const dir = path.dirname(file);
    if (!dir || dir === '.') continue;
    try {
      const entries = fs.readdirSync(path.join(projectRoot, dir), { withFileTypes: true });
      for (const e of entries) {
        if (!e.isFile()) continue;
        if (e.name.startsWith('.')) continue;
        const rel = path.posix.join(dir, e.name).replace(/\\/g, '/');
        if (changedFiles.includes(rel)) continue;
        neighbors.add(rel);
      }
    } catch {}
  }
  return [...neighbors];
}

function getTestPaths(projectRoot, changedFiles) {
  const tests = new Set();
  const isTestName = (name) => /\.(test|spec)\.[a-z]+$/i.test(name) || /^test[s]?[\/\\]/i.test(name) || /__tests__[\/\\]/i.test(name);
  // Tests in the same directory tree, and direct "test" / "tests" siblings
  for (const file of changedFiles) {
    if (!file) continue;
    const dir = path.dirname(file);
    // Same-dir tests
    try {
      const entries = fs.readdirSync(path.join(projectRoot, dir), { withFileTypes: true });
      for (const e of entries) {
        if (!e.isFile()) continue;
        if (isTestName(e.name)) {
          tests.add(path.posix.join(dir, e.name).replace(/\\/g, '/'));
        }
      }
    } catch {}
    // Direct test/ folder sibling
    for (const candidate of ['tests', 'test', '__tests__']) {
      const testDir = path.join(projectRoot, dir, candidate);
      if (!fs.existsSync(testDir)) continue;
      try {
        const entries = fs.readdirSync(testDir, { withFileTypes: true });
        for (const e of entries) {
          if (!e.isFile()) continue;
          if (isTestName(e.name)) {
            tests.add(path.posix.join(dir, candidate, e.name).replace(/\\/g, '/'));
          }
        }
      } catch {}
    }
  }
  return [...tests];
}

function findRelatedDocs(projectRoot, changedFiles) {
  // Map files to existing module/change docs by lightweight body/path match.
  const out = new Set();
  const dirs = [path.join(projectRoot, 'modules'), path.join(projectRoot, 'changes')];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.md')) continue;
      const full = path.join(dir, e.name);
      let text;
      try { text = fs.readFileSync(full, 'utf-8'); } catch { continue; }
      const rel = path.posix.join(path.basename(dir), e.name).replace(/\\/g, '/');
      // Heuristic: if any changed file path is mentioned in the doc body, treat as related.
      for (const f of changedFiles) {
        if (f && text.includes(f)) { out.add(rel); break; }
      }
    }
  }
  return [...out];
}

async function buildContextPack({ project, runId, trigger, commits = [], options = {} }) {
  if (!project || !project.slug) throw new Error('project required');
  const slug = project.slug;
  if (!project.kbPath) throw new Error('project.kbPath is required');
  const projectRoot = path.resolve(project.kbPath);
  if (!isSafePath(projectRoot, '')) throw new Error('unsafe project root');

  const gitPath = project.gitPath || project.localPath;
  if (!gitPath) throw new Error('project has no git/local path');
  const sourceRoot = path.resolve(gitPath); // source files live in the git repo, not the KB

  const maxFiles = options.maxFiles || 80;
  const entries = [];
  const seenAbs = new Set();
  const safeSeen = (rel) => entries.find(e => e.path === rel);

  function addEntry(rel, kind, reason) {
    if (entries.length >= maxFiles) return;
    // Decide which root to read from: KB files are anchored at projectRoot,
    // source files are anchored at sourceRoot.
    const isKbKind = ['goal', 'analysis', 'module-doc', 'change-doc'].includes(kind);
    const root = isKbKind ? projectRoot : sourceRoot;
    if (!isSafePath(root, rel)) return; // path traversal guard
    if (safeSeen(rel)) return;
    const abs = path.join(root, rel);
    if (seenAbs.has(abs)) return;
    if (!fs.existsSync(abs)) return;
    let stat;
    try { stat = fs.statSync(abs); } catch { return; }
    if (!stat.isFile()) return;
    const data = readSafeExcerpt(abs);
    if (!data) return;
    entries.push({
      path: rel.replace(/\\/g, '/'),
      kind,
      reason,
      size: data.size,
      binary: data.binary,
      truncated: !!data.truncated,
      skipped: data.skipped || null,
      excerpt: data.excerpt,
    });
    seenAbs.add(abs);
  }

  // 1. project goal (highest-priority context)
  if (fs.existsSync(path.join(projectRoot, 'GOAL.md'))) {
    addEntry('GOAL.md', 'goal', 'highest-priority human-controlled truth');
  }

  // 2. architecture / project analysis
  if (fs.existsSync(path.join(projectRoot, 'ARCHITECTURE.md'))) {
    addEntry('ARCHITECTURE.md', 'analysis', 'current architecture and project description');
  }

  let changedFiles = [];
  let range = null;
  let diffStat = null;

  if (trigger === 'commits' && commits.length > 0) {
    // 3a. Collect every file touched by any of the commits (use git show --name-only).
    // This is safer than `diff first^..last` because the first commit has no parent.
    const seen = new Set();
    for (const c of commits) {
      const r = await execGit(gitPath, ['show', '--name-only', '--format=', c.hash]);
      if (r.ok) {
        for (const line of (r.stdout || '').split('\n')) {
          const f = line.trim();
          if (f) seen.add(f);
        }
      }
    }
    changedFiles = [...seen];
    range = `${commits[0].hash.slice(0, 7)}..${commits[commits.length - 1].hash.slice(0, 7)} (${commits.length} commit${commits.length === 1 ? '' : 's'})`;
    // shortstat across the union of commits
    const stat = await execGit(gitPath, ['diff', '--shortstat', `${commits[0].hash}^`, commits[commits.length - 1].hash]);
    if (stat.ok) diffStat = (stat.stdout || '').trim();
  } else {
    // initial: enumerate tracked files (top N by size is overkill — just take first maxFiles)
    const ls = await execGit(gitPath, ['ls-files']);
    if (ls.ok) {
      changedFiles = (ls.stdout || '').split('\n').map(s => s.trim()).filter(Boolean);
    }
    range = 'all-tracked-files';
  }

  // 3b. Changed files (as evidence)
  for (const f of changedFiles) addEntry(f, 'git-changed', trigger === 'commits' ? `changed in ${range}` : 'tracked file');

  // 4. Package / config files (look in source root)
  for (const f of PACKAGE_CONFIG_FILES) {
    if (fs.existsSync(path.join(sourceRoot, f))) addEntry(f, 'package-config', 'package or build configuration');
  }

  // 5. Neighbouring source files (in source root)
  for (const f of getNeighborPaths(sourceRoot, changedFiles)) {
    addEntry(f, 'neighbor', 'sibling of a changed file');
  }

  // 6. Tests near changed files (in source root)
  for (const f of getTestPaths(sourceRoot, changedFiles)) {
    addEntry(f, 'test-nearby', 'test for a changed file');
  }

  // 7. Related module / change docs (look in KB root)
  for (const f of findRelatedDocs(projectRoot, changedFiles)) {
    const kind = f.startsWith('changes/') ? 'change-doc' : 'module-doc';
    addEntry(f, kind, 'mentions a changed file');
  }

  const pack = {
    schema: 'context-pack/v1',
    runId: runId || shortHash(`${slug}:${Date.now()}:${Math.random()}`),
    project: slug,
    createdAt: new Date().toISOString(),
    trigger: trigger || 'initial',
    gitPath,
    kbPath: projectRoot,
    sourceBranch: project.currentBranch || null,
    sourceDefaultBranch: project.defaultBranch || null,
    sourceRemote: project.remoteUrl || null,
    range,
    diffStat,
    commitCount: commits.length,
    commits: commits.map(c => ({ hash: c.hash, short: c.short, subject: c.subject, date: c.date, author: c.author })),
    entries,
    limits: {
      maxFiles,
      maxFileBytes: MAX_FILE_BYTES,
      maxExcerptBytes: MAX_EXCERPT_BYTES,
    },
  };

  // 8. Write to disk
  const outDir = aiWorkspace.contextPackDir(slug, pack.runId);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'context-pack.json'), JSON.stringify(pack, null, 2), 'utf-8');

  return pack;
}

module.exports = {
  buildContextPack,
  isSafePath,
  PACKAGE_CONFIG_FILES,
  MAX_FILE_BYTES,
  MAX_EXCERPT_BYTES,
};
