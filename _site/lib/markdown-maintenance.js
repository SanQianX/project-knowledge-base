const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { listMarkdownFiles, isDerivedIndex } = require('./markdown-knowledge-indexer');
const { renderModuleIndex, renderChangesIndex } = require('./index-builder');

const SCHEMA = 'project-knowledge/markdown-maintenance/v1';
const LARGE_FILE_BYTES = 64 * 1024;

function normalizeRel(value) {
  return String(value || '').replace(/\\/g, '/');
}

function atomicWrite(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
  fs.writeFileSync(temp, content, 'utf8');
  fs.renameSync(temp, filePath);
}

function issue(code, severity, fixable, message, details = {}) {
  return { code, severity, fixable, message, ...details };
}

function fenceState(lines) {
  let active = null;
  for (const line of lines) {
    const match = /^\s*(`{3,}|~{3,})/.exec(line);
    if (!match) continue;
    const marker = match[1][0];
    if (!active) active = marker;
    else if (active === marker) active = null;
  }
  return active;
}

function repairFrontmatter(text) {
  const lines = String(text || '').split('\n');
  if (lines[0]?.trim() !== '---') return String(text || '');
  if (lines.slice(1).some(line => line.trim() === '---')) return String(text || '');
  const headingIndex = lines.findIndex((line, index) => index > 1 && /^#{1,6}\s+/.test(line));
  if (headingIndex < 2) return String(text || '');
  const metadata = lines.slice(1, headingIndex);
  const hasField = metadata.some(line => /^[A-Za-z0-9_-]+:\s*/.test(line));
  const onlyMetadataShape = metadata.every(line => !line.trim() || /^[A-Za-z0-9_-]+:\s*/.test(line) || /^\s+\S/.test(line));
  if (!hasField || !onlyMetadataShape) return String(text || '');
  lines.splice(headingIndex, 0, '---', '');
  return lines.join('\n');
}

function headingPathDuplicates(lines) {
  const stack = [];
  const seen = new Map();
  let fenced = null;
  for (const line of lines) {
    const fence = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (!fenced) fenced = fence[1][0];
      else if (fenced === fence[1][0]) fenced = null;
      continue;
    }
    if (fenced) continue;
    const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    const level = match[1].length;
    stack.length = level - 1;
    stack[level - 1] = match[2].trim().toLowerCase();
    const key = stack.filter(Boolean).join(' > ');
    seen.set(key, (seen.get(key) || 0) + 1);
  }
  return [...seen.entries()].filter(([, count]) => count > 1).map(([headingPath, count]) => ({ headingPath, count }));
}

function analyzeMarkdown(content, relativePath = '') {
  const text = String(content || '');
  const normalizedNewlines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = normalizedNewlines.replace(/^\uFEFF/, '').split('\n');
  const issues = [];
  if (text.charCodeAt(0) === 0xFEFF) issues.push(issue('utf8-bom', 'warning', true, 'UTF-8 BOM can confuse Markdown tooling.'));
  const hasLf = /(^|[^\r])\n/.test(text);
  const hasCrlf = /\r\n/.test(text);
  const hasCr = /\r(?!\n)/.test(text);
  if ((hasLf && hasCrlf) || hasCr) issues.push(issue('mixed-line-endings', 'warning', true, 'Mixed line endings should be normalized.'));
  const trailing = lines.filter(line => /\t+$/.test(line) || / {3,}$/.test(line)).length;
  if (trailing) issues.push(issue('trailing-whitespace', 'warning', true, `${trailing} line(s) contain excessive trailing whitespace.`, { count: trailing }));
  if (!text.endsWith('\n')) issues.push(issue('missing-final-newline', 'warning', true, 'File should end with one newline.'));
  if (/\n[ \t]*\n[ \t]*\n[ \t]*\n/.test(normalizedNewlines)) {
    issues.push(issue('excessive-blank-lines', 'warning', true, 'More than two consecutive blank lines were found.'));
  }
  if (/^---\s*\n/.test(normalizedNewlines) && !/^---\s*\n[\s\S]*?\n---\s*(?:\n|$)/.test(normalizedNewlines)) {
    const repaired = repairFrontmatter(normalizedNewlines);
    issues.push(issue('malformed-frontmatter', 'error', repaired !== normalizedNewlines, 'Frontmatter opens with --- but has no valid closing delimiter.'));
  }
  if (fenceState(lines)) issues.push(issue('unclosed-code-fence', 'error', true, 'A fenced code block is not closed.'));
  const duplicateHeadings = headingPathDuplicates(lines);
  if (duplicateHeadings.length) {
    issues.push(issue('duplicate-heading-path', 'review', false, `${duplicateHeadings.length} heading path(s) are repeated and may contain appended old content.`, { headings: duplicateHeadings.slice(0, 10) }));
  }
  const updatedLines = lines.slice(0, 40).filter(line => /^Updated\s*:/i.test(line.trim())).length;
  if (updatedLines > 1) {
    issues.push(issue('repeated-update-metadata', 'review', false, `${updatedLines} Updated metadata lines were appended near the top of the file.`, { count: updatedLines }));
  }
  if (Buffer.byteLength(text, 'utf8') > LARGE_FILE_BYTES && !isDerivedIndex(relativePath)) {
    issues.push(issue('large-document', 'review', false, 'Document exceeds 64 KiB and should be semantically consolidated.', { bytes: Buffer.byteLength(text, 'utf8') }));
  }
  return issues;
}

function normalizeMarkdown(content) {
  const text = repairFrontmatter(String(content || '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n'));
  const lines = text.split('\n');
  const out = [];
  let fenced = null;
  let blankCount = 0;
  for (let line of lines) {
    const fence = /^\s*(`{3,}|~{3,})/.exec(line);
    if (!fenced) {
      line = line.replace(/\t+$/, '').replace(/ {3,}$/, '  ');
      if (/^\s*$/.test(line)) {
        blankCount += 1;
        if (blankCount > 2) continue;
        line = '';
      } else {
        blankCount = 0;
      }
    }
    out.push(line);
    if (fence) {
      if (!fenced) fenced = fence[1][0];
      else if (fenced === fence[1][0]) fenced = null;
    }
  }
  if (fenced) out.push(fenced === '~' ? '~~~' : '```');
  while (out.length && out[out.length - 1] === '') out.pop();
  return `${out.join('\n')}\n`;
}

function expectedIndexes(kbPath) {
  return [renderModuleIndex(kbPath), renderChangesIndex(kbPath)];
}

function auditKnowledgeBase(slug, kbPath) {
  const result = {
    schema: SCHEMA,
    slug,
    kbPath: path.resolve(kbPath || '.'),
    exists: false,
    files: 0,
    bytes: 0,
    issueCount: 0,
    fixableCount: 0,
    reviewCount: 0,
    errorCount: 0,
    issues: [],
  };
  if (!kbPath || !fs.existsSync(kbPath) || !fs.statSync(kbPath).isDirectory()) {
    result.issues.push({ path: '', ...issue('kb-missing', 'error', false, 'Knowledge-base directory does not exist.') });
  } else {
    result.exists = true;
    for (const filePath of listMarkdownFiles(kbPath, { includeDerived: true })) {
      const relativePath = normalizeRel(path.relative(kbPath, filePath));
      const content = fs.readFileSync(filePath, 'utf8');
      const bytes = Buffer.byteLength(content, 'utf8');
      result.files += 1;
      result.bytes += bytes;
      for (const found of analyzeMarkdown(content, relativePath)) result.issues.push({ path: relativePath, ...found });
    }
    for (const index of expectedIndexes(kbPath)) {
      const filePath = path.join(kbPath, index.path);
      const current = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
      if (current !== index.content) {
        result.issues.push({ path: index.path, ...issue('derived-index-stale', 'warning', true, 'Derived index does not match the current compact generated format.') });
      }
    }
  }
  result.issueCount = result.issues.length;
  result.fixableCount = result.issues.filter(item => item.fixable).length;
  result.reviewCount = result.issues.filter(item => item.severity === 'review').length;
  result.errorCount = result.issues.filter(item => item.severity === 'error').length;
  return result;
}

function backupFile(kbPath, backupDir, relativePath) {
  const source = path.join(kbPath, relativePath);
  if (!fs.existsSync(source)) return null;
  const target = path.join(backupDir, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
  return target;
}

function optimizeKnowledgeBase(input) {
  const { slug, kbPath, backupRoot, batchId } = input;
  const before = auditKnowledgeBase(slug, kbPath);
  if (!before.exists) return { slug, kbPath, status: 'failed', error: 'knowledge-base directory does not exist', before };
  const safeSlug = String(slug || 'project').replace(/[^A-Za-z0-9._-]+/g, '_');
  const backupDir = path.join(backupRoot, batchId, safeSlug);
  const changed = [];
  for (const filePath of listMarkdownFiles(kbPath)) {
    const relativePath = normalizeRel(path.relative(kbPath, filePath));
    const current = fs.readFileSync(filePath, 'utf8');
    const next = normalizeMarkdown(current);
    if (next === current) continue;
    backupFile(kbPath, backupDir, relativePath);
    atomicWrite(filePath, next);
    changed.push(relativePath);
  }
  for (const index of expectedIndexes(kbPath)) {
    const filePath = path.join(kbPath, index.path);
    const current = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
    if (current === index.content) continue;
    backupFile(kbPath, backupDir, index.path);
    atomicWrite(filePath, index.content);
    changed.push(index.path);
  }
  const after = auditKnowledgeBase(slug, kbPath);
  return {
    schema: SCHEMA,
    slug,
    kbPath,
    status: after.errorCount || after.reviewCount ? 'completed-with-review' : 'completed',
    changed: [...new Set(changed)].sort(),
    backupDir: changed.length ? backupDir : null,
    before,
    after,
  };
}

function uniqueProjects(projects, selectedSlugs = null) {
  const selected = Array.isArray(selectedSlugs) && selectedSlugs.length ? new Set(selectedSlugs) : null;
  const byPath = new Map();
  for (const [slug, project] of Object.entries(projects || {})) {
    if (!project || project.enabled === false || !project.kbPath || (selected && !selected.has(slug))) continue;
    const key = path.resolve(project.kbPath).toLowerCase();
    if (!byPath.has(key)) byPath.set(key, { slug, project, aliases: [] });
    else byPath.get(key).aliases.push(slug);
  }
  return [...byPath.values()];
}

function auditProjects(projects, selectedSlugs = null) {
  const entries = uniqueProjects(projects, selectedSlugs).map(({ slug, project, aliases }) => ({
    ...auditKnowledgeBase(slug, project.kbPath),
    aliases,
    knowledgeBackend: project.knowledgeBackend || 'markdown',
    teamMode: !!(project.teamKnowledge && project.teamKnowledge.enabled),
  }));
  return {
    schema: SCHEMA,
    auditedAt: new Date().toISOString(),
    projects: entries,
    summary: {
      projects: entries.length,
      files: entries.reduce((sum, item) => sum + item.files, 0),
      bytes: entries.reduce((sum, item) => sum + item.bytes, 0),
      issues: entries.reduce((sum, item) => sum + item.issueCount, 0),
      fixable: entries.reduce((sum, item) => sum + item.fixableCount, 0),
      review: entries.reduce((sum, item) => sum + item.reviewCount, 0),
      errors: entries.reduce((sum, item) => sum + item.errorCount, 0),
    },
  };
}

module.exports = {
  SCHEMA,
  LARGE_FILE_BYTES,
  analyzeMarkdown,
  normalizeMarkdown,
  repairFrontmatter,
  auditKnowledgeBase,
  optimizeKnowledgeBase,
  auditProjects,
  uniqueProjects,
};
