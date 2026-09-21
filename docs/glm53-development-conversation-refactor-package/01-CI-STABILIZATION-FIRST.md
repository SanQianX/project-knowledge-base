# 01 — CI STABILIZATION FIRST

## T00 — Fix the recurring Windows browser/CDP CI failure before feature work

### Why T00 is mandatory

Observed failing workflow:

- repository: `SanQianX/project-knowledge-base`
- workflow: `Non-release validation`
- run: `32155087359`
- branch: `refactor/project-knowledge-v13`
- commit: `497fd2f135fd0c05ff79d3ea64ef1ab00bbe429e`
- failed lane: `Core (web runtime) / Node 18.x / Windows`

The suite executed 73 tests:

```text
72 PASS
1 FAIL
```

Only failure:

```text
project-control-panel-task14-test.js
```

Observed failure:

```text
Error: Timed out waiting for Chrome debugging page:
connect ECONNREFUSED 127.0.0.1:10212
```

The test was reported as approximately:

```text
300013 ms
exit null
```

The same test on Windows Node 24 in the same workflow run passed in about 6 seconds.

This is primarily a **test infrastructure failure**, not a Knowledge Base functional failure.

Current `v4.2.2` workflow already removed the Windows Node 18 matrix and keeps Windows Node 24 only. Do not re-add Windows Node 18 as part of this feature refactor unless a separate compatibility requirement explicitly asks for it.

However, the underlying CDP helper bug still exists in `v4.2.2`, so T00 must fix it rather than merely relying on removal of the Node 18 Windows lane.

---

## T00.1 Root Cause Contract

Before editing, the agent must understand and preserve this diagnosis:

1. `_site/_test/helpers/cdp-browser.js` spawns Chrome/Edge.
2. It waits for `http://127.0.0.1:<port>/json`.
3. If Chrome never exposes CDP, the helper throws.
4. `launchCdpBrowser()` throws before returning the `browser` object.
5. Caller `project-control-panel-task14-test.js` only calls `browser.close()` when `browser` was successfully assigned.
6. Therefore the spawned Chrome process may remain alive on launch failure.
7. `_site/_test/run-all-tests.js` runs each test as a child process with a large outer timeout; the leaked Chrome/child handle can keep the failed test process alive until the outer timeout.
8. `stdio: 'ignore'` discards the most useful Chrome startup diagnostics.
9. Fixed PID-derived debug ports are an unnecessary collision/race risk.

The fix must address **failure cleanup + diagnostics + port discovery**, not just increase timeouts.

---

## T00.2 Files to inspect before editing

Project-Knowledge only:

```text
_site/_test/helpers/cdp-browser.js
_site/_test/helpers/find-chrome.js
_site/_test/project-control-panel-task14-test.js
_site/_test/run-all-tests.js
.github/workflows/ci.yml
package.json
```

Also search for every caller of:

```text
launchCdpBrowser
findChrome
requestJson
```

Do not assume only Task14 uses these helpers.

---

## T00.3 Required `cdp-browser.js` behavior

### A. Always-cleanup launch lifecycle

Refactor `launchCdpBrowser()` so any failure after `spawn()` executes cleanup before rethrow.

Required structure conceptually:

```js
let child = null;
try {
  child = spawn(...);
  // wait for browser / CDP
  // connect websocket
  // navigate page
  return browserHandle;
} catch (error) {
  await cleanupSpawnedBrowser(child, profileDir);
  throw enrichBrowserLaunchError(error, diagnostics);
}
```

No code path may leave the spawned browser alive after launch initialization fails.

### B. Child process diagnostics

Do not use:

```js
stdio: 'ignore'
```

for browser startup.

Capture stdout/stderr with bounded memory.

Recommended:

```js
stdio: ['ignore', 'pipe', 'pipe']
```

Keep only a bounded tail such as 16–32 KiB per stream.

Listen to:

- `error`
- `exit`
- `close`

If the browser exits before CDP becomes ready, fail immediately rather than waiting the full launch timeout.

Error message must include at least:

```text
browser executable path
PID if available
exit code
signal
stderr tail
selected user-data-dir
```

Do not leak full environment variables or secrets into logs.

### C. Use dynamic CDP port

Preferred implementation:

```text
--remote-debugging-port=0
```

Chrome writes the selected port to:

```text
<profileDir>/DevToolsActivePort
```

Algorithm:

1. spawn with port `0`;
2. wait for `DevToolsActivePort`;
3. parse first line as integer port;
4. poll `http://127.0.0.1:<port>/json/list` or `/json`;
5. connect page WebSocket.

If the installed Chrome/Edge version unexpectedly does not support this path, use a real free-port allocator. Do **not** return to `10100 + pid % 200` as the default.

### D. HTTP request timeout

`requestJson()` must have a short per-request timeout, e.g. 1000 ms.

It must destroy the request on timeout and reject with a useful error.

A single stuck socket must not consume the whole launch timeout.

### E. Launch timeout

Keep a bounded launch timeout, default around 15–20 seconds.

Expose through an optional parameter/env only if useful for CI diagnostics.

Do **not** solve the issue by making it 60/120/300 seconds.

### F. Windows process-tree cleanup

On Windows, `child.kill()` is not always sufficient if Chromium created children.

Implement a cleanup helper that attempts graceful kill then, if necessary, process-tree termination, e.g. `taskkill /PID <pid> /T /F`.

Requirements:

- cleanup is best effort;
- cleanup errors must not replace the original test failure;
- non-Windows path must remain portable.

### G. Profile cleanup

Delete profile directory on both successful `close()` and failed launch cleanup.

Use retries/best-effort on Windows file locking rather than leaking temp directories.

---

## T00.4 Required `find-chrome.js` behavior

Remove the personal hard-coded path:

```text
C:\Users\SanQian\AppData\Local\ms-playwright\...
```

Shared repository tests must not contain a developer-specific absolute browser path.

Candidate order should be:

1. `KB_CHROME_PATH`
2. standard Chrome installation paths
3. standard Edge installation paths
4. standard Linux Chromium/Chrome paths
5. standard macOS Chrome path

Optional but recommended diagnostics function:

```js
findChromeDetailed()
```

returning:

```js
{
  path,
  source
}
```

Do not shell-execute arbitrary candidate strings.

---

## T00.5 Required test-runner hardening

Inspect `_site/_test/run-all-tests.js`.

Requirements:

1. Make per-test timeout configurable, e.g.:

```text
PK_TEST_TIMEOUT_MS
```

2. Default should be materially lower than 300 seconds for ordinary tests, recommended 60–90 seconds unless an existing known test legitimately requires more.
3. Report timeout explicitly:

```text
TIMEOUT
```

instead of only:

```text
exit null
```

4. Include child `signal`, error code and output tail in failure report.
5. Do not kill the whole suite on first failure unless existing behavior requires it; continue collecting failures as current runner does.

Do not hide a real slow test by simply increasing the timeout.

---

## T00.6 New deterministic failure test

Create a helper regression test, suggested name:

```text
_site/_test/cdp-browser-failure-test.js
```

It must not depend on an actual broken GitHub runner.

Test scenario:

1. Launch `launchCdpBrowser()` with a fake executable or controlled helper process that exits immediately and never exposes CDP.
2. Assert the promise rejects quickly, target < 5 seconds for immediate-exit fixture.
3. Assert error contains early-exit diagnostic data.
4. Assert no spawned child remains alive.
5. Assert profile directory is cleaned.

Add a second scenario if practical:

- process stays alive but never exposes CDP;
- launch timeout occurs;
- cleanup kills it;
- total test duration stays bounded.

Do not mark test skipped on Windows.

---

## T00.7 Existing UI test verification

Run at least:

```text
node _site/_test/project-control-panel-task14-test.js
node _site/_test/ui-smoke-test.js
node _site/_test/task15-20-ui-flow-test.js
node _site/_test/cdp-browser-failure-test.js
```

Run each multiple times if feasible, especially the browser helper tests.

Then run full:

```text
npm test -- --no-report
```

---

## T00.8 Workflow policy

For current `v4.2.2` behavior:

- Linux Node 18 + 24 may remain as compatibility matrix.
- Windows web-runtime job may remain Node 24 only.
- Do not add unnecessary 4-way matrix expansion during this feature refactor.
- Do not use CI workflow changes as a substitute for fixing browser cleanup.

If a future requirement needs Windows Node 18, it can be reintroduced only after T00 helper tests prove deterministic failure behavior.

---

## T00.9 Acceptance Criteria

T00 PASS only if:

- [ ] Failed browser start leaves no Chrome/Edge child process.
- [ ] Failed browser start reports browser stderr/exit diagnostics.
- [ ] CDP port is dynamically allocated/discovered.
- [ ] HTTP polling has per-request timeout.
- [ ] No developer-specific hard-coded Chrome path remains.
- [ ] A deterministic failure test proves fast cleanup.
- [ ] Task14 browser test passes locally/CI target environment.
- [ ] Full PK test suite passes.
- [ ] `git diff --check` passes.
- [ ] CI helper failure can no longer consume the old ~300-second outer timeout under normal launch failure.

After T00 passes, proceed to Development Conversation tasks. Do not interleave T00 with Bridge architecture changes.
