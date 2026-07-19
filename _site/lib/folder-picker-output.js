const path = require('path');

function selectedDirectoryFromOutput(output, options = {}) {
  const exists = options.exists || require('fs').existsSync;
  const stat = options.stat || (file => require('fs').statSync(file));
  const lines = String(output || '')
    .split(/\r?\n/)
    .map(line => line.trim().replace(/^"|"$/g, ''))
    .filter(Boolean)
    .reverse();

  for (const candidate of lines) {
    const absolute = path.isAbsolute(candidate) || path.win32.isAbsolute(candidate);
    if (!absolute || !exists(candidate)) continue;
    try {
      if (stat(candidate).isDirectory()) return candidate;
    } catch {}
  }
  return '';
}

module.exports = { selectedDirectoryFromOutput };
