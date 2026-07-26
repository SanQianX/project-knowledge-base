const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawnServer } = require('./helpers/spawn-server');

const ROOT = path.resolve(__dirname, '..', '..');
const PORT = 7900 + (process.pid % 500);
const SLUG = 'remove-guard-test';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `kb-remove-guard-${process.pid}-`));
const repoPath = path.join(dataDir, 'repo');
const kbPath = path.join(dataDir, 'knowledge', SLUG);
const sessionDir = path.join(dataDir, '_ai', SLUG, 'claude-workbench');
const sessionPath = path.join(sessionDir, 'active-session.json');

fs.mkdirSync(repoPath, { recursive: true });
fs.mkdirSync(kbPath, { recursive: true });
fs.mkdirSync(sessionDir, { recursive: true });
fs.writeFileSync(path.join(dataDir, 'projects.json'), JSON.stringify({
  [SLUG]: {
    slug: SLUG,
    displayName: 'Remove Guard Test',
    localPath: repoPath,
    gitPath: repoPath,
    kbPath,
    enabled: true,
  },
}, null, 2));

const now = new Date().toISOString();
const sessionRecord = {
  schema: 'claude-workbench-session/v1',
  sessionId: 'active-session',
  projectSlug: SLUG,
  projectPath: repoPath,
  kbPath,
  promptKey: 'terminal-chat',
  runner: 'sdk',
  state: 'running',
  source: 'terminal',
  startedAt: now,
  updatedAt: now,
  events: [],
};
fs.writeFileSync(sessionPath, JSON.stringify(sessionRecord, null, 2));

function request(method, requestPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1',
      port: PORT,
      method,
      path: requestPath,
      headers: payload ? {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
      } : {},
    }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => {
        let data = {};
        try { data = JSON.parse(text || '{}'); } catch {}
        resolve({ status: res.statusCode, data });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function waitForServer() {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const result = await request('GET', '/api/state');
      if (result.status === 200) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('server did not start');
}

(async () => {
  const spawned = spawnServer({ root: ROOT, port: PORT, dataDir, tag: 'project-remove-running-guard' });
  try {
    await waitForServer();

    const preview = await request('GET', `/api/projects/${SLUG}/remove-preview`);
    assert.strictEqual(preview.status, 200);
    assert.strictEqual(preview.data.preview.hasRunningJobs, true);

    const blocked = await request('POST', `/api/projects/${SLUG}/remove`, { deleteKb: false });
    assert.strictEqual(blocked.status, 409);
    assert.strictEqual(blocked.data.code, 'project_has_running_jobs');

    const projectsWhileActive = await request('GET', '/api/projects');
    assert(projectsWhileActive.data[SLUG], 'active project must remain registered');

    fs.writeFileSync(sessionPath, JSON.stringify({
      ...sessionRecord,
      state: 'idle',
      updatedAt: new Date().toISOString(),
    }, null, 2));

    const removed = await request('POST', `/api/projects/${SLUG}/remove`, {
      deleteKb: false,
      reason: 'guard regression test',
    });
    assert.strictEqual(removed.status, 200);
    assert.strictEqual(removed.data.ok, true);

    const projectsAfter = await request('GET', '/api/projects');
    assert(!projectsAfter.data[SLUG], 'idle project should be removable');
    console.log('project remove running guard test passed');
  } finally {
    spawned.cleanup();
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
