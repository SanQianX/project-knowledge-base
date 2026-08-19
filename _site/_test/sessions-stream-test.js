const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { spawnServer } = require('./helpers/spawn-server');

const ROOT = path.resolve(__dirname, '..', '..');
const PORT = 7804;
const BASE = `http://127.0.0.1:${PORT}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkb-sse-v2-'));
const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'pkb-sse-repo-'));

function git(args) {
  const result = spawnSync('git', args, { cwd: repoPath, encoding: 'utf8' });
  assert.strictEqual(result.status, 0, result.stderr);
}

async function json(method, pathname, body) {
  const response = await fetch(`${BASE}${pathname}`, { method, headers: body === undefined ? undefined : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, data: await response.json() };
}

async function waitForServer() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('server did not start');
}

function openSse() {
  const frames = [];
  let buffer = '';
  const request = http.get(`${BASE}/api/claude/sessions-stream`, response => {
    assert.strictEqual(response.statusCode, 200);
    response.on('data', chunk => {
      buffer += chunk.toString('utf8');
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const event = /^event:\s*(.+)$/m.exec(block);
        const data = /^data:\s*(.+)$/m.exec(block);
        if (event && data) frames.push({ event: event[1], data: JSON.parse(data[1]) });
      }
    });
  });
  request.on('error', error => { frames.push({ event: 'transport-error', data: { message: error.message } }); });
  return { frames, close: () => request.destroy() };
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('timed out waiting for SSE frame');
}

(async () => {
  git(['init', '--initial-branch=main']);
  git(['config', 'user.email', 'sse@example.test']);
  git(['config', 'user.name', 'SSE Test']);
  const spawned = spawnServer({ root: ROOT, port: PORT, dataDir, tag: 'sse-v2', extraEnv: { KB_SKIP_MIGRATION: '1' } });
  try {
    await waitForServer();
    await json('PATCH', '/api/settings', { knowledge: { rootPath: path.join(dataDir, 'knowledge') } });
    await json('PUT', '/api/ai-profiles', { schema: 'ai-profiles/v1', defaultProfileId: 'test', profiles: [{ id: 'test', name: 'Test', enabled: true, implementation: 'claude-code-agent', apiKeyUpdate: { mode: 'replace', value: 'sk-test' } }] });
    const imported = await json('POST', '/api/projects/import', { localPath: repoPath, aiProfileId: 'test' });
    assert.strictEqual(imported.status, 201, JSON.stringify(imported.data));

    const stream = openSse();
    await waitFor(() => stream.frames.some(frame => frame.event === 'claude/snapshot'));
    const snapshot = stream.frames.find(frame => frame.event === 'claude/snapshot');
    assert(Array.isArray(snapshot.data.sessions));

    const started = await json('POST', '/api/claude/sessions', { projectId: imported.data.projectId });
    assert.strictEqual(started.status, 201, JSON.stringify(started.data));
    await waitFor(() => stream.frames.some(frame => frame.event === 'claude/sessions-changed' && frame.data.kind === 'create'));
    const created = stream.frames.find(frame => frame.event === 'claude/sessions-changed' && frame.data.kind === 'create');
    assert.strictEqual(created.data.projectSlug, imported.data.projectId);
    const sessions = await json('GET', `/api/claude/sessions?projectId=${encodeURIComponent(imported.data.projectId)}`);
    assert(sessions.data.sessions.some(session => session.sessionId === started.data.sessionId));
    stream.close();
    console.log('sessions-stream-test PASS');
  } finally {
    await spawned.cleanup();
    fs.rmSync(repoPath, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
