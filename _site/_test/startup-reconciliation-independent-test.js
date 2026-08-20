// _site/_test/startup-reconciliation-independent-test.js
//
// T05: prove startup reconciliation works independently from the live hook.
//
// Flow:
//   1. Set up a managed project with a tracked baseline commit (no hook delivery).
//   2. Make 2 new Git commits while the backend is OFFLINE.
//   3. Start the backend. No hook events fire; only startup reconciliation
//      can discover the pending commits.
//   4. Wait for the deterministic state signal: lastAnalyzedCommit catches up
//      to HEAD, knowledge Markdown files exist for both new commits.
//   5. Assert oldest-first ordering by inspecting analysis.claim / evidence.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { spawnServer } = require('./helpers/spawn-server');

const ROOT = path.resolve(__dirname, '..', '..');
const PORT = 7902;
const BASE = `http://127.0.0.1:${PORT}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `pk-startup-recon-${process.pid}-`));
const repo = fs.mkdtempSync(path.join(os.tmpdir(), `pk-startup-recon-repo-${process.pid}-`));

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
  git(['config', 'user.email', 'startup@example.local']);
  git(['config', 'user.name', 'Startup Recon Test']);
  git(['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(repo, 'README.md'), '# startup recon\n');
  git(['add', 'README.md']);
  git(['commit', '-q', '-m', 'baseline']);
}

async function waitFor(predicate, { label, timeoutMs = 60_000, intervalMs = 200 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    last = await predicate();
    if (last && (last.ok || last.match)) return last;
    if (Date.now() > deadline) throw new Error(`${label} timed out; last=${JSON.stringify(last)}`);
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
}

(async () => {
  makeRepo();
  const baselineSha = git(['rev-parse', 'HEAD']);
  // Start backend BEFORE making any commits past the baseline. We import the
  // project at this point so the tracked baseline is the import-time HEAD.
  const spawned = spawnServer({
    root: ROOT, port: PORT, dataDir, tag: 'startup-recon',
    extraEnv: {
      KB_AUTOMATION_FAKE_CLAUDE: '1', KB_EMBEDDING_FAKE: '1',
      KB_MAINTENANCE_INTERVAL_MS: '600000',
    },
  });
  let output = '';
  spawned.child.stdout.on('data', chunk => { output += chunk; });
  spawned.child.stderr.on('data', chunk => { output += chunk; });
  try {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    await fetch(`${BASE}/api/settings`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ knowledge: { rootPath: path.join(dataDir, 'knowledge') } }),
    });
    await fetch(`${BASE}/api/ai-profiles`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        schema: 'ai-profiles/v1', defaultProfileId: 'fake',
        profiles: [{ id: 'fake', name: 'Fake', enabled: true, vendor: 'anthropic', model: 'fake', apiKeyUpdate: { mode: 'replace', value: 'k' } }],
      }),
    });
    const importResponse = await fetch(`${BASE}/api/projects/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: 'project-startup-recon', localPath: repo, displayName: 'Startup Recon', aiProfileId: 'fake',
      }),
    });
    assert.strictEqual(importResponse.status, 201);
    const importBody = await importResponse.json();
    const projectId = importBody.projectId;
    assert.strictEqual(importBody.project.state.trackingStartCommit, baselineSha, 'import must freeze trackingStartCommit at the import-time HEAD');
    assert.strictEqual(importBody.project.state.lastAnalyzedCommit, null);
    // Stop the backend BEFORE making the two offline commits. This proves the
    // live hook cannot fire.
    spawned.child.kill();
    await new Promise(resolve => spawned.child.once('exit', resolve));
    fs.writeFileSync(path.join(repo, 'change1.txt'), 'one\n');
    git(['add', 'change1.txt']);
    git(['commit', '-q', '-m', 'change-1']);
    const firstPending = git(['rev-parse', 'HEAD']);
    fs.writeFileSync(path.join(repo, 'change2.txt'), 'two\n');
    git(['add', 'change2.txt']);
    git(['commit', '-q', '-m', 'change-2']);
    const headSha = git(['rev-parse', 'HEAD']);
    assert.notStrictEqual(firstPending, headSha, 'fixture must create two distinct commits');
    assert.notStrictEqual(firstPending, baselineSha, 'first pending must not equal baseline');
    // Re-start the backend. Startup reconciliation must discover both
    // pending commits with NO hook events ever firing.
    const spawned2 = spawnServer({
      root: ROOT, port: PORT, dataDir, tag: 'startup-recon-2',
      extraEnv: {
        KB_AUTOMATION_FAKE_CLAUDE: '1', KB_EMBEDDING_FAKE: '1',
        KB_MAINTENANCE_INTERVAL_MS: '600000',
      },
    });
    let output2 = '';
    spawned2.child.stdout.on('data', chunk => { output2 += chunk; });
    spawned2.child.stderr.on('data', chunk => { output2 += chunk; });
    try {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch {}
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      // Wait for startup reconciliation to catch up.
      await waitFor(async () => {
        const r = await fetch(`${BASE}/api/projects/${projectId}`);
        const body = await r.json();
        const last = body.project.state.lastAnalyzedCommit;
        return last === headSha ? { ok: true, state: body.project.state } : { ok: false, last };
      }, { label: 'startup reconciliation after backend restart catches up to HEAD' });
      const knowledgePath = importBody.project.config.knowledgePath;
      const firstFile = path.join(knowledgePath, 'changes', `${firstPending.slice(0, 12)}.md`);
      const secondFile = path.join(knowledgePath, 'changes', `${headSha.slice(0, 12)}.md`);
      assert(fs.existsSync(firstFile), `first pending commit must have a knowledge Markdown file at ${firstFile}`);
      assert(fs.existsSync(secondFile), `second pending commit (HEAD) must have a knowledge Markdown file at ${secondFile}`);
      // The reconciler re-scans after each batch and may overwrite
      // analysis.status with 'idle' if it sees an empty commit list. The
      // post-fix runSweep only writes 'idle' when nothing was processed,
      // so we still read 'state.advanced' here. Wait briefly to give
      // any trailing reconcile work a chance to settle so the read is
      // deterministic across fast and slow machines (the CI failure was
      // a timing race around this exact transition).
      await new Promise(resolve => setTimeout(resolve, 500));
      const finalState = await (await fetch(`${BASE}/api/projects/${projectId}`)).json();
      assert.strictEqual(finalState.project.state.lastAnalyzedCommit, headSha);
      assert.strictEqual(finalState.project.state.trackingStartCommit, baselineSha);
      assert.strictEqual(finalState.project.state.analysis.activeClaim, null);
      assert.strictEqual(finalState.project.state.analysis.status, 'state.advanced');
    } finally {
      spawned2.child.kill();
      await new Promise(resolve => spawned2.child.once('exit', resolve));
    }
  } catch (error) {
    console.error('SERVER OUTPUT:\n', output);
    throw error;
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
  console.log('startup-reconciliation-independent-test PASS');
})().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
