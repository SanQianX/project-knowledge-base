'use strict';

const { spawn: realSpawn } = require('child_process');

// Generic persistent app-server bridge: manages one long-lived child process
// speaking line-delimited JSON-RPC over stdio (the dialect `codex app-server`
// uses — messages may omit the `jsonrpc` field in both directions).
//
// Responsibilities:
//   - process lifecycle: lazy single-flight start, crash auto-restart with
//     backoff (bounded), idle shutdown after a configurable quiet period,
//     terminal close();
//   - JSON-RPC client: id-correlated request/response promises, client
//     notifications, server notification fan-out (onEvent) and server-initiated
//     requests answered through the onServerRequest callback;
//   - line-buffered stdio parsing (same framing as the CLI JSON runners).
//
// Everything is injectable for tests: pass `spawn` to substitute the child.
//
// config:
//   command, args, env, cwd   child invocation (env/cwd are merged/defaults)
//   spawn                     injectable spawn(command, args, options)
//   onEvent                   ({ method, params }) => void  — notifications
//   onServerRequest           async (method, params) => result — throws to send an error response
//   onUnexpectedExit          (error) => void — child died outside idle/close (turns may hang)
//   requestTimeoutMs          per-request default timeout (0 disables; default 120000)
//   idleTimeoutMs             quiet period before shutdown (0 disables; default 600000)
//   maxRestarts               crash restart budget before giving up (default 3)
//   restartBackoffMs          array of escalating delays (default [250, 500, 1000])
//   log                       (message, meta) => void diagnostics hook
//
// States: idle -> starting -> ready -> (restarting -> ready)* -> idle|crashed|closed

const DEFAULT_REQUEST_TIMEOUT_MS = 120000;
const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_MAX_RESTARTS = 3;
const DEFAULT_RESTART_BACKOFF_MS = [250, 500, 1000];

function createAppServerBridge(config = {}) {
  const spawnFn = config.spawn || realSpawn;
  const onEvent = typeof config.onEvent === 'function' ? config.onEvent : () => {};
  const onUnexpectedExit = typeof config.onUnexpectedExit === 'function' ? config.onUnexpectedExit : () => {};
  const onReady = typeof config.onReady === 'function' ? config.onReady : () => {};
  const onServerRequest = config.onServerRequest;
  const log = typeof config.log === 'function' ? config.log : () => {};
  const requestTimeoutMs = config.requestTimeoutMs !== undefined ? config.requestTimeoutMs : DEFAULT_REQUEST_TIMEOUT_MS;
  const idleTimeoutMs = config.idleTimeoutMs !== undefined ? config.idleTimeoutMs : DEFAULT_IDLE_TIMEOUT_MS;
  const maxRestarts = config.maxRestarts !== undefined ? config.maxRestarts : DEFAULT_MAX_RESTARTS;
  const restartBackoffMs = config.restartBackoffMs || DEFAULT_RESTART_BACKOFF_MS;

  let state = 'idle';
  let child = null;
  let generation = 0; // bumped on every successful (re)launch of the child
  let bootPromise = null;
  let restartTimer = null;
  let idleTimer = null;
  let restartsUsed = 0;
  let intentionalStop = false;
  let closed = false;
  let nextRequestId = 1;
  let bootSettle = null; // { resolve, reject } of the in-flight launch promise
  let inFlightServerRequests = 0; // unanswered server requests are activity
  const pending = new Map(); // id -> { resolve, reject, timer }

  function safeWrite(message) {
    const line = `${JSON.stringify(message)}\n`;
    if (!child || !child.stdin || child.stdin.destroyed) throw bridgeError('bridge child stdin is not writable', 503, 'BRIDGE_NOT_READY');
    child.stdin.write(line);
  }

  function touchActivity() {
    if (idleTimeoutMs > 0 && state === 'ready') {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(idleShutdown, idleTimeoutMs);
      idleTimer.unref && idleTimer.unref();
    }
  }

  function idleShutdown() {
    if (closed || pending.size > 0 || inFlightServerRequests > 0) { touchActivity(); return; }
    log('bridge idle shutdown', { idleTimeoutMs });
    intentionalStop = true;
    killChild('idle-timeout');
    state = 'idle';
    bootPromise = null;
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

  function failPending(error) {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
  }

  function wire(childInstance) {
    child = childInstance;
    let buffer = '';
    childInstance.stdout.setEncoding('utf8');
    childInstance.stdout.on('data', chunk => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line) handleMessage(line);
      }
    });
    childInstance.stderr.setEncoding && childInstance.stderr.setEncoding('utf8');
    childInstance.stderr.on('data', chunk => {
      const text = String(chunk).trim();
      if (text) log(`bridge stderr: ${text.slice(0, 400)}`);
    });
    childInstance.on('error', error => {
      log(`bridge child error: ${error.message}`);
      handleExit(error);
    });
    childInstance.on('close', code => {
      log(`bridge child exited code=${code}`);
      handleExit(null);
    });
  }

  function handleMessage(line) {
    touchActivity();
    let message;
    try { message = JSON.parse(line); } catch {
      log(`bridge discarded unparseable line: ${line.slice(0, 200)}`);
      return;
    }
    if (!message || typeof message !== 'object') return;
    if (message.method && message.id !== undefined && message.id !== null) {
      handleServerRequest(message);
    } else if (message.method) {
      try { onEvent({ method: message.method, params: message.params }); } catch (error) {
        log(`bridge onEvent handler failed for ${message.method}: ${error.message}`);
      }
    } else if (message.id !== undefined && message.id !== null) {
      const entry = pending.get(message.id);
      if (!entry) return; // response to an unknown/aborted request
      pending.delete(message.id);
      clearTimeout(entry.timer);
      if (restartsUsed > 0) restartsUsed = 0;
      if (message.error) entry.reject(rpcError(message.error));
      else entry.resolve(message.result !== undefined ? message.result : null);
    }
    // anything else is ignored
  }

  async function handleServerRequest(message) {
    const id = message.id;
    // An unanswered server request (e.g. an approval) is bridge activity:
    // it must keep the child alive and never be silently idled away.
    inFlightServerRequests += 1;
    try {
      if (!onServerRequest) throw bridgeError(`no onServerRequest handler for ${message.method}`, 501, 'BRIDGE_UNSUPPORTED');
      const result = await onServerRequest(message.method, message.params);
      safeWrite({ id, result: result === undefined ? null : result });
    } catch (error) {
      try {
        safeWrite({ id, error: { code: error.rpcCode || -32000, message: String(error && error.message || error).slice(0, 1000) } });
      } catch { /* child already gone; nothing to answer */ }
    } finally {
      inFlightServerRequests -= 1;
      touchActivity();
    }
  }

  function handleExit(spawnError) {
    if (!child) return;
    const wasReady = state === 'ready';
    child = null;
    bootPromise = null;
    clearTimeout(idleTimer);
    if (closed || intentionalStop) return;
    const error = spawnError
      ? bridgeError(`bridge child failed: ${spawnError.message}`, 503, 'BRIDGE_SPAWN_FAILED', { cause: spawnError })
      : bridgeError('bridge child exited unexpectedly', 503, 'BRIDGE_CRASHED');
    failPending(error);
    try { onUnexpectedExit(error); } catch (hookError) { log(`bridge onUnexpectedExit hook failed: ${hookError.message}`); }
    if (!wasReady) {
      // The boot promise never resolved; fail it so start() callers see why.
      state = 'idle';
      if (bootSettle) {
        const settle = bootSettle;
        bootSettle = null;
        settle.reject(spawnError
          ? bridgeError(`bridge child failed to start: ${spawnError.message}`, 503, 'BRIDGE_SPAWN_FAILED', { cause: spawnError })
          : bridgeError('bridge child exited before becoming ready', 503, 'BRIDGE_SPAWN_FAILED'));
      }
      return;
    }
    if (restartsUsed < maxRestarts) {
      const backoff = restartBackoffMs[Math.min(restartsUsed, restartBackoffMs.length - 1)];
      restartsUsed += 1;
      state = 'restarting';
      log(`bridge crashed; restarting (${restartsUsed}/${maxRestarts}) in ${backoff}ms`);
      bootPromise = new Promise((resolve, reject) => {
        // Register the restart promise's settle so a close() during the
        // backoff window cannot leave start() callers hanging forever.
        bootSettle = { resolve, reject };
        restartTimer = setTimeout(() => {
          launchChild().then(resolve, reject);
        }, backoff);
      });
      // This promise is held internally until someone calls start(); without
      // a handler a close()-time rejection would surface as unhandled.
      bootPromise.catch(() => {});
    } else {
      state = 'crashed';
      log('bridge exhausted its restart budget');
    }
  }

  function launchChild() {
    state = 'starting';
    return new Promise((resolve, reject) => {
      bootSettle = { resolve, reject };
      let instance;
      try {
        instance = spawnFn(config.command, config.args || [], {
          cwd: config.cwd,
          windowsHide: true,
          env: { ...process.env, ...(config.env || {}) },
        });
      } catch (error) {
        state = 'idle';
        bootSettle = null;
        reject(bridgeError(`failed to start bridge child: ${error.message}`, 503, 'BRIDGE_SPAWN_FAILED', { cause: error }));
        return;
      }
      wire(instance);
      const markReady = () => {
        if (!child || closed) return;
        bootSettle = null;
        generation += 1;
        state = 'ready';
        intentionalStop = false;
        touchActivity();
        try { onReady(generation); } catch (error) { log(`bridge onReady hook failed: ${error.message}`); }
        resolve();
      };
      if (instance.pid === undefined) {
        // Fake children (EventEmitter stand-ins) never emit 'spawn'.
        setImmediate(markReady);
      } else {
        // Real children signal readiness through 'spawn'; a fallback timer
        // covers exotic platforms that are slow to emit it.
        if (typeof instance.once === 'function') instance.once('spawn', markReady);
        const fallback = setTimeout(markReady, 500);
        fallback.unref && fallback.unref();
      }
    });
  }

  function start() {
    if (closed) return Promise.reject(bridgeError('bridge is closed', 503, 'BRIDGE_CLOSED'));
    if (state === 'ready' && bootPromise) return bootPromise;
    if (state === 'crashed') return Promise.reject(bridgeError('bridge exhausted its restart budget', 503, 'BRIDGE_CRASHED'));
    if (!bootPromise) bootPromise = launchChild();
    return bootPromise;
  }

  function request(method, params, options = {}) {
    if (closed) return Promise.reject(bridgeError('bridge is closed', 503, 'BRIDGE_CLOSED'));
    if (state === 'crashed') return Promise.reject(bridgeError('bridge exhausted its restart budget', 503, 'BRIDGE_CRASHED'));
    const timeoutMs = options.timeoutMs !== undefined ? options.timeoutMs : requestTimeoutMs;
    return start().then(() => new Promise((resolve, reject) => {
      const id = nextRequestId++;
      const entry = { resolve, reject, timer: null };
      if (timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          pending.delete(id);
          reject(bridgeError(`bridge request ${method} timed out after ${timeoutMs}ms`, 504, 'BRIDGE_TIMEOUT'));
        }, timeoutMs);
        entry.timer.unref && entry.timer.unref();
      }
      pending.set(id, entry);
      try {
        // The app-server dialect omits the jsonrpc field; we mirror that.
        safeWrite(params !== undefined ? { id, method, params } : { id, method });
        touchActivity();
      } catch (error) {
        pending.delete(id);
        clearTimeout(entry.timer);
        reject(error);
      }
    }));
  }

  function notify(method, params) {
    if (closed) throw bridgeError('bridge is closed', 503, 'BRIDGE_CLOSED');
    return start().then(() => {
      safeWrite(params !== undefined ? { method, params } : { method });
      touchActivity();
    });
  }

  function close() {
    if (closed) return Promise.resolve();
    closed = true;
    state = 'closed';
    clearTimeout(restartTimer);
    clearTimeout(idleTimer);
    intentionalStop = true;
    killChild();
    failPending(bridgeError('bridge closed', 503, 'BRIDGE_CLOSED'));
    // A close() while still starting (or in a restart backoff) must settle
    // the boot promise, otherwise every awaiting start() caller hangs.
    if (bootSettle) {
      const settle = bootSettle;
      bootSettle = null;
      settle.reject(bridgeError('bridge closed', 503, 'BRIDGE_CLOSED'));
    }
    return Promise.resolve();
  }

  return {
    command: config.command,
    args: config.args || [],
    env: config.env || {},
    get state() { return state; },
    get pendingCount() { return pending.size; },
    get restartsUsed() { return restartsUsed; },
    get generation() { return generation; },
    start,
    request,
    notify,
    close,
  };
}

function bridgeError(message, status, code, extra = {}) {
  return Object.assign(new Error(message), { status, code, ...extra });
}

function rpcError(rpc) {
  return Object.assign(new Error(String(rpc && rpc.message || 'bridge rpc error').slice(0, 1000)), {
    status: 502,
    code: 'BRIDGE_RPC_ERROR',
    rpcCode: rpc && rpc.code,
  });
}

module.exports = { createAppServerBridge };
