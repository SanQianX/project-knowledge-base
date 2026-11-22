const path = require('path');
const { DomainError } = require('./contracts');

function resolveGitPath(cwd, output) {
  const value = String(output || '').trim();
  // rev-parse may echo unsupported flags with exit code 0. Never let a
  // multi-line response become a filesystem path or a repository identity.
  if (!value || /[\r\n\0]/.test(value) || value.startsWith('--')) {
    throw new DomainError('INVALID_ARGUMENT', 'Git 返回了无效的目录路径，请检查 Git 安装。', { status: 400 });
  }
  return path.resolve(cwd, value);
}

module.exports = { resolveGitPath };
