const { EventEmitter } = require('events');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const updaterModule = require('../lib/app-updater.cjs');

(async () => {
  const handlers = new Map();
  const ipcMain = {
    handle: (channel, handler) => handlers.set(channel, handler),
    removeHandler: channel => handlers.delete(channel),
  };
  const sent = [];
  const autoUpdater = new EventEmitter();
  autoUpdater.setFeedURL = options => { autoUpdater.feed = options.url; };
  autoUpdater.checkForUpdates = () => autoUpdater.emit('checking-for-update');
  autoUpdater.quitAndInstall = () => { autoUpdater.installed = true; };
  let beforeInstall = false;

  const dispose = updaterModule.registerAppUpdater({
    ipcMain,
    autoUpdater,
    app: { isPackaged: true, getVersion: () => '4.1.5' },
    platform: 'win32',
    getWindow: () => ({ isDestroyed: () => false, webContents: { send: (...args) => sent.push(args) } }),
    onBeforeInstall: () => { beforeInstall = true; },
    defer: callback => callback(),
  });

  const initial = await handlers.get(updaterModule.CHANNELS.state)();
  assert.equal(initial.currentVersion, '4.1.5');
  assert.equal(initial.status, 'idle');

  const checking = await handlers.get(updaterModule.CHANNELS.check)();
  assert.equal(checking.status, 'checking');
  assert.equal(autoUpdater.feed, updaterModule.DEFAULT_FEED_URL);

  autoUpdater.emit('update-available');
  autoUpdater.emit('update-downloaded', {}, '', 'v4.1.6');
  const ready = await handlers.get(updaterModule.CHANNELS.state)();
  assert.equal(ready.status, 'ready');
  assert.equal(ready.latestVersion, '4.1.6');
  assert.equal(ready.updateAvailable, true);

  await handlers.get(updaterModule.CHANNELS.install)();
  assert.equal(beforeInstall, true);
  assert.equal(autoUpdater.installed, true);
  assert(sent.some(([channel, value]) => channel === updaterModule.CHANNELS.changed && value.status === 'ready'));

  dispose();
  assert.equal(handlers.size, 0);

  const workflow = fs.readFileSync(path.join(__dirname, '..', '..', '.github', 'workflows', 'desktop-release.yml'), 'utf-8');
  assert(workflow.includes('full.nupkg') && workflow.includes('Copy-Item -LiteralPath $releases'),
    'desktop release must upload the Squirrel package and RELEASES feed');
  console.log('app-updater-test PASS');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
