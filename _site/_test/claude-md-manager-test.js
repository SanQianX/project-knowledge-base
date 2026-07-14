// Run: node _site/_test/claude-md-manager-test.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  CLAUDE_MD_FILENAME,
  SECTION_MARKER_START,
  SECTION_MARKER_END,
  CENTRAL_MARKER_START,
  CENTRAL_RULE_REFERENCE,
  PROJECT_GUIDANCE,
  RULE_BLOCK,
  buildRuleBlock,
  ensureCentralRulesFile,
  ensureClaudeMdRule,
  refreshClaudeMdRule,
  removeClaudeMdRule,
  readClaudeMdStatus,
} = require('../lib/claude-md-manager');

const SANDBOX = path.join(os.tmpdir(), `kb-claude-md-test-${process.pid}-${Date.now()}`);
function assert(condition, message) { if (!condition) throw new Error(`ASSERT: ${message}`); }
function read(filePath) { return fs.readFileSync(filePath, 'utf-8'); }
function repo(name = 'repo') { const p = path.join(SANDBOX, name); fs.mkdirSync(p, { recursive: true }); return p; }
function occurrences(text, needle) { return text.split(needle).length - 1; }

try {
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  fs.mkdirSync(SANDBOX, { recursive: true });

  // New project files contain one shared import sentence, never detailed or
  // machine-specific KB instructions.
  const a = repo('a');
  let result = ensureClaudeMdRule(a, { projectSlug: 'ignored', kbPath: 'C:/private/kb' });
  assert(result.ok && result.action === 'created', 'creates CLAUDE.md');
  let text = read(path.join(a, CLAUDE_MD_FILENAME));
  assert(text.includes(PROJECT_GUIDANCE), 'contains canonical import line');
  assert(text.includes(`@${CENTRAL_RULE_REFERENCE}`), 'uses home-relative central import');
  assert(!text.includes('C:/private/kb') && !text.includes('projectSlug:'), 'does not embed per-project metadata');
  assert(!text.includes('Read-only boundary') && !text.includes('GOAL.md'), 'does not duplicate detailed rules');
  assert(text.trim().split(/\r?\n/).length === 3, 'managed project block is exactly marker, sentence, marker');

  // Existing user instructions survive append and future updates.
  const b = repo('b');
  const bPath = path.join(b, CLAUDE_MD_FILENAME);
  fs.writeFileSync(bPath, '# User rules\n\nRun npm test.\n', 'utf-8');
  result = ensureClaudeMdRule(b);
  assert(result.ok && result.action === 'appended', 'appends to user CLAUDE.md');
  assert(read(bPath).includes('# User rules') && read(bPath).includes('Run npm test.'), 'preserves user text');

  // An old verbose block is replaced in place and surrounding user text is untouched.
  const c = repo('c');
  const cPath = path.join(c, CLAUDE_MD_FILENAME);
  const legacy = `${SECTION_MARKER_START}\n## Knowledge Base Reading Rule\nprojectSlug: old-project\nC:/old/private/path/GOAL.md\n${SECTION_MARKER_END}\n`;
  fs.writeFileSync(cPath, `# Before\n\n${legacy}\n# After\n`, 'utf-8');
  let status = readClaudeMdStatus(c);
  assert(status.state === 'outdated' && status.needsRefresh, 'recognizes legacy managed block');
  result = refreshClaudeMdRule(c);
  assert(result.ok && result.action === 'updated', 'strict refresh migrates legacy block');
  text = read(cPath);
  assert(text.includes('# Before') && text.includes('# After'), 'migration preserves surrounding text');
  assert(!text.includes('old-project') && !text.includes('C:/old/private/path'), 'migration removes old inline metadata');
  assert(occurrences(text, SECTION_MARKER_START) === 1, 'migration leaves one block');
  status = readClaudeMdStatus(c);
  assert(status.state === 'current' && status.current && !status.needsRefresh, 'reports current after migration');
  assert(status.format === 'central-v1', 'reports central format');

  // CRLF canonical content is current, not a false-positive refresh.
  const d = repo('d');
  fs.writeFileSync(path.join(d, CLAUDE_MD_FILENAME), RULE_BLOCK.replace(/\n/g, '\r\n'), 'utf-8');
  assert(readClaudeMdStatus(d).state === 'current', 'CRLF canonical block is current');

  // Strict bulk refresh never creates/appends and fails closed on bad markers.
  const missing = repo('missing');
  result = refreshClaudeMdRule(missing);
  assert(result.ok && result.action === 'skipped' && !fs.existsSync(path.join(missing, CLAUDE_MD_FILENAME)), 'missing file is skipped');
  const unmanaged = repo('unmanaged');
  const unmanagedPath = path.join(unmanaged, CLAUDE_MD_FILENAME);
  fs.writeFileSync(unmanagedPath, '# User only\n', 'utf-8');
  result = refreshClaudeMdRule(unmanaged);
  assert(result.ok && result.action === 'skipped' && read(unmanagedPath) === '# User only\n', 'unmanaged file is untouched');
  const malformed = repo('malformed');
  const malformedPath = path.join(malformed, CLAUDE_MD_FILENAME);
  fs.writeFileSync(malformedPath, `${SECTION_MARKER_START}\npartial\n`, 'utf-8');
  assert(readClaudeMdStatus(malformed).state === 'malformed', 'half marker is malformed');
  result = ensureClaudeMdRule(malformed);
  assert(!result.ok && result.action === 'malformed', 'normal ensure also refuses malformed markers');
  assert(read(malformedPath).includes('partial'), 'malformed file remains untouched');

  // Idempotency and removal operate only on the marked pointer.
  result = ensureClaudeMdRule(a);
  assert(result.ok && result.action === 'unchanged', 'second ensure is unchanged');
  result = removeClaudeMdRule(b);
  assert(result.ok && result.removed && !result.fileDeleted, 'removes block while retaining user file');
  assert(read(bPath).includes('# User rules') && !read(bPath).includes(SECTION_MARKER_START), 'remove keeps user content');
  result = removeClaudeMdRule(a);
  assert(result.ok && result.fileDeleted && !fs.existsSync(path.join(a, CLAUDE_MD_FILENAME)), 'deletes pointer-only file');

  // Central file contains all detailed policy and the authoritative registry path.
  const centralDir = path.join(SANDBOX, '.project-knowledge');
  const projectsPath = path.join(centralDir, 'projects.json');
  result = ensureCentralRulesFile({ rulesDir: centralDir, projectsPath });
  assert(result.ok && result.action === 'created', 'creates central rules file');
  const centralPath = result.path;
  text = read(centralPath);
  assert(text.includes(CENTRAL_MARKER_START), 'central file has managed marker');
  assert(text.includes(projectsPath.replace(/\\/g, '/')), 'central file contains registry path');
  assert(text.includes('strictly read-only'), 'central file owns development read-only policy');
  assert(text.includes('post-commit automation after a successful Git commit'), 'central file reserves writes for post-commit');
  assert(text.includes('git rev-parse --show-toplevel'), 'central file resolves projects by current Git root');
  const before = read(centralPath);
  result = ensureCentralRulesFile({ rulesDir: centralDir, projectsPath });
  assert(result.ok && result.action === 'unchanged' && read(centralPath) === before, 'central ensure is idempotent');

  // User additions outside the central managed section survive rule upgrades.
  fs.writeFileSync(centralPath, `${before}\n## My local addition\nKeep this.\n`, 'utf-8');
  result = ensureCentralRulesFile({ rulesDir: centralDir, projectsPath: path.join(centralDir, 'moved-projects.json') });
  text = read(centralPath);
  assert(result.ok && result.action === 'updated', 'updates central managed section');
  assert(text.includes('## My local addition') && text.includes('Keep this.'), 'preserves central user additions');
  assert(text.includes('moved-projects.json'), 'updates central registry location');

  assert(buildRuleBlock({ projectsPath: 'X:/secret', projectSlug: 'secret' }) === RULE_BLOCK, 'legacy options cannot leak into project block');

  console.log('claude md manager test passed');
} finally {
  fs.rmSync(SANDBOX, { recursive: true, force: true });
}
