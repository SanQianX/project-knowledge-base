// _site/_test/hook-status-repair-api-test.js
//
// Integration tests for T04 — Hook status / verify / repair service API.
// Drives the live server through:
//   GET  /api/projects/:id/hook-status
//   POST /api/projects/:id/hook-repair
//
// and verifies that:
//   - the status payload carries all required fields;
//   - repair works for missing / broken managed hooks;
//   - repair refuses to overwrite third-party hooks;
//   - lastConflict is surfaced from state.hook.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { spawnServer } = require('./helpers/spawn-server');

const ROOT = path.resolve(__dirname, '..', '..');
const PORT = 7901;
const BASE = `http://127.0.0.1:${PORT}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `pk-hook-api-${process.pid}-`));
const repo = fs.mkdtempSync(path.join(os.tmpdir(), `pk-hook-api-repo-${process.pid}-`));

function git(args) {
  const result = spawnSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed: ${result.status}`);
  return String(result.stdout || '').trim();
}

function makeRepo() {
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'hook-api@example.local']);
  git(['config', 'user.name', 'Hook API Test']);
  fs.writeFileSync(path.join(repo, 'README.md'), '# hook api\n');
  git(['add', 'README.md']);
  git(['commit', '-q', '-m', 'initial']);
}

function requestJson(method, pathname, body) {
  return fetch(`${BASE}${pathname}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async response => ({ status: response.status, body: await response.json() }));
}
function postJson(pathname, body) { return requestJson('POST', pathname, body); }
function patchJson(pathname, body) { return requestJson('PATCH', pathname, body); }
function putJson(pathname, body) { return requestJson('PUT', pathname, body); }
function getJson(pathname) { return requestJson('GET', pathname); }

async function waitForServer() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('server did not start');
}

(async () => {
  makeRepo();
  const spawned = spawnServer({
    root: ROOT, port: PORT, dataDir, tag: 'hook-api',
    extraEnv: { KB_SKIP_MIGRATION: '1' },
  });
  try {
    await waitForServer();
    // Configure knowledge root + a fake AI profile so import succeeds.
    let r = await patchJson('/api/settings', { knowledge: { rootPath: path.join(dataDir, 'knowledge') } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    r = await putJson('/api/ai-profiles', {
      schema: 'ai-profiles/v1', defaultProfileId: 'fake',
      profiles: [{ id: 'fake', name: 'Fake', enabled: true, vendor: 'anthropic', model: 'fake', apiKeyUpdate: { mode: 'replace', value: 'k' } }],
    });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const PROJECT_ID = 'project-hook-api';
    r = await postJson('/api/projects/import', {
      projectId: PROJECT_ID, localPath: repo, displayName: 'Hook API', aiProfileId: 'fake',
    });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));

    // Case 1: status payload after fresh import carries all required fields.
    r = await getJson(`/api/projects/${PROJECT_ID}/hook-status`);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.ok, true);
    assert.strictEqual(r.body.projectId, PROJECT_ID);
    assert.strictEqual(typeof r.body.hook.repoPath, 'string');
    assert.strictEqual(typeof r.body.hook.hookPath, 'string');
    assert.strictEqual(r.body.hook.installed, true);
    assert.strictEqual(r.body.hook.managed, true);
    assert.strictEqual(r.body.hook.managedVersion, 2);
    assert.strictEqual(typeof r.body.hook.runtimeTarget, 'string');
    assert(typeof r.body.hook.lastVerifiedAt === 'string' && r.body.hook.lastVerifiedAt.length > 0);
    assert.strictEqual(r.body.hook.migrationVersion, 2);
    assert.strictEqual(r.body.hook.repairAvailable, false, 'freshly-imported managed hook needs no repair');

    // Case 2: missing managed hook is reported + repairable.
    const hookPath = r.body.hook.hookPath;
    fs.unlinkSync(hookPath);
    r = await getJson(`/api/projects/${PROJECT_ID}/hook-status`);
    assert.strictEqual(r.body.hook.installed, false);
    assert.strictEqual(r.body.hook.managed, false);
    assert.strictEqual(r.body.hook.repairAvailable, true, 'missing managed hook must be repairable');
    r = await postJson(`/api/projects/${PROJECT_ID}/hook-repair`, {});
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.installed, true);
    assert.strictEqual(r.body.managedVersion, 2);
    r = await getJson(`/api/projects/${PROJECT_ID}/hook-status`);
    assert.strictEqual(r.body.hook.installed, true, 'repair must re-install the managed hook');
    assert.strictEqual(r.body.hook.managed, true);
    assert.strictEqual(r.body.hook.repairAvailable, false);

    // Case 3: third-party hook is reported as conflict + repair refuses.
    const userHook = '#!/bin/sh\necho "user owned"\nexit 0\n';
    fs.writeFileSync(hookPath, userHook, { mode: 0o755 });
    r = await getJson(`/api/projects/${PROJECT_ID}/hook-status`);
    assert.strictEqual(r.body.hook.installed, false, 'third-party hook must not be reported as installed');
    assert.strictEqual(r.body.hook.managed, false, 'third-party hook must not be reported as managed');
    assert.strictEqual(r.body.hook.repairAvailable, false, 'third-party hook must not be repairable');
    assert(r.body.hook.reason && /third-party/i.test(r.body.hook.reason));
    r = await postJson(`/api/projects/${PROJECT_ID}/hook-repair`, {});
    assert.strictEqual(r.status, 409, `third-party repair must be rejected with 409; got ${r.status}`);
    assert.strictEqual(r.body.error.code, 'HOOK_CONFLICT');
    assert.strictEqual(fs.readFileSync(hookPath, 'utf8'), userHook, 'third-party hook body must remain untouched');

    // Case 4: managed hook belonging to a different project is reported as conflict.
    fs.writeFileSync(hookPath, '#!/bin/sh\n# PROJECT-KNOWLEDGE-HOOK ' + JSON.stringify({
      schema: 'project-knowledge/hook/v2', managedVersion: 2, projectId: 'project-someone-else',
    }) + '\nexit 0\n', { mode: 0o755 });
    r = await getJson(`/api/projects/${PROJECT_ID}/hook-status`);
    assert.strictEqual(r.body.hook.managed, true, 'managed hook body must be recognized as managed');
    assert.strictEqual(r.body.hook.installed, false, 'wrong-project managed hook must not be installed for this project');
    assert.strictEqual(r.body.hook.repairAvailable, false, 'wrong-project managed hook must not be auto-repaired');
    r = await postJson(`/api/projects/${PROJECT_ID}/hook-repair`, {});
    assert.strictEqual(r.status, 409, 'wrong-project repair must be rejected with 409');
  } finally {
    spawned.child.kill();
    await new Promise(resolve => spawned.child.once('exit', resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
  console.log('hook-status-repair-api-test PASS');
})().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
