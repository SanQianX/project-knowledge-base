// Manage the small project-local CLAUDE.md pointer and the shared rule file.
// Project files keep only a home-relative @import. Detailed instructions live
// in ~/.project-knowledge so changing the rule never requires editing every
// imported repository.

const fs = require('fs');
const os = require('os');
const path = require('path');

const CLAUDE_MD_FILENAME = 'CLAUDE.md';
// Keep these markers byte-for-byte compatible with already imported projects.
const SECTION_MARKER_START = '<!-- KB-MANAGED:CLAUDE-MD:START — managed by project-knowledge -->';
const SECTION_MARKER_END = '<!-- KB-MANAGED:CLAUDE-MD:END -->';
const CENTRAL_MARKER_START = '<!-- KB-MANAGED:CENTRAL-RULES:START -->';
const CENTRAL_MARKER_END = '<!-- KB-MANAGED:CENTRAL-RULES:END -->';
const CENTRAL_RULE_FILENAME = 'claude-code-rules.md';
const CENTRAL_RULE_REFERENCE = '~/.project-knowledge/claude-code-rules.md';
const PROJECT_GUIDANCE = `@${CENTRAL_RULE_REFERENCE}`;

function normalizePath(value) {
  return typeof value === 'string' ? value.replace(/\\/g, '/') : '';
}

function buildRuleBlock() {
  return `${SECTION_MARKER_START}\n${PROJECT_GUIDANCE}\n${SECTION_MARKER_END}\n`;
}

const RULE_BLOCK = buildRuleBlock();

function buildCentralRules(input = {}) {
  const projectsPath = normalizePath(input.projectsPath) || '~/.project-knowledge/projects.json';
  return `# Project Knowledge Instructions

${CENTRAL_MARKER_START}
This managed section is shared by every project imported into project-knowledge.

## Resolve the current project's knowledge base

1. Resolve the current Git root with \`git rev-parse --show-toplevel\`.
2. Read the project registry at \`${projectsPath}\`. Its top-level keys are project slugs.
3. Normalize path separators and case as appropriate for the operating system, then match the Git root against each entry's \`gitPath\` or \`localPath\`.
4. Continue only when exactly one enabled entry matches and its \`kbPath\` exists. That entry's \`kbPath\` is the resolved knowledge-base path. If there is no unique match, do not guess and do not read another project's knowledge base.

## Read-only boundary

During ordinary interactive Claude Code development, the resolved knowledge base is strictly read-only. Do not create, edit, rename, move, or delete files under it, and do not update it at the end of an implementation task. Routine knowledge-base writes belong exclusively to project-knowledge post-commit automation after a successful Git commit. The only exception is an explicit user request to edit the knowledge base itself.

At the start of every session, before answering questions about prior work, and before implementing a non-trivial feature or fix:

1. If the matched registry entry has \`knowledgeBackend: "lancedb"\`, use the read-only local tools first:
   - \`project-knowledge-kb search --project <projectSlug> --query "<question>" --json\`
   - \`project-knowledge-kb ask --project <projectSlug> --query "<question>"\`
   - \`project-knowledge-kb get --project <projectSlug> --entry "<entryId>" --json\`
   - \`project-knowledge-kb history --project <projectSlug> --json\`
2. These tools automatically enforce the project's explicit, non-transitive related-project search scope. Never bypass that scope by opening the LanceDB files directly.
3. Treat returned \`chunk_text\` as the human-readable source text. Vectors are retrieval indexes and are never decoded into prose.
4. For a legacy Markdown project, read only \`GOAL.md\`, \`modules/00-index.md\`, and \`changes/00-index.md\` first, then open only the most relevant documents. These compatibility indexes intentionally contain compact metadata and only the most recent changes; if an older fact is not listed, use read-only filename or text search inside \`modules/\` and \`changes/\` instead of loading every document.
5. If there is no match, continue from source evidence without creating knowledge-base records during development. Do not load the whole knowledge base unless the user explicitly asks.

For this project's facts, the knowledge base outranks auto-memory, claude-mem, and conversational context. If they disagree, rely on the knowledge base and report the discrepancy when useful; do not resolve it by changing the knowledge base during ordinary development.
${CENTRAL_MARKER_END}
`;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function managedBlockRegex(start = SECTION_MARKER_START, end = SECTION_MARKER_END) {
  return new RegExp(`${escapeRegExp(start)}[\\s\\S]*?${escapeRegExp(end)}\\n*`);
}

function countOccurrences(text, needle) {
  if (typeof text !== 'string') return 0;
  let count = 0;
  let offset = 0;
  while ((offset = text.indexOf(needle, offset)) !== -1) {
    count += 1;
    offset += needle.length;
  }
  return count;
}

function blockShape(text, start = SECTION_MARKER_START, end = SECTION_MARKER_END) {
  const starts = countOccurrences(text, start);
  const ends = countOccurrences(text, end);
  const startIndex = typeof text === 'string' ? text.indexOf(start) : -1;
  const endIndex = typeof text === 'string' ? text.indexOf(end) : -1;
  return {
    starts,
    ends,
    valid: starts === 1 && ends === 1 && startIndex >= 0 && endIndex > startIndex,
    malformed: starts !== ends || starts > 1 || ends > 1 || (starts === 1 && endIndex < startIndex),
  };
}

function normalizeBlock(text) {
  return String(text || '').replace(/\r\n/g, '\n').trim();
}

function inspectText(text) {
  const shape = blockShape(text);
  if (shape.malformed) return { managed: false, state: 'malformed', current: false, needsRefresh: false };
  if (!shape.valid) return { managed: false, state: 'unmanaged', current: false, needsRefresh: false };
  const match = text.match(managedBlockRegex());
  const current = !!match && normalizeBlock(match[0]) === normalizeBlock(RULE_BLOCK);
  return {
    managed: true,
    state: current ? 'current' : 'outdated',
    current,
    needsRefresh: !current,
  };
}

function hasManagedBlock(text) {
  return inspectText(text).managed;
}

function ensureClaudeMdRule(repoPath) {
  const filePath = path.join(repoPath, CLAUDE_MD_FILENAME);
  let existing = null;
  try {
    if (fs.existsSync(filePath)) existing = fs.readFileSync(filePath, 'utf-8');
  } catch (error) {
    return { ok: false, action: 'read-failed', path: filePath, error: error.message };
  }

  try {
    if (existing != null) {
      const inspection = inspectText(existing);
      if (inspection.state === 'malformed') {
        return { ok: false, action: 'malformed', path: filePath, error: 'CLAUDE.md contains malformed or duplicate managed markers' };
      }
      if (inspection.managed) {
        const next = existing.replace(managedBlockRegex(), RULE_BLOCK);
        if (next === existing) return { ok: true, action: 'unchanged', path: filePath };
        fs.writeFileSync(filePath, next, 'utf-8');
        return { ok: true, action: inspection.current ? 'unchanged' : 'updated', path: filePath };
      }
    }
    const prefix = existing ? (existing.endsWith('\n') ? existing : `${existing}\n`) : '';
    const separator = existing ? '\n' : '';
    fs.mkdirSync(repoPath, { recursive: true });
    fs.writeFileSync(filePath, `${prefix}${separator}${RULE_BLOCK}`, 'utf-8');
    return { ok: true, action: existing ? 'appended' : 'created', path: filePath };
  } catch (error) {
    return { ok: false, action: 'write-failed', path: filePath, error: error.message };
  }
}

// Strict migration path used by the bulk refresh endpoint. It only replaces
// an existing, uniquely marked block and never appends to user-owned files.
function refreshClaudeMdRule(repoPath) {
  const status = readClaudeMdStatus(repoPath);
  if (!status.ok) return { ok: false, action: 'failed', path: status.path, error: status.error };
  if (status.state !== 'outdated') {
    return { ok: true, action: status.state === 'current' ? 'unchanged' : 'skipped', reason: status.state, path: status.path };
  }
  try {
    const text = fs.readFileSync(status.path, 'utf-8');
    if (inspectText(text).state !== 'outdated') {
      return { ok: true, action: 'skipped', reason: 'changed-during-refresh', path: status.path };
    }
    fs.writeFileSync(status.path, text.replace(managedBlockRegex(), RULE_BLOCK), 'utf-8');
    return { ok: true, action: 'updated', path: status.path };
  } catch (error) {
    return { ok: false, action: 'failed', path: status.path, error: error.message };
  }
}

function removeClaudeMdRule(repoPath) {
  const filePath = path.join(repoPath, CLAUDE_MD_FILENAME);
  let existing;
  try {
    if (!fs.existsSync(filePath)) return { ok: true, removed: false, reason: 'no CLAUDE.md', path: filePath };
    existing = fs.readFileSync(filePath, 'utf-8');
  } catch (error) {
    return { ok: false, removed: false, path: filePath, error: error.message };
  }
  const inspection = inspectText(existing);
  if (!inspection.managed) {
    return { ok: true, removed: false, reason: inspection.state === 'malformed' ? 'malformed managed block' : 'no KB-managed block', path: filePath };
  }
  try {
    const next = existing.replace(managedBlockRegex(), '').trim();
    if (!next) {
      fs.unlinkSync(filePath);
      return { ok: true, removed: true, fileDeleted: true, path: filePath };
    }
    fs.writeFileSync(filePath, `${next}\n`, 'utf-8');
    return { ok: true, removed: true, fileDeleted: false, path: filePath };
  } catch (error) {
    return { ok: false, removed: false, path: filePath, error: error.message };
  }
}

function readClaudeMdStatus(repoPath) {
  const filePath = path.join(repoPath || '', CLAUDE_MD_FILENAME);
  try {
    if (!repoPath || !fs.existsSync(filePath)) {
      return { ok: true, present: false, managed: false, current: false, needsRefresh: false, state: 'missing', path: filePath };
    }
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink()) {
      return { ok: true, present: true, managed: false, current: false, needsRefresh: false, state: 'symlink', path: filePath };
    }
    const text = fs.readFileSync(filePath, 'utf-8');
    const inspection = inspectText(text);
    const legacy = extractLegacyMeta(text);
    return {
      ok: true,
      present: true,
      ...inspection,
      format: inspection.current ? 'central-v1' : (inspection.managed ? 'legacy-inline' : null),
      rulesReference: inspection.current ? CENTRAL_RULE_REFERENCE : null,
      kbPath: legacy.kbPath,
      projectsPath: legacy.projectsPath,
      projectSlug: legacy.projectSlug,
      path: filePath,
      bytes: Buffer.byteLength(text, 'utf-8'),
    };
  } catch (error) {
    return { ok: false, present: true, managed: false, current: false, needsRefresh: false, state: 'unavailable', path: filePath, error: error.message };
  }
}

function extractLegacyMeta(text) {
  if (typeof text !== 'string') return { kbPath: null, projectsPath: null, projectSlug: null };
  const kb = /lives at:\s*\n\s*(\S[^\n]*)/.exec(text);
  const projects = /projects\.json:\s+((?:\/(?!\d)|~\/|[A-Za-z]:)[^\s\n]*)/.exec(text);
  const slug = /projectSlug:\s*([a-zA-Z0-9_-]+)/.exec(text);
  return {
    kbPath: kb ? normalizePath(kb[1].trim()) : null,
    projectsPath: projects ? normalizePath(projects[1].trim()) : null,
    projectSlug: slug ? slug[1].trim() : null,
  };
}

function defaultCentralRulesDir() {
  return process.env.KB_CLAUDE_RULES_DIR
    ? path.resolve(process.env.KB_CLAUDE_RULES_DIR)
    : path.join(os.homedir(), '.project-knowledge');
}

function ensureCentralRulesFile(input = {}) {
  const rulesDir = input.rulesDir ? path.resolve(input.rulesDir) : defaultCentralRulesDir();
  const filePath = path.join(rulesDir, CENTRAL_RULE_FILENAME);
  const canonical = buildCentralRules(input);
  let existing = '';
  try {
    if (fs.existsSync(filePath)) existing = fs.readFileSync(filePath, 'utf-8');
    let next;
    const shape = blockShape(existing, CENTRAL_MARKER_START, CENTRAL_MARKER_END);
    if (shape.malformed) {
      return { ok: false, action: 'malformed', path: filePath, error: 'central rules file contains malformed managed markers' };
    }
    if (shape.valid) {
      const match = canonical.match(managedBlockRegex(CENTRAL_MARKER_START, CENTRAL_MARKER_END));
      next = existing.replace(managedBlockRegex(CENTRAL_MARKER_START, CENTRAL_MARKER_END), match[0]);
    } else if (existing) {
      next = `${existing.trimEnd()}\n\n${canonical}`;
    } else {
      next = canonical;
    }
    if (normalizeBlock(existing) === normalizeBlock(next)) return { ok: true, action: 'unchanged', path: filePath, reference: CENTRAL_RULE_REFERENCE };
    fs.mkdirSync(rulesDir, { recursive: true });
    const tempPath = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tempPath, next, 'utf-8');
    fs.renameSync(tempPath, filePath);
    return { ok: true, action: existing ? 'updated' : 'created', path: filePath, reference: CENTRAL_RULE_REFERENCE };
  } catch (error) {
    return { ok: false, action: 'write-failed', path: filePath, reference: CENTRAL_RULE_REFERENCE, error: error.message };
  }
}

module.exports = {
  CLAUDE_MD_FILENAME,
  SECTION_MARKER_START,
  SECTION_MARKER_END,
  CENTRAL_MARKER_START,
  CENTRAL_MARKER_END,
  CENTRAL_RULE_FILENAME,
  CENTRAL_RULE_REFERENCE,
  PROJECT_GUIDANCE,
  RULE_BLOCK,
  buildRuleBlock,
  buildCentralRules,
  ensureCentralRulesFile,
  ensureClaudeMdRule,
  refreshClaudeMdRule,
  removeClaudeMdRule,
  readClaudeMdStatus,
};
