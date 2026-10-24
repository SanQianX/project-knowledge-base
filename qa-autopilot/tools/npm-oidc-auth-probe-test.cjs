'use strict';
// Offline synthetic self-test for npm-oidc-auth-probe.cjs.
// Mocked transport only: no network, no registry, no npm, no credential file.
// Run: node qa-autopilot/tools/npm-oidc-auth-probe-test.cjs

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const probeModule = require('./npm-oidc-auth-probe.cjs');

const CORE = probeModule.CORE_PACKAGE;
const DESKTOP = probeModule.DESKTOP_PACKAGE;

const FAKE_ID_TOKEN = 'eyJhbGciOiJSUzI1NiJ9.fake-id-token-payload.fake-signature';
const FAKE_REQUEST_TOKEN = 'ghs_fake_actions_request_token';
const FAKE_REGISTRY_TOKEN = 'npm_FAKEregistrytoken_do_not_leak_0123456789';
const RAW_BODY_MESSAGE = 'OIDC token exchange error - package not found';

const RUNNER_ENV = {
  GITHUB_REPOSITORY: 'SanQianX/project-knowledge-base',
  GITHUB_WORKFLOW_REF: 'SanQianX/project-knowledge-base/.github/workflows/publish.yml@refs/heads/main',
  ACTIONS_ID_TOKEN_REQUEST_URL: 'https://pipelines.actions.githubusercontent.com/_apis/oidc',
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: FAKE_REQUEST_TOKEN,
};

function makeFetch(responses) {
  const calls = [];
  const impl = async (url, options) => {
    calls.push({ url: String(url), options: options || {} });
    const next = responses.shift();
    if (!next) throw new Error('unexpected request');
    if (next.throws) throw new Error(next.throws);
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      json: async () => { if (next.bodyThrows) throw new Error('invalid json'); return next.body; },
    };
  };
  impl.calls = calls;
  return impl;
}

function okIdToken() { return { status: 200, body: { value: FAKE_ID_TOKEN } }; }
function okExchange() { return { status: 200, body: { token: FAKE_REGISTRY_TOKEN } }; }

async function withEnv(vars, fn) {
  const saved = {};
  for (const [key, value] of Object.entries(vars)) { saved[key] = process.env[key]; process.env[key] = value; }
  try { return await fn(); } finally { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
}

async function captureStdout(fn) {
  const original = process.stdout.write.bind(process.stdout);
  let captured = '';
  process.stdout.write = (chunk, ...rest) => { captured += String(chunk); return true; };
  try { const code = await fn(); return { code, stdout: captured }; } finally { process.stdout.write = original; }
}

function tempDir(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

// ---- allowlist and identity ---------------------------------------------------

test('a freeform package target is rejected before any request', async () => {
  const fetchImpl = makeFetch([]);
  const { exitCode, receipt } = await probeModule.probe({ packageName: 'some-other-package', env: RUNNER_ENV, fetchImpl });
  assert.strictEqual(exitCode, probeModule.EXIT.USAGE);
  assert.strictEqual(receipt.errorCode, 'EALLOWLIST');
  assert.strictEqual(receipt.package, null, 'a rejected target must not be echoed into the receipt');
  assert.strictEqual(fetchImpl.calls.length, 0, 'no request may leave the allowlist check');
});

test('a URL-like or scope-escaping target is rejected before any request', async () => {
  for (const target of ['https://registry.npmjs.org/-/npm/v1/oidc/token/exchange/package/x', '@sanqianx/../evil', '@sanqianx/project-knowledge@5.0.25', '']) {
    const fetchImpl = makeFetch([]);
    const { exitCode, receipt } = await probeModule.probe({ packageName: target, env: RUNNER_ENV, fetchImpl });
    assert.strictEqual(receipt.errorCode, 'EALLOWLIST', 'target must be rejected: ' + target);
    assert.strictEqual(exitCode, probeModule.EXIT.USAGE);
    assert.strictEqual(fetchImpl.calls.length, 0);
  }
});

test('both approved packages are accepted by the allowlist', async () => {
  assert.deepStrictEqual([...probeModule.ALLOWED_PACKAGES], [CORE, DESKTOP]);
  assert.strictEqual(probeModule.isAllowedPackage(CORE), true);
  assert.strictEqual(probeModule.isAllowedPackage(DESKTOP), true);
});

test('a foreign repository or another workflow file is refused', async () => {
  for (const env of [
    { ...RUNNER_ENV, GITHUB_REPOSITORY: 'SanQianX/other-repo' },
    { ...RUNNER_ENV, GITHUB_WORKFLOW_REF: 'SanQianX/project-knowledge-base/.github/workflows/other.yml@refs/heads/main' },
    { ...RUNNER_ENV, GITHUB_WORKFLOW_REF: '' },
  ]) {
    const fetchImpl = makeFetch([]);
    const { exitCode, receipt } = await probeModule.probe({ packageName: CORE, env, fetchImpl });
    assert.strictEqual(receipt.errorCode, 'ECIDENTITY');
    assert.strictEqual(exitCode, probeModule.EXIT.USAGE);
    assert.strictEqual(fetchImpl.calls.length, 0);
  }
});

// ---- missing GitHub identity --------------------------------------------------

test('a missing GitHub OIDC token fails closed without any request', async () => {
  for (const env of [
    { ...RUNNER_ENV, ACTIONS_ID_TOKEN_REQUEST_URL: undefined },
    { ...RUNNER_ENV, ACTIONS_ID_TOKEN_REQUEST_TOKEN: undefined },
    { ...RUNNER_ENV, ACTIONS_ID_TOKEN_REQUEST_URL: '', ACTIONS_ID_TOKEN_REQUEST_TOKEN: '' },
  ]) {
    const fetchImpl = makeFetch([]);
    const clean = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined));
    const { exitCode, receipt } = await probeModule.probe({ packageName: CORE, env: clean, fetchImpl });
    assert.strictEqual(receipt.errorCode, 'ENOGITHUBTOKEN');
    assert.strictEqual(exitCode, probeModule.EXIT.USAGE);
    assert.strictEqual(fetchImpl.calls.length, 0);
  }
});

test('a non-https or foreign OIDC token URL is refused', async () => {
  for (const url of ['http://pipelines.actions.githubusercontent.com/oidc', 'https://evil.example.com/oidc', 'file:///etc/passwd', 'not a url']) {
    const fetchImpl = makeFetch([]);
    const { exitCode, receipt } = await probeModule.probe({ packageName: CORE, env: { ...RUNNER_ENV, ACTIONS_ID_TOKEN_REQUEST_URL: url }, fetchImpl });
    assert.strictEqual(receipt.errorCode, 'EINVALIDTOKENURL', 'url must be refused: ' + url);
    assert.strictEqual(exitCode, probeModule.EXIT.USAGE);
    assert.strictEqual(fetchImpl.calls.length, 0);
  }
});

// ---- success path -------------------------------------------------------------

test('a successful exchange is reported without leaking the token', async () => {
  const fetchImpl = makeFetch([okIdToken(), okExchange()]);
  const { exitCode, receipt } = await probeModule.probe({ packageName: CORE, env: RUNNER_ENV, fetchImpl });
  assert.strictEqual(exitCode, probeModule.EXIT.OK);
  assert.strictEqual(receipt.success, true);
  assert.strictEqual(receipt.status, 200);
  assert.strictEqual(receipt.errorCode, null);
  const serialized = JSON.stringify(receipt);
  assert.ok(!serialized.includes(FAKE_REGISTRY_TOKEN), 'the registry token must never reach the receipt');
  assert.ok(!serialized.includes(FAKE_ID_TOKEN), 'the id token must never reach the receipt');
  assert.ok(!serialized.includes(FAKE_REQUEST_TOKEN), 'the request token must never reach the receipt');
});

test('the receipt exposes only whitelisted metadata', async () => {
  const fetchImpl = makeFetch([okIdToken(), okExchange()]);
  const { receipt } = await probeModule.probe({ packageName: DESKTOP, env: RUNNER_ENV, fetchImpl });
  assert.deepStrictEqual(Object.keys(receipt).sort(), [...probeModule.RECEIPT_FIELDS].sort());
  assert.strictEqual(receipt.package, DESKTOP);
  assert.ok(!Number.isNaN(Date.parse(receipt.timestamp)), 'timestamp must be a parseable date');
});

test('the exchange request reproduces the npm OIDC protocol exactly', async () => {
  const fetchImpl = makeFetch([okIdToken(), okExchange()]);
  await probeModule.probe({ packageName: CORE, env: RUNNER_ENV, fetchImpl });
  assert.strictEqual(fetchImpl.calls.length, 2);

  const idCall = fetchImpl.calls[0];
  assert.ok(idCall.url.includes('audience=npm%3Aregistry.npmjs.org'), 'the npm audience is required');
  assert.strictEqual(idCall.options.method, 'GET');
  assert.strictEqual(idCall.options.headers.authorization, 'Bearer ' + FAKE_REQUEST_TOKEN);

  const exchange = fetchImpl.calls[1];
  assert.strictEqual(exchange.url, 'https://registry.npmjs.org/-/npm/v1/oidc/token/exchange/package/@sanqianx%2fproject-knowledge');
  assert.strictEqual(exchange.options.method, 'POST');
  assert.strictEqual(exchange.options.body, undefined, 'npm sends no body on the exchange');
  assert.strictEqual(exchange.options.headers.authorization, 'Bearer ' + FAKE_ID_TOKEN);
  assert.strictEqual(exchange.options.redirect, 'manual');
});

test('the desktop package uses its own escaped exchange path', async () => {
  const fetchImpl = makeFetch([okIdToken(), okExchange()]);
  await probeModule.probe({ packageName: DESKTOP, env: RUNNER_ENV, fetchImpl });
  assert.strictEqual(fetchImpl.calls[1].url, 'https://registry.npmjs.org/-/npm/v1/oidc/token/exchange/package/@sanqianx%2fproject-knowledge-desktop');
  assert.strictEqual(probeModule.escapePackageName(CORE), '@sanqianx%2fproject-knowledge');
});

// ---- registry refusals --------------------------------------------------------

test('a 404 from the exchange is classified and the raw body never appears', async () => {
  const fetchImpl = makeFetch([okIdToken(), { status: 404, body: { error: RAW_BODY_MESSAGE } }]);
  const { exitCode, receipt } = await probeModule.probe({ packageName: CORE, env: RUNNER_ENV, fetchImpl });
  assert.strictEqual(exitCode, probeModule.EXIT.NOT_AUTHORIZED);
  assert.strictEqual(receipt.success, false);
  assert.strictEqual(receipt.status, 404);
  assert.strictEqual(receipt.errorCode, 'EREGISTRYNOTFOUND');
  assert.ok(!JSON.stringify(receipt).includes(RAW_BODY_MESSAGE), 'the raw registry body must never be echoed');
});

test('401 and 403 are classified as unauthorized', async () => {
  for (const status of [401, 403]) {
    const fetchImpl = makeFetch([okIdToken(), { status, body: { error: 'nope' } }]);
    const { exitCode, receipt } = await probeModule.probe({ packageName: CORE, env: RUNNER_ENV, fetchImpl });
    assert.strictEqual(receipt.errorCode, 'EREGISTRYUNAUTHORIZED');
    assert.strictEqual(exitCode, probeModule.EXIT.NOT_AUTHORIZED);
    assert.strictEqual(receipt.success, false);
  }
});

test('a 200 without a token is not treated as success', async () => {
  const fetchImpl = makeFetch([okIdToken(), { status: 200, body: { token: null } }]);
  const { exitCode, receipt } = await probeModule.probe({ packageName: CORE, env: RUNNER_ENV, fetchImpl });
  assert.strictEqual(receipt.errorCode, 'EREGISTRYTOKENMISSING');
  assert.strictEqual(receipt.success, false);
  assert.strictEqual(exitCode, probeModule.EXIT.NOT_AUTHORIZED);
});

test('a redirect is refused instead of followed', async () => {
  const fetchImpl = makeFetch([okIdToken(), { status: 302, body: {} }]);
  const { exitCode, receipt } = await probeModule.probe({ packageName: CORE, env: RUNNER_ENV, fetchImpl });
  assert.strictEqual(receipt.errorCode, 'EREGISTRYREDIRECT');
  assert.strictEqual(receipt.success, false);
  assert.strictEqual(exitCode, probeModule.EXIT.NOT_AUTHORIZED);
  assert.strictEqual(fetchImpl.calls.length, 2, 'no redirect target may be requested');
});

test('a GitHub id-token failure stops before the exchange', async () => {
  for (const response of [{ status: 500, body: {} }, { status: 200, body: {} }, { status: 200, body: { value: '' } }]) {
    const fetchImpl = makeFetch([response]);
    const { exitCode, receipt } = await probeModule.probe({ packageName: CORE, env: RUNNER_ENV, fetchImpl });
    assert.strictEqual(receipt.errorCode, 'EGITHUBTOKEN');
    assert.strictEqual(exitCode, probeModule.EXIT.NETWORK);
    assert.strictEqual(fetchImpl.calls.length, 1, 'the exchange must not run without an id token');
  }
});

test('a transport failure is classified as a network error', async () => {
  const fetchImpl = makeFetch([{ throws: 'socket hang up' }]);
  const { exitCode, receipt } = await probeModule.probe({ packageName: CORE, env: RUNNER_ENV, fetchImpl });
  assert.strictEqual(receipt.errorCode, 'ENETWORK');
  assert.strictEqual(exitCode, probeModule.EXIT.NETWORK);
  assert.ok(!JSON.stringify(receipt).includes('socket hang up'), 'raw transport errors must not be echoed');
});

test('every request carries a bounded timeout signal', async () => {
  const fetchImpl = makeFetch([okIdToken(), okExchange()]);
  await probeModule.probe({ packageName: CORE, env: RUNNER_ENV, fetchImpl, timeoutMs: 1234 });
  for (const call of fetchImpl.calls) {
    assert.ok(call.options.signal, 'each request must carry an abort signal');
    assert.strictEqual(typeof call.options.signal.aborted, 'boolean');
  }
});

// ---- CLI behaviour (offline) --------------------------------------------------

test('the CLI fails closed offline and writes no npm credential config', () => {
  const home = tempDir('oidc-probe-home-');
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: home, USERPROFILE: home };
  const result = spawnSync(process.execPath, [path.join(__dirname, 'npm-oidc-auth-probe.cjs'), '--package', CORE], { env, encoding: 'utf8', windowsHide: true, timeout: 30000 });
  assert.strictEqual(result.status, 2, 'the CLI must exit nonzero');
  const receipt = JSON.parse(result.stdout.trim());
  assert.strictEqual(receipt.errorCode, 'ECIDENTITY', 'outside the approved runner the probe must refuse');
  assert.deepStrictEqual(Object.keys(receipt).sort(), [...probeModule.RECEIPT_FIELDS].sort());
  assert.deepStrictEqual(fs.readdirSync(home), [], 'no credential file may be created');
});

test('the CLI writes a metadata-only receipt file and never leaks the token', async () => {
  const dir = tempDir('oidc-probe-receipt-');
  const receiptFile = path.join(dir, 'receipt.json');
  const originalFetch = globalThis.fetch;
  globalThis.fetch = makeFetch([okIdToken(), okExchange()]);
  let captured;
  try {
    captured = await withEnv(RUNNER_ENV, () => captureStdout(() => probeModule.main(['--package', CORE, '--receipt', receiptFile])));
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.strictEqual(captured.code, probeModule.EXIT.OK);
  assert.ok(!captured.stdout.includes(FAKE_REGISTRY_TOKEN), 'the registry token must never reach stdout');
  assert.ok(!captured.stdout.includes(FAKE_ID_TOKEN), 'the id token must never reach stdout');
  const written = fs.readFileSync(receiptFile, 'utf8');
  assert.ok(!written.includes(FAKE_REGISTRY_TOKEN), 'the registry token must never reach the receipt file');
  assert.ok(!written.includes(FAKE_ID_TOKEN), 'the id token must never reach the receipt file');
  const parsed = JSON.parse(written);
  assert.deepStrictEqual(Object.keys(parsed).sort(), [...probeModule.RECEIPT_FIELDS].sort());
  assert.strictEqual(parsed.success, true);
});

test('the probe source contains no publish, dist-tag or credential write path', () => {
  const source = fs.readFileSync(path.join(__dirname, 'npm-oidc-auth-probe.cjs'), 'utf8');
  const code = source.split('\n').filter(line => !line.trim().startsWith('//')).join('\n');
  for (const forbidden of ['npm publish', 'dist-tag', 'npm access', 'npm login', 'npmrc', 'NODE_AUTH_TOKEN', 'NPM_TOKEN']) {
    assert.ok(!code.includes(forbidden), 'the probe must not contain: ' + forbidden);
  }
});
