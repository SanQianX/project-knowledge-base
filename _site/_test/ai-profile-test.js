const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnServer } = require('./helpers/spawn-server');

const ROOT = path.resolve(__dirname, '..', '..');
const PORT = 7795;
const BASE = `http://127.0.0.1:${PORT}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkb-ai-v2-'));

async function request(method, pathname, body) {
  const response = await fetch(`${BASE}${pathname}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, text: await response.text() };
}

async function json(method, pathname, body) {
  const result = await request(method, pathname, body);
  return { ...result, data: JSON.parse(result.text || '{}') };
}

async function waitForServer() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('server did not start');
}

(async () => {
  const spawned = spawnServer({ root: ROOT, port: PORT, dataDir, tag: 'ai-profile-v2', extraEnv: { KB_SKIP_MIGRATION: '1' } });
  try {
    await waitForServer();
    let result = await json('PUT', '/api/ai-profiles', {
      schema: 'ai-profiles/v1', defaultProfileId: 'secure', profiles: [{
        id: 'secure', name: 'Secure', enabled: true, implementation: 'claude-code-agent', apiKeyUpdate: { mode: 'replace', value: 'sk-secret-1234' },
      }],
    });
    assert.strictEqual(result.status, 200, result.text);
    assert.strictEqual(result.data.config.profiles[0].hasApiKey, true);
    assert.strictEqual(result.data.config.profiles[0].apiKeyMasked, '****1234');
    assert(!result.text.includes('sk-secret-1234'));

    result = await json('GET', '/api/ai-profiles');
    assert.strictEqual(result.status, 200);
    assert(!result.text.includes('sk-secret-1234'));
    assert(!/"apiKey"\s*:/.test(result.text));

    result = await json('PUT', '/api/ai-profiles', {
      schema: 'ai-profiles/v1', defaultProfileId: 'secure', profiles: [{ id: 'secure', name: 'Renamed', enabled: true, implementation: 'claude-code-agent', apiKeyUpdate: { mode: 'preserve' } }],
    });
    assert.strictEqual(result.status, 200);
    let settings = JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8'));
    assert.strictEqual(settings.ai.profiles[0].apiKey, 'sk-secret-1234');

    result = await json('PUT', '/api/ai-profiles', {
      schema: 'ai-profiles/v1', defaultProfileId: 'secure', profiles: [{ id: 'secure', name: 'Renamed', enabled: true, implementation: 'claude-code-agent', apiKeyUpdate: { mode: 'clear' } }],
    });
    assert.strictEqual(result.status, 200);
    settings = JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8'));
    assert(!Object.prototype.hasOwnProperty.call(settings.ai.profiles[0], 'apiKey'));

    result = await json('PUT', '/api/ai-profiles', { profiles: [{ id: '../bad', apiKeyUpdate: { mode: 'clear' } }] });
    assert.strictEqual(result.status, 400);
    assert.strictEqual(result.data.error.code, 'INVALID_ARGUMENT');
    assert(!Object.prototype.hasOwnProperty.call(result.data.error, 'stack'));
    console.log('ai-profile-test PASS');
  } finally {
    spawned.cleanup();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
