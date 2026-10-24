'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const {
  app,
  BrowserWindow,
  Menu,
  Tray,
  dialog,
  ipcMain,
  nativeImage,
  session,
  shell,
} = require('electron');

// Squirrel invokes the executable with install/update/uninstall arguments.
// Exit before touching the backend so setup can create shortcuts without
// starting LanceDB or showing a window.
if (require('electron-squirrel-startup')) {
  app.quit();
} else {

const runtime = require('./lib/backend-runtime.cjs');

const coreRoot = runtime.resolveCoreRoot();
const corePkg = require(path.join(coreRoot, 'package.json'));
const coreCliPath = runtime.coreCliPath(coreRoot);
const endpointStore = require(path.join(coreRoot, '_site', 'lib', 'runtime-endpoint.js'));
const instances = require(path.join(coreRoot, '_site', 'lib', 'cli-instances.js'));

let mainWindow = null;
let tray = null;
let ownedBackend = null;
let ownedLogPath = null;
let ownedStartupPending = false;
let activeEndpoint = null;
let isQuitting = false;
let starting = false;

app.setName('Project Knowledge');
if (process.platform === 'win32') app.setAppUserModelId('com.sanqian.projectknowledge.desktop');
// Isolation hook for tests/CI: a separate userData dir also gives the
// instance its own single-instance-lock domain (the machine's real desktop
// app may be running). Must run before requestSingleInstanceLock.
if (process.env.KB_DESKTOP_USER_DATA_DIR) {
  try { app.setPath('userData', process.env.KB_DESKTOP_USER_DATA_DIR); } catch {}
}

const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) {
  app.quit();
} else {
  app.on('second-instance', () => showMainWindow());

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.png'));
  tray = new Tray(icon.resize({ width: 20, height: 20 }));
  tray.setToolTip('Project Knowledge');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开 Project Knowledge', click: showMainWindow },
    { type: 'separator' },
    { label: '退出', click: () => { isQuitting = true; app.quit(); } },
  ]));
  tray.on('double-click', showMainWindow);
}

const SPLASH_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;background:#0c1118;color:#e6edf3;font-family:system-ui,sans-serif;gap:14px}
h1{font-size:18px;font-weight:600;margin:0}p{color:#8b98a5;font-size:13px;margin:0}
.spin{width:26px;height:26px;border:3px solid #263041;border-top-color:#4f8cff;border-radius:50%;animation:r 1s linear infinite}@keyframes r{to{transform:rotate(360deg)}}
#status{min-height:1em;max-width:640px;text-align:center}
</style></head><body><div class="spin"></div><h1>Project Knowledge 正在启动</h1><p>正在连接本机知识库服务…</p><p id="status"></p><script>window.__kbStatus=function(t){document.getElementById('status').textContent=t;};</script></body></html>`;

function statusPage(kind, message, logPath) {
  const heading = kind === 'starting' ? '仍在启动' : '后台连接失败';
  const note = kind === 'starting' ? '后台进程仍在初始化（未判定失败），可等待或重试连接。' : '后台未能启动或已退出，详情见下方日志。';
  return `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;background:#0c1118;color:#e6edf3;font-family:system-ui,sans-serif;gap:12px;padding:24px}
h1{font-size:18px;font-weight:600;margin:0}p{color:#8b98a5;font-size:13px;margin:0;max-width:560px;text-align:center;white-space:pre-wrap}
button{margin-top:8px;padding:8px 22px;background:#1f6feb;border:0;border-radius:6px;color:#fff;font-size:14px;cursor:pointer}
code{color:#6e7681;font-size:11px;word-break:break-all}
</style></head><body><h1>${heading}</h1><p>${String(message).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))}</p><p>${note}</p>${logPath ? `<code>${logPath}</code>` : ''}<button onclick="desktopBridge.retry()">重试连接</button></body></html>`;
}

function configureSecurity() {
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (runtime.isAllowedExternalUrl(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!activeEndpoint || !runtime.isAllowedNavigation(url, activeEndpoint)) {
      event.preventDefault();
      if (runtime.isAllowedExternalUrl(url)) shell.openExternal(url);
    }
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1080,
    minHeight: 720,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#0c1118',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, 'preload.cjs'),
      devTools: !app.isPackaged,
    },
  });
  configureSecurity();
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('close', event => {
    if (isQuitting) return;
    event.preventDefault();
    mainWindow.hide();
  });
  mainWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(SPLASH_HTML));
}

function dataDir(override) {
  return runtime.coreDataDir(coreRoot, override || process.env.KB_DATA_DIR_DESKTOP);
}

// R10 slow-startup patience: a live-but-not-yet-answering backend is STARTING,
// never a failure. All waits below fail fast only when a process actually
// dies, and surface honest still-starting states at the patience deadline.
function connectPatienceMs() {
  // R12: a NaN budget (malformed env) would disable every deadline at once;
  // invalid values fall back and absurd values clamp to one hour.
  const value = Number(process.env.KB_DESKTOP_CONNECT_PATIENCE_MS);
  if (!Number.isFinite(value) || value <= 0) return 600000;
  return Math.min(value, 3600000);
}

function setStartupStatus(text) {
  console.log(`[desktop] ${text}`);
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    const url = mainWindow.webContents.getURL();
    if (!url.startsWith('data:')) return;
    mainWindow.webContents.executeJavaScript(`window.__kbStatus ? window.__kbStatus(${JSON.stringify(text)}) : 0`).catch(() => {});
  } catch {}
}

function tailLog(logPath, maxChars = 1200) {
  try {
    const stat = fs.statSync(logPath);
    const length = Math.min(stat.size, maxChars * 3);
    const fd = fs.openSync(logPath, 'r');
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, stat.size - length);
    fs.closeSync(fd);
    return buffer.toString('utf8').slice(-maxChars).trim();
  } catch {
    return '';
  }
}

function versionMismatchError(existing) {
  return Object.assign(new Error(
    `已有一个 ${existing.version} 版本的知识库后台正在运行（PID ${existing.pid}，端口 ${existing.port}）。` +
    `桌面版内置核心为 ${corePkg.version}，为避免双写已拒绝启动第二个后台。` +
    `请先停止旧实例（project-knowledge stop）或升级后再试。`
  ), { code: 'DESKTOP_VERSION_MISMATCH' });
}

async function connectExistingInstance(dir, live) {
  const result = await runtime.waitForInstanceControl({
    probe: () => instances.current(dir),
    endpoint: live,
    isAlive: pid => endpointStore.isProcessAlive(pid),
    timeoutMs: connectPatienceMs(),
    intervalMs: 750,
    onProgress: elapsed => setStartupStatus(`检测到现有后台（PID ${live.pid}）正在初始化或繁忙，正在连接… 已等待 ${Math.round(elapsed / 1000)}s`),
  });
  if (result.status === 'answered') {
    if (runtime.versionState(corePkg.version, result.instance.version) === 'mismatch') throw versionMismatchError(result.instance);
    return { endpoint: { host: result.instance.host, port: result.instance.port }, owned: false };
  }
  if (result.status === 'refused') throw result.error;
  if (result.status === 'gone') return null;
  throw Object.assign(new Error(
    `现有后台（PID ${live.pid}，端口 ${live.port}）仍在启动或繁忙，控制通道暂未响应（已等待 ${Math.round(result.elapsedMs / 1000)}s）。` +
    `为避免双写未启动第二个后台。`
  ), { code: 'DESKTOP_BACKEND_BUSY' });
}

async function resolveBackend() {
  const dir = dataDir();
  const live = endpointStore.readLiveEndpoint(dir, { removeStale: false });
  // A live endpoint proves some backend owns this data directory: never spawn
  // a second one, even while its control channel is busy starting up.
  if (live) {
    const reused = await connectExistingInstance(dir, live);
    if (reused) return reused;
  }

  const started = runtime.spawnBackend({
    executable: process.execPath,
    cliPath: coreCliPath,
    dataDir: dir,
    cwd: path.dirname(process.execPath),
  });
  ownedBackend = started.child;
  ownedLogPath = started.logPath;
  ownedStartupPending = true;
  ownedBackend.once('exit', () => {
    // showErrorBox is a blocking modal on Windows: while the startup waits
    // below still own the process they surface exits honestly on the status
    // page; the modal is reserved for post-ready crashes.
    if (ownedStartupPending) return;
    if (!isQuitting && mainWindow && !mainWindow.isDestroyed()) {
      dialog.showErrorBox('Project Knowledge 后端已停止', `桌面后端意外退出。诊断日志：${ownedLogPath}`);
    }
  });
  const childAlive = () => ownedBackend.exitCode === null;

  try {
    const publication = await runtime.waitForBackendEndpoint({
      readEndpoint: () => endpointStore.readLiveEndpoint(dir, { removeStale: false }),
      ownedPid: ownedBackend.pid,
      isAlive: childAlive,
      timeoutMs: connectPatienceMs(),
      intervalMs: 250,
      onProgress: elapsed => setStartupStatus(`等待后台发布运行端点… 已等待 ${Math.round(elapsed / 1000)}s（进程运行中）`),
    });
    if (publication.status === 'exited') {
      const tail = tailLog(ownedLogPath);
      throw Object.assign(new Error(`后台进程在发布端点前退出（exit ${ownedBackend.exitCode}）。${tail ? `日志尾部：\n${tail}` : `诊断日志：${ownedLogPath}`}`), { code: 'DESKTOP_BACKEND_EXITED' });
    }
    if (publication.status === 'taken') {
      const reused = await connectExistingInstance(dir, publication.endpoint);
      if (reused) return reused;
      throw Object.assign(new Error(`端口被另一实例占用且控制通道不可用（PID ${publication.endpoint.pid}）。`), { code: 'DESKTOP_BACKEND_BUSY' });
    }
    if (publication.status === 'timeout') {
      throw Object.assign(new Error(
        `后台进程 ${Math.round(publication.elapsedMs / 1000)}s 内未能发布运行端点（进程仍存活，未判定失败）。诊断日志：${ownedLogPath}`
      ), { code: 'DESKTOP_BACKEND_STILL_STARTING' });
    }

    const endpoint = publication.endpoint;
    setStartupStatus('后台端点已发布，正在确认服务响应…');
    try {
      await runtime.waitForHttpReadyGuarded({
        host: endpoint.host,
        port: endpoint.port,
        timeoutMs: connectPatienceMs(),
        intervalMs: 250,
        isAlive: childAlive,
        onProgress: (elapsed, lastError) => setStartupStatus(`等待本机服务响应… 已等待 ${Math.round(elapsed / 1000)}s（进程运行中${lastError ? '，' + lastError.message : ''}）`),
      });
    } catch (error) {
      if (error.code === 'DESKTOP_BACKEND_EXITED') {
        const tail = tailLog(ownedLogPath);
        error.message += tail ? `\n日志尾部：\n${tail}` : `\n诊断日志：${ownedLogPath}`;
      }
      throw error;
    }
    return { endpoint, owned: true };
  } finally {
    ownedStartupPending = false;
  }
}

async function boot() {
  if (starting) return;
  starting = true;
  try {
    const { endpoint, owned } = await resolveBackend();
    activeEndpoint = endpoint;
    if (owned) console.log(`[desktop] owned backend ready at ${runtime.endpointUrl(endpoint)} (log: ${ownedLogPath})`);
    else console.log(`[desktop] reusing backend at ${runtime.endpointUrl(endpoint)}`);
    if (!mainWindow || mainWindow.isDestroyed()) createWindow();
    await mainWindow.loadURL(runtime.endpointUrl(endpoint));
  } catch (error) {
    if (error.code === 'DESKTOP_VERSION_MISMATCH') {
      dialog.showErrorBox('版本不匹配', error.message);
      isQuitting = true;
      app.quit();
      return;
    }
    if (!mainWindow || mainWindow.isDestroyed()) createWindow();
    // Still-starting states are honest progress pages, not failures; only
    // definitive outcomes (process exited, semantic refusal, core missing)
    // render the failure page.
    const kind = ['DESKTOP_BACKEND_BUSY', 'DESKTOP_BACKEND_STILL_STARTING'].includes(error.code) ? 'starting' : 'failed';
    if (kind === 'starting') console.log(`[desktop] still starting: ${error.message}`);
    else console.error(`[desktop] backend failed: ${error.message}`);
    await mainWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(statusPage(kind, error.message, ownedLogPath)));
  } finally {
    starting = false;
  }
}

async function stopOwnedBackend() {
  if (!ownedBackend || ownedBackend.exitCode !== null) return;
  // Delegate to the core's verified stop protocol; the desktop never kills
  // PIDs itself and never touches a backend it does not own.
  await new Promise(resolve => {
    const child = spawn(process.execPath, [coreCliPath, 'stop'], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', KB_DATA_DIR: dataDir() },
      windowsHide: true,
      stdio: 'ignore',
    });
    const timer = setTimeout(() => { child.kill(); resolve(); }, 45000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    child.once('error', () => { clearTimeout(timer); resolve(); });
  });
}

app.whenReady().then(() => {
  ipcMain.handle('desktop:retry', () => { boot(); return true; });
  ipcMain.handle('project-knowledge:open-external', (_event, url) => {
    if (runtime.isAllowedExternalUrl(url)) shell.openExternal(url);
    return true;
  });
  createWindow();
  createTray();
  boot();
});

app.on('window-all-closed', () => {
  // Tray keeps the app alive; knowledge maintenance continues.
});

app.on('before-quit', event => {
  if (isQuitting) return;
  event.preventDefault();
  isQuitting = true;
  stopOwnedBackend().finally(() => app.quit());
});

}
}
