// _site/lib/hook-manager.js
//
// Install/uninstall a post-commit hook in a project's git repo so that
// commits automatically report a post-commit event to the KB server. The hook
// is a tiny shim that calls `node <siteRoot>/scripts/hook-trigger.js` with the
// project repo path.
//
// Safety contract:
//   * The hook is installed as `<repo>/.git/hooks/post-commit`.
//   * It is a real, standalone script — it does NOT depend on the KB
//     server being up to commit; it always exits 0.
//   * The script points at the absolute path of the KB site scripts dir,
//     so moving either the repo or the KB root is safe only when both
//     are reinstalled.
//   * If `<repo>/.git/hooks/post-commit` already exists, we refuse
//     unless the caller passes `overwrite: true`. This protects any
//     pre-existing hook the user might rely on.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const {
  ensureClaudeMdRule,
  removeClaudeMdRule,
  readClaudeMdStatus,
} = require('./claude-md-manager');

const HOOK_NAME = 'post-commit';
const HOOK_MARKER = '# KB-HOOK-MANAGED';

function isWindows() { return process.platform === 'win32'; }

function repoGitDir(repoPath) {
  // We expect repoPath to be the work-tree root, but accept either.
  const direct = path.join(repoPath, '.git');
  if (fs.existsSync(direct)) {
    const stat = fs.statSync(direct);
    if (stat.isDirectory()) {
      // Normal repo: hooks live in <repo>/.git/hooks
      return direct;
    }
    // Submodule / linked work-tree: .git is a file containing "gitdir: ..."
    if (stat.isFile()) {
      const text = fs.readFileSync(direct, 'utf-8').trim();
      const m = /^gitdir:\s*(.+)$/m.exec(text);
      if (m) return path.resolve(repoPath, m[1].trim());
    }
  }
  return null;
}

function gitHooksDir(gitDir) {
  // Git's hooks directory is `<gitDir>/hooks`, unless core.hooksPath is set.
  // We respect the env var `GIT_HOOKS_PATH` and `core.hooksPath` by reading
  // the repo's config; otherwise default to the conventional location.
  if (!gitDir) return null;
  const env = process.env.GIT_HOOKS_PATH;
  if (env) return env;
  // Try to read the worktree's config: search upward for the git toplevel.
  // We don't need to do a full `git rev-parse` — we trust that the standard
  // hooks dir exists.
  return path.join(gitDir, 'hooks');
}

function normalizeHooksPath(value, repoPath) {
  if (!value || typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return path.isAbsolute(trimmed) ? trimmed : path.resolve(repoPath, trimmed);
}

function readCoreHooksPath(repoPath) {
  const result = spawnSync('git', ['-C', repoPath, 'config', '--path', '--get', 'core.hooksPath'], {
    encoding: 'utf-8',
    windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  if (result.status !== 0) return null;
  return (result.stdout || '').trim() || null;
}

function resolveGitHooksDir(gitDir, repoPath) {
  if (!gitDir) return null;
  const fromEnv = normalizeHooksPath(process.env.GIT_HOOKS_PATH, repoPath);
  if (fromEnv) return fromEnv;
  const fromConfig = normalizeHooksPath(readCoreHooksPath(repoPath), repoPath);
  if (fromConfig) return fromConfig;
  return path.join(gitDir, 'hooks');
}

function buildHookBody({ siteRoot, host, port }) {
  // The script is a plain POSIX shell that defers to Node. This works in
  // Git for Windows (git-bash) and on macOS / Linux.
  const trigger = path.join(siteRoot, 'scripts', 'hook-trigger.js');
  // Use forward slashes inside the shim for portability; Windows git-bash
  // accepts them. Quote with single-quotes for paths that contain spaces.
  const triggerPosix = trigger.replace(/\\/g, '/');
  const repoPath = '$REPO_PATH_PLACEHOLDER';
  const hostLine = host ? `--host ${host}` : '';
  const portLine = Number.isFinite(port) ? `--port ${port}` : '';
  return `#!/bin/sh
${HOOK_MARKER} v1 — auto-installed by KB manager
# This hook is generated. Editing the marker line will break updates.
# To remove: 'git hooks uninstall' from the KB manager, or delete this file.
set -e
REPO_ROOT="$(git rev-parse --show-toplevel)"
node '${triggerPosix}' \\
  --kb-root '${siteRoot.replace(/\\/g, '/')}' \\
  --repo "${repoPath}" \\
  ${hostLine} ${portLine} &
HOOK_PID=$!
# Wait up to 4 seconds for the trigger to dispatch; otherwise let it run free.
( sleep 4 && kill -0 "$HOOK_PID" 2>/dev/null && kill "$HOOK_PID" 2>/dev/null ) &
WATCHER=$!
wait "$HOOK_PID" 2>/dev/null || true
kill "$WATCHER" 2>/dev/null || true
exit 0
`;
}

function installHook({
  repoPath,
  siteRoot,
  host,
  port,
  overwrite = false,
  updateClaudeMd = true,
  kbPath = null,
  projectsPath = null,
  projectSlug = null,
}) {
  if (!repoPath) return { ok: false, status: 400, error: 'repoPath required' };
  if (!siteRoot) return { ok: false, status: 400, error: 'siteRoot required' };
  const abs = path.resolve(repoPath);
  const gitDir = repoGitDir(abs);
  if (!gitDir) return { ok: false, status: 400, error: `no .git directory under ${abs}` };
  const hooksDir = resolveGitHooksDir(gitDir, abs);
  if (!fs.existsSync(hooksDir)) fs.mkdirSync(hooksDir, { recursive: true });
  const hookPath = path.join(hooksDir, HOOK_NAME);
  if (fs.existsSync(hookPath) && !overwrite) {
    const existing = fs.readFileSync(hookPath, 'utf-8');
    if (!existing.includes(HOOK_MARKER)) {
      return { ok: false, status: 409, error: `${HOOK_NAME} already exists and is not KB-managed. Pass overwrite:true to replace.` };
    }
  }
  let body = buildHookBody({ siteRoot, host, port });
  body = body.replace('$REPO_PATH_PLACEHOLDER', abs.replace(/\\/g, '/'));
  fs.writeFileSync(hookPath, body, { mode: 0o755 });

  let claudeMd;
  if (updateClaudeMd) {
    const portableClaudeOptions = projectSlug ? { projectSlug } : {};
    claudeMd = ensureClaudeMdRule(abs, portableClaudeOptions);
  } else {
    claudeMd = { ok: true, action: 'skipped', path: path.join(abs, 'CLAUDE.md') };
  }
  return { ok: true, hookPath, repoPath: abs, claudeMd };
}

function uninstallHook({ repoPath, updateClaudeMd = true }) {
  if (!repoPath) return { ok: false, status: 400, error: 'repoPath required' };
  const abs = path.resolve(repoPath);
  const gitDir = repoGitDir(abs);
  if (!gitDir) return { ok: false, status: 400, error: `no .git directory under ${abs}` };
  const hooksDir = resolveGitHooksDir(gitDir, abs);
  const hookPath = path.join(hooksDir, HOOK_NAME);
  if (!fs.existsSync(hookPath)) return { ok: true, removed: false, hookPath };
  const text = fs.readFileSync(hookPath, 'utf-8');
  if (!text.includes(HOOK_MARKER)) {
    return { ok: false, status: 409, error: `${HOOK_NAME} is not KB-managed; refusing to delete. Remove it manually.` };
  }
  fs.unlinkSync(hookPath);

  let claudeMd;
  if (updateClaudeMd) {
    claudeMd = removeClaudeMdRule(abs);
  } else {
    claudeMd = { ok: true, action: 'skipped', path: path.join(abs, 'CLAUDE.md') };
  }
  return { ok: true, removed: true, hookPath, claudeMd };
}

function readHookStatus({ repoPath }) {
  if (!repoPath) return { ok: false, status: 400, error: 'repoPath required' };
  const abs = path.resolve(repoPath);
  const gitDir = repoGitDir(abs);
  const claudeMd = readClaudeMdStatus(abs);
  if (!gitDir) {
    return { ok: true, installed: false, repoPath: abs, reason: 'no .git directory', claudeMd };
  }
  const hooksDir = resolveGitHooksDir(gitDir, abs);
  const hookPath = path.join(hooksDir, HOOK_NAME);
  if (!fs.existsSync(hookPath)) {
    return { ok: true, installed: false, hookPath, repoPath: abs, claudeMd };
  }
  const text = fs.readFileSync(hookPath, 'utf-8');
  if (!text.includes(HOOK_MARKER)) {
    return { ok: true, installed: false, kbManaged: false, hookPath, repoPath: abs, reason: 'pre-existing hook (not KB-managed)', claudeMd };
  }
  return { ok: true, installed: true, kbManaged: true, hookPath, repoPath: abs, bytes: text.length, claudeMd };
}

module.exports = {
  HOOK_NAME,
  HOOK_MARKER,
  installHook,
  uninstallHook,
  readHookStatus,
};
