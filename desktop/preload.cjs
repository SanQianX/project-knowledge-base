const { contextBridge, ipcRenderer } = require('electron');

const FOLDER_PICKER_CHANNEL = 'project-knowledge:pick-folder';
const UPDATE_CHANNELS = Object.freeze({
  state: 'project-knowledge:update-state',
  check: 'project-knowledge:check-for-updates',
  install: 'project-knowledge:install-update',
  changed: 'project-knowledge:update-state-changed',
});

contextBridge.exposeInMainWorld('projectKnowledgeDesktop', Object.freeze({
  pickFolder: () => ipcRenderer.invoke(FOLDER_PICKER_CHANNEL),
  getUpdateState: () => ipcRenderer.invoke(UPDATE_CHANNELS.state),
  checkForUpdates: () => ipcRenderer.invoke(UPDATE_CHANNELS.check),
  installUpdate: () => ipcRenderer.invoke(UPDATE_CHANNELS.install),
  onUpdateState: callback => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, state) => callback(state);
    ipcRenderer.on(UPDATE_CHANNELS.changed, listener);
    return () => ipcRenderer.removeListener(UPDATE_CHANNELS.changed, listener);
  },
}));
