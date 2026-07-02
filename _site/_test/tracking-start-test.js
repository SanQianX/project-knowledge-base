const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const { spawnServer } = require('./helpers/spawn-server');

const ROOT = path.resolve(__dirname, '..', '..');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), `kb-tracking-start-data-${process.pid}-`));
const REPO = fs.mkdtempSync(path.join(os.tmpdir(), `kb-tracking-start-repo-${process.pid}-`));
const PORT = process.env.KB_TRACKING_START_PORT || '7834';
const BASE_URL = `http://127.0.0.1:${PORT}`;

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
  }],
}, null, 2) + '\n', 'utf-8');

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function git(args) {
  const r = spawnSync('git', args, { cwd: REPO, encoding: 'utf-8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  return (r.stdout || '').trim();
}

function commit(name, body) {
  fs.writeFileSync(path.join(REPO, name), `${body}\n`, 'utf-8');
  git(['add', name]);
  git(['commit', '--no-verify', '-m', `feat: ${body}`]);
  return git(['rev-parse', 'HEAD']);
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
  git(['init', '--initial-branch=main']);
  git(['config', 'user.email', 'tracking@example.com']);
  git(['config', 'user.name', 'Tracking Test']);
  git(['config', 'commit.gpgsign', 'false']);
  commit('one.txt', 'one');
  commit('two.txt', 'two');
  const importHead = commit('three.txt', 'three');

  const spawned = spawnServer({
    root: ROOT,
    port: Number(PORT),
    dataDir: DATA_DIR,
    tag: 'tracking-start',
    extraEnv: { KB_AUTOMATION_FAKE_CLAUDE: '1' },
  });
  const child = spawned.child;
  let serverOutput = '';
  child.stdout.on('data', d => { serverOutput += d.toString(); });
  child.stderr.on('data', d => { serverOutput += d.toString(); });
  child.on('exit', (code, signal) => { serverOutput += `\n[child exit] code=${code} signal=${signal}\n`; });

  try {
    await waitForServer();
    let r = await json('POST', '/api/projects/import', { localPath: REPO });
    assert(r.res.ok, `import should succeed: ${JSON.stringify(r.data)}`);
    const slug = r.data.slug;
    const kbPath = r.data.config.kbPath;
    assert(r.data.config.trackingStartCommit === importHead, 'first import should track current HEAD as start');

    r = await json('POST', `/api/projects/${slug}/scan`);
    assert(r.res.ok, 'scan after import should succeed');
    assert(r.data.pendingCount === 0, `pre-import commits must not be pending, got ${r.data.pendingCount}`);
    r = await json('POST', `/api/projects/${slug}/hook-uninstall`);
    assert(r.res.ok, 'hook uninstall should succeed for isolated tracking test');

    commit('four.txt', 'four');
    commit('five.txt', 'five');
    r = await json('POST', `/api/projects/${slug}/scan`);
    assert(r.res.ok, 'scan after new commits should succeed');
    assert(r.data.pendingCount === 2, `expected 2 post-import commits, got ${r.data.pendingCount}`);

    r = await json('POST', `/api/projects/${slug}/remove`, { deleteKb: false, reason: 'tracking test soft remove' });
    assert(r.res.ok && r.data.removedKb === false, 'soft remove should keep KB');

    commit('six.txt', 'six');
    r = await json('POST', '/api/projects/import', { localPath: REPO });
    assert(r.res.ok, `reimport should succeed: ${JSON.stringify(r.data)}`);
    assert(r.data.slug === slug, 'reimport should restore the original slug');
    assert(r.data.reconnected === true, 'reimport should reconnect soft-removed project');
    assert(r.data.config.trackingStartCommit === importHead, 'reimport must preserve first import tracking start');
    assert(r.data.initAutomation && r.data.initAutomation.skipped === true, 'reimport with existing KB should skip init automation');
    assert(!kbPath || fs.existsSync(kbPath), 'soft-removed KB should still exist');

    r = await json('POST', `/api/projects/${slug}/scan`);
    assert(r.res.ok, 'scan after reimport should succeed');
    assert(r.data.pendingCount === 3, `reimport should include all commits since first import, got ${r.data.pendingCount}`);

    console.log('tracking start test passed');
  } catch (e) {
    console.error('tracking start test failed:', e.stack || e.message);
    if (serverOutput) console.error(serverOutput);
    process.exitCode = 1;
  } finally {
    try { child.kill(); } catch {}
    try { fs.rmSync(REPO, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch {}
  }
})();
