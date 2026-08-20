// _site/_test/knowledge-language-control-test.js
//
// T11: knowledge output language controls. Verifies:
//   - import accepts knowledgeLanguage ('zh-CN' / 'en-US');
//   - per-project PATCH updates knowledgeLanguage;
//   - the value is persisted in config.knowledgeLanguage;
//   - the value is what the next analyzer invocation would see (we
//     verify it via the public state API which surfaces the same
//     config object the reconciler reads);
//   - changing language does NOT silently rewrite historical knowledge;
//   - invalid values are rejected with 400.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { spawnServer } = require('./helpers/spawn-server');

const ROOT = path.resolve(__dirname, '..', '..');
const sitePort = 7990 + (process.pid % 200);
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-knowledge-language-' + process.pid + '-'));
const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-knowledge-language-repo-' + process.pid + '-'));

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
  git(['config', 'user.email', 'kl@example.local']);
  git(['config', 'user.name', 'Knowledge Language']);
  fs.writeFileSync(path.join(repo, 'README.md'), '# kl\n');
  git(['add', 'README.md']);
  git(['commit', '-q', '-m', 'baseline']);
  const knowledgeRoot = path.join(dataDir, 'knowledge');
  fs.mkdirSync(knowledgeRoot, { recursive: true });
  const server = spawnServer({
    root: ROOT, port: sitePort, dataDir, tag: 'knowledge-language',
    extraEnv: { KB_AUTOMATION_FAKE_CLAUDE: '1', KB_EMBEDDING_FAKE: '1', KB_SKIP_MIGRATION: '1' },
  });
  try {
    // waitForServer-equivalent
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        const r = await serverFetch(`http://127.0.0.1:${sitePort}/api/health`);
        if (r.body.ok) break;
      } catch {}
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

    // Case 1: import with zh-CN (default)
    let r = await serverFetch(`http://127.0.0.1:${sitePort}/api/projects/import`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ localPath: repo, aiProfileId: 'fake', knowledgeLanguage: 'zh-CN' }),
    });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    assert.strictEqual(r.body.config.knowledgeLanguage, 'zh-CN');
    const PROJECT_ID = r.body.projectId;

    // Case 2: import with en-US
    const repo2 = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-kl-repo2-' + process.pid + '-'));
    const git2 = (args) => git(['-C', repo2, ...args]);
    git2(['init', '-q', '-b', 'main']);
    git2(['config', 'user.email', 'kl2@example.local']);
    git2(['config', 'user.name', 'KL2']);
    fs.writeFileSync(path.join(repo2, 'README.md'), '# en\n');
    git2(['add', 'README.md']);
    git2(['commit', '-q', '-m', 'baseline']);
    r = await serverFetch(`http://127.0.0.1:${sitePort}/api/projects/import`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ localPath: repo2, aiProfileId: 'fake', knowledgeLanguage: 'en-US' }),
    });
    assert.strictEqual(r.status, 201);
    assert.strictEqual(r.body.config.knowledgeLanguage, 'en-US');
    fs.rmSync(repo2, { recursive: true, force: true });

    // Case 3: invalid language rejected
    r = await serverFetch(`http://127.0.0.1:${sitePort}/api/projects/import`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ localPath: repo2, aiProfileId: 'fake', knowledgeLanguage: 'xx-INVALID' }),
    });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.body.error.code, 'INVALID_ARGUMENT');

    // Case 4: per-project PATCH updates knowledgeLanguage
    r = await serverFetch(`http://127.0.0.1:${sitePort}/api/projects/${PROJECT_ID}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ knowledgeLanguage: 'en-US' }),
    });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.config.knowledgeLanguage, 'en-US');
    // Verify state-side persists
    const readBack = await serverFetch(`http://127.0.0.1:${sitePort}/api/projects/${PROJECT_ID}`, undefined);
    assert.strictEqual(readBack.body.project.config.knowledgeLanguage, 'en-US');

    // Case 5: invalid value via PATCH also rejected
    r = await serverFetch(`http://127.0.0.1:${sitePort}/api/projects/${PROJECT_ID}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ knowledgeLanguage: 'klingon' }),
    });
    assert.strictEqual(r.status, 400);

    // Case 6: project status surfaces knowledgeLanguage in the public state.
    // The CommitReconciler reads config.knowledgeLanguage via projectStore,
    // so anything the UI sees the analyzer also sees.
    const stateR = await serverFetch(`http://127.0.0.1:${sitePort}/api/state`, undefined);
    assert.strictEqual(stateR.status, 200);
    const project = stateR.body.projects.find(p => p.projectId === PROJECT_ID);
    assert(project, 'project must appear in /api/state');
    assert.strictEqual(project.config.knowledgeLanguage, 'en-US');

    // Case 7: changing language does NOT silently rewrite historical files.
    // We snapshot the knowledge directory before and after a language flip;
    // the existing files (if any) must remain identical and only NEW
    // commits should produce output under the new language.
    const knowledgePath = readBack.body.project.config.knowledgePath;
    fs.mkdirSync(knowledgePath, { recursive: true });
    const marker = path.join(knowledgePath, 'marker.txt');
    fs.writeFileSync(marker, 'do-not-touch\n');
    const mtimeBefore = fs.statSync(marker).mtimeMs;
    const contentBefore = fs.readFileSync(marker, 'utf8');
    await new Promise(resolve => setTimeout(resolve, 20));
    r = await serverFetch(`http://127.0.0.1:${sitePort}/api/projects/${PROJECT_ID}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ knowledgeLanguage: 'zh-CN' }),
    });
    assert.strictEqual(r.status, 200);
    assert(fs.existsSync(marker), 'historical knowledge files must not be deleted by a language change');
    assert.strictEqual(fs.readFileSync(marker, 'utf8'), contentBefore, 'historical content must remain intact');
    assert.strictEqual(fs.statSync(marker).mtimeMs, mtimeBefore, 'historical files must not be touched');
  } finally {
    server.child.kill();
    await new Promise(resolve => server.child.once('exit', resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
  console.log('knowledge-language-control-test PASS');
})().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
