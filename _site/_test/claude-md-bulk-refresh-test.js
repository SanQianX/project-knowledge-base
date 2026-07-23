// Run: node _site/_test/claude-md-bulk-refresh-test.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnServer } = require('./helpers/spawn-server');
const {
  SECTION_MARKER_START,
  SECTION_MARKER_END,
  CENTRAL_RULE_FILENAME,
  PROJECT_GUIDANCE,
  RULE_BLOCK,
} = require('../lib/claude-md-manager');

const ROOT = path.resolve(__dirname, '..', '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), `kb-claude-bulk-${process.pid}-`));
const DATA_DIR = path.join(TMP, 'data');
const PORT = 8100 + (process.pid % 500);
const BASE = `http://127.0.0.1:${PORT}`;

function assert(condition, message) { if (!condition) throw new Error(`ASSERT: ${message}`); }
function makeRepo(name, claudeText) {
  const repo = path.join(TMP, name);
  fs.mkdirSync(repo, { recursive: true });
  if (claudeText !== undefined) fs.writeFileSync(path.join(repo, 'CLAUDE.md'), claudeText, 'utf-8');
  return repo;
}
async function waitForServer() {
  const until = Date.now() + 15000;
  while (Date.now() < until) {
    try { const response = await fetch(`${BASE}/api/claude-md/status?rescan=1`); if (response.ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('server did not start');
}
async function json(method, url, body) {
  const response = await fetch(`${BASE}${url}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`${response.status}: ${JSON.stringify(data)}`);
  return data;
}

(async () => {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const legacyBlock = `${SECTION_MARKER_START}\n## Knowledge Base Reading Rule\nprojectSlug: legacy\nC:/old/kb/GOAL.md\n${SECTION_MARKER_END}\n`;
  const legacyRepo = makeRepo('legacy', `# User before\n\n${legacyBlock}\n# User after\n`);
  const currentRepo = makeRepo('current', RULE_BLOCK);
  const unmanagedRepo = makeRepo('unmanaged', '# User content only\n');
  const missingRepo = makeRepo('missing');
  const malformedRepo = makeRepo('malformed', `${SECTION_MARKER_START}\npartial\n`);
  const unavailableRepo = path.join(TMP, 'does-not-exist');
  const projects = {
    legacy: { displayName: 'Legacy', localPath: legacyRepo, gitPath: legacyRepo, kbPath: path.join(TMP, 'kb-legacy'), enabled: true },
    current: { displayName: 'Current', localPath: currentRepo, gitPath: currentRepo, kbPath: path.join(TMP, 'kb-current'), enabled: true },
    unmanaged: { displayName: 'Unmanaged', localPath: unmanagedRepo, gitPath: unmanagedRepo, kbPath: path.join(TMP, 'kb-unmanaged'), enabled: true },
    missing: { displayName: 'Missing', localPath: missingRepo, gitPath: missingRepo, kbPath: path.join(TMP, 'kb-missing'), enabled: true },
    malformed: { displayName: 'Malformed', localPath: malformedRepo, gitPath: malformedRepo, kbPath: path.join(TMP, 'kb-malformed'), enabled: true },
    unavailable: { displayName: 'Unavailable', localPath: unavailableRepo, gitPath: unavailableRepo, kbPath: path.join(TMP, 'kb-unavailable'), enabled: true },
  };
  const projectsPath = path.join(DATA_DIR, 'projects.json');
  fs.writeFileSync(projectsPath, `${JSON.stringify(projects, null, 2)}\n`, 'utf-8');
  const projectsBefore = fs.readFileSync(projectsPath, 'utf-8');
  const legacyBefore = fs.readFileSync(path.join(legacyRepo, 'CLAUDE.md'), 'utf-8');
  const unmanagedBefore = fs.readFileSync(path.join(unmanagedRepo, 'CLAUDE.md'), 'utf-8');
  const malformedBefore = fs.readFileSync(path.join(malformedRepo, 'CLAUDE.md'), 'utf-8');

  const server = spawnServer({ root: ROOT, port: PORT, dataDir: DATA_DIR, tag: 'claude-bulk' });
  let output = '';
  server.child.stdout.on('data', chunk => { output += chunk.toString(); });
  server.child.stderr.on('data', chunk => { output += chunk.toString(); });
  try {
    await waitForServer();
    assert(fs.readFileSync(path.join(legacyRepo, 'CLAUDE.md'), 'utf-8') === legacyBefore, 'startup audit must not edit legacy project');
    assert(fs.existsSync(path.join(DATA_DIR, CENTRAL_RULE_FILENAME)), 'startup creates central rules file');
    const central = fs.readFileSync(path.join(DATA_DIR, CENTRAL_RULE_FILENAME), 'utf-8');
    assert(central.includes('strictly read-only') && central.includes('post-commit automation'), 'central file contains detailed policy');

    let audit = await json('GET', '/api/claude-md/status?rescan=1');
    assert(audit.summary.total === 6, `expected six projects: ${JSON.stringify(audit.summary)}`);
    assert(audit.summary.outdated === 1 && audit.summary.refreshable === 1, 'only legacy managed block is refreshable');
    assert(audit.summary.current === 1, 'current pointer is recognized');
    assert(audit.summary.unmanaged === 1 && audit.summary.missing === 1, 'unmanaged and missing are reported');
    assert(audit.summary.malformed === 1 && audit.summary.unavailable === 1, 'unsafe states are reported');

    const result = await json('POST', '/api/claude-md/refresh-all', {});
    assert(result.updated === 1 && result.failed === 0, `one project should update: ${JSON.stringify(result)}`);
    const migrated = fs.readFileSync(path.join(legacyRepo, 'CLAUDE.md'), 'utf-8');
    assert(migrated.includes(PROJECT_GUIDANCE), 'legacy block becomes central pointer');
    assert(migrated.includes('# User before') && migrated.includes('# User after'), 'migration preserves user content');
    assert(!migrated.includes('C:/old/kb') && !migrated.includes('projectSlug: legacy'), 'legacy inline details are removed');
    assert(fs.readFileSync(path.join(unmanagedRepo, 'CLAUDE.md'), 'utf-8') === unmanagedBefore, 'unmanaged file is untouched');
    assert(fs.readFileSync(path.join(malformedRepo, 'CLAUDE.md'), 'utf-8') === malformedBefore, 'malformed file is untouched');
    assert(!fs.existsSync(path.join(missingRepo, 'CLAUDE.md')), 'missing CLAUDE.md is not created by bulk refresh');
    assert(fs.readFileSync(projectsPath, 'utf-8') === projectsBefore, 'bulk refresh does not rewrite projects.json');

    audit = await json('POST', '/api/claude-md/refresh-all', {});
    assert(audit.updated === 0 && audit.audit.summary.refreshable === 0, 'second refresh is idempotent');
    console.log('claude md bulk refresh test passed');
  } catch (error) {
    console.error(error.message);
    if (output) console.error(output.slice(-2000));
    process.exitCode = 1;
  } finally {
    // On Windows, removing the temporary directory immediately after
    // child.kill() races the server process while it still owns files in it.
    // That can produce EPERM and crash Node during shutdown. Wait for the
    // server to exit before removing the whole test fixture.
    if (server.child.exitCode === null) {
      const exited = new Promise(resolve => server.child.once('exit', resolve));
      if (!server.child.killed) {
        try { server.child.kill(); } catch {}
      }
      await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 5000))]);
    }
    // Node 24 on Windows can abort in libuv when this test recursively
    // removes a directory that was just used by the spawned server, even
    // after the child has exited. The runner's temporary workspace is
    // discarded after CI, so keep this short-lived fixture on Windows rather
    // than turning a successful assertion run into a process crash.
    if (process.platform !== 'win32') {
      fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  }
})();
