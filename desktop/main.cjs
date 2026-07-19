const path = require('path');
const {
  app,
  autoUpdater,
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
// Handle those events before loading the knowledge backend so setup can create
// shortcuts without accidentally starting LanceDB or showing the dashboard.
if (require('electron-squirrel-startup')) {
  app.quit();
} else {
const backendRuntime = require('./lib/backend-runtime.cjs');
const folderPicker = require('./lib/folder-picker.cjs');
const appUpdater = require('./lib/app-updater.cjs');
const externalLink = require('./lib/external-link.cjs');

const corePackagePath = require.resolve('project-knowledge/package.json');
const coreRoot = path.dirname(corePackagePath);
const { getDataDir } = require(path.join(coreRoot, '_site', 'lib', 'data-dir.js'));
const runtimeEndpoint = require(path.join(coreRoot, '_site', 'lib', 'runtime-endpoint.js'));

let mainWindow = null;
let tray = null;
let ownedBackend = null;
let activeEndpoint = null;
let isQuitting = false;
let removeFolderPickerHandler = null;
let removeAppUpdaterHandler = null;
let removeExternalLinkHandler = null;

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
      preload: path.join(__dirname, 'preload.cjs'),
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
  const extraEnv = await resolveDesktopNetworkEnv();
  const cliPath = path.join(coreRoot, 'bin', 'project-knowledge.js');
  const started = backendRuntime.spawnBackend({
    executable: process.execPath,
    cliPath,
    dataDir,
    port,
    cwd: path.dirname(process.execPath),
    extraEnv,
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

async function resolveDesktopNetworkEnv() {
  const result = {};
  const targets = [
    ['KB_GITHUB_WEB_PROXY', 'https://github.com/login/device'],
    ['KB_GITHUB_API_PROXY', 'https://api.github.com/user'],
  ];
  await Promise.all(targets.map(async ([name, target]) => {
    if (process.env[name] || process.env.KB_GITHUB_PROXY || process.env.KB_GIT_PROXY) return;
    try {
      const rules = await Promise.race([
        session.defaultSession.resolveProxy(target),
        new Promise((_, reject) => setTimeout(() => reject(new Error('system proxy resolution timed out')), 3000)),
      ]);
      const proxyUrl = backendRuntime.proxyUrlFromElectronRules(rules);
      if (proxyUrl) result[name] = proxyUrl;
    } catch {}
  }));
  return result;
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
    removeExternalLinkHandler = externalLink.registerExternalLink({
      ipcMain,
      shell,
      isAllowedUrl: backendRuntime.isAllowedExternalUrl,
    });
    removeFolderPickerHandler = folderPicker.registerFolderPicker({
      ipcMain,
      dialog,
      getWindow: () => mainWindow,
    });
    removeAppUpdaterHandler = appUpdater.registerAppUpdater({
      ipcMain,
      autoUpdater,
      app,
      getWindow: () => mainWindow,
      onBeforeInstall: () => {
        isQuitting = true;
        stopOwnedBackend();
      },
    });
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
  if (removeFolderPickerHandler) removeFolderPickerHandler();
  removeFolderPickerHandler = null;
  if (removeAppUpdaterHandler) removeAppUpdaterHandler();
  removeAppUpdaterHandler = null;
  if (removeExternalLinkHandler) removeExternalLinkHandler();
  removeExternalLinkHandler = null;
  stopOwnedBackend();
});
}
