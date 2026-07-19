const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const runtime = require('../lib/backend-runtime.cjs');
const folderPicker = require('../lib/folder-picker.cjs');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

(async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/api/state') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const endpoint = { host: '127.0.0.1', port: server.address().port, pid: process.pid };
  const result = await runtime.requestState(endpoint);
  assert(result === endpoint, 'requestState should return the ready endpoint');
  assert(runtime.isAllowedNavigation(`http://127.0.0.1:${endpoint.port}/settings`, endpoint), 'same origin should be allowed');
  assert(!runtime.isAllowedNavigation('https://example.com', endpoint), 'remote navigation must be blocked');
  assert(runtime.isAllowedExternalUrl('https://github.com/test'), 'https external link should be allowed');
  assert(!runtime.isAllowedExternalUrl('file:///etc/passwd'), 'file URL must be blocked');

  let pickerHandler = null;
  let pickerRemoved = false;
  const ipcMain = {
    handle(channel, handler) {
      assert(channel === folderPicker.CHANNEL, 'unexpected folder picker IPC channel');
      pickerHandler = handler;
    },
    removeHandler(channel) {
      assert(channel === folderPicker.CHANNEL, 'unexpected folder picker IPC cleanup channel');
      pickerRemoved = true;
    },
  };
  const dialog = {
    async showOpenDialog(owner, options) {
      assert(owner && owner.name === 'main-window', 'folder picker should be owned by the main window');
      assert(options.properties.includes('openDirectory'), 'folder picker must select directories');
      return { canceled: false, filePaths: ['C:\\work\\selected-project'] };
    },
  };
  const unregisterPicker = folderPicker.registerFolderPicker({
    ipcMain,
    dialog,
    getWindow: () => ({ name: 'main-window', isDestroyed: () => false }),
  });
  assert(typeof pickerHandler === 'function', 'folder picker IPC handler should be registered');
  const selected = await pickerHandler();
  assert(selected.ok === true && selected.path === 'C:\\work\\selected-project',
    'folder picker should return the selected directory');
  pickerRemoved = false;
  unregisterPicker();
  assert(pickerRemoved, 'folder picker IPC handler should be removed on shutdown');

  const preloadSource = fs.readFileSync(path.join(__dirname, '..', 'preload.cjs'), 'utf-8');
  const mainSource = fs.readFileSync(path.join(__dirname, '..', 'main.cjs'), 'utf-8');
  assert(preloadSource.includes("exposeInMainWorld('projectKnowledgeDesktop'"),
    'preload should expose the narrow desktop bridge');
  assert(mainSource.includes("preload: path.join(__dirname, 'preload.cjs')"),
    'BrowserWindow should load the desktop preload bridge');

  const freePort = await runtime.findFreePort(20000 + (process.pid % 10000), 20);
  assert(Number.isInteger(freePort), 'findFreePort should find a port');

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), `kb-desktop-log-${process.pid}-`));
  const log = path.join(temp, 'desktop-backend.log');
  fs.writeFileSync(log, Buffer.alloc(2048));
  runtime.rotateLog(log, 1024);
  assert(fs.existsSync(`${log}.old`), 'oversized desktop log should rotate');
  fs.rmSync(temp, { recursive: true, force: true });
  await new Promise(resolve => server.close(resolve));
  console.log('desktop-runtime-test PASS');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
