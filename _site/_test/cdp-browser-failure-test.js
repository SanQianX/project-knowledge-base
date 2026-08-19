// Regression test for CDP browser launch failures (T00):
// - browser that exits immediately must fail fast with exit/stderr diagnostics
// - browser that stays alive but never exposes CDP must hit the launch timeout,
//   then be killed and cleaned up
// - in both cases: no child process remains alive, profile dir is removed.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { launchCdpBrowser } = require('./helpers/cdp-browser');

const FIXTURE_EXIT = path.join(__dirname, 'fixtures', 'fake-browser-exit.js');
const FIXTURE_HANG = path.join(__dirname, 'fixtures', 'fake-browser-hang.js');
const FAST_FAIL_BUDGET_MS = 5000;

function isPidAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

async function waitForPidExit(pid, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return false;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return isPidAlive(pid);
}

async function expectLaunchFailure(scenario) {
  const pidFile = path.join(os.tmpdir(), `pk-cdp-failure-${scenario}-pid-${process.pid}.txt`);
  const profileDir = path.join(os.tmpdir(), `pk-cdp-failure-${scenario}-profile-${process.pid}`);
  process.env.KB_FAKE_BROWSER_PIDFILE = pidFile;
  try {
    const start = Date.now();
    let error = null;
    try {
      await launchCdpBrowser(scenario.options(profileDir));
    } catch (caught) {
      error = caught;
    }
    const durationMs = Date.now() - start;
    assert(error, `${scenario.name}: launchCdpBrowser must reject`);
    assert(durationMs < FAST_FAIL_BUDGET_MS, `${scenario.name}: must fail fast, took ${durationMs}ms`);
    const message = error.message;
    assert(message.includes(process.execPath), `${scenario.name}: error must include executable path, got: ${message}`);
    assert(message.includes(profileDir), `${scenario.name}: error must include user-data-dir, got: ${message}`);
    scenario.assertions(message, durationMs);
    assert(!fs.existsSync(profileDir), `${scenario.name}: profile dir must be cleaned after failed launch`);
    assert(fs.existsSync(pidFile), `${scenario.name}: fixture pid file missing; cannot verify cleanup`);
    const pid = Number.parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
    const stillAlive = await waitForPidExit(pid);
    assert(!stillAlive, `${scenario.name}: spawned child pid ${pid} still alive after failure cleanup`);
    return durationMs;
  } finally {
    delete process.env.KB_FAKE_BROWSER_PIDFILE;
    try { fs.rmSync(pidFile, { force: true }); } catch {}
    try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch {}
  }
}

(async () => {
  const exitDuration = await expectLaunchFailure({
    name: 'immediate-exit',
    options: profileDir => ({
      chrome: process.execPath,
      prependArgs: [FIXTURE_EXIT],
      profileDir,
      url: 'http://127.0.0.1:1/',
    }),
    assertions(message) {
      assert(message.includes('exit code: 3'), `immediate-exit: error must contain exit code, got: ${message}`);
      assert(message.includes('fake-browser-exit stderr: simulated browser crash before CDP'), `immediate-exit: error must contain stderr tail, got: ${message}`);
    },
  });
  console.log(`cdp-browser immediate-exit failure test PASS (${exitDuration}ms)`);

  const hangDuration = await expectLaunchFailure({
    name: 'hang-timeout',
    options: profileDir => ({
      chrome: process.execPath,
      prependArgs: [FIXTURE_HANG],
      profileDir,
      url: 'http://127.0.0.1:1/',
      launchTimeoutMs: 1500,
    }),
    assertions(message, durationMs) {
      assert(message.includes('DevToolsActivePort'), `hang-timeout: error must mention DevToolsActivePort wait, got: ${message}`);
      assert(durationMs < FAST_FAIL_BUDGET_MS, `hang-timeout: bounded duration, took ${durationMs}ms`);
    },
  });
  console.log(`cdp-browser hang-timeout failure test PASS (${hangDuration}ms)`);
})().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
