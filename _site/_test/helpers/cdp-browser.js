const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');

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
      lastError = error;
    }
    await wait(100);
  }
  throw new Error("Timed out waiting for " + label + (lastError ? ": " + lastError.message : ""));
}

function requestJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, response => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", chunk => { body += chunk; });
      response.on("end", () => {
        try { resolve(JSON.parse(body)); }
        catch (error) { reject(error); }
      });
    }).on("error", reject);
  });
}

async function launchCdpBrowser(options) {
  const chrome = options.chrome;
  const debugPort = Number(options.debugPort);
  const profileDir = path.resolve(options.profileDir);
  fs.rmSync(profileDir, { recursive: true, force: true });
  fs.mkdirSync(profileDir, { recursive: true });

  const child = spawn(chrome, [
    "--headless=new",
    "--disable-gpu",
    "--disable-background-networking",
    "--disable-default-apps",
    "--disable-extensions",
    "--no-first-run",
    "--no-default-browser-check",
    "--remote-debugging-port=" + debugPort,
    "--user-data-dir=" + profileDir,
    "--window-size=" + Number(options.width || 1360) + "," + Number(options.height || 900),
    "about:blank",
  ], { stdio: "ignore", windowsHide: true });

  const pages = await waitFor(
    () => requestJson("http://127.0.0.1:" + debugPort + "/json").then(items => {
      const available = items.filter(item => item.type === "page");
      return available.length ? available : null;
    }),
    "Chrome debugging page",
  );
  const page = pages[0];
  const socket = new WebSocket(page.webSocketDebuggerUrl);
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
    try { child.kill(); } catch {}
    await wait(100);
    try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch {}
  }

  return { child, socket, send, evaluate, screenshot, setViewport, exceptions, consoleErrors, close };
}

module.exports = { launchCdpBrowser, requestJson, waitFor, wait };
