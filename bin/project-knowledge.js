#!/usr/bin/env node

// project-knowledge CLI — start in background by default (auto-opens browser).
// Pattern modeled on tokmeter's bin.js: detached child + PID file + port fallback.
// Run `project-knowledge --help` for usage.

const path = require('path');
const { spawn, exec, execSync } = require('child_process');
const { existsSync, readFileSync, writeFileSync, unlinkSync } = require('fs');
const net = require('net');
const os = require('os');
const { getDataDir } = require('../_site/lib/data-dir');
const runtimeEndpoint = require('../_site/lib/runtime-endpoint');

const pkg = require('../package.json');
const DEFAULT_PORT = parseInt(process.env.KB_SITE_PORT || '5757', 10);
const PORT_RANGE = 20;
const PID_FILE = path.join(os.tmpdir(), '.project-knowledge.pid');
const DATA_DIR = getDataDir();

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

function removePid(expectedPid) {
  try {
    if (expectedPid != null && readPid() !== Number(expectedPid)) return;
    unlinkSync(PID_FILE);
  } catch { /* ignore */ }
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

function isPortFree(port, host = '127.0.0.1') {
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
    tester.listen(port, host);
    setTimeout(() => finish(false), 1000);
  });
}

async function findFreePort(start, host = '127.0.0.1') {
  for (let offset = 0; offset < PORT_RANGE; offset++) {
    const port = start + offset;
    if (await isPortFree(port, host)) return port;
  }
  throw new Error(`No free port found in range ${start}-${start + PORT_RANGE - 1}`);
}

// Find PIDs whose TCP socket is LISTENING on `port`. Cross-platform wrapper
// around netstat / lsof / ss. Returns a deduped list, possibly empty.
function findListeningPids(port) {
  try {
    let cmd;
    if (process.platform === 'win32') {
      cmd = `netstat -ano | findstr ":${port} " | findstr "LISTENING"`;
    } else if (process.platform === 'darwin') {
      cmd = `lsof -nP -iTCP:${port} -sTCP:LISTEN -t 2>/dev/null`;
    } else {
      cmd = `ss -tlnpH 'sport = :${port}' 2>/dev/null | grep -oP 'pid=\\K[0-9]+'`;
    }
    const stdout = execSync(cmd, { windowsHide: true, encoding: 'utf8', timeout: 3000 });
    const pids = stdout.split(/\r?\n/).map((line) => {
      const nums = line.match(/\d+/g);
      return nums && nums.length ? parseInt(nums[nums.length - 1], 10) : null;
    }).filter(Boolean);
    return Array.from(new Set(pids));
  } catch {
    return [];
  }
}

// Read another process's command line so we can verify it's ours before
// killing it. Returns '' on any failure (permissions, process gone, etc).
function getProcessCommandLine(pid) {
  try {
    let cmd, stdout;
    if (process.platform === 'win32') {
      stdout = execSync(`wmic process where "ProcessId=${pid}" get CommandLine /value`,
        { windowsHide: true, encoding: 'utf8', timeout: 3000 });
      const m = stdout.match(/CommandLine=(.+)/);
      return m ? m[1].trim() : '';
    }
    stdout = execSync(`ps -p ${pid} -o args= 2>/dev/null`,
      { encoding: 'utf8', timeout: 3000 });
    return stdout.trim();
  } catch {
    return '';
  }
}

// Scan DEFAULT_PORT..+PORT_RANGE for a LISTENING PID whose command line looks
// like our server. Used as a fallback when the PID file is missing/stale so the
// CLI isn't blind to long-running orphans.
function findOrphanProcess() {
  const startPort = readPort() || DEFAULT_PORT;
  for (let offset = 0; offset < PORT_RANGE; offset++) {
    const port = startPort + offset;
    for (const candidate of findListeningPids(port)) {
      const cmdline = getProcessCommandLine(candidate).toLowerCase();
      if (cmdline.includes('project-knowledge') && cmdline.includes('node')) {
        return { pid: candidate, port };
      }
    }
  }
  return null;
}

// ── Subcommands ──
function cmdStop() {
  const endpoint = runtimeEndpoint.readLiveEndpoint(DATA_DIR);
  if (endpoint) {
    try {
      process.kill(endpoint.pid);
      runtimeEndpoint.clearEndpoint(DATA_DIR, { pid: endpoint.pid });
      if (readPid() === endpoint.pid) removePid(endpoint.pid);
      console.log(`project-knowledge stopped (PID ${endpoint.pid}).`);
    } catch {
      console.error(`Failed to stop process ${endpoint.pid}`);
      process.exit(1);
    }
    process.exit(0);
  }
  const pid = readPid();
  if (pid && isProcessAlive(pid)) {
    try {
      process.kill(pid);
      removePid();
      console.log(`project-knowledge stopped (PID ${pid}).`);
    } catch {
      console.error(`Failed to stop process ${pid}`);
      process.exit(1);
    }
    process.exit(0);
  }
  if (pid) {
    // Stale PID file — record pointed at a dead process. Drop it so the
    // orphan-scan below can take over without being misled.
    removePid();
    console.log('Process already stopped.');
  }

  // Fallback: the PID file can disappear (manual cleanup, antivirus, OS temp
  // cleanup) while the server keeps running. Without this scan the CLI has no
  // way to stop an orphan whose PID it never recorded.
  const orphan = findOrphanProcess();
  if (orphan) {
    try {
      process.kill(orphan.pid);
      console.log(`Stopped orphan project-knowledge (PID ${orphan.pid}) on port ${orphan.port}.`);
      process.exit(0);
    } catch {
      console.error(`Found PID ${orphan.pid} on port ${orphan.port} but failed to stop it.`);
      process.exit(1);
    }
  }
  console.log('No background process found.');
  process.exit(0);
}

function cmdStatus() {
  const endpoint = runtimeEndpoint.readLiveEndpoint(DATA_DIR);
  if (endpoint) {
    console.log(`project-knowledge is running (PID ${endpoint.pid}) at http://${endpoint.host}:${endpoint.port} [${endpoint.mode}]`);
    process.exit(0);
  }
  const pid = readPid();
  if (pid && isProcessAlive(pid)) {
    const port = readPort() || DEFAULT_PORT;
    console.log(`project-knowledge is running (PID ${pid}) at http://localhost:${port}`);
    process.exit(0);
  }
  if (pid) removePid();

  // PID file is gone or stale — check the port directly.
  const orphan = findOrphanProcess();
  if (orphan) {
    console.log(`project-knowledge is running (orphan, PID ${orphan.pid}) at http://localhost:${orphan.port}`);
    console.log('(No PID file on disk — recovered via port scan. Run "project-knowledge stop" to clean up.)');
    process.exit(0);
  }
  console.log('project-knowledge is not running.');
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
  const endpoint = runtimeEndpoint.readLiveEndpoint(DATA_DIR);
  if (endpoint) {
    const url = `http://${endpoint.host}:${endpoint.port}`;
    console.log(`Already running (PID ${endpoint.pid}) at ${url}`);
    if (shouldOpen) openBrowser(url);
    process.exit(0);
  }
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
  const existingEndpoint = runtimeEndpoint.readLiveEndpoint(DATA_DIR);
  if (existingEndpoint && existingEndpoint.pid !== process.pid) {
    console.log(`Already running (PID ${existingEndpoint.pid}) at http://${existingEndpoint.host}:${existingEndpoint.port}`);
    process.exit(0);
  }
  const actualPort = portExplicit ? port : await findFreePort(port, host);
  process.env.KB_SITE_PORT = String(actualPort);

  const claim = runtimeEndpoint.claimEndpoint(DATA_DIR, {
    pid: process.pid,
    host,
    port: actualPort,
    mode: process.env.KB_RUNTIME_MODE || 'cli',
  });
  if (!claim.claimed) {
    const active = claim.endpoint;
    if (active) {
      console.log(`Already running (PID ${active.pid}) at http://${active.host}:${active.port}`);
    } else {
      console.error('Another project-knowledge process is starting. Please try again in a moment.');
    }
    process.exit(active ? 0 : 1);
  }
  writePid(process.pid, actualPort);
  const cleanup = () => {
    removePid(process.pid);
    runtimeEndpoint.clearEndpoint(DATA_DIR, { pid: process.pid });
  };
  process.on('exit', cleanup);
  process.on('SIGINT', () => { cleanup(); process.exit(0); });
  process.on('SIGTERM', () => { cleanup(); process.exit(0); });
  // Windows console-close sends SIGBREAK; Node doesn't run exit handlers after
  // a forceful TerminateProcess, but SIGBREAK does fire before the process is
  // torn down, so we can still clean up here.
  if (process.platform === 'win32') {
    process.on('SIGBREAK', () => { cleanup(); process.exit(0); });
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
    console.log(`Data dir: ${getDataDir()}`);
  } catch {}

  require(path.join(__dirname, '..', '_site', 'server.js'));

  if (shouldOpen) setTimeout(() => openBrowser(url), 500);
}

main().catch((err) => {
  console.error(err.message);
  removePid(process.pid);
  runtimeEndpoint.clearEndpoint(DATA_DIR, { pid: process.pid });
  process.exit(1);
});
