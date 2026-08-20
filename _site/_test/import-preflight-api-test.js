// _site/_test/import-preflight-api-test.js
//
// T06: preflight endpoint surface contract.
// Drives POST /api/projects/preflight-import through every documented
// prerequisite path and asserts the response shape.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { spawnServer } = require('./helpers/spawn-server');

const ROOT = path.resolve(__dirname, '..', '..');
const PORT = 7903;
const BASE = `http://127.0.0.1:${PORT}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `pk-preflight-${process.pid}-`));

function git(repo, args) {
  const result = spawnSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed: ${result.status}`);
  return String(result.stdout || '').trim();
}

async function requestJson(method, pathname, body) {
  const response = await fetch(`${BASE}${pathname}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}
function postJson(pathname, body) { return requestJson('POST', pathname, body); }
function patchJson(pathname, body) { return requestJson('PATCH', pathname, body); }
function putJson(pathname, body) { return requestJson('PUT', pathname, body); }

async function waitForServer() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('server did not start');
}

(async () => {
  const repoOk = fs.mkdtempSync(path.join(os.tmpdir(), `pk-preflight-repo-ok-${process.pid}-`));
  const repoEmpty = fs.mkdtempSync(path.join(os.tmpdir(), `pk-preflight-repo-empty-${process.pid}-`));
  const repoNonGit = fs.mkdtempSync(path.join(os.tmpdir(), `pk-preflight-repo-non-git-${process.pid}-`));
  const repoSpaces = path.join(fs.mkdtempSync(path.join(os.tmpdir(), `pk-preflight-spaces-${process.pid}-`)), 'project with spaces');
  const repoThirdParty = fs.mkdtempSync(path.join(os.tmpdir(), `pk-preflight-thirdparty-${process.pid}-`));
  try {
    fs.mkdirSync(repoSpaces, { recursive: true });
    // existing Git repo with a baseline commit
    git(repoOk, ['init', '-q', '-b', 'main']);
    git(repoOk, ['config', 'user.email', 'preflight@example.local']);
    git(repoOk, ['config', 'user.name', 'Preflight']);
    fs.writeFileSync(path.join(repoOk, 'README.md'), '# ok\n');
    git(repoOk, ['add', 'README.md']);
    git(repoOk, ['commit', '-q', '-m', 'baseline']);
    // empty git repo (no commits yet)
    git(repoEmpty, ['init', '-q', '-b', 'main']);
    git(repoEmpty, ['config', 'user.email', 'preflight@example.local']);
    git(repoEmpty, ['config', 'user.name', 'Preflight']);
    // non-git dir with a stray file
    fs.writeFileSync(path.join(repoNonGit, 'note.txt'), 'hi\n');
    // repo with a literal space in its path
    git(repoSpaces, ['init', '-q', '-b', 'main']);
    git(repoSpaces, ['config', 'user.email', 'preflight@example.local']);
    git(repoSpaces, ['config', 'user.name', 'Preflight']);
    fs.writeFileSync(path.join(repoSpaces, 'README.md'), '# spaces\n');
    git(repoSpaces, ['add', 'README.md']);
    git(repoSpaces, ['commit', '-q', '-m', 'baseline']);
    // repo with a third-party hook
    git(repoThirdParty, ['init', '-q', '-b', 'main']);
    git(repoThirdParty, ['config', 'user.email', 'preflight@example.local']);
    git(repoThirdParty, ['config', 'user.name', 'Preflight']);
    fs.writeFileSync(path.join(repoThirdParty, 'README.md'), '# tp\n');
    git(repoThirdParty, ['add', 'README.md']);
    git(repoThirdParty, ['commit', '-q', '-m', 'baseline']);
    const gitDir = git(repoThirdParty, ['rev-parse', '--path-format=absolute', '--git-dir']);
    const hooksDir = path.join(path.resolve(gitDir), 'hooks');
    fs.mkdirSync(hooksDir, { recursive: true });
    fs.writeFileSync(path.join(hooksDir, 'post-commit'), '#!/bin/sh\necho "user owned"\nexit 0\n', { mode: 0o755 });

    const spawned = spawnServer({
      root: ROOT, port: PORT, dataDir, tag: 'preflight',
      extraEnv: { KB_SKIP_MIGRATION: '1' },
    });
    try {
      await waitForServer();
      const knowledgeRoot = path.join(dataDir, 'knowledge');
      fs.mkdirSync(knowledgeRoot, { recursive: true });
      let r = await patchJson('/api/settings', { knowledge: { rootPath: knowledgeRoot } });
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      // Configure a fake AI profile so most checks succeed.
      r = await putJson('/api/ai-profiles', {
        schema: 'ai-profiles/v1', defaultProfileId: 'fake',
        profiles: [{ id: 'fake', name: 'Fake', enabled: true, vendor: 'anthropic', model: 'fake', apiKeyUpdate: { mode: 'replace', value: 'k' } }],
      });
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));

      // Case 1: existing Git repo with AI profile -> ready
      r = await postJson('/api/projects/preflight-import', { localPath: repoOk, aiProfileId: 'fake' });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.body.ok, true);
      assert.strictEqual(r.body.ready, true);
      assert.strictEqual(r.body.plannedGitInit, false);
      assert.deepStrictEqual(r.body.problems, []);
      assert.strictEqual(r.body.checks.git.status, 'ok');
      assert.strictEqual(r.body.checks.aiProfile.ok, true);
      assert.strictEqual(r.body.effective.aiProfile.id, 'fake');

      // Case 2: non-Git folder -> plannedGitInit=true, ready=true (auto-init path)
      // The product intentionally auto-inits on import (T06), so the preflight
      // surfaces the planned init rather than blocking. The UI shows a banner.
      r = await postJson('/api/projects/preflight-import', { localPath: repoNonGit, aiProfileId: 'fake' });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.body.plannedGitInit, true);
      assert.strictEqual(r.body.ready, true, 'non-git folder with planned auto-init is importable');
      assert.strictEqual(r.body.checks.git.plannedInit, true);
      assert.strictEqual(r.body.checks.git.status, 'non-git');

      // Case 3: empty git repo (HEAD missing) -> ready=true (commit will be made later)
      r = await postJson('/api/projects/preflight-import', { localPath: repoEmpty, aiProfileId: 'fake' });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.body.ok, true, 'empty repo is importable; the import transaction creates the first commit semantics later');
      assert.strictEqual(r.body.checks.git.status, 'empty');
      assert.strictEqual(r.body.checks.git.headCommit, null);

      // Case 4: missing knowledge root -> ready=false
      const noKnowledgeSpawned = spawnServer({
        root: ROOT, port: PORT + 1, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), `pk-preflight-nokb-${process.pid}-`)),
        tag: 'preflight-nokb', extraEnv: { KB_SKIP_MIGRATION: '1' },
      });
      try {
        for (let attempt = 0; attempt < 100; attempt += 1) {
          try { if ((await fetch(`http://127.0.0.1:${PORT + 1}/api/health`)).ok) break; } catch {}
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        const r2 = await fetch(`http://127.0.0.1:${PORT + 1}/api/projects/preflight-import`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ localPath: repoOk, aiProfileId: 'fake' }),
        }).then(async response => ({ status: response.status, body: await response.json() }));
        console.log('DEBUG no-knowledge-root:', r2.status, JSON.stringify(r2.body));
        assert.strictEqual(r2.status, 200);
        assert.strictEqual(r2.body.ready, false);
        assert(r2.body.problems.some(p => p.code === 'KNOWLEDGE_ROOT_MISSING'));
      } finally {
        noKnowledgeSpawned.child.kill();
        await new Promise(resolve => noKnowledgeSpawned.child.once('exit', resolve));
      }

      // Case 5: path with spaces -> ready=true
      r = await postJson('/api/projects/preflight-import', { localPath: repoSpaces, aiProfileId: 'fake' });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.body.ready, true);
      assert.strictEqual(r.body.checks.git.ok, true);

      // Case 6: no AI profile configured -> ready=false with AI_PROFILE_REQUIRED
      const noProfileSpawned = spawnServer({
        root: ROOT, port: PORT + 2, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), `pk-preflight-noprofile-${process.pid}-`)),
        tag: 'preflight-noprofile', extraEnv: { KB_SKIP_MIGRATION: '1' },
      });
      try {
        for (let attempt = 0; attempt < 100; attempt += 1) {
          try { if ((await fetch(`http://127.0.0.1:${PORT + 2}/api/health`)).ok) break; } catch {}
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        // Patch only knowledge root; no AI profile configured
        const noProfileDir = noProfileSpawned.dataDir || noProfileSpawned.dir;
        await fetch(`http://127.0.0.1:${PORT + 2}/api/settings`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ knowledge: { rootPath: path.join(noProfileDir, 'knowledge') } }),
        });
        const r2 = await fetch(`http://127.0.0.1:${PORT + 2}/api/projects/preflight-import`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ localPath: repoOk }),
        }).then(async response => ({ status: response.status, body: await response.json() }));
        assert.strictEqual(r2.status, 200);
        assert.strictEqual(r2.body.ready, false);
        assert(r2.body.problems.some(p => p.code === 'AI_PROFILE_REQUIRED'));
      } finally {
        noProfileSpawned.child.kill();
        await new Promise(resolve => noProfileSpawned.child.once('exit', resolve));
      }

      // Case 7: third-party hook -> ready=false with HOOK_CONFLICT
      r = await postJson('/api/projects/preflight-import', { localPath: repoThirdParty, aiProfileId: 'fake' });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.body.ready, false);
      assert(r.body.problems.some(p => p.code === 'HOOK_CONFLICT'));
      assert.strictEqual(r.body.checks.hook.ok, false);
      assert.strictEqual(r.body.checks.hook.reason, 'third-party');

      // Case 8: duplicate detection after a successful import
      r = await postJson('/api/projects/import', { localPath: repoOk, displayName: 'Dup', aiProfileId: 'fake' });
      assert.strictEqual(r.status, 201, JSON.stringify(r.body));
      const projectId = r.body.projectId;
      r = await postJson('/api/projects/preflight-import', { localPath: repoOk, aiProfileId: 'fake' });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.body.ready, false);
      assert(r.body.problems.some(p => p.code === 'DUPLICATE_PROJECT' && p.existingProjectId === projectId));

      // Case 9: invalid knowledgeLanguage -> problem reported
      r = await postJson('/api/projects/preflight-import', { localPath: repoOk, aiProfileId: 'fake', knowledgeLanguage: 'xx-INVALID' });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.body.ready, false);
      assert(r.body.problems.some(p => p.code === 'KNOWLEDGE_LANGUAGE_INVALID'));

      // Case 10: path missing entirely
      r = await postJson('/api/projects/preflight-import', { localPath: path.join(dataDir, 'does-not-exist') });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.body.ready, false);
      assert(r.body.problems.some(p => p.code === 'PATH_MISSING'));
    } finally {
      spawned.child.kill();
      await new Promise(resolve => spawned.child.once('exit', resolve));
    }
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
    for (const dir of [repoOk, repoEmpty, repoNonGit, repoSpaces, repoThirdParty]) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  }
  console.log('import-preflight-api-test PASS');
})().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
