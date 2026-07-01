// Run: node _site/_test/claude-md-manager-test.js
//
// Unit tests for claude-md-manager:
//   1. Creates CLAUDE.md from scratch with the KB-managed block.
//   2. Appends the block to a pre-existing CLAUDE.md without managed markers.
//   3. Replaces the existing block on re-install (idempotent, no duplicates).
//   4. Preserves surrounding user content across updates.
//   5. Removes only the marked block, leaves the rest of the file alone.
//   6. Removes CLAUDE.md entirely when the file became empty after removal.
//   7. Reports status correctly: present / managed / not-managed / absent.
//   8. Never throws on filesystem errors — returns ok:false instead.
//   9. Embeds the supplied kbPath (absolute) into the rule block.
//  10. Replaces the kbPath on re-install when the registry path changes.
//  11. Falls back to the "locate the KB" wording when no kbPath is given.

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  CLAUDE_MD_FILENAME,
  SECTION_MARKER_START,
  SECTION_MARKER_END,
  RULE_BLOCK,
  buildRuleBlock,
  ensureClaudeMdRule,
  removeClaudeMdRule,
  readClaudeMdStatus,
} = require('../lib/claude-md-manager');

const SANDBOX = path.join(os.tmpdir(), `kb-claude-md-test-${process.pid}-${Date.now()}`);

function assert(cond, msg) { if (!cond) throw new Error('ASSERT: ' + msg); }

function rmrf(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch {} }

function makeRepo() {
  rmrf(SANDBOX);
  fs.mkdirSync(SANDBOX, { recursive: true });
  const repo = path.join(SANDBOX, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  return repo;
}

function readFile(p) { return fs.readFileSync(p, 'utf-8'); }

function countOccurrences(text, needle) {
  let count = 0;
  let idx = 0;
  while ((idx = text.indexOf(needle, idx)) !== -1) { count++; idx += needle.length; }
  return count;
}

(() => {
  // 1. Creates CLAUDE.md from scratch.
  {
    const repo = makeRepo();
    const result = ensureClaudeMdRule(repo);
    assert(result.ok, 'create: should succeed: ' + JSON.stringify(result));
    assert(result.action === 'created', `create: action should be "created", got ${result.action}`);
    const p = path.join(repo, CLAUDE_MD_FILENAME);
    assert(fs.existsSync(p), 'create: CLAUDE.md should exist');
    const text = readFile(p);
    assert(text.includes(SECTION_MARKER_START), 'create: file should contain start marker');
    assert(text.includes(SECTION_MARKER_END), 'create: file should contain end marker');
    assert(text.includes('Knowledge Base Reading Rule'), 'create: file should contain rule heading');
    assert(countOccurrences(text, SECTION_MARKER_START) === 1, 'create: should have exactly one start marker');
    assert(countOccurrences(text, SECTION_MARKER_END) === 1, 'create: should have exactly one end marker');
  }

  // 2. Appends to a pre-existing CLAUDE.md without managed markers.
  {
    const repo = makeRepo();
    const p = path.join(repo, CLAUDE_MD_FILENAME);
    const original = '# My Project\n\nThis is the user-written intro.\n';
    fs.writeFileSync(p, original, 'utf-8');
    const result = ensureClaudeMdRule(repo);
    assert(result.ok, 'append: should succeed: ' + JSON.stringify(result));
    assert(result.action === 'appended', `append: action should be "appended", got ${result.action}`);
    const text = readFile(p);
    assert(text.startsWith(original.trimEnd()) || text.includes('# My Project'), 'append: original content must be preserved');
    assert(text.includes('This is the user-written intro.'), 'append: original prose must be preserved');
    assert(text.includes(SECTION_MARKER_START), 'append: managed markers should be added');
  }

  // 3. Idempotent re-install: replaces existing block in place, no duplicates.
  {
    const repo = makeRepo();
    ensureClaudeMdRule(repo);
    const p = path.join(repo, CLAUDE_MD_FILENAME);
    const beforeText = readFile(p);
    // Replace the rule block content in-place by simulating the user editing
    // the rule, then re-run ensure and assert the block is replaced, not duplicated.
    const tampered = beforeText.replace(
      '## Knowledge Base Reading Rule',
      '## Knowledge Base Reading Rule (tampered by user)'
    );
    fs.writeFileSync(p, tampered, 'utf-8');

    const result = ensureClaudeMdRule(repo);
    assert(result.ok, 'reinstall: should succeed: ' + JSON.stringify(result));
    assert(result.action === 'updated', `reinstall: action should be "updated", got ${result.action}`);
    const afterText = readFile(p);
    assert(countOccurrences(afterText, SECTION_MARKER_START) === 1,
      `reinstall: should have exactly one start marker, got ${countOccurrences(afterText, SECTION_MARKER_START)}`);
    assert(countOccurrences(afterText, SECTION_MARKER_END) === 1,
      `reinstall: should have exactly one end marker, got ${countOccurrences(afterText, SECTION_MARKER_END)}`);
    assert(!afterText.includes('(tampered by user)'),
      'reinstall: tampered content should be replaced by canonical block');
    assert(afterText.includes('Knowledge Base Reading Rule'),
      'reinstall: canonical rule heading should be present');
  }

  // 4. Preserves surrounding user content across updates.
  {
    const repo = makeRepo();
    const p = path.join(repo, CLAUDE_MD_FILENAME);
    const original = `# Project Notes

Some user-specific instructions that must survive updates.

${RULE_BLOCK}

## Build commands

- \`npm run build\`
- \`npm test\`
`;
    fs.writeFileSync(p, original, 'utf-8');

    const result = ensureClaudeMdRule(repo);
    assert(result.ok && result.action === 'updated', 'preserve: should detect existing block and update it');
    const text = readFile(p);
    assert(text.includes('Project Notes'), 'preserve: heading before block must survive');
    assert(text.includes('Some user-specific instructions'), 'preserve: prose before block must survive');
    assert(text.includes('Build commands'), 'preserve: heading after block must survive');
    assert(text.includes('npm run build'), 'preserve: code block after block must survive');
    assert(countOccurrences(text, SECTION_MARKER_START) === 1, 'preserve: exactly one start marker');
  }

  // 5. Removes only the marked block, leaves the rest alone.
  {
    const repo = makeRepo();
    const p = path.join(repo, CLAUDE_MD_FILENAME);
    const original = `# Project Notes

Some user prose.

${RULE_BLOCK}

## Build

\`npm test\`
`;
    fs.writeFileSync(p, original, 'utf-8');

    const result = removeClaudeMdRule(repo);
    assert(result.ok, 'remove: should succeed: ' + JSON.stringify(result));
    assert(result.removed === true, 'remove: should report removed=true');
    assert(result.fileDeleted === false, 'remove: should not delete file when other content remains');
    const text = readFile(p);
    assert(text.includes('Project Notes'), 'remove: content before block must survive');
    assert(text.includes('Some user prose.'), 'remove: prose before block must survive');
    assert(text.includes('Build'), 'remove: content after block must survive');
    assert(text.includes('npm test'), 'remove: code after block must survive');
    assert(!text.includes(SECTION_MARKER_START), 'remove: start marker should be gone');
    assert(!text.includes(SECTION_MARKER_END), 'remove: end marker should be gone');
    assert(!text.includes('Knowledge Base Reading Rule'), 'remove: rule heading should be gone');
  }

  // 6. Removes CLAUDE.md entirely when nothing else remains.
  {
    const repo = makeRepo();
    ensureClaudeMdRule(repo);
    const p = path.join(repo, CLAUDE_MD_FILENAME);
    assert(fs.existsSync(p), 'remove-empty: CLAUDE.md should exist before remove');

    const result = removeClaudeMdRule(repo);
    assert(result.ok, 'remove-empty: should succeed');
    assert(result.removed === true, 'remove-empty: removed=true');
    assert(result.fileDeleted === true, 'remove-empty: fileDeleted=true when file becomes empty');
    assert(!fs.existsSync(p), 'remove-empty: CLAUDE.md should be deleted');
  }

  // 7. Status: absent, present-not-managed, present-managed.
  {
    const repo = makeRepo();
    let status = readClaudeMdStatus(repo);
    assert(status.ok && status.present === false && status.managed === false,
      `status-absent: ${JSON.stringify(status)}`);

    const p = path.join(repo, CLAUDE_MD_FILENAME);
    fs.writeFileSync(p, '# Plain project\n', 'utf-8');
    status = readClaudeMdStatus(repo);
    assert(status.present === true && status.managed === false,
      `status-present-not-managed: ${JSON.stringify(status)}`);

    ensureClaudeMdRule(repo);
    status = readClaudeMdStatus(repo);
    assert(status.present === true && status.managed === true,
      `status-managed: ${JSON.stringify(status)}`);
    assert(status.bytes > 0, 'status-managed: bytes should be > 0');
  }

  // 8. No-throw on filesystem errors — returns ok:false.
  {
    const repo = makeRepo();
    // Pre-create CLAUDE.md as a directory to force read failure inside
    // ensureClaudeMdRule's stat+read path. Then remove it before testing
    // write failure on a path whose parent is not writable.
    const nonexistent = path.join(SANDBOX, 'no-such-repo');
    const r1 = ensureClaudeMdRule(nonexistent);
    // First call on missing path: it WILL create the file (parent exists).
    // So this isn't an error path. Instead, test by passing a path whose
    // parent is a file (not a directory).
    const blockerParent = path.join(SANDBOX, 'blocker');
    fs.writeFileSync(blockerParent, 'not a directory', 'utf-8');
    const blockedRepo = path.join(blockerParent, 'repo');
    const r2 = ensureClaudeMdRule(blockedRepo);
    assert(r2.ok === false, `error-path: should return ok=false, got ${JSON.stringify(r2)}`);
    assert(typeof r2.error === 'string', 'error-path: should include error string');
  }

  // 9. removeClaudeMdRule on a non-KB-managed CLAUDE.md is a no-op.
  {
    const repo = makeRepo();
    const p = path.join(repo, CLAUDE_MD_FILENAME);
    const original = '# user-written content only\n';
    fs.writeFileSync(p, original, 'utf-8');
    const result = removeClaudeMdRule(repo);
    assert(result.ok, 'remove-noop: should succeed');
    assert(result.removed === false, `remove-noop: removed should be false, got ${result.removed}`);
    assert(result.reason === 'no KB-managed block', `remove-noop: reason ${result.reason}`);
    assert(readFile(p) === original, 'remove-noop: file should be untouched');
  }

  // 10. removeClaudeMdRule when CLAUDE.md is missing.
  {
    const repo = makeRepo();
    const result = removeClaudeMdRule(repo);
    assert(result.ok, 'remove-missing: should succeed');
    assert(result.removed === false, 'remove-missing: removed=false');
    assert(result.reason === 'no CLAUDE.md', `remove-missing: reason ${result.reason}`);
  }

  // 11. Default v2.4.2+ form: discovery chain + slug, no absolute path
  //     embedded. This is the form that lands in shared repos.
  {
    const repo = makeRepo();
    const projectSlug = 'kb-postcheck-agent';
    const result = ensureClaudeMdRule(repo, { projectSlug });
    assert(result.ok, 'portable-embed: should succeed');
    const text = readFile(path.join(repo, CLAUDE_MD_FILENAME));
    // Discovery chain is the key signal of v2.4.2+ behavior.
    assert(text.includes('$PROJECT_KNOWLEDGE_REGISTRY'),
      'portable-embed: block should mention $PROJECT_KNOWLEDGE_REGISTRY env var');
    assert(text.includes('~/.project-knowledge/projects.json'),
      'portable-embed: block should mention tilde-convention fallback');
    // Slug is the only project-specific thing embedded.
    assert(text.includes(`projectSlug: ${projectSlug}`),
      'portable-embed: block should include projectSlug');
    // Index paths use the resolved placeholder.
    assert(text.includes('<resolved kbPath>/GOAL.md'),
      'portable-embed: index paths should use resolved placeholder');
    assert(text.includes('<resolved kbPath>/modules/00-index.md'),
      'portable-embed: modules index path uses resolved placeholder');
    assert(text.includes('<resolved kbPath>/changes/00-index.md'),
      'portable-embed: changes index path uses resolved placeholder');
    // Hard guarantee: no absolute path is embedded in the default form.
    assert(!text.includes('projects.json: '),
      'portable-embed: default form must NOT include "projects.json: <path>" line');
    assert(!text.includes('C:/'), 'portable-embed: default form must not embed any C:/ path');
    assert(!text.includes('Users/'),
      'portable-embed: default form must not embed any /Users/ path');
    assert(!text.includes('lives at:'),
      'portable-embed: default form must not use legacy "lives at" direct mode');
    // Status reflects what was written.
    const status = readClaudeMdStatus(repo);
    assert(status.kbPath === null,
      `portable-embed: status.kbPath should be null, got ${status.kbPath}`);
    assert(status.projectsPath === null,
      `portable-embed: status.projectsPath should be null, got ${status.projectsPath}`);
    assert(status.projectSlug === projectSlug,
      `portable-embed: status.projectSlug should report ${projectSlug}, got ${status.projectSlug}`);
  }

  // 12. Re-installing with a different slug replaces the block (no leftover
  //     from the previous slug).
  {
    const repo = makeRepo();
    ensureClaudeMdRule(repo, { projectSlug: 'project-a' });
    const textA = readFile(path.join(repo, CLAUDE_MD_FILENAME));
    assert(textA.includes('projectSlug: project-a'),
      'slug-replace: should contain project-a initially');
    assert(!textA.includes('projectSlug: project-b'),
      'slug-replace: should not contain project-b initially');

    const result = ensureClaudeMdRule(repo, { projectSlug: 'project-b' });
    assert(result.ok && result.action === 'updated',
      'slug-replace: re-install should report updated');
    const textB = readFile(path.join(repo, CLAUDE_MD_FILENAME));
    assert(textB.includes('projectSlug: project-b'),
      'slug-replace: should now contain project-b');
    assert(!textB.includes('projectSlug: project-a'),
      'slug-replace: should no longer contain project-a');
    assert(countOccurrences(textB, SECTION_MARKER_START) === 1,
      'slug-replace: exactly one start marker');
    assert(countOccurrences(textB, SECTION_MARKER_END) === 1,
      'slug-replace: exactly one end marker');
    const status = readClaudeMdStatus(repo);
    assert(status.projectSlug === 'project-b',
      `slug-replace: status should report project-b, got ${status.projectSlug}`);
    assert(status.projectsPath === null,
      'slug-replace: status should not report projectsPath in default form');
    assert(status.kbPath === null,
      'slug-replace: status should not report kbPath in default form');
  }

  // 13. Back-compat: explicit projectsPath + projectSlug produces the
  //     legacy v2.4.1 form (still supported for advanced opt-in callers
  //     and tests). Default callers do not get this form.
  {
    const repo = makeRepo();
    const projectsPath = path.join(SANDBOX, '.project-knowledge', 'projects.json');
    const projectSlug = 'kb-postcheck-agent';
    const result = ensureClaudeMdRule(repo, { projectsPath, projectSlug });
    assert(result.ok, 'legacy-embed: should succeed');
    const text = readFile(path.join(repo, CLAUDE_MD_FILENAME));
    const expectedRegistry = projectsPath.replace(/\\/g, '/');
    assert(text.includes(`projects.json: ${expectedRegistry}`),
      'legacy-embed: block should include projectsPath');
    assert(text.includes(`projectSlug: ${projectSlug}`),
      'legacy-embed: block should include projectSlug');
    assert(text.includes('<resolved kbPath>/GOAL.md'),
      'legacy-embed: index paths use resolved placeholder');
    const status = readClaudeMdStatus(repo);
    assert(status.kbPath === null, 'legacy-embed: status.kbPath should be null');
    assert(status.projectsPath === expectedRegistry,
      `legacy-embed: status.projectsPath should report ${expectedRegistry}`);
    assert(status.projectSlug === projectSlug, 'legacy-embed: status.projectSlug should match');
  }

  // 14. buildRuleBlock() helper: pure string-builder, covers all four forms.
  {
    // (a) Default: slug only — portable discovery-chain form.
    const portable = buildRuleBlock({ projectSlug: 'demo' });
    assert(portable.startsWith(SECTION_MARKER_START),
      'buildRuleBlock portable: starts with start marker');
    assert(portable.trimEnd().endsWith(SECTION_MARKER_END),
      'buildRuleBlock portable: ends with end marker');
    assert(portable.includes('projectSlug: demo'),
      'buildRuleBlock portable: embeds projectSlug');
    assert(portable.includes('$PROJECT_KNOWLEDGE_REGISTRY'),
      'buildRuleBlock portable: embeds env-var discovery');
    assert(portable.includes('~/.project-knowledge/projects.json'),
      'buildRuleBlock portable: embeds tilde-fallback discovery');
    assert(portable.includes('<resolved kbPath>/GOAL.md'),
      'buildRuleBlock portable: uses resolved placeholder for GOAL.md');
    assert(!portable.includes('projects.json: '),
      'buildRuleBlock portable: must not include "projects.json: <path>" line');
    assert(!portable.includes('C:/'),
      'buildRuleBlock portable: must not embed any C:/ path');
    assert(!portable.includes('D:/'),
      'buildRuleBlock portable: must not embed any D:/ path');

    // (b) Back-compat: explicit projectsPath + projectSlug — legacy form.
    const legacy = buildRuleBlock({
      projectsPath: 'C:/Users/Someone/.project-knowledge/projects.json',
      projectSlug: 'some-project',
    });
    assert(legacy.includes('projects.json: C:/Users/Someone/.project-knowledge/projects.json'),
      'buildRuleBlock legacy: registry projectsPath appears in block');
    assert(legacy.includes('projectSlug: some-project'),
      'buildRuleBlock legacy: projectSlug appears in block');
    assert(legacy.includes('<resolved kbPath>/GOAL.md'),
      'buildRuleBlock legacy: uses resolved placeholder paths');
    assert(!legacy.includes('~/'),
      'buildRuleBlock legacy: tilde-fallback should not appear when explicit path is given');

    // (c) Direct: kbPath only — legacy direct mode.
    const direct = buildRuleBlock('D:/some/kb');
    assert(direct.includes('D:/some/kb'),
      'buildRuleBlock direct: kbPath appears in block');
    assert(direct.includes('D:/some/kb/GOAL.md'),
      'buildRuleBlock direct: absolute GOAL.md path');
    assert(!direct.includes('<resolved kbPath>'),
      'buildRuleBlock direct: should not use resolved placeholder');

    // (d) Empty: nothing supplied — "Locate" fallback.
    const empty = buildRuleBlock();
    assert(empty.includes('Locate the project knowledge base'),
      'buildRuleBlock empty: should include fallback "Locate" wording');
    assert(!empty.includes('C:/'),
      'buildRuleBlock empty: must not include any C:/ path');
    assert(!empty.includes('D:/'),
      'buildRuleBlock empty: must not include any D:/ path');
  }

  rmrf(SANDBOX);
  console.log('claude-md-manager-test PASS');
})();
