const fs = require('fs');
const path = require('path');

const MAX_INDEX_ITEMS = 100;
const MAX_TAGS = 6;
const MAX_SOURCE_PATHS = 4;
const MAX_LOOKUPS = 6;
const MAX_CELL_CHARS = 240;

function parseFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(String(text || ''));
  if (!match) return {};
  const meta = {};
  for (const line of match[1].split(/\r?\n/)) {
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line.trim());
    if (!m) continue;
    let value = m[2].trim();
    if (/^\[.*\]$/.test(value)) {
      value = value.slice(1, -1).split(',').map(s => s.trim()).filter(Boolean);
    }
    meta[m[1]] = value;
  }
  return meta;
}

function listMarkdown(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.md') && entry.name !== '00-index.md')
    .map(entry => {
      const rel = entry.name;
      const full = path.join(dir, entry.name);
      const text = fs.readFileSync(full, 'utf-8');
      const meta = parseFrontmatter(text);
      const title = meta.title || text.match(/^#\s+(.+)$/m)?.[1] || entry.name.replace(/\.md$/, '');
      return { rel, full, meta, title, updatedAt: meta.updatedAt || meta.period || '' };
    });
}

function metaList(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  if (!value) return [];
  return String(value).split(',').map(s => s.trim()).filter(Boolean);
}

function compactList(value, limit) {
  const items = metaList(value);
  if (items.length <= limit) return items.join(', ');
  return `${items.slice(0, limit).join(', ')} (+${items.length - limit})`;
}

function cell(value, maxChars = MAX_CELL_CHARS) {
  const text = Array.isArray(value) ? value.join(', ') : String(value || '');
  const clean = text.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim();
  if (!clean) return '-';
  return clean.length > maxChars ? `${clean.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…` : clean;
}

function indexSummary(total, shown) {
  return shown < total
    ? `Items: ${total} (showing ${shown}; use knowledge search or file search for older entries)`
    : `Items: ${total}`;
}

function writeModuleIndex(kbPath) {
  const dir = path.join(kbPath, 'modules');
  fs.mkdirSync(dir, { recursive: true });
  const items = listMarkdown(dir).sort((a, b) => a.title.localeCompare(b.title));
  // Modules describe the current system shape, so keep every module visible.
  // Their individual metadata cells are still bounded below.
  const visible = items;
  const lines = [
    '# Modules Index',
    '',
    indexSummary(items.length, visible.length),
    '',
    '| Module | Tags | Source Paths | Routes / Symbols | Updated |',
    '|---|---|---|---|---|',
  ];
  for (const item of visible) {
    const tagsText = compactList(item.meta.tags, MAX_TAGS);
    const sourcePaths = compactList(item.meta.sourcePaths, MAX_SOURCE_PATHS);
    const routes = metaList(item.meta.routes);
    const symbols = metaList(item.meta.symbols);
    const lookup = compactList([...routes, ...symbols], MAX_LOOKUPS);
    lines.push(`| [${item.title}](./${item.rel}) | ${cell(tagsText)} | ${cell(sourcePaths)} | ${cell(lookup)} | ${cell(item.updatedAt)} |`);
  }
  if (!items.length) lines.push('| No modules yet | - | - | - | - |');
  fs.writeFileSync(path.join(dir, '00-index.md'), lines.join('\n') + '\n', 'utf-8');
  return { path: 'modules/00-index.md', count: items.length };
}

function writeChangesIndex(kbPath) {
  const dir = path.join(kbPath, 'changes');
  fs.mkdirSync(dir, { recursive: true });
  const items = listMarkdown(dir).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)) || a.title.localeCompare(b.title));
  const visible = items.slice(0, MAX_INDEX_ITEMS);
  const lines = [
    '# Changes Index',
    '',
    indexSummary(items.length, visible.length),
    '',
    '| Change | Tags | Affected Modules | Period / Updated | Intent |',
    '|---|---|---|---|---|',
  ];
  for (const item of visible) {
    const tagsText = compactList(item.meta.tags, MAX_TAGS);
    const affected = compactList(item.meta.affectedModules, MAX_SOURCE_PATHS);
    const intent = item.meta.developmentIntent || item.meta.intent || '';
    lines.push(`| [${item.title}](./${item.rel}) | ${cell(tagsText)} | ${cell(affected)} | ${cell(item.updatedAt)} | ${cell(intent)} |`);
  }
  if (!items.length) lines.push('| No changes yet | - | - | - | - |');
  fs.writeFileSync(path.join(dir, '00-index.md'), lines.join('\n') + '\n', 'utf-8');
  return { path: 'changes/00-index.md', count: items.length };
}

function regenerateIndexes(kbPath) {
  return {
    modules: writeModuleIndex(kbPath),
    changes: writeChangesIndex(kbPath),
  };
}

module.exports = {
  parseFrontmatter,
  compactList,
  cell,
  regenerateIndexes,
  writeModuleIndex,
  writeChangesIndex,
};
