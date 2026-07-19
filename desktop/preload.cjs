const { contextBridge, ipcRenderer } = require('electron');

const FOLDER_PICKER_CHANNEL = 'project-knowledge:pick-folder';

contextBridge.exposeInMainWorld('projectKnowledgeDesktop', Object.freeze({
  pickFolder: () => ipcRenderer.invoke(FOLDER_PICKER_CHANNEL),
}));
