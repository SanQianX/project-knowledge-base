const path = require('path');
const {
  app,
  BrowserWindow,
  Menu,
  Tray,
  dialog,
  nativeImage,
  session,
  shell,
} = require('electron');
const backendRuntime = require('./lib/backend-runtime.cjs');

const corePackagePath = require.resolve('project-knowledge/package.json');
const coreRoot = path.dirname(corePackagePath);
const { getDataDir } = require(path.join(coreRoot, '_site', 'lib', 'data-dir.js'));
const runtimeEndpoint = require(path.join(coreRoot, '_site', 'lib', 'runtime-endpoint.js'));

let mainWindow = null;
let tray = null;
let ownedBackend = null;
let activeEndpoint = null;
let isQuitting = false;

app.setName('Project Knowledge');
if (process.platform === 'win32') app.setAppUserModelId('com.sanqian.projectknowledge');

const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) {
  app.quit();
} else {
  app.on('second-instance', () => showMainWindow());
}

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
    {
      label: '退出',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]));
  tray.on('double-click', showMainWindow);
}

function configureSecurity(endpoint) {
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (backendRuntime.isAllowedExternalUrl(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (backendRuntime.isAllowedNavigation(url, endpoint)) return;
    event.preventDefault();
    if (backendRuntime.isAllowedExternalUrl(url)) shell.openExternal(url);
  });
}

function createWindow(endpoint) {
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
      devTools: !app.isPackaged,
    },
  });
  configureSecurity(endpoint);
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('close', event => {
    if (isQuitting) return;
    event.preventDefault();
    mainWindow.hide();
  });
  mainWindow.loadURL(backendRuntime.endpointUrl(endpoint));
}

async function resolveBackend() {
  const dataDir = getDataDir();
  const existing = runtimeEndpoint.readLiveEndpoint(dataDir);
  if (existing) {
    // A CLI instance may still be starting. Reuse it instead of opening a
    // second LanceDB writer.
    return backendRuntime.waitForBackend({
      readLiveEndpoint: runtimeEndpoint.readLiveEndpoint,
      dataDir,
      timeoutMs: 20000,
    });
  }

  const port = await backendRuntime.findFreePort(Number(process.env.KB_SITE_PORT || 5757), 20);
  const cliPath = path.join(coreRoot, 'bin', 'project-knowledge.js');
  const started = backendRuntime.spawnBackend({
    executable: process.execPath,
    cliPath,
    dataDir,
    port,
    cwd: path.dirname(process.execPath),
  });
  ownedBackend = started.child;
  ownedBackend.once('exit', () => {
    if (!isQuitting && mainWindow && !mainWindow.isDestroyed()) {
      dialog.showErrorBox(
        'Project Knowledge 后端已停止',
        `桌面后端意外退出。诊断日志：${started.logPath}`
      );
    }
  });
  return backendRuntime.waitForOwnedBackend({
    child: ownedBackend,
    readLiveEndpoint: runtimeEndpoint.readLiveEndpoint,
    dataDir,
    timeoutMs: 45000,
    expectedPid: ownedBackend.pid,
  });
}

function stopOwnedBackend() {
  if (!ownedBackend) return;
  const pid = ownedBackend.pid;
  try { ownedBackend.kill(); } catch {}
  runtimeEndpoint.clearEndpoint(getDataDir(), { pid });
  ownedBackend = null;
}

if (singleInstance) app.whenReady().then(async () => {
  try {
    activeEndpoint = await resolveBackend();
    createTray();
    createWindow(activeEndpoint);
  } catch (error) {
    dialog.showErrorBox(
      'Project Knowledge 无法启动',
      `${error.message}\n\n数据目录：${getDataDir()}\n请查看 desktop-backend.log。`
    );
    isQuitting = true;
    stopOwnedBackend();
    app.quit();
  }
});

app.on('activate', showMainWindow);
app.on('window-all-closed', event => {
  // Keep the backend and Git hooks alive in the tray on every platform.
  event.preventDefault();
});
app.on('before-quit', () => {
  isQuitting = true;
  stopOwnedBackend();
});
