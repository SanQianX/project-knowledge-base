// _site/_test/project-goal-editor-test.js
//
// T13: Project Goal editor.
//   GET /api/projects/:id/goal  -> read GOAL.md from project knowledge path
//   PUT /api/projects/:id/goal  -> atomic write GOAL.md
// Verifies:
//   - missing GOAL.md returns exists=false;
//   - PUT creates the file atomically;
//   - subsequent GET returns the persisted content;
//   - empty content allowed (no auto-template);
//   - the file is scoped to the project's own knowledgePath (no
//     cross-project writes);
//   - 413 when content exceeds 256KB.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { spawnServer } = require('./helpers/spawn-server');

const ROOT = path.resolve(__dirname, '..', '..');
const sitePort = 8000 + (process.pid % 200);
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-goal-' + process.pid + '-'));
const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-goal-repo-' + process.pid + '-'));

function git(args) {
  const result = spawnSync('git', ['-C', repo, ...args], {
    encoding: 'utf8', windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed: ${result.status}`);
  return String(result.stdout || '').trim();
}

async function serverFetch(url, init, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : {} };
  } finally {
    clearTimeout(timer);
  }
}

(async () => {
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'goal@example.local']);
  git(['config', 'user.name', 'Goal']);
  fs.writeFileSync(path.join(repo, 'README.md'), '# goal\n');
  git(['add', 'README.md']);
  git(['commit', '-q', '-m', 'baseline']);
  const knowledgeRoot = path.join(dataDir, 'knowledge');
  fs.mkdirSync(knowledgeRoot, { recursive: true });
  const server = spawnServer({
    root: ROOT, port: sitePort, dataDir, tag: 'goal',
    extraEnv: { KB_AUTOMATION_FAKE_CLAUDE: '1', KB_EMBEDDING_FAKE: '1', KB_SKIP_MIGRATION: '1' },
  });
  try {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try { const r = await serverFetch(`http://127.0.0.1:${sitePort}/api/health`); if (r.body.ok) break; } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    await serverFetch(`http://127.0.0.1:${sitePort}/api/settings`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ knowledge: { rootPath: knowledgeRoot } }),
    });
    await serverFetch(`http://127.0.0.1:${sitePort}/api/ai-profiles`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        schema: 'ai-profiles/v1', defaultProfileId: 'fake',
        profiles: [{ id: 'fake', name: 'Fake', enabled: true, vendor: 'anthropic', model: 'fake', apiKeyUpdate: { mode: 'replace', value: 'k' } }],
      }),
    });
    const importR = await serverFetch(`http://127.0.0.1:${sitePort}/api/projects/import`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ localPath: repo, aiProfileId: 'fake' }),
    });
    assert.strictEqual(importR.status, 201, JSON.stringify(importR.body));
    const projectId = importR.body.projectId;
    const knowledgePath = importR.body.config.knowledgePath;

    // Case 1: GET on missing GOAL.md returns exists=false
    let r = await serverFetch(`http://127.0.0.1:${sitePort}/api/projects/${projectId}/goal`, undefined);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.exists, false);
    assert.strictEqual(r.body.content, '');

    // Case 2: PUT creates the file atomically with the supplied content
    r = await serverFetch(`http://127.0.0.1:${sitePort}/api/projects/${projectId}/goal`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: '# Project Goal\n\nBuild a knowledge base for v4.1.22 -> main recovery.\n' }),
    });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const goalPath = path.join(knowledgePath, 'GOAL.md');
    assert(fs.existsSync(goalPath), 'GOAL.md must be created');
    assert(fs.readFileSync(goalPath, 'utf8').includes('v4.1.22'), 'goal content must include the user-supplied text');

    // Case 3: GET now returns the persisted content
    r = await serverFetch(`http://127.0.0.1:${sitePort}/api/projects/${projectId}/goal`, undefined);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.exists, true);
    assert(r.body.content.includes('v4.1.22'));

    // Case 4: empty content is allowed (no auto-template)
    r = await serverFetch(`http://127.0.0.1:${sitePort}/api/projects/${projectId}/goal`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: '' }),
    });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(fs.readFileSync(goalPath, 'utf8'), '', 'empty content must clear the file');

    // Case 5: writes are scoped to the project's own knowledgePath
    r = await serverFetch(`http://127.0.0.1:${sitePort}/api/projects/${projectId}/goal`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'real content\n' }),
    });
    assert.strictEqual(r.status, 200);
    const otherFiles = fs.readdirSync(knowledgePath).filter(name => name !== 'GOAL.md');
    assert.deepStrictEqual(otherFiles, [], 'only GOAL.md must be created in the project knowledge path');

    // Case 6: 413 when content exceeds 256KB
    const huge = 'x'.repeat(257 * 1024);
    r = await serverFetch(`http://127.0.0.1:${sitePort}/api/projects/${projectId}/goal`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: huge }),
    });
    assert.strictEqual(r.status, 413);

    // Case 7: GET on a non-existent project returns 404
    r = await serverFetch(`http://127.0.0.1:${sitePort}/api/projects/does-not-exist/goal`, undefined);
    assert.strictEqual(r.status, 404);
  } finally {
    server.child.kill();
    await new Promise(resolve => server.child.once('exit', resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
  console.log('project-goal-editor-test PASS');
})().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});