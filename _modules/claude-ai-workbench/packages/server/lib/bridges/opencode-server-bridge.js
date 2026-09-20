'use strict';

const net = require('net');
const { spawn: realSpawn } = require('child_process');
const { resolveCliInvocation } = require('../drivers/cli-json-runner');

// Persistent `opencode serve` bridge (HTTP + SSE), the HTTP sibling of the
// stdio app-server bridge. Protocol verified live against opencode 1.18.5:
//
//   - `opencode serve --port N --hostname 127.0.0.1` binds a real port
//     (--port 0 means "the default 4096", NOT a random port, so the bridge
//     allocates a free port itself and passes it explicitly).
//   - Readiness: poll `GET /global/health` -> { healthy, version }.
//   - Auth: none by default (localhost, no OPENCODE_SERVER_PASSWORD).
//   - `OPENCODE_CONFIG_CONTENT` env var is honored (custom provider injection
//     works exactly like the CLI transport).
//   - SSE: `GET /global/event` carries every project's events wrapped as
//     { directory, project, workspace, payload: { id, type, properties } }.
//     (`GET /event` is scoped to the serve process cwd and misses sessions in
//     other directories.) First frame is server.connected; server.heartbeat
//     frames arrive every ~10-15s. There is NO Last-Event-ID replay: after a
//     reconnect the consumer must reconcile missed state through REST
//     (onSseGap fires for exactly that).
//   - `message.part.delta` events are true incremental text deltas; tool
//     parts stream pending -> running -> completed state snapshots.
//
// Responsibilities:
//   - child lifecycle: lazy single-flight start with health handshake, crash
//     auto-restart with backoff (bounded), idle shutdown (heartbeats do NOT
//     count as activity), terminal close();
//   - HTTP client: JSON requests with per-request timeouts against the live
//     port (fetch is injectable for tests);
//   - SSE subscription: frame parsing, payload unwrapping, heartbeat
//     staleness watchdog and self-healing reconnect with onSseGap notification.
//
// config:
//   command, args, env, cwd    child invocation (args appended after 'serve')
//   spawn                      injectable spawn(command, args, options)
//   fetch                      injectable fetch(input, init) for HTTP/SSE
//   allocatePort               injectable async () => port number
//   hostname                   serve bind address (default 127.0.0.1)
//   onEvent                    (payload) => void — unwrapped global events
//   onSseGap                   () => void — the SSE stream dropped; reconcile
//   onUnexpectedExit           (error) => void — child died outside idle/close
//   onReady                    (generation) => void
//   healthTimeoutMs            startup handshake budget (default 15000)
//   requestTimeoutMs           per-request default (default 30000)
//   idleTimeoutMs              quiet period before shutdown (default 600000)
//   maxRestarts / restartBackoffMs   crash restart budget (3 / [250,500,1000])
//   sseReconnectMs             SSE reconnect backoff steps (default [250,500,1000,2000])
//   heartbeatTimeoutMs         no-frame watchdog (default 75000; 0 disables)
//   log                        (message, meta) => void
//
// States: idle -> starting -> ready -> (restarting -> ready)* -> idle|crashed|closed

const DEFAULTS = {
  healthTimeoutMs: 15000,
  requestTimeoutMs: 30000,
  idleTimeoutMs: 10 * 60 * 1000,
  maxRestarts: 3,
  restartBackoffMs: [250, 500, 1000],
  sseReconnectMs: [250, 500, 1000, 2000],
  heartbeatTimeoutMs: 75000,
  hostname: '127.0.0.1',
};

function createOpenCodeServerBridge(config = {}) {
  // Config keys that are present-but-undefined (e.g. an options pass-through
  // from the driver) must not shadow the defaults.
  const present = {};
  for (const [key, value] of Object.entries(config)) {
    if (value !== undefined) present[key] = value;
  }
  const opts = { ...DEFAULTS, ...present };
  const spawnFn = opts.spawn || realSpawn;
  const fetchFn = opts.fetch || (typeof fetch === 'function' ? fetch : null);
  const onEvent = typeof opts.onEvent === 'function' ? opts.onEvent : () => {};
  const onSseGap = typeof opts.onSseGap === 'function' ? opts.onSseGap : () => {};
  const onUnexpectedExit = typeof opts.onUnexpectedExit === 'function' ? opts.onUnexpectedExit : () => {};
  const onReady = typeof opts.onReady === 'function' ? opts.onReady : () => {};
  const log = typeof opts.log === 'function' ? opts.log : () => {};

  let state = 'idle';
  let child = null;
  let port = null;
  let generation = 0; // bumped on every successful (re)launch
  let bootPromise = null;
  let bootSettle = null; // { resolve, reject } of the in-flight launch
  let restartTimer = null;
  let idleTimer = null;
  let restartsUsed = 0;
  let intentionalStop = false;
  let closed = false;
  let sseAbort = null; // AbortController of the live SSE fetch
  let sseStaleTimer = null;
  let sseReconnectTimer = null;
  let sseAttempt = 0;
  let lastFrameAt = 0;
  let inFlightRequests = 0;

  if (!fetchFn) throw bridgeError('no fetch implementation available for the opencode server bridge', 503, 'BRIDGE_NO_FETCH');

  const base = () => `http://${opts.hostname}:${port}`;

  function touchActivity() {
    if (opts.idleTimeoutMs > 0 && state === 'ready') {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(idleShutdown, opts.idleTimeoutMs);
      idleTimer.unref && idleTimer.unref();
    }
  }

  function idleShutdown() {
    if (closed || inFlightRequests > 0) { touchActivity(); return; }
    log('opencode serve bridge idle shutdown', { idleTimeoutMs: opts.idleTimeoutMs });
    intentionalStop = true;
    stopSse();
    killChild();
    state = 'idle';
    bootPromise = null;
    port = null;
    restartsUsed = 0;
  }

  function killChild() {
    if (!child) return;
    const target = child;
    child = null;
    try {
      // npm shims spawn a node child on Windows; killing the shell alone
      // orphans it. Fakes injected by tests have no pid and skip taskkill.
      if (process.platform === 'win32' && Number.isInteger(target.pid)) {
        realSpawn('taskkill', ['/pid', String(target.pid), '/T', '/F'], { windowsHide: true });
      }
    } catch { /* already gone */ }
    try { target.kill(); } catch { /* already gone */ }
  }

  function stopSse() {
    clearTimeout(sseReconnectTimer);
    clearTimeout(sseStaleTimer);
    sseReconnectTimer = null;
    if (sseAbort) {
      const abort = sseAbort;
      sseAbort = null;
      try { abort.abort(); } catch { /* already aborted */ }
    }
  }

  // ---- HTTP client ---------------------------------------------------------

  async function request(method, path, options = {}) {
    if (closed) throw bridgeError('opencode serve bridge is closed', 503, 'BRIDGE_CLOSED');
    if (state === 'crashed') throw bridgeError('opencode serve bridge exhausted its restart budget', 503, 'BRIDGE_CRASHED');
    if (!port) await start();
    const timeoutMs = options.timeoutMs !== undefined ? options.timeoutMs : opts.requestTimeoutMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref && timer.unref();
    inFlightRequests += 1;
    try {
      const response = await fetchFn(`${base()}${path}`, {
        method,
        signal: controller.signal,
        headers: options.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      });
      if (!response.ok) {
        let detail = '';
        try {
          const parsed = await response.json();
          detail = parsed && (parsed.message || parsed.error && parsed.error.message) || '';
        } catch { /* non-JSON error body */ }
        throw bridgeError(`opencode serve ${method} ${path} failed: ${response.status} ${String(detail).slice(0, 300)}`,
          502, 'BRIDGE_HTTP_ERROR', { httpStatus: response.status });
      }
      if (response.status === 204) return null;
      const text = await response.text();
      touchActivity();
      return text ? JSON.parse(text) : null;
    } catch (error) {
      if (error && (error.code === 'BRIDGE_HTTP_ERROR' || error.code === 'BRIDGE_CLOSED')) throw error;
      if (controller.signal.aborted) {
        throw bridgeError(`opencode serve ${method} ${path} timed out after ${timeoutMs}ms`, 504, 'BRIDGE_TIMEOUT');
      }
      throw bridgeError(`opencode serve ${method} ${path} failed: ${error && error.message || error}`,
        503, 'BRIDGE_REQUEST_FAILED', { cause: error });
    } finally {
      clearTimeout(timer);
      inFlightRequests -= 1;
      touchActivity();
    }
  }

  // ---- SSE subscription ----------------------------------------------------

  function handleSseFrame(raw) {
    const dataLines = [];
    for (const line of raw.split('\n')) {
      if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
    }
    if (!dataLines.length) return;
    let parsed;
    try { parsed = JSON.parse(dataLines.join('\n')); } catch {
      log(`opencode serve bridge discarded unparseable SSE frame: ${raw.slice(0, 160)}`);
      return;
    }
    const payload = parsed && parsed.payload && typeof parsed.payload === 'object' ? parsed.payload : null;
    if (!payload || !payload.type) return; // heartbeat frames still refresh liveness below
    // Heartbeats prove the stream is alive but must not keep the child from
    // idling away — every other event (and each request) is real activity.
    if (payload.type !== 'server.heartbeat') touchActivity();
    try { onEvent(payload); } catch (error) {
      log(`opencode serve bridge onEvent handler failed for ${payload.type}: ${error.message}`);
    }
  }

  async function sseLoop() {
    const myGeneration = generation;
    while (!closed && child && generation === myGeneration) {
      const controller = new AbortController();
      sseAbort = controller;
      try {
        const response = await fetchFn(`${base()}/global/event`, { signal: controller.signal });
        if (!response.ok || !response.body || typeof response.body.getReader !== 'function') {
          throw new Error(`event subscription failed: HTTP ${response.status}`);
        }
        sseAttempt = 0; // a healthy subscription resets the backoff
        lastFrameAt = Date.now();
        armStalenessWatchdog();
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          lastFrameAt = Date.now();
          buffer += decoder.decode(value, { stream: true });
          let index;
          while ((index = buffer.indexOf('\n\n')) >= 0) {
            const frame = buffer.slice(0, index);
            buffer = buffer.slice(index + 2);
            if (frame.trim()) handleSseFrame(frame);
          }
        }
      } catch (error) {
        if (closed || !child || generation !== myGeneration) return;
        if (!controller.signal.aborted) log(`opencode serve event stream dropped: ${error && error.message || error}`);
      } finally {
        clearTimeout(sseStaleTimer);
      }
      if (closed || !child || generation !== myGeneration) return;
      // The stream ended (server closed it, watchdog aborted it, network cut
      // it): notify once per gap so the consumer reconciles missed events via
      // REST, then reconnect with capped backoff while the child lives.
      sseAbort = null;
      try { onSseGap(); } catch (error) { log(`onSseGap handler failed: ${error.message}`); }
      const backoff = opts.sseReconnectMs[Math.min(sseAttempt, opts.sseReconnectMs.length - 1)];
      sseAttempt += 1;
      await new Promise(resolve => {
        sseReconnectTimer = setTimeout(resolve, backoff);
        sseReconnectTimer.unref && sseReconnectTimer.unref();
      });
      sseReconnectTimer = null;
      if (closed || !child || generation !== myGeneration) return;
    }
  }

  function armStalenessWatchdog() {
    if (!opts.heartbeatTimeoutMs) return;
    clearTimeout(sseStaleTimer);
    sseStaleTimer = setTimeout(() => {
      // Heartbeats arrive every ~10-15s; silence means a dead stream that the
      // OS has not reported yet — abort the fetch to force the reconnect path.
      log(`opencode serve event stream stale for ${opts.heartbeatTimeoutMs}ms; forcing reconnect`);
      if (sseAbort) {
        try { sseAbort.abort(); } catch { /* already aborted */ }
      }
    }, opts.heartbeatTimeoutMs);
    sseStaleTimer.unref && sseStaleTimer.unref();
  }

  // ---- child lifecycle -----------------------------------------------------

  function allocatePort() {
    if (typeof opts.allocatePort === 'function') return Promise.resolve(opts.allocatePort());
    return new Promise((resolve, reject) => {
      const server = net.createServer();
      server.unref();
      server.on('error', reject);
      server.listen(0, opts.hostname, () => {
        const { port: freePort } = server.address();
        server.close(() => resolve(freePort));
      });
    });
  }

  async function waitForHealth(deadline) {
    while (Date.now() < deadline) {
      if (!child) throw bridgeError('opencode serve child exited during startup', 503, 'BRIDGE_SPAWN_FAILED');
      try {
        const response = await fetchFn(`${base()}/global/health`);
        if (response.ok) {
          const parsed = await response.json().catch(() => null);
          if (!parsed || parsed.healthy !== true) throw new Error('health endpoint reported unhealthy');
          return parsed;
        }
      } catch (error) {
        if (!child) throw bridgeError('opencode serve child exited during startup', 503, 'BRIDGE_SPAWN_FAILED', { cause: error });
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw bridgeError(`opencode serve did not become healthy within ${opts.healthTimeoutMs}ms`, 504, 'BRIDGE_HEALTH_TIMEOUT');
  }

  function wire(childInstance) {
    child = childInstance;
    if (childInstance.stdout && childInstance.stdout.setEncoding) {
      childInstance.stdout.setEncoding('utf8');
      childInstance.stdout.on('data', chunk => {
        const text = String(chunk).trim();
        if (text) log(`opencode serve stdout: ${text.slice(0, 200)}`);
      });
    }
    if (childInstance.stderr && childInstance.stderr.setEncoding) {
      childInstance.stderr.setEncoding('utf8');
      childInstance.stderr.on('data', chunk => {
        const text = String(chunk).trim();
        if (text) log(`opencode serve stderr: ${text.slice(0, 200)}`);
      });
    }
    childInstance.on('error', error => {
      log(`opencode serve child error: ${error.message}`);
      handleExit(error);
    });
    childInstance.on('close', code => {
      log(`opencode serve child exited code=${code}`);
      handleExit(null);
    });
  }

  function handleExit(spawnError) {
    if (!child) return;
    const wasReady = state === 'ready';
    child = null;
    port = null;
    bootPromise = null;
    clearTimeout(idleTimer);
    stopSse();
    if (closed || intentionalStop) return;
    const error = spawnError
      ? bridgeError(`opencode serve child failed: ${spawnError.message}`, 503, 'BRIDGE_SPAWN_FAILED', { cause: spawnError })
      : bridgeError('opencode serve child exited unexpectedly', 503, 'BRIDGE_CRASHED');
    try { onUnexpectedExit(error); } catch (hookError) { log(`onUnexpectedExit hook failed: ${hookError.message}`); }
    if (!wasReady) {
      state = 'idle';
      if (bootSettle) {
        const settle = bootSettle;
        bootSettle = null;
        settle.reject(spawnError
          ? bridgeError(`opencode serve child failed to start: ${spawnError.message}`, 503, 'BRIDGE_SPAWN_FAILED')
          : bridgeError('opencode serve child exited before becoming healthy', 503, 'BRIDGE_SPAWN_FAILED'));
      }
      return;
    }
    if (restartsUsed < opts.maxRestarts) {
      const backoff = opts.restartBackoffMs[Math.min(restartsUsed, opts.restartBackoffMs.length - 1)];
      restartsUsed += 1;
      state = 'restarting';
      log(`opencode serve crashed; restarting (${restartsUsed}/${opts.maxRestarts}) in ${backoff}ms`);
      bootPromise = new Promise((resolve, reject) => {
        bootSettle = { resolve, reject };
        restartTimer = setTimeout(() => {
          launchChild().then(resolve, reject);
        }, backoff);
        restartTimer.unref && restartTimer.unref();
      });
      bootPromise.catch(() => {}); // held internally until the next start()
    } else {
      state = 'crashed';
      log('opencode serve bridge exhausted its restart budget');
    }
  }

  function launchChild() {
    state = 'starting';
    return allocatePort().then(allocatedPort => new Promise((resolve, reject) => {
      bootSettle = { resolve, reject };
      port = allocatedPort;
      const args = ['serve', '--port', String(allocatedPort), '--hostname', opts.hostname, ...(config.args || [])];
      let invocation;
      try {
        // Real children must skip npm .cmd shims on Windows (plain spawn of a
        // shim name is ENOENT); injected test doubles pass through as-is.
        invocation = config.spawn || !config.command
          ? { command: config.command || 'opencode', args }
          : resolveCliInvocation(config.command, args);
      } catch (error) {
        state = 'idle';
        port = null;
        bootSettle = null;
        reject(bridgeError(`failed to resolve the opencode executable: ${error.message}`, 503, 'BRIDGE_SPAWN_FAILED', { cause: error }));
        return;
      }
      let instance;
      try {
        instance = spawnFn(invocation.command, invocation.args, {
          cwd: config.cwd,
          windowsHide: true,
          env: { ...process.env, ...(config.env || {}) },
        });
      } catch (error) {
        state = 'idle';
        port = null;
        bootSettle = null;
        reject(bridgeError(`failed to start opencode serve: ${error.message}`, 503, 'BRIDGE_SPAWN_FAILED', { cause: error }));
        return;
      }
      wire(instance);
      const deadline = Date.now() + opts.healthTimeoutMs;
      waitForHealth(deadline).then(health => {
        if (!child || closed) throw bridgeError('bridge closed during startup', 503, 'BRIDGE_CLOSED');
        bootSettle = null;
        generation += 1;
        state = 'ready';
        intentionalStop = false;
        touchActivity();
        sseAttempt = 0;
        sseLoop(); // fire and forget; the loop owns its own error path
        try { onReady(generation, { port, version: health && health.version }); } catch (error) {
          log(`onReady hook failed: ${error.message}`);
        }
        resolve({ port: allocatedPort, version: health && health.version });
      }, error => {
        if (bootSettle) {
          const settle = bootSettle;
          bootSettle = null;
          settle.reject(error);
        }
        // A failed handshake must not leave a doomed child running.
        intentionalStop = true;
        stopSse();
        killChild();
        state = 'idle';
        port = null;
      });
    }));
  }

  function start() {
    if (closed) return Promise.reject(bridgeError('opencode serve bridge is closed', 503, 'BRIDGE_CLOSED'));
    if (state === 'ready' && bootPromise) return bootPromise;
    if (state === 'crashed') return Promise.reject(bridgeError('opencode serve bridge exhausted its restart budget', 503, 'BRIDGE_CRASHED'));
    if (!bootPromise) bootPromise = launchChild();
    return bootPromise;
  }

  function close() {
    if (closed) return Promise.resolve();
    closed = true;
    state = 'closed';
    clearTimeout(restartTimer);
    clearTimeout(idleTimer);
    intentionalStop = true;
    stopSse();
    killChild();
    if (bootSettle) {
      const settle = bootSettle;
      bootSettle = null;
      settle.reject(bridgeError('opencode serve bridge is closed', 503, 'BRIDGE_CLOSED'));
    }
    return Promise.resolve();
  }

  return {
    get state() { return state; },
    get port() { return port; },
    get generation() { return generation; },
    get sseConnected() { return Boolean(sseAbort); },
    start,
    request,
    close,
  };
}

function bridgeError(message, status, code, extra = {}) {
  return Object.assign(new Error(message), { status, code, ...extra });
}

module.exports = { createOpenCodeServerBridge };
