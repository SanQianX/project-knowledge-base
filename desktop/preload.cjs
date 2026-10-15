'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// Minimal bridges: retry + bounded external links. Nothing else leaks into
// the sandboxed page (no Node, no arbitrary IPC channels).
contextBridge.exposeInMainWorld('desktopBridge', {
  retry: () => ipcRenderer.invoke('desktop:retry'),
});
contextBridge.exposeInMainWorld('projectKnowledge', {
  openExternal: url => ipcRenderer.invoke('project-knowledge:open-external', url),
});
