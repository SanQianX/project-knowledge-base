const fs = require('fs');
const path = require('path');

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

function tagLine(items) {
  const tags = new Set();
  for (const item of items) {
    const raw = item.meta.tags;
    if (Array.isArray(raw)) raw.forEach(t => tags.add(t));
    else if (raw) String(raw).split(',').map(s => s.trim()).filter(Boolean).forEach(t => tags.add(t));
  }
  return [...tags].sort();
}

function metaList(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  if (!value) return [];
  return String(value).split(',').map(s => s.trim()).filter(Boolean);
}

function cell(value) {
  const text = Array.isArray(value) ? value.join(', ') : String(value || '');
  return text.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|') || '-';
}

function writeModuleIndex(kbPath) {
  const dir = path.join(kbPath, 'modules');
  fs.mkdirSync(dir, { recursive: true });
  const items = listMarkdown(dir).sort((a, b) => a.title.localeCompare(b.title));
  const tags = tagLine(items);
  const lines = [
    '# Modules Index',
    '',
    tags.length ? `Tags: ${tags.map(t => `\`${t}\``).join(', ')}` : 'Tags: none',
    '',
    '| Module | Tags | Source Paths | Routes / Symbols | Updated |',
    '|---|---|---|---|---|',
  ];
  for (const item of items) {
    const tagsText = metaList(item.meta.tags).join(', ');
    const sourcePaths = metaList(item.meta.sourcePaths).join(', ');
    const routes = metaList(item.meta.routes).join(', ');
    const symbols = metaList(item.meta.symbols).join(', ');
    const lookup = [routes, symbols].filter(Boolean).join(' / ');
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
  const tags = tagLine(items);
  const lines = [
    '# Changes Index',
    '',
    tags.length ? `Tags: ${tags.map(t => `\`${t}\``).join(', ')}` : 'Tags: none',
    '',
    '| Change | Tags | Affected Modules | Period / Updated | Intent |',
    '|---|---|---|---|---|',
  ];
  for (const item of items) {
    const tagsText = metaList(item.meta.tags).join(', ');
    const affected = metaList(item.meta.affectedModules).join(', ');
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
  regenerateIndexes,
  writeModuleIndex,
  writeChangesIndex,
};
