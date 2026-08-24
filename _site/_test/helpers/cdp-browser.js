const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const WebSocket = require('ws');

const MAX_STREAM_TAIL_BYTES = 32 * 1024;
const DEFAULT_HTTP_TIMEOUT_MS = 1000;
const DEFAULT_LAUNCH_TIMEOUT_MS = Number(process.env.KB_CDP_LAUNCH_TIMEOUT_MS || (process.platform === 'linux' ? 30000 : 20000));

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor(fn, label, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await fn();
      if (result) return result;
    } catch (error) {
      if (error && error.fatal) throw error;
      lastError = error;
    }
    await wait(100);
  }
  throw new Error("Timed out waiting for " + label + (lastError ? ": " + lastError.message : ""));
}

function requestJson(url, timeoutMs = DEFAULT_HTTP_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const request = http.get(url, response => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", chunk => { body += chunk; });
      response.on("end", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { resolve(JSON.parse(body)); }
        catch (error) { reject(error); }
      });
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const error = new Error("HTTP request timed out after " + timeoutMs + "ms: " + url);
      error.code = "ETIMEDOUT";
      request.destroy(error);
      reject(error);
    }, timeoutMs);
    request.on("error", error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
  });
}

function createBoundedTail(maxBytes = MAX_STREAM_TAIL_BYTES) {
  let buffer = Buffer.alloc(0);
  return {
    push(chunk) {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      if (buffer.length + data.length <= maxBytes) {
        buffer = Buffer.concat([buffer, data]);
      } else {
        buffer = Buffer.concat([buffer.slice(buffer.length + data.length - maxBytes), data]);
      }
    },
    text() { return buffer.toString("utf8"); },
  };
}

function hasExited(child) {
  return !child || child.exitCode !== null || child.signalCode !== null;
}

function isWindowsChromeLauncher(executable) {
  if (process.platform !== "win32") return false;
  return /(?:chrome|msedge)\.exe$/i.test(path.basename(String(executable || "")));
}

function platformLaunchArgs(platform = process.platform) {
  // GitHub Linux runners occasionally leave Chrome alive without publishing
  // DevToolsActivePort when its sandbox or shared-memory backing stalls.
  // These flags are scoped to isolated, disposable test browsers only.
  return platform === 'linux' ? ['--disable-dev-shm-usage', '--no-sandbox'] : [];
}

function waitForExit(child, timeoutMs = 3000) {
  if (hasExited(child)) return Promise.resolve();
  return new Promise(resolve => {
    const finish = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(finish, timeoutMs);
    child.once("exit", finish);
  });
}

function terminateProfileProcesses(profileDir) {
  if (process.platform !== "win32" || !profileDir) return;
  const command = "$profile = $env:PK_CDP_PROFILE; "
    + "Get-CimInstance Win32_Process -Filter \"Name = 'chrome.exe' OR Name = 'msedge.exe'\" "
    + "| Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($profile, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 } "
    + "| ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }";
  try {
    spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
      stdio: "ignore",
      timeout: 10000,
      windowsHide: true,
      env: { ...process.env, PK_CDP_PROFILE: profileDir },
    });
  } catch {}
}

async function terminateProcessTree(child, profileDir) {
  if (!hasExited(child) && process.platform === "win32" && child.pid) {
    try {
      spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", timeout: 10000 });
    } catch {}
  }
  if (!hasExited(child)) {
    try { child.kill(); } catch {}
    await waitForExit(child, 3000);
  }
  // Windows Chrome can detach from the launcher process. Always clean by the
  // unique test profile as well, otherwise later CDP launches become flaky.
  terminateProfileProcesses(profileDir);
}

function removeProfileDir(profileDir) {
  try {
    fs.rmSync(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {}
  return !fs.existsSync(profileDir);
}

async function cleanupSpawnedBrowser(child, profileDir) {
  try {
    await terminateProcessTree(child, profileDir);
  } catch {}
  if (profileDir) removeProfileDir(profileDir);
}

function enrichBrowserLaunchError(error, diagnostics) {
  const parts = ["Failed to launch CDP browser: " + (error && error.message ? error.message : String(error))];
  if (diagnostics.executable) parts.push("executable: " + diagnostics.executable);
  if (diagnostics.pid) parts.push("pid: " + diagnostics.pid);
  if (diagnostics.exitCode !== null && diagnostics.exitCode !== undefined) parts.push("exit code: " + diagnostics.exitCode);
  if (diagnostics.signal) parts.push("signal: " + diagnostics.signal);
  if (diagnostics.spawnError) parts.push("spawn error: " + diagnostics.spawnError);
  if (diagnostics.profileDir) parts.push("user-data-dir: " + diagnostics.profileDir);
  const stderrTail = String(diagnostics.stderrTail || "").trim();
  const stdoutTail = String(diagnostics.stdoutTail || "").trim();
  if (stderrTail) parts.push("stderr tail:\n" + stderrTail);
  if (stdoutTail) parts.push("stdout tail:\n" + stdoutTail);
  const enriched = new Error(parts.filter(Boolean).join("\n"));
  if (error) {
    enriched.cause = error;
    if (error.code) enriched.code = error.code;
  }
  enriched.diagnostics = diagnostics;
  return enriched;
}

function describeEarlyExit(exitInfo, spawnError) {
  if (spawnError) return "browser process failed to start: " + spawnError;
  const code = exitInfo && exitInfo.code !== null && exitInfo.code !== undefined ? String(exitInfo.code) : "unknown";
  const signal = exitInfo && exitInfo.signal ? " (signal " + exitInfo.signal + ")" : "";
  return "browser exited before exposing CDP (exit code " + code + signal + ")";
}

async function waitForDevToolsPort(profileDir, state, timeoutMs, tolerateLauncherExit) {
  const portFile = path.join(profileDir, "DevToolsActivePort");
  return waitFor(() => {
    let text;
    try { text = fs.readFileSync(portFile, "utf8"); } catch {}
    const port = Number.parseInt(String(text || "").split(/\r?\n/, 1)[0], 10);
    if (Number.isInteger(port) && port > 0) return port;
    if (state.exited && !tolerateLauncherExit) {
      const error = new Error(describeEarlyExit(state.exitInfo, state.spawnError));
      error.fatal = true;
      throw error;
    }
    return null;
  }, "DevToolsActivePort file", timeoutMs);
}

async function launchCdpBrowser(options) {
  const chrome = options.chrome;
  const profileDir = path.resolve(options.profileDir);
  const launchTimeoutMs = Number(options.launchTimeoutMs || DEFAULT_LAUNCH_TIMEOUT_MS);
  const explicitPort = Number(options.debugPort) > 0 ? Number(options.debugPort) : 0;
  const prependArgs = Array.isArray(options.prependArgs) ? options.prependArgs : [];
  const tolerateLauncherExit = isWindowsChromeLauncher(chrome);

  removeProfileDir(profileDir);
  fs.mkdirSync(profileDir, { recursive: true });

  const stdoutTail = createBoundedTail();
  const stderrTail = createBoundedTail();
  const state = { exited: false, exitInfo: null, spawnError: null };
  const diagnostics = {
    executable: chrome,
    pid: null,
    exitCode: null,
    signal: null,
    spawnError: null,
    profileDir,
    stdoutTail: "",
    stderrTail: "",
  };

  let child = null;
  let socket = null;

  const failLaunch = async (error) => {
    diagnostics.stdoutTail = stdoutTail.text();
    diagnostics.stderrTail = stderrTail.text();
    if (state.exitInfo) {
      diagnostics.exitCode = state.exitInfo.code;
      diagnostics.signal = state.exitInfo.signal;
    }
    if (state.spawnError) diagnostics.spawnError = state.spawnError;
    if (socket) { try { socket.close(); } catch {} }
    await cleanupSpawnedBrowser(child, profileDir);
    throw enrichBrowserLaunchError(error, diagnostics);
  };

  try {
    child = spawn(chrome, [
      ...prependArgs,
      ...platformLaunchArgs(),
      "--headless=new",
      "--disable-gpu",
      "--disable-background-networking",
      "--disable-default-apps",
      "--disable-extensions",
      "--no-first-run",
      "--no-default-browser-check",
      "--remote-debugging-port=" + explicitPort,
      "--user-data-dir=" + profileDir,
      "--window-size=" + Number(options.width || 1360) + "," + Number(options.height || 900),
      "about:blank",
    ], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    diagnostics.pid = child.pid;

    child.stdout.on("data", chunk => stdoutTail.push(chunk));
    child.stderr.on("data", chunk => stderrTail.push(chunk));
    child.on("error", error => {
      state.exited = true;
      state.spawnError = error && error.message ? error.message : String(error);
      if (!state.exitInfo) state.exitInfo = { code: null, signal: null };
    });
    child.on("exit", (code, signal) => {
      state.exited = true;
      state.exitInfo = { code, signal };
    });

    const debugPort = explicitPort || await waitForDevToolsPort(profileDir, state, launchTimeoutMs, tolerateLauncherExit);

    const pages = await waitFor(() => {
      if (state.exited && !tolerateLauncherExit) {
        const error = new Error(describeEarlyExit(state.exitInfo, state.spawnError));
        error.fatal = true;
        throw error;
      }
      return requestJson("http://127.0.0.1:" + debugPort + "/json").then(items => {
        const available = items.filter(item => item.type === "page");
        return available.length ? available : null;
      });
    }, "Chrome debugging page (port " + debugPort + ")", launchTimeoutMs);
    const page = pages[0];
    socket = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });

    let nextId = 1;
    const pending = new Map();
    const exceptions = [];
    const consoleErrors = [];
    socket.on("message", raw => {
      const message = JSON.parse(String(raw));
      if (message.method === "Runtime.exceptionThrown") exceptions.push(message.params);
      if (message.method === "Log.entryAdded" && message.params && message.params.entry && message.params.entry.level === "error") {
        consoleErrors.push(message.params.entry);
      }
      if (!message.id || !pending.has(message.id)) return;
      const callbacks = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) callbacks.reject(new Error(message.error.message));
      else callbacks.resolve(message.result || {});
    });

    function send(method, params) {
      return new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params: params || {} }));
      });
    }

    async function evaluate(expression) {
      const result = await send("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true,
      });
      if (result.exceptionDetails) {
        const detail = result.exceptionDetails.exception && result.exceptionDetails.exception.description;
        throw new Error(detail || result.exceptionDetails.text || "Browser evaluation failed");
      }
      return result.result ? result.result.value : undefined;
    }

    await send("Page.enable");
    await send("Runtime.enable");
    await send("Log.enable");
    await send("Page.navigate", { url: options.url });
    await waitFor(() => evaluate("document.readyState === 'complete'"), "page load");

    async function screenshot(filePath) {
      const result = await send("Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: false });
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, Buffer.from(result.data, "base64"));
    }

    async function setViewport(width, height, deviceScaleFactor = 1) {
      await send("Emulation.setDeviceMetricsOverride", {
        width,
        height,
        deviceScaleFactor,
        mobile: width < 620,
        screenWidth: width,
        screenHeight: height,
      });
    }

    async function close() {
      try { socket.close(); } catch {}
      await terminateProcessTree(child, profileDir);
      removeProfileDir(profileDir);
    }

    return { child, socket, send, evaluate, screenshot, setViewport, exceptions, consoleErrors, close };
  } catch (error) {
    await failLaunch(error);
  }
}

module.exports = { isWindowsChromeLauncher, platformLaunchArgs, launchCdpBrowser, requestJson, waitFor, wait };
