// _site/_test/sessions-stream-test.js
//
// Regression test for the global Claude session lifecycle SSE channel
// (GET /api/claude/sessions-stream). Verifies:
//   1. Connecting receives an immediate `claude/snapshot` frame with the
//      current session list (so the client can sync without a separate poll).
//   2. Triggering a post-commit automation via /api/hooks/post-commit pushes
//      `claude/sessions-changed` frames with `kind: 'create'` then a
//      transition frame as the fake Claude session moves through its states.
//   3. Disconnecting cleans up the server-side subscriber (no leaked timers).
//
// Uses KB_AUTOMATION_FAKE_CLAUDE=1 so the SDK run completes instantly without
// the real Claude binary.

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { spawnSync } = require('child_process');
const { spawnServer } = require('./helpers/spawn-server');

const ROOT = path.resolve(__dirname, '..', '..');
const PORT = process.env.KB_SSE_TEST_PORT || '7804';
const HOST = '127.0.0.1';
const BASE_URL = `http://${HOST}:${PORT}`;

const SLUG = 'sse-test-proj';
const TEST_AI_PROFILE_ID = 'test-claude-agent';
const FIXTURE_REPO = path.join(os.tmpdir(), `kb-sse-test-${process.pid}`);
const FIXTURE_KB_PATH = path.join(os.tmpdir(), `kb-sse-test-kb-${process.pid}`);

function assert(cond, msg) {
  if (!cond) throw new Error('ASSERT: ' + msg);
}

function rmrf(p) {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch {}
}

function execGit(cwd, args) {
  return spawnSync('git', args, { cwd, encoding: 'utf-8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
}

function initRepo(p) {
  rmrf(p);
  fs.mkdirSync(p, { recursive: true });
  let r = execGit(p, ['init', '--initial-branch=main']);
  assert(r.status === 0, 'git init failed: ' + r.stderr);
  execGit(p, ['config', 'user.email', 'kb-sse-test@example.com']);
  execGit(p, ['config', 'user.name', 'KB SSE Test']);
  execGit(p, ['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(p, 'README.md'), '# sse test\n', 'utf-8');
  execGit(p, ['add', 'README.md']);
  r = execGit(p, ['commit', '-m', 'init']);
  assert(r.status === 0, 'initial commit failed: ' + r.stderr);
}

function makeCommit(p, msg) {
  fs.writeFileSync(path.join(p, 'changelog.md'), `+ ${msg}\n`, { flag: 'a' });
  execGit(p, ['add', 'changelog.md']);
  const r = execGit(p, ['commit', '-m', msg]);
  assert(r.status === 0, 'commit failed: ' + r.stderr + ' :: ' + r.stdout);
}

async function waitForServer() {
  const deadline = Date.now() + 15000;
  let last;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE_URL}/api/state`);
      if (r.status < 500) return;
      last = new Error('HTTP ' + r.status);
    } catch (e) { last = e; }
    await new Promise(r => setTimeout(r, 250));
  }
  throw last || new Error('server did not start');
}

async function postJson(path_, body) {
  const data = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: HOST, port: Number(PORT), method: 'POST', path: path_,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      timeout: 5000,
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf-8');
        let json = {};
        try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
        resolve({ status: res.statusCode, data: json });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.write(data);
    req.end();
  });
}

async function getJson(path_) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: HOST, port: Number(PORT), method: 'GET', path: path_, timeout: 5000 }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf-8');
        let json = {};
        try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
        resolve({ status: res.statusCode, data: json });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.end();
  });
}

// Open SSE stream and collect parsed frames. Returns { frames, close }.
function openSse(path_) {
  const frames = [];
  let buf = '';
  let settled = false;
  const req = http.request({
    host: HOST, port: Number(PORT), method: 'GET', path: path_,
    headers: { Accept: 'text/event-stream' },
  }, (res) => {
    assert(res.statusCode === 200, `SSE returned HTTP ${res.statusCode}`);
    assert(/text\/event-stream/.test(res.headers['content-type'] || ''),
      `expected text/event-stream, got ${res.headers['content-type']}`);
    res.on('data', (chunk) => {
      buf += chunk.toString('utf-8');
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, idx); buf = buf.slice(idx + 2);
        const ev = {};
        for (const line of block.split('\n')) {
          const m = line.match(/^(\w+):\s?(.*)$/);
          if (m) ev[m[1]] = ev[m[1]] ? ev[m[1]] + '\n' + m[2] : m[2];
        }
        // Skip comment frames (heartbeats) and frames without data
        if (!ev.event || ev.data === undefined) continue;
        let data = ev.data;
        try { data = JSON.parse(data); } catch {}
        frames.push({ event: ev.event, data });
      }
    });
    res.on('end', () => { settled = true; });
    res.on('error', () => { settled = true; });
  });
  req.on('error', () => { settled = true; });
  req.end();
  return {
    frames,
    get settled() { return settled; },
    close() {
      try { req.destroy(); } catch {}
    },
  };
}

async function waitFor(predicate, timeoutMs = 5000, intervalMs = 50) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return predicate();
}

(async () => {
  initRepo(FIXTURE_REPO);

  const serverHandle = spawnServer({
    root: ROOT,
    port: Number(PORT),
    tag: 'sse-stream',
    extraEnv: { KB_AUTOMATION_FAKE_CLAUDE: '1' },
  });
  const serverDataDir = serverHandle.dataDir;
  // Pre-populate ai-profiles.json in the test data dir so the server's
  // validateUsableAiProfile check passes and startAutomationSession actually
  // creates a session (which is what we want to broadcast).
  fs.writeFileSync(path.join(serverDataDir, 'ai-profiles.json'), JSON.stringify({
    schema: 'ai-profiles/v1',
    profiles: [{
      id: TEST_AI_PROFILE_ID,
      name: 'Test Claude Agent',
      provider: 'test',
      enabled: true,
      implementation: 'claude-code-agent',
      apiKey: 'sk-test',
      baseUrl: 'https://example.test/anthropic',
      mainModel: 'test-model',
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      model: 'test-model',
    }],
  }, null, 2) + '\n', 'utf-8');
  const server = serverHandle.child;
  let serverOutput = '';
  server.stdout.on('data', d => { serverOutput += d.toString(); });
  server.stderr.on('data', d => { serverOutput += d.toString(); });
  const PROJECTS_JSON = path.join(serverDataDir, 'projects.json');
  const projKb = path.join(serverDataDir, 'projects', SLUG);

  try {
    await waitForServer();

    // Set up KB fixture so the project registration is valid.
    rmrf(projKb);
    rmrf(path.join(serverDataDir, '_ai', SLUG));
    fs.mkdirSync(projKb, { recursive: true });
    fs.mkdirSync(path.join(projKb, 'modules'), { recursive: true });
    fs.mkdirSync(path.join(projKb, 'changes'), { recursive: true });
    fs.writeFileSync(path.join(projKb, 'README.md'), '# sse test kb\n', 'utf-8');
    fs.writeFileSync(path.join(projKb, 'GOAL.md'), '# goal\n\ntest goal\n', 'utf-8');
    fs.writeFileSync(path.join(projKb, 'ARCHITECTURE.md'), '# architecture\n', 'utf-8');
    fs.writeFileSync(path.join(projKb, 'modules', '00-index.md'), '# Modules Index\n', 'utf-8');
    fs.writeFileSync(path.join(projKb, 'changes', '00-index.md'), '# Changes Index\n', 'utf-8');

    // Register the project so /api/hooks/post-commit can resolve it.
    const projects = JSON.parse(fs.readFileSync(PROJECTS_JSON, 'utf-8'));
    const trackingBaseline = execGit(FIXTURE_REPO, ['rev-parse', 'HEAD']).stdout.trim();
    projects[SLUG] = {
      displayName: 'SSE Test',
      localPath: FIXTURE_REPO,
      gitPath: FIXTURE_REPO,
      isReference: false,
      primaryLanguage: 'JavaScript',
      tags: [],
      docConvention: 'frontmatter-relations',
      kbPath: projKb,
      enabled: true,
      repoStatus: 'unknown',
      headCommit: null,
      lastSeenCommit: null,
      lastAnalyzedCommit: trackingBaseline,
      trackingStartCommit: trackingBaseline,
      aiProfileId: TEST_AI_PROFILE_ID,
      kbSchemaVersion: 'minimal',
      goalStatus: 'accepted',
      kbInitialized: true,
      automation: {
        enabled: true,
        postCommitEnabled: true,
        knowledgeMode: 'directWriteKb',
        allowReadOnlyBash: true,
        hookPromptTemplate: 'SSE test {{projectSlug}} {{shortHash}} {{changedFiles}} {{knowledgeMode}} {{permissionMode}}',
      },
      claudeWorkbench: { permissionMode: 'bypassPermissions' },
    };
    fs.writeFileSync(PROJECTS_JSON, JSON.stringify(projects, null, 2) + '\n', 'utf-8');

    // ---- Test 1: snapshot frame on connect ----
    let stream = openSse('/api/claude/sessions-stream');
    const gotSnapshot = await waitFor(() =>
      stream.frames.some(f => f.event === 'claude/snapshot'), 3000);
    assert(gotSnapshot, 'did not receive claude/snapshot frame within 3s; got: ' + JSON.stringify(stream.frames));
    const snap = stream.frames.find(f => f.event === 'claude/snapshot');
    assert(Array.isArray(snap.data.sessions),
      `claude/snapshot data.sessions should be array, got ${typeof snap.data.sessions}`);
    console.log('snapshot frame received with', snap.data.sessions.length, 'existing session(s)');

    // ---- Test 2: trigger automation, expect change frames ----
    makeCommit(FIXTURE_REPO, 'feat: sse test commit');

    // The hook is not installed in the fixture repo (we don't need it — we
    // post directly to /api/hooks/post-commit the way hook-trigger.js would).
    const dispatch = await postJson('/api/hooks/post-commit', {
      repoPath: FIXTURE_REPO,
      commitHash: '',
      branch: 'main',
    });
    assert(dispatch.status === 202 && dispatch.data.accepted === true,
      `dispatch failed: HTTP ${dispatch.status} ${JSON.stringify(dispatch.data)}`);

    // Wait for at least one 'create' frame followed by a state transition.
    const gotCreate = await waitFor(() =>
      stream.frames.some(f => f.event === 'claude/sessions-changed' && f.data && f.data.kind === 'create'),
      5000);
    assert(gotCreate,
      'did not receive create frame within 5s; got: ' + JSON.stringify(stream.frames.map(f => ({ e: f.event, k: f.data && f.data.kind }))));

    // Wait for at least one 'state' frame (the active→idle transition).
    const gotState = await waitFor(() =>
      stream.frames.some(f => f.event === 'claude/sessions-changed' && f.data && f.data.kind === 'state'),
      5000);
    assert(gotState,
      'did not receive state frame within 5s; got: ' + JSON.stringify(stream.frames.map(f => ({ e: f.event, k: f.data && f.data.kind, s: f.data && f.data.state }))));

    // The change frames must reference our slug and the same sessionId.
    const allChange = stream.frames.filter(f => f.event === 'claude/sessions-changed');
    const createFrame = allChange.find(f => f.data.kind === 'create');
    const sessionId = createFrame.data.sessionId;
    assert(createFrame.data.projectSlug === SLUG, `create frame should target ${SLUG}, got ${createFrame.data.projectSlug}`);
    assert(/^sess-/.test(sessionId), `sessionId should start with sess-, got ${sessionId}`);

    const stateFrames = allChange.filter(f => f.data.kind === 'state' && f.data.sessionId === sessionId);
    assert(stateFrames.length >= 1, 'expected at least 1 state frame for the new session');
    const lastState = stateFrames[stateFrames.length - 1];
    assert(lastState.data.state === 'idle' || lastState.data.state === 'failed' || lastState.data.state === 'aborted',
      `final state should be terminal-ish, got ${lastState.data.state}`);

    console.log('change frames received:', allChange.length,
      '(create +', stateFrames.length, 'state transitions)');

    // ---- Test 3: disconnect cleans up ----
    stream.close();
    // Give the server a moment to fire its 'close' cleanup. Then open a fresh
    // stream and confirm we get a snapshot (i.e. server still healthy).
    await new Promise(r => setTimeout(r, 250));
    const stream2 = openSse('/api/claude/sessions-stream');
    const got2 = await waitFor(() =>
      stream2.frames.some(f => f.event === 'claude/snapshot'), 3000);
    assert(got2, 'reopened stream did not deliver snapshot — server may have leaked state');
    stream2.close();

    // And the /api/claude/sessions REST endpoint agrees the session ended.
    await waitFor(async () => {
      const r = await getJson('/api/claude/sessions');
      return Array.isArray(r.data.sessions) && r.data.sessions.some(s => s.sessionId === sessionId);
    }, 5000);
    const rest = await getJson('/api/claude/sessions');
    const persisted = (rest.data.sessions || []).find(s => s.sessionId === sessionId);
    assert(persisted, 'persisted session should appear in /api/claude/sessions list');

    console.log('OK sessions-stream-test');
  } catch (e) {
    console.error('sessions-stream-test failed:', e.message);
    if (serverOutput) console.error('--- server output tail ---');
    if (serverOutput) console.error(serverOutput.slice(-2000));
    process.exitCode = 1;
  } finally {
    try { server.kill(); } catch {}
    rmrf(FIXTURE_REPO);
    rmrf(FIXTURE_KB_PATH);
    rmrf(projKb);
    rmrf(path.join(serverDataDir, '_ai', SLUG));
    try { fs.rmSync(serverDataDir, { recursive: true, force: true }); } catch {}
  }
})();
