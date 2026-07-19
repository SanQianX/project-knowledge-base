const CHANNEL = 'project-knowledge:pick-folder';

function registerFolderPicker({ ipcMain, dialog, getWindow = () => null }) {
  if (!ipcMain || typeof ipcMain.handle !== 'function' || typeof ipcMain.removeHandler !== 'function') {
    throw new TypeError('ipcMain with handle/removeHandler is required');
  }
  if (!dialog || typeof dialog.showOpenDialog !== 'function') {
    throw new TypeError('Electron dialog is required');
  }

  ipcMain.removeHandler(CHANNEL);
  ipcMain.handle(CHANNEL, async () => {
    const options = {
      title: 'Select Project Folder',
      buttonLabel: 'Select Folder',
      properties: ['openDirectory', 'createDirectory'],
    };
    const owner = getWindow();
    const result = owner && typeof owner.isDestroyed === 'function' && !owner.isDestroyed()
      ? await dialog.showOpenDialog(owner, options)
      : await dialog.showOpenDialog(options);
    if (!result || result.canceled || !Array.isArray(result.filePaths) || !result.filePaths[0]) {
      return { ok: false, cancelled: true };
    }
    return { ok: true, path: result.filePaths[0] };
  });

  return () => ipcMain.removeHandler(CHANNEL);
}

module.exports = { CHANNEL, registerFolderPicker };
