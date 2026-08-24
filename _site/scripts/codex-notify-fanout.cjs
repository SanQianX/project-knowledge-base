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

function invoke(command, payload, env) {
  if (!command) return;
  try {
    const [executable, ...args] = command;
    const child = spawn(executable, args, { detached: true, stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true, env });
    child.stdin.end(payload || '');
    child.unref();
  } catch {
    // A notifier must never block Codex itself.
  }
}

(async () => {
  const payload = await readStdin();
  const args = process.argv.slice(2);
  invoke(commandFrom(args, '--next-base64'), payload, process.env);
  invoke(commandFrom(args, '--bridge-base64'), payload, {
    ...process.env,
    CODEX_SESSIONS_ROOT: process.env.CODEX_SESSIONS_ROOT || path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions'),
  });
})();
