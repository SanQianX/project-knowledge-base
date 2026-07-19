const { EventEmitter } = require('events');

const DEFAULT_FEED_URL = 'https://github.com/SanQianX/project-knowledge-base/releases/latest/download';
const CHANNELS = Object.freeze({
  state: 'project-knowledge:update-state',
  check: 'project-knowledge:check-for-updates',
  install: 'project-knowledge:install-update',
  changed: 'project-knowledge:update-state-changed',
});

function publicState(state) {
  return { ...state };
}

function registerAppUpdater({
  ipcMain,
  autoUpdater,
  app,
  getWindow = () => null,
  onBeforeInstall = () => {},
  platform = process.platform,
  feedUrl = DEFAULT_FEED_URL,
  defer = setImmediate,
}) {
  if (!ipcMain || typeof ipcMain.handle !== 'function' || typeof ipcMain.removeHandler !== 'function') {
    throw new TypeError('ipcMain with handle/removeHandler is required');
  }
  if (!(autoUpdater instanceof EventEmitter) && (!autoUpdater || typeof autoUpdater.on !== 'function')) {
    throw new TypeError('Electron autoUpdater is required');
  }

  const supported = platform === 'win32' && app.isPackaged === true;
  const state = {
    supported,
    currentVersion: String(app.getVersion()),
    latestVersion: '',
    status: supported ? 'idle' : 'unsupported',
    updateAvailable: false,
    error: '',
  };

  const notify = () => {
    const win = getWindow();
    if (win && typeof win.isDestroyed === 'function' && !win.isDestroyed() && win.webContents) {
      win.webContents.send(CHANNELS.changed, publicState(state));
    }
  };
  const setState = patch => {
    Object.assign(state, patch);
    notify();
    return publicState(state);
  };

  const listeners = {
    checking: () => setState({ status: 'checking', error: '' }),
    available: () => setState({ status: 'downloading', updateAvailable: true, error: '' }),
    unavailable: () => setState({ status: 'current', updateAvailable: false, latestVersion: state.currentVersion, error: '' }),
    downloaded: (_event, _notes, releaseName) => setState({
      status: 'ready',
      updateAvailable: true,
      latestVersion: String(releaseName || '').replace(/^v/i, ''),
      error: '',
    }),
    error: error => setState({ status: 'error', error: error && error.message || String(error || 'Update failed') }),
  };

  autoUpdater.on('checking-for-update', listeners.checking);
  autoUpdater.on('update-available', listeners.available);
  autoUpdater.on('update-not-available', listeners.unavailable);
  autoUpdater.on('update-downloaded', listeners.downloaded);
  autoUpdater.on('error', listeners.error);

  for (const channel of [CHANNELS.state, CHANNELS.check, CHANNELS.install]) ipcMain.removeHandler(channel);
  ipcMain.handle(CHANNELS.state, async () => publicState(state));
  ipcMain.handle(CHANNELS.check, async () => {
    if (!supported) return publicState(state);
    if (['checking', 'downloading', 'ready', 'installing'].includes(state.status)) return publicState(state);
    setState({ status: 'checking', error: '' });
    try {
      autoUpdater.setFeedURL({ url: feedUrl });
      autoUpdater.checkForUpdates();
    } catch (error) {
      listeners.error(error);
    }
    return publicState(state);
  });
  ipcMain.handle(CHANNELS.install, async () => {
    if (state.status !== 'ready') {
      return setState({ error: 'Update has not finished downloading.' });
    }
    setState({ status: 'installing', error: '' });
    defer(() => {
      try {
        onBeforeInstall();
        autoUpdater.quitAndInstall();
      } catch (error) {
        listeners.error(error);
      }
    });
    return publicState(state);
  });

  return () => {
    for (const channel of [CHANNELS.state, CHANNELS.check, CHANNELS.install]) ipcMain.removeHandler(channel);
    autoUpdater.removeListener('checking-for-update', listeners.checking);
    autoUpdater.removeListener('update-available', listeners.available);
    autoUpdater.removeListener('update-not-available', listeners.unavailable);
    autoUpdater.removeListener('update-downloaded', listeners.downloaded);
    autoUpdater.removeListener('error', listeners.error);
  };
}

module.exports = { CHANNELS, DEFAULT_FEED_URL, registerAppUpdater };
