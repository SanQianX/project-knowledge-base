const fs = require('fs');
const path = require('path');
const { sha256 } = require('./knowledge-schema');

const CHUNKER_VERSION = 1;
const DEFAULT_MAX_CHARS = 1200;
const DEFAULT_OVERLAP_CHARS = 120;
const EXCLUDED_DIRS = new Set(['.git', '_ai', '_backup', 'node_modules']);

function normalizeRel(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^\.\//, '');
}

function stripFrontmatter(markdown) {
  return String(markdown || '').replace(/^---\s*\r?\n[\s\S]*?\r?\n---\s*\r?\n?/, '');
}

function splitLongText(text, maxChars, overlapChars) {
  const clean = String(text || '').trim();
  if (!clean) return [];
  if (clean.length <= maxChars) return [clean];
  const parts = [];
  let start = 0;
  while (start < clean.length) {
    let end = Math.min(start + maxChars, clean.length);
    if (end < clean.length) {
      const floor = start + Math.floor(maxChars * 0.6);
      const boundary = Math.max(clean.lastIndexOf('\n\n', end), clean.lastIndexOf('。', end), clean.lastIndexOf('. ', end));
      if (boundary >= floor) end = boundary + 1;
    }
    parts.push(clean.slice(start, end).trim());
    if (end >= clean.length) break;
    start = Math.max(start + 1, end - overlapChars);
  }
  return parts.filter(Boolean);
}

function chunkMarkdown(markdown, options = {}) {
  const maxChars = Number(options.maxChars || DEFAULT_MAX_CHARS);
  const overlapChars = Math.min(Number(options.overlapChars || DEFAULT_OVERLAP_CHARS), Math.floor(maxChars / 3));
  const body = stripFrontmatter(markdown).replace(/\r\n/g, '\n');
  const lines = body.split('\n');
  const headings = [];
  const sections = [];
  let buffer = [];
  let sectionHeadings = [];

  const flush = () => {
    const text = buffer.join('\n').trim();
    if (text) sections.push({ headingPath: [...sectionHeadings], text });
    buffer = [];
  };

  for (const line of lines) {
    const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (match) {
      flush();
      const level = match[1].length;
      headings.length = level - 1;
      headings[level - 1] = match[2].trim();
      sectionHeadings = headings.filter(Boolean);
      buffer.push(line);
    } else {
      buffer.push(line);
    }
  }
  flush();

  const chunks = [];
  for (const section of sections) {
    for (const text of splitLongText(section.text, maxChars, overlapChars)) {
      chunks.push({
        chunkOrder: chunks.length,
        headingPath: section.headingPath,
        chunkText: text,
      });
    }
  }
  return chunks;
}

function listMarkdownFiles(root) {
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || EXCLUDED_DIRS.has(entry.name)) continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.isFile() && /\.md$/i.test(entry.name)) files.push(abs);
    }
  };
  if (fs.existsSync(root)) walk(path.resolve(root));
  return files.sort();
}

function inferEntryType(relativePath) {
  const rel = normalizeRel(relativePath).toLowerCase();
  if (rel === 'goal.md') return 'goal';
  if (rel === 'architecture.md') return 'architecture';
  if (rel.startsWith('modules/')) return 'module';
  if (rel.startsWith('changes/')) return 'change';
  return 'document';
}

function inferTitle(markdown, relativePath) {
  const heading = /^#\s+(.+)$/m.exec(stripFrontmatter(markdown));
  return heading ? heading[1].trim() : path.basename(relativePath, path.extname(relativePath));
}

class MarkdownKnowledgeIndexer {
  constructor(options = {}) {
    if (!options.database) throw new Error('database is required');
    if (!options.embedder) throw new Error('embedder is required');
    this.database = options.database;
    this.embedder = options.embedder;
    this.maxChars = options.maxChars || DEFAULT_MAX_CHARS;
    this.overlapChars = options.overlapChars || DEFAULT_OVERLAP_CHARS;
  }

  async indexFile(input) {
    const filePath = path.resolve(input.filePath);
    const relativePath = normalizeRel(input.relativePath || path.basename(filePath));
    const markdown = fs.readFileSync(filePath, 'utf8');
    const documentHash = sha256(`chunker:${CHUNKER_VERSION}\n${markdown}`);
    const existing = await this.database.rowsForEntry(input.spaceId, relativePath);
    if (existing.length && existing.every(row => row.document_hash === documentHash)) {
      return { ok: true, action: 'unchanged', entryId: relativePath, chunks: existing.length, documentHash };
    }
    const title = inferTitle(markdown, relativePath);
    const rawChunks = chunkMarkdown(markdown, { maxChars: this.maxChars, overlapChars: this.overlapChars });
    const chunks = [];
    for (const chunk of rawChunks) {
      const searchText = [title, chunk.headingPath.join(' > '), chunk.chunkText].filter(Boolean).join('\n');
      chunks.push({
        ...chunk,
        title,
        entryType: inferEntryType(relativePath),
        searchText,
        vector: await this.embedder.embedPassage(searchText),
        sourcePaths: input.sourcePaths || [],
        sourceProjectId: input.sourceProjectId || '',
        sourceCommit: input.sourceCommit || '',
        documentHash,
      });
    }
    const result = await this.database.replaceEntry(input.spaceId, relativePath, chunks);
    return { ...result, entryId: relativePath, chunks: chunks.length, documentHash };
  }

  async indexDirectory(input) {
    const root = path.resolve(input.kbPath);
    const files = listMarkdownFiles(root);
    const present = new Set();
    const results = [];
    for (const filePath of files) {
      const relativePath = normalizeRel(path.relative(root, filePath));
      present.add(relativePath);
      results.push(await this.indexFile({ ...input, filePath, relativePath }));
    }
    const stale = (await this.database.entryIds(input.spaceId)).filter(entryId => !present.has(entryId));
    let deletedChunks = 0;
    for (const entryId of stale) deletedChunks += (await this.database.deleteEntry(input.spaceId, entryId)).deleted;
    if (await this.database.count([input.spaceId])) {
      await this.database.ensureSearchIndexes();
      await this.database.optimize();
    }
    return {
      ok: true,
      spaceId: input.spaceId,
      files: files.length,
      indexed: results.filter(item => item.action !== 'unchanged').length,
      unchanged: results.filter(item => item.action === 'unchanged').length,
      deletedEntries: stale.length,
      deletedChunks,
      results,
    };
  }
}

module.exports = {
  MarkdownKnowledgeIndexer,
  CHUNKER_VERSION,
  chunkMarkdown,
  listMarkdownFiles,
  inferEntryType,
};
