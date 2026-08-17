const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnServer } = require('./helpers/spawn-server');
const { createRequestHandler } = require('../lib/server-app');

const ROOT = path.resolve(__dirname, '..', '..');
const PORT = 7832;
const BASE = `http://127.0.0.1:${PORT}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkb-security-v2-'));
const REMOTE_PORT = 7833;
const REMOTE_BASE = `http://127.0.0.1:${REMOTE_PORT}`;
const remoteDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkb-security-remote-v2-'));

async function waitForServer() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('server did not start');
}

(async () => {
  assert.throws(
    () => createRequestHandler({}, { host: '0.0.0.0', port: 9999 }),
    error => error && error.code === 'AUTH_REQUIRED',
    'non-loopback bind must require authentication',
  );

  const spawned = spawnServer({ root: ROOT, port: PORT, dataDir, tag: 'security-v2', extraEnv: { KB_SKIP_MIGRATION: '1' } });
  try {
    await waitForServer();
    let response = await fetch(`${BASE}/api/ai-profiles`, { headers: { Origin: 'https://evil.example' } });
    assert.strictEqual(response.status, 403);
    assert.strictEqual(response.headers.get('access-control-allow-origin'), null);

    response = await fetch(`${BASE}/api/ai-profiles`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
        schema: 'ai-profiles/v1', profiles: [{ id: 'secret', enabled: true, apiKeyUpdate: { mode: 'replace', value: 'top-secret-api-key' } }],
      }),
    });
    assert.strictEqual(response.status, 200);
    response = await fetch(`${BASE}/api/ai-profiles`);
    const profileText = await response.text();
    assert(!profileText.includes('top-secret-api-key'));
    assert(!/"apiKey"\s*:/.test(profileText));

    response = await fetch(`${BASE}/api/raw?path=../../settings.json`);
    assert.strictEqual(response.status, 404);
    const rawText = await response.text();
    assert(!rawText.includes('top-secret-api-key'));

    response = await fetch(`${BASE}/api/projects/not-valid%2Fid`);
    const errorText = await response.text();
    assert(!/\bstack\b/i.test(errorText));
    assert(!errorText.includes('top-secret-api-key'));
    const error = JSON.parse(errorText);
    assert(error.error.operationId);

    const remote = spawnServer({
      root: ROOT,
      port: REMOTE_PORT,
      host: '0.0.0.0',
      dataDir: remoteDataDir,
      tag: 'security-remote-v2',
      extraEnv: {
        KB_SKIP_MIGRATION: '1',
        KB_SITE_AUTH_TOKEN: 'remote-auth-secret',
        KB_ALLOWED_ORIGINS: 'https://allowed.example',
      },
    });
    try {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        try {
          const ready = await fetch(`${REMOTE_BASE}/api/health`, { headers: { Authorization: 'Bearer remote-auth-secret', Origin: 'https://allowed.example' } });
          if (ready.ok) break;
        } catch {}
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      let remoteResponse = await fetch(`${REMOTE_BASE}/api/health`, { headers: { Origin: 'https://allowed.example' } });
      assert.strictEqual(remoteResponse.status, 401, 'non-loopback request without token must fail');
      remoteResponse = await fetch(`${REMOTE_BASE}/api/health`, { headers: { Authorization: 'Bearer remote-auth-secret', Origin: 'https://evil.example' } });
      assert.strictEqual(remoteResponse.status, 403, 'non-loopback request from an unlisted Origin must fail');
      remoteResponse = await fetch(`${REMOTE_BASE}/api/health`, { headers: { Authorization: 'Bearer remote-auth-secret', Origin: 'https://allowed.example' } });
      assert.strictEqual(remoteResponse.status, 200);
      assert.strictEqual(remoteResponse.headers.get('access-control-allow-origin'), 'https://allowed.example');
    } finally {
      remote.cleanup();
    }
    console.log('server-security-test PASS');
  } finally {
    spawned.cleanup();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(remoteDataDir, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
