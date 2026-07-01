#!/usr/bin/env node

// project-knowledge CLI — start in background by default (auto-opens browser).
// Pattern modeled on tokmeter's bin.js: detached child + PID file + port fallback.
// Run `project-knowledge --help` for usage.

const path = require('path');
const { spawn, exec } = require('child_process');
const { existsSync, readFileSync, writeFileSync, unlinkSync } = require('fs');
const net = require('net');
const os = require('os');

const pkg = require('../package.json');
const DEFAULT_PORT = 5757;
const PORT_RANGE = 20;
const PID_FILE = path.join(os.tmpdir(), '.project-knowledge.pid');

function readPid() {
  try {
    if (!existsSync(PID_FILE)) return null;
    const lines = readFileSync(PID_FILE, 'utf8').trim().split('\n');
    return parseInt(lines[0], 10);
  } catch { return null; }
}

function readPort() {
  try {
    if (!existsSync(PID_FILE)) return null;
    const lines = readFileSync(PID_FILE, 'utf8').trim().split('\n');
    return lines[1] ? parseInt(lines[1], 10) : null;
  } catch { return null; }
}

function writePid(pid, port) {
  try {
    writeFileSync(PID_FILE, `${pid}\n${port}`, 'utf8');
  } catch (err) {
    console.error(`Warning: failed to write PID file at ${PID_FILE}: ${err.message}`);
  }
}

function removePid() {
  try { unlinkSync(PID_FILE); } catch { /* ignore */ }
}

function isProcessAlive(pid) {
  if (!pid || Number.isNaN(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function openBrowser(url) {
  let cmd;
  if (process.platform === 'win32') {
    cmd = `start "" "${url}"`;
  } else if (process.platform === 'darwin') {
    cmd = `open "${url}"`;
  } else {
    cmd = `xdg-open "${url}"`;
  }
  try { exec(cmd); } catch { /* best-effort */ }
}

function isPortFree(port) {
  return new Promise((resolve) => {
    const tester = net.createServer();
    let settled = false;
    const finish = (free) => {
      if (settled) return;
      settled = true;
      tester.removeAllListeners();
      tester.close(() => resolve(free));
    };
    tester.once('error', () => finish(false));
    tester.once('listening', () => finish(true));
    tester.listen(port);
    setTimeout(() => finish(false), 1000);
  });
}

async function findFreePort(start) {
  for (let offset = 0; offset < PORT_RANGE; offset++) {
    const port = start + offset;
    if (await isPortFree(port)) return port;
  }
  throw new Error(`No free port found in range ${start}-${start + PORT_RANGE - 1}`);
}

// ── Subcommands ──
function cmdStop() {
  const pid = readPid();
  if (!pid) {
    console.log('No background process found.');
    process.exit(0);
  }
  if (!isProcessAlive(pid)) {
    removePid();
    console.log('Process already stopped.');
    process.exit(0);
  }
  try {
    process.kill(pid);
    removePid();
    console.log(`project-knowledge stopped (PID ${pid}).`);
  } catch {
    console.error(`Failed to stop process ${pid}`);
    process.exit(1);
  }
  // process.exit never returns — guarantees we don't fall through to the
  // background-launch branch below, which would otherwise re-spawn the server
  // we just killed (console.log writes synchronously to stdout, so the
  // "stopped" line above is flushed before exit).
  process.exit(0);
}

function cmdStatus() {
  const pid = readPid();
  if (!pid || !isProcessAlive(pid)) {
    removePid();
    console.log('project-knowledge is not running.');
    process.exit(0);
  }
  const port = readPort() || DEFAULT_PORT;
  console.log(`project-knowledge is running (PID ${pid}) at http://localhost:${port}`);
  process.exit(0);
}

function printHelp() {
  console.log(`project-knowledge ${pkg.version}

Local knowledge-base dashboard manager.

Usage:
  project-knowledge              Start in background (default), auto-open browser
  project-knowledge --fg         Start in foreground (Ctrl+C to stop)
  project-knowledge stop         Stop the background process
  project-knowledge status       Check if running

Options:
  -p, --port <port>   Port to run on (default: ${DEFAULT_PORT}, auto-fallback ±${PORT_RANGE})
      --host <host>   Host to bind on (default: 127.0.0.1)
      --no-open       Don't auto-open browser
      --fg            Run in foreground
  -v, --version       Print version and exit
  -h, --help          Show this help message

Runtime data lives next to the npm global root; PID file at ${PID_FILE}.
`);
  process.exit(0);
}

// ── Parse args ──
const args = process.argv.slice(2);

// Subcommands first
if (args[0] === 'stop') cmdStop();
if (args[0] === 'status') cmdStatus();

let port = DEFAULT_PORT;
let host = '127.0.0.1';
let shouldOpen = true;
let foreground = false;
let portExplicit = false;
let hostExplicit = false;

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--help' || arg === '-h') {
    printHelp();
  } else if (arg === '--version' || arg === '-v') {
    console.log(pkg.version);
    process.exit(0);
  } else if ((arg === '--port' || arg === '-p') && args[i + 1]) {
    const parsed = parseInt(args[i + 1], 10);
    if (Number.isNaN(parsed)) {
      console.error('Error: --port must be a number');
      process.exit(1);
    }
    port = parsed;
    portExplicit = true;
    i++;
  } else if (arg === '--host' && args[i + 1]) {
    host = args[i + 1];
    hostExplicit = true;
    i++;
  } else if (arg === '--no-open') {
    shouldOpen = false;
  } else if (arg === '--fg') {
    foreground = true;
  } else if (arg.startsWith('-')) {
    console.error(`Unknown option: ${arg}\nRun \`project-knowledge --help\` for usage.`);
    process.exit(1);
  }
}

// ── Background launch ──
if (!foreground) {
  const existingPid = readPid();
  if (existingPid && isProcessAlive(existingPid)) {
    const actualPort = readPort() || DEFAULT_PORT;
    const url = `http://localhost:${actualPort}`;
    console.log(`Already running (PID ${existingPid}) at ${url}`);
    if (shouldOpen) openBrowser(url);
    process.exit(0);
  }
  removePid();

  // Re-spawn self with --fg so the child owns the PID file
  const forwarded = [];
  if (portExplicit) forwarded.push('--port', String(port));
  if (hostExplicit) forwarded.push('--host', host);
  if (!shouldOpen) forwarded.push('--no-open');

  const child = spawn(
    process.execPath,
    [...process.argv.slice(1), '--fg', ...forwarded],
    { detached: true, stdio: 'ignore', windowsHide: true }
  );
  child.unref();

  // Parent exits immediately; child writes its own PID + port asynchronously
  const url = `http://localhost:${port}`;
  console.log(`project-knowledge starting in background at ${url}`);
  console.log(`Use "project-knowledge status" to check, "project-knowledge stop" to stop.`);
  if (shouldOpen) setTimeout(() => openBrowser(url), 1200);
  process.exit(0);
}

// ── Foreground: start server ──
process.env.KB_SITE_HOST = host;

async function main() {
  const actualPort = portExplicit ? port : await findFreePort(port);
  process.env.KB_SITE_PORT = String(actualPort);

  writePid(process.pid, actualPort);
  process.on('exit', removePid);
  process.on('SIGINT', () => { removePid(); process.exit(0); });
  process.on('SIGTERM', () => { removePid(); process.exit(0); });
  // Windows console-close sends SIGBREAK; Node doesn't run exit handlers after
  // a forceful TerminateProcess, but SIGBREAK does fire before the process is
  // torn down, so we can still clean up here.
  if (process.platform === 'win32') {
    process.on('SIGBREAK', () => { removePid(); process.exit(0); });
  }

  const url = `http://localhost:${actualPort}`;
  if (actualPort !== port) {
    console.log(`(Port ${port} was busy, using ${actualPort} instead)`);
  }
  console.log(`project-knowledge ${pkg.version}`);
  console.log(`Listening at ${url}`);
  // Resolve data dir the same way server.js will, so we can show the user
  // where their config and KB files live BEFORE the server boots.
  try {
    const { getDataDir } = require(path.join(__dirname, '..', '_site', 'lib', 'data-dir.js'));
    console.log(`Data dir: ${getDataDir()}`);
  } catch {}

  require(path.join(__dirname, '..', '_site', 'server.js'));

  if (shouldOpen) setTimeout(() => openBrowser(url), 500);
}

main().catch((err) => {
  console.error(err.message);
  removePid();
  process.exit(1);
});
