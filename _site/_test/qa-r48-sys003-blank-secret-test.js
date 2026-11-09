'use strict';

// P-LIFECYCLE-EVIDENCE-R48 driver: SYS-003 凭据留空 (the single permitted
// minimal offline supplement, selected after the six-case audit).
//
// Case step (qa-autopilot/config/test-cases.json SYS-003): 已有embedding凭据后
// 留空保存，再读取mask元数据。 Expected: 留空不覆盖; 响应、日志不泄露secret.
//
// Real product bytes under test: the ROOT server (_site/lib/server-app.js +
// _site/lib/module-bridge.js proxy at the lane's source HEAD), spawned via the
// shared spawn-server helper on an ephemeral port with fully isolated data
// dirs, its terminal leg pointed at an OWN FAKE terminal service through
// KB_TERMINAL_URL (the dispatch's sanctioned 假服务 pattern).
//
// What is REAL here (product assertions):
//   * the proxy faithfully transports PUT bodies (secret value and the blank
//     secret '' exactly as the real UI sends it) and module responses;
//   * the masked GET metadata the UI reads carries no secret;
//   * the internal module endpoints are 403 to browsers (server-app guard);
//   * after /api/modules/configure really pulls the resolved (secret-bearing)
//     internal config through the root process, the public status contains no
//     secret, and NO root-server log file or response ever contains it.
// What is a DOCUMENTED-CONTRACT STAND-IN (honestly bounded, not a product
// claim): the fake terminal implements 留空不覆盖 + masked GET per the WB
// module's documented contract (ui copy '留空凭据不会覆盖现有密钥'); real
// WB 0.13.9 bytes were NOT exercised by this lane.
//
// No real service is touched; no UI is substituted for an API assertion (the
// case step itself is an interface procedure); no real credential exists here
// (the secret is an obvious fake marker).

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { installLaneEnv } = require('./helpers/qa-r48-env');

const ROOT = path.resolve(__dirname, '..', '..');
const CASE_DIR = 'sys003-blank-secret';
const SECRET = 'r48-fake-embedding-secret-9f1aCANNOT-be-real';

const lane = installLaneEnv({ caseId: 'sys003' });
const EVIDENCE = path.join(lane.evidenceRoot, CASE_DIR);

const { spawnServer } = require('./helpers/spawn-server');
const freePort = require('./helpers/free-port');

function sha256(file) {
  return require('node:crypto').createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

// ---- the OWN fake terminal service (documented-contract stand-in) ----
function startFakeTerminal() {
  const state = { received: [], internalPulls: 0, stored: null };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const url = new URL(req.url, 'http://127.0.0.1');
      const route = `${req.method} ${url.pathname}`;
      const bodyText = Buffer.concat(chunks).toString('utf8');
      const send = (status, payload) => {
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(payload));
      };
      if (route === 'GET /api/claude-workbench/v1/health') return send(200, { ok: true, status: 'ok' });
      if (route === 'GET /api/claude-workbench/v1/profiles') return send(200, { profiles: [] });
      if (route === 'GET /api/claude-workbench/v1/embedding-config') {
        if (!state.stored) return send(200, { configured: false, config: {} });
        // Masked metadata only — the documented module contract the UI reads.
        const { secret, ...masked } = state.stored;
        return send(200, { configured: Boolean(secret), config: masked, secretPresent: false });
      }
      if (route === 'PUT /api/claude-workbench/v1/embedding-config') {
        const body = bodyText ? JSON.parse(bodyText) : {};
        state.received.push({ at: new Date().toISOString(), body: { ...body } });
        // 留空不覆盖: a blank secret never clears the stored one.
        const incoming = typeof body.secret === 'string' ? body.secret : '';
        const previous = state.stored || {};
        state.stored = { ...previous, ...body, secret: incoming || previous.secret || '' };
        return send(200, { ok: true, configured: Boolean(state.stored.secret) });
      }
      if (route === 'POST /api/claude-workbench/v1/internal/embedding-config') {
        state.internalPulls += 1;
        // Internal channel returns the RESOLVED settings including the secret —
        // this is the payload the root process really handles and forwards.
        return send(200, state.stored ? { ...state.stored } : { configured: false });
      }
      if (route === 'POST /api/claude-workbench/v1/internal/maintenance-config') return send(200, {});
      return send(404, { ok: false, error: 'NOT_IMPLEMENTED', route });
    });
  });
  return {
    state,
    async listen() {
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      return `http://127.0.0.1:${server.address().port}`;
    },
    async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); },
  };
}

async function fetchRaw(url, options) {
  const response = await fetch(url, options);
  const text = await response.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch {}
  return { status: response.status, raw: text, body: parsed };
}

async function main() {
  fs.mkdirSync(EVIDENCE, { recursive: true });
  const evidence = {
    caseId: 'SYS-003', lane: 'P-LIFECYCLE-EVIDENCE-R48', startedAt: new Date().toISOString(),
    secretMarker: SECRET.replace(/[a-zA-Z0-9]/g, (c, i) => (i < 8 ? c : '*')),
    isolation: { laneTmp: lane.laneTmp, evidenceRoot: lane.evidenceRoot, env: lane.envIsolationResolved },
    identity: {
      serverAppSha256: sha256(path.join(ROOT, '_site', 'lib', 'server-app.js')),
      moduleBridgeSha256: sha256(path.join(ROOT, '_site', 'lib', 'module-bridge.js')),
      uiProductSha256: sha256(path.join(ROOT, 'ui', 'product.js')),
    },
    responses: [], fakeTerminal: null,
  };
  const everyRawBody = [];
  const record = (label, result) => {
    evidence.responses.push({ label, status: result.status, raw: result.raw });
    everyRawBody.push({ label, raw: result.raw });
    return result;
  };

  const fake = startFakeTerminal();
  let serverHandle = null;
  try {
    const fakeUrl = await fake.listen();
    const port = await freePort();
    serverHandle = spawnServer({
      root: ROOT, port, tag: 'qa-r48-sys003',
      extraEnv: { KB_TERMINAL_URL: fakeUrl },
    });
    evidence.server = { pid: serverHandle.child.pid, port, dataDir: serverHandle.dataDir, fakeTerminalUrl: fakeUrl };

    let stdout = ''; let stderr = '';
    serverHandle.child.stdout.on('data', c => { stdout += c; });
    serverHandle.child.stderr.on('data', c => { stderr += c; });
    evidence.serverStdioCapture = true;

    const base = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 30000;
    let healthy = false;
    while (Date.now() < deadline) {
      try { const r = await fetch(`${base}/api/health`); if (r.ok) { healthy = true; break; } } catch {}
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    assert.ok(healthy, 'isolated root server did not become healthy within 30s');

    // (1) first save with the fake credential — exactly the UI payload shape
    const put1 = record('put-initial', await fetchRaw(`${base}/api/terminal/embedding-config`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'minimax', model: 'embo-01', endpoint: 'https://fake.invalid/v1', profileId: null, secret: SECRET }),
    }));
    assert.equal(put1.status, 200, `initial PUT failed: ${put1.raw}`);
    assert.equal(put1.body.ok, true, 'initial PUT not accepted by the module');
    assert.equal(fake.state.received.length, 1, 'the proxy must deliver the PUT exactly once');
    assert.equal(fake.state.received[0].body.secret, SECRET, 'the proxy must transport the secret verbatim (faithful passthrough)');
    assert.equal(fake.state.stored.secret, SECRET, 'module stand-in stored the credential');

    // (2) masked read — the metadata surface the real UI renders
    const get1 = record('get-masked-after-initial', await fetchRaw(`${base}/api/terminal/embedding-config`));
    assert.equal(get1.status, 200);
    assert.equal(get1.body.configured, true, 'configured must be true with a stored credential');
    assert.deepEqual(Object.keys(get1.body.config).sort(), ['endpoint', 'model', 'profileId', 'provider'], 'GET must expose mask metadata fields only');
    assert.ok(!get1.raw.includes(SECRET), 'LEAK: masked GET response contains the secret');

    // (3) blank save — the exact payload the real UI sends when the field is left blank
    const put2 = record('put-blank', await fetchRaw(`${base}/api/terminal/embedding-config`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'minimax', model: 'embo-01', endpoint: 'https://fake.invalid/v1', profileId: null, secret: '' }),
    }));
    assert.equal(put2.status, 200, `blank PUT failed: ${put2.raw}`);
    assert.equal(fake.state.received[1].body.secret, '', "blank save must arrive at the module as '' (the UI contract payload)");
    assert.equal(fake.state.stored.secret, SECRET, '留空不覆盖: the module stand-in kept the previous credential after a blank save');

    // (4) masked read again — still configured, still no secret
    const get2 = record('get-masked-after-blank', await fetchRaw(`${base}/api/terminal/embedding-config`));
    assert.equal(get2.body.configured, true, 'credential must remain configured after the blank save');
    assert.equal(get2.body.config.provider, 'minimax');
    assert.ok(!get2.raw.includes(SECRET), 'LEAK: post-blank GET response contains the secret');

    // (5) real configure flow: the root pulls the resolved (secret-bearing)
    // internal config and applies modules; the public status must stay clean
    const configure = record('post-modules-configure', await fetchRaw(`${base}/api/modules/configure`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    }));
    assert.equal(configure.status, 200, `configure failed: ${configure.raw}`);
    assert.ok(fake.state.internalPulls >= 1, 'the root really pulled the internal embedding config (secret transited the root process)');
    assert.ok(!configure.raw.includes(SECRET), 'LEAK: public configure status contains the secret');

    // (6) browser guard: internal module endpoints are not browser-reachable
    const guard = record('get-terminal-internal-guard', await fetchRaw(`${base}/api/terminal/internal/embedding-config`));
    assert.equal(guard.status, 403, `internal endpoint must be 403 to browsers, got ${guard.status}`);

    // (7) no secret in ANY captured response body
    const leakedResponses = everyRawBody.filter(entry => entry.raw.includes(SECRET)).map(entry => entry.label);
    assert.deepEqual(leakedResponses, [], 'LEAK: secret present in response bodies');

    // (8) no secret in the root server's own log files (scan BEFORE cleanup
    // deletes dataDir) nor in its stdout/stderr
    const logFiles = [];
    const walk = dir => {
      if (!fs.existsSync(dir)) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const absolute = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(absolute);
        else logFiles.push(absolute);
      }
    };
    walk(path.join(serverHandle.dataDir, 'logs'));
    const leakedLogs = [];
    const logManifest = [];
    for (const file of logFiles) {
      const text = fs.readFileSync(file, 'utf8');
      if (text.includes(SECRET)) leakedLogs.push(path.relative(serverHandle.dataDir, file));
      logManifest.push({ file: path.relative(serverHandle.dataDir, file), bytes: fs.statSync(file).size, sha256: sha256(file) });
    }
    evidence.logScan = { filesScanned: logFiles.length, leakedLogs, manifest: logManifest };
    assert.deepEqual(leakedLogs, [], 'LEAK: secret present in root-server log files');
    assert.ok(!stdout.includes(SECRET) && !stderr.includes(SECRET), 'LEAK: secret present in server stdout/stderr');
    evidence.serverStdioSecretFree = true;

    evidence.fakeTerminal = {
      receivedPuts: fake.state.received.map(r => ({ secretWasBlank: r.body.secret === '', secretWasMarker: r.body.secret === SECRET, provider: r.body.provider })),
      internalPulls: fake.state.internalPulls,
      storedSecretIsMarker: fake.state.stored.secret === SECRET,
      moduleContractStandIn: '留空不覆盖 + masked GET are implemented by this OWN fake per the documented WB contract; real WB 0.13.9 bytes NOT exercised',
    };
    evidence.verdict = {
      '留空不覆盖 (transport + documented module contract)': `PASS - blank '' PUT transported verbatim through the real proxy; module stand-in kept the credential; masked GET still configured`,
      '响应不泄露secret': `PASS - ${everyRawBody.length} captured response bodies (PUT/GET/configure/guard) all secret-free`,
      '日志不泄露secret': `PASS - ${logFiles.length} root-server log files + stdout/stderr all secret-free`,
      'browser-guard': 'PASS - /api/terminal/internal/* answered 403 through the real server',
      boundary: 'module-side storage semantics are the fake stand-in per documented contract; root-transport/masking/guard/log assertions are real product behaviour at this HEAD',
    };
    fs.writeFileSync(path.join(EVIDENCE, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
    console.log('QA-R48 SYS-003 BLANK-SECRET PASS');
    process.exitCode = 0;
  } catch (error) {
    evidence.verdict = { failed: String((error && error.stack) || error) };
    try { fs.writeFileSync(path.join(EVIDENCE, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n'); } catch {}
    console.error(`QA-R48 SYS-003 BLANK-SECRET FAIL: ${error.message}`);
    process.exitCode = 1;
  } finally {
    try { await serverHandle?.cleanup(); } catch {}
    try { await fake.close(); } catch {}
    lane.cleanup();
  }
}

main();
