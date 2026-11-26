const assert = require('assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnServer } = require('./helpers/spawn-server');
const { createRequestHandler } = require('../src/server/server-app');

const ROOT = require("./paths").ROOT;
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

    // /api/workflow/* 写入加固：页面现在能登记会被自动执行的本机命令。
    // 单靠「Origin 等于 Host」不够：DNS 重绑定的页面发出的请求正是这样，两者都是攻击者的域名。
    // Workflow writes hardening: the page can now register local commands that run automatically.
    // "Origin equals Host" alone is not enough — it is exactly what a DNS-rebinding page sends, both names being the attacker's.
    const workflowWrite = headers => new Promise((resolve, reject) => {
      const request = http.request({
        host: '127.0.0.1', port: PORT, method: 'POST', path: '/api/workflow/team',
        headers: { 'Content-Type': 'application/json', 'Content-Length': 2, ...headers },
      }, response => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', chunk => { text += chunk; });
        response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(text) }));
      });
      request.on('error', reject);
      request.end('{}');
    });
    const rebound = await workflowWrite({ Host: `rebind.example:${PORT}`, Origin: `http://rebind.example:${PORT}` });
    assert.strictEqual(rebound.status, 403, 'Origin equal to a non-loopback Host is a rebound page, not the product page');
    assert.strictEqual(rebound.body.error.code, 'ORIGIN_FORBIDDEN');
    for (const site of ['cross-site', 'same-site']) {
      const response2 = await workflowWrite({ 'Sec-Fetch-Site': site });
      assert.strictEqual(response2.status, 403, `Sec-Fetch-Site ${site} must not write through the workflow proxy`);
    }
    // 放行的请求到达代理后，只会连到这个隔离实例自己的（空）模块地址。
    // A request that passes the gate reaches the proxy and only this isolated instance's own (offline) module address.
    for (const headers of [{ 'Sec-Fetch-Site': 'same-origin' }, { Host: `localhost:${PORT}`, 'Sec-Fetch-Site': 'none' }]) {
      const response2 = await workflowWrite(headers);
      assert.strictEqual(response2.status, 502, JSON.stringify(response2.body));
      assert.strictEqual(response2.body.error, 'MODULE_UNREACHABLE');
      assert.strictEqual(response2.body.target, 'http://127.0.0.1:0/api/workflow/v1/team');
    }
    // 非回环监听（带令牌）时 Host 可以是任意地址，由 Sec-Fetch-Site 把关。
    // On a token-protected non-loopback bind the Host may be any address; Sec-Fetch-Site is the gate.
    const { workflowWriteAllowed } = require('../src/server/server-app');
    const exposed = { loopbackBind: false };
    assert.strictEqual(workflowWriteAllowed({ headers: { host: '192.168.1.5:5757', 'sec-fetch-site': 'same-origin' } }, exposed), true);
    assert.strictEqual(workflowWriteAllowed({ headers: { host: '192.168.1.5:5757' } }, exposed), true, 'non-browser clients send no Sec-Fetch-Site');
    assert.strictEqual(workflowWriteAllowed({ headers: { host: '192.168.1.5:5757', 'sec-fetch-site': 'same-site' } }, exposed), false);

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
    await spawned.cleanup();
    fs.rmSync(remoteDataDir, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
