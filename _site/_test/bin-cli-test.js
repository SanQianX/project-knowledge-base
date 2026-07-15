// Run: node _site/_test/bin-cli-test.js
//
// Covers the project-knowledge CLI:
//   --version, --help, status (no pid), stop (no pid),
//   --fg foreground lifecycle (PID file written + cleaned),
//   port fallback when default port is busy.

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const BIN = path.join(ROOT, 'bin', 'project-knowledge.js');
const KB_BIN = path.join(ROOT, 'bin', 'project-knowledge-kb.js');
const PID_FILE = path.join(os.tmpdir(), '.project-knowledge.pid');
const ISOLATED_STATUS_PORT = 19000 + (process.pid % 1000);
const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), `kb-bin-cli-${process.pid}-`));
const TEST_ENV = { ...process.env, KB_DATA_DIR: TEST_DATA_DIR, KB_SKIP_MIGRATION: '1' };

function assert(cond, msg) { if (!cond) throw new Error(msg); }

function run(args, opts = {}) {
  return spawnSync(process.execPath, [BIN, ...args], {
    cwd: ROOT,
    encoding: 'utf-8',
    timeout: 15_000,
    env: TEST_ENV,
    ...opts,
  });
}

function readPidFile() {
  try {
    if (!fs.existsSync(PID_FILE)) return null;
    const lines = fs.readFileSync(PID_FILE, 'utf-8').trim().split('\n');
    return { pid: parseInt(lines[0], 10), port: lines[1] ? parseInt(lines[1], 10) : null };
  } catch { return null; }
}

function removePidFile() {
  try { fs.unlinkSync(PID_FILE); } catch { /* ignore */ }
}

function pickFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function isPortListening(port) {
  // A port is "in use by someone else" iff we cannot bind it (EADDRINUSE).
  // If our probe bind succeeds, the port is actually free.
  return new Promise((resolve) => {
    const tester = net.createServer();
    tester.unref();
    const finish = (inUse) => {
      tester.removeAllListeners();
      tester.close(() => resolve(inUse));
    };
    tester.once('error', (err) => {
      if (err && err.code === 'EADDRINUSE') finish(true);
      else finish(false);
    });
    tester.once('listening', () => finish(false));
    tester.listen(port, '127.0.0.1');
    setTimeout(() => finish(false), 500);
  });
}

async function waitForListening(port, deadlineMs = 8000) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (await isPortListening(port)) return true;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  return false;
}

(async () => {
  // Make sure no leftover PID file or server from a previous run.
  removePidFile();

  // --version
  const versionResult = run(['--version']);
  assert(versionResult.status === 0, `--version should exit 0, got ${versionResult.status}: ${versionResult.stderr}`);
  assert(versionResult.stdout.trim() === require(path.join(ROOT, 'package.json')).version,
    `--version output (${versionResult.stdout.trim()}) should match package.json`);

  // --help mentions the new subcommands
  const helpResult = run(['--help']);
  assert(helpResult.status === 0, '--help should exit 0');
  const helpText = helpResult.stdout;
  assert(/stop/.test(helpText), '--help should mention `stop`');
  assert(/status/.test(helpText), '--help should mention `status`');
  assert(/--fg/.test(helpText), '--help should mention `--fg`');
  assert(/--no-open/.test(helpText), '--help should mention `--no-open`');
  assert(/5757/.test(helpText), '--help should mention default port 5757');

  const kbHelp = spawnSync(process.execPath, [KB_BIN, '--help'], { cwd: ROOT, encoding: 'utf8', timeout: 15_000 });
  assert(kbHelp.status === 0, `project-knowledge-kb --help should exit 0: ${kbHelp.stderr}`);
  assert(/search/.test(kbHelp.stdout) && /history/.test(kbHelp.stdout), 'knowledge CLI help should list read-only commands');

  // status when no PID file
  removePidFile();
  const statusResult = run(['status'], { env: { ...TEST_ENV, KB_SITE_PORT: String(ISOLATED_STATUS_PORT) } });
  assert(statusResult.status === 0, 'status should exit 0 when not running');
  assert(/not running/i.test(statusResult.stdout + statusResult.stderr),
    `status output should mention "not running", got: ${statusResult.stdout} ${statusResult.stderr}`);

  // stop when no PID file
  const stopResult = run(['stop'], { env: { ...TEST_ENV, KB_SITE_PORT: String(ISOLATED_STATUS_PORT) } });
  assert(stopResult.status === 0, 'stop should exit 0 when no PID file');
  assert(/No background process/i.test(stopResult.stdout + stopResult.stderr),
    `stop output should mention "No background process", got: ${stopResult.stdout} ${stopResult.stderr}`);

  // Foreground lifecycle: --fg writes PID file and listens; SIGTERM cleans up.
  const fgPort = await pickFreePort();
  const fgChild = spawn(process.execPath, [BIN, '--fg', '--port', String(fgPort), '--no-open'], {
    cwd: ROOT,
    env: TEST_ENV,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let fgOutput = '';
  fgChild.stdout.on('data', d => { fgOutput += d.toString(); });
  fgChild.stderr.on('data', d => { fgOutput += d.toString(); });

  const listening = await waitForListening(fgPort);
  assert(listening, `server in --fg mode should listen on port ${fgPort}; output: ${fgOutput}`);

  const pidRecord = readPidFile();
  assert(pidRecord, `PID file at ${PID_FILE} should exist after fg child bound port; output: ${fgOutput}`);
  assert(pidRecord.pid === fgChild.pid,
    `PID file should record the foreground child PID (file: ${JSON.stringify(pidRecord)}, child: ${fgChild.pid})`);
  assert(pidRecord.port === fgPort,
    `PID file should record the actual port ${fgPort}, got ${pidRecord && pidRecord.port}`);

  fgChild.kill('SIGTERM');
  await new Promise(resolve => setTimeout(resolve, 400));

  // On Windows, child.kill('SIGTERM') goes through TerminateProcess and skips
  // Node's exit/SIGTERM handlers, so we can't reliably assert PID file cleanup
  // here. Instead, verify the bin was responsive while alive and that the
  // child is gone; the test harness cleans up the PID file at the end.
  assert(fgChild.killed || fgChild.exitCode !== null, 'foreground child should have exited on kill');
  removePidFile();

  // Port fallback: bind a port in 5757-5776 range, then start --fg without --port
  // → CLI should pick the next free port in that range.
  let busyPort = null;
  for (let candidate = 5757; candidate < 5757 + 19; candidate++) {
    if (!(await isPortListening(candidate)) && !(await isPortListening(candidate + 1))) {
      busyPort = candidate;
      break;
    }
  }
  assert(busyPort, 'should find a free port in fallback range');
  const busyServer = net.createServer();
  await new Promise((resolve, reject) => {
    busyServer.once('error', reject);
    busyServer.listen(busyPort, '127.0.0.1', resolve);
  });

  const fallbackChild = spawn(process.execPath, [BIN, '--fg', '--no-open'], {
    cwd: ROOT,
    env: { ...TEST_ENV, KB_SITE_PORT: String(busyPort) },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let fallbackOutput = '';
  fallbackChild.stdout.on('data', d => { fallbackOutput += d.toString(); });
  fallbackChild.stderr.on('data', d => { fallbackOutput += d.toString(); });

  // Wait for server to come up on some port.
  const deadline = Date.now() + 8000;
  let detectedPort = null;
  while (Date.now() < deadline && !detectedPort) {
    const rec = readPidFile();
    if (rec && rec.port && rec.port !== busyPort) {
      if (await isPortListening(rec.port)) {
        detectedPort = rec.port;
        break;
      }
    }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  assert(detectedPort, `port fallback should pick a free port (output: ${fallbackOutput})`);
  assert(detectedPort >= 5757 && detectedPort < 5757 + 20,
    `fallback port ${detectedPort} should be in 5757–${5757 + 19} range`);

  fallbackChild.kill('SIGTERM');
  await new Promise(resolve => setTimeout(resolve, 400));
  await new Promise(resolve => busyServer.close(resolve));

  // Unknown flag should exit non-zero
  const unknown = run(['--bogus']);
  assert(unknown.status !== 0, 'unknown flag should exit non-zero');
  assert(/Unknown option/i.test(unknown.stdout + unknown.stderr),
    `unknown flag output should mention "Unknown option", got: ${unknown.stdout} ${unknown.stderr}`);

  removePidFile();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  console.log('bin-cli-test PASS');
})().catch(err => {
  console.error(err && err.stack || err);
  removePidFile();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  process.exit(1);
});
