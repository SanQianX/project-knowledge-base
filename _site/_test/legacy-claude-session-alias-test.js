// Run: node _site/_test/legacy-claude-session-alias-test.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `kb-legacy-session-${process.pid}-`));
const projectId = 'project-stable-id';
const legacySlug = 'legacy-project-slug';
const knowledgePath = path.join(dataDir, 'knowledge', legacySlug);
const metadataPath = path.join(dataDir, 'projects', projectId);
const now = new Date().toISOString();
process.env.KB_DATA_DIR = dataDir;
require('../lib/data-dir')._resetCache();

const { defaultProjectConfig, defaultProjectState } = require('../lib/project-store');

function writeRecord(root, record) {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, `${record.sessionId}.json`), `${JSON.stringify({
    schema: 'claude-workbench-session/v1',
    projectPath: dataDir,
    kbPath: knowledgePath,
    promptKey: 'post-commit-automation',
    runner: 'sdk',
    state: 'idle',
    model: 'test-model',
    startedAt: now,
    endedAt: now,
    exitCode: 0,
    turns: 1,
    pendingPermission: null,
    updatedAt: now,
    ...record,
  }, null, 2)}\n`, 'utf8');
}

try {
  fs.mkdirSync(metadataPath, { recursive: true });
  fs.mkdirSync(knowledgePath, { recursive: true });
  fs.writeFileSync(path.join(metadataPath, 'config.json'), `${JSON.stringify(defaultProjectConfig(projectId, {
    displayName: 'Legacy project',
    storageName: 'legacy-project',
    repoPath: dataDir,
    knowledgePath,
    legacyExtensions: { slug: legacySlug, sourceSchema: 'legacy-v1' },
  }), null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(metadataPath, 'state.json'), `${JSON.stringify(defaultProjectState(), null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(dataDir, 'projects.json'), `${JSON.stringify({
    schema: 'project-registry/v2',
    schemaVersion: 2,
    projectOrder: [projectId],
    projects: { [projectId]: { createdAt: now, displayNameSnapshot: 'Legacy project' } },
    revision: 1,
    updatedAt: now,
  }, null, 2)}\n`, 'utf8');

  const legacyRoot = path.join(dataDir, '_ai', legacySlug, 'claude-workbench');
  const currentRoot = path.join(dataDir, 'runtime', 'claude-sessions', projectId);
  writeRecord(legacyRoot, {
    sessionId: 'sess-legacy-only',
    projectSlug: legacySlug,
    source: 'git-hook',
    automation: true,
    events: [
      { type: 'claude/user-prompt', text: 'historical hook prompt' },
      { type: 'claude/result', result: 'historical analysis result' },
    ],
  });
  writeRecord(legacyRoot, {
    sessionId: 'sess-duplicate',
    projectSlug: legacySlug,
    source: 'legacy-copy',
    events: [{ type: 'claude/result', result: 'legacy duplicate' }],
  });
  writeRecord(currentRoot, {
    sessionId: 'sess-duplicate',
    projectSlug: projectId,
    source: 'current-runtime',
    events: [{ type: 'claude/result', result: 'current duplicate' }],
  });

  const runner = require('../lib/claude-cli-runner');
  const listed = runner.listSessions({ projectSlug: projectId });
  assert.strictEqual(listed.length, 2);
  const legacy = listed.find(session => session.sessionId === 'sess-legacy-only');
  assert(legacy, 'legacy alias session must be discoverable under the stable projectId');
  assert.strictEqual(legacy.projectSlug, projectId);
  assert.strictEqual(legacy.legacyProjectSlug, legacySlug);
  assert.strictEqual(legacy.legacySource, true);
  assert.strictEqual(listed.find(session => session.sessionId === 'sess-duplicate').source, 'current-runtime', 'canonical runtime record must win duplicate IDs');

  const events = [];
  const unsubscribe = runner.subscribe('sess-legacy-only', event => events.push(event));
  unsubscribe();
  assert(events.some(event => event.type === 'claude/user-prompt' && event.text === 'historical hook prompt'));
  assert(events.some(event => event.type === 'claude/result' && event.result === 'historical analysis result'));
  assert.strictEqual(runner.getState('sess-legacy-only').projectSlug, projectId);
  console.log('legacy-claude-session-alias-test PASS');
} catch (error) {
  console.error(error.stack || error.message);
  process.exitCode = 1;
} finally {
  fs.rmSync(dataDir, { recursive: true, force: true });
}
