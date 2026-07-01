// KB Validator
//
// The current knowledge base framework is intentionally small:
//
//   README.md
//   GOAL.md
//   ARCHITECTURE.md
//   modules/
//     00-index.md
//   changes/
//     00-index.md
//
// Everything inside this layout is trusted project memory. AI working files,
// drafts, context packs, backups, and Claude workbench sessions live under
// `_site/_ai/<slug>/`, outside the project KB.

const fs = require('fs');
const path = require('path');
const { KB_FRAMEWORK_SCHEMA, PROJECT_SCHEMA_VERSION, TOP_LEVEL } = require('./kb-framework');

function walkTrustedFiles(root, dir = root, prefix = '') {
  const out = [];
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith('.')) continue;
    if (entry.name === '_ai' || entry.name === '_meta' || entry.name === 'node_modules') continue;
    const rel = (prefix ? `${prefix}/` : '') + entry.name;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkTrustedFiles(root, full, rel));
    else if (entry.isFile() && entry.name.endsWith('.md')) {
      out.push({ path: rel, content: fs.readFileSync(full, 'utf-8'), size: fs.statSync(full).size });
    }
  }
  return out;
}

function validateKb(kbPath) {
  const info = {
    kbPath,
    schemaVersion: PROJECT_SCHEMA_VERSION,
    frameworkSchema: KB_FRAMEWORK_SCHEMA,
    goalStatus: 'unknown',
    architectureStatus: 'unknown',
    trustedKnowledgeEntries: 0,
  };

  if (!kbPath || !fs.existsSync(kbPath)) {
    return { ok: false, status: 400, error: `kbPath does not exist: ${kbPath}` };
  }
  if (!fs.statSync(kbPath).isDirectory()) {
    return { ok: false, status: 400, error: `kbPath is not a directory: ${kbPath}` };
  }

  const errors = [];
  const warnings = [];
  const required = [
    ['README.md', 'file'],
    ['GOAL.md', 'file'],
    ['ARCHITECTURE.md', 'file'],
    ['modules', 'dir'],
    ['changes', 'dir'],
    ['modules/00-index.md', 'file'],
    ['changes/00-index.md', 'file'],
  ];
  for (const [rel, kind] of required) {
    const abs = path.join(kbPath, rel);
    if (!fs.existsSync(abs)) {
      errors.push(`${rel} missing`);
      continue;
    }
    const stat = fs.statSync(abs);
    if (kind === 'file' && !stat.isFile()) errors.push(`${rel} must be a file`);
    if (kind === 'dir' && !stat.isDirectory()) errors.push(`${rel} must be a directory`);
  }

  const top = fs.readdirSync(kbPath).filter(name => !name.startsWith('.')).sort();
  const unexpected = top.filter(name => !TOP_LEVEL.includes(name));
  if (unexpected.length) errors.push(`unexpected top-level KB items: ${unexpected.join(', ')}`);
  if (fs.existsSync(path.join(kbPath, '_ai'))) errors.push('_ai must not live inside a project KB');
  if (fs.existsSync(path.join(kbPath, 'kb-manifest.json'))) errors.push('kb-manifest.json is not part of the current KB framework');

  info.goalStatus = fs.existsSync(path.join(kbPath, 'GOAL.md')) ? 'present' : 'missing';
  info.architectureStatus = fs.existsSync(path.join(kbPath, 'ARCHITECTURE.md')) ? 'present' : 'missing';
  info.trustedKnowledgeEntries = walkTrustedFiles(kbPath).length;

  return {
    ok: errors.length === 0,
    status: errors.length ? 422 : 200,
    info,
    errors,
    warnings,
  };
}

function buildPrContextPack(kbPath) {
  const validation = validateKb(kbPath);
  if (!validation.ok) return { ok: false, status: validation.status || 422, error: 'kb invalid', validation };
  const files = walkTrustedFiles(kbPath);
  const readFile = rel => files.find(item => item.path === rel) || null;
  return {
    ok: true,
    pack: {
      schema: 'pr-context-pack/v1',
      frameworkSchema: KB_FRAMEWORK_SCHEMA,
      generatedAt: new Date().toISOString(),
      project: path.basename(kbPath),
      goal: readFile('GOAL.md'),
      architecture: readFile('ARCHITECTURE.md'),
      indexes: {
        modules: readFile('modules/00-index.md'),
        changes: readFile('changes/00-index.md'),
      },
      trustedKnowledge: files,
    },
  };
}

module.exports = {
  KB_FRAMEWORK_SCHEMA,
  validateKb,
  buildPrContextPack,
  walkTrustedFiles,
};
