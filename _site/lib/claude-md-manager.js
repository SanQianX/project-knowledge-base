// _site/lib/claude-md-manager.js
//
// Install / uninstall a "Knowledge Base Reading Rule" block in an imported
// project's CLAUDE.md so Claude Code automatically reads the project's KB
// indexes before working in that repo. Hooked into hook-manager.js so the
// block is added when a post-commit hook is installed and removed when the
// hook is uninstalled.
//
// The default block (v2.4.2+) is fully portable: it embeds only the project
// slug, and instructs Claude Code to discover the user's `projects.json`
// registry at runtime via the $PROJECT_KNOWLEDGE_REGISTRY env var or the
// `~/.project-knowledge/projects.json` convention. It does NOT embed any
// absolute path — neither the developer's KB path nor the user's
// projects.json path — so a shared repo CLAUDE.md can be cloned to any
// developer without rewriting.
//
// Two back-compat forms remain supported for callers that explicitly opt in:
//   * `projectsPath` (string) — the absolute path to the user's
//     projects.json. Emitted only when the caller passes it; intended for
//     tests and advanced single-machine setups.
//   * `kbPath` (string) — the absolute path to the KB. Direct mode, only
//     used when the caller does not know the registry. This form
//     intentionally embeds an absolute path and is the only way to do so;
//     treat it as deprecated for shared repos.
//
// Safety contract:
//   * The block is bracketed by HTML-comment markers so we can replace or
//     remove it without touching the rest of the user's CLAUDE.md.
//   * ensureClaudeMdRule is idempotent: re-installing replaces the block
//     in place (lets us update the rule text or slug without leaving
//     duplicates).
//   * removeClaudeMdRule only deletes the marked block; if CLAUDE.md was
//     created by us and becomes empty, the file is also removed.
//   * No function throws on filesystem errors — they return { ok: false, ... }
//     so the caller (hook-manager) can still report a successful hook install
//     even when CLAUDE.md write was denied.

const fs = require('fs');
const path = require('path');

const CLAUDE_MD_FILENAME = 'CLAUDE.md';
const SECTION_MARKER_START = '<!-- KB-MANAGED:CLAUDE-MD:START — managed by project-knowledge -->';
const SECTION_MARKER_END = '<!-- KB-MANAGED:CLAUDE-MD:END -->';

const DISCOVERY_RULE_BODY =
  "Resolve this project's knowledge base through the current user's project registry.\n\n" +
  'Discovery order for the registry file\n' +
  '  1. The $PROJECT_KNOWLEDGE_REGISTRY env var (if set)\n' +
  '  2. ~/.project-knowledge/projects.json\n\n' +
  'Read that JSON file and use `registry[projectSlug].kbPath` as `<resolved kbPath>`.';

// Reading procedure body, with `__PREFIX__` as a placeholder for the index
// path prefix. The prefix depends on the form: `<resolved kbPath>/` for
// registry modes, the absolute kbPath for the legacy direct mode.
//
// The trigger phrase is intentionally unconditional on session start and on
// any recall/lookup question. claude-mem and auto-memory are always one tool
// call away and tend to win by default if the rule only fires on heavy work;
// listing those triggers explicitly closes that gap so the KB gets consulted
// first for "what did we do before", "上次改动", "之前的实现", etc.
const READING_PROCEDURE_BODY_TEMPLATE =
  'At the start of every session, AND before answering any question about\n' +
  'what changed, when, why, or what was previously developed in this repo\n' +
  '(including "what did we work on before", "上次改动", "之前的实现", "what\n' +
  'did you change last time"), AND before implementing a non-trivial feature\n' +
  'or fix, follow this procedure:\n\n' +
  '1. **Read only the indexes first**:\n' +
  '   `__PREFIX__GOAL.md`, `__PREFIX__modules/00-index.md`,\n' +
  '   `__PREFIX__changes/00-index.md`.\n' +
  "2. **Compare** the user request, changed files, API routes, symbols, and\n" +
  '   keywords against the module and change indexes.\n' +
  '3. **Open only the top-relevant** module and change docs based on the match.\n' +
  '4. **No hits? Treat as a new feature area.** Propose a new module + change\n' +
  '   entry instead of patching unrelated knowledge.\n' +
  '5. **Do not load the whole KB** unless explicitly asked.\n\n' +
  'The KB outranks auto-memory, claude-mem, and conversational context for\n' +
  "this project's facts. When the user asks about this project's history,\n" +
  'decisions, architecture, prior work, or anything that could be answered\n' +
  'from prior development, resolve from the KB first; only fall back to\n' +
  'claude-mem or auto-memory if the KB has no answer. If a memory record and\n' +
  'a KB entry disagree, the KB wins — update or remove the stale memory.';

function buildReadingProcedure(prefix) {
  return READING_PROCEDURE_BODY_TEMPLATE.replace(/__PREFIX__/g, prefix);
}

function normalizePath(p) {
  return typeof p === 'string' ? p.replace(/\\/g, '/') : '';
}

function normalizeRuleOptions(input) {
  if (typeof input === 'string') return { kbPath: input };
  return input && typeof input === 'object' ? input : {};
}

function buildRuleBlock(input = {}) {
  const opts = normalizeRuleOptions(input);
  const kb = normalizePath(opts.kbPath);
  const projectsPath = normalizePath(opts.projectsPath);
  const projectSlug = typeof opts.projectSlug === 'string' ? opts.projectSlug.trim() : '';
  const hasRegistry = !!(projectsPath && projectSlug);
  const hasDirect = !!(kb && !projectSlug);
  const hasSlugOnly = !!(projectSlug && !projectsPath);

  let location;
  let prefix;
  if (hasRegistry) {
    // Back-compat explicit form: caller supplied a concrete projects.json
    // path. Still includes the slug. This is the only form that embeds an
    // absolute path and should not be used for shared-repo CLAUDE.md.
    location =
      `Resolve this project's knowledge base through the current user's project registry:\n\n` +
      `  projects.json: ${projectsPath}\n` +
      `  projectSlug: ${projectSlug}\n\n` +
      `Read that JSON file and use \`registry[projectSlug].kbPath\` as \`<resolved kbPath>\`.`;
    prefix = '<resolved kbPath>/';
  } else if (hasSlugOnly) {
    // Default portable form: discovery chain + slug. No absolute path.
    location =
      `${DISCOVERY_RULE_BODY}\n\n` +
      `projectSlug: ${projectSlug}`;
    prefix = '<resolved kbPath>/';
  } else if (hasDirect) {
    // Legacy direct form. Caller does not know the registry. Embeds the
    // absolute kbPath. Kept for back-compat with single-machine callers.
    location = `This project's knowledge base lives at:\n\n  ${kb}\n`;
    prefix = `${kb}/`;
  } else {
    // Nothing supplied: give Claude a discoverable instruction but no path.
    location = 'Locate the project knowledge base (registered with the project-knowledge manager).';
    prefix = '<resolved kbPath>/';
  }

  return `${SECTION_MARKER_START}
## Knowledge Base Reading Rule

${location}

${buildReadingProcedure(prefix)}
${SECTION_MARKER_END}
`;
}

// Back-compat constant. Existing callers and tests that imported
// RULE_BLOCK without a kbPath still get a sensible (no-path) block.
const RULE_BLOCK = buildRuleBlock();

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function blockRegex() {
  return new RegExp(
    `${escapeRegExp(SECTION_MARKER_START)}[\\s\\S]*?${escapeRegExp(SECTION_MARKER_END)}\\n*`
  );
}

function hasManagedBlock(text) {
  return typeof text === 'string'
    && text.includes(SECTION_MARKER_START)
    && text.includes(SECTION_MARKER_END);
}

function ensureClaudeMdRule(repoPath, opts = {}) {
  const filePath = path.join(repoPath, CLAUDE_MD_FILENAME);
  const ruleBlock = buildRuleBlock(opts);
  let existing = null;
  try {
    if (fs.existsSync(filePath)) existing = fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    return { ok: false, action: 'read-failed', path: filePath, error: err.message };
  }

  try {
    if (existing && hasManagedBlock(existing)) {
      const next = existing.replace(blockRegex(), ruleBlock);
      fs.writeFileSync(filePath, next, 'utf-8');
      return { ok: true, action: 'updated', path: filePath };
    }
    const prefix = existing
      ? (existing.endsWith('\n') ? existing : existing + '\n')
      : '';
    const separator = existing ? '\n' : '';
    fs.writeFileSync(filePath, `${prefix}${separator}${ruleBlock}`, 'utf-8');
    return {
      ok: true,
      action: existing ? 'appended' : 'created',
      path: filePath,
    };
  } catch (err) {
    return { ok: false, action: 'write-failed', path: filePath, error: err.message };
  }
}

function removeClaudeMdRule(repoPath) {
  const filePath = path.join(repoPath, CLAUDE_MD_FILENAME);
  let existing = null;
  try {
    if (!fs.existsSync(filePath)) {
      return { ok: true, removed: false, reason: 'no CLAUDE.md', path: filePath };
    }
    existing = fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    return { ok: false, removed: false, path: filePath, error: err.message };
  }

  if (!hasManagedBlock(existing)) {
    return { ok: true, removed: false, reason: 'no KB-managed block', path: filePath };
  }

  try {
    const next = existing.replace(blockRegex(), '').replace(/^\s+|\s+$/g, '');
    if (next.length === 0) {
      fs.unlinkSync(filePath);
      return { ok: true, removed: true, fileDeleted: true, path: filePath };
    }
    fs.writeFileSync(filePath, `${next}\n`, 'utf-8');
    return { ok: true, removed: true, fileDeleted: false, path: filePath };
  } catch (err) {
    return { ok: false, removed: false, path: filePath, error: err.message };
  }
}

function readClaudeMdStatus(repoPath) {
  const filePath = path.join(repoPath, CLAUDE_MD_FILENAME);
  if (!fs.existsSync(filePath)) {
    return { ok: true, present: false, managed: false, path: filePath };
  }
  try {
    const text = fs.readFileSync(filePath, 'utf-8');
    const kbPath = extractKbPath(text);
    const registry = extractRegistryMeta(text);
    return {
      ok: true,
      present: true,
      managed: hasManagedBlock(text),
      kbPath: kbPath || null,
      projectsPath: registry.projectsPath || null,
      projectSlug: registry.projectSlug || null,
      path: filePath,
      bytes: Buffer.byteLength(text, 'utf-8'),
    };
  } catch (err) {
    return { ok: false, present: true, managed: false, path: filePath, error: err.message };
  }
}

function extractKbPath(text) {
  // Recover the kbPath from a managed block so readClaudeMdStatus can echo
  // back what ensureClaudeMdRule wrote. Looks for the line "lives at:"
  // followed by an indented path on the next line.
  if (typeof text !== 'string') return null;
  const m = /lives at:\s*\n\s*(\S[^\n]*)/.exec(text);
  return m ? normalizePath(m[1].trim()) : null;
}

function extractRegistryMeta(text) {
  // The default v2.4.2+ block only embeds `projectSlug:`. The legacy
  // v2.4.1 registry-mode block additionally embeds `projects.json: <path>`.
  // Both forms are parsed here for back-compat with already-installed blocks.
  if (typeof text !== 'string') return {};
  // The projects.json path must look like a path (start with `/`, `~`, or a
  // drive letter) — this rules out prose like "Discovery order for the
  // registry file" lines that happen to mention the filename. The capture
  // extends over the rest of the path (anything up to whitespace or newline).
  const projectsPathMatch = /projects\.json:\s+((?:\/(?!\d)|~\/|[A-Za-z]:)[^\s\n]*)/.exec(text);
  const projectSlugMatch = /projectSlug:\s*([a-zA-Z0-9_-]+)/.exec(text);
  return {
    projectsPath: projectsPathMatch ? normalizePath(projectsPathMatch[1].trim()) : null,
    projectSlug: projectSlugMatch ? projectSlugMatch[1].trim() : null,
  };
}

module.exports = {
  CLAUDE_MD_FILENAME,
  SECTION_MARKER_START,
  SECTION_MARKER_END,
  RULE_BLOCK,
  buildRuleBlock,
  ensureClaudeMdRule,
  removeClaudeMdRule,
  readClaudeMdStatus,
};
