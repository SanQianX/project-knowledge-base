'use strict';
// R10/R12 slow-startup unit tests for the desktop backend-runtime readiness
// primitives. Contract under test: a live-but-slow process is STARTING
// (progress + patience), a dead process is a definitive failure surfaced
// immediately, and semantic control refusals are never retried.
//
// R12 additions (both PRIORITY-2 boundary fixes), each race-protected so the
// pre-fix code fails loudly instead of hanging the suite:
//   - waitForHttpReadyGuarded: every fetch attempt is bounded; a hung request
//     plus a dead child fails fast (EXITED), a hung request with a live child
//     keeps progressing and ends as STILL_STARTING at the deadline, an outer
//     cancel aborts cleanly, and an eventual answer still succeeds.
//   - bin/project-knowledge.js test surface (require.main guard + exports):
//     parsePatienceMs clamps and waitForStartup honors a patience deadline
//     below the first 45s checkpoint with a typed still-starting error.
// The driver hardens its own env at START (R12 isolation contract).
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createHarness } = require('./slow-startup-env.cjs');

const harness = createHarness('unit');
const {
  waitForHttpReady,
  isRetryableControlError,
  waitForBackendEndpoint,
  waitForHttpReadyGuarded,
  waitForInstanceControl,
} = require('../lib/backend-runtime.cjs');

const BIN = path.resolve(__dirname, '..', '..', 'bin', 'project-knowledge.js');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const withRace = (p, ms = 8000) => Promise.race([
  p.then(v => ({ ok: v }), e => ({ err: e })),
  sleep(ms).then(() => ({ timeout: true })),
]);
// Emulates undici for the abort path: never settles on its own, rejects with
// an AbortError as soon as the caller's signal fires.
const neverSettlingFetch = (_url, { signal } = {}) => new Promise((_, reject) => {
  if (signal) signal.addEventListener('abort', () => reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })), { once: true });
});

(async () => {
  let unhandled = 0;
  process.on('unhandledRejection', () => { unhandled += 1; });
  const failures = [];
  const check = (name, fn) => fn().catch(error => { failures.push({ name, error: error.message }); });

  // isRetryableControlError: budget timeouts / disconnects retry; coded
  // transport errors and semantic refusals do not.
  assert.equal(isRetryableControlError(Object.assign(new Error('知识库控制请求超时，停止尚未确认。'), {})), true);
  assert.equal(isRetryableControlError(new Error('实例断开连接，停止尚未确认。')), true);
  assert.equal(isRetryableControlError(Object.assign(new Error('x'), { code: 'ETIMEDOUT' })), true);
  assert.equal(isRetryableControlError(Object.assign(new Error('x'), { code: 'ECONNREFUSED' })), false);
  assert.equal(isRetryableControlError(new Error('实例身份不匹配，已拒绝控制。')), false, 'semantic refusals must surface immediately');
  assert.equal(isRetryableControlError(null), false);

  // waitForBackendEndpoint: publication with our PID.
  {
    const endpoint = { pid: 4242, host: '127.0.0.1', port: 5900 };
    const result = await waitForBackendEndpoint({ readEndpoint: () => endpoint, ownedPid: 4242, timeoutMs: 500 });
    assert.deepEqual(result, { status: 'endpoint', endpoint });
  }
  // Foreign live PID wins the file: 'taken', never treated as our backend.
  {
    const result = await waitForBackendEndpoint({ readEndpoint: () => ({ pid: 999, host: '127.0.0.1', port: 5900 }), ownedPid: 4242, timeoutMs: 500 });
    assert.equal(result.status, 'taken');
  }
  // Child dies before publishing: definitive 'exited' without burning the budget.
  {
    const started = Date.now();
    let alive = true;
    const pending = waitForBackendEndpoint({ readEndpoint: () => null, ownedPid: 1, isAlive: () => alive, timeoutMs: 5000, intervalMs: 20 });
    await sleep(80); alive = false;
    const result = await pending;
    assert.equal(result.status, 'exited');
    assert.ok(Date.now() - started < 2000, 'exit must fail fast, not at the deadline');
  }
  // Alive, nothing published, deadline reached: honest 'timeout' (STARTING).
  {
    const result = await waitForBackendEndpoint({ readEndpoint: () => null, isAlive: () => true, timeoutMs: 150, intervalMs: 20 });
    assert.equal(result.status, 'timeout');
    assert.ok(result.elapsedMs >= 140);
  }

  // waitForHttpReadyGuarded: any sub-500 answer is ready.
  {
    const server = http.createServer((_req, res) => { res.writeHead(404); res.end(); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    try {
      const ready = await waitForHttpReadyGuarded({ host: '127.0.0.1', port, timeoutMs: 2000, intervalMs: 20 });
      assert.deepEqual(ready, { host: '127.0.0.1', port });
    } finally { server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)); }
  }
  // Slow success: the answer arrives after the old fixed budget would have
  // declared failure — guarded waiting must still succeed while alive.
  {
    const server = http.createServer((_req, res) => { res.writeHead(503); res.end(); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    try {
      const pending = waitForHttpReadyGuarded({ host: '127.0.0.1', port, timeoutMs: 1000, intervalMs: 20, isAlive: () => true });
      setTimeout(() => { server.removeAllListeners('request'); server.on('request', (_req, res) => { res.writeHead(200); res.end(); }); }, 600);
      const ready = await pending;
      assert.equal(ready.port, port);
    } finally { server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)); }
  }
  // Child dies mid-wait: definitive DESKTOP_BACKEND_EXITED, fast.
  {
    let alive = true;
    const started = Date.now();
    const pending = waitForHttpReadyGuarded({
      host: '127.0.0.1', port: 59901, timeoutMs: 5000, intervalMs: 20, fetchImpl: async () => { throw new Error('connection refused'); },
      isAlive: () => alive,
    });
    await sleep(120); alive = false;
    await assert.rejects(() => pending, error => error.code === 'DESKTOP_BACKEND_EXITED');
    assert.ok(Date.now() - started < 2000, 'dead child must fail fast');
  }
  // Alive but silent at the deadline: DESKTOP_BACKEND_STILL_STARTING, never
  // the old blanket DESKTOP_BACKEND_TIMEOUT for an owned child.
  {
    await assert.rejects(
      () => waitForHttpReadyGuarded({ host: '127.0.0.1', port: 59901, timeoutMs: 150, intervalMs: 20, fetchImpl: async () => { throw new Error('connection refused'); }, isAlive: () => true }),
      error => error.code === 'DESKTOP_BACKEND_STILL_STARTING' && /存活/.test(error.message),
    );
  }
  // Legacy waitForHttpReady contract unchanged for callers without liveness.
  {
    await assert.rejects(
      () => waitForHttpReady({ host: '127.0.0.1', port: 59901, timeoutMs: 120, intervalMs: 20, fetchImpl: async () => { throw new Error('connection refused'); } }),
      error => error.code === 'DESKTOP_BACKEND_TIMEOUT',
    );
  }

  // waitForInstanceControl: busy window survived by retrying (probe times out
  // twice, then answers) — the exact false-failure shape from the field.
  {
    let calls = 0;
    const instance = { pid: 777, host: '127.0.0.1', port: 5901, version: '5.0.24' };
    const result = await waitForInstanceControl({
      probe: async () => { calls += 1; if (calls < 3) throw Object.assign(new Error('知识库控制请求超时，停止尚未确认。'), {}); return instance; },
      endpoint: { pid: 777 },
      isAlive: () => true,
      timeoutMs: 5000,
      intervalMs: 10,
    });
    assert.equal(result.status, 'answered');
    assert.equal(result.instance.pid, 777);
    assert.ok(calls >= 3);
  }
  // PID dies while probing: 'gone' (the launcher may then try to own the dir).
  {
    let alive = true;
    const pending = waitForInstanceControl({
      probe: async () => { throw Object.assign(new Error('知识库控制请求超时，停止尚未确认。'), {}); },
      endpoint: { pid: 777 },
      isAlive: () => alive,
      timeoutMs: 5000,
      intervalMs: 10,
    });
    await sleep(80); alive = false;
    assert.equal((await pending).status, 'gone');
  }
  // Semantic refusal surfaces immediately, no retry burn.
  {
    const started = Date.now();
    const result = await waitForInstanceControl({
      probe: async () => { throw new Error('实例身份不匹配，已拒绝控制。'); },
      endpoint: { pid: 777 },
      isAlive: () => true,
      timeoutMs: 5000,
      intervalMs: 10,
    });
    assert.equal(result.status, 'refused');
    assert.ok(Date.now() - started < 1000);
  }
  // Patience exceeded with PID alive: honest 'busy', never a failure claim.
  {
    const result = await waitForInstanceControl({
      probe: async () => null,
      endpoint: { pid: 777 },
      isAlive: () => true,
      timeoutMs: 120,
      intervalMs: 10,
    });
    assert.equal(result.status, 'busy');
    assert.ok(result.elapsedMs >= 110);
  }

  // ---- R12 fix 2: bounded per-request fetch in waitForHttpReadyGuarded ----

  // Hung request + child dies mid-attempt: EXITED fast, not at a fetch that
  // never settles. (Pre-fix this hangs: the await never returns.)
  await check('guarded-hung-dead-child', async () => {
    let alive = true;
    const started = Date.now();
    const pending = waitForHttpReadyGuarded({
      host: '127.0.0.1', port: 59902, timeoutMs: 5000, intervalMs: 20, requestTimeoutMs: 4000,
      fetchImpl: neverSettlingFetch, isAlive: () => alive,
    });
    await sleep(120); alive = false;
    const outcome = await withRace(pending, 8000);
    assert.ok(!outcome.timeout, 'pre-fix code hangs on a never-settling fetch (red)');
    assert.equal(outcome.err.code, 'DESKTOP_BACKEND_EXITED');
    assert.ok(Date.now() - started < 2500, 'dead child must surface fast even with a hung request');
  });

  // Hung request, child alive: attempts are bounded and retried (progress),
  // deadline reached while alive is STILL_STARTING — never a hidden hang.
  await check('guarded-hung-alive-still-starting', async () => {
    let calls = 0;
    const started = Date.now();
    const outcome = await withRace(waitForHttpReadyGuarded({
      host: '127.0.0.1', port: 59902, timeoutMs: 300, intervalMs: 20, requestTimeoutMs: 100,
      fetchImpl: (u, o) => { calls += 1; return neverSettlingFetch(u, o); },
      isAlive: () => true,
    }), 8000);
    assert.ok(!outcome.timeout, 'pre-fix code hangs on a never-settling fetch (red)');
    assert.equal(outcome.err.code, 'DESKTOP_BACKEND_STILL_STARTING');
    assert.ok(calls >= 2, `bounded attempts must retry, saw ${calls}`);
    assert.ok(Date.now() - started < 3000, 'must surface at the deadline, not minutes later');
  });

  // First attempt hangs, second answers: eventual ready still works.
  await check('guarded-eventual-ready-after-hang', async () => {
    let calls = 0;
    const outcome = await withRace(waitForHttpReadyGuarded({
      host: '127.0.0.1', port: 59902, timeoutMs: 4000, intervalMs: 20, requestTimeoutMs: 120,
      fetchImpl: (u, o) => { calls += 1; return calls === 1 ? neverSettlingFetch(u, o) : Promise.resolve({ status: 200 }); },
      isAlive: () => true,
    }), 8000);
    assert.ok(!outcome.timeout, 'pre-fix code hangs on the first never-settling attempt (red)');
    assert.deepEqual(outcome.ok, { host: '127.0.0.1', port: 59902 });
  });

  // Outer cancel aborts the in-flight wait cleanly.
  await check('guarded-outer-cancel', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const outcome = await withRace(waitForHttpReadyGuarded({
      host: '127.0.0.1', port: 59902, timeoutMs: 5000, intervalMs: 20, requestTimeoutMs: 4000,
      fetchImpl: neverSettlingFetch, isAlive: () => true, signal: controller.signal,
    }), 8000);
    assert.ok(!outcome.timeout, 'cancel path hung (red)');
    assert.equal(outcome.err.code, 'DESKTOP_WAIT_CANCELLED');
  });

  // REAL hung server (accepts the socket, never responds) with real fetch:
  // bounded attempts against the real network stack.
  await check('guarded-real-hung-server', async () => {
    const sockets = new Set();
    const server = net.createServer(socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    if (harness.protectedPorts.includes(port)) { server.close(); return; }
    let calls = 0;
    try {
      const outcome = await withRace(waitForHttpReadyGuarded({
        host: '127.0.0.1', port, timeoutMs: 400, intervalMs: 20, requestTimeoutMs: 120,
        fetchImpl: (u, o) => { calls += 1; return fetch(u, o); },
        isAlive: () => true,
      }), 8000);
      assert.ok(!outcome.timeout, 'pre-fix code waits on the real hung socket forever (red)');
      assert.equal(outcome.err.code, 'DESKTOP_BACKEND_STILL_STARTING');
      assert.ok(calls >= 2, `real hung server must see bounded retries, saw ${calls}`);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => server.close(resolve));
    }
  });

  // ---- R12 fix 1: bin launcher test surface (require.main guard + exports) ----
  // Pre-fix bin executes main() on require, so the probe only runs when the
  // guard is present in the source (checked as text, never by requiring).
  const binSource = fs.readFileSync(BIN, 'utf8');
  if (!/require\.main\s*===?\s*module/.test(binSource)) {
    failures.push({ name: 'bin-test-surface', error: 'bin/project-knowledge.js has no require.main guard; waitForStartup/parsePatienceMs are not exported (red: unit surface unavailable, deadline-below-checkpoint unobservable)' });
  } else {
    await check('bin-unit-surface', async () => {
      const probe = `
        const assert = require('node:assert/strict');
        const EventEmitter = require('node:events');
        const { waitForStartup, parsePatienceMs } = require(${JSON.stringify(BIN)});
        (async () => {
        assert.equal(typeof waitForStartup, 'function');
        assert.equal(parsePatienceMs('1200', 60000), 1200);
        assert.equal(parsePatienceMs(undefined, 250000), 250000);
        for (const bad of ['0', '-5', 'abc', '', 'Infinity', 'NaN']) assert.equal(parsePatienceMs(bad, 60000), 60000, bad);
        assert.equal(parsePatienceMs('99999999999', 60000), 3600000);
        const fakeChild = () => Object.assign(new EventEmitter(), { exitCode: null, connected: true, disconnect() { this.connected = false; } });
        { // patience below the first checkpoint: typed still-starting, fast
          const child = fakeChild();
          const started = Date.now();
          await assert.rejects(
            () => waitForStartup(child, 'x.log', { initialBudgetMs: 100, progressIntervalMs: 80, patienceMs: 260 }),
            error => error.code === 'KB_STARTUP_STILL_STARTING' && /未判定失败/.test(error.message),
          );
          assert.ok(Date.now() - started < 2000, 'deadline must fire at the patience cap, not the 45s checkpoint');
        }
        { // delayed ready between checkpoint and patience: resolves with the message
          const child = fakeChild();
          setTimeout(() => child.emit('message', { type: 'kb:launcher-ready', url: 'http://127.0.0.1:1' }), 160);
          const ready = await waitForStartup(child, 'x.log', { initialBudgetMs: 80, progressIntervalMs: 80, patienceMs: 2000 });
          assert.equal(ready.url, 'http://127.0.0.1:1');
        }
        { // child exit stays definitive
          const child = fakeChild();
          setTimeout(() => child.emit('exit', 1), 60);
          await assert.rejects(() => waitForStartup(child, 'x.log', { initialBudgetMs: 80, patienceMs: 5000 }), /退出/);
        }
        console.log('BIN_PROBE_PASS');
        })().catch(error => { console.error(error); process.exit(1); });
      `;
      const result = await new Promise((resolve) => {
        const child = spawn(process.execPath, ['-e', probe], { env: harness.nodeEnv({}), windowsHide: true });
        let out = '', err = '';
        child.stdout.on('data', d => { out += d; });
        child.stderr.on('data', d => { err += d; });
        const timer = setTimeout(() => { try { child.kill(); } catch {} resolve({ timeout: true, out, err }); }, 15000);
        child.once('exit', code => { clearTimeout(timer); resolve({ code, out, err }); });
      });
      assert.ok(!result.timeout, 'bin probe timed out: ' + (result.out + result.err).slice(-500));
      assert.equal(result.code, 0, 'bin unit probe failed: ' + (result.out + result.err).slice(-800));
      assert.ok(/BIN_PROBE_PASS/.test(result.out));
    });
  }

  assert.equal(unhandled, 0, 'no unhandled rejections across the suite');
  if (failures.length) {
    for (const failure of failures) console.error(`R12-CASE-FAIL ${failure.name}: ${failure.error}`);
    throw new Error(`R12 boundary cases failed: ${failures.map(f => f.name).join(', ')}`);
  }
  console.log('slow-startup runtime test PASS');
  harness.cleanup();
})().catch(error => { console.error(error); try { harness.cleanup(); } catch {} process.exitCode = 1; });
