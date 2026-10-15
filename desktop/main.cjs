'use strict';
const path = require('node:path');
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
let activeEndpoint = null;
let isQuitting = false;
let starting = false;

app.setName('Project Knowledge');
if (process.platform === 'win32') app.setAppUserModelId('com.sanqian.projectknowledge.desktop');

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
</style></head><body><div class="spin"></div><h1>Project Knowledge 正在启动</h1><p>正在连接本机知识库服务…</p></body></html>`;

function errorPage(message, logPath) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;background:#0c1118;color:#e6edf3;font-family:system-ui,sans-serif;gap:12px;padding:24px}
h1{font-size:18px;font-weight:600;margin:0}p{color:#8b98a5;font-size:13px;margin:0;max-width:560px;text-align:center;white-space:pre-wrap}
button{margin-top:8px;padding:8px 22px;background:#1f6feb;border:0;border-radius:6px;color:#fff;font-size:14px;cursor:pointer}
code{color:#6e7681;font-size:11px;word-break:break-all}
</style></head><body><h1>后台连接失败</h1><p>${String(message).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))}</p>${logPath ? `<code>${logPath}</code>` : ''}<button onclick="desktopBridge.retry()">重试连接</button></body></html>`;
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

async function resolveBackend() {
  const dir = dataDir();
  const existing = await instances.current(dir);
  if (existing) {
    const state = runtime.versionState(corePkg.version, existing.version);
    if (state === 'mismatch') {
      throw Object.assign(new Error(
        `已有一个 ${existing.version} 版本的知识库后台正在运行（PID ${existing.pid}，端口 ${existing.port}）。` +
        `桌面版内置核心为 ${corePkg.version}，为避免双写已拒绝启动第二个后台。` +
        `请先停止旧实例（project-knowledge stop）或升级后再试。`
      ), { code: 'DESKTOP_VERSION_MISMATCH' });
    }
    // Verified compatible instance (typically the web CLI): reuse it.
    return { endpoint: { host: existing.host, port: existing.port }, owned: false };
  }

  const started = runtime.spawnBackend({
    executable: process.execPath,
    cliPath: coreCliPath,
    dataDir: dir,
    cwd: path.dirname(process.execPath),
  });
  ownedBackend = started.child;
  ownedLogPath = started.logPath;
  ownedBackend.once('exit', () => {
    if (!isQuitting && mainWindow && !mainWindow.isDestroyed()) {
      dialog.showErrorBox('Project Knowledge 后端已停止', `桌面后端意外退出。诊断日志：${ownedLogPath}`);
    }
  });

  const deadline = Date.now() + 180000;
  let endpoint = null;
  while (Date.now() < deadline && !endpoint) {
    const found = endpointStore.readLiveEndpoint(dir, { removeStale: false });
    if (found && found.pid === ownedBackend.pid) endpoint = found;
    else await new Promise(resolve => setTimeout(resolve, 250));
  }
  if (!endpoint) throw Object.assign(new Error('后台进程未能发布运行端点。'), { code: 'DESKTOP_BACKEND_TIMEOUT' });
  await runtime.waitForHttpReady({ host: endpoint.host, port: endpoint.port, timeoutMs: 120000 });
  return { endpoint, owned: true };
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
    await mainWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(errorPage(error.message, ownedLogPath)));
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
