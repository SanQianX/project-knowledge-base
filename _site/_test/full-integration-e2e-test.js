const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { spawnServer } = require('./helpers/spawn-server');
const { StorageLayout } = require('../lib/storage-layout');
const { ProjectRegistryStore } = require('../lib/project-registry-store');
const { ProjectStore } = require('../lib/project-store');
const { RequirementRecorder } = require('../lib/requirement-recorder');

const ROOT = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.KB_FULL_E2E_PORT || 7942);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), `project-knowledge-e2e-${process.pid}-`));
const DATA_DIR = path.join(TEMP, 'data');
const REPO = path.join(TEMP, 'repo with 空格');
const PROJECT_ID = 'project-full-e2e';
// Git commits fire the managed hook -> hook-trigger -> Bridge journal.
// Keep that journal inside the test sandbox, never the developer's home.
const BRIDGE_HOME = path.join(TEMP, 'bridge-home');

function git(args, allowFailure = false) {
  const result = spawnSync('git', ['-C', REPO, ...args], {
    encoding: 'utf8', windowsHide: true,
    env: { ...process.env, KB_DATA_DIR: DATA_DIR, KB_SITE_PORT: String(PORT), AI_CODING_EVENT_BRIDGE_HOME: BRIDGE_HOME },
  });
  if (!allowFailure) assert.strictEqual(result.status, 0, result.stderr || result.stdout);
  return { status: result.status, stdout: String(result.stdout || '').trim(), stderr: String(result.stderr || '').trim() };
}

function commit(name, content) {
  fs.writeFileSync(path.join(REPO, `${name}.txt`), `${content}\n`, 'utf8');
  git(['add', `${name}.txt`]);
  git(['commit', '-m', name]);
  return git(['rev-parse', 'HEAD']).stdout;
}

async function json(method, route, body) {
  const response = await fetch(`${BASE_URL}${route}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) : {} };
}

async function start() {
  const spawned = spawnServer({
    root: ROOT, port: PORT, dataDir: DATA_DIR, tag: 'full-e2e',
    extraEnv: {
      KB_AUTOMATION_FAKE_CLAUDE: '1', KB_EMBEDDING_FAKE: '1', KB_MAINTENANCE_INTERVAL_MS: '600000',
      AI_CODING_EVENT_BRIDGE_HOME: BRIDGE_HOME,
    },
  });
  let output = '';
  spawned.child.stdout.on('data', chunk => { output += chunk; });
  spawned.child.stderr.on('data', chunk => { output += chunk; });
  for (let attempt = 0; attempt < 150; attempt += 1) {
    try { if ((await fetch(`${BASE_URL}/api/health`)).ok) return { ...spawned, output: () => output }; } catch {}
    if (spawned.child.exitCode != null) throw new Error(`server exited during startup (${spawned.child.exitCode})\n${output}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`server did not start\n${output}`);
}

async function stop(spawned) {
  if (!spawned || spawned.child.exitCode != null) return;
  const exited = new Promise(resolve => spawned.child.once('exit', resolve));
  spawned.child.kill();
  await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 5000))]);
}

async function waitForState(predicate, label) {
  let last;
  for (let attempt = 0; attempt < 250; attempt += 1) {
    const result = await json('GET', `/api/projects/${PROJECT_ID}`);
    if (result.response.ok) {
      last = result.body.project.state;
      if (predicate(last)) return last;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`${label} timed out: ${JSON.stringify(last)}`);
}

(async () => {
  let server;
  fs.mkdirSync(REPO, { recursive: true });
  git(['init', '--initial-branch=main']);
  git(['config', 'user.name', 'Full E2E']);
  git(['config', 'user.email', 'e2e@example.test']);
  commit('baseline', 'baseline before import');
  try {
    server = await start();
    let result = await json('PATCH', '/api/settings', { knowledge: { rootPath: path.join(TEMP, '用户知识') } });
    assert(result.response.ok, JSON.stringify(result.body));
    result = await json('PUT', '/api/ai-profiles', {
      schema: 'ai-profiles/v1',
      defaultProfileId: 'fake-profile',
      profiles: [{ id: 'fake-profile', name: 'Fake', enabled: true, vendor: 'anthropic', model: 'fake', apiKeyUpdate: { mode: 'replace', value: 'fake-key-for-test' } }],
    });
    assert(result.response.ok, JSON.stringify(result.body));
    result = await json('POST', '/api/projects/import', {
      projectId: PROJECT_ID, localPath: REPO, displayName: 'Full E2E', aiProfileId: 'fake-profile', knowledgeLanguage: 'en-US',
    });
    assert.strictEqual(result.response.status, 201, `${JSON.stringify(result.body)}\n${server.output()}`);
    const knowledgePath = result.body.config.knowledgePath;
    assert.deepStrictEqual(fs.readdirSync(knowledgePath), [], 'import must not run AI or generate knowledge');
    assert.strictEqual(result.body.state.lastAnalyzedCommit, null);
    assert.strictEqual(result.body.project.state.hook.managedVersion, 2);

    const layout = new StorageLayout({ dataDir: DATA_DIR });
    const recorder = new RequirementRecorder({
      layout,
      registryStore: new ProjectRegistryStore({ layout }),
      projectStore: new ProjectStore({ layout }),
    });
    const requirement = await recorder.recordRequirement({
      projectId: PROJECT_ID, repoPath: REPO, client: 'codex', sessionId: 'full-e2e-session',
      text: 'Record the actual post-commit behavior and keep Markdown as the source of truth.',
    });
    assert(requirement.id && fs.existsSync(layout.getProjectConversationEventsPath(PROJECT_ID)));
    assert.strictEqual(fs.existsSync(layout.getProjectRequirementsPath(PROJECT_ID)), false);

    const onlineCommit = commit('online-change', 'online hook evidence');
    let state = await waitForState(current => current.lastAnalyzedCommit === onlineCommit && current.index.dirty === false, 'online Hook reconciliation');
    assert.strictEqual(state.analysis.activeClaim, null);
    assert(fs.existsSync(path.join(knowledgePath, 'changes', `${onlineCommit.slice(0, 12)}.md`)));
    result = await json('POST', '/api/knowledge/search', { projectId: PROJECT_ID, query: onlineCommit.slice(0, 12), limit: 5 });
    assert(result.response.ok && result.body.results.length > 0, JSON.stringify(result.body));

    result = await json('GET', `/api/logs?projectId=${PROJECT_ID}&pageSize=500`);
    const onlineEvents = result.body.entries.map(entry => entry.event);
    for (const event of ['reconcile.claim_prepared', 'knowledge.promotion_completed', 'reconcile.commit_completed', 'index.project_applied']) {
      assert(onlineEvents.includes(event), `missing online operation event: ${event}`);
    }
    assert.strictEqual(result.body.entries.filter(entry => entry.event === 'reconcile.claim_prepared' && entry.commitSha === onlineCommit).length, 1, 'Hook/startup overlap must not duplicate one Commit');

    await stop(server);
    server = null;
    const offlineOne = commit('offline-one', 'first offline change');
    const offlineTwo = commit('offline-two', 'second offline change');
    assert.notStrictEqual(offlineOne, offlineTwo);
    server = await start();
    state = await waitForState(current => current.lastAnalyzedCommit === offlineTwo && current.index.dirty === false, 'startup ordered catch-up');
    assert.strictEqual(state.analysis.activeClaim, null);
    assert(fs.existsSync(path.join(knowledgePath, 'changes', `${offlineOne.slice(0, 12)}.md`)));
    assert(fs.existsSync(path.join(knowledgePath, 'changes', `${offlineTwo.slice(0, 12)}.md`)));
    result = await json('GET', `/api/logs?projectId=${PROJECT_ID}&pageSize=500`);
    assert.strictEqual(result.body.entries.filter(entry => entry.event === 'reconcile.commit_completed' && entry.commitSha === offlineOne).length, 1);
    assert.strictEqual(result.body.entries.filter(entry => entry.event === 'reconcile.commit_completed' && entry.commitSha === offlineTwo).length, 1);
    console.log('full-integration-e2e-test PASS');
  } finally {
    await stop(server);
  }
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
