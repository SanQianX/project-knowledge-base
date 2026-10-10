#!/usr/bin/env node
'use strict';

// Codex supports one notify command. This fail-open fan-out preserves an
// existing notifier and invokes the Bridge beside it.
const { spawn } = require('child_process');
const os = require('os');
const path = require('path');

function commandFrom(args, marker) {
  const index = args.indexOf(marker);
  if (index < 0 || !args[index + 1]) return null;
  try {
    const command = JSON.parse(Buffer.from(args[index + 1], 'base64').toString('utf8'));
    return Array.isArray(command) && command.length && command.every(part => typeof part === 'string') ? command : null;
  } catch {
    return null;
  }
}

function readStdin() {
  return new Promise(resolve => {
    let value = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { value += chunk; });
    process.stdin.on('end', () => resolve(value));
    process.stdin.on('error', () => resolve(value));
  });
}

function payloadArgument(args) {
  const last = args.length - 1;
  if (last < 0 || ['--next-base64', '--bridge-base64'].includes(args[last - 1])) return null;
  try {
    const payload = JSON.parse(args[last]);
    return payload && typeof payload === 'object' && !Array.isArray(payload) ? args[last] : null;
  } catch {
    return null;
  }
}

function bridgePayload(raw) {
  try {
    const payload = JSON.parse(raw);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return raw;
    let changed = false;
    if (!payload.session_id && !payload.sessionId && typeof payload['thread-id'] === 'string') {
      payload.session_id = payload['thread-id'];
      changed = true;
    }
    if (!payload.turn_id && !payload.turnId && typeof payload['turn-id'] === 'string') {
      payload.turn_id = payload['turn-id'];
      changed = true;
    }
    // The notification only wakes the authoritative rollout reader. It must
    // never substitute its summary fields for captured conversation evidence.
    return changed ? JSON.stringify(payload) : raw;
  } catch {
    return raw;
  }
}

function invoke(command, payload, env, transport = 'stdin') {
  if (!command) return;
  try {
    const [executable, ...args] = command;
    const child = spawn(executable, transport === 'argv' ? [...args, payload] : args, {
      detached: true,
      stdio: [transport === 'argv' ? 'ignore' : 'pipe', 'ignore', 'ignore'],
      windowsHide: true,
      env,
    });
    child.on('error', () => {});
    if (child.stdin) {
      child.stdin.on('error', () => {});
      child.stdin.end(payload || '');
    }
    child.unref();
  } catch {
    // A notifier must never block Codex itself.
  }
}

(async () => {
  const args = process.argv.slice(2);
  const argument = payloadArgument(args);
  // Codex passes one JSON argument; legacy callers used stdin. Do not wait for
  // an open stdin in argv mode, and keep the third-party transport unchanged.
  const payload = argument === null ? await readStdin() : argument;
  invoke(commandFrom(args, '--next-base64'), payload, process.env, argument === null ? 'stdin' : 'argv');
  invoke(commandFrom(args, '--bridge-base64'), bridgePayload(payload), {
    ...process.env,
    CODEX_SESSIONS_ROOT: process.env.CODEX_SESSIONS_ROOT || path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions'),
  });
})();
