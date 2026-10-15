#!/usr/bin/env node
'use strict';
// project-knowledge-desktop — thin launcher.
//
//   start (default)  launch the Electron window (spawning or reusing the core backend)
//   status           delegate to the core CLI's verified status protocol
//   stop             delegate to the core CLI's safe-stop control channel
//
// status/stop are delegated, never reimplemented: the core owns instance
// identity verification and refuses stale endpoints.

const path = require('node:path');
const { spawn } = require('node:child_process');
const runtime = require('../lib/backend-runtime.cjs');
const pkg = require('../package.json');

const USAGE = `project-knowledge-desktop ${pkg.version}

Usage:
  project-knowledge-desktop [start]   Start the desktop app (default)
  project-knowledge-desktop status    Show this data directory's backend instance
  project-knowledge-desktop stop      Safely stop the backend instance

Options:
      --data <dir>   Select data directory (default: same as the core CLI)
  -v, --version      Print version
  -h, --help         Show help`;

function parse(argv) {
  const commands = new Set(['start', 'status', 'stop']);
  let command = 'start';
  const args = [...argv];
  if (args[0] && !args[0].startsWith('-')) {
    const next = args.shift().toLowerCase();
    if (!commands.has(next)) throw new Error(`Unknown command: ${next}. Run project-knowledge-desktop --help.`);
    command = next;
  }
  const options = { command };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--version' || arg === '-v') options.version = true;
    else if (arg === '--data') {
      const value = args[++i];
      if (!value || value.startsWith('-')) throw new Error('Missing value for --data.');
      options.dataDir = value;
    } else throw new Error(`${arg.startsWith('-') ? 'Unknown option' : 'Unexpected argument'}: ${arg}.`);
  }
  return options;
}

function delegate(command, dataDir) {
  const coreRoot = runtime.resolveCoreRoot();
  const cliPath = runtime.coreCliPath(coreRoot);
  const args = [cliPath, command];
  if (dataDir) args.push('--data', dataDir);
  const child = spawn(process.execPath, args, { stdio: 'inherit', windowsHide: true });
  child.once('error', error => { console.error(`project-knowledge-desktop ${command} failed: ${error.message}`); process.exitCode = 1; });
  child.once('exit', code => { process.exitCode = code ?? 1; });
}

function startElectron() {
  const appDir = path.resolve(__dirname, '..');
  let electronPath;
  try {
    electronPath = require('electron');
  } catch {
    console.error('Electron runtime is not installed. Run npm install inside @sanqianx/project-knowledge-desktop first.');
    process.exitCode = 1;
    return;
  }
  // require('electron') returns the binary path when launched from node.
  const child = spawn(electronPath, [appDir, ...process.argv.slice(2).filter(arg => arg !== 'start')], {
    stdio: 'inherit',
    windowsHide: false,
  });
  child.once('error', error => { console.error(`failed to launch desktop window: ${error.message}`); process.exitCode = 1; });
  child.once('exit', code => { process.exitCode = code ?? 0; });
}

async function main() {
  const options = parse(process.argv.slice(2));
  if (options.help) { console.log(USAGE); return; }
  if (options.version) { console.log(pkg.version); return; }
  if (options.command === 'start') { startElectron(); return; }
  delegate(options.command, options.dataDir);
}

if (require.main === module) main();

module.exports = { parse, USAGE };
