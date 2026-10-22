'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const {
  resolveCoreRoot, versionState, waitForHttpReady,
  isAllowedNavigation, isAllowedExternalUrl, endpointUrl,
} = require('../lib/backend-runtime.cjs');

(async () => {
  // resolveCoreRoot happy path: a non-empty path pointing at the installed
  // core package root (its package.json lives right there).
  {
    const coreRoot = resolveCoreRoot();
    assert.equal(typeof coreRoot, 'string');
    assert.ok(coreRoot.length > 0);
    assert.ok(fs.existsSync(path.join(coreRoot, 'package.json')), 'core root must be the project-knowledge package directory');
    const corePackage = require(path.join(coreRoot, 'package.json'));
    assert.equal(corePackage.version, require('../package.json').dependencies['@sanqianx/project-knowledge'], 'resolved core must match the desktop dependency pin');
  }
  // resolveCoreRoot failure path: with module resolution patched so the core
  // package cannot be found (temp-dir isolation alone is not enough on
  // machines with a user-level node_modules), an isolated copy must fail with
  // DESKTOP_CORE_MISSING.
  {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-desktop-core-missing-'));
    fs.copyFileSync(path.join(__dirname, '..', 'lib', 'backend-runtime.cjs'), path.join(sandbox, 'backend-runtime.cjs'));
    const Module = require('node:module');
    const originalResolveFilename = Module._resolveFilename;
    Module._resolveFilename = function (request, ...rest) {
      if (String(request).includes('project-knowledge')) {
        throw Object.assign(new Error(`Cannot find module '${request}'`), { code: 'MODULE_NOT_FOUND' });
      }
      return originalResolveFilename.call(this, request, ...rest);
    };
    try {
      const isolated = require(path.join(sandbox, 'backend-runtime.cjs'));
      assert.throws(() => isolated.resolveCoreRoot(), error => error.code === 'DESKTOP_CORE_MISSING');
    } finally {
      Module._resolveFilename = originalResolveFilename;
    }
  }
  // versionState: match / unknown (falsy instance version) / mismatch.
  assert.equal(versionState('5.0.17', '5.0.17'), 'match');
  assert.equal(versionState('5.0.17', undefined), 'unknown');
  assert.equal(versionState('5.0.17', ''), 'unknown');
  assert.equal(versionState('5.0.17', '5.0.18'), 'mismatch');
  // waitForHttpReady success: any HTTP answer (404 here) on /api/state is ready.
  {
    const requested = [];
    const server = http.createServer((req, res) => {
      requested.push(req.url);
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{"error":"not found"}');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    try {
      const ready = await waitForHttpReady({ host: '127.0.0.1', port, timeoutMs: 2000, intervalMs: 20 });
      assert.deepEqual(ready, { host: '127.0.0.1', port });
      assert.ok(requested.includes('/api/state'), `must poll /api/state, saw: ${requested.join(', ')}`);
    } finally {
      server.closeAllConnections?.();
      await new Promise(resolve => server.close(resolve));
    }
  }
  // waitForHttpReady timeout: a network that always errors keeps polling until
  // the deadline instead of surfacing the first fetch failure.
  {
    let calls = 0;
    const fetchImpl = async () => { calls += 1; throw new Error('connection refused'); };
    const startedAt = Date.now();
    await assert.rejects(
      () => waitForHttpReady({ host: '127.0.0.1', port: 59001, timeoutMs: 300, intervalMs: 50, fetchImpl }),
      error => error.code === 'DESKTOP_BACKEND_TIMEOUT',
    );
    assert.ok(calls >= 2, `fetch errors must not abort the wait loop (fetch calls: ${calls})`);
    assert.ok(Date.now() - startedAt >= 290, 'rejection must come from the timeout, not the first error');
  }
  // isAllowedNavigation: same-origin only, hostile look-alikes and garbage rejected.
  {
    const endpoint = { host: '127.0.0.1', port: 5757 };
    assert.equal(isAllowedNavigation('http://127.0.0.1:5757/index.html', endpoint), true);
    assert.equal(isAllowedNavigation('http://127.0.0.1:5757/api/state?x=1', endpoint), true);
    assert.equal(isAllowedNavigation('http://127.0.0.1:5758/index.html', endpoint), false, 'different port is a different origin');
    assert.equal(isAllowedNavigation('http://localhost:5757/index.html', endpoint), false, 'different host is a different origin');
    assert.equal(isAllowedNavigation('https://127.0.0.1:5757/index.html', endpoint), false, 'different scheme is a different origin');
    assert.equal(isAllowedNavigation('http://127.0.0.1:5757.attacker.example/', endpoint), false, 'host-suffix look-alikes must not pass');
    assert.equal(isAllowedNavigation('not a url', endpoint), false);
  }
  // isAllowedExternalUrl: only http(s) may be handed to the system browser.
  assert.equal(isAllowedExternalUrl('https://github.com/sanqianx/example/releases'), true);
  assert.equal(isAllowedExternalUrl('http://example.com/page'), true);
  assert.equal(isAllowedExternalUrl('file:///C:/Windows/system.ini'), false);
  assert.equal(isAllowedExternalUrl('javascript:alert(1)'), false);
  // endpointUrl
  assert.equal(endpointUrl({ host: '127.0.0.1', port: 5757 }), 'http://127.0.0.1:5757');
  console.log('backend runtime test PASS');
})().catch(error => { console.error(error); process.exitCode = 1; });
