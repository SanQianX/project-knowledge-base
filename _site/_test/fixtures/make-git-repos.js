const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

function parseArgs(input) {
  if (Array.isArray(input)) return input.map(String);
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match;
  while ((match = re.exec(String(input || '')))) {
    out.push(match[1] != null ? match[1] : match[2] != null ? match[2] : match[3]);
  }
  return out;
}

function git(cwd, args) {
  const argv = ['-C', cwd, ...parseArgs(args)];
  return execFileSync('git', argv, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function write(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function commit(repoPath, message) {
  git(repoPath, ['add', '.']);
  git(repoPath, ['commit', '-q', '-m', message]);
  const hash = git(repoPath, ['rev-parse', 'HEAD']);
  return {
    hash,
    short: hash.slice(0, 7),
    date: git(repoPath, ['show', '-s', '--format=%ad', '--date=short', 'HEAD']),
    author: git(repoPath, ['show', '-s', '--format=%an', 'HEAD']),
    subject: message,
  };
}

function initRepo(repoPath) {
  git(repoPath, ['init', '-q', '-b', 'main']);
  git(repoPath, ['config', 'user.name', 'Project Knowledge Test']);
  git(repoPath, ['config', 'user.email', 'project-knowledge-test@example.local']);
  git(repoPath, ['config', 'commit.gpgsign', 'false']);
}

function makeRepo({ kind = 'one-commit' } = {}) {
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), `kb-fixture-${kind}-${process.pid}-`));
  const commits = [];
  const cleanup = () => fs.rmSync(repoPath, { recursive: true, force: true });

  if (kind === 'not-git') {
    write(path.join(repoPath, 'README.md'), '# not git\n');
    return { path: repoPath, commits, headCommit: null, cleanup };
  }

  initRepo(repoPath);

  if (kind === 'empty') {
    return { path: repoPath, commits, headCommit: null, cleanup };
  }

  write(path.join(repoPath, 'README.md'), `# ${kind}\n`);
  commits.push(commit(repoPath, 'chore: initial commit'));

  if (kind === 'one-commit') {
    return { path: repoPath, commits, headCommit: commits[commits.length - 1].hash, cleanup };
  }

  if (kind === 'feature-commit') {
    write(path.join(repoPath, 'src', 'feature.ts'), 'export const feature = true;\n');
    commits.push(commit(repoPath, 'feat: add feature module'));
  } else if (kind === 'multi-commit') {
    write(path.join(repoPath, 'src', 'a.ts'), 'export const a = 1;\n');
    commits.push(commit(repoPath, 'feat: add a module'));
    write(path.join(repoPath, 'src', 'b.ts'), 'export const b = 2;\n');
    commits.push(commit(repoPath, 'fix: add b module'));
  } else if (kind === 'binary-commit') {
    fs.writeFileSync(path.join(repoPath, 'big.bin'), Buffer.alloc(256 * 1024, 7));
    commits.push(commit(repoPath, 'feat: add binary fixture'));
  } else {
    cleanup();
    throw new Error(`unknown fixture kind: ${kind}`);
  }

  return { path: repoPath, commits, headCommit: commits[commits.length - 1].hash, cleanup };
}

module.exports = { makeRepo, git };
