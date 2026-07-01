// Simple project import test.
// Verifies the one-path import flow initializes Git, KB files, Hook automation,
// and a project-init automation run.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnServer } = require('./helpers/spawn-server');

const ROOT = path.resolve(__dirname, '..', '..');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), `kb-data-simple-import-${process.pid}-`));
const PORT = process.env.KB_SIMPLE_IMPORT_PORT || '7824';
const BASE_URL = `http://127.0.0.1:${PORT}`;
const TEMP_REPO = fs.mkdtempSync(path.join(os.tmpdir(), `kb-simple-import-repo-${process.pid}-`));

process.env.KB_DATA_DIR = DATA_DIR;
require('../lib/data-dir')._resetCache();
fs.writeFileSync(path.join(DATA_DIR, 'projects.json'), '{}\n', 'utf-8');
fs.writeFileSync(path.join(DATA_DIR, 'ai-profiles.json'), JSON.stringify({
  schema: 'ai-profiles/v1',
  profiles: [{
    id: 'test-profile',
    name: 'Test Profile',
    enabled: true,
    implementation: 'claude-code-agent',
    baseUrl: 'https://example.test/anthropic',
    apiKey: 'test-key',
    mainModel: 'test-model',
  }, {
    id: 'second-profile',
    name: 'Second Profile',
    enabled: true,
    implementation: 'claude-code-agent',
    baseUrl: 'https://example.test/anthropic',
    apiKey: 'test-key-2',
    mainModel: 'test-model-2',
  }],
}, null, 2) + '\n', 'utf-8');

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function waitForServer() {
  const deadline = Date.now() + 15000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE_URL}/api/state`);
      if (res.ok) return;
      lastError = new Error(`HTTP ${res.status}`);
    } catch (e) {
      lastError = e;
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw lastError || new Error('server did not start');
}

async function json(method, url, body) {
  const res = await fetch(`${BASE_URL}${url}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = {};
  if (text) {
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
  }
  return { res, data };
}

(async () => {
  fs.writeFileSync(path.join(TEMP_REPO, 'README.md'), '# simple import\n', 'utf-8');

  const spawned = spawnServer({
    root: ROOT,
    port: Number(PORT),
    dataDir: DATA_DIR,
    tag: 'simple-import',
    extraEnv: { KB_AUTOMATION_FAKE_CLAUDE: '1' },
  });
  const child = spawned.child;
  let serverOutput = '';
  child.stdout.on('data', d => { serverOutput += d.toString(); });
  child.stderr.on('data', d => { serverOutput += d.toString(); });

  try {
    await waitForServer();
    const r = await json('POST', '/api/projects/import', { localPath: TEMP_REPO, aiProfileId: 'second-profile' });
    assert(r.res.ok, `import should succeed: ${JSON.stringify(r.data)}`);
    assert(r.data.slug, 'import should return slug');
    assert(r.data.gitInit && r.data.gitInit.initialized === true, 'non-git folder should be initialized');
    assert(r.data.config.aiProfileId === 'test-profile', 'import should assign default first usable AI profile');
    assert(r.data.config.automation.enabled === true, 'automation should be enabled');
    assert(r.data.config.automation.postCommitEnabled === true, 'post-commit automation should be enabled');
    assert(r.data.config.automation.allowReadOnlyBash === true, 'read-only Bash should be enabled');
    assert(r.data.config.automation.knowledgeMode === 'autoApply', 'knowledge mode should default to autoApply');
    assert(r.data.config.automation.hookPromptTemplate.includes('知识库更新原则'), 'default hook prompt should be rich');
    assert(r.data.config.automation.initPromptTemplate.includes('初始化当前项目知识库'), 'init prompt should be stored');
    assert(r.data.config.claudeWorkbench.permissionMode === 'acceptEdits', 'permission mode should default to acceptEdits');
    assert(fs.existsSync(path.join(r.data.config.kbPath, 'README.md')), 'KB README should be initialized');
    assert(r.data.hookResult && r.data.hookResult.ok === true, 'managed hook should be installed');
    assert(r.data.initAutomation && r.data.initAutomation.ok === true, 'project-init automation should dispatch');

    const runs = await json('GET', `/api/projects/${r.data.slug}/automation/runs`);
    assert(runs.res.ok, 'automation runs should be readable');
    assert((runs.data.runs || []).some(run => run.source === 'project-init'), 'project-init run should be persisted');

    console.log('simple import test passed');
  } catch (e) {
    console.error('simple import test failed:', e.message);
    if (serverOutput) console.error(serverOutput);
    process.exitCode = 1;
  } finally {
    try { child.kill(); } catch {}
    try { fs.rmSync(TEMP_REPO, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch {}
  }
})();
